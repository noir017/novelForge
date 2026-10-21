import {
  THREAD_KINDS,
  ForeshadowState,
  Thread,
  ThreadBook,
  ThreadEvent,
  ThreadFileBase,
  foreshadowingOf,
  isForeshadowClosed,
  isForeshadowEvent,
  threadKey,
  threadStateAt,
  threadWatch,
} from '../model/threadFile';
import { ThreadReminder, isFallbackChapterTitle, threadRemindersFor } from '../model/pipeline';
import { NovelProject } from '../model/project';
import {
  ThreadLineView,
  ThreadUnfiledView,
  ThreadsOverview,
  ThreadsOverviewCell,
  ThreadsOverviewChapter,
  ThreadsOverviewChapterState,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewGroup,
  ThreadsOverviewLine,
  ThreadsOverviewSpan,
  ThreadsView,
} from '../protocol';
import { volumeOf } from './quickOpen';

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
 * 和 `views/lore.ts`、`views/cast.ts` 并排；三期的「叙事线总览」（章 × 线的时间轴，{@link buildThreadsOverview}）也从这里出数据：
 * 一行的说法、排序与「现在」都与工程页同一份。
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

// ---------------------------------------------------------------- 叙事线总览（三期）

/**
 * 总览的列数上限：几千章的书照样画得下（格子是稀疏的，一行只画有事件的那几章），再多就是计划里写错了章号
 * （`plan: 3-30000`）。有正文或细纲的章永远画全，只截计划里提得太远的那一截。
 */
export const OVERVIEW_MAX_CHAPTERS = 5000;

/** 总览里一列的原料：有细纲或正文的那几章（读盘那一半给，{@link buildThreadsOverview}）。 */
export interface OverviewChapterInput {
  no: number;
  title: string;
  volume: string;
  state: Exclude<ThreadsOverviewChapterState, 'none'>;
  chapterPath?: string;
  plotPath?: string;
}

/**
 * 编辑区「叙事线总览」标签的数据（设计稿「八、叙事线总览」）：读一遍叙事线目录与章节、细纲两份列表（借缓存），交给
 * {@link buildThreadsMatrix}。**纯读盘、不调模型、不落盘**（第 18、28 条：状态一律从事件现算）。「现在」与工程页「叙事线」
 * 页签同一个口径：定稿过（细纲有 `sourceHash`）、正文还在的章里章号最大的那一章。
 *
 * 按需要（`requestThreadsOverview`），不进工程树：工程树每次文件变动都全量重推，这份只在总览开着时有用。
 */
export async function buildThreadsOverview(project: NovelProject): Promise<ThreadsOverview> {
  if (!(await project.isInitialized())) {
    return { initialized: false, chapters: [], current: 0, volumes: false, groups: [] };
  }
  const [book, plots, chapters] = await Promise.all([project.readThreads(), project.listPlots(), project.listChapters()]);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const plotsRoot = project.relPath(project.plotsDir);
  // 同号的正文有两份时认路径排序第一份（与流水线、「转到…」同一个口径）。
  const chapterOf = new Map<number, (typeof chapters)[number]>();
  for (const c of chapters) {
    if (!chapterOf.has(c.order)) {
      chapterOf.set(c.order, c);
    }
  }
  const nos = [...new Set([...chapterOf.keys(), ...plots.map((p) => p.no)])].sort((a, b) => a - b);
  const inputs: OverviewChapterInput[] = nos.map((no) => {
    const chapter = chapterOf.get(no);
    // 细纲按路径配对（`NovelProject.plotFor`）：有正文只认它镜像的那一份，没有正文按号认计划。
    const plot = project.plotFor(no, plots, chapters);
    const title = plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : '');
    const state: OverviewChapterInput['state'] =
      chapter && plot?.sourceHash ? 'finalized' : chapter && chapter.wordCount > 0 ? 'written' : 'planned';
    return {
      no,
      title,
      volume: chapter ? volumeOf(chapter.relPath, chaptersRoot) : plot ? volumeOf(plot.relPath, plotsRoot) : '',
      state,
      ...(chapter ? { chapterPath: chapter.relPath } : {}),
      ...(plot ? { plotPath: plot.relPath } : {}),
    };
  });
  const current = inputs.reduce((max, c) => (c.state === 'finalized' && c.no > max ? c.no : max), 0);
  return { initialized: true, ...buildThreadsMatrix(book, inputs, current) };
}

/**
 * 总览的矩阵（纯函数）。`chapters` 是有细纲或正文的章，`current` 是「现在」（定稿到的最后一章）。
 *
 * - **列**：第 1 章到「计划或已写的最后一章」——有细纲或正文的章、任何事件（计划的、实际的）、伏笔计划埋与收的章、线的
 *   计划区间里最晚的那一章；中间没有文件的章补一列 `none`（卷名沿用前一章）。提得太远的截在 {@link OVERVIEW_MAX_CHAPTERS}。
 * - **行**：线按种类分组（主线 → 支线 → 感情线 → 人物线），组里的先后与工程页一样；每条线下面是它的伏笔（`foreshadowingOf`
 *   的顺序：「伏笔」一节写了的在前，只在事件里出现过的跟在后面）；最后是「未归属的伏笔」（一条都没有不给）。
 * - **线的格子**：线自己的事件（推进 / 关系 / 收束 / 放弃）；没写伏笔名的伏笔事件也放在这里（没有别的行可放）。
 * - **伏笔的格子**：这条伏笔的埋 / 收 / 弃；连线见 {@link spanOf}。
 */
export function buildThreadsMatrix(
  book: ThreadBook,
  chapters: readonly OverviewChapterInput[],
  current: number,
  limit = OVERVIEW_MAX_CHAPTERS
): Omit<ThreadsOverview, 'initialized'> {
  const files: ThreadFileBase[] = [...book.threads, book.unfiled];
  const fileMax = chapters.reduce((m, c) => Math.max(m, c.no), Math.max(0, current));
  const mentioned = [
    ...files.flatMap((f) => f.events.map((e) => e.chapter)),
    ...files.flatMap((f) => f.foreshadowing.flatMap((x) => [x.plant ?? 0, x.resolve ?? 0])),
    ...book.threads.flatMap((t) => [t.from ?? 0, t.to ?? 0]),
  ];
  const wanted = mentioned.reduce((m, n) => Math.max(m, n), fileMax);
  const last = Math.min(wanted, Math.max(limit, fileMax));

  const byNo = new Map(chapters.map((c) => [c.no, c]));
  const columns: ThreadsOverviewChapter[] = [];
  let volume = '';
  for (let no = 1; no <= last; no++) {
    const c = byNo.get(no);
    volume = c ? c.volume : volume;
    columns.push(c ? { ...c } : { no, title: '', volume, state: 'none' });
  }
  const finalized = new Set(columns.filter((c) => c.state === 'finalized').map((c) => c.no));

  // 组里的先后与工程页同一个排法（`buildThreadsView`）：最近推进的在前，没推进过的按计划开始的章。
  const order = book.threads
    .map((t) => ({ t, view: lineOf(t, current) }))
    .sort((a, b) => compareLines(a.t, a.view, b.t, b.view));
  const groups: ThreadsOverviewGroup[] = [];
  for (const { t, view } of order) {
    const line: ThreadsOverviewLine = {
      name: t.name,
      relPath: t.relPath,
      kind: t.kind,
      status: view.status,
      ...(t.from !== undefined ? { from: t.from } : {}),
      ...(t.to !== undefined ? { to: t.to } : {}),
      detail: view.detail,
      warnings: view.warnings,
      tip: view.tip,
      cells: lineCells(t, finalized, last),
      foreshadowing: foreshadowRows(t, current, finalized, last),
    };
    const group = groups.find((g) => g.kind === t.kind);
    if (group) {
      group.lines.push(line);
    } else {
      groups.push({ kind: t.kind, lines: [line] });
    }
  }
  const unfiled = foreshadowRows(book.unfiled, current, finalized, last);
  return {
    chapters: columns,
    current,
    volumes: columns.some((c) => c.volume !== ''),
    groups,
    ...(unfiled.length > 0 ? { unfiled: { relPath: book.unfiled.relPath, foreshadowing: unfiled } } : {}),
    ...(wanted > last ? { clippedFrom: wanted } : {}),
  };
}

function overviewEvent(e: ThreadEvent): ThreadsOverviewEvent {
  return {
    type: e.type,
    ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}),
    what: e.what,
    ...(e.evidence ? { evidence: e.evidence } : {}),
  };
}

/** 按章把事件归成格子（只给有事件的章，按章号升序；同一章里照文件里写的先后）。截掉 `last` 之后的。 */
function cellsOf(events: readonly ThreadEvent[], last: number): ThreadsOverviewCell[] {
  const by = new Map<number, ThreadsOverviewCell>();
  for (const e of events) {
    if (e.chapter > last) {
      continue;
    }
    let cell = by.get(e.chapter);
    if (!cell) {
      cell = { chapter: e.chapter, planned: [], actual: [], deviation: false };
      by.set(e.chapter, cell);
    }
    (e.planned ? cell.planned : cell.actual).push(overviewEvent(e));
  }
  return [...by.values()].sort((a, b) => a.chapter - b.chapter);
}

/**
 * 线那一行的格子：线自己的事件。偏差（⚑）= 这一章有计划、那一章定稿了，却**一条**实际的事件都没有——计划了推进与关系、只发生了
 * 推进的算发生了（画 ◉，悬停看得到两边各是什么）。伏笔的事件不算这条线动过：它们在伏笔那几行。
 */
function lineCells(t: Thread, finalized: ReadonlySet<number>, last: number): ThreadsOverviewCell[] {
  const cells = cellsOf(
    t.events.filter((e) => !(isForeshadowEvent(e.type) && e.foreshadowing)),
    last
  );
  for (const cell of cells) {
    cell.deviation = cell.planned.length > 0 && cell.actual.length === 0 && finalized.has(cell.chapter);
  }
  return cells;
}

/**
 * 一份文件（一条线，或「未归属的伏笔」）里的伏笔，一条一行。偏差（⚑）：计划在第 N 章埋的，第 N 章定稿了、到第 N 章为止还没埋
 * （也没收、没弃）；计划在第 N 章收的，第 N 章定稿了、到第 N 章为止还没收（或弃）。提前埋了、提前收了的不算偏差。
 */
function foreshadowRows(
  file: ThreadFileBase,
  current: number,
  finalized: ReadonlySet<number>,
  last: number
): ThreadsOverviewForeshadow[] {
  return foreshadowingOf(file, current).map((f) => {
    const key = threadKey(f.name);
    const mine = file.events.filter((e) => isForeshadowEvent(e.type) && e.foreshadowing && threadKey(e.foreshadowing) === key);
    const actual = mine.filter((e) => !e.planned);
    const plantedBy = (no: number) => actual.some((e) => e.type === '埋' && e.chapter <= no);
    const closedBy = (no: number) => actual.some((e) => e.type !== '埋' && e.chapter <= no);
    const cells = cellsOf(mine, last);
    for (const cell of cells) {
      if (!finalized.has(cell.chapter)) {
        continue;
      }
      const types = new Set(cell.planned.map((e) => e.type));
      const missedPlant = types.has('埋') && !plantedBy(cell.chapter) && !closedBy(cell.chapter);
      const missedClose = (types.has('收') || types.has('弃')) && !closedBy(cell.chapter);
      cell.deviation = missedPlant || missedClose;
    }
    const plannedChapters = (type: '埋' | '收') => mine.filter((e) => e.planned && e.type === type).map((e) => e.chapter);
    const span = spanOf(f, plannedChapters('埋'), plannedChapters('收'), current, last);
    return {
      name: f.name,
      what: f.what,
      status: f.status,
      ...(f.plant !== undefined ? { plant: f.plant } : {}),
      ...(f.resolve !== undefined ? { resolve: f.resolve } : {}),
      ...(f.plantedAt !== undefined ? { plantedAt: f.plantedAt } : {}),
      ...(f.closedAt !== undefined ? { closedAt: f.closedAt } : {}),
      overdue: f.overdue,
      ...(span ? { span } : {}),
      tip: foreshadowTip(f),
      cells,
    };
  });
}

/**
 * 伏笔一行上的连线（设计稿：埋 ● 到收 ◆ 之间连一条线，没收的虚线延到计划回收章）：
 *
 * - 收了、弃了：从埋的那一章实线连到收（弃）的那一章；
 * - 埋了没收：虚线从埋的那一章延到计划回收章——伏笔那一行写的回收章与计划里收它的那一章（推迟了的会更晚）**取晚的**（⚑，
 *   二期留的那个问题：两样都画，回收章那一格另有一道竖线，计划的收画空心 ◆）；逾期的延到「现在」；一样都没写也延到「现在」
 *   （它还挂着）；
 * - 还没埋：按计划从埋的那一章（伏笔那一行写的，没写取计划里埋它的那一章）到回收章画一条淡虚线；缺一头不画。
 *
 * 超过最后一列的截到最后一列。
 */
function spanOf(
  f: ForeshadowState,
  plannedPlants: readonly number[],
  plannedResolves: readonly number[],
  current: number,
  last: number
): ThreadsOverviewSpan | undefined {
  const clip = (span: ThreadsOverviewSpan): ThreadsOverviewSpan | undefined =>
    span.from < Math.min(span.to, last) ? { ...span, to: Math.min(span.to, last) } : undefined;
  if (isForeshadowClosed(f.status) && f.closedAt !== undefined) {
    return clip({ from: f.plantedAt ?? f.closedAt, to: f.closedAt, kind: 'done' });
  }
  const ends = [
    ...(f.resolve !== undefined ? [f.resolve] : []),
    ...plannedResolves,
    ...(f.overdue ? [current] : []),
  ];
  if (f.plantedAt !== undefined) {
    return clip({ from: f.plantedAt, to: Math.max(f.plantedAt, ...(ends.length > 0 ? ends : [current])), kind: 'open' });
  }
  const from = f.plant ?? (plannedPlants.length > 0 ? Math.min(...plannedPlants) : undefined);
  if (from === undefined || ends.length === 0) {
    return undefined;
  }
  return clip({ from, to: Math.max(...ends), kind: 'planned' });
}

/** 悬停伏笔名看的几行：是什么、计划第几章埋 / 第几章前收、现在怎样。 */
function foreshadowTip(f: ForeshadowState): string {
  const plan = [f.plant !== undefined ? `计划第 ${f.plant} 章埋` : '', f.resolve !== undefined ? `第 ${f.resolve} 章前收` : '']
    .filter(Boolean)
    .join('、');
  const state =
    f.status === '已收'
      ? `第 ${f.closedAt} 章收了`
      : f.status === '已弃'
        ? `第 ${f.closedAt} 章弃了`
        : f.status === '已埋'
          ? `第 ${f.plantedAt} 章埋下，还没收`
          : '还没埋';
  return [f.what, plan, `${state}${f.overdue ? `，过了第 ${f.resolve} 章（逾期）` : ''}`].filter(Boolean).join('\n');
}
