# VoiceBox REST API 参考

Base URL：`http://127.0.0.1:17493`（本机）。所有接口都在同一个进程上；`/mcp` 是 MCP 端点（见 `mcp.md`）。权威来源：`GET /openapi.json`。

## 1. 核心链路（TTS）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/generate` | 入队合成，立即返回 `generation_id`（异步） |
| `POST` | `/generate/stream` | 同步式：同 `GenerationRequest` 体，直接等音频返回（适合短文本） |
| `GET` | `/generate/{generation_id}/status` | `{"id","status","duration","error","source"}`，`status` ∈ `generating`/`completed`/`failed` |
| `GET` | `/audio/{generation_id}` | 取生成的音频 |
| `GET` | `/audio/version/{version_id}` | 取某个版本（重新生成/应用效果后的分支） |
| `POST` | `/generate/{generation_id}/{regenerate,retry,cancel}` | 重跑 / 重试 / 取消 |
| `POST` | `/generate/import` | 导入外部音频作为一次生成记录 |
| `POST` | `/speak` | 轻量入口：`text` / `profile` / `engine` / `personality` / `language`（**无 `instruct`**） |
| `POST` | `/events/speak` | 事件式触发（供外部集成） |

### 1.1 `POST /generate` 请求体（`GenerationRequest`）

必填：`profile_id`、`text`。

| 字段 | 类型 / 约束 | 默认 | 说明 |
|---|---|---|---|
| `profile_id` | string | — | 声音档案 id（`GET /profiles` 拿） |
| `text` | string, 1–50000 | — | 要合成的文本 |
| `language` | 枚举：`zh en ja ko de fr ru pt es it he ar da el fi hi ms nl no pl sv sw tr` | `en` | 语言 |
| `engine` | 枚举：`qwen qwen_custom_voice qwen_voice_design luxtts chatterbox chatterbox_turbo tada kokoro omnivoice indextts` | 档案 `default_engine` | 覆盖引擎 |
| `instruct` | string, ≤500 | 档案 `default_instruct` | **传达说明**，逐引擎语义见 `instruct.md`；请求值**整体替换**档案默认值 |
| `seed` | int ≥0 \| null | null | 固定随机性（同 seed + 同参数可复现） |
| `model_size` | `1.7B` \| `0.6B` \| `1B` \| `3B` \| `2.5` | `1.7B` | 引擎模型档（IndexTTS 用 `2.5`） |
| `personality` | bool | false | true 且档案有人物设定时，先按角色改写文本再合成 |
| `max_chunk_chars` | int 100–5000 | 800 | 长文本分块长度 |
| `crossfade_ms` | int 0–500 | 50 | 分块之间的交叉淡化，0 = 硬切 |
| `normalize` | bool | true | 输出音量归一化 |
| `effects_chain` | `EffectConfig[]` \| null | null | 后处理链，覆盖档案默认 |

### 1.2 典型调用（PowerShell / curl）

```bash
# 入队
curl -s -X POST http://127.0.0.1:17493/generate -H 'Content-Type: application/json' \
  -d '{"profile_id":"<id>","text":"你好，这是一次合成测试","language":"zh","engine":"indextts","instruct":"speed=1.1\nsteps=12"}'

# 轮询（直到 status=completed）
curl -s http://127.0.0.1:17493/generate/<gid>/status

# 取音频
curl -s -o out.wav http://127.0.0.1:17493/audio/<gid>
```

> PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，想要真 curl 用 `curl.exe`。JSON 里的 `\n` 在 instruct 中是合法分隔符（换行或分号都行）。

## 2. 声音档案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/profiles` | 列出档案（字段：`id name description language avatar_path effects_chain voice_type preset_engine preset_voice_id design_prompt default_engine personality default_instruct generation_count sample_count created_at updated_at`） |
| `GET` `PATCH` `DELETE` | `/profiles/{profile_id}` | 读 / 改 / 删。**改档案时只想动一个字段**：请求体里只放那个字段（后端按 `model_fields_set` 判断），否则会把 `default_instruct` 等覆盖掉 |
| `GET` | `/profiles/presets/{engine}` | 该引擎的内置音色表（preset 档案用） |
| `POST` | `/profiles/{profile_id}/samples`、`GET`/`DELETE /profiles/samples/{sample_id}` | 参考音频样本管理 |
| `POST` | `/profiles/{profile_id}/compose` | 用多个样本合成/组合音色 |
| `GET` `PUT` | `/profiles/{profile_id}/effects` | 档案级效果链 |
| `POST` | `/profiles/{profile_id}/export`、`/profiles/import` | 档案导入导出 |

创建档案（`VoiceProfileCreate`）字段：`name`、`description`、`language`、`voice_type`、`preset_engine`、`preset_voice_id`、`design_prompt`、`default_engine`、`personality`、`default_instruct`。参考文本 `reference_text` 在导入样本时是**必填**（`min_length=1`）。

## 3. 其它常用

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 健康 + `model_loaded` / `gpu_type` / `vram_used_mb` |
| `GET` | `/health/filesystem` | 磁盘与缓存目录情况 |
| `GET` `POST` | `/models/status`、`/models/load`、`/models/unload`、`/models/{model_name}` | 模型加载/卸载（首次合成慢就是因为没加载） |
| `GET` `POST` | `/models/download`、`/models/progress/{model_name}`、`/models/migrate` | 模型下载与迁移 |
| `POST` | `/transcribe` | 音频 → 文本 |
| `GET` | `/captures`、`/captures/{capture_id}`、`/captures/{capture_id}/audio` | 捕获（录音）列表与音频 |
| `POST` | `/captures/{capture_id}/{retranscribe,refine}` | 重新转写 / 精修 |
| `GET` `POST` | `/effects/presets`、`/effects/available` | 效果预设 |
| `GET` | `/history`、`/history/stats`、`/history/failed`、`/history/{generation_id}` | 历史记录 |
| `GET` `POST` | `/stories`、`/stories/{story_id}/items` … | 多角色故事编排（多说话人场景的载体） |
| `GET` `POST` | `/settings/generation` | 全局默认（`max_chunk_chars` / `crossfade_ms` / `normalize_audio` / `autoplay_on_generate`） |
| `GET` | `/tasks/active`、`POST /tasks/clear` | 后台任务观察 |
| `POST` | `/cache/clear` | 清缓存（改了引擎参数后可用来排除旧缓存干扰） |
| `GET` `POST` `DELETE` | `/mcp/bindings`、`/mcp/bindings/{client_id}` | MCP 客户端绑定管理 |
| — | `/v1/audio/speech`、`/v1/models` | OpenAI 兼容层（给外部工具直接当 OpenAI TTS 用） |
| `POST` | `/shutdown` | 停服务 |

## 4. 并发与长文本

- `/generate` 是队列式异步；并发提交不会丢，`/tasks/active` 能看到在跑的。
- 长文本会被按 `max_chunk_chars` 切块、按 `crossfade_ms` 拼接；引擎侧还有自己的二次切块（如 chatterbox 系按 `utils/chunked_tts.py` 切，且会保护 `[laugh]` 这类括号标签不被劈开）。
- 想要"参数确实生效"的证据：取音频文件比时长/sha256，或看引擎侧日志（IndexTTS 见 `troubleshooting.md`）。
