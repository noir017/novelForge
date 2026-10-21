import {
  THREAD_KINDS,
  Thread,
  ThreadBook,
  ThreadFileBase,
  foreshadowingOf,
  isForeshadowClosed,
  threadStateAt,
  threadWatch,
} from '../model/threadFile';
import { ThreadReminder, threadRemindersFor } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { ThreadLineView, ThreadUnfiledView, ThreadsView } from '../protocol';

/**
 * 叙事线一览（叙事线重做第 8 个提交，设计见 docs/design/plans/2026-10-20-narrative-threads.md「七、工程页」）：工程页
 * 「叙事线」页签那一列——一条线一行，作者一眼看出各条线走到哪、哪条断了、哪条伏笔该收了。
 *
 * - **纯函数、不调模型、不落盘**（第 18 条：状态一律从磁盘推导）。读盘由调用方做：工程页刷新时 `projectView.ts`
 *   把它那一趟 `readThreads()` 读到的整本交进来，同一次刷新里叙事线目录每份只读一次（`projectTreeReads` 钉着）。
 * - **「现在」是定稿到的最后一章**（定稿过的章里章号最大的那一章）：线上的实际事件都是定稿写进来的，拿「写到第几章」
 *   当现在的话，写了没定稿的那几章会让每条线都像断了。
 * - **一行怎么写由这里给**（与设定名录、出场人物同一个道理：文案只有一份），前端只渲染、只加 ⚠。
 *
 * 和 `views/lore.ts`、`views/cast.ts` 并排；三期的「叙事线总览」（章 × 线的时间轴）也从这里出数据。
 *
 * 写前检查的两类提醒（二期，{@link threadReminders}）也在这里取数：工作台、对话页写正文之前、批量写章的确认框用它；
 * 前端批量写章弹窗拿工程页数据里的 `watch` 自己算（同一个 `threadRemindersFor`）。
 */

/** 排序：主线 → 支线 → 感情线 → 人物线。 */
const KIND_ORDER = new Map(THREAD_KINDS.map((k, i) => [k, i]));

/** 一行鼠标移上去看的（意图、当前进度）各截多少字。 */
const TIP_CHARS = 120;

/** 压成一行、截到 `max` 个字（装配器的 `clipLine` 同一个写法；views 不依赖 context/）。 */
function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s*\n+\s*/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/**
 * 工程页「叙事线」页签的数据。`current` 是「现在」：定稿到的最后一章。
 *
 * 排序：种类（主线 → 支线 → 感情线 → 人物线）→ 最近一次推进（近的在前；一次都没推进过的排在同种类最后，按计划
 * 开始的章）→ 目录里的顺序（文件名）。
 */
export function buildThreadsView(book: ThreadBook, current: number): ThreadsView {
  const lines = book.threads.map((t) => lineOf(t, current));
  const order = new Map(book.threads.map((t) => [t.relPath, t]));
  lines.sort((a, b) => compareLines(order.get(a.relPath)!, a, order.get(b.relPath)!, b));
  const unfiled = unfiledOf(book.unfiled, current);
  // 写前提醒要的数（二期）：按现在的样子算，前端批量写章弹窗照它与要写的那几章算提醒（与后端确认框同一个函数）。
  return { lines, ...(unfiled ? { unfiled } : {}), current, watch: threadWatch(book) };
}

/**
 * 写这几章之前的叙事线提醒（二期，设计稿「四、写前检查」）：伏笔逾期、线断了，零调用、不拦人。读一遍叙事线目录与章节，
 * 按第一章 `asOf`（写第 N 章时按第 N − 1 章算，`threadRemindersFor`）。`through` 是定稿到的最后一章（同工程页的「现在」：
 * 定稿过、正文还在的章里章号最大的），说法里拿它注一句没定稿的那几章（`unrecordedBefore`）。
 */
export async function threadReminders(project: NovelProject, nos: readonly number[]): Promise<{ reminders: ThreadReminder[]; through: number }> {
  if (nos.length === 0) {
    return { reminders: [], through: 0 };
  }
  const first = Math.min(...nos);
  const [book, plots, chapters] = await Promise.all([project.readThreads(), project.listPlots(), project.listChapters()]);
  const through = chapters.reduce((max, c) => (c.order > max && project.plotFor(c.order, plots, chapters)?.sourceHash ? c.order : max), 0);
  return { reminders: threadRemindersFor(threadWatch(book, first), nos), through };
}

function compareLines(ta: Thread, a: ThreadLineView, tb: Thread, b: ThreadLineView): number {
  return (
    KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    (b.lastActive ?? -1) - (a.lastActive ?? -1) ||
    (ta.from ?? Infinity) - (tb.from ?? Infinity) ||
    ta.index - tb.index
  );
}

/** 一条线一行。 */
function lineOf(t: Thread, current: number): ThreadLineView {
  const state = threadStateAt(t, current);
  const fores = foreshadowingOf(t, current);
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdueFores = fores.filter((f) => f.overdue).length;
  const detail = [
    t.kind,
    state.status,
    state.lastActive !== undefined ? `最近第 ${state.lastActive} 章` : planOf(t),
    open > 0 ? `${open} 条伏笔没收` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const warnings = [
    state.stalled ? `断了 ${state.gap} 章` : '',
    overdueFores > 0 ? `${overdueFores} 条伏笔逾期` : '',
    state.overdue ? `过了计划收束的第 ${t.to} 章` : '',
  ].filter(Boolean);
  const tip = [
    t.intent ? `意图：${clipLine(t.intent, TIP_CHARS)}` : '',
    t.progress ? `当前进度${t.progressThrough !== undefined ? `（写到第 ${t.progressThrough} 章）` : ''}：${clipLine(t.progress, TIP_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: t.name,
    relPath: t.relPath,
    kind: t.kind,
    status: state.status,
    ...(state.lastActive !== undefined ? { lastActive: state.lastActive } : {}),
    detail,
    warnings,
    tip,
  };
}

/** 还没推进过的线写计划区间：`计划第 3–40 章`、`计划第 3 章起`、`计划第 40 章收`。都没写是空串。 */
function planOf(t: Thread): string {
  if (t.from !== undefined && t.to !== undefined) {
    return `计划第 ${t.from}–${t.to} 章`;
  }
  if (t.from !== undefined) {
    return `计划第 ${t.from} 章起`;
  }
  return t.to !== undefined ? `计划第 ${t.to} 章收` : '';
}

/**
 * 「未归属的伏笔 · N 条」。一条伏笔都没有（没有这份文件、或作者把它们都挪走了）时不画这一行：点进去也是空的。
 * 只在事件里出现过名字的也算一条（与 `foreshadowingOf` 同一个口径）。
 */
function unfiledOf(file: ThreadFileBase, current: number): ThreadUnfiledView | undefined {
  const fores = foreshadowingOf(file, current);
  if (fores.length === 0) {
    return undefined;
  }
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdue = fores.filter((f) => f.overdue).length;
  return {
    relPath: file.relPath,
    total: fores.length,
    detail: `${fores.length} 条${open < fores.length ? ` · ${open} 条没收` : ''}`,
    warnings: overdue > 0 ? [`${overdue} 条伏笔逾期`] : [],
  };
}
