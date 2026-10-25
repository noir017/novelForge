/**
 * 工程页「叙事线」页签（叙事线重做第 8 个提交）：一条线一行，最后一行是「未归属的伏笔」。
 *
 * 一行写 `林昭与沈青 · 感情线 · 进行中 · 最近第 12 章 · 2 条伏笔没收`，有问题的另加 `⚠ 断了 15 章`、
 * `⚠ 1 条伏笔逾期`、`⚠ 过了计划收束的第 40 章`。这几句由后端给（`views/threads.ts`，文案只有一份），这里只渲染、
 * 只在每一句前面加 ⚠。作者一眼要看出的是「哪条线走到哪了、哪条该管一管」，所以 ⚠ 另起一格、不截断。
 *
 * - **点一行打开那条线的文件**（单击临时标签、双击转正，同别的行）；右键「打开」「在总览里看」（叙事线重做三期：编辑区里
 *   「叙事线总览」标签打开、定位到这一行）。
 * - **失败的 ❗ 挂在对应的行上**：当前进度作者改过、没覆盖的黄 ❗ 挂在那条线的文件上；排线失败的红 ❗ 挂在叙事线
 *   目录上，没有对应的行，放在页签标题旁边、按钮前面。
 * - **「从大纲排出 / 从大纲补充」在页签标题旁边**（组标题只管折叠，点不开东西，`groups.ts` 的 `head`）：线从情节
 *   大纲排，还没有大纲时不给；排线在跑时也不给（点第二次只会撞上「已有任务在进行」，任务名与 features/threads.ts
 *   的 runTask 一字不差）。按钮不直接花钱：后端先弹确认框，写明 1 次调用。右键标题与页里的空白处也给这一项。
 * - **「总览」也在页签标题旁边**（三期）：打开编辑区里的「叙事线总览」（章 × 线的时间轴）。**能力探测**：先问
 *   `nf-threads-query` 有没有人画得了——只有内置编辑器（editor.js）回答，插件形态没有内置编辑器，「总览」与「在总览里看」
 *   都不画（设计稿 ⚑11：VS Code 插件先不做总览；不判断是哪个壳）。一条线、一条未归属的伏笔都没有时也不给（打开了是空的）。
 * - 挂伏笔靠作者在文件里剪贴（设计稿 ⚑10），这里不做「挪」。
 * - **一行右键「标为收束」「标为放弃」**（2026-10-24）：同步漏报了收束的线（第 7 章就走完了，却一直挂「断了 75 章」）由作者补一笔。
 *   进行中的两样都给，计划中的只给放弃，收束、放弃了的不给。不调模型，后端先问一句（features/threads.ts 的 `markThreadEnded`）。
 * - **叙事线判到哪**（四期）：定稿了、叙事线还没判的章（拆书导入、补齐整理出来的、补记停在半路的）在页里最上面说一句
 *   「⚠ 第 31–60 章还没判」——线的状态按判到的那一章算，这几章上线里本来就没有事件。文案由后端给（`views/threads.ts`）。
 *   这时标题旁多一个「从正文补记」（右键标题、页里空白处也有）：逐章走定稿第三步，后端先弹确认框写明章数与次数；补记在跑时
 *   不给（任务名与 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差）。不落后时不给——没有要补的。
 * - **故事时间单独一组「时间线」**（2026-10-24 重做，设计稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：排在叙事线组前面，
 *   {@link buildTimelineRows}。对账一条一行，章按月分段（最后一段默认展开、其余收起，⚑9）一章一行；右键改时间、重推这一章、从这一章起重推。
 *   标题旁「补推时间」「重推」「总览」，都先由后端弹确认框。文案后端给。
 * - **同日「时间线总览」**（docs/design/plans/2026-10-24-timeline-page.md「二」，作者嫌原来的点法反人类）：历法与起点那一行去掉，挪到组标题的
 *   悬停里、改走右键（没填起点有建议、起点认不出的各成一条 ⚠，右键改）；**点一章打开时间线总览、展开这一章**，不再打开正文（推翻上一稿
 *   ⚑10；打开正文挪到右键）；点一条带章号的 ⚠ 同样定位过去；标题旁「总览」打开时间线总览。插件形态没有内置编辑器（`nf-timeline-query`
 *   没人回答）：点一章、点 ⚠ 打开时间线文件（⚑8），不给「总览」。
 */
import { el as mk } from '../../dom';
import { commandThreadsOverview, commandTimelineOverview, queryThreadsOverview, queryTimelineOverview } from '../../globals';
import type { MenuItem } from '../../globals';
import { THREAD_PLAN_CALLS, THREADS_JUDGE_CALLS } from '../../protocol';
import type { ProjectTree, ThreadLineView, ThreadUnfiledView, TimelineChapterView, TimelineGroupView, TimelineSegmentView } from '../../protocol';
import { linkBtn } from '../buttons';
import { onContextMenu } from '../menu';
import { openPath, vscode } from '../store';
import { hasTask } from '../tasks';
import { baseMenuItems, projectAction } from './actions';
import { emptyRow, failureMark } from './rows';
import { indentOf, timelineFolds } from './treeState';

/** 排线的任务名：与 features/threads.ts 的 runTask 一字不差。 */
const PLAN_TASK = '排叙事线';
/** 补记的任务名：与 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差。 */
const BACKFILL_TASK = '从已写正文补记叙事线';
/** 补推、重推故事时间的任务名：与 features/timelineBackfill.ts 的 `TIMELINE_BACKFILL_TASK` / `TIMELINE_REFRESH_TASK` 一字不差。 */
const TIME_BACKFILL_TASK = '从正文补推故事时间';
const TIME_REFRESH_TASK = '重推故事时间';

/** 补推、重推有一样在跑：两样都不给（同时跑会互相写同一份时间线）。 */
function timeTaskRunning(): boolean {
  return hasTask(TIME_BACKFILL_TASK) || hasTask(TIME_REFRESH_TASK);
}

/** 同步过、时间线里还没有（或还推不出）的章（2026-10-24）：给「补推时间」。 */
function canBackfillTime(tree: ProjectTree): boolean {
  return !!tree.threads.timeline?.missing;
}

/** 时间线里有机器写的行：给「重推」。 */
function canRefreshTime(tree: ProjectTree): boolean {
  return (tree.threads.timeline?.machine ?? 0) > 0;
}

/** 叙事线落后于定稿（有定稿了还没判的章）：给「从正文补记」。 */
function canBackfill(tree: ProjectTree): boolean {
  return !!tree.threads.lag;
}

/** 有情节大纲才排得出线。 */
function canPlan(tree: ProjectTree): boolean {
  return tree.architecture.some((a) => a.key === 'outline' && a.filled);
}

/** 没有线时「从大纲排出」，有了「从大纲补充」。 */
function planVerb(tree: ProjectTree): string {
  return tree.threads.lines.length === 0 ? '从大纲排出' : '从大纲补充';
}

/** 组标题的副标题：`4 条 · 3 条进行中`；一条都没有说「还没有」。 */
export function threadsGroupLabel(tree: ProjectTree): string {
  const lines = tree.threads.lines;
  if (lines.length === 0) {
    return '还没有';
  }
  const going = lines.filter((l) => l.status === '进行中').length;
  return going > 0 ? `${lines.length} 条 · ${going} 条进行中` : `${lines.length} 条`;
}

/**
 * 「叙事线总览」画得了、也有东西可画：有内置编辑器（能力探测，插件形态没有人回答）、至少有一条线或一条未归属的伏笔。时间线不算
 * （2026-10-24：时间线挪去了自己的「时间线总览」）。
 */
function canOverview(tree: ProjectTree): boolean {
  return (tree.threads.lines.length > 0 || !!tree.threads.unfiled) && queryThreadsOverview();
}

/** 一行右键「在总览里看」：打开编辑区里的叙事线总览，定位到这一行。没有内置编辑器时不给。 */
function overviewItems(tree: ProjectTree, relPath: string): MenuItem[] {
  return canOverview(tree) ? [{ label: '在总览里看', run: () => commandThreadsOverview(relPath) }] : [];
}

/** 组标题与页里空白处的右键：补记（落后时才有）、排线那一项（有情节大纲才有）、打开总览（有内置编辑器才有）。 */
export function threadsMenuItems(tree: ProjectTree): MenuItem[] {
  const items: MenuItem[] = [];
  if (canBackfill(tree)) {
    items.push({ label: '从已写正文补记叙事线', run: () => projectAction('backfillThreads') });
  }
  if (canPlan(tree)) {
    items.push({ label: `${planVerb(tree)}叙事线`, run: () => projectAction('generateThreads') });
  }
  if (canOverview(tree)) {
    items.push({ label: '打开叙事线总览', run: () => commandThreadsOverview() });
  }
  return items.length > 0 ? [...items, { sep: true }] : [];
}

/** 页签标题旁边那一截：排线失败的红 ❗、「从正文补记」（落后时）、「从大纲排出 / 补充」与「总览」。都没有时是 undefined。 */
export function threadsHead(tree: ProjectTree): HTMLElement | undefined {
  const box = mk('span', 'threads-head');
  const mark = failureMark(tree.threadsPath);
  if (mark) {
    box.appendChild(mark);
  }
  if (canBackfill(tree) && !hasTask(BACKFILL_TASK)) {
    const btn = linkBtn('从正文补记', () => projectAction('backfillThreads'));
    btn.classList.add('threads-backfill-btn');
    btn.title = `从已写正文补记叙事线：${tree.threads.lag!.text}，逐章认这一章在叙事线上发生了什么（先弹确认框，每章调用模型 ${THREADS_JUDGE_CALLS.low}–${THREADS_JUDGE_CALLS.high} 次，含转写）；已有的不动，只往线里追加`;
    box.appendChild(btn);
  }
  if (canPlan(tree) && !hasTask(PLAN_TASK)) {
    const btn = linkBtn(planVerb(tree), () => projectAction('generateThreads'));
    btn.title = `从情节大纲排叙事线（先弹确认框，调用模型 ${THREAD_PLAN_CALLS.low} 次：排 1 次、转写 1 次）；已有的线不动，同名跳过`;
    box.appendChild(btn);
  }
  if (canOverview(tree)) {
    const btn = linkBtn('总览', () => commandThreadsOverview());
    btn.classList.add('threads-overview-btn');
    btn.title = '在编辑区打开叙事线总览：章 × 线的时间轴，每条线走到哪、伏笔埋了收了没有、计划的事哪一章没发生（不调模型）';
    box.appendChild(btn);
  }
  return box.childElementCount > 0 ? box : undefined;
}

/**
 * 叙事线组的全部行：（叙事线落后于定稿时）最上面一句「还没判」，一条线一行（后端已排好），最后是「未归属的伏笔」；
 * 一条线都没有时说清先做什么。
 */
export function buildThreadRows(tree: ProjectTree): HTMLElement[] {
  const { lines, unfiled, lag } = tree.threads;
  const rows = lines.map((line) => buildLineRow(tree, line));
  if (lag) {
    rows.unshift(buildLagRow(tree, lag));
  }
  if (lines.length === 0) {
    rows.push(
      emptyRow(
        canPlan(tree)
          ? '还没有叙事线。点标题旁的「从大纲排出」，从情节大纲排出主线、支线、感情线、人物线；同步时也会从正文里认出新的线。'
          : '还没有叙事线。先排出情节大纲，再从大纲排出叙事线；同步时也会从正文里认出新的线。'
      )
    );
  }
  if (unfiled) {
    rows.push(buildUnfiledRow(tree, unfiled));
  }
  return rows;
}

/**
 * 「⚠ 第 31–60 章还没判」（四期）：定稿了、叙事线还没判的章。挂在页里最上面（与角色组的「称呼冲突」同一个样子）：说清线的状态
 * 按判到的那一章算、总览上这几章的计划不算偏差。
 */
function buildLagRow(tree: ProjectTree, lag: NonNullable<ProjectTree['threads']['lag']>): HTMLElement {
  const through = tree.threads.through;
  const row = mk(
    'div',
    'row-conflict threads-lag',
    `⚠ ${lag.text}：这几章同步了，叙事线还没记上。` +
      `${through > 0 ? `线断了几章、伏笔逾期都按判到的第 ${through} 章算` : '线断了几章、伏笔逾期先不算'}，总览上这几章的计划不算偏差。` +
      '点标题旁的「从正文补记」逐章补上（先问你，每章 1–3 次调用）。'
  );
  row.title = `叙事线判到第 ${through} 章（从第 1 章起连续判过的），同步到第 ${tree.threads.current} 章。`;
  return row;
}

/** 一章的状态点：有依据 ●、推测 ○、推不出 ?、没推 ·、你定的 ★、正文写明 ◆、回忆 ↺、认不出 ✕。 */
const TIME_DOT: Record<TimelineChapterView['state'], string> = {
  evidence: '●',
  guess: '○',
  unknown: '?',
  missing: '·',
  anchor: '★',
  dated: '◆',
  flashback: '↺',
  bad: '✕',
};

const TIME_STATE: Record<TimelineChapterView['state'], string> = {
  evidence: '有原文依据',
  guess: '推测的',
  unknown: '推不出',
  missing: '还没推',
  anchor: '你定的',
  dated: '正文写明了日子',
  flashback: '整章是回忆',
  bad: '那一行认不出',
};

/** 「时间线」组标题后面那一串。 */
export function timelineGroupLabel(tree: ProjectTree): string {
  return tree.threads.timeline?.label ?? '';
}

/** 「时间线」组标题的悬停：历法与起点、历法怎么算（2026-10-24 从组里第一行挪上来）。 */
export function timelineGroupTip(tree: ProjectTree): string | undefined {
  const cal = tree.threads.timeline?.calendar;
  return cal ? `${cal.text}\n${cal.tip}` : undefined;
}

/** 改历法与起点、填为起点（组标题右键、说起点的那条 ⚠ 右键）。 */
function startItems(tree: ProjectTree): MenuItem[] {
  const suggestion = tree.threads.timeline?.calendar.suggestion;
  return [
    { label: '改历法与起点…', run: () => projectAction('setTimelineStart') },
    ...(suggestion ? [{ label: `填为起点「${suggestion.start}」（${suggestion.note}）`, run: () => projectAction('setTimelineStart', undefined, undefined, suggestion.start) }] : []),
  ];
}

/**
 * 点一章、点一条 ⚠：有内置编辑器就打开时间线总览（带章号的展开那一章），没有（插件形态）打开时间线文件（⚑8）。看的是时间，不是正文。
 */
function showInTimeline(tree: ProjectTree, chapter?: number): void {
  const tl = tree.threads.timeline;
  if (queryTimelineOverview()) {
    commandTimelineOverview(chapter);
  } else if (tl?.exists) {
    openPath(tl.relPath);
  }
}

/** 时间线组标题与组里空白处的右键：补推、重推、改历法与起点（填为起点）、打开时间线总览、打开文件。 */
export function timelineMenuItems(tree: ProjectTree): MenuItem[] {
  const tl = tree.threads.timeline;
  if (!tl) {
    return [];
  }
  const busy = timeTaskRunning();
  return [
    ...(canBackfillTime(tree) && !busy ? [{ label: '从正文补推故事时间', run: () => projectAction('backfillTimeline') }] : []),
    ...(canRefreshTime(tree) && !busy ? [{ label: `重推机器写的 ${tl.machine} 行…`, run: () => projectAction('refreshTimeline') }] : []),
    ...startItems(tree),
    ...(queryTimelineOverview() ? [{ label: '打开时间线总览', run: () => commandTimelineOverview() }] : []),
    ...(tl.exists ? [{ label: '打开时间线文件', run: () => openPath(tl.relPath) }] : []),
    { sep: true },
  ];
}

/** 时间线组标题旁边那一截：补推 / 重推失败的红 ❗、「补推时间」「重推」「总览」。都没有时是 undefined。 */
export function timelineHead(tree: ProjectTree): HTMLElement | undefined {
  const tl = tree.threads.timeline;
  if (!tl) {
    return undefined;
  }
  const box = mk('span', 'threads-head');
  const mark = failureMark(tl.relPath);
  if (mark) {
    box.appendChild(mark);
  }
  const busy = timeTaskRunning();
  if (canBackfillTime(tree) && !busy) {
    const btn = linkBtn('补推时间', () => projectAction('backfillTimeline'));
    btn.classList.add('threads-time-btn');
    btn.title = `从正文补推故事时间：${tl.missing!.text}，几章一批判每章比上一章晚几天（先弹确认框，写明调用次数）；只往时间线里填空，你写的行不动`;
    box.appendChild(btn);
  }
  if (canRefreshTime(tree) && !busy) {
    const btn = linkBtn('重推', () => projectAction('refreshTimeline'));
    btn.classList.add('threads-refresh-btn');
    btn.title = `机器写的 ${tl.machine} 行照正文重新推一遍（先弹确认框，写明会换掉几行、调用次数）；你定的行一个字不动`;
    box.appendChild(btn);
  }
  if (queryTimelineOverview()) {
    const btn = linkBtn('总览', () => commandTimelineOverview());
    btn.classList.add('timeline-overview-btn');
    btn.title = '在编辑区打开时间线总览：竖着按故事里的日子排，一章一张卡片——哪天、隔了多久、这一章在各条线上发生了什么、哪里对不上（不调模型）';
    box.appendChild(btn);
  }
  return box.childElementCount > 0 ? box : undefined;
}

/**
 * 「时间线」组的全部行：对账一条一行、各段（段头 + 一章一行）。`rerender` 是折叠之后重画（同章节页签的卷）。历法与起点在组标题的悬停里
 * （{@link timelineGroupTip}）。
 */
export function buildTimelineRows(tree: ProjectTree, rerender: () => void): HTMLElement[] {
  const tl = tree.threads.timeline;
  if (!tl) {
    return [];
  }
  const rows: HTMLElement[] = [];
  const overview = queryTimelineOverview();
  for (const issue of tl.issues) {
    // 一条一行、不加框（叙事线组的「还没判」是一句话的大框；对账可能有好几条，框起来要占半屏）。
    const row = mk('div', 'timeline-issue', `⚠ ${issue.text}`);
    if (overview || tl.exists) {
      row.title = overview
        ? issue.chapter !== undefined
          ? `点击在时间线总览里看第 ${issue.chapter} 章`
          : '点击打开时间线总览'
        : '点击打开时间线文件（在那里改，或者右键那一章「改时间」）';
      row.addEventListener('click', () => showInTimeline(tree, issue.chapter));
    }
    if (issue.start) {
      onContextMenu(row, () => [...startItems(tree), { sep: true }, ...timelineMenuItems(tree), ...baseMenuItems()]);
    }
    rows.push(row);
  }
  const lastKey = tl.segments[tl.segments.length - 1]?.key;
  for (const seg of tl.segments) {
    // 最后一段默认展开、其余默认收起（⚑9）；作者点过的照作者的。
    const open = timelineFolds.open.has(seg.key) || (seg.key === lastKey && !timelineFolds.closed.has(seg.key));
    rows.push(buildSegmentHead(seg, open, seg.key === lastKey, rerender));
    if (open) {
      for (const c of seg.chapters) {
        rows.push(buildTimeChapterRow(tree, tl, c));
      }
    }
  }
  if (tl.segments.length === 0) {
    rows.push(emptyRow('时间线里还没有一章。同步时会推这一章的时间；已经同步过的章点标题旁的「补推时间」。'));
  }
  return rows;
}

/** 一段的段头：`▾ 大衍三年三月 · 第 1–12 章 · 14 天`，点了折叠。 */
function buildSegmentHead(seg: TimelineSegmentView, open: boolean, last: boolean, rerender: () => void): HTMLElement {
  const row = mk('div', 'row row-dir row-timeline-segment');
  row.dataset.segment = seg.key;
  row.style.paddingLeft = `${indentOf(0)}px`;
  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);
  row.appendChild(mk('span', 'row-label row-dir-label', seg.label));
  row.appendChild(mk('span', 'meta', seg.detail));
  const toggle = () => {
    // 记下作者的选择：默认展开的（最后一段）折起来记在 closed，默认收起的展开记在 open。
    if (open) {
      timelineFolds.open.delete(seg.key);
      if (last) {
        timelineFolds.closed.add(seg.key);
      }
    } else {
      timelineFolds.closed.delete(seg.key);
      if (!last) {
        timelineFolds.open.add(seg.key);
      }
    }
    rerender();
  };
  row.addEventListener('click', toggle);
  return row;
}

/** 一章一行：状态点、章号与章名、那一天、比上一章、依据；点了在时间线总览里展开这一章（插件形态打开时间线文件），右键改时间与重推、打开正文。 */
function buildTimeChapterRow(tree: ProjectTree, tl: TimelineGroupView, c: TimelineChapterView): HTMLElement {
  const row = mk('div', `row row-thread row-time-chapter time-${c.state}${c.issue ? ' has-issue' : ''}`);
  row.dataset.chapter = String(c.no);
  row.style.paddingLeft = `${indentOf(1)}px`;
  const dot = mk('span', 'dot', TIME_DOT[c.state]);
  dot.title = TIME_STATE[c.state];
  row.appendChild(dot);
  const label = mk('span', 'row-label', `第 ${c.no} 章${c.title ? ` ${c.title}` : ''}`);
  const overview = queryTimelineOverview();
  label.title = [c.tip, overview ? '点击在时间线总览里看这一章；右键改时间、打开正文' : tl.exists ? '点击打开时间线文件；右键改时间、打开正文' : '右键改时间'].join('\n\n');
  if (overview || tl.exists) {
    label.addEventListener('click', () => showInTimeline(tree, c.no));
  }
  row.appendChild(label);
  row.appendChild(mk('span', 'meta row-detail', [c.when, c.delta ?? '', c.note].filter(Boolean).join(' · ')));
  if (c.issue) {
    appendWarnings(row, ['对不上']);
  }
  const busy = timeTaskRunning();
  onContextMenu(row, () => [
    { label: '改时间…', run: () => projectAction('editTimeline', undefined, undefined, String(c.no)) },
    ...(!busy && (c.machine || c.state === 'missing') ? [{ label: '重推这一章', run: () => refreshRange(c.no, c.no) }] : []),
    ...(!busy && tl.last > c.no ? [{ label: `从这一章起重推（到第 ${tl.last} 章）`, run: () => refreshRange(c.no, tl.last) }] : []),
    { sep: true },
    ...(c.chapterPath ? [{ label: '打开这一章', run: () => openPath(c.chapterPath!) }] : []),
    ...(tl.exists ? [{ label: '打开时间线文件', run: () => openPath(tl.relPath) }] : []),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 重推一段（后端先弹确认框）。 */
function refreshRange(from: number, to: number): void {
  vscode.postMessage({ type: 'projectAction', action: 'refreshTimeline', range: { from, to } });
}

/** 状态点：进行中 ●、计划中 ○、已收束 ✓、已放弃 ✕。 */
const STATUS_DOT: Record<ThreadLineView['status'], string> = { 进行中: '●', 计划中: '○', 已收束: '✓', 已放弃: '✕' };

function buildLineRow(tree: ProjectTree, line: ThreadLineView): HTMLElement {
  const closed = line.status === '已收束' || line.status === '已放弃';
  const row = mk('div', `row row-thread${closed ? ' row-thread-closed' : ''}`);
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', STATUS_DOT[line.status]);
  dot.title = line.status;
  row.appendChild(dot);

  const mark = failureMark(line.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', line.name);
  label.title = [line.tip, `${line.relPath}\n点击打开这条线的文件`].filter(Boolean).join('\n\n');
  // 单击开成临时标签，双击转正（见章节那一行）。
  label.addEventListener('click', (e) => openPath(line.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', line.detail));
  appendWarnings(row, line.warnings);

  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(line.relPath) },
    ...overviewItems(tree, line.relPath),
    ...endingItems(line),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 「标为收束」「标为放弃」：进行中的两样都给，计划中的只给放弃（还没发生过事，谈不上收束），收束、放弃了的不给。 */
function endingItems(line: ThreadLineView): MenuItem[] {
  if (line.status === '已收束' || line.status === '已放弃') {
    return [];
  }
  return [
    { sep: true },
    ...(line.status === '进行中' ? [{ label: '标为收束…', run: () => projectAction('closeThread', line.relPath) }] : []),
    { label: '标为放弃…', run: () => projectAction('abandonThread', line.relPath) },
  ];
}

/** 「未归属的伏笔 · N 条」：挂不上哪条线的伏笔。作者把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。 */
function buildUnfiledRow(tree: ProjectTree, u: ThreadUnfiledView): HTMLElement {
  const row = mk('div', 'row row-thread row-thread-unfiled');
  row.style.paddingLeft = `${indentOf(0)}px`;
  row.appendChild(mk('span', 'dot', '◇'));

  const mark = failureMark(u.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', '未归属的伏笔');
  label.title = `${u.relPath}\n挂不上哪一条线的伏笔。把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。`;
  label.addEventListener('click', (e) => openPath(u.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', u.detail));
  appendWarnings(row, u.warnings);

  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(u.relPath) },
    ...overviewItems(tree, u.relPath),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** ⚠ 一句一格，不截断：几条线里扫一眼要看的就是这个。 */
function appendWarnings(row: HTMLElement, warnings: readonly string[]): void {
  for (const w of warnings) {
    row.appendChild(mk('span', 'meta thread-warn', `⚠ ${w}`));
  }
}
