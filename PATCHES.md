# PATCHES — 本 fork 相对上游 voicebox 的改动说明

本仓库是 [jamiepine/voicebox](https://github.com/jamiepine/voicebox) 的**个人 fork**，基线为上游提交
`8af7efe62fab8d33e2a5dfbedabaa45f68a5184f`（2026-10-07，`main`）。上游许可是 **MIT**（见 [LICENSE](LICENSE)，未做任何改动），
本 fork 同样按 MIT 分发。

改动只有一个目的：**给 voicebox 接上第 10 个引擎 IndexTTS 2.5，并把"引擎私有参数"这条链路从后端一路打通到前端与 MCP。**
本文档说明改了什么、为什么改、怎么验证、怎么回滚、怎么跟上游同步。

文件规模：**23 个已跟踪文件被修改**（+649 / −114 行），**3 个新增**
（`app/src/lib/constants/instructHelp.ts`、`backend/backends/indextts_backend.py`、`.agents/skills/voicebox/`），
外加本目录的 `patches/` 与本文档。

---

## 0. 一句话总结每组改动

| 组 | 主题 | 影响面 |
|---|---|---|
| **A** | IndexTTS 2.5 引擎接入（sidecar 形态） | 新后端 + 7 处登记 |
| **B** | `instruct`（传达说明）全参数接线 | 引擎侧解析器 + 仓库外两份补丁 |
| **C** | 声音档案级默认 `instruct` | DB 列 + 迁移 + API + 3 条路由兜底 |
| **D** | MCP 工具补齐参数 | `voicebox_speak` / `voicebox_list_profiles` |
| **E** | 前端：help 弹层、reset、切档案预填 | 生成页 + 档案表单 + i18n |
| **F** | `voicebox` skill 包 | `.agents/skills/voicebox/` |

---

## A. IndexTTS 2.5 作为第 10 个引擎

**为什么用 sidecar**：IndexTTS 需要 `transformers 4.52.1`，与本体的依赖树冲突，因此它的库与模型都放在
voicebox 之外（`D:\AI\IndexTTS`，模型在 `D:\AI\AIModels\VoiceBox\IndexTTS2.5`），由本后端**按需拉起**一个
HTTP sidecar（默认端口 `17494`）来跑推理。模型文件与 `data/` 都不进仓库（`data/` 已在 `.gitignore` 里）。

**新增**

- `backend/backends/indextts_backend.py` —— 引擎实现：懒启动并复用一个 sidecar 进程、健康检查、
  参考音频裁到前 15 秒、22050 Hz 单声道输出、启动超时 180 s、单次合成超时 900 s；
  无参考音频会**明确报错**（该引擎没有内置音色库，必须给参考音频）。

**登记（每处都是加一行左右）**

| 文件 | 改了什么 |
|---|---|
| `backend/backends/__init__.py` | 注册引擎（+23） |
| `backend/build_binary.py` | 冻结打包时 `--hidden-import backend.backends.indextts_backend`（引擎库刻意不打进去） |
| `app/src/lib/constants/engines.ts` | 加入 `INSTRUCT_ENGINES` |
| `app/src/lib/constants/languages.ts` | `ENGINE_LANGUAGES.indextts = ['ar','en','es','ja','zh']` |
| `app/src/components/Generation/EngineModelSelector.tsx` | 下拉项 + 描述 + 计入 `CLONING_ENGINES` |
| `app/src/components/ServerSettings/ModelManagement.tsx` | 模型卡片描述与分组归并 |
| `app/src/components/CapturesTab/CapturesTab.tsx` | 该引擎的模型/档案归并展示 |
| `app/src/lib/utils/format.ts` | 显示名 `IndexTTS 2.5`（顺带补上漏掉的 `OmniVoice`） |

## B. `instruct`（传达说明）全参数接线

背景：`instruct` 是 voicebox 里**唯一的"引擎私有参数通道"**（一个 ≤500 字符的自由字符串，逐引擎自定义语义）。
IndexTTS 最有价值的能力（语速、扩散步数、情绪）都只能从这里进去。

**仓库内（解析器）** —— `backend/backends/indextts_backend.py` 的 `_parse_instruct()`：

- 语法：一行一个 `键=值`；分隔符是换行 / `;` / `；`（**逗号不是分隔符**，因为 `emo_vector` 的值用逗号）；
  键不区分大小写并接受中文别名；`#` 开头的**整行**是注释（行内注释不行）。
- 未知键静默忽略；单个值非法只忽略该键并打一行 warning（不打断整次生成）。
- 夹取：`emo_alpha` 0–1、`interval_silence` 0–5000 ms、`max_text_tokens_per_segment` 20–600、
  `duration_factor` 0.5–2.0、`steps` 4–50。
- 键表：`speed`/`语速`(取倒数成时长倍率)、`duration_factor`/`时长`、`steps`/`步数`、`emo_text`/`情绪`、
  `emo_vector`(≤8 维：高兴,愤怒,悲伤,恐惧,反感,低落,惊讶,自然)、`emo_audio`、`alpha`/`强度`、
  `silence`、`max_tokens`、`norm`/`归一化`、`lang`/`语言`、`seed`、`random`。

**仓库外（必须另外应用）** —— 见 `patches/`：

| 文件 | 落到哪 | 说明 |
|---|---|---|
| `patches/indextts-sidecar-server.py` | `D:\AI\IndexTTS\server.py` | sidecar 本体：按需挂载情绪模型、只在文件真实存在时接受 `emo_audio`、透传 `diffusion_steps`/`use_random`、每次推理打一行 `推理参数 …`（**唯一的排障观测点**） |
| `patches/indextts-infer_v2_5.patch` | IndexTTS 仓库（上游 `d9e41aa`） | `git apply` 这份 diff：把写死的 `diffusion_steps = 25` 改成可被调用方覆盖（环境变量 `INDEXTTS_DIFFUSION_STEPS` 兜底）。**必须 `pop` 出来**，否则会被转发给 GPT 的 `generate()` 并抛 `ValueError: The following model_kwargs are not used by the model` |

**两条容易被忽略的语义**（都实测过）：

1. 请求里的 `instruct` **整体替换**档案默认值，不是逐键合并。
2. 情绪三件套互斥：`emo_text` 覆盖 `emo_vector`；这两者任一存在时 `emo_audio` **整段丢弃**；
   `alpha` 只在同时给了 `emo_audio` 时才有意义（否则被上游强制回 1.0）。

## C. 声音档案级默认 `instruct`

让"这个声音平时怎么说"跟着档案走，而不是每次手写。

- `backend/database/models.py`：`default_instruct = Column(Text, nullable=True)`
- `backend/database/migrations.py`：手写迁移框架里加一行 `_add_column`（与既有的 `personality` 同构）
- `backend/models.py`：Pydantic 读写字段（≤500 字符）
- `backend/services/profiles.py`：`_clean_instruct()` + `resolve_instruct(profile, request_instruct)`
  —— 请求值优先、空则用档案默认；更新档案时用 `model_fields_set` 判断"请求真的带了这个键"才改，
  避免旧前端编辑档案时把默认值抹掉
- 兜底：`backend/routes/generations.py`（`/generate` 与 `/generate/stream`）、
  `backend/routes/openai_compat.py`（OpenAI 兼容接口的 `instructions` 字段）、
  `backend/services/generation.py`（其它入队路径）

回落链：**请求 `instruct` → 档案 `default_instruct` → 引擎默认**（IndexTTS 还有环境变量
`INDEXTTS_DURATION_FACTOR` 兜底）。

## D. MCP 工具补齐参数

`backend/mcp_server/tools.py`：`voicebox_speak` 增加 `instruct` 与 `seed`（docstring 里写明逐引擎语义与
IndexTTS 键表），`voicebox_list_profiles` 返回值增加 `default_engine` 与 `default_instruct`。
补齐之前，Agent 通过 MCP 说话**用不到**语速/步数/情绪——这是本次最直接的动机。

## E. 前端

- **`app/src/components/Generation/FloatingGenerateBox.tsx`**（+238）：生成页的「传达说明」框改为
  ①旁边有 `?` 帮助弹层（内容**跟着当前引擎走**，含"这些限制"提示段，示例可点击插入）
  ②有 reset 按钮（常显，三态提示：当前是默认值 / 档案没设默认值 / 可恢复）
  ③切换声音档案时自动预填档案默认值（仅当输入框为空、或内容还等于上次自动带入的值——不覆盖手写内容）
- **`app/src/components/VoiceProfiles/ProfileForm.tsx`**（+46）：档案表单新增「默认传达说明」字段
  （校验、默认值、重置、草稿、四处提交路径）
- `app/src/lib/constants/instructHelp.ts`（新）：逐引擎帮助数据（摘要 / 示例 / 限制 notes / 待接线项）
- `app/src/lib/hooks/useGenerationForm.ts`、`app/src/lib/api/types.ts`、`app/src/stores/uiStore.ts`：类型与表单状态
- `app/src/i18n/locales/{zh-CN,en}/translation.json`：新增约 30 个键（含帮助弹层与 reset 提示文案）

## F. `voicebox` skill 包

`.agents/skills/voicebox/` —— 与仓库既有的 4 个 skill 同一目录约定，让 Agent 会正确使用这套服务：

```
.agents/skills/voicebox/
├── SKILL.md                    # 何时用、服务在哪、REST vs MCP、标准动作、排障三件
└── references/
    ├── rest-api.md             # 端点全表 + GenerationRequest 全字段 + 档案字段
    ├── instruct.md             # 逐引擎语义 + IndexTTS 键表/默认模板/情绪优先级实测
    ├── mcp.md                  # MCP 工具、地址（结尾斜杠！）、JSON-RPC 手工验证
    └── troubleshooting.md      # 服务/模型/参数不生效/MCP/改代码后怎么验证
```

安装到 DSH（或任何支持该约定的客户端）只需把整个目录复制到 skills 根目录，例如
`~/.dsh/skills/voicebox/`。

---

## 验证（三条硬证据，缺一条都不算通过）

```powershell
# 1) 服务活着（应含 "status":"healthy" 与 gpu_type）
curl.exe -s http://127.0.0.1:17493/health

# 2) 参数真的到了引擎：sidecar 日志里的「推理参数」行（注意在 .err.log —— logger 走 stderr）
Get-Content D:\AI\IndexTTS\logs\sidecar.err.log -Tail 20 | Select-String 推理参数

# 3) MCP 露出新参数
curl.exe -s -X POST http://127.0.0.1:17493/mcp/ -H 'Content-Type: application/json' `
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

本机实测基线（RTX 4070 Ti SUPER，参考音频 15 s 内）：首载约 18 s；warm RTF ≈ 0.69–0.71；
`steps=25` 约 3.57 s，`steps=6` 约 1.96 s（快约 1.8×）；`speed=1.3` → `duration_factor=0.769`。
**GPU 被别的程序占用时 RTF 会飙到 200 以上**，怀疑"卡住"先看显存。

## 回滚

```powershell
# 整个 fork 回到上游基线
git -C <本仓库> reset --hard 8af7efe

# 仓库外的两份：sidecar 直接覆盖回备份；上游 IndexTTS 反向应用
git -C D:\AI\IndexTTS\index-tts apply --reverse patches\indextts-infer_v2_5.patch
```

## 跟上游同步

- `origin` 指向上游 `jamiepine/voicebox`（便于跟进），`fork` 指向本仓库。
  同步：`git fetch origin && git merge origin/main`，解决冲突后 `git push fork main`。
- 若上游将来自己做了 IndexTTS 或 instruct 相关实现，优先看上游版本，再决定本 fork 的补丁是否还要保留。

### 第一次推送时踩到的两个坑（已解决，记录备查）

1. **原 clone 是 shallow 的**（只有 1 个提交深度）。shallow 仓库直接 push 会被远端拒：
   `remote: fatal: did not receive expected object … / remote unpack failed: index-pack failed`。
   解决：`git fetch --unshallow origin`（本机实测 10.6 s，补完 814 个提交、pack 约 99 MB），再 push。
2. **GitHub 的邮箱隐私保护**会拒收带着"私有邮箱"的提交：
   `GH007: Your push would publish a private email address`。
   解决：把提交身份换成 noreply 邮箱后重新提交：

   ```powershell
   git config user.name  "hmisaki"
   git config user.email "hmisaki@users.noreply.github.com"
   git commit --amend --reset-author --no-edit   # 或在后续提交里直接用这个身份
   ```

推上去之后实测：整仓（814 个提交 + 814 个历史 tag 里的 release tag）首次推送约 22 s / 99 MB。

## 不含什么

- **模型权重**：IndexTTS 2.5 在 `D:\AI\AIModels\VoiceBox\IndexTTS2.5`，其它引擎的模型由 VoiceBox 自己管理。
- **运行数据**：`data/`（档案库、缓存、生成的音频）已被 `.gitignore` 排除。
- **IndexTTS 上游源码树**：`D:\AI\IndexTTS\index-tts` 是独立 clone，只以 `patches/` 里的 diff 形式参与本仓库。
