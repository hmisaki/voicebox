"""IndexTTS-2.5 backend — 零样本音色克隆（中 / 英 / 日 / 西 / 阿）。

为什么是 sidecar 而不是进程内加载
----------------------------------
``index-tts`` 把 transformers 4.52.1 的 GPT2 与 generation 实现整份拷贝进自己的
仓库（``indextts/gpt/transformers_gpt2.py``、``transformers_generation_utils.py``），
依赖 4.57.x 已删除的私有 API —— 而 voicebox 现有引擎（kokoro / chatterbox /
omnivoice ...）反过来依赖 transformers 4.57.x 的内部实现。两者只能进程隔离：

* 库隔离：``D:\\AI\\IndexTTS\\shadows\\site2`` 放 transformers 4.52.1 + tokenizers
  0.21.0，``site`` / ``site3`` 放其余小包（无重复 torch）；
* 进程隔离：本 backend 起一个无窗口子进程跑 ``D:\\AI\\IndexTTS\\server.py``
  （FastAPI，127.0.0.1:17494）。``load_model()`` 启动并预加载，``unload_model()``
  杀掉；没有新增脚本、图标或控制台窗口，生命周期完全跟着 voicebox。

权重：``D:\\AI\\AIModels\\VoiceBox\\IndexTTS2.5``（22 文件 / 5.11 GB，5.11 GB 权重 +
``hf_cache/`` 里的 4 个辅助模型）。HF 缓存里另有一份硬链接快照，供
``is_model_cached("IndexTeam/IndexTTS-2.5")`` 判定"已下载"。

参考音频：``create_voice_prompt()`` 把样本归一化成 24 kHz 单声道 wav 存到
voice prompt 缓存目录的 ``indextts_ref/``，并把**稳定路径**交给 sidecar ——
IndexTTS 内部按 ``spk_audio_prompt`` 路径缓存说话人条件，路径稳定才能命中。
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from . import TTSBackend  # noqa: F401  （Protocol，供类型/文档参照）
from .base import (
    combine_voice_prompts as _combine_voice_prompts,
    empty_device_cache,
    get_torch_device,
    is_model_cached,
)
from ..utils.audio import load_audio, save_audio
from ..utils.cache import (
    _get_cache_dir,
    cache_voice_prompt,
    get_cache_key,
    get_cached_voice_prompt,
)

logger = logging.getLogger(__name__)

INDEXTTS_HF_REPO = "IndexTeam/IndexTTS-2.5"
INDEXTTS_ROOT = Path(os.environ.get("INDEXTTS_ROOT", r"D:\AI\IndexTTS"))
INDEXTTS_SERVER = Path(os.environ.get("INDEXTTS_SERVER_PATH", str(INDEXTTS_ROOT / "server.py")))
INDEXTTS_LOG_DIR = Path(os.environ.get("INDEXTTS_LOG_DIR", str(INDEXTTS_ROOT / "logs")))
INDEXTTS_MODELS_DIR = Path(
    os.environ.get("INDEXTTS_MODELS_DIR", r"D:\AI\AIModels\VoiceBox\IndexTTS2.5")
)
INDEXTTS_PORT = int(os.environ.get("INDEXTTS_PORT", "17494"))
# 用哪个解释器起 sidecar：默认 voicebox 自己的（同一套 Python + 依赖）。
# 打包成 exe 运行时 sys.executable 是 exe 本身，此时用 INDEXTTS_PYTHON 指到真解释器。
INDEXTTS_PYTHON = os.environ.get("INDEXTTS_PYTHON") or sys.executable
INDEXTTS_SAMPLE_RATE = 22050
_PROMPT_VERSION = 1
_REF_MAX_SECONDS = 15
_SIDECAR_START_TIMEOUT = 180
_TTS_TIMEOUT = float(os.environ.get("INDEXTTS_TTS_TIMEOUT", "900"))

# 上游 README 明确支持的五种语言
_DECLARED_LANGS = ("zh", "en", "ja", "es", "ar")
# indextts/utils/tokenizer.py 的 LANGUAGES 表（质量不作承诺，但可透传）
_KNOWN_LANGS = {
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl",
    "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro",
    "da", "hu", "ta", "no", "th", "ur", "hr", "bg",
}
_REQUIRED_FILES = (
    "config.yaml",
    "gpt.pth",
    "s2mel.pth",
    "codec.pth",
    "multilingual_zh_ja_yue_char_del.tiktoken",
    "qwen0.6bemo4-merge/model.safetensors",
)
_DURATION_MIN, _DURATION_MAX = 0.5, 2.0
_DIFFUSION_MIN, _DIFFUSION_MAX = 4, 50

# instruct 语法：一行一个 ``键=值``（换行、``;``、``；`` 都算分隔符；逗号不分割，
# 因为 ``emo_vector=0,0,0,0,0,0,0,1`` 的值本身含逗号）。键不区分大小写，附中文别名。
# 解析结果直接就是 sidecar ``/tts`` 的字段名。
_ITEM_SPLIT_RE = re.compile(r"[\n\r;；]+")
_ITEM_RE = re.compile(r"^([0-9A-Za-z_]+|[^\s=:：]+)\s*[=:：]\s*(.*)$", re.S)

_TRUE_WORDS = {"1", "on", "true", "yes", "y", "开", "是", "启用"}
_FALSE_WORDS = {"0", "off", "false", "no", "n", "关", "否", "禁用"}

_INSTRUCT_ALIASES = {
    "speed": "speed",
    "语速": "speed",
    "rate": "speed",
    "duration_factor": "duration_factor",
    "duration": "duration_factor",
    "时长": "duration_factor",
    "emo_text": "emo_text",
    "emotion_text": "emo_text",
    "emotion": "emo_text",
    "情绪": "emo_text",
    "情绪文字": "emo_text",
    "emo_vector": "emo_vector",
    "emotion_vector": "emo_vector",
    "vector": "emo_vector",
    "情绪向量": "emo_vector",
    "emo_audio": "emo_audio",
    "emotion_audio": "emo_audio",
    "情绪音频": "emo_audio",
    "alpha": "emo_alpha",
    "emo_alpha": "emo_alpha",
    "strength": "emo_alpha",
    "强度": "emo_alpha",
    "silence": "interval_silence",
    "interval_silence": "interval_silence",
    "静音": "interval_silence",
    "max_tokens": "max_text_tokens_per_segment",
    "max_text_tokens_per_segment": "max_text_tokens_per_segment",
    "分段字数": "max_text_tokens_per_segment",
    "norm": "text_normalization",
    "normalize": "text_normalization",
    "text_normalization": "text_normalization",
    "归一化": "text_normalization",
    "lang": "lang",
    "language": "lang",
    "语言": "lang",
    "steps": "diffusion_steps",
    "diffusion_steps": "diffusion_steps",
    "步数": "diffusion_steps",
    "seed": "seed",
    "random": "use_random",
    "随机": "use_random",
    "emo_random": "use_random",
}


def _resolve_lang(language: Optional[str]) -> str:
    code = (language or "zh").lower().replace("_", "-").split("-")[0]
    if code in _DECLARED_LANGS:
        return code
    if code in _KNOWN_LANGS:
        return code
    return "zh"


def _clamp_duration(value: float) -> float:
    return max(_DURATION_MIN, min(_DURATION_MAX, value))


def _env_duration_factor() -> float:
    try:
        return _clamp_duration(float(os.environ.get("INDEXTTS_DURATION_FACTOR", "1.0")))
    except ValueError:
        return 1.0


def _parse_bool(value: str) -> bool:
    text = value.strip().lower()
    if text in _TRUE_WORDS:
        return True
    if text in _FALSE_WORDS:
        return False
    return bool(text)


def _parse_instruct(instruct: Optional[str]) -> dict:
    """把「传达说明」解析成 sidecar ``/tts`` 的参数。

    语法是「一行一个 ``键=值``」，例如::

        speed=1.2                        语速 1.2 倍（等价 duration_factor=1/1.2）
        duration_factor=1.1              时长 1.1 倍（说得更慢）
        emo_text=温柔又带点疲惫           用文字描述情绪（自动开启 use_emo_text）
        emo_vector=0,0,0,0,0,0,0,1       8 维情绪向量
        emo_audio=D:\\a.wav / alpha=0.8   情绪参考音与强度
        silence=200                      分段之间静音毫秒
        max_tokens=120                   每段最大 token
        steps=15                         s2mel 扩散步数（默认 25，越小越快越糊）
        seed=12345 / random=on / norm=off / lang=en

    不认识的键直接忽略：instruct 框是所有引擎共用的，别的引擎的写法不该报错。
    单个值非法时也只忽略该键，不打断整次生成。
    """
    params: dict = {}
    if not instruct or not instruct.strip():
        return params
    for raw in _ITEM_SPLIT_RE.split(instruct):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _ITEM_RE.match(line)
        if not m:
            continue
        field = _INSTRUCT_ALIASES.get(m.group(1).strip().lower())
        value = m.group(2).strip()
        if not field or not value:
            continue
        try:
            if field == "speed":
                speed = float(value)
                if speed > 0:
                    params["duration_factor"] = _clamp_duration(1.0 / speed)
            elif field == "duration_factor":
                params["duration_factor"] = _clamp_duration(float(value))
            elif field == "emo_alpha":
                params["emo_alpha"] = max(0.0, min(1.0, float(value)))
            elif field == "interval_silence":
                params["interval_silence"] = max(0, min(5000, int(float(value))))
            elif field == "max_text_tokens_per_segment":
                params["max_text_tokens_per_segment"] = max(20, min(600, int(float(value))))
            elif field == "diffusion_steps":
                params["diffusion_steps"] = max(
                    _DIFFUSION_MIN, min(_DIFFUSION_MAX, int(float(value)))
                )
            elif field == "seed":
                params["seed"] = int(float(value))
            elif field == "text_normalization":
                params["text_normalization"] = _parse_bool(value)
            elif field == "use_random":
                params["use_random"] = _parse_bool(value)
            elif field == "lang":
                code = value.lower().replace("_", "-").split("-")[0]
                if code in _DECLARED_LANGS or code in _KNOWN_LANGS:
                    params["lang"] = code
            elif field == "emo_vector":
                vector = [float(x) for x in re.split(r"[,\s]+", value) if x != ""]
                if vector:
                    params["emo_vector"] = vector[:8]
            elif field == "emo_text":
                params["emo_text"] = value
                params["use_emo_text"] = True
            elif field == "emo_audio":
                params["emo_audio"] = value
        except (TypeError, ValueError):
            logger.warning("IndexTTS 传达说明里 %s 的值无法解析，已忽略：%r", field, value)
    return params


def _resolve_duration_factor(instruct: Optional[str]) -> float:
    """兼容旧调用：只取语速，没有就退回环境变量 ``INDEXTTS_DURATION_FACTOR``。"""
    params = _parse_instruct(instruct)
    if "duration_factor" in params:
        return params["duration_factor"]
    return _env_duration_factor()


class IndexTTSBackend:
    """IndexTTS-2.5，以 sidecar 子进程方式托管。"""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._model_loaded = False
        self.model_size = "default"  # IndexTTS-2.5 只有一个检查点
        self._lock = threading.RLock()
        self._base = f"http://127.0.0.1:{INDEXTTS_PORT}"
        self._load_seconds = 0.0

    # --- 基础属性 ---
    def _get_device(self) -> str:
        return get_torch_device()

    def _get_model_path(self, model_size: str = "default") -> str:
        return str(INDEXTTS_MODELS_DIR)

    def _is_model_cached(self, model_size: str = "default") -> bool:
        if is_model_cached(INDEXTTS_HF_REPO, required_files=list(_REQUIRED_FILES)):
            return True
        return all((INDEXTTS_MODELS_DIR / name).is_file() for name in _REQUIRED_FILES)

    def is_loaded(self) -> bool:
        return (
            self._proc is not None
            and self._proc.poll() is None
            and self._model_loaded
        )

    # --- HTTP 辅助 ---
    def _health_ok(self, timeout: float = 5.0) -> bool:
        try:
            body = self._http_json("/health", None, timeout=timeout)
            return bool(body.get("ok"))
        except Exception:
            return False

    def _http_json(self, path: str, payload: Optional[dict], timeout: float = 30.0) -> dict:
        url = self._base + path
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _http_wav_sync(self, payload: dict) -> Tuple[bytes, dict]:
        req = urllib.request.Request(
            self._base + "/tts",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=_TTS_TIMEOUT) as resp:
                return resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:800]
            raise RuntimeError(f"IndexTTS sidecar 返回 HTTP {exc.code}: {detail}") from exc

    # --- 加载 / 卸载 ---
    async def load_model(self, model_size: str = "default") -> None:
        if self.is_loaded():
            return
        await asyncio.to_thread(self._load_sync)

    def _load_sync(self) -> None:
        device = self._get_device()
        self._ensure_sidecar_sync()
        if self._model_loaded:
            return
        logger.info("IndexTTS 预加载模型（sidecar pid=%s, device=%s）", getattr(self._proc, "pid", "?"), device)
        t0 = time.time()
        body = self._http_json("/load", {}, timeout=_SIDECAR_START_TIMEOUT + 240)
        self._load_seconds = float(body.get("load_seconds") or (time.time() - t0))
        self._model_loaded = True
        logger.info("IndexTTS 加载完成 %.1f s", self._load_seconds)

    def _ensure_sidecar_sync(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None and self._health_ok():
                return
            if not INDEXTTS_SERVER.is_file():
                raise RuntimeError(f"IndexTTS sidecar 脚本不存在：{INDEXTTS_SERVER}")
            if not self._is_model_cached():
                raise RuntimeError(
                    f"IndexTTS 权重不完整：{INDEXTTS_MODELS_DIR}"
                    "（缺 gpt.pth / s2mel.pth / codec.pth / config.yaml 等）"
                )
            INDEXTTS_LOG_DIR.mkdir(parents=True, exist_ok=True)
            env = os.environ.copy()
            env.update(
                {
                    "INDEXTTS_MODELS_DIR": str(INDEXTTS_MODELS_DIR),
                    "INDEXTTS_PORT": str(INDEXTTS_PORT),
                    "PYTHONUTF8": "1",
                    "PYTHONIOENCODING": "utf-8",
                    "NO_PROXY": "127.0.0.1,localhost",
                    "no_proxy": "127.0.0.1,localhost",
                }
            )
            out = open(INDEXTTS_LOG_DIR / "sidecar.out.log", "a", encoding="utf-8")
            err = open(INDEXTTS_LOG_DIR / "sidecar.err.log", "a", encoding="utf-8")
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0
            self._proc = subprocess.Popen(
                [INDEXTTS_PYTHON, str(INDEXTTS_SERVER), "--port", str(INDEXTTS_PORT)],
                cwd=str(INDEXTTS_ROOT),
                env=env,
                stdout=out,
                stderr=err,
                creationflags=flags,
                start_new_session=(os.name != "nt"),
            )
            out.close()
            err.close()
            logger.info("IndexTTS sidecar 启动 pid=%s → %s:%d", self._proc.pid, "127.0.0.1", INDEXTTS_PORT)

            deadline = time.time() + _SIDECAR_START_TIMEOUT
            while time.time() < deadline:
                if self._proc.poll() is not None:
                    raise RuntimeError(
                        f"IndexTTS sidecar 启动即退出（exit {self._proc.returncode}）；"
                        f"日志：{INDEXTTS_LOG_DIR / 'sidecar.err.log'}"
                    )
                if self._health_ok():
                    return
                time.sleep(1.0)
            raise RuntimeError(f"IndexTTS sidecar {_SIDECAR_START_TIMEOUT} s 内未就绪；日志：{INDEXTTS_LOG_DIR}")

    def unload_model(self) -> None:
        with self._lock:
            self._model_loaded = False
            proc = self._proc
            self._proc = None
            if proc is None:
                return
            try:
                self._http_json("/unload", {}, timeout=30)
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=20)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            logger.info("IndexTTS sidecar 已停止")
            try:
                empty_device_cache(self._get_device())
            except Exception:
                pass

    # --- voice prompt ---
    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        await self.load_model()
        cache_key = ("indextts_" + get_cache_key(audio_path, reference_text)) if use_cache else None
        if cache_key:
            cached = get_cached_voice_prompt(cache_key)
            if isinstance(cached, dict) and cached.get("version") == _PROMPT_VERSION:
                return cached, True
        prompt = await asyncio.to_thread(self._prepare_reference_sync, audio_path, reference_text, cache_key)
        if cache_key:
            cache_voice_prompt(cache_key, prompt)
        return prompt, False

    def _prepare_reference_sync(
        self,
        audio_path: str,
        reference_text: str,
        cache_key: Optional[str],
    ) -> dict:
        ref_dir = Path(_get_cache_dir()) / "indextts_ref"
        ref_dir.mkdir(parents=True, exist_ok=True)
        key = cache_key or ("indextts_" + get_cache_key(audio_path, reference_text))
        dst = ref_dir / f"{key}.wav"
        if not dst.is_file():
            audio, sr = load_audio(str(audio_path), sample_rate=24000, mono=True)
            if audio is None or len(audio) == 0:
                raise RuntimeError(f"参考音频无法解码：{audio_path}")
            max_samples = int(sr * _REF_MAX_SECONDS)
            if len(audio) > max_samples:
                audio = audio[:max_samples]
            save_audio(audio, str(dst), sample_rate=sr)
            logger.info("IndexTTS 参考音频已归一化：%s（%.2f s @ %d Hz）", dst, len(audio) / sr, sr)
        return {
            "version": _PROMPT_VERSION,
            "path": str(dst),
            "reference_text": reference_text or "",
            "sample_rate": 24000,
        }

    async def combine_voice_prompts(
        self,
        audio_paths,
        reference_texts,
    ) -> Tuple[np.ndarray, str]:
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=24000)

    # --- 推理 ---
    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        await self.load_model()
        ref = voice_prompt.get("path") if isinstance(voice_prompt, dict) else None
        if not ref or not os.path.isfile(str(ref)):
            raise RuntimeError(
                "IndexTTS 需要参考音频：当前 voice_prompt 里没有可用的参考音频路径"
                "（请给档案绑定样本，或改用克隆型引擎）"
            )
        params = _parse_instruct(instruct)
        payload = {
            "text": text,
            "ref_audio": str(ref),
            "lang": params.pop("lang", None) or _resolve_lang(language),
            "duration_factor": params.pop("duration_factor", None) or _env_duration_factor(),
            "text_normalization": params.pop("text_normalization", True),
        }
        # instruct 里剩下的都是可选能力（情绪 / 步数 / 静音 / 分段字数 / 随机），
        # 原样交给 sidecar；不认识的键在 _parse_instruct 里已被过滤掉。
        payload.update(params)
        # 显式 seed 优先；instruct 里的 seed= 在没有请求 seed 时生效。
        instruct_seed = payload.pop("seed", None)
        if seed is None:
            seed = instruct_seed
        if seed is not None:
            payload["seed"] = int(seed)
        if params:
            logger.info("IndexTTS 传达说明参数：%s", params)
        data, headers = await asyncio.to_thread(self._http_wav_sync, payload)
        try:
            import soundfile as sf

            audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
        except Exception as exc:
            raise RuntimeError(f"IndexTTS 输出音频解码失败：{exc}") from exc
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        audio = np.asarray(audio, dtype=np.float32)
        try:
            sr = int(headers.get("X-Sample-Rate") or sr)
            logger.info(
                "IndexTTS 生成完成：%.2f s 音频 / %.2f s 推理 / RTF %s",
                float(headers.get("X-Duration") or 0.0),
                float(headers.get("X-Infer-Seconds") or 0.0),
                headers.get("X-Rtf"),
            )
        except Exception:
            pass
        return audio, sr
