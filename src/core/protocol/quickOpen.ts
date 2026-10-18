/**
 * 「转到…」（独立版内置编辑器的 Ctrl+P 快速打开）要的那份索引。
 *
 * 面板打开时前端发 `requestQuickOpen`，后端回 `quickOpenIndex`（同一个 `requestId`）——**按需要，不常驻推送**：
 * 这份东西只在作者按下 Ctrl+P 的那一刻有用，塞进每次文件变动都全量重推的 `ProjectTree` / `ViewState`
 * 等于每保存一次就白推一遍。面板开着时工程变了不刷新，下次打开再要一份。
 *
 * 构建见 `views/quickOpen.ts`（读了哪些盘写在那里），匹配与排序是前端的纯函数（`media/src/editor/quickOpenCore.ts`）。
 */

/** 一章（细纲号 = 章号，一个章号一条，与工程页的章节列表同一个口径）。 */
export interface QuickOpenChapter {
  no: number;
  /** 细纲的标题优先，其次正文的（「第 9 章」这种回落标题不算标题，给空串）。 */
  title: string;
  /** 所在的卷目录：正文（没有正文时是细纲）在章节根下的那段子目录，`第一卷`、`第一卷/上`；根下是空串。 */
  volume: string;
  /** 正文路径。缺席 = 还没有正文。 */
  chapterPath?: string;
  /** 细纲路径（正文镜像的那一份，或者还没有正文时按号认的计划）。缺席 = 还没有细纲。 */
  plotPath?: string;
  /** 正文字数（中文按字、英文按词，与工程页同一个数）。没有正文是 0。 */
  words: number;
}

export interface QuickOpenCharacter {
  name: string;
  aliases: string[];
  path: string;
}

export interface QuickOpenLore {
  title: string;
  path: string;
}

/** 架构三件、情节大纲、文风、叙事线、全书摘要。 */
export type QuickOpenDocKey = 'config' | 'premise' | 'world' | 'outline' | 'style' | 'threads' | 'globalSummary';

export interface QuickOpenDoc {
  key: QuickOpenDocKey;
  /** 「小说配置」「情节大纲」……由后端给，前端只渲染。 */
  label: string;
  path: string;
}

export interface QuickOpenDraft {
  path: string;
  /** 文件名。 */
  name: string;
  /** 文件名里的章号（草稿镜像正文的路径，文件名与正文同名）。认不出时缺席。 */
  no?: number;
}

export interface QuickOpenIndex {
  /** 还不是小说工程（没有 `.novelforge/project.json`）时为 false，其余列表都是空的。 */
  initialized: boolean;
  /** 按章号升序。 */
  chapters: QuickOpenChapter[];
  characters: QuickOpenCharacter[];
  lore: QuickOpenLore[];
  /** 只列磁盘上有这份文件的。 */
  docs: QuickOpenDoc[];
  drafts: QuickOpenDraft[];
}
