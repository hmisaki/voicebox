# VoiceBox 排障与验证

## 1. 服务没起来 / 起来了又没了

```powershell
# 谁在听？
Get-NetTCPConnection -LocalPort 17493,17494,5188 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
```

- **必须带 `-ExecutionPolicy Bypass`**，否则默认策略拒绝加载脚本：
  `powershell -NoProfile -ExecutionPolicy Bypass -File D:\AI\VoiceBox\start-voicebox.ps1 -NoBrowser`
  （也可以直接跑 `D:\AI\VoiceBox\start-voicebox.cmd`，它内部就是这个命令行）
- 已在跑要换代码，加 `-Restart`。
- **VoiceBox 不会跟着 DSH 网关一起重启**：网关重启后如果发现 17493 不通，手动再起一次即可。
- `POST /shutdown` 是停服务；`GET /health` 是确认活着的唯一权威。

## 2. 第一次合成慢 / 卡住

- `GET /health` 的 `model_loaded=false` 表示还没加载：IndexTTS 首次加载实测 **约 18 s**，之后 warm 起来 RTF ≈ 0.69–0.71。
- 想预热：`POST /models/load`；想腾显存：`POST /models/unload`。进度看 `GET /models/status`、`GET /models/progress/{model_name}`。
- **GPU 被别的程序占着会灾难性变慢**：实测有游戏运行时 RTF 从 0.7 掉到 **219**（同一次请求跑了 453 s）。怀疑"卡住"先看显存与占用进程。
- IndexTTS 模型目录 `D:\AI\AIModels\VoiceBox\IndexTTS2.5`，必需文件：`config.yaml`、`gpt.pth`、`s2mel.pth`、`codec.pth`、`multilingual_zh_ja_yue_char_del.tiktoken`、`qwen0.6bemo4-merge/model.safetensors`。

## 3. 参数"好像没生效"

按这个顺序查，别靠猜：

1. **读 sidecar 日志**（IndexTTS 的唯一真相）：`D:\AI\IndexTTS\logs\sidecar.err.log` 里的
   `推理参数 lang=zh duration_factor=0.769 steps=6 emo_text=False …` 行。
   ⚠️ sidecar 的 logger 输出到 **stderr**，所以看 `.err.log` 而不是 `.out.log`；
   日志按字节偏移读，可以只取"这次请求之后新增的行"。
2. **比音频本身**：同 `seed`、同文本、只改一个参数，量时长或比 sha256。逐字节相同 = 那个参数没起作用。
3. **确认 instruct 有没有被替换掉**：请求里的 `instruct` 是**整体替换**档案默认值（见 `instruct.md`）。
4. **清缓存**：`POST /cache/clear`，排除旧缓存干扰。

已知"看起来没生效"的四种情况都是**设计如此**：`emo_audio` 路径不存在（静默忽略）、`alpha` 单独写（被强制回 1.0）、`emo_text` 与 `emo_audio` 同给（后者整段丢弃）、`#` 注释写在行内（不解析）。

## 4. MCP 连不上

- 地址**必须以 `/` 结尾**：`http://127.0.0.1:17493/mcp/`（不带就是 307，客户端可能不跟随 → `server is disconnected`）。
- 确认后端在跑（17493 通）→ 改完 `cordis.patch.yml` 要重启网关才会重新注册工具。
- 手工验证用 `mcp.md` 里的 JSON-RPC 命令；返回 200 且内容里有 `"result"` 就说明服务端没问题。
- 改 MCP 工具参数后必须重启后端（`start-voicebox.ps1 -Restart`），`tools/list` 才会露出新参数。

## 5. 改了代码之后怎么验证

**后端 / 引擎（Python）**

- 改 `D:\AI\VoiceBox\app\backend\**` → `start-voicebox.ps1 -Restart -NoBrowser`。
- 改 IndexTTS 上游（`D:\AI\IndexTTS\server.py`、`D:\AI\IndexTTS\index-tts\indextts\infer_v2_5.py`）→ **还要杀掉占 `17494` 的 sidecar**，否则跑的还是旧进程里的旧代码：
  ```powershell
  Get-NetTCPConnection -LocalPort 17494 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
- 上游有个坑：把构造参数混进 `**generation_kwargs` 会被转发给 GPT 的 `generate()`，报
  `ValueError: The following model_kwargs are not used by the model: ['<参数名>']`。
  新增透传参数时要么在 `infer()` 入口 `pop` 出来，要么别塞进去（`diffusion_steps`、`use_qwen_emo` 都踩过）。

**前端（React）**

- 静态检查（cwd 必须是 `D:\AI\VoiceBox\app\app`）：
  ```powershell
  D:\AI\VoiceBox\app\node_modules\.bin\tsc.exe -p tsconfig.json --noEmit
  D:\AI\VoiceBox\app\node_modules\.bin\biome.exe format --write <文件>
  ```
- **验证某个模块真的被 dev server 处理了**：Vite root 是 `D:\AI\VoiceBox\app\web`，而应用源码在
  `D:\AI\VoiceBox\app\app\src`，所以正确姿势是
  `http://127.0.0.1:5188/@fs/D:/AI/VoiceBox/app/app/src/<相对路径>`
  直接请求 `/src/...` 会拿到 index.html（SPA 兜底）——**那不代表改动没生效**。
- 界面行为对不上先**硬刷新**：长时间开着的标签页会留着旧模块（HMR 陈旧），曾据此误判过"弹层张冠李戴"。

## 6. 别碰的东西

- `data/`（档案库、生成的音频）已在 `.gitignore` 里，**不要 `git add -f`**。
- 档案的 `reference_text` 是数据层必填（`min_length=1`），绕过它没有意义；IndexTTS 不读它，但别的引擎读（见下表）。

| 引擎 | 是否真用 `reference_text` |
|---|---|
| Qwen（MLX / pytorch） | 用（`create_voice_clone_prompt(ref_text=…)`） |
| chatterbox 系 | 用（传 `ref_text`） |
| hume | 有则用（否则自己 ASR） |
| omnivoice / luxtts | 不用传入值，缺了就自己跑 ASR |
| **indextts** | **完全不读**（只作缓存键） |
