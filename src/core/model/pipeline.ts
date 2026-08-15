/**
 * 创作流水线的领域模型：`Stage × Capability × Target`。
 *
 * **纯类型 + 纯函数，零 I/O**（与 naming.ts / identity.ts / chapterFile.ts 同类），
 * 因此前端、装配器、编排层、工程页共用同一份定义，不会各写一遍再慢慢跑偏。
 *
 * 这里替换掉的是旧的 `mode: 'write' | 'discuss'`。那个开关是按 **AI 的输出形式**
 * 划分的，而不是按作者真实的创作流程划分：
 *
 * - 「讨论」不是一个模式——大纲、剧情、场景、正文四个阶段都会讨论；
 * - 「续写」不是一个阶段——它只是正文阶段的一个动作。
 *
 * 所以拆成三个正交维度：
 *
 * - **Stage**：我在哪一层（决定 AI 的身份、装配配方、产物落到哪）
 * - **Capability**：我要它干什么（任何阶段都能用，只是可用集合不同）
 * - **Target**：我在改哪一个具体产物
 *
 * ## 单位是章，但生成时不受「一章」束缚
 *
 * 流水线的每一格就是**一章**：第 99 章之后规划的就是第 100 章，编号跨
 * `plots/` 与 `chapters/` 连续（`nextPlotNo()`）。界面上一律称「章」。
 *
 * 但生成正文时**不要求它正好凑成一章**——那是这一层与旧版最大的区别。模型按
 * 剧情的自然长度写，正文先落在中转站 `manuscripts/`；作者在里面用 `---` 标出
 * 断点，一份正文可以拆成两章、三章。拆完中转站那份就删掉，此后一切按
 * `chapters/` 管理（见 model/plotFile.ts 的文件头）。
 *
 * 所以 `PlotStage` 比四层产物多一档 `split`：正文写完、还没拆分。
 */

// ---------------------------------------------------------------- Stage

/** 创作阶段。四层，自上而下：故事讲什么 → 这章发生什么 → 这幕怎么发生 → 怎么写出来。 */
export type CreationStage = 'outline' | 'plot' | 'scene' | 'manuscript';

export const CREATION_STAGES: CreationStage[] = ['outline', 'plot', 'scene', 'manuscript'];

/** 阶段的中文名。前端按钮、日志、确认框共用这一份，不在前端另写。 */
export const STAGE_LABEL: Record<CreationStage, string> = {
  outline: '大纲',
  plot: '剧情',
  scene: '细节',
  manuscript: '正文',
};

/** 每个阶段回答的那个问题。前端的流水线条用它做 tooltip。 */
export const STAGE_QUESTION: Record<CreationStage, string> = {
  outline: '故事讲什么？',
  plot: '这一章发生什么？',
  scene: '这一幕具体怎么发生？',
  manuscript: '怎么把它写出来？',
};

/**
 * AI 在该阶段的身份。
 *
 * 这比提示词技巧更要紧：同一句「这里冲突太弱」，策划编辑会去动故事结构，
 * 剧情编剧会去调这一章的事件与因果，编剧会去想这一幕的画面，作者会去改措辞。
 * 不说清身份，四个阶段会得到同一种泛泛而谈的回答。
 */
export const STAGE_ROLE: Record<CreationStage, string> = {
  outline: '资深长篇小说策划编辑',
  plot: '剧情编剧',  scene: '分镜编剧',
  manuscript: '资深中文长篇小说作者',
};

export function isCreationStage(value: unknown): value is CreationStage {
  return typeof value === 'string' && (CREATION_STAGES as string[]).includes(value);
}

// ---------------------------------------------------------------- Capability

/** 通用能力。与阶段正交——「讨论」不再是一个模式，而是八个能力之一。 */
export type Capability =
  | 'discuss'
  | 'expand'
  | 'critique'
  | 'check'
  | 'split'
  | 'generate'
  | 'settle'
  | 'rewrite';

export const CAPABILITIES: Capability[] = [
  'discuss',
  'expand',
  'critique',
  'check',
  'split',
  'generate',
  'settle',
  'rewrite',
];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  discuss: '讨论',
  expand: '扩展',
  critique: '挑刺',
  check: '检查',
  split: '拆分',
  generate: '生成',
  settle: '落定',
  rewrite: '改写',
};

/** 按钮的 tooltip。说清「点了会发生什么」，尤其是会不会产出可采纳的东西。 */
export const CAPABILITY_HINT: Record<Capability, string> = {
  discuss: '就当前产物提问，AI 只回答，不改动任何文件',
  expand: '在现有产物上补充内容，产出建议而非直接覆盖',
  critique: '找逻辑漏洞、冲突太弱、节奏问题',
  check: '与既有设定、伏笔、时间线对账',
  split: '拆成下一层：大纲拆成各章，剧情拆成场景',
  generate: '按你描述的走向产出本阶段的产物，可采纳写入',
  settle: '把刚才讨论出的结论整理成产物，可采纳写入',
  rewrite: '拿着修改意见重做一版，可采纳写入',
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as string[]).includes(value);
}

/**
 * 能力在某个阶段的**具体说法**。`CAPABILITY_LABEL` 是通用说法，日志与确认框
 * 用它是对的；界面上有阶段做上下文，说得具体些更好懂。
 *
 * 只覆盖差别大到会让人误解的那几处：`split` 在大纲拆的是一章章的细纲、在剧情层
 * 拆的是场景；`generate` 在四层产出的是四种完全不同的东西。其余沿用通用说法。
 */
const CAPABILITY_LABEL_IN: Partial<Record<CreationStage, Partial<Record<Capability, string>>>> = {
  outline: { split: '拆成章节', generate: '生成大纲', rewrite: '重写大纲' },
  plot: { split: '拆成场景', generate: '写剧情', settle: '落定剧情', rewrite: '重写剧情' },
  scene: { generate: '设计这一场', rewrite: '重做这一场' },
  manuscript: { generate: '写正文', rewrite: '重写正文' },
};

/** 某阶段下某能力在按钮上的说法。 */
export function labelOf(stage: CreationStage, capability: Capability): string {
  return CAPABILITY_LABEL_IN[stage]?.[capability] ?? CAPABILITY_LABEL[capability];
}

/**
 * 每个阶段合法的能力。**前端的按钮组直接读它**，不在前端另写一份。
 *
 * 三处刻意的缺席与一处刻意的独有：
 * - `scene` 没有 `split`：场景已经是最小的可采纳单位，再往下拆就是一句一句的
 *   动作，那是正文的事，不单独成文件。
 * - `manuscript` 没有 `split` / `expand`：正文阶段要的是重写整章，
 *   而不是往里插东西——插出来的段落接不上上下文的语气。
 * - **只有 `plot` 有 `settle`**：剧情是唯一一层「先跟人聊、聊出结论再落文件」
 *   的东西。大纲通常一次成型，场景与正文都是从上一层展开而不是从对话展开。
 *   把 `settle` 铺到四层，另外三层会得到一个几乎没人点、点了也不知道该沉淀
 *   什么的按钮。
 */
export const STAGE_CAPABILITIES: Record<CreationStage, Capability[]> = {
  outline: ['discuss', 'expand', 'critique', 'check', 'split', 'generate', 'rewrite'],
  plot: ['discuss', 'settle', 'generate', 'expand', 'critique', 'check', 'split', 'rewrite'],
  scene: ['discuss', 'expand', 'critique', 'check', 'generate', 'rewrite'],
  manuscript: ['discuss', 'critique', 'check', 'generate', 'rewrite'],
};

/**
 * 切到某阶段时默认高亮哪个能力。
 *
 * 一律是 `discuss`：默认动作不该是花钱产出一份要不要都不知道的产物。
 * 这是「不偷偷烧 token」在交互上的落法——用户得主动点「生成」。
 */
export const DEFAULT_CAPABILITY: Record<CreationStage, Capability> = {
  outline: 'discuss',
  plot: 'discuss',
  scene: 'discuss',
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
 * 容错归一：认不出的阶段回落到 `manuscript`（老会话最可能是在续写），
 * 认不出或该阶段不支持的能力回落到该阶段的默认能力。**绝不抛**。
 */
export function normalizeAction(raw: unknown): CreationAction {
  const o = (raw ?? {}) as Partial<CreationAction>;
  const stage: CreationStage = isCreationStage(o.stage) ? o.stage : 'manuscript';
  const capability =
    isCapability(o.capability) && STAGE_CAPABILITIES[stage].includes(o.capability)
      ? o.capability
      : DEFAULT_CAPABILITY[stage];
  return { stage, capability };
}

// ---------------------------------------------------------------- 输出形态

/**
 * 输出形态。决定要不要解析成结构化产物、要不要给「采纳」按钮。
 *
 * - `text`：自由作答，只出现在对话气泡里，不碰任何文件。
 * - `artifact`：产出本阶段的产物，可以采纳落盘。
 */
export type OutputKind = 'text' | 'artifact';

export function outputKindOf(action: CreationAction): OutputKind {
  return action.capability === 'generate' ||
    action.capability === 'settle' ||
    action.capability === 'rewrite' ||
    action.capability === 'split'
    ? 'artifact'
    : 'text';
}

// ---------------------------------------------------------------- 命令表

/**
 * 一条可执行的命令。创作页的 `/` 命令面板吃这一份。
 *
 * 取代了原来那排七个平铺的能力按钮。平铺的问题不是不好看，是**七个等重的
 * 按钮看不出该点哪个**——而在任何一个具体时刻，作者真正要按的只有一个
 * （由状态机算出来，见 `deriveNextStep`），其余的是「偶尔要用」。
 * 偶尔要用的东西该收进命令面板，不该常驻占地方。
 */
export interface StageCommand {
  capability: Capability;
  /** 按钮/菜单项上的说法，已按阶段具体化。 */
  label: string;
  hint: string;
  /** 点了会写文件（产出可采纳的产物）。界面上要与「只是聊聊」分得开。 */
  writes: boolean;
  /**
   * 必须有输入才有意义。
   *
   * **只有 `discuss`**：讨论的全部内容就是作者那句话，没有话就没有讨论。
   * 其余的输入是可选的补充要求——「写剧情」不需要作者说任何话（大纲与前后
   * 章里都写着），逼他先写一句才能点，是旧界面最没道理的一处。
   *
   * `settle` 尤其不能要求输入：它要沉淀的是**已经发生过的对话**，
   * 此刻输入框本来就该是空的。
   */
  needsText: boolean;
  /** `/` 面板的过滤键。中文标签之外再给 ascii 别名，免得为了打一个命令切输入法。 */
  keys: string[];
}

/** 各能力的 ascii 别名。全拼 + 拼音首字母，两种都认。 */
const CAPABILITY_KEYS: Record<Capability, string[]> = {
  discuss: ['discuss', 'tl'],
  expand: ['expand', 'kz'],
  critique: ['critique', 'tc'],
  check: ['check', 'jc'],
  split: ['split', 'cf'],
  generate: ['generate', 'sc'],
  settle: ['settle', 'ld'],
  rewrite: ['rewrite', 'gx'],
};

/** 这个阶段能下哪些命令。顺序即面板里的顺序。 */
export function commandsFor(stage: CreationStage): StageCommand[] {
  return (STAGE_CAPABILITIES[stage] ?? []).map((capability) => ({
    capability,
    label: labelOf(stage, capability),
    hint: hintOf(stage, capability),
    writes: outputKindOf({ stage, capability }) === 'artifact',
    needsText: capability === 'discuss',
    keys: CAPABILITY_KEYS[capability],
  }));
}

/**
 * 某阶段下某能力的 tooltip。
 *
 * 只有剧情层的 `settle` / `generate` 需要具体化：这两条是同一层里**唯二**
 * 产出同一种产物的命令，通用文案说不清它们的差别，而那个差别（以讨论为准
 * 还是以你这句话为准）正是作者要选的东西。
 */
function hintOf(stage: CreationStage, capability: Capability): string {
  if (stage === 'plot') {
    if (capability === 'settle') {
      return '把刚才讨论出的剧情整理成细纲，以讨论里的结论为准';
    }
    if (capability === 'generate') {
      return '按你在输入框里描述的走向填成细纲';
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
 * **未命名的章只报序号。** 拆章时标题可能还没定（`007.md`），`listChapters`
 * 的标题回落链也会给出「第 7 章」；模板一套就成了「第 7 章《第 7 章》」——
 * 读起来像出了 bug。判据就是「标题恰好等于那个回落值」，因为那正是
 * 「没有标题」在数据里的样子。
 *
 * 细纲（`plots/`）与发布文件（`chapters/`）说的是同一章，所以只有这一个说法。
 * `plotLabel` 是它在细纲那一侧的别名，两者输出一字不差——留着别名是因为
 * 调用点分属两条取数路径，读代码时能看出手里拿的是哪一份。
 *
 * 住在这里而不是 plotFile.ts，是因为**这个模块零 import**：前端直接打包它
 * （见 media/src/protocol.ts），而 plotFile.ts 要 `node:path`，带进浏览器会炸。
 */
export function chapterLabel(order: number, title?: string): string {
  const named = title?.trim();
  return named && named !== `第 ${order} 章` ? `第 ${order} 章《${named}》` : `第 ${order} 章`;
}

/** {@link chapterLabel} 在细纲那一侧的别名。输出完全一致。 */
export const plotLabel = chapterLabel;

// ---------------------------------------------------------------- Target

/**
 * 当前在改哪个产物。
 *
 * **一律用 `plotRelPath` 而不是章号**：号会撞（作者手改文件名时 `007-a.md` 与
 * `007-b.md` 并存是允许的），路径不会。这与摘要、场景、失败记录三处既有取舍
 * 完全一致。
 *
 * `manuscript` 的 `sceneNo` 可选：给了就是「写这一场」，不给就是「写整章」。
 * 于是「场景 → 写正文 → 采纳 → 写入第 12 章」与整章续写共用一条路。
 */
export type CreationTarget =
  | { kind: 'outline' }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'scene'; plotRelPath: string; sceneNo: number }
  | { kind: 'manuscript'; plotRelPath: string; sceneNo?: number };

/** target 属于哪个阶段。两者不是同一件事：target 是名词，stage 是动词的所在层。 */
export function stageOfTarget(target: CreationTarget): CreationStage {
  return target.kind;
}

/** 该 target 归属的细纲路径；全书大纲没有归属章。 */
export function plotOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'outline' ? undefined : target.plotRelPath;
}

/**
 * 稳定的字符串键。会话分组、前端 dataset、失败记录都用它，
 * 避免各处自己拼一份格式不同的 id。
 */
export function targetKey(target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return 'outline';
    case 'plot':
      return `plot:${target.plotRelPath}`;
    case 'scene':
      return `scene:${target.plotRelPath}#${target.sceneNo}`;
    case 'manuscript':
      return target.sceneNo === undefined
        ? `manuscript:${target.plotRelPath}`
        : `manuscript:${target.plotRelPath}#${target.sceneNo}`;
  }
}

export function isSameTarget(a: CreationTarget, b: CreationTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * 人类可读的位置描述，如「第 12 章《入宗风波》· 场景 2」。
 *
 * 后端生成、前端直接显示：文案只有一份，气泡里、历史页、日志里不会分叉。
 */
export function describeTarget(
  target: CreationTarget,
  info?: { no?: number; title?: string; sceneTitle?: string }
): string {
  if (target.kind === 'outline') {
    return '全书大纲';
  }
  const head = info?.no !== undefined ? plotLabel(info.no, info.title) : target.plotRelPath;
  const scene = (no: number) => ` · 场景 ${no}${info?.sceneTitle ? ` ${info.sceneTitle}` : ''}`;

  switch (target.kind) {
    case 'plot':
      return `${head} · 剧情`;
    case 'scene':
      return `${head}${scene(target.sceneNo)}`;
    case 'manuscript':
      return target.sceneNo === undefined ? `${head} · 正文` : `${head}${scene(target.sceneNo)} · 正文`;
  }
}

/**
 * 容错归一。认不出的一律回落到 `{ kind: 'outline' }`——它是唯一一个
 * 不依赖任何一章就一定存在的产物，因此是安全的落点。**绝不抛**：
 * 这条路上的输入来自会话 JSON（作者可能手改过）与前端消息。
 */
export function normalizeTarget(raw: unknown): CreationTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const plotRelPath = typeof o.plotRelPath === 'string' ? o.plotRelPath.trim() : '';
  const sceneNo =
    typeof o.sceneNo === 'number' && Number.isInteger(o.sceneNo) && o.sceneNo > 0 ? o.sceneNo : undefined;

  switch (o.kind) {
    case 'plot':
      return plotRelPath ? { kind: 'plot', plotRelPath } : { kind: 'outline' };
    case 'scene':
      return plotRelPath && sceneNo !== undefined
        ? { kind: 'scene', plotRelPath, sceneNo }
        : plotRelPath
          ? { kind: 'plot', plotRelPath }
          : { kind: 'outline' };
    case 'manuscript':
      return plotRelPath ? { kind: 'manuscript', plotRelPath, sceneNo } : { kind: 'outline' };
    default:
      return { kind: 'outline' };
  }
}

// ---------------------------------------------------------------- 单章流水线状态

/**
 * 这一章当前该做哪一步。
 *
 * **全部由磁盘推导，不落盘**。存一个 `status: writing` 字段的话，作者手删
 * 半章正文之后它就在撒谎；而 `wordCount` 与 hash 永远诚实。这与
 * 「摘要新鲜度看 sourceHash 而不是看某个标记位」是同一个取舍。
 *
 * `split` 这一档是中转站带来的：正文写在 `manuscripts/`，作者标好断点之后
 * 才拆进 `chapters/`。拆分之前那一章还不算数——摘要要从发布文件生成，
 * 所以状态得停在这里等他动手。
 */
export type PlotStage = 'plot' | 'scene' | 'manuscript' | 'split' | 'review' | 'done';

export const PLOT_STAGE_LABEL: Record<PlotStage, string> = {
  plot: '待写剧情',
  scene: '待拆场景',
  manuscript: '待写正文',
  split: '待拆分',
  review: '待审阅',
  done: '已完成',
};

/** 推导所需的全部事实。取数在 core/views/pipeline.ts，判断在这里，便于单测。 */
export interface PipelineFacts {
  /** 细纲有实质内容（「剧情脉络」非空，不是一份只有目标的骨架）。 */
  plotFilled: boolean;
  sceneCount: number;
  /** 已经备好素材的场景数——只有这样的场景才写得出正文。 */
  sceneReady: number;
  /** 已标记 `status: written` 的场景数。 */
  sceneWritten: number;
  /** 正文字数。中转站与发布文件取其一，见 `chapterExists`。 */
  words: number;
  /** 正文所依据的场景已经变过（正文 frontmatter 的 beatsHash 对不上）。 */
  beatsStale: boolean;
  /**
   * 这一章在 `chapters/` 里已经有文件了——也就是正文已经拆分（或本来就是
   * 老工程里手写的章）。
   *
   * 为什么要单独一个事实：中转站里有正文**不等于**这一章成立。摘要、角色卡、
   * 设定三条下游读的都是 `chapters/`，拆分之前它们无从读起。所以这一档卡在
   * 正文与审阅之间，而不是把「没拆分」混进 `manuscript` 里——混进去的话，
   * 界面会说「待写正文」，而正文明明已经写完了。
   */
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
    sceneCount: 0,
    sceneReady: 0,
    sceneWritten: 0,
    words: 0,
    beatsStale: false,
    chapterExists: false,
    summaryExists: false,
    summaryStale: true,
    markedDone: false,
  };
}

/**
 * 当前阶段。
 *
 * **先看这一章成品在不在**（`chapters/` 里有没有文件），再谈生产链：
 * 生产链回答的是「怎么把这一章造出来」，成品已经在了就无从谈起。这条顺序
 * 是老工程能直接用的关键——写了 99 章、从没碰过本工具的书，99 行全是
 * 「已完成 / 待审阅」，不会被倒回去要求补细纲。
 *
 * 成品不在时判据自上而下取第一个不满足的：
 * 剧情没排 → 写剧情；剧情有了没场景（或场景没填够） → 拆场景；
 * 场景齐了正文没写完（或场景变过） → 写正文；正文写完还在中转站 → 拆分。
 */
export function deriveStage(f: PipelineFacts): PlotStage {
  if (f.chapterExists) {
    if (!f.summaryExists || f.summaryStale) {
      // 作者说过这一章过了就不再催审阅。
      return f.markedDone ? 'done' : 'review';
    }
    return 'done';
  }
  if (!f.plotFilled) {
    return 'plot';
  }
  if (f.sceneCount === 0 || f.sceneReady < f.sceneCount) {
    return 'scene';
  }
  if (f.words === 0 || f.beatsStale || f.sceneWritten < f.sceneCount) {
    return 'manuscript';
  }
  // 正文齐了但还躺在中转站里：作者得先标断点、拆成发布章节，
  // 摘要与三条支路读的都是 `chapters/`，拆分之前它们无从读起。
  return 'split';
}

export interface PipelineProgress {
  plot: number;
  scene: number;
  manuscript: number;
  summary: number;
}

/**
 * 四段完成度，各自 0..1。工程页的徽章与创作页的流水线条直接渲染它。
 *
 * 用比例而不是布尔，是因为设计要的是「剧情细节 80%」这种粒度——
 * 「有 4 个场景但其中 1 个还没备素材」和「一个场景都没有」不是一回事。
 *
 * 与 `deriveStage` 同一条顺序：**成品在就是造完了**，前三段一律满格。
 * 否则老工程的 99 章会显示成「进度 25%」——它们明明已经写完了，
 * 只是没经过这条流水线。
 */
export function deriveProgress(f: PipelineFacts): PipelineProgress {
  const summary = f.summaryExists && !f.summaryStale ? 1 : 0;
  if (f.chapterExists) {
    return { plot: 1, scene: 1, manuscript: 1, summary };
  }
  const plot = f.plotFilled ? 1 : 0;
  const scene = f.sceneCount === 0 ? 0 : f.sceneReady / f.sceneCount;
  const manuscript =
    f.words === 0 ? 0 : f.sceneCount === 0 ? 1 : Math.min(1, f.sceneWritten / f.sceneCount);
  return { plot, scene, manuscript, summary };
}

// ---------------------------------------------------------------- 下一步

/**
 * 状态机算出来的「现在该干什么」。创作页的主按钮吃这一份。
 *
 * 这是整套流水线在界面上的落点。四层产物、四段进度、⟳ 标记都只是**信息**；
 * 作者真正要的是一句「所以我现在该点什么」。旧界面把这个判断留给了作者：
 * 七个能力按钮平铺，选中一章一律落到正文层——哪怕那一章连剧情都没排。
 *
 * **与 `deriveStage` 共用同一套判据**，不另发明一套：那边算出停在哪一层，
 * 这边把那一层翻译成一个具体动作。两处如果各判各的，界面上就会出现
 * 「徽章说待拆场景，按钮让你写正文」。
 */
export interface NextStepPlan {
  stage: CreationStage;
  capability: Capability;
  /** 动作落在具体某一场时给出。 */
  sceneNo?: number;
  /** 主按钮上的字，如「拆成场景」。 */
  label: string;
  /** 按钮下面那句话：为什么是这一步。 */
  hint: string;
  /**
   * 这一步不是一次模型对话，而是一个工程动作。
   *
   * 有两处用得上：正文写完要拆成发布章节（`splitManuscript`），
   * 拆完要更新摘要（`summarizePlot`）。两者都是既有的工程动作，
   * 不该假装成一轮对话。
   */
  projectAction?: 'summarizePlot' | 'splitManuscript';
}

/** 推导下一步所需的事实。比 `PipelineFacts` 多两个「第一个没做完的是哪一场」。 */
export interface NextStepFacts {
  sceneCount: number;
  /** 第一个还没备素材的场景号。 */
  firstUnreadyScene?: number;
  /** 第一个还没写正文的场景号。 */
  firstUnwrittenScene?: number;
  beatsStale: boolean;
}

export function deriveNextStep(stage: PlotStage, f: NextStepFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'plot':
      return {
        stage: 'plot',
        capability: 'generate',
        label: labelOf('plot', 'generate'),
        hint: '先把这一章的剧情脉络排出来：发生什么、因果怎么串、收在什么局面上。',
      };

    case 'scene':
      // 一场都没有 → 先拆；拆过了但有场没填满 → 去填第一个没填的。
      if (f.sceneCount === 0) {
        return {
          stage: 'plot',
          capability: 'split',
          label: labelOf('plot', 'split'),
          hint: '把这一章拆成几个能独立开写的场景。',
        };
      }
      return {
        stage: 'scene',
        capability: 'generate',
        sceneNo: f.firstUnreadyScene,
        label: f.firstUnreadyScene === undefined ? '设计场景' : `设计场景 ${f.firstUnreadyScene}`,
        hint: '把这一幕想具体：环境、动作、对话。写正文时直接取用。',
      };

    case 'manuscript':
      // 场景改过而正文没跟上：要的是拿新场景重做一版，不是往后接着写。
      if (f.beatsStale) {
        return {
          stage: 'manuscript',
          capability: 'rewrite',
          label: labelOf('manuscript', 'rewrite'),
          hint: '场景改过，现有正文可能已经与细节对不上。',
        };
      }
      return {
        stage: 'manuscript',
        capability: 'generate',
        sceneNo: f.firstUnwrittenScene,
        label:
          f.firstUnwrittenScene === undefined ? '写正文' : `写场景 ${f.firstUnwrittenScene} 的正文`,
        hint: '剧情已经定好了，这一步只负责把它写成小说。',
      };

    case 'split':
      return {
        // 停在正文层：拆分改的是正文的落点，作者点开看的也是那份正文。
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'splitManuscript',
        label: '拆成章节',
        hint: '正文写好了。在编辑器里用单独一行 --- 标出断点，再拆成发布章节。',
      };

    case 'review':
      return {
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'summarizePlot',
        label: '总结这一章',
        hint: '正文齐了。摘要是后面几百章唯一能记住这一章的东西。',
      };

    // 都做完了就不催。给一个「下一步」等于逼作者一直有事可做。
    case 'done':
      return undefined;
  }
}

// ---------------------------------------------------------------- 全书状态

/**
 * 整本书走到哪一步。与 `PlotStage` 同构，只是粒度是全书。
 *
 * 需要它是因为 `plots/` 是一条有序序列，而「还没有大纲」「有大纲但一章都没规划」
 * 这两种状态不属于任何一章——从前这个判断手写在 controller 里（`outlineNextStep`），
 * 判据落在 I/O 层就测不到，也没法与 `deriveStage` 保持同一套写法。
 */
export type BookStage = 'outline' | 'plots' | 'working';

export interface BookFacts {
  /** `outline.md` 去掉模板占位后有内容。 */
  outlineFilled: boolean;
  /**
   * 有细纲的章数**加上**已经写完的章数。
   *
   * 两者都要算：只有 `chapters/` 的老工程（写了 99 章、从没用过这个工具）
   * 一样是「已经在写了」，不该被叫回去从拆章开始。
   */
  plotCount: number;
}

/** 判据自上而下取第一个不满足的：没大纲 → 写大纲；有大纲没章 → 拆章；有章 → 交给按章流水线。 */
export function deriveBookStage(f: BookFacts): BookStage {
  if (!f.outlineFilled) {
    return 'outline';
  }
  return f.plotCount === 0 ? 'plots' : 'working';
}

/**
 * 全书级的下一步。章已经有了就返回 undefined——那时该做什么由**选中的那一章**
 * 决定（`deriveNextStep`），而挑哪一章是作者的选择，不是系统能替他定的。
 */
export function deriveBookNextStep(stage: BookStage): NextStepPlan | undefined {
  switch (stage) {
    case 'outline':
      return {
        stage: 'outline',
        capability: 'generate',
        label: labelOf('outline', 'generate'),
        hint: '先定下这个故事讲什么。后面三层都从它展开。',
      };
    case 'plots':
      return {
        stage: 'outline',
        capability: 'split',
        label: labelOf('outline', 'split'),
        hint: '把大纲切成一章一章的剧情，每章有一个能判断达成没达成的目标。',
      };
    case 'working':
      return undefined;
  }
}
