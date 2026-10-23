/**
 * 「叙事线总览」（独立版内置编辑器里的一个特殊标签，叙事线重做三期）要的那份矩阵：章 × 线的时间轴。
 *
 * 标签打开时前端发 `requestThreadsOverview`，后端回 `threadsOverview`（同一个 `requestId`）——**按需要，不常驻推送**
 * （同「转到…」的 `requestQuickOpen`）：这份东西只在总览开着的时候有用，塞进每次文件变动都全量重推的 `ProjectTree`
 * 等于每保存一次就白推一遍。总览开着时收到 `state`（磁盘上变过）再要一次。
 *
 * 构建见 `views/threads.ts` 的 `buildThreadsOverview`（纯读盘、不调模型、不落盘；状态现算，第 18、28 条），
 * 前端只画（`media/src/editor/threadsOverview.ts`）。设计见 docs/design/plans/2026-10-20-narrative-threads.md「八」。
 */
import type { ForeshadowStatus, ThreadEventType, ThreadKind, ThreadStatus } from '../model/threadFile';
import type { TimelineDayState } from '../model/timelineFile';

/**
 * 一章（一列）的定稿状态：
 * - `finalized`：定稿过（细纲上记着 `sourceHash`）、正文还在——与工程页「现在」同一个口径，定稿之后正文又改过的也算；
 * - `written`：有正文、还没定稿；
 * - `planned`：只有细纲；
 * - `none`：细纲、正文都没有（计划事件或伏笔的回收章落在这里）。
 */
export type ThreadsOverviewChapterState = 'finalized' | 'written' | 'planned' | 'none';

/** 一列。第 1 章到「计划或已写的最后一章」，一章不缺。 */
export interface ThreadsOverviewChapter {
  no: number;
  /** 细纲的标题优先，其次正文的；回落标题（「第 9 章」）与没有文件的章给空串。 */
  title: string;
  /** 所在的卷目录（`第一卷`、`第一卷/上`），根下是空串；细纲、正文都没有的章沿用前一章的卷。 */
  volume: string;
  state: ThreadsOverviewChapterState;
  /**
   * 定稿过、叙事线却还没判（四期：在水位之后、也没另外判过）——列头另一种样子；这一列上的计划不算偏差（线里本来就还没有它的
   * 实际事件）。只有 `finalized` 的列会有。
   */
  unjudged?: true;
  /** 正文路径。缺席 = 还没有正文。 */
  chapterPath?: string;
  /** 细纲路径（正文镜像的那一份，或者还没有正文时按号认的计划）。缺席 = 还没有细纲。 */
  plotPath?: string;
  /** 这一章的故事时间（2026-10-24，从时间线现算）。时间线里写到的最后一章之后缺席。 */
  time?: ThreadsOverviewTime;
}

/** 「故事时间」那一行的一格。 */
export interface ThreadsOverviewTime {
  /** 有依据 / 推测 / 推不出 / 没推 / 作者定的 / 回忆 / 认不出。 */
  state: TimelineDayState;
  /** 格子里写的：几号（`十四`、`14`），没有起点是第几天（`46`）；回忆是 `忆`；推不出、认不出是 `?`；和上一章同一天、没推是空串（画一个点）。 */
  short: string;
  /** 全称：`大衍三年三月十四 清晨`、`第 46 天`、`回忆（约二十年前）`（线与伏笔格子的悬停也带上它）。 */
  label: string;
  /** 悬停看的：全称、故事第几天、比上一章晚多久、历时、依据 / 推测 / 推不出的理由。 */
  tip: string;
  /** 月份带上那一段（有起点时）：`大衍三年三月`。 */
  month?: string;
}

/** 格子里的一条事件（悬停看）。 */
export interface ThreadsOverviewEvent {
  type: ThreadEventType;
  /** 伏笔的事件挂的是哪一条。 */
  foreshadowing?: string;
  what: string;
  /** 正文里的一句原文（定稿记下的实际事件才有；作者手写的可以没有）。 */
  evidence?: string;
}

/** 一行在某一章的一格。**只给有事件的章**（稀疏）。 */
export interface ThreadsOverviewCell {
  chapter: number;
  /** 计划事件（拆细纲写进线里的，`第 N 章 · 计划 · ……`）。 */
  planned: ThreadsOverviewEvent[];
  /** 实际事件（定稿记下的、作者手写的）。 */
  actual: ThreadsOverviewEvent[];
  /**
   * 偏差：计划了、那一章也定稿了（四期：叙事线也判过了）却没发生（画红圈）。线那一行：这一章有计划、却一条实际的线事件都没有；
   * 伏笔那一行：计划在这一章埋（收）的，到这一章为止还没埋（收、弃）。比的是**现在的**计划：定稿之后又重拆了那一章，偏差跟着变。
   */
  deviation: boolean;
}

/** 伏笔那一行上的连线（从第 `from` 章的中间画到第 `to` 章的中间）。 */
export interface ThreadsOverviewSpan {
  from: number;
  to: number;
  /**
   * - `done`：埋了也收了（或弃了），实线连到收（弃）的那一章；
   * - `open`：埋了还没收，虚线延到计划回收章（伏笔那一行写的与计划里收它的那一章取晚的；逾期的延到现在；都没写也延到现在）；
   * - `planned`：还没埋，按计划从埋的那一章到回收章画一条淡的虚线。
   */
  kind: 'done' | 'open' | 'planned';
}

/** 一条伏笔一行（缩进在它所在的线下面，或在「未归属的伏笔」下面）。 */
export interface ThreadsOverviewForeshadow {
  name: string;
  what: string;
  status: ForeshadowStatus;
  /** 伏笔那一行写的计划：第几章埋、第几章前收。 */
  plant?: number;
  resolve?: number;
  /** 实际埋在第几章、收（弃）在第几章。 */
  plantedAt?: number;
  closedAt?: number;
  /** 过了计划回收章还没收、也没弃（按「现在」算）。 */
  overdue: boolean;
  span?: ThreadsOverviewSpan;
  /** 悬停伏笔名看的几行：是什么、计划、现在怎样。 */
  tip: string;
  cells: ThreadsOverviewCell[];
}

/** 一条线一行，下面跟着它的伏笔。 */
export interface ThreadsOverviewLine {
  name: string;
  relPath: string;
  kind: ThreadKind;
  status: ThreadStatus;
  /** 计划区间（frontmatter 的 `plan`），画一条淡底。 */
  from?: number;
  to?: number;
  /** 与工程页那一行同一份（`views/threads.ts` 的 `lineOf`）：`感情线 · 进行中 · 最近第 12 章 · 2 条伏笔没收`。 */
  detail: string;
  /** 断了几章、几条伏笔逾期、过了计划收束的第几章。 */
  warnings: string[];
  /** 意图与当前进度（悬停线名看）。 */
  tip: string;
  /** 线自己的事件（推进 / 关系 / 收束 / 放弃）；伏笔的事件在伏笔那几行。 */
  cells: ThreadsOverviewCell[];
  foreshadowing: ThreadsOverviewForeshadow[];
}

/** 按种类分组：主线 → 支线 → 感情线 → 人物线，没有线的种类不给。 */
export interface ThreadsOverviewGroup {
  kind: ThreadKind;
  lines: ThreadsOverviewLine[];
}

export interface ThreadsOverview {
  /** 还不是小说工程（没有 `.novelforge/project.json`）时为 false，其余都是空的。 */
  initialized: boolean;
  /** 第 1 章起一章一列。 */
  chapters: ThreadsOverviewChapter[];
  /** 定稿到的最后一章（竖线画在它右边），与工程页「叙事线」页签同一个数。一章都没定稿是 0。 */
  current: number;
  /**
   * 叙事线判到第几章（四期：水位，不超过 {@link current}），与工程页同一个数。落后于定稿时另画一条竖线；线与伏笔的状态（逾期、
   * 断了、连线延到哪）按它算。
   */
  through: number;
  /** 分卷的书（有一章在卷目录里）：列头上多一行卷名。 */
  volumes: boolean;
  groups: ThreadsOverviewGroup[];
  /** 「未归属的伏笔」。一条伏笔都没有时缺席。 */
  unfiled?: { relPath: string; foreshadowing: ThreadsOverviewForeshadow[] };
  /**
   * 故事时间（2026-10-24）：有时间线文件时给——画「故事时间」那一行（点格子、点名字打开这份文件），`months` 时表头多一条月份带。
   */
  timeline?: { relPath: string; months: boolean };
  /**
   * 计划里提到的章号太远（多半是手误，`plan: 3-30000`）、列数被截在上限（`views/threads.ts` 的 `OVERVIEW_MAX_CHAPTERS`）时，
   * 原本要画到第几章。截掉的那几章上的事件不画，界面上照实说一句（第 2 条的精神：不静默截断）。
   */
  clippedFrom?: number;
}
