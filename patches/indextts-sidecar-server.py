"""IndexTTS-2.5 sidecar —— Voicebox 的第 10 个 TTS 引擎的后端服务。

由 voicebox 的 IndexTTS backend 以**无窗口子进程**方式托管：
    <voicebox 的 python.exe> D:\\AI\\IndexTTS\\server.py --port 17494

为什么是独立进程：IndexTTS 把 transformers 4.52.1 的 GPT2/generation 实现整份
拷贝进自己的仓库（依赖 4.57.x 里已不存在的私有 API），而 voicebox 现有 9 个引擎
依赖 transformers 4.57.x 的内部实现 —— 两者只能进程隔离，库隔离用影子目录实现。

端点：
    GET  /health   健康、模型状态、显存
    POST /load     显式加载模型（首次 /tts 会隐式加载）
    POST /tts      {text, ref_audio, lang, duration_factor, seed, ...} -> audio/wav
    POST /unload   卸载模型并释放显存

环境变量：
    INDEXTTS_MODELS_DIR  权重目录，默认 D:\\AI\\AIModels\\VoiceBox\\IndexTTS2.5
    INDEXTTS_HF_CACHE    HF 缓存目录，默认 D:\\AI\\AIModels\\VoiceBox\\hub
    INDEXTTS_PORT        监听端口，默认 17494
    INDEXTTS_IDLE_UNLOAD 空闲 N 秒后自动卸载（0 = 不自动卸载，默认 0）
"""
from __future__ import annotations

import argparse
import logging
import os
import random
import sys
import threading
import time
import uuid
import wave
from pathlib import Path

# --- 影子依赖必须先于 torch / transformers 进入 sys.path ---
_ROOT = Path(__file__).resolve().parent
_SHADOW = (
    _ROOT / "index-tts",
    _ROOT / "shadows" / "site2",   # transformers 4.52.1 + tokenizers 0.21.0
    _ROOT / "shadows" / "site",    # 小包集合（wetext / unidic / modelscope 依赖链等）
    _ROOT / "shadows" / "site3",   # modelscope 1.27.0
)
sys.path[:0] = [str(p) for p in _SHADOW if p.is_dir()]

MODELS_DIR = Path(os.environ.get("INDEXTTS_MODELS_DIR", r"D:\AI\AIModels\VoiceBox\IndexTTS2.5"))
os.environ.setdefault("HF_HUB_CACHE", os.environ.get("INDEXTTS_HF_CACHE", r"D:\AI\AIModels\VoiceBox\hub"))
WORK_DIR = Path(os.environ.get("INDEXTTS_WORK_DIR", r"D:\AI\IndexTTS\work"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402
import transformers  # noqa: E402

# torchaudio >= 2.9 的 save() 走 TorchCodec（未安装 → ImportError: TorchCodec is required
# for save_with_torchcodec）。IndexTTS 的 save_pcm_wav() 送进来的已是 [-1,1] float32，
# 所以用 soundfile 顶掉即可，不必引入 torchcodec。
if not hasattr(torchaudio, "_dsh_soundfile_patched"):
    import soundfile as _sf

    def _save_soundfile(uri, src, sample_rate, *args, **kwargs):
        arr = src
        if hasattr(arr, "detach"):
            arr = arr.detach().to("cpu", dtype=torch.float32).numpy()
        arr = np.asarray(arr)
        if arr.ndim == 2 and arr.shape[0] < arr.shape[1]:   # (ch, n) -> (n, ch)
            arr = arr.T
        _sf.write(str(uri), arr, int(sample_rate), subtype="PCM_16")
        return None

    torchaudio.save = _save_soundfile
    torchaudio._dsh_soundfile_patched = True

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import Response
    import uvicorn
except Exception as exc:  # pragma: no cover
    print(f"[sidecar] fastapi/uvicorn 不可用: {exc}", flush=True)
    raise

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("indextts-sidecar")

# IndexTTS 2.5 的语言表（indextts/utils/tokenizer.py: LANGUAGES）；README 明确支持的
# 只有中/英/日/西/阿，其余的按 tokenizer 表原样透传、质量不作承诺。
SUPPORTED_LANGS = {"zh", "en", "ja", "es", "ar"}
_KNOWN_LANGS = {
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl",
    "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro",
    "da", "hu", "ta", "no", "th", "ur", "hr", "bg",
}


class _Engine:
    """模型 + 推理的串行化封装（单卡，一次只跑一个请求）。"""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.model = None
        self.load_seconds = 0.0
        self.last_used = 0.0
        self.requests = 0

    # --- 加载 / 卸载 ---
    def load(self):
        with self.lock:
            if self.model is not None:
                return self.model
            cfg = MODELS_DIR / "config.yaml"
            if not cfg.is_file():
                raise RuntimeError(f"IndexTTS 权重目录不完整（缺 config.yaml）: {MODELS_DIR}")
            from indextts.infer_v2_5 import IndexTTS2

            t0 = time.time()
            logger.info("加载 IndexTTS-2.5: %s", MODELS_DIR)
            self.model = IndexTTS2(
                cfg_path=str(cfg),
                model_dir=str(MODELS_DIR),
                use_bf16=True,
                use_qwen_emo=False,
            )
            self.load_seconds = time.time() - t0
            logger.info("加载完成 %.1f s", self.load_seconds)
            return self.model

    def unload(self) -> bool:
        with self.lock:
            if self.model is None:
                return False
            del self.model
            self.model = None
            import gc

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            logger.info("模型已卸载，显存已释放")
            return True

    # --- 推理 ---
    def _load_qwen_emo(self, model) -> None:
        """按需加载 QwenEmotion（文字 → 情绪向量），不重建整个模型。"""
        from indextts.infer_v2_5 import QwenEmotion

        path = os.path.join(model.model_dir, model.cfg.qwen_emo_path)
        logger.info("按需加载 QwenEmotion: %s", path)
        t0 = time.time()
        model.qwen_emo = QwenEmotion(path)
        logger.info("QwenEmotion 加载完成 %.1f s", time.time() - t0)

    def infer(self, req: dict) -> tuple[bytes, int, float, float]:
        ref = str(req.get("ref_audio") or "")
        if not ref or not os.path.isfile(ref):
            raise RuntimeError(f"参考音频不存在: {ref}")
        text = (req.get("text") or "").strip()
        if not text:
            raise RuntimeError("text 为空")

        lang = str(req.get("lang") or "zh").lower()
        if lang not in _KNOWN_LANGS:
            logger.warning("lang=%s 不在 IndexTTS 语言表里，回退 zh", lang)
            lang = "zh"

        duration_factor = float(req.get("duration_factor") or 1.0)
        duration_factor = max(0.5, min(2.0, duration_factor))
        seed = req.get("seed")
        out_path = WORK_DIR / f"out-{uuid.uuid4().hex}.wav"

        with self.lock:
            model = self.load()
            if seed is not None:
                seed = int(seed)
                torch.manual_seed(seed)
                random.seed(seed)
                np.random.seed(seed % (2**32))
            kwargs = {
                "spk_audio_prompt": ref,
                "text": text,
                "output_path": str(out_path),
                "lang": lang,
                "duration_factor": duration_factor,
                "verbose": bool(req.get("verbose", False)),
            }
            # 注：IndexTTS-2.5 不需要参考音频的转写文本（spk_audio_prompt 自带对齐），
            # 所以 req 里的 ref_text 只用于调用方缓存键，不往下传（上游 infer 不接受该参数）。
            if req.get("max_text_tokens_per_segment"):
                kwargs["max_text_tokens_per_segment"] = int(req["max_text_tokens_per_segment"])
            if req.get("interval_silence") is not None:
                kwargs["interval_silence"] = int(req["interval_silence"])
            if req.get("text_normalization") is not None:
                kwargs["text_normalization"] = bool(req["text_normalization"])
            emo_audio = req.get("emo_audio")
            if emo_audio and os.path.isfile(str(emo_audio)):
                kwargs["emo_audio_prompt"] = str(emo_audio)
                kwargs["emo_alpha"] = float(req.get("emo_alpha") or 1.0)
            emo_vector = req.get("emo_vector")
            if emo_vector:
                kwargs["emo_vector"] = [float(x) for x in emo_vector]
            if req.get("use_emo_text"):
                # QwenEmotion 默认不加载（多占 1.2 GB 显存）；第一次真用到时按需补上即可，
                # 不必重建模型 —— 上游只在 self.qwen_emo is None 时抛错（infer_v2_5.py:590）。
                if getattr(model, "qwen_emo", None) is None:
                    self._load_qwen_emo(model)
                # 注意：这里**不能**传 use_qwen_emo —— 那是构造参数，不是 infer 的
                # 形参，会落进 **generation_kwargs 被转发给 GPT 的 generate()，
                # 直接抛 ValueError: The following model_kwargs are not used by the model。
                kwargs["use_emo_text"] = True
                kwargs["emo_text"] = req.get("emo_text") or text
            steps = req.get("diffusion_steps")
            if steps:
                # s2mel 扩散步数（默认 25，越小越快、高频细节越糊）
                kwargs["diffusion_steps"] = int(steps)
            if req.get("use_random") is not None:
                kwargs["use_random"] = bool(req["use_random"])

            t0 = time.time()
            logger.info(
                "推理参数 lang=%s duration_factor=%.3f steps=%s emo_text=%s emo_vector=%s emo_audio=%s silence=%s max_tokens=%s norm=%s seed=%s",
                lang, duration_factor, kwargs.get("diffusion_steps", "default(25)"),
                bool(kwargs.get("use_emo_text")), bool(kwargs.get("emo_vector")),
                bool(kwargs.get("emo_audio_prompt")), kwargs.get("interval_silence", "default(200)"),
                kwargs.get("max_text_tokens_per_segment", "default(120)"),
                kwargs.get("text_normalization", True), seed,
            )
            try:
                model.infer(**kwargs)
            finally:
                self.last_used = time.time()
                self.requests += 1
            elapsed = time.time() - t0

        if not out_path.is_file():
            raise RuntimeError("推理结束但没有生成音频文件")
        with wave.open(str(out_path), "rb") as w:
            sr, frames = w.getframerate(), w.getnframes()
        data = out_path.read_bytes()
        out_path.unlink(missing_ok=True)
        return data, sr, frames / float(sr), elapsed


ENGINE = _Engine()
app = FastAPI(title="IndexTTS-2.5 sidecar", version="1.0")


def _vram() -> dict:
    if not torch.cuda.is_available():
        return {}
    return {
        "allocated_gb": round(torch.cuda.memory_allocated() / 1024**3, 2),
        "reserved_gb": round(torch.cuda.memory_reserved() / 1024**3, 2),
        "peak_allocated_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2),
    }


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "engine": "indextts-2.5",
        "loaded": ENGINE.model is not None,
        "loading": False,
        "requests": ENGINE.requests,
        "model_dir": str(MODELS_DIR),
        "langs": sorted(SUPPORTED_LANGS),
        "transformers": transformers.__version__,
        "torch": torch.__version__,
        "cuda": torch.cuda.is_available(),
        "vram": _vram(),
    }


@app.post("/load")
def load() -> dict:
    t0 = time.time()
    try:
        ENGINE.load()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True, "load_seconds": round(ENGINE.load_seconds or (time.time() - t0), 1), "vram": _vram()}


@app.post("/unload")
def unload() -> dict:
    return {"ok": True, "unloaded": ENGINE.unload(), "vram": _vram()}


@app.post("/tts")
def tts(req: dict):
    try:
        data, sr, dur, elapsed = ENGINE.infer(req or {})
    except Exception as exc:
        logger.exception("推理失败")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    rtf = (elapsed / dur) if dur else 0.0
    logger.info("tts ok: %.2f s 音频 / %.2f s 推理 / RTF %.3f", dur, elapsed, rtf)
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Sample-Rate": str(sr),
            "X-Duration": f"{dur:.3f}",
            "X-Infer-Seconds": f"{elapsed:.3f}",
            "X-Rtf": f"{rtf:.3f}",
            "X-Vram-Allocated-Gb": str(_vram().get("allocated_gb", "")),
        },
    )


def _idle_watchdog(idle_seconds: int) -> None:
    while True:
        time.sleep(15)
        try:
            if ENGINE.model is not None and ENGINE.last_used and (time.time() - ENGINE.last_used) > idle_seconds:
                logger.info("空闲 %d s，自动卸载", idle_seconds)
                ENGINE.unload()
        except Exception:  # pragma: no cover
            logger.exception("idle watchdog 出错")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("INDEXTTS_PORT", "17494")))
    parser.add_argument("--preload", action="store_true", help="启动时就加载模型")
    args = parser.parse_args()

    idle = int(os.environ.get("INDEXTTS_IDLE_UNLOAD", "0"))
    if idle > 0:
        threading.Thread(target=_idle_watchdog, args=(idle,), daemon=True).start()

    logger.info("IndexTTS-2.5 sidecar 启动 http://%s:%d  (models=%s)", args.host, args.port, MODELS_DIR)
    if args.preload:
        try:
            ENGINE.load()
        except Exception:
            logger.exception("预加载失败，等待首次请求重试")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)
