/**
 * 创作流水线的领域模型：`Stage × Capability × Target`。
 *
 * **纯类型 + 纯函数，零 I/O**（与 naming.ts / identity.ts / chapterFile.ts 同类），
 * 因此前端、装配器、编排层、工程页共用同一份定义，不会各写一遍再慢慢跑偏。
 *
 * 这里替换掉的是旧的 `mode: 'write' | 'discuss'`。那个开关是按 **AI 的输出形式**
 * 划分的，而不是按作者真实的创作流程划分：
 *
 * - 「讨论」不是一个模式——大纲、细纲、场景、正文四个阶段都会讨论；
 * - 「续写」不是一个阶段——它只是正文阶段的一个动作。
 *
 * 所以拆成三个正交维度：
 *
 * - **Stage**：我在哪一层（决定 AI 的身份、装配配方、产物落到哪）
 * - **Capability**：我要它干什么（任何阶段都能用，只是可用集合不同）
 * - **Target**：我在改哪一个具体产物
 */

// ---------------------------------------------------------------- Stage

/** 创作阶段。四层，自上而下：故事讲什么 → 这章发生什么 → 这幕怎么发生 → 怎么写出来。 */
export type CreationStage = 'outline' | 'plan' | 'scene' | 'manuscript';

export const CREATION_STAGES: CreationStage[] = ['outline', 'plan', 'scene', 'manuscript'];

/** 阶段的中文名。前端按钮、日志、确认框共用这一份，不在前端另写。 */
export const STAGE_LABEL: Record<CreationStage, string> = {
  outline: '大纲',
  plan: '细纲',
  scene: '细节',
  manuscript: '正文',
};

/** 每个阶段回答的那个问题。前端的流水线条用它做 tooltip。 */
export const STAGE_QUESTION: Record<CreationStage, string> = {
  outline: '故事讲什么？',
  plan: '这一章发生什么？',
  scene: '这一幕具体怎么发生？',
  manuscript: '怎么把它写出来？',
};

/**
 * AI 在该阶段的身份。
 *
 * 这比提示词技巧更要紧：同一句「这里冲突太弱」，策划编辑会去动故事结构，
 * 剧情导演会去调这一章的节奏，编剧会去改这一幕的胜负条件，作者会去改措辞。
 * 不说清身份，四个阶段会得到同一种泛泛而谈的回答。
 */
export const STAGE_ROLE: Record<CreationStage, string> = {
  outline: '资深长篇小说策划编辑',
  plan: '剧情导演',
  scene: '编剧',
  manuscript: '资深中文长篇小说作者',
};

export function isCreationStage(value: unknown): value is CreationStage {
  return typeof value === 'string' && (CREATION_STAGES as string[]).includes(value);
}

// ---------------------------------------------------------------- Capability

/** 通用能力。与阶段正交——「讨论」不再是一个模式，而是七个能力之一。 */
export type Capability =
  | 'discuss'
  | 'expand'
  | 'critique'
  | 'check'
  | 'split'
  | 'generate'
  | 'rewrite';

export const CAPABILITIES: Capability[] = [
  'discuss',
  'expand',
  'critique',
  'check',
  'split',
  'generate',
  'rewrite',
];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  discuss: '讨论',
  expand: '扩展',
  critique: '挑刺',
  check: '检查',
  split: '拆分',
  generate: '生成',
  rewrite: '改写',
};

/** 按钮的 tooltip。说清「点了会发生什么」，尤其是会不会产出可采纳的东西。 */
export const CAPABILITY_HINT: Record<Capability, string> = {
  discuss: '就当前产物提问，AI 只回答，不改动任何文件',
  expand: '在现有产物上补充内容，产出建议而非直接覆盖',
  critique: '找逻辑漏洞、冲突太弱、节奏问题',
  check: '与既有设定、伏笔、时间线对账',
  split: '拆成下一层：大纲拆成章，细纲拆成场景',
  generate: '产出本阶段的完整产物，可采纳写入',
  rewrite: '拿着修改意见重做一版，可采纳写入',
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as string[]).includes(value);
}

/**
 * 能力在某个阶段的**具体说法**。`CAPABILITY_LABEL` 是通用说法，日志与确认框
 * 用它是对的；界面上有阶段做上下文，说得具体些更好懂。
 *
 * 只覆盖差别大到会让人误解的那几处：`split` 在大纲拆的是章、在细纲拆的是场；
 * `generate` 在四层产出的是四种完全不同的东西。其余沿用通用说法。
 */
const CAPABILITY_LABEL_IN: Partial<Record<CreationStage, Partial<Record<Capability, string>>>> = {
  outline: { split: '拆成章节', generate: '生成大纲', rewrite: '重写大纲' },
  plan: { split: '拆成场景', generate: '生成细纲', rewrite: '重写细纲' },
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
 * 两处刻意的缺席：
 * - `scene` 没有 `split`：场景已经是最小的可采纳单位，再拆就是 beat，
 *   而 beat 现在是场景里「必须发生」的列表项，不单独成文件。
 * - `manuscript` 没有 `split` / `expand`：正文阶段要的是重写整段，
 *   而不是往里插东西——插出来的段落接不上上下文的语气。
 */
export const STAGE_CAPABILITIES: Record<CreationStage, Capability[]> = {
  outline: ['discuss', 'expand', 'critique', 'check', 'split', 'generate', 'rewrite'],
  plan: ['discuss', 'expand', 'critique', 'check', 'split', 'generate', 'rewrite'],
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
  plan: 'discuss',
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
 * （由状态机算出来，见 `deriveNextStep`），其余六个是「偶尔要用」。
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
   * 其余六个的输入是可选的补充要求——「生成细纲」不需要作者说任何话，
   * 逼他先写一句才能点，是旧界面最没道理的一处。
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
  rewrite: ['rewrite', 'gx'],
};

/** 这个阶段能下哪些命令。顺序即面板里的顺序。 */
export function commandsFor(stage: CreationStage): StageCommand[] {
  return (STAGE_CAPABILITIES[stage] ?? []).map((capability) => ({
    capability,
    label: labelOf(stage, capability),
    hint: CAPABILITY_HINT[capability],
    writes: outputKindOf({ stage, capability }) === 'artifact',
    needsText: capability === 'discuss',
    keys: CAPABILITY_KEYS[capability],
  }));
}

/** 某阶段的某个能力对应的命令；不支持时 undefined。 */
export function commandOf(stage: CreationStage, capability: Capability): StageCommand | undefined {
  return commandsFor(stage).find((c) => c.capability === capability);
}

// ---------------------------------------------------------------- Target

/**
 * 当前在改哪个产物。
 *
 * **一律用 `chapterRelPath` 而不是 order**：序号会撞（`001 序.txt` 与
 * `001 正文.txt` 并存是允许的，见 AGENTS.md 第 8 条），路径不会。这与摘要
 * （`summaryPathForChapter`）、草稿（`draftRelPathFor`）、失败记录
 * （`targetKey` 一律用 relPath）三处既有取舍完全一致。
 *
 * `manuscript` 的 `sceneNo` 可选：给了就是「写这一场」，不给就是「写整章」。
 * 于是「场景 → 写正文 → 采纳 → 写入第 12 章」与整章续写共用一条路。
 */
export type CreationTarget =
  | { kind: 'outline' }
  | { kind: 'plan'; chapterRelPath: string }
  | { kind: 'scene'; chapterRelPath: string; sceneNo: number }
  | { kind: 'manuscript'; chapterRelPath: string; sceneNo?: number };

/** target 属于哪个阶段。两者不是同一件事：target 是名词，stage 是动词的所在层。 */
export function stageOfTarget(target: CreationTarget): CreationStage {
  return target.kind;
}

/** 该 target 归属的章节路径；全书大纲没有归属章节。 */
export function chapterOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'outline' ? undefined : target.chapterRelPath;
}

/**
 * 稳定的字符串键。会话分组、前端 dataset、失败记录都用它，
 * 避免各处自己拼一份格式不同的 id。
 */
export function targetKey(target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return 'outline';
    case 'plan':
      return `plan:${target.chapterRelPath}`;
    case 'scene':
      return `scene:${target.chapterRelPath}#${target.sceneNo}`;
    case 'manuscript':
      return target.sceneNo === undefined
        ? `manuscript:${target.chapterRelPath}`
        : `manuscript:${target.chapterRelPath}#${target.sceneNo}`;
  }
}

export function isSameTarget(a: CreationTarget, b: CreationTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * 人类可读的位置描述，如「第 12 章《夜入青云》· 场景 2」。
 *
 * 后端生成、前端直接显示：文案只有一份，气泡里、历史页、日志里不会分叉。
 */
export function describeTarget(
  target: CreationTarget,
  info?: { order?: number; title?: string; sceneTitle?: string }
): string {
  if (target.kind === 'outline') {
    return '全书大纲';
  }
  const head =
    info?.order !== undefined
      ? `第 ${info.order} 章${info.title ? `《${info.title}》` : ''}`
      : target.chapterRelPath;
  const scene = (no: number) => ` · 场景 ${no}${info?.sceneTitle ? ` ${info.sceneTitle}` : ''}`;

  switch (target.kind) {
    case 'plan':
      return `${head} · 细纲`;
    case 'scene':
      return `${head}${scene(target.sceneNo)}`;
    case 'manuscript':
      return target.sceneNo === undefined ? `${head} · 正文` : `${head}${scene(target.sceneNo)} · 正文`;
  }
}

/**
 * 容错归一。认不出的一律回落到 `{ kind: 'outline' }`——它是唯一一个
 * 不依赖任何章节就一定存在的产物，因此是安全的落点。**绝不抛**：
 * 这条路上的输入来自会话 JSON（作者可能手改过）与前端消息。
 */
export function normalizeTarget(raw: unknown): CreationTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const chapterRelPath = typeof o.chapterRelPath === 'string' ? o.chapterRelPath.trim() : '';
  const sceneNo =
    typeof o.sceneNo === 'number' && Number.isInteger(o.sceneNo) && o.sceneNo > 0 ? o.sceneNo : undefined;

  switch (o.kind) {
    case 'plan':
      return chapterRelPath ? { kind: 'plan', chapterRelPath } : { kind: 'outline' };
    case 'scene':
      return chapterRelPath && sceneNo !== undefined
        ? { kind: 'scene', chapterRelPath, sceneNo }
        : chapterRelPath
          ? { kind: 'plan', chapterRelPath }
          : { kind: 'outline' };
    case 'manuscript':
      return chapterRelPath ? { kind: 'manuscript', chapterRelPath, sceneNo } : { kind: 'outline' };
    default:
      return { kind: 'outline' };
  }
}

// ---------------------------------------------------------------- 章节流水线状态

/**
 * 一章当前该做哪一步。
 *
 * **全部由磁盘推导，不落盘**。存一个 `status: writing` 字段的话，作者手删
 * 半章正文之后它就在撒谎；而 `wordCount` 与 hash 永远诚实。这与
 * 「摘要新鲜度看 sourceHash 而不是看某个标记位」是同一个取舍。
 */
export type ChapterStage = 'plan' | 'scene' | 'manuscript' | 'review' | 'done';

export const CHAPTER_STAGE_LABEL: Record<ChapterStage, string> = {
  plan: '待写细纲',
  scene: '待拆场景',
  manuscript: '待写正文',
  review: '待审阅',
  done: '已完成',
};

/** 推导所需的全部事实。取数在 core/views/pipeline.ts，判断在这里，便于单测。 */
export interface PipelineFacts {
  hasPlan: boolean;
  /** 细纲有实质内容（不是一份全空的骨架）。 */
  planFilled: boolean;
  sceneCount: number;
  /** 「必须发生」非空的场景数——只有这样的场景才写得出正文。 */
  sceneReady: number;
  /** 已标记 `status: written` 的场景数。 */
  sceneWritten: number;
  /** 正文字数。 */
  words: number;
  /** 正文所依据的场景已经变过（manifest.beatsHash 对不上）。 */
  beatsStale: boolean;
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
    hasPlan: false,
    planFilled: false,
    sceneCount: 0,
    sceneReady: 0,
    sceneWritten: 0,
    words: 0,
    beatsStale: false,
    summaryExists: false,
    summaryStale: true,
    markedDone: false,
  };
}

/**
 * 当前阶段。判据自上而下取第一个不满足的：
 *
 * 没细纲 → 写细纲；细纲有了没场景（或场景没填够） → 拆场景；
 * 场景齐了正文没写完（或场景变过） → 写正文；正文齐了摘要过期 → 审阅；
 * 都齐了 → 完成。
 */
export function deriveStage(f: PipelineFacts): ChapterStage {
  if (!f.hasPlan || !f.planFilled) {
    return 'plan';
  }
  if (f.sceneCount === 0 || f.sceneReady < f.sceneCount) {
    return 'scene';
  }
  if (f.words === 0 || f.beatsStale || f.sceneWritten < f.sceneCount) {
    return 'manuscript';
  }
  if (!f.summaryExists || f.summaryStale) {
    // 作者说过这一章过了就不再催审阅——但只在正文与场景都齐了之后才认这句话。
    return f.markedDone ? 'done' : 'review';
  }
  return 'done';
}

export interface PipelineProgress {
  plan: number;
  scene: number;
  manuscript: number;
  summary: number;
}

/**
 * 四段完成度，各自 0..1。工程页的徽章与创作页的流水线条直接渲染它。
 *
 * 用比例而不是布尔，是因为设计要的是「剧情细节 80%」这种粒度——
 * 「有 4 个场景但其中 1 个还没填必须发生」和「一个场景都没有」不是一回事。
 */
export function deriveProgress(f: PipelineFacts): PipelineProgress {
  const plan = f.hasPlan ? (f.planFilled ? 1 : 0.5) : 0;
  const scene = f.sceneCount === 0 ? 0 : f.sceneReady / f.sceneCount;
  const manuscript =
    f.words === 0 ? 0 : f.sceneCount === 0 ? 1 : Math.min(1, f.sceneWritten / f.sceneCount);
  const summary = f.summaryExists && !f.summaryStale ? 1 : 0;
  return { plan, scene, manuscript, summary };
}

// ---------------------------------------------------------------- 下一步

/**
 * 状态机算出来的「现在该干什么」。创作页的主按钮吃这一份。
 *
 * 这是整套流水线在界面上的落点。四层产物、四段进度、⟳ 标记都只是**信息**；
 * 作者真正要的是一句「所以我现在该点什么」。旧界面把这个判断留给了作者：
 * 七个能力按钮平铺，选中一个章节一律落到正文层——哪怕那一章连细纲都没有。
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
   * 只有审阅阶段用得上：正文齐了之后要做的是更新摘要，那是既有的
   * `summarizeChapter`，不该假装成一轮对话。
   */
  projectAction?: 'summarizeChapter';
}

/** 推导下一步所需的事实。比 `PipelineFacts` 多两个「第一个没做完的是哪一场」。 */
export interface NextStepFacts {
  sceneCount: number;
  /** 第一个「必须发生」还没填的场景号。 */
  firstUnreadyScene?: number;
  /** 第一个还没写正文的场景号。 */
  firstUnwrittenScene?: number;
  beatsStale: boolean;
}

export function deriveNextStep(stage: ChapterStage, f: NextStepFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'plan':
      return {
        stage: 'plan',
        capability: 'generate',
        label: labelOf('plan', 'generate'),
        hint: '先定下这一章要达成什么、主冲突是什么。后面几层都从它展开。',
      };

    case 'scene':
      // 一场都没有 → 先拆；拆过了但有场没填满 → 去填第一个没填的。
      if (f.sceneCount === 0) {
        return {
          stage: 'plan',
          capability: 'split',
          label: labelOf('plan', 'split'),
          hint: '把这一章拆成 3~6 个能独立开写的场景。',
        };
      }
      return {
        stage: 'scene',
        capability: 'generate',
        sceneNo: f.firstUnreadyScene,
        label: f.firstUnreadyScene === undefined ? '设计场景' : `设计场景 ${f.firstUnreadyScene}`,
        hint: '填「必须发生」——它是这一场的骨架，也是写正文的前提。',
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

    case 'review':
      return {
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'summarizeChapter',
        label: '总结本章',
        hint: '正文齐了。摘要是后面几百章唯一能记住这一章的东西。',
      };

    // 都做完了就不催。给一个「下一步」等于逼作者一直有事可做。
    case 'done':
      return undefined;
  }
}
