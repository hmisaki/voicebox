---
name: voicebox
description: |
  本机 VoiceBox 语音服务的操作手册：REST 全参数为主、MCP 快捷说话为辅。覆盖服务位置与健康检查、声音档案发现、`/generate` 全参数字段、`instruct`（传达说明）的逐引擎语义与 IndexTTS 键表、转写、以及"不发声/参数不生效"的排障路径。Voicebox local TTS/STT service runbook (REST-first, MCP for quick speak).
whenToUse: |
  需要让本机发声（TTS）或转写音频；要挑声音档案、建档案、调语速/步数/情绪等合成参数；要让 Agent 用 MCP 说一句话；或排查 VoiceBox 不出声、参数不生效、MCP 连不上时使用。
---

# VoiceBox 语音服务

本机（Windows）跑着一套 VoiceBox：FastAPI 后端 + React 前端 + 若干 TTS/STT 引擎，其中 IndexTTS 2.5 走一个**独立 sidecar 进程**。本 skill 是操作手册，不是代码导览。

## 0. 服务在哪、怎么确认活着

| 东西 | 位置 |
|---|---|
| 后端 REST | `http://127.0.0.1:17493` |
| 网页界面（dev） | `http://127.0.0.1:5188` |
| 前端源码 / Vite root | `D:\AI\VoiceBox\app\app\src` / `D:\AI\VoiceBox\app\web` |
| 生成的音频 | `D:\AI\VoiceBox\app\data\generations\<generation_id>.wav`（`data/` 已 gitignore） |
| IndexTTS 引擎（上游） | `D:\AI\IndexTTS`（sidecar，端口 `17494`，**按需启动、不常驻**） |

```bash
# 健康检查：model_loaded=false 只代表首次合成要先加载模型（数十秒）
curl -s http://127.0.0.1:17493/health
# 端口在不在（PowerShell）
Get-NetTCPConnection -LocalPort 17493,17494 -State Listen -ErrorAction SilentlyContinue
```

启动 / 重启（**必须带 `-ExecutionPolicy Bypass`**，否则默认策略会拒绝加载脚本）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\AI\VoiceBox\start-voicebox.ps1 -NoBrowser
# 已在跑就加 -Restart；也可直接调 D:\AI\VoiceBox\start-voicebox.cmd
```

改动后端 Python 后**必须重启**；改动 IndexTTS 上游（`D:\AI\IndexTTS\...`）后还要**杀掉 sidecar**（占 `17494` 的进程），否则跑的还是旧代码。

## 1. 两条路：REST 全参数 / MCP 快捷

| 场景 | 用哪条 |
|---|---|
| 需要 `instruct`/`seed`/`normalize`/`effects_chain` 等全参数、要拿音频文件、要建/改档案 | **REST** `POST /generate` |
| 只是让 Agent "说一句话"、快速预览或朗读 | **MCP** `voicebox_speak` |

MCP 工具也已支持 `instruct` / `seed`（本机补丁），但它仍是 REST 的子集；需要精细控制就走 REST。MCP 细节见 `references/mcp.md`。

## 2. 标准动作

### 2.1 看有哪些声音档案

```bash
curl -s http://127.0.0.1:17493/profiles
```

关键字段：`id`（喂给 `profile_id`）、`name`、`language`、`voice_type`（`cloned` / `preset` / `designed`）、`default_engine`、**`default_instruct`**、`design_prompt`、`personality`、`sample_count`。引擎可选值（10 个）：`qwen`、`qwen_custom_voice`、`qwen_voice_design`、`luxtts`、`chatterbox`、`chatterbox_turbo`、`tada`、`kokoro`、`omnivoice`、`indextts`。

### 2.2 合成（REST，全参数）

```bash
curl -s -X POST http://127.0.0.1:17493/generate \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"<profile id>","text":"要念的话","language":"zh","engine":"indextts","instruct":"speed=1.1\nsteps=12"}'
# → {"generation_id":"…","status":"generating","…"}

curl -s http://127.0.0.1:17493/generate/<generation_id>/status    # 轮询到 completed / failed
curl -s -o out.wav http://127.0.0.1:17493/audio/<generation_id>  # 取音频
```

**`/generate` 是异步的**：立刻返回 `generation_id`，合成在后台跑。字段全集（含 `seed`、`model_size`、`max_chunk_chars`、`crossfade_ms`、`normalize`、`personality`、`effects_chain`）见 `references/rest-api.md`。

### 2.3 转写

```bash
curl -s -X POST http://127.0.0.1:17493/transcribe -F "file=@some.wav"
```

## 3. `instruct`（传达说明）——本服务唯一的"参数通道"

VoiceBox 不给每个引擎开独立表单，引擎私有参数统一从 `instruct` 这个自由字符串进（上限 **500 字符**）。它会按引擎翻译成真实参数，逐引擎语义差别很大：

- **忽略它**：`kokoro`、`luxtts`、`chatterbox`、`chatterbox_turbo`、`hume*`（传了不报错、也不生效）
- **自然语言**：`qwen_custom_voice`、`qwen_voice_design`（叠在 `design_prompt` 之后）、pytorch 系
- **闭集词表**：`omnivoice`（非法属性直接 `ValueError`）
- **键值对**：`indextts`（`speed=`、`steps=`、`emo_text=`… 见键表）

三条硬规则：

1. 请求里带的 `instruct` **整体替换**档案的 `default_instruct`，不是逐键合并 —— 想"只改语速、其余用档案"就自己把要保留的键一起写上，或先读档案默认值再拼接。
2. 请求没带（`null`）时回落到档案 `default_instruct`；档案也没有就用引擎默认。
3. 解析器只认**整行**的 `#` 注释（`# 这一整行是注释`）；行内注释无效。

逐引擎细节与 IndexTTS 完整键表、别名、取值范围、实测坑：**`references/instruct.md`**（要写 `instruct` 之前必读）。

## 4. 排障

`references/troubleshooting.md` 收录了实测过的路径。三个最常见的：

1. **端口不通** → 服务没起：带 `-ExecutionPolicy Bypass` 重启（见 §0）。
2. **首次合成特别慢** → 模型在加载（IndexTTS 冷启实测约 18 s；sidecar 日志里有进度行）。
3. **MCP 客户端显示 disconnected** → `/mcp` 地址**必须以斜杠结尾**（`http://127.0.0.1:17493/mcp/`），否则 307 跳转，部分客户端不跟随。

## 5. 铁律（踩过的坑）

- 别用 `POST /speak` 当全参数入口：它只有 `text` / `profile` / `engine` / `personality` / `language`，**没有 `instruct`**。
- `instruct` 里写的 `emo_audio` 路径**必须真实存在**：不存在会被静默忽略（不报错、结果与没写一样）。
- 档案的 `reference_text`（参考文本）在**数据层是必填**（`min_length=1`），创建/导入档案时绕不过去。
- 产物与档案库都在 `data/` 下，**已被 .gitignore 排除**：别手贱 `git add -f`，那是个人音频，不该进仓库。
- 观测合成参数是否真的到达引擎，看 sidecar 日志（IndexTTS）：`D:\AI\IndexTTS\logs\sidecar.err.log` 里的 `推理参数 …` 行。REST 响应头里的耗时字段在流式路径上可能是空的，别依赖。
