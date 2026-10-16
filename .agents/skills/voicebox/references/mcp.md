# VoiceBox MCP 端点

VoiceBox **自带**一个 MCP 服务器，挂在同一个后端进程上（Streamable HTTP），不需要额外起进程。

## 1. 地址与配置

```
http://127.0.0.1:17493/mcp/
```

- **结尾斜杠是必须的**：不带斜杠会拿到 307 跳转，部分 MCP 客户端不跟随 → 表现成 "server is disconnected"。
- 建议带上客户端标识头：`X-Voicebox-Client-Id: <你的客户端名>`（用于 MCP 绑定与来源标记）。
- DSH 侧配置在 `C:\Users\hezhiping\.dsh\profiles\web\cordis.patch.yml` 的 `mcpServers.voicebox`；改完要重启网关才会重新注册 `mcp__voicebox__*` 工具。
- 仓库里还留了一份给别的客户端用的样例：`D:\AI\VoiceBox\app\.mcp.json`。
- 服务端有绑定机制：`GET/POST/DELETE /mcp/bindings`、`/mcp/bindings/{client_id}`，可限制某个客户端能看到哪些档案。

## 2. 工具清单（本机补丁后的形态）

| 工具 | 参数 | 说明 |
|---|---|---|
| `voicebox_speak` | `text`, `profile`, `engine`, `personality`, `language`, `model_size`, **`instruct`**, **`seed`** | 合成一句话。`profile` 可给档案名或 id |
| `voicebox_transcribe` | `audio_base64`, `audio_path`, `language`, `model` | 音频 → 文本 |
| `voicebox_list_captures` | `limit`, `offset` | 列出捕获（录音） |
| `voicebox_list_profiles` | — | 列出声音档案，返回 `name` / `voice_type` / `language` / `engine`（= `default_engine`）/ **`instruct`**（= `default_instruct`） |

> **本仓库补丁**：`instruct`、`seed` 与 `list_profiles` 的两个新字段是后加的（上游 MCP 当时只有 `text/profile/engine/language/personality/model_size`），所以"当天接出来的语速/步数/情绪在 MCP 路径上不可用"这类问题已经解决。`instruct` 语义与 REST 完全一致（见 `instruct.md`），不传时由路由回落到档案 `default_instruct`。

## 3. 调用语义

`voicebox_speak` 是**异步**的：它立刻返回

```json
{"generation_id":"…","status":"generating","profile":"…","source":"mcp","poll_url":"/generate/<id>/status"}
```

拿到 id 后走 REST 轮询 `GET http://127.0.0.1:17493/generate/<id>/status`，完成后 `GET /audio/<id>` 取音频。

## 4. 手工验证（JSON-RPC over HTTP）

```bash
# 列工具
curl -s -X POST http://127.0.0.1:17493/mcp/ \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Voicebox-Client-Id: manual' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 说一句（带 instruct）
curl -s -X POST http://127.0.0.1:17493/mcp/ \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Voicebox-Client-Id: manual' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"voicebox_speak","arguments":{"profile":"<档案名>","text":"测试","instruct":"speed=1.3\nsteps=6"}}}'
```

本仓库里有一份跑通这两步并顺带核对 sidecar 日志的脚本：`tools/vb-mcp-instruct-test.py`。

## 5. REST 还是 MCP？

| | REST `/generate` | MCP `voicebox_speak` |
|---|---|---|
| 参数面 | 全量（含 `normalize`、`effects_chain`、`max_chunk_chars`…） | 子集（含 `instruct`/`seed`） |
| 拿音频 | `/audio/{id}` 直接下文件 | 同样要回 REST 轮询 + 下载 |
| 适用 | 精细控制、批量、要落盘 | Agent 顺手说一句、快速预览 |

结论：**能用 REST 就用 REST**；MCP 是便捷入口。
