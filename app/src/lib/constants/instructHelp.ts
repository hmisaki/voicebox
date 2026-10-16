/**
 * 「传达说明」(instruct) 的逐引擎帮助内容。
 *
 * 生成页的「传达说明」框右下角有个 `?` 按钮，弹层里的内容就来自这里。
 *
 * 为什么需要它：`instruct` 对每个引擎的含义都不一样 —— IndexTTS 是键值对
 * （`speed=1.2` / `steps=15`），Qwen 系是自由散文，OmniVoice 是闭集词表。
 * 把差异写在一张表里，比在界面上摆一排按钮更能说清楚。
 *
 * 文案（标签、说明、示例标题）都在 i18n 里，键为
 * `generation.instruct.help.<engine>.items.<id>`；本文件只放**与语言无关**的
 * 部分：能敲的键名、可一键插入的片段、以及「上游有但还没接线」的清单。
 */

export interface InstructHelpItem {
  /** i18n 键后缀：generation.instruct.help.<engine>.items.<id> */
  id: string;
  /** 键名，按实际键入的样子写。 */
  key: string;
  /** 值的样子，显示在键名后面。 */
  value?: string;
  /** 点击后插入的完整一行。 */
  insert: string;
}

export interface InstructHelp {
  /** 一键插入的完整示例行。 */
  examples: string[];
  /** 该引擎当前真正识别的键 / 语法。 */
  items: InstructHelpItem[];
  /** 容易踩的坑（互斥关系、静默降级、只取前 N 秒之类）—— 必须如实写出来。 */
  notes?: string[];
  /** 上游支持但 voicebox 尚未转发的项 —— 弹层里要如实标成「未接线」。 */
  pending?: string[];
}

const INDEXTTS: InstructHelp = {
  examples: [
    'speed=1.2',
    'speed=0.85',
    'steps=15',
    'emo_text=温柔又带点疲惫',
    'speed=0.9\nsteps=18',
  ],
  items: [
    { id: 'speed', key: 'speed', value: '1.2', insert: 'speed=1.2' },
    { id: 'durationFactor', key: 'duration_factor', value: '1.1', insert: 'duration_factor=1.1' },
    { id: 'emoText', key: 'emo_text', value: '温柔又带点疲惫', insert: 'emo_text=温柔又带点疲惫' },
    {
      id: 'emoVector',
      key: 'emo_vector',
      value: '0,0,0,0,0,0,0,1',
      insert: 'emo_vector=0,0,0,0,0,0,0,1',
    },
    { id: 'emoAudio', key: 'emo_audio', value: 'D:\\ref\\angry.wav', insert: 'emo_audio=' },
    { id: 'alpha', key: 'alpha', value: '0.8', insert: 'alpha=0.8' },
    { id: 'silence', key: 'silence', value: '200', insert: 'silence=200' },
    { id: 'maxTokens', key: 'max_tokens', value: '120', insert: 'max_tokens=120' },
    { id: 'steps', key: 'steps', value: '15', insert: 'steps=15' },
    { id: 'seed', key: 'seed', value: '12345', insert: 'seed=12345' },
    { id: 'lang', key: 'lang', value: 'en', insert: 'lang=en' },
    { id: 'norm', key: 'norm', value: 'off', insert: 'norm=off' },
  ],
  // 全部实测过（tools/vb-emo-audio-test.py）：同 seed 下换真文件音频会变、
  // 假路径与「完全不写」逐字节相同、emo_text + emo_audio 与只有 emo_text 逐字节相同。
  notes: ['emoExclusive', 'emoAudioPath', 'emoAudioCut', 'alphaNeedsAudio'],
};

const QWEN_CUSTOM_VOICE: InstructHelp = {
  examples: [
    'Speak in a warm, gentle tone.',
    'Read this like a calm news anchor.',
    'A little nervous, slightly out of breath.',
  ],
  items: [],
};

const QWEN_VOICE_DESIGN: InstructHelp = {
  examples: ['Speak in a warm, gentle tone.', 'Slow and solemn, like a documentary narrator.'],
  items: [],
};

const OMNIVOICE: InstructHelp = {
  examples: ['female, low pitch, british accent', 'male, high pitch, american accent'],
  items: [],
  pending: ['omnivoiceClosedVocabulary'],
};

export const INSTRUCT_HELP: Record<string, InstructHelp> = {
  indextts: INDEXTTS,
  qwen_custom_voice: QWEN_CUSTOM_VOICE,
  qwen_voice_design: QWEN_VOICE_DESIGN,
  omnivoice: OMNIVOICE,
};

/** 该引擎的帮助；没有登记就返回 undefined（弹层改为只显示通用语法）。 */
export function instructHelpFor(engine: string | undefined): InstructHelp | undefined {
  return engine ? INSTRUCT_HELP[engine] : undefined;
}

/** 逐档案预填时用：把默认值拆成可读行（空行去掉）。 */
export function instructLines(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n\r;；]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
