/**
 * 「时间线总览」（独立版内置编辑器里的一个特殊标签，2026-10-24，设计稿 docs/design/plans/2026-10-24-timeline-page.md）要的那份数据：
 * 竖着按故事日子排，一个日子一项，那一天的几章一章一张卡片。
 *
 * 和「叙事线总览」同一个做法：标签显示出来时前端发 `requestTimelineOverview`，后端回 `timelineOverview`（同一个 `requestId`）——
 * **按需要，不常驻推送**（只在总览开着的时候有用，塞进每次文件变动都全量重推的 `ProjectTree` 等于每保存一次就白推一遍）。
 *
 * 构建见 `views/timeline.ts` 的 `buildTimelineMatrix`（纯函数、不调模型、不落盘；日期与对账现算，第 18、28 条），读盘在
 * `views/threads.ts` 的 `buildTimelineOverview`；前端只画（`media/src/editor/timelineOverview.ts`）。文案都由后端给。
 */
import type { ThreadEventType } from '../model/threadFile';
import type { TimelineDayState, TimelineSeason } from '../model/timelineFile';
import type { TimelineIssueView } from './views';

export interface TimelineOverview {
  /** 还不是小说工程（没有 `.novelforge/project.json`）时为 false，其余都是空的。 */
  initialized: boolean;
  /** `threads/时间线.md`（还没有这份文件时也给：补推会建它）。 */
  relPath: string;
  /** 文件在不在。 */
  exists: boolean;
  /** 标题栏后面那一串：`简单历 · 起点 大衍三年三月初七 · 推到第 30 章 · 故事第 46 天（大衍三年四月十九 夜里）`。 */
  meta: string;
  /** 标题栏的悬停：历法怎么算、起点。 */
  tip: string;
  /** 「改历法与起点」「填为起点」要的（同工程页那一组）。 */
  calendar: { name: '简单历' | '公历'; start: string; suggestion?: { start: string; note: string } };
  /** ⚠ 一条一行（不带 ⚠，前端加）：对账、推不出、认不出、起点、还没推。`chapter` 给了的点了展开那一章。 */
  issues: TimelineIssueView[];
  /** 筛选下拉里的线：有实际事件的线，按种类（主线 → 支线 → 感情线 → 人物线）与目录里的先后；「未归属的伏笔」排最后。 */
  threads: TimelineOverviewThread[];
  /** 轴：按故事日子从早到晚，一个日子一项（没有章的日子不给）。 */
  days: TimelineOverviewDay[];
  /** 同步过、时间线里还没有（或还推不出）的章（右键「补推时间」）。没有时缺席。 */
  missing?: { count: number; text: string };
  /** 机器写的行有几行（右键「重推」；0 时不给）。 */
  machine: number;
  /** 最后一章的章号（「从这一章起重推」到哪一章）。 */
  last: number;
}

/** 一条线：名字与颜色（0–7 循环；-1 是「未归属的伏笔」，灰）。 */
export interface TimelineOverviewThread {
  name: string;
  color: number;
}

/** 轴上的一个日子。 */
export interface TimelineOverviewDay {
  /** 故事第几天（第 1 天 = 起点；只有回忆、一天都推不出时是 0）。 */
  day: number;
  /** 轴上写的：`三月初七`、`3月7日`；没起点 `第 8 天`。 */
  label: string;
  /** 下面一行小字：`第 1 天`（没起点时缺席——大字就是它）。 */
  sub?: string;
  /** 悬停：`大衍三年三月初七`。 */
  full: string;
  /** 这一天在哪个月（填了起点才有）：`大衍三年三月`。月份变了，前端插一行分隔。 */
  month?: string;
  /** 那个月是什么季节（同对账的口径：简单历正月到三月是春，公历 3–5 月是春）。 */
  season?: TimelineSeason;
  /** 这一天开头的章（按章号）；回忆的章跟在阅读顺序上前一章后面。 */
  cards: TimelineOverviewCard[];
}

/** 一章一张卡片。 */
export interface TimelineOverviewCard {
  no: number;
  title: string;
  state: TimelineDayState;
  /** 右上角那一截：`清晨 → 夜里`、`清晨 → 三月十五 夜里 · 3 天`、`回忆（约二十年前）`；同一天又没写时段是空串。 */
  when: string;
  /** 比上一章：`+2 天`、`同一天`、`往回 3 天`；第 1 章、回忆、没推缺席。 */
  delta?: string;
  /** 依据「…」、推测：…、推不出：…、正文写明八月十五、你定的、还没推（截短；全文在 `detail`）。 */
  note: string;
  /** 这一章在各条线上实际发生的事（计划的不给），按线的先后、同一条线里照文件里的先后。 */
  events: TimelineOverviewEvent[];
  /** 一条事件都没有时：细纲的梗概。 */
  synopsis?: string;
  /** 对账报了这一章的几条（卡片上红字一条一行）。 */
  issues: string[];
  /** 展开之后的详情（一条一行）：那一天的全称、故事第几天、比上一章、历时、依据、正文写明的、对齐、季节、细纲的时间地点。 */
  detail: string[];
  /** 整章是回忆：挂在阅读顺序上前一章那一天里，缩进、虚线框。 */
  flashback?: true;
  /** 「只看有问题的」留它：对账报了、推不出、认不出、还没推。 */
  problem: boolean;
  /** 正文、细纲（右键打开）；还没有时缺席。 */
  chapterPath?: string;
  plotPath?: string;
  /** 这一行是机器写的（右键「重推这一章」给不给）。 */
  machine: boolean;
}

/** 卡片上的一条事件。 */
export interface TimelineOverviewEvent {
  /** 线名；「未归属的伏笔」里的写「未归属的伏笔」。 */
  thread: string;
  /** 同 {@link TimelineOverviewThread.color}。 */
  color: number;
  type: ThreadEventType;
  /** 伏笔的事件挂的是哪一条。 */
  foreshadowing?: string;
  what: string;
  /** 正文里的一句原文。 */
  evidence?: string;
}
