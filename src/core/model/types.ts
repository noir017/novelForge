import { ActiveModel, ProviderProfile } from './providers';
import { LlmTask, ModelTier, TierModels } from './tiers';

/** 章节：chapters/NNN-标题.md 中的一篇正文。 */export interface Chapter {
  /** 序号，来自文件名前缀，决定顺序。 */
  order: number;
  /** 标题，来自文件名（去掉序号前缀与扩展名），若正文首行是 `# xxx` 则以正文为准。 */
  title: string;
  /** 相对工作区根目录的路径，例如 `chapters/001-楔子.md`。 */
  relPath: string;
  /** 正文字数（去掉空白后的字符数）。 */
  wordCount: number;
  /** 正文内容的 hash，用于判断摘要是否过期。 */
  contentHash: string;
}

/** 单章摘要，存于 .novelforge/summaries/ 下，按章节文件名与路径镜像（如 `001 序.md`）。 */
export interface ChapterSummary {
  order: number;
  relPath: string;
  /** 生成该摘要时所依据的章节正文 hash。与当前 Chapter.contentHash 不同即为过期。 */
  sourceHash: string;
  /** 摘要全文（含各固定小节）。 */
  content: string;
  sections: SummarySections;
  /**
   * 出场人物的结构化清单。
   *
   * 与 `sections.出场人物`（人类可读的「林昭、沈氏」）是同一份信息的两种形态：
   * 这一份来自 frontmatter 的 `cast`，供角色页聚合与角色卡关联用；那一份供
   * 阅读与注入 prompt 用。**读取时以 frontmatter 为准，缺席则从小节文本回退解析**——
   * 0.2.x 之前写的摘要文件没有 cast 字段，不该因此在角色页上凭空少一批人。
   */
  cast: SummaryCast[];
}

/** 摘要里的一位出场人物。 */
export interface SummaryCast {
  /** 正式姓名（模型被要求沿用已有角色卡的名字）。 */
  name: string;
  /** 本章出现的别名/称呼。 */
  aliases: string[];
}

/** 单章摘要的固定小节。缺失的小节为空字符串。 */
export interface SummarySections {
  梗概: string;
  出场人物: string;
  时间地点: string;
  关键事件: string;
  新增伏笔: string;
  状态变更: string;
}

export const SUMMARY_SECTION_KEYS: (keyof SummarySections)[] = [
  '梗概',
  '出场人物',
  '时间地点',
  '关键事件',
  '新增伏笔',
  '状态变更',
];

/** 角色卡，存于 .novelforge/characters/<slug>.md。 */
export interface CharacterCard {
  /** 文件名（不含扩展名）。 */
  slug: string;
  relPath: string;
  name: string;
  aliases: string[];
  tags: string[];
  /** 首次出场章节序号。 */
  firstAppear?: number;
  /** 最后出场章节序号。 */
  lastSeen?: number;
  /**
   * 该角色出场的全部章节序号（升序）。
   *
   * 由摘要的 `cast` 反向聚合后写回 frontmatter，**是缓存而非真相**——
   * 真相始终是各章摘要。落在卡里是为了两件事：不读全部摘要就能在角色页上
   * 显示「出场 12 章」，以及日后按人物检索章节。摘要重算后这里会跟着更新。
   */
  appearsIn: number[];
  /**
   * 上次「更新角色卡」时读到了第几章。
   *
   * 增量更新的依据：只关联这一章之后的出场章节。undefined 表示从未更新过
   * （手写的卡也是这个状态），此时增量等于全量。
   */
  updatedThrough?: number;
  /** 除 frontmatter 外的正文全文。 */
  body: string;
  sections: CharacterSections;
}

export interface CharacterSections {
  身份: string;
  外貌: string;
  性格: string;
  语言习惯: string;
  人物关系: string;
  当前状态: string;
  未收伏笔: string;
}

export const CHARACTER_SECTION_KEYS: (keyof CharacterSections)[] = [
  '身份',
  '外貌',
  '性格',
  '语言习惯',
  '人物关系',
  '当前状态',
  '未收伏笔',
];

/** 续写时优先保留的角色卡小节（预算不足时只留这几节）。 */
export const CHARACTER_ESSENTIAL_KEYS: (keyof CharacterSections)[] = ['身份', '当前状态', '未收伏笔'];

/** 世界观设定条目，存于 .novelforge/lore/<slug>.md。 */
export interface LoreEntry {
  slug: string;
  relPath: string;
  title: string;
  /** 用于与剧情纲要做关键词匹配。 */
  keywords: string[];
  body: string;
}

/** .novelforge/project.json 的结构。 */
export interface ProjectManifest {
  /** 数据格式版本，便于日后迁移。 */
  version: number;
  title: string;
  author: string;
  /** 章节索引。summaryHash 为生成摘要时的正文 hash。 */
  chapters: ManifestChapter[];
  /** 上次重建全书摘要时，已覆盖到的最大章节序号。 */
  globalSummaryThrough?: number;
}

export interface ManifestChapter {
  file: string;
  order: number;
  title: string;
  wordCount: number;
  contentHash: string;
  /** 该章摘要所依据的正文 hash；无摘要则为 undefined。 */
  summaryHash?: string;
}

export const MANIFEST_VERSION = 1;

/** 从设置读出的运行时配置。 */
export interface NovelConfig {
  /** 已配置的服务商（含各自的模型清单）。 */
  providers: ProviderProfile[];
  /**
   * 默认模型列表，按顺序，第一个是首选。至少一项（配不出来时为空数组）。
   *
   * 工程页的后台任务从这里取模型：串行调用恒用第一个、失败随机换用其余，
   * 并发调用在列表里轮转。对话页续写不走这套，严格用 `model`。
   */
  models: string[];
  /** 当前模型引用，形如 `glm/glm-4-plus`。恒等于 `models[0]`。 */
  model: string;
  /** 当前模型解析结果；引用无效时为 undefined。 */
  active?: ActiveModel;
  /**
   * 三档（快速 / 均衡 / 精标）各自的模型清单。每档都在，可能是空数组——
   * 空 = 该档的任务沿用 `models`。只作用于工程页的后台任务。
   */
  tierModels: TierModels;
  /** 任务 → 档位的覆盖，缺席的任务用 `DEFAULT_TASK_TIERS`。 */
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  /** 当前模型的上下文窗口（模型配置优先，缺省使用兼容值）。 */
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  recentChaptersFullText: number;
  prevChapterTailChars: number;
  chaptersDir: string;
  /** 草稿根目录（相对工作区根）。镜像章节在 chaptersDir 之下的相对路径。 */
  draftsDir: string;
  summaryBatchSize: number;
  requestTimeoutMs: number;
  /** 工程页批量任务的并发请求数。1 表示串行。 */
  concurrency: number;
  /** 一次调用失败后，换用列表里其它模型重试的次数上限。0 表示不重试。 */
  fallbackAttempts: number;
}
