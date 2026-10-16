# `instruct`（传达说明）逐引擎手册

`instruct` 是 VoiceBox 唯一的"引擎私有参数通道"：一个自由字符串，上限 **500 字符**，由各引擎自己解释。写之前先确认你选的引擎属于哪一类 —— 写错类别不会报错，只会**安静地什么都不发生**（IndexTTS 的非法单值只打一行 warning）。

## 1. 引擎 → 语义分类

| 类别 | 引擎 | 行为 |
|---|---|---|
| **忽略** | `kokoro`、`luxtts`、`chatterbox`、`chatterbox_turbo` | 传了不报错、不生效 |
| **自然语言** | `qwen_custom_voice`、`qwen_voice_design` | 当风格/情感描述读；`qwen_voice_design` 会把它**叠在** `design_prompt` 之后 |
| **闭集词表** | `omnivoice` | 只认固定属性词，非法值直接 `ValueError`（会让这次生成失败） |
| **键值对** | `indextts` | `键=值`，见下节 |

> `tada`、`qwen`（pytorch 系）使用方式按自然语言理解，细节以引擎实现为准。

## 2. IndexTTS 键表（本仓库补丁实现，实测过）

语法：**一行一个 `键=值`**；分隔符是换行、`;`、`；`（**逗号不是分隔符**，因为 `emo_vector` 的值本身用逗号）；键不区分大小写、带中文别名；`=`、`:`、`：` 都可作分隔。

```
# 整行注释（# 必须是行首）
speed=1.1            语速 1.1 倍
steps=15             扩散步数（默认 25）
```

| 键（别名） | 取值与夹取范围 | 作用 |
|---|---|---|
| `speed`（`语速`、`rate`） | >0 的浮点；**取倒数**成 `duration_factor`，最终夹在 **0.5–2.0** | 语速倍率，1.2 = 快 20% |
| `duration_factor`（`duration`、`时长`） | 浮点，夹在 **0.5–2.0** | 时长倍率，1.1 = 说得更慢 |
| `steps`（`步数`、`diffusion_steps`） | 整数，夹在 **4–50**（默认 25） | s2mel 扩散步数：越小越快、越糊 |
| `emo_text`（`emotion_text`、`emotion`、`情绪`、`情绪文字`） | 任意文本 | 用文字描述情绪；会**自动开启** `use_emo_text` |
| `emo_vector`（`emotion_vector`、`vector`、`情绪向量`） | 逗号/空格分隔的浮点，**最多取前 8 个**（顺序：高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 自然） | 手写 8 维情绪向量 |
| `emo_audio`（`emotion_audio`、`情绪音频`） | 文件路径 | 情绪参考音，**只借情绪**；音色仍来自档案参考音频 |
| `alpha`（`emo_alpha`、`strength`、`强度`） | 0–1（夹取） | 情绪强度，**只在同时给了 `emo_audio` 时才有意义** |
| `silence`（`interval_silence`、`静音`） | 整数毫秒，夹在 **0–5000** | 分段之间的静音 |
| `max_tokens`（`max_text_tokens_per_segment`、`分段字数`） | 整数，夹在 **20–600** | 每段最大 token |
| `norm`（`normalize`、`text_normalization`、`归一化`） | `on/off/true/false/1/0/开/关/是/否/启用/禁用` | 文本归一化 |
| `seed` | 整数 | 随机种子（同 seed + 同参数可复现） |
| `random`（`随机`、`emo_random`） | 同上布尔词 | 情绪矩阵取随机索引（否则取余弦最近） |
| `lang`（`language`、`语言`） | 语言码，须在支持表内（宣称支持 `zh/en/ja/es/ar`；另有 34 个可透传码），否则**忽略该键** | 覆盖语言 |

**不认识的键**：静默忽略（instruct 是所有引擎共用的输入框，别的引擎的写法不该报错）。
**单个值非法**：只忽略该键并打一行 `IndexTTS 传达说明里 … 的值无法解析，已忽略`，不打断整次生成。

### 2.1 默认模板（可直接抄用）

```
# 「传达说明」一行一个 键=值，换行或分号分隔；# 开头的整行是注释
speed=1.0
steps=15
max_tokens=120
silence=200
norm=on
# emo_text=温柔又带点疲惫
# emo_vector=0,0,0,0,0,0,0,1
# emo_audio=D:\path\to\emotion_ref.wav
# alpha=0.8
# lang=zh
# seed=12345
# random=on
```

## 3. 情绪三件套的优先级（上游 `infer_v2_5.py` 实测）

- `emo_text` 与 `emo_vector` **不能共存**：`use_emo_text` 为真时向量由文字重算，**覆盖**手写的 `emo_vector`。
- 上面两者任一存在，**`emo_audio` 会被整段丢弃**（上游把 `emo_audio_prompt` 置 `None`）——此时 sidecar 日志里的 `emo_audio=True` 只是转发前的记录，**别被它误导**。
- `alpha` 单独写等于没写：没有外部情绪音时上游会把 `emo_alpha` 强制回 `1.0`（且在缩放之后）。
- `emo_audio` 的路径**必须真实存在**：不存在就静默忽略（结果与完全没写 `emo_audio` 逐字节相同）。
- 情绪参考音**只取前 15 秒**并重采样到 16 kHz。

实测证据（同 seed、同文本，sha256 比对）：`emo_audio=<真> alpha=0.6` ≠ `alpha=1.0`；**假路径 == 只写 alpha**；`emo_text + emo_audio` == **只写 emo_text**；`只写 emo_audio` == `alpha=1.0`。

## 4. 与档案默认值的关系

```
请求 instruct（非空）  ──整体替换──▶  档案 default_instruct  ──▶  引擎默认
```

- **是替换不是合并**：只想改语速的话，别只写 `speed=1.2`，除非你确实要丢掉档案里的其它键（比如 `steps`）。
- 想"改一项、其余照旧"：先 `GET /profiles/{id}` 读回 `default_instruct`，在本地改完再整体传进去。
- 引擎级兜底：IndexTTS 的 `duration_factor` 在没有 instruct 时读环境变量 `INDEXTTS_DURATION_FACTOR`。

## 5. 调参经验（本机 RTX 4070 Ti SUPER 实测）

| 目的 | 做法 | 观测 |
|---|---|---|
| 更快 | `steps=6`（默认 25） | 1.96 s / RTF 0.615（15 步为 3.57 s / RTF 1.107） |
| 更快但仍清楚 | `steps=12~15` | 与 25 步听感接近 |
| 更慢更清楚 | `steps=25`（默认）或更高 | 首词更稳，代价是时间线性增长 |
| 语速 | `speed=1.3` → `duration_factor=0.769` | 时长按比例缩短，**不产生拉伸变调** |
| 带情绪 | 优先 `emo_text`；要精确配比再上 `emo_vector` | 首次用 `emo_text` 会按需加载情绪模型（约 1–2 s） |
