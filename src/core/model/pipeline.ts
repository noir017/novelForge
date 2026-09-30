/**
 * 创作流水线的领域模型：`Stage × Capability × Target`。
 *
 * **纯类型 + 纯函数，零 I/O、零 import**（与 naming.ts / identity.ts / chapterFile.ts 同类），
 * 因此前端、装配器、编排层、工程页共用同一份定义，不会各写一遍再慢慢跑偏。
 * 前端直接打包这个文件（见 media/src/protocol.ts），所以这里**一个 import 都不能有**。
 *
 * 三个正交维度：
 *
 * - **Stage**：我在哪一层（决定 AI 的身份、装配配方、产物落到哪）
 * - **Capability**：我要它干什么（任何阶段都能用，只是可用集合不同）
 * - **Target**：我在改哪一个具体产物
 *
 * ## 设定先行，一章一纲
 *
 * 展开的链（思路来自 AI-Novel-Writer，GPL-3.0，源自 AI_NovelGenerator）：
 *
 * ```
 * 一句话 ─▶ 架构：小说配置 → 故事前提 → 角色图谱 → 世界观
 *        ─▶ 情节大纲（按章号区间分节）
 *        ─▶ 细纲 plots/NNN-标题.md（一章一份，每批 5 章）
 *        ─▶ 正文 chapters/NNN-标题.md（直接落盘）
 *        ─▶ 定稿（摘要）
 * ```
 *
 * **一条轴：细纲号 = 章号。** 从前是两条：规划的单位是「剧情段」，一段写完再由
 * 作者标断点切成几章，界面上的「剧情 N」是推导出来的位次。那套跑出来的正文是
 * 梗概体的流水账——细纲太虚、又没有长度锚点，模型拿到一条抽象的因果链去「扩写」。
 * 现在一章一份细纲、每章一个目标字数，卷、中转站、拆章、位次统统删掉。
 * 老工程磁盘上的 `volumes/`、`manuscripts/` 一个字节都不动，代码只是不再读它们。
 */

// ---------------------------------------------------------------- Stage

/**
 * 创作阶段。四层，自上而下：这是个什么故事 → 故事怎么走 → 这一章发生什么 →
 * 怎么写出来。
 *
 * `setting` 界面上叫「架构」而不叫「设定」：设定条目（`lore/`）在工程页上一直
 * 叫「设定」，两个东西撞名的话作者分不清点开的是哪一个。
 */
export type CreationStage = 'setting' | 'outline' | 'plot' | 'manuscript';

export const CREATION_STAGES: CreationStage[] = ['setting', 'outline', 'plot', 'manuscript'];

/** 阶段的中文名。前端按钮、日志、确认框共用这一份，不在前端另写。 */
export const STAGE_LABEL: Record<CreationStage, string> = {
  setting: '架构',
  outline: '大纲',
  plot: '细纲',
  manuscript: '正文',
};

/** 每个阶段回答的那个问题。前端的流水线条用它做 tooltip。 */
export const STAGE_QUESTION: Record<CreationStage, string> = {
  setting: '这是个什么故事？谁在里面，世界怎么运转？',
  outline: '故事怎么走？',
  plot: '这一章发生什么？',
  manuscript: '怎么把它写出来？',
};

/**
 * AI 在该阶段的身份。
 *
 * 这比提示词技巧更要紧：同一句「这里冲突太弱」，策划会去动卖点与人设，
 * 大纲编辑会去动故事结构，剧情编剧会去调这一章的事件与钩子，作者会去改措辞。
 * 不说清身份，四个阶段会得到同一种泛泛而谈的回答。
 */
export const STAGE_ROLE: Record<CreationStage, string> = {
  setting: '资深网文策划编辑',
  outline: '资深长篇小说策划编辑',
  plot: '剧情编剧',
  manuscript: '资深中文长篇小说作者',
};

export function isCreationStage(value: unknown): value is CreationStage {
  return typeof value === 'string' && (CREATION_STAGES as string[]).includes(value);
}

// ---------------------------------------------------------------- 架构的四件文档

/**
 * 架构层的四件文档，顺序即生成顺序：每一件都吃前面几件的产出。
 *
 * `characters`（角色图谱）没有自己的文件——它就是 `characters/` 下那一组角色卡。
 * 另外三件各是一份文件（见 model/settingFile.ts）。
 */
export type SettingDoc = 'config' | 'premise' | 'characters' | 'world';

export const SETTING_DOCS: SettingDoc[] = ['config', 'premise', 'characters', 'world'];

export const SETTING_DOC_LABEL: Record<SettingDoc, string> = {
  config: '小说配置',
  premise: '故事前提',
  characters: '角色图谱',
  world: '世界观',
};

export function isSettingDoc(value: unknown): value is SettingDoc {
  return typeof value === 'string' && (SETTING_DOCS as string[]).includes(value);
}

// ---------------------------------------------------------------- Capability

/**
 * 通用能力。与阶段正交——「讨论」不是一个模式，而是三个能力之一。
 *
 * 留下来的每一个都有**提示词之外**的结构差异：输出契约、解析、装配配方、
 * 采纳流程，那才是值得作者显式挑一下的东西。从前还有一个 `split`（大纲拆卷、
 * 卷拆剧情段），卷那一层删掉之后它没有落点了。
 */
export type Capability = 'discuss' | 'generate' | 'settle';

export const CAPABILITIES: Capability[] = ['discuss', 'generate', 'settle'];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  discuss: '讨论',
  generate: '生成',
  settle: '落定',
};

/** 按钮的 tooltip。说清「点了会发生什么」，尤其是会不会产出可采纳的东西。 */
export const CAPABILITY_HINT: Record<Capability, string> = {
  discuss: '就当前产物提问，AI 只回答，不改动任何文件',
  generate: '按你描述的走向产出本阶段的产物，可采纳写入；目标已有内容时，你的话就是修改意见',
  settle: '把刚才讨论出的结论整理成产物，可采纳写入',
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as string[]).includes(value);
}

/**
 * 能力在某个阶段的**具体说法**。`CAPABILITY_LABEL` 是通用说法，日志与确认框
 * 用它是对的；界面上有阶段做上下文，说得具体些更好懂。
 */
const CAPABILITY_LABEL_IN: Partial<Record<CreationStage, Partial<Record<Capability, string>>>> = {
  setting: { generate: '生成这份架构文档' },
  outline: { generate: '生成情节大纲' },
  plot: { generate: '写细纲', settle: '落定细纲' },
  manuscript: { generate: '写正文' },
};

/** 某阶段下某能力在按钮上的说法。 */
export function labelOf(stage: CreationStage, capability: Capability): string {
  return CAPABILITY_LABEL_IN[stage]?.[capability] ?? CAPABILITY_LABEL[capability];
}

/**
 * 每个阶段合法的能力。**前端的命令面板经 `commandsFor` 读它**，不在前端另写一份。
 *
 * **只有 `plot` 有 `settle`**：细纲是唯一一层「先跟人聊、聊出结论再落文件」的
 * 东西（第 22 条）。架构与大纲通常一次成型，正文是从细纲展开而不是从对话展开。
 */
export const STAGE_CAPABILITIES: Record<CreationStage, Capability[]> = {
  setting: ['discuss', 'generate'],
  outline: ['discuss', 'generate'],
  plot: ['discuss', 'settle', 'generate'],
  manuscript: ['discuss', 'generate'],
};

/**
 * 切到某阶段时默认高亮哪个能力。
 *
 * 一律是 `discuss`：默认动作不该是花钱产出一份要不要都不知道的产物。
 * 这是「不偷偷烧 token」在交互上的落法——用户得主动点「生成」。
 */
export const DEFAULT_CAPABILITY: Record<CreationStage, Capability> = {
  setting: 'discuss',
  outline: 'discuss',
  plot: 'discuss',
  manuscript: 'discuss',
};

export interface CreationAction {
  stage: CreationStage;
  capability: Capability;
}

export function isValidAction(action: CreationAction): boolean {
  return (
    isCreationStage(action.stage) &&
    isCapability(action.capability) &&
    STAGE_CAPABILITIES[action.stage].includes(action.capability)
  );
}

/**
 * 删掉的能力在老会话里的落点：改写并进了生成，其余是讨论的变体。
 * `split`（拆卷 / 拆段）**不映射**——它认不出，于是回落到默认的讨论：
 * 打开一个老会话不该替作者按下一个会花钱的按钮。
 */
const LEGACY_CAPABILITY: Record<string, Capability> = {
  rewrite: 'generate',
  expand: 'discuss',
  critique: 'discuss',
  check: 'discuss',
};

/**
 * 删掉的阶段在老会话里的落点。与 `normalizeTarget` 必须一致，否则老会话打开时
 * stage 说一层、target 指另一层。
 *
 * - `scene`（细节层）落到 `plot`：那一层的会话记的是「这一幕该怎么发生」。
 * - `volume`（卷纲）落到 `outline`：卷那一层删掉了，离它最近的是情节大纲。
 */
const LEGACY_STAGE: Record<string, CreationStage> = {
  scene: 'plot',
  volume: 'outline',
};

/**
 * 容错归一：认不出的阶段回落到 `manuscript`（老会话最可能是在续写），
 * 认不出或该阶段不支持的能力回落到该阶段的默认能力。**绝不抛**。
 */
export function normalizeAction(raw: unknown): CreationAction {
  const o = (raw ?? {}) as { stage?: unknown; capability?: unknown };
  const rawStage = typeof o.stage === 'string' ? LEGACY_STAGE[o.stage] ?? o.stage : o.stage;
  const stage: CreationStage = isCreationStage(rawStage) ? rawStage : 'manuscript';
  const raw2 = typeof o.capability === 'string' ? LEGACY_CAPABILITY[o.capability] ?? o.capability : o.capability;
  const capability =
    isCapability(raw2) && STAGE_CAPABILITIES[stage].includes(raw2) ? raw2 : DEFAULT_CAPABILITY[stage];
  return { stage, capability };
}

// ---------------------------------------------------------------- 输出形态

/**
 * 输出形态。决定要不要解析成结构化产物、要不要问一次落盘。
 *
 * - `text`：自由作答，只出现在对话气泡里，不碰任何文件。
 * - `artifact`：产出本阶段的产物，可以采纳落盘。
 */
export type OutputKind = 'text' | 'artifact';

export function outputKindOf(action: CreationAction): OutputKind {
  return action.capability === 'discuss' ? 'text' : 'artifact';
}

// ---------------------------------------------------------------- 命令表

/**
 * 一条可执行的命令。创作页的 `/` 命令面板吃这一份。
 *
 * 在任何一个具体时刻，作者真正要按的只有一个（由状态机算出来，见 `deriveNextStep`），
 * 其余的是「偶尔要用」。偶尔要用的东西该收进命令面板，不该常驻占地方。
 */
export interface StageCommand {
  capability: Capability;
  /** 按钮/菜单项上的说法，已按阶段具体化。 */
  label: string;
  hint: string;
  /** `/` 面板的过滤键。中文标签之外再给 ascii 别名，免得为了打一个命令切输入法。 */
  keys: string[];
}

/** 各能力的 ascii 别名。全拼 + 拼音首字母，两种都认。 */
const CAPABILITY_KEYS: Record<Capability, string[]> = {
  discuss: ['discuss', 'tl'],
  generate: ['generate', 'sc'],
  settle: ['settle', 'ld'],
};

/**
 * 这个阶段能下哪些命令。顺序即面板里的顺序。
 *
 * **`discuss` 不进面板**：讨论是默认动作——打字就是在讨论，不需要一条命令。
 * 于是面板里剩下的每一条都产出可采纳的产物（会花钱、会问一次落盘），
 * 这正是它们值得显式挑一下的原因。也因此命令都**不要求输入**：输入是可选的
 * 补充要求；`settle` 尤其不能要求输入——它要沉淀的是已经发生过的对话。
 */
export function commandsFor(stage: CreationStage): StageCommand[] {
  return (STAGE_CAPABILITIES[stage] ?? [])
    .filter((capability) => capability !== 'discuss')
    .map((capability) => ({
      capability,
      label: labelOf(stage, capability),
      hint: hintOf(stage, capability),
      keys: CAPABILITY_KEYS[capability],
    }));
}

/**
 * 某阶段下某能力的 tooltip。
 *
 * **细纲层的 `settle` / `generate`**：这两条是同一层里唯二产出同一种产物的命令，
 * 通用文案说不清它们的差别，而那个差别（以讨论为准还是以你这句话为准）正是
 * 作者要选的东西。
 */
function hintOf(stage: CreationStage, capability: Capability): string {
  if (stage === 'plot') {
    if (capability === 'settle') {
      return '把刚才讨论出的走向整理成这一章的细纲，以讨论里的结论为准';
    }
    if (capability === 'generate') {
      return '按你在输入框里描述的走向填成这一章的细纲';
    }
  }
  return CAPABILITY_HINT[capability];
}

/** 某阶段的某个能力对应的命令；不支持时 undefined。 */
export function commandOf(stage: CreationStage, capability: Capability): StageCommand | undefined {
  return commandsFor(stage).find((c) => c.capability === capability);
}

/**
 * 「第 12 章《夜入青云》」——一章在界面、日志、上下文标签里的统一说法。
 *
 * **未命名的章只报序号。** 标题可能还没定（`007.md`），`listChapters` 的标题回落链
 * 也会给出「第 7 章」；模板一套就成了「第 7 章《第 7 章》」——读起来像出了 bug。
 * 判据就是「标题恰好等于那个回落值」，因为那正是「没有标题」在数据里的样子。
 *
 * 细纲（`plots/`）与正文（`chapters/`）说的是同一章，所以只有这一个说法。
 */
export function chapterLabel(order: number, title?: string): string {
  const named = title?.trim();
  return named && !isFallbackChapterTitle(order, named) ? `第 ${order} 章《${named}》` : `第 ${order} 章`;
}

/**
 * 这个标题就是「没有标题」在数据里的样子。
 *
 * 无标题的章（`009.md`）在 `listChapters` 的回落链里会拿到「第 9 章」——
 * 那不是作者起的名字，是没有名字。凡是要拿标题去**造东西**的地方都得先问一句：
 * 拿它拼细纲文件名会得到 `009-第-9-章.md`，一个假标题就此进了磁盘。
 */
export function isFallbackChapterTitle(order: number, title?: string): boolean {
  return (title?.trim() ?? '') === `第 ${order} 章`;
}

/** {@link chapterLabel} 在细纲那一侧的别名。输出完全一致。 */
export const plotLabel = chapterLabel;

// ---------------------------------------------------------------- Target

/**
 * 当前在改哪个产物。
 *
 * 细纲与正文**一律用 `plotRelPath` 而不是章号**：号会撞（作者手改文件名时
 * `007-a.md` 与 `007-b.md` 并存是允许的），路径不会。正文的落点由细纲号去认
 * 同号的章节——那一步要读盘，不在这里做（见 views/pipeline.ts 的 `chapterOfPlotNo`）。
 */
export type CreationTarget =
  | { kind: 'setting'; doc: SettingDoc }
  | { kind: 'outline' }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'manuscript'; plotRelPath: string };

/**
 * target 属于哪个阶段。两者不是同一件事：target 是名词，stage 是动词的所在层。
 *
 * 现在是恒等映射。留着这个函数是因为调用点分属两条取数路径，读代码时能看出
 * 手里拿的是名词还是动词。
 */
export function stageOfTarget(target: CreationTarget): CreationStage {
  return target.kind;
}

/** 该 target 归属的细纲路径；架构与大纲都没有归属章。 */
export function plotOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'plot' || target.kind === 'manuscript' ? target.plotRelPath : undefined;
}

/** 该 target 是架构的哪一件；不是架构时 undefined。 */
export function settingOfTarget(target: CreationTarget): SettingDoc | undefined {
  return target.kind === 'setting' ? target.doc : undefined;
}

/**
 * 稳定的字符串键。会话分组、前端 dataset、失败记录都用它，
 * 避免各处自己拼一份格式不同的 id。
 */
export function targetKey(target: CreationTarget): string {
  switch (target.kind) {
    case 'setting':
      return `setting:${target.doc}`;
    case 'outline':
      return 'outline';
    case 'plot':
      return `plot:${target.plotRelPath}`;
    case 'manuscript':
      return `manuscript:${target.plotRelPath}`;
  }
}

export function isSameTarget(a: CreationTarget, b: CreationTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * 人类可读的位置描述，如「第 12 章《入宗风波》· 正文」。
 *
 * 后端生成、前端直接显示：文案只有一份，气泡里、历史页、日志里不会分叉。
 */
export function describeTarget(
  target: CreationTarget,
  info?: { no?: number; title?: string }
): string {
  if (target.kind === 'setting') {
    return `故事架构 · ${SETTING_DOC_LABEL[target.doc]}`;
  }
  if (target.kind === 'outline') {
    return '情节大纲';
  }
  const head = info?.no !== undefined ? plotLabel(info.no, info.title) : target.plotRelPath;
  return target.kind === 'plot' ? `${head} · 细纲` : `${head} · 正文`;
}

/**
 * 容错归一。认不出的一律回落到 `{ kind: 'outline' }`——它是唯一一个
 * 不依赖任何一章就一定存在的产物，因此是安全的落点。**绝不抛**：
 * 这条路上的输入来自会话 JSON（作者可能手改过）与前端消息。
 *
 * - 老会话里的 `scene` 落到 `plot`：它记着的 `plotRelPath` 仍然有效。
 * - 老会话里的 `volume` 落到 `outline`：卷那一层删掉了。
 * - `setting` 带着认不出的 `doc` 落到 `config`：那是架构的第一件。
 */
export function normalizeTarget(raw: unknown): CreationTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const plotRelPath = typeof o.plotRelPath === 'string' ? o.plotRelPath.trim() : '';

  switch (o.kind) {
    case 'setting':
      return { kind: 'setting', doc: isSettingDoc(o.doc) ? o.doc : 'config' };
    case 'plot':
    // 删掉的那一层：落回它所属那一章的细纲层。
    case 'scene':
      return plotRelPath ? { kind: 'plot', plotRelPath } : { kind: 'outline' };
    case 'manuscript':
      return plotRelPath ? { kind: 'manuscript', plotRelPath } : { kind: 'outline' };
    default:
      return { kind: 'outline' };
  }
}

// ---------------------------------------------------------------- 单章流水线状态

/**
 * 这一章当前该做哪一步。
 *
 * **全部由磁盘推导，不落盘**。存一个 `status: writing` 字段的话，作者手删
 * 半章正文之后它就在撒谎；而字数与 hash 永远诚实。
 *
 * 从前在正文与定稿之间还有一档 `split`（正文写在中转站，等作者标断点拆成章）。
 * 一章一纲之后正文直接落 `chapters/`，这一档没有了。
 */
export type PlotStage = 'plot' | 'manuscript' | 'finalize' | 'done';

export const PLOT_STAGE_LABEL: Record<PlotStage, string> = {
  plot: '待写细纲',
  manuscript: '待写正文',
  finalize: '待定稿',
  done: '已完成',
};

/**
 * 正文写到目标字数的这个比例就算写够了。
 *
 * **为什么要一个比例而不是「有字就算」**：写了五百字就跳到「待定稿」会让状态机
 * 在最需要说话的时候闭嘴——作者要的恰恰是「这一章还没写够，接着写」。
 * **为什么不是 1.0**：模型不会正好停在目标字数上，卡在 0.97 会让「待写正文」
 * 永远消不掉。自动续写（三期）用的也是这个比例。
 *
 * 判据只在这里定义一次，`deriveStage` 与 `deriveProgress` 共用——两处各写
 * 一遍的话，界面上会出现「进度 100% 但徽章说待写正文」。
 */
export const MANUSCRIPT_DONE_RATIO = 0.8;

/** 推导所需的全部事实。取数在 core/views/pipeline.ts，判断在这里，便于单测。 */
export interface PipelineFacts {
  /** 细纲有实质内容（「关键事件」非空，不是一份只有标题的骨架）。 */
  plotFilled: boolean;
  /** 同号章节的正文字数。 */
  words: number;
  /**
   * 这一章的目标字数：细纲的 `targetWords`，没写就是 `config.md` 的每章字数。
   *
   * **两者都没有就没有阈值可比**，那时「有字就算写够」——不拿一个猜出来的数字
   * 骗人（比如「一章总得有三千字」）。
   */
  targetWords?: number;
  /**
   * 正文所依据的细纲已经变过：细纲 frontmatter 的 `writtenFrom` 与细纲当前内容的
   * 指纹对不上。**从没记录过（作者手写的正文）就不算**，永不标脏（第 18a 条）。
   */
  upstreamStale: boolean;
  /** 同号的章节文件存在。 */
  chapterExists: boolean;
  summaryExists: boolean;
  summaryStale: boolean;
  /**
   * 细纲 frontmatter 里的 `status: done`——作者手工宣布这一章过了。
   * **只允许向前覆盖**：推导说 done 时不接受被标成未完成，
   * 否则会出现「文件明明变了但界面说完成」。
   */
  markedDone: boolean;
}

export function emptyFacts(): PipelineFacts {
  return {
    plotFilled: false,
    words: 0,
    upstreamStale: false,
    chapterExists: false,
    summaryExists: false,
    summaryStale: true,
    markedDone: false,
  };
}

/**
 * 正文的完成度，0..1。判据只有一条，`deriveStage` 与 `deriveProgress` 共用。
 *
 * 目标字数缺席时退化成布尔（有字就是 1）——见 `PipelineFacts.targetWords`。
 */
export function manuscriptRatio(f: Pick<PipelineFacts, 'words' | 'targetWords'>): number {
  if (f.words <= 0) {
    return 0;
  }
  if (!f.targetWords || f.targetWords <= 0) {
    return 1;
  }
  return Math.min(1, f.words / (f.targetWords * MANUSCRIPT_DONE_RATIO));
}

/**
 * 当前阶段。
 *
 * **先看正文在不在**：没有正文时，细纲排没排过决定是写细纲还是写正文。
 * 有正文之后：
 *
 * 1. 定稿过（摘要在且不过期）或作者宣布过了 → 完成。**定稿过的章即使细纲后来
 *    改了也不拉回「待写」**——那是作者已经认可的文字，界面只挂 ⟳ 提醒。
 * 2. 细纲在正文之后改过，或正文还没写够 → 写正文（重写 / 接着写）。
 * 3. 其余 → 待定稿。
 *
 * 老工程里只有正文、没有细纲的章走的也是这条：它们有字，于是是「待定稿」或
 * 「已完成」，不会被倒回去要求补细纲。
 */
export function deriveStage(f: PipelineFacts): PlotStage {
  const written = f.chapterExists && f.words > 0;
  if (!written) {
    return f.plotFilled ? 'manuscript' : 'plot';
  }
  if (f.markedDone || (f.summaryExists && !f.summaryStale)) {
    return 'done';
  }
  if (f.upstreamStale || manuscriptRatio(f) < 1) {
    return 'manuscript';
  }
  return 'finalize';
}

export interface PipelineProgress {
  plot: number;
  manuscript: number;
  summary: number;
}

/**
 * 三段完成度，各自 0..1。工程页的行与创作页的流水线条直接渲染它。
 *
 * **每一段只报它自己**：没有细纲就是 0，哪怕正文已经写完（老工程的章就是这样）。
 * 从前成品在就把前两段一律填满，那是因为「剧情段」与章不是一回事，成品的来源段
 * 常常找不到；一章一纲之后细纲就在同号那个位置，有没有一眼看得到，不必替它圆。
 */
export function deriveProgress(f: PipelineFacts): PipelineProgress {
  return {
    plot: f.plotFilled ? 1 : 0,
    manuscript: f.chapterExists ? manuscriptRatio(f) : 0,
    summary: f.summaryExists && !f.summaryStale ? 1 : 0,
  };
}

// ---------------------------------------------------------------- 下一步

/**
 * 状态机算出来的「现在该干什么」。创作页的主按钮吃这一份（第 20 条）。
 *
 * **与 `deriveStage` 共用同一套判据**，不另发明一套：那边算出停在哪一层，
 * 这边把那一层翻译成一个具体动作。两处如果各判各的，界面上就会出现
 * 「徽章说待写正文，按钮让你去定稿」。
 */
export interface NextStepPlan {
  stage: CreationStage;
  capability: Capability;
  /** 主按钮上的字，如「写第 12 章」。 */
  label: string;
  /** 按钮下面那句话：为什么是这一步。 */
  hint: string;
  /**
   * 这一步不是一次模型对话，而是一个工程动作。
   *
   * 目前只有定稿（`finalizeChapter`）：它是工程页那条既有的「总结这一章」，
   * 不该假装成一轮对话。
   */
  projectAction?: 'finalizeChapter';
  /**
   * 这一步覆盖的章号区间（闭区间）。大纲一次写一段区间、细纲一批写几章，
   * 按钮上的「第 21–40 章」与发给后端的范围都读它。
   */
  range?: { from: number; to: number };
  /**
   * 这一步落在哪个产物上。**全书层的下一步由纯函数给出**（架构、大纲）；
   * 细纲那一档要一个路径，而路径由文件名规则决定、纯函数算不出，
   * 于是留空由调用方用 `plotPathForNo` 补。单章的下一步也留空——落点就是那一章。
   */
  target?: CreationTarget;
}

/** 推导单章下一步所需的事实。 */
export interface NextStepFacts {
  /** 章号。按钮上要说「写第 12 章」。 */
  no: number;
  /** 正文字数。0 = 还没开始写。 */
  words: number;
  /** 正文写到目标字数的比例，`manuscriptRatio` 算出来的那一份。 */
  ratio: number;
  /** 细纲在正文写完之后改过。 */
  upstreamStale: boolean;
}

export function deriveNextStep(stage: PlotStage, f: NextStepFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'plot':
      return {
        stage: 'plot',
        capability: 'generate',
        label: `写第 ${f.no} 章细纲`,
        hint: '先把这一章要发生什么定下来：本章目的、关键事件、章末钩子。',
      };

    case 'manuscript':
      // 细纲改过而正文没跟上：要的是拿新细纲重做一版，不是往后接着写。
      if (f.upstreamStale && f.words > 0) {
        return {
          stage: 'manuscript',
          capability: 'generate',
          label: `重写第 ${f.no} 章`,
          hint: '细纲改过，现有正文可能已经与它对不上。',
        };
      }
      // 写过一部分但还没写够：说清是「接着写」而不是「重新写一遍」——
      // 落盘走的是追加，作者点下去不会丢掉前面那几千字。
      if (f.words > 0) {
        return {
          stage: 'manuscript',
          capability: 'generate',
          label: '接着写',
          hint: `第 ${f.no} 章写了 ${f.words} 字，还没写够（约 ${Math.round(f.ratio * 100)}%）。` +
            '接着往下写，新写的会追加在末尾。',
        };
      }
      return {
        stage: 'manuscript',
        capability: 'generate',
        label: `写第 ${f.no} 章`,
        hint: '细纲已经定好了，这一步把它写成小说。',
      };

    case 'finalize':
      return {
        // 停在正文层：定稿读的是正文，作者点开看的也是那份正文。
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'finalizeChapter',
        label: '定稿（生成摘要）',
        hint: '正文写够了。摘要是后面几百章唯一能记住这些内容的东西。',
      };

    // 都做完了就不催这一章——调用方会转去问全书的下一步（下一章）。
    case 'done':
      return undefined;
  }
}

// ---------------------------------------------------------------- 全书状态

/** 情节大纲一次写多少章。一次写一百章的大纲，后半段会稀得像目录（D20）。 */
export const OUTLINE_BATCH = 20;

/** 细纲一批写几章。一批里有前后因果，又不至于长到后几章潦草。 */
export const PLOT_BATCH = 5;

/**
 * 整本书走到哪一步。与 `PlotStage` 同构，只是粒度是全书。
 *
 * `writing` 的意思是「全书层没有要做的了，去做第 N 章」——那一章该做什么由
 * 单章状态机说（`deriveNextStep`）。
 */
export type BookStage = 'setting' | 'outline' | 'plots' | 'writing' | 'complete';

export interface BookFacts {
  /** 架构四件各自填过没有（角色图谱 = 至少有一张角色卡）。 */
  settings: Record<SettingDoc, boolean>;
  /** 情节大纲有内容。 */
  outlineFilled: boolean;
  /**
   * 情节大纲按章号区间覆盖到第几章（model/outlineFile.ts 的 `outlineCoverage`）。
   * 有内容但没有区间标题时是 `Infinity`——说不上覆盖到哪，就不拦。
   */
  outlineCoverage: number;
  /** `config.md` 的总章数。没写就没有「写完了」这一说。 */
  totalChapters?: number;
  /**
   * 下一个该写的章：从第 1 章起**连续**有正文的最大章号 + 1。
   *
   * 连续才算：第 1、2、5 章有正文时，下一个该写的是第 3 章——跳着写是作者的
   * 自由，但主按钮只推一个，推的应该是那个缺口。
   */
  nextChapterNo: number;
  /** 那一章有排好的细纲。 */
  nextPlotFilled: boolean;
}

/**
 * 判据自上而下取第一个不满足的：
 *
 * 1. 架构四件缺哪件 → 按顺序生成（每一件都吃前面几件）；
 * 2. 写满了总章数 → 完成；
 * 3. 大纲缺失，或下一章已经超出大纲的覆盖 → 生成 / 续写大纲；
 * 4. 下一章没有细纲 → 拆细纲；
 * 5. 否则 → 去写那一章。
 *
 * 老工程（有几十章正文、从没有过架构）会被推回第 1 条。这是有意的（D11）：
 * 新链路写正文要读前提、角色与世界观，没有它们上下文就是空的。
 */
export function deriveBookStage(f: BookFacts): BookStage {
  if (SETTING_DOCS.some((doc) => !f.settings[doc])) {
    return 'setting';
  }
  if (f.totalChapters && f.nextChapterNo > f.totalChapters) {
    return 'complete';
  }
  if (!f.outlineFilled || f.nextChapterNo > f.outlineCoverage) {
    return 'outline';
  }
  if (!f.nextPlotFilled) {
    return 'plots';
  }
  return 'writing';
}

/** 架构四件各自那句「为什么是这一步」。 */
const SETTING_HINT: Record<SettingDoc, string> = {
  config: '先把这个脑洞展开成一份小说配置：类型、卖点、主角、金手指，以及全书写多少章、每章多少字。',
  premise: '从配置里提炼故事前提：一句话前提、核心冲突链、金手指定位、悬念骨架。',
  characters: '按前提排出角色图谱：主角、盟友、对手，以及他们之间的关系。',
  world: '把世界观立起来：规则与它的漏洞、阶层与资源、深层危机。',
};

/** 「第 3 章」或「第 3–7 章」。 */
function rangeText(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 全书级的下一步。`writing` 与 `complete` 返回 undefined：前者交给第 N 章的单章
 * 状态机，后者就是没有下一步。
 *
 * `plots` 那一档的 target 留空，由调用方补上第 N 章细纲的路径（见 `NextStepPlan.target`）。
 */
export function deriveBookNextStep(stage: BookStage, f: BookFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'setting': {
      const doc = SETTING_DOCS.find((d) => !f.settings[d]) ?? 'config';
      return {
        stage: 'setting',
        capability: 'generate',
        label: `生成${SETTING_DOC_LABEL[doc]}`,
        hint: SETTING_HINT[doc],
        target: { kind: 'setting', doc },
      };
    }

    case 'outline': {
      const from = f.outlineFilled && Number.isFinite(f.outlineCoverage) ? f.outlineCoverage + 1 : 1;
      const to = Math.max(from, Math.min(from + OUTLINE_BATCH - 1, f.totalChapters ?? Infinity));
      const verb = f.outlineFilled ? '续写' : '生成';
      return {
        stage: 'outline',
        capability: 'generate',
        label: `${verb}情节大纲（${rangeText(from, to)}）`,
        hint: f.outlineFilled
          ? `大纲只覆盖到第 ${f.outlineCoverage} 章，接下来要写的第 ${f.nextChapterNo} 章还没有着落。`
          : '按故事结构把全书的走向排出来，按章号区间分节。一次写一段，后面的等写到了再续。',
        target: { kind: 'outline' },
        range: { from, to },
      };
    }

    case 'plots': {
      const from = f.nextChapterNo;
      const cap = Math.min(f.totalChapters ?? Infinity, f.outlineCoverage);
      const to = Math.max(from, Math.min(from + PLOT_BATCH - 1, cap));
      return {
        stage: 'plot',
        capability: 'generate',
        label: `拆细纲（${rangeText(from, to)}）`,
        hint: '从情节大纲里把接下来几章拆成一章一份的细纲：本章目的、关键事件、章末钩子。',
        range: { from, to },
      };
    }

    case 'writing':
    case 'complete':
      return undefined;
  }
}
