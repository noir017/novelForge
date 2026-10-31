/**
 * 编辑区「时间线总览」标签（2026-10-24，设计稿 docs/design/plans/2026-10-24-timeline-page.md）：竖着按故事里的日子排，一个日子一行、
 * 那一天开头的几章一章一张卡片，作者一眼看出故事里谁先谁后、隔了多久、这一章在各条线上发生了什么、哪里对不上。
 *
 * - **一个不对应文件的特殊标签**（同「叙事线总览」，`store.ts` 的 `SpecialTab`）：挂在这一块的 `.ed-stage` 上、盖住正文区，同一时刻只开在
 *   一块里（缺省主区）。只在独立版、桌面版有：工程页先问 `nf-timeline-query` 有没有人画得了，插件形态没有 editor.js，没人回答（能力探测）。
 * - **数据按需要**：显示出来时发 `requestTimelineOverview`，后端回 `timelineOverview`（`core/views/timeline.ts` 的 `buildTimelineMatrix`：
 *   纯读盘、不调模型、日期与对账现算）；认 requestId（回复是广播）。显示着收到 `state` / `init` 停一下再要一次；藏着只记一笔「过期」。
 * - **画法**：月份变了插一行（`大衍三年三月 · 春`）；一个日子一行——左边那一天（大字日子、小字第几天），中间一条竖轴一个点，右边卡片；
 *   相邻两个日子之间空了 2 天以上插一行「N 天后」（照上一行里最晚的结尾算；只压空白、不按比例，⚑2）。卡片：状态点、章号章名、时段与
 *   比上一章、依据，这一章在各条线上实际发生的事（线名是带色块的小标签，收着时最多 3 条，⚑3），没有事件时是细纲梗概，对账报了的红字；
 *   回忆的章虚线框、缩进（⚑5）。
 * - **交互**：单击卡片展开 / 收起详情（同时选中）；右键卡片改时间、重推、打开正文 / 细纲 / 时间线文件；右键标题栏与空白处改历法与起点、
 *   填为起点、补推、重推、打开文件、刷新（⚑7：设置都在右键，标题栏上只有筛选与刷新）。改时间、重推走工程页同一个 `projectAction`，后端照旧
 *   先问。筛选「只看有问题的」「线」只在前端，不记住。
 * - **入口**：工程页「时间线」组标题旁的「总览」、点一章、点一条带章号的 ⚠（`nf-timeline-command`，带 `chapter` 就展开那一张、滚过去）。
 *
 * 用户内容一律 `textContent`。样式在 `css/standalone/timeline.css`。
 */
import { el, setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem, TimelineOverviewCommand } from '../globals';
import type { InMessage, OutMessage, ProjectAction, TimelineOverview, TimelineOverviewCard, TimelineOverviewDay, TimelineOverviewEvent } from '../protocol';
import { onMessage } from '../vscodeApi';
import { openChapterMessage } from '../narrow';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';

/** 特殊标签的 id（记进 localStorage）。 */
export const TIMELINE_OVERVIEW_TAB = 'timeline-overview';

/** 显示着时收到 `state` 之后停多久再要一次（作者连着存几次只要一次）。 */
const REFRESH_DELAY_MS = 600;
/** 卡片收着时最多列几条事件（⚑3）。 */
const CARD_EVENTS = 3;
/** 相邻两个日子差几天起插一行「N 天后」（次日不画：日子变了一眼看得出）。 */
const GAP_DAYS = 2;

const TITLE = '时间线总览';
const TAB_TIP = '时间线总览：竖着按故事里的日子排，一章一张卡片——哪天、隔了多久、这一章在各条线上发生了什么、哪里对不上。现算，不调模型。';
const NO_WORKSPACE = '先打开一个小说工程，才有时间线总览。';

/** 状态点（同工程页「时间线」组那一行）。 */
const STATE_DOT: Record<TimelineOverviewCard['state'], string> = {
  evidence: '●',
  guess: '○',
  unknown: '?',
  missing: '·',
  anchor: '★',
  dated: '◆',
  flashback: '↺',
  bad: '✕',
};

const STATE_LABEL: Record<TimelineOverviewCard['state'], string> = {
  evidence: '有原文依据',
  guess: '推测的',
  unknown: '推不出',
  missing: '还没推',
  anchor: '你定的',
  dated: '正文写明了日子',
  flashback: '整章是回忆',
  bad: '那一行认不出',
};

interface View {
  root: HTMLElement;
  meta: HTMLElement;
  problems: HTMLInputElement;
  thread: HTMLSelectElement;
  issues: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 显示在哪一块。 */
let host: Pane | undefined;
let data: TimelineOverview | undefined;
/** 在路上的那一次请求。 */
let waiting: string | undefined;
/** 拿到这一份之后磁盘上变过（或从没拿过）：下次显示时再要。 */
let stale = true;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** 展开着的卡片（章号）；换了数据重画也展开着。 */
const expanded = new Set<number>();
/** 选中的那一张（最近点过、或从工程页定位过来的）。 */
let selected: number | undefined;
/** 定位之后还没滚过去的那一章（数据到了、画好了才滚，滚一次）。 */
let scrollTo: number | undefined;
/** 筛选：只看有问题的、只看某条线（空串是全部）。 */
let onlyProblems = false;
let threadFilter = '';

// ---------------------------------------------------------------- 装

export function installTimelineOverview(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: TIMELINE_OVERVIEW_TAB,
    label: () => ({ title: TITLE, tip: TAB_TIP }),
    show,
    hide,
    menu: () => [{ label: '刷新', run: () => request() }],
  });

  // 工程页问「画得了吗」：只有装了编辑器（独立版、桌面版）才有人回答（能力探测）。
  window.addEventListener('nf-timeline-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-timeline-command', (e) => openOverview(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    // 标签由 index.ts 一并关掉；这里丢掉上一个工程的数据与筛选。
    data = undefined;
    waiting = undefined;
    stale = true;
    expanded.clear();
    selected = undefined;
    scrollTo = undefined;
    onlyProblems = false;
    threadFilter = '';
    clearTimeout(refreshTimer);
    if (view) {
      view.scroll.replaceChildren();
      view.issues.replaceChildren();
    }
  });

  onMessage((msg: OutMessage) => {
    if (msg.type === 'timelineOverview') {
      if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
        return;
      }
      waiting = undefined;
      data = msg.overview;
      stale = false;
      render();
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁盘上可能变过（同步、补推、改时间……）。显示着就停一下再要一次，藏着就等下次显示。
      stale = true;
      if (visible()) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (visible() && stale && !waiting) {
            request();
          }
        }, REFRESH_DELAY_MS);
      }
    }
  });
}

/** 打开总览（已经开着就切过去）；`chapter` 给了就展开那一张、滚过去。 */
function openOverview(cmd: TimelineOverviewCommand | undefined): void {
  if (document.body.classList.contains('no-workspace')) {
    toast(NO_WORKSPACE);
    return;
  }
  const pane = paneWithSpecial(TIMELINE_OVERVIEW_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  if (cmd?.chapter !== undefined) {
    expanded.add(cmd.chapter);
    selected = cmd.chapter;
    scrollTo = cmd.chapter;
  }
  // 作者点了就是要看现在的样子：开着也再要一次。
  stale = true;
  pane.openSpecial(TIMELINE_OVERVIEW_TAB);
  if (data) {
    render();
  }
  revealEditor();
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === TIMELINE_OVERVIEW_TAB;
}

function request(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  clearTimeout(refreshTimer);
  waiting = newRequestId('timeline');
  post({ type: 'requestTimelineOverview', requestId: waiting });
  if (!data) {
    render();
  }
}

// ---------------------------------------------------------------- 显示与收起（SpecialTab）

function show(pane: Pane): void {
  const stage = pane.root.querySelector<HTMLElement>('.ed-stage');
  if (!stage) {
    return;
  }
  const v = ensureView();
  if (v.root.parentElement !== stage) {
    stage.appendChild(v.root);
  }
  host = pane;
  setHidden(v.root, false);
  if ((stale || !data) && !waiting) {
    request();
  }
}

function hide(pane: Pane): void {
  if (!view || host !== pane) {
    return;
  }
  setHidden(view.root, true);
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'tlp hidden');
  root.setAttribute('aria-label', TITLE);
  const head = el('div', 'tlp-head');
  head.appendChild(el('span', 'tlp-title', TITLE));
  const meta = el('span', 'tlp-meta');
  head.appendChild(meta);
  head.appendChild(legend());
  head.appendChild(el('span', 'spacer'));

  const problemsLabel = el('label', 'tlp-filter');
  const problems = el('input');
  problems.type = 'checkbox';
  problems.addEventListener('change', () => {
    onlyProblems = problems.checked;
    render();
  });
  problemsLabel.append(problems, el('span', undefined, '只看有问题的'));
  problemsLabel.title = '只留对账报了的章，和推不出、认不出、还没推的章';
  head.appendChild(problemsLabel);

  const thread = el('select', 'tlp-thread');
  thread.title = '只看在这条线上有事发生的章';
  thread.addEventListener('change', () => {
    threadFilter = thread.value;
    render();
  });
  head.appendChild(thread);

  const refresh = el('button', 'chip-btn tlp-refresh', '刷新');
  refresh.type = 'button';
  refresh.title = '照磁盘上现在的时间线与叙事线重画（不调模型）';
  refresh.addEventListener('click', () => request());
  head.appendChild(refresh);

  const issues = el('div', 'tlp-issues hidden');
  const note = el('p', 'hint tlp-note hidden');
  const scroll = el('div', 'tlp-scroll');
  root.append(head, issues, note, scroll);

  scroll.addEventListener('click', onClick);
  // 标题栏、对账、空白处：设置、补推、重推都在这里（⚑7）。卡片自己登记了，右键卡片弹的是卡片那一份。
  onContextMenu(root, pageMenu);
  view = { root, meta, problems, thread, issues, note, scroll };
  return view;
}

/** 图例：几种状态点。 */
function legend(): HTMLElement {
  const box = el('span', 'tlp-legend');
  for (const state of ['evidence', 'guess', 'dated', 'anchor', 'unknown', 'flashback'] as const) {
    const item = el('span', `tlp-legend-item tlp-${state}`);
    item.append(el('span', 'tlp-dot', STATE_DOT[state]), el('span', undefined, STATE_LABEL[state]));
    box.appendChild(item);
  }
  return box;
}

// ---------------------------------------------------------------- 画

function render(): void {
  const v = ensureView();
  const keep = v.scroll.scrollTop;
  v.scroll.replaceChildren();
  v.issues.replaceChildren();
  setHidden(v.issues, true);
  if (!data) {
    v.meta.textContent = '';
    showNote(document.body.classList.contains('no-workspace') ? NO_WORKSPACE : '正在读取时间线…');
    return;
  }
  if (!data.initialized) {
    v.meta.textContent = '';
    showNote('这个目录还不是小说工程（没有 .novelforge/），没有时间线。');
    return;
  }
  v.meta.textContent = data.meta;
  v.meta.title = data.tip;
  for (const issue of data.issues) {
    v.issues.appendChild(issueRow(issue.text, issue.chapter, issue.start));
  }
  setHidden(v.issues, data.issues.length === 0);
  fillThreads(v.thread, data);
  if (data.days.length === 0) {
    syncFilters(v);
    showNote(
      data.missing
        ? `时间线里还没有一章。${data.missing.text}：右键这里「从正文补推故事时间」（先问你，写明调用次数），或到工程页「时间线」组点「补推时间」。`
        : '时间线里还没有一章。同步一章就会推它的故事时间。'
    );
    return;
  }
  // 从工程页定位过来的那一章被筛选藏起来了：筛选放开（作者点的就是要看它）。
  if (scrollTo !== undefined && !data.days.some((d) => d.cards.some((c) => c.no === scrollTo && passes(c)))) {
    onlyProblems = false;
    threadFilter = '';
  }
  syncFilters(v);
  const days = data.days.map((d) => ({ ...d, cards: d.cards.filter(passes) })).filter((d) => d.cards.length > 0);
  if (days.length === 0) {
    showNote('没有符合筛选的章。');
    return;
  }
  showNote('');
  v.scroll.appendChild(buildAxis(days));
  v.scroll.scrollTop = keep;
  applyScroll();
}

function showNote(text: string): void {
  if (!view) {
    return;
  }
  view.note.textContent = text;
  setHidden(view.note, !text);
}

/** 筛选：只看有问题的、只看某条线上有事发生的。 */
function passes(c: TimelineOverviewCard): boolean {
  return (!onlyProblems || c.problem) && (!threadFilter || c.events.some((e) => e.thread === threadFilter));
}

function syncFilters(v: View): void {
  v.problems.checked = onlyProblems;
  v.thread.value = threadFilter;
}

/** 「线」下拉：全部线 + 有实际事件的线（换了数据、那条线不在了就回到全部）。 */
function fillThreads(select: HTMLSelectElement, d: TimelineOverview): void {
  select.replaceChildren();
  const all = el('option', undefined, '全部线');
  all.value = '';
  select.appendChild(all);
  for (const t of d.threads) {
    const opt = el('option', undefined, t.name);
    opt.value = t.name;
    select.appendChild(opt);
  }
  if (!d.threads.some((t) => t.name === threadFilter)) {
    threadFilter = '';
  }
  setHidden(select, d.threads.length === 0);
}

/** 一条 ⚠。带章号的点了展开那一张；说起点的右键改起点、填为起点（标题栏右键也有）。 */
function issueRow(text: string, chapter: number | undefined, start: boolean | undefined): HTMLElement {
  const row = el('div', `tlp-issue${chapter !== undefined ? ' is-link' : ''}`, `⚠ ${text}`);
  if (chapter !== undefined) {
    row.dataset.chapter = String(chapter);
    row.title = `点击展开第 ${chapter} 章`;
    row.addEventListener('click', () => focusChapter(chapter));
  }
  if (start) {
    onContextMenu(row, () => [...startItems(), { sep: true }, ...pageMenu()]);
  }
  return row;
}

/** 竖轴：月份分隔、「N 天后」、一个日子一行。 */
function buildAxis(days: readonly TimelineOverviewDay[]): HTMLElement {
  const axis = el('div', 'tlp-axis');
  let month: string | undefined;
  let reach: number | undefined;
  for (const d of days) {
    // 「N 天后」照上一行里最晚的结尾算（跨了几天的章把它往后推）；回忆那一行（第 0 天）不算。
    if (reach !== undefined && d.day - reach >= GAP_DAYS) {
      axis.appendChild(el('div', 'tlp-gap', `${d.day - reach} 天后`));
    }
    if (d.month && d.month !== month) {
      axis.appendChild(el('div', 'tlp-month', d.season ? `${d.month} · ${d.season}` : d.month));
      month = d.month;
    }
    axis.appendChild(dayRow(d));
    if (d.day > 0) {
      reach = Math.max(reach ?? d.day, d.day, ...d.cards.map((c) => c.end ?? d.day));
    }
  }
  return axis;
}

function dayRow(d: TimelineOverviewDay): HTMLElement {
  const row = el('div', 'tlp-day');
  row.dataset.day = String(d.day);
  const when = el('div', 'tlp-when');
  when.title = d.full;
  when.appendChild(el('div', 'tlp-date', d.label));
  if (d.sub) {
    when.appendChild(el('div', 'tlp-sub', d.sub));
  }
  const rail = el('div', 'tlp-rail');
  rail.appendChild(el('span', 'tlp-node'));
  const cards = el('div', 'tlp-cards');
  for (const c of d.cards) {
    cards.appendChild(cardEl(c));
  }
  row.append(when, rail, cards);
  return row;
}

/** 一章一张卡片：收着时是摘要，展开多一块详情、事件带原文。 */
function cardEl(c: TimelineOverviewCard): HTMLElement {
  const open = expanded.has(c.no);
  const card = el(
    'div',
    `tlp-card tlp-${c.state}${c.flashback ? ' tlp-flashback' : ''}${c.issues.length > 0 ? ' has-issue' : ''}${open ? ' is-open' : ''}${selected === c.no ? ' is-selected' : ''}`
  );
  card.dataset.no = String(c.no);

  const head = el('div', 'tlp-card-head');
  const dot = el('span', 'tlp-dot', STATE_DOT[c.state]);
  dot.title = STATE_LABEL[c.state];
  const title = el('span', 'tlp-card-title', `第 ${c.no} 章${c.title ? ` ${c.title}` : ''}`);
  title.title = open ? '点击收起；右键改时间、重推、打开正文' : '点击展开详情；右键改时间、重推、打开正文';
  head.append(dot, title);
  const time = [c.when, c.delta].filter(Boolean).join(' · ');
  if (time) {
    head.appendChild(el('span', 'tlp-card-time', time));
  }
  card.appendChild(head);
  if (c.note) {
    card.appendChild(el('div', 'tlp-card-note', c.note));
  }
  const events = open ? c.events : c.events.slice(0, CARD_EVENTS);
  if (events.length > 0) {
    const list = el('div', 'tlp-events');
    for (const e of events) {
      list.appendChild(eventEl(e, open));
    }
    card.appendChild(list);
  }
  if (!open && c.events.length > CARD_EVENTS) {
    card.appendChild(el('div', 'tlp-more', `还有 ${c.events.length - CARD_EVENTS} 条，点开看`));
  }
  if (c.synopsis) {
    card.appendChild(el('div', 'tlp-synopsis', c.synopsis));
  }
  for (const issue of c.issues) {
    card.appendChild(el('div', 'tlp-card-issue', `⚠ ${issue}`));
  }
  if (open) {
    const detail = el('div', 'tlp-detail');
    for (const line of c.detail) {
      detail.appendChild(el('div', undefined, line));
    }
    card.appendChild(detail);
  }
  onContextMenu(card, () => cardMenu(c));
  return card;
}

/** 一条事件：线名小标签（色块 + 名字，名字用正文的颜色）、事件；展开时带原文。 */
function eventEl(e: TimelineOverviewEvent, withEvidence: boolean): HTMLElement {
  const row = el('div', 'tlp-event');
  const chip = el('span', `tlp-chip ${e.color >= 0 ? `tlp-c${e.color}` : 'tlp-cx'}`);
  chip.append(el('span', 'tlp-swatch'), el('span', 'tlp-chip-name', e.thread));
  row.appendChild(chip);
  const label = e.foreshadowing ? `${e.type}〈${e.foreshadowing}〉` : e.type === '推进' ? '' : e.type;
  row.appendChild(el('span', 'tlp-event-what', label ? `${label}：${e.what}` : e.what));
  if (withEvidence && e.evidence) {
    row.appendChild(el('div', 'tlp-quote', `「${e.evidence}」`));
  }
  return row;
}

// ---------------------------------------------------------------- 定位与交互

/** 展开那一张、选中、滚过去（从 ⚠ 点过来的）。 */
function focusChapter(no: number): void {
  expanded.add(no);
  selected = no;
  scrollTo = no;
  render();
}

/** 定位过来、还没滚过的滚过去（滚一次），那一张放在上面一点。 */
function applyScroll(): void {
  if (!view || scrollTo === undefined) {
    return;
  }
  const card = view.scroll.querySelector<HTMLElement>(`.tlp-card[data-no="${scrollTo}"]`);
  if (!card) {
    return;
  }
  scrollTo = undefined;
  const top = card.getBoundingClientRect().top - view.scroll.getBoundingClientRect().top;
  view.scroll.scrollTop = Math.max(0, view.scroll.scrollTop + top - 48);
}

/** 单击卡片：展开 / 收起，同时选中。只换这一张（整页重画会丢掉滚动位置）。 */
function onClick(e: MouseEvent): void {
  const node = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tlp-card');
  const no = node?.dataset.no ? Number(node.dataset.no) : undefined;
  const c = no !== undefined ? data?.days.flatMap((d) => d.cards).find((x) => x.no === no) : undefined;
  if (!node || !c || !view) {
    return;
  }
  if (expanded.has(c.no)) {
    expanded.delete(c.no);
  } else {
    expanded.add(c.no);
  }
  selected = c.no;
  for (const other of view.scroll.querySelectorAll('.tlp-card.is-selected')) {
    other.classList.remove('is-selected');
  }
  node.replaceWith(cardEl(c));
}

function act(action: ProjectAction, extra: { name?: string; range?: { from: number; to: number } } = {}): void {
  post({ type: 'projectAction', action, ...extra });
}

function openFile(path: string): void {
  post({ type: 'openEditor', path, pane: host?.id ?? 'main' });
}

/** 改历法与起点、填为起点（标题栏右键与说起点的那条 ⚠）。 */
function startItems(): MenuItem[] {
  const suggestion = data?.calendar.suggestion;
  return [
    { label: '改历法与起点…', run: () => act('setTimelineStart') },
    ...(suggestion ? [{ label: `填为起点「${suggestion.start}」（${suggestion.note}）`, run: () => act('setTimelineStart', { name: suggestion.start }) }] : []),
  ];
}

/** 标题栏与空白处的右键（⚑7）。 */
function pageMenu(): MenuItem[] {
  if (!data?.initialized) {
    return [{ label: '刷新', run: () => request() }];
  }
  const d = data;
  return [
    ...startItems(),
    ...(d.missing ? [{ label: '从正文补推故事时间', run: () => act('backfillTimeline') }] : []),
    ...(d.machine > 0 ? [{ label: `重推机器写的 ${d.machine} 行…`, run: () => act('refreshTimeline') }] : []),
    { sep: true },
    ...(d.exists ? [{ label: '打开时间线文件', run: () => openFile(d.relPath) }] : []),
    { label: '刷新', run: () => request() },
  ];
}

/** 右键一张卡片：改时间、重推（机器写的、还没推的才给「重推这一章」）、打开正文 / 细纲 / 时间线文件。 */
function cardMenu(c: TimelineOverviewCard): MenuItem[] {
  const d = data;
  if (!d) {
    return [];
  }
  return [
    { label: '改时间…', run: () => act('editTimeline', { name: String(c.no) }) },
    ...(c.machine || c.state === 'missing' ? [{ label: '重推这一章', run: () => act('refreshTimeline', { range: { from: c.no, to: c.no } }) }] : []),
    ...(d.last > c.no ? [{ label: `从这一章起重推（到第 ${d.last} 章）`, run: () => act('refreshTimeline', { range: { from: c.no, to: d.last } }) }] : []),
    { sep: true },
    // 正文进主区、细纲并排（同叙事线总览点格子）。
    ...(c.chapterPath ? [{ label: '打开这一章', run: () => post(openChapterMessage(c.chapterPath!)) }] : []),
    ...(c.plotPath ? [{ label: '打开细纲', run: () => openFile(c.plotPath!) }] : []),
    ...(d.exists ? [{ label: '打开时间线文件', run: () => openFile(d.relPath) }] : []),
  ];
}
