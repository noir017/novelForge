import { ActiveModel, ProviderProfile } from './providers';

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

/** 单章摘要，存于 .novelforge/summaries/NNN.md。 */
export interface ChapterSummary {
  order: number;
  relPath: string;
  /** 生成该摘要时所依据的章节正文 hash。与当前 Chapter.contentHash 不同即为过期。 */
  sourceHash: string;
  /** 摘要全文（含各固定小节）。 */
  content: string;
  sections: SummarySections;
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
  /** 当前模型引用，形如 `glm/glm-4-plus`。 */
  model: string;
  /** 当前模型解析结果；引用无效时为 undefined。 */
  active?: ActiveModel;
  /** 全局默认上下文窗口，模型自带 contextWindow 时以模型为准。 */
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
}
