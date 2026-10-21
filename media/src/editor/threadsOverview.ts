/**
 * 编辑区「叙事线总览」标签（叙事线重做三期，设计见 docs/design/plans/2026-10-20-narrative-threads.md「八」）：章 × 线的
 * 时间轴，作者一眼看出每条线走到哪、哪条伏笔该收了、计划的事哪一章没发生。
 *
 * - **一个不对应文件的特殊标签**（`store.ts` 的 `SpecialTab`）：标签条上排在文件标签前面，切过去时这一块没有当前文件，
 *   画的东西照历史版本抽屉（`versions.ts`）的做法挂在这一块的 `.ed-stage` 上、盖住正文区。同一时刻只开在一块里（缺省主区）。
 *   刷新记着、恢复时先于文件打开（`store.ts` 的 `restore`），记坏了的不认、不崩。
 * - **数据按需要**（仿「转到…」）：显示出来时发 `requestThreadsOverview { requestId }`，后端回 `threadsOverview`
 *   （`core/views/threads.ts` 的 `buildThreadsOverview`：纯读盘、不调模型、状态现算）；认 requestId（回复是广播）。显示着
 *   收到 `state` / `init`（磁盘上变过）停一下再要一次；藏着时只记一笔「过期」，下次显示再要。不进 `ProjectTree`。
 * - **画法**：横轴是章（列头标章号、分卷的书多一行卷名，列头的样子说这一章定稿没有），一条竖线标「定稿到第 N 章」；纵轴
 *   按种类分组，每条线下面缩进列它的伏笔，最后是「未归属的伏笔」。线的格子 ○ 只有计划、● 只有实际、◉ 计划也发生了、
 *   红圈是计划了那一章也定稿了却没发生（偏差）；伏笔一行埋 ● 到收 ◆ 连线、没收的虚线延到回收章（那一格一道竖线）、
 *   还没埋的按计划淡虚线，逾期标红、弃画 ✕，计划的埋与收画空心。圆点借流水线条的 `pstage-mark`。连线、偏差、状态
 *   都是后端算好的，这里只画。左列（线名、伏笔名）与表头固定（`position: sticky`），横向滚动；格子是稀疏的，一行只
 *   画有事件的那几章，几千章也画得动。
 * - **交互**：悬停格子看那几条事件与证据；点格子、点列头打开那一章（`openChapter`：正文进主区、细纲并排，还没写的打开细纲）；
 *   点线名、伏笔名、「未归属的伏笔」打开那份文件（开在总览所在的这一块）。
 * - **入口**：工程页「叙事线」页签标题旁的「总览」与右键「在总览里看」（经 `nf-threads-command`，带 `focus` 就定位到那一行）。
 *   工程页先问 `nf-threads-query` 有没有人画得了——只有这个模块回答，插件形态没有 editor.js，入口就不画（能力探测）。
 *
 * 用户内容一律 `textContent`。样式在 `css/standalone/threads.css`。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import type { ThreadsOverviewCommand } from '../globals';
import type {
  InMessage,
  OutMessage,
  ThreadsOverview,
  ThreadsOverviewCell,
  ThreadsOverviewChapter,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewLine,
} from '../protocol';
import { onMessage } from '../vscodeApi';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';

/** 特殊标签的 id（记进 localStorage）。 */
export const THREADS_OVERVIEW_TAB = 'threads-overview';

/** 一列多宽、左列多宽（px）。CSS 经 `--tov-cell` / `--tov-name` 拿同一个数。 */
const CELL = 24;
const NAME_WIDTH = 220;
/** 显示着时收到 `state` 之后停多久再要一次（作者连着存几次只要一次）。 */
const REFRESH_DELAY_MS = 600;

const TITLE = '叙事线总览';
const TAB_TIP = '叙事线总览：章 × 线的时间轴——每条线走到哪、伏笔埋了收了没有、计划的事哪一章没发生。现算，不调模型。';
const NO_WORKSPACE = '先打开一个小说工程，才有叙事线总览。';

const STATE_LABEL: Record<ThreadsOverviewChapter['state'], string> = {
  finalized: '已定稿',
  written: '写了，还没定稿',
  planned: '只有细纲',
  none: '还没有细纲',
};

/** 线名前的状态点（同工程页那一行）。 */
const STATUS_DOT: Record<ThreadsOverviewLine['status'], string> = { 进行中: '●', 计划中: '○', 已收束: '✓', 已放弃: '✕' };

interface View {
  root: HTMLElement;
  meta: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
  tip: HTMLElement;
}

/** 一格悬停时要说的。 */
interface CellInfo {
  row: string;
  cell: ThreadsOverviewCell;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 显示在哪一块。 */
let host: Pane | undefined;
let data: ThreadsOverview | undefined;
/** 在路上的那一次请求。 */
let waiting: string | undefined;
/** 拿到这一份之后磁盘上变过（或从没拿过）：下次显示时再要。 */
let stale = true;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** 定位到的那一行（一条线、或「未归属的伏笔」那份文件的路径）：一直标着，换了数据重画也标着。 */
let focused: string | undefined;
/** 定位之后还没滚过去（数据到了、画好了才滚，滚一次）。 */
let scrollPending = false;
const cellInfo = new WeakMap<HTMLElement, CellInfo>();

// ---------------------------------------------------------------- 装

export function installThreadsOverview(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: THREADS_OVERVIEW_TAB,
    label: () => ({ title: TITLE, tip: TAB_TIP }),
    show,
    hide,
    menu: () => [{ label: '刷新', run: () => request() }],
  });

  // 工程页问「画得了吗」：只有装了编辑器（独立版、桌面版）才有人回答（能力探测）。
  window.addEventListener('nf-threads-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-threads-command', (e) => openOverview(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    // 标签由 index.ts 一并关掉；这里丢掉上一个工程的数据。
    data = undefined;
    waiting = undefined;
    stale = true;
    focused = undefined;
    scrollPending = false;
    clearTimeout(refreshTimer);
    if (view) {
      view.scroll.replaceChildren();
      hideTip();
    }
  });

  onMessage((msg: OutMessage) => {
    if (msg.type === 'threadsOverview') {
      if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
        return;
      }
      waiting = undefined;
      data = msg.overview;
      stale = false;
      render();
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁盘上可能变过（保存、定稿、拆细纲……）。显示着就停一下再要一次，藏着就等下次显示。
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

/** 打开总览（已经开着就切过去）；`focus` 给了就定位到那一行。 */
function openOverview(cmd: ThreadsOverviewCommand | undefined): void {
  if (document.body.classList.contains('no-workspace')) {
    toast(NO_WORKSPACE);
    return;
  }
  const pane = paneWithSpecial(THREADS_OVERVIEW_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  if (cmd?.focus) {
    focused = cmd.focus;
    scrollPending = true;
  }
  // 作者点了「总览」就是要看现在的样子：开着也再要一次。
  stale = true;
  pane.openSpecial(THREADS_OVERVIEW_TAB);
  if (data) {
    applyFocus();
  }
  revealEditor();
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === THREADS_OVERVIEW_TAB;
}

function request(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  clearTimeout(refreshTimer);
  waiting = newRequestId('threads');
  post({ type: 'requestThreadsOverview', requestId: waiting });
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
  hideTip();
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'tov hidden');
  root.setAttribute('aria-label', TITLE);
  const head = el('div', 'tov-head');
  head.appendChild(el('span', 'tov-title', TITLE));
  const meta = el('span', 'tov-meta');
  head.appendChild(meta);
  head.appendChild(legend());
  head.appendChild(el('span', 'spacer'));
  const refresh = el('button', 'chip-btn tov-refresh', '刷新');
  refresh.type = 'button';
  refresh.title = '照磁盘上现在的叙事线与章节重画（不调模型）';
  refresh.addEventListener('click', () => request());
  head.appendChild(refresh);
  const note = el('p', 'hint tov-note hidden');
  const scroll = el('div', 'tov-scroll');
  scroll.style.setProperty('--tov-cell', `${CELL}px`);
  scroll.style.setProperty('--tov-name', `${NAME_WIDTH}px`);
  const tip = el('div', 'tov-tip hidden');
  tip.setAttribute('role', 'tooltip');
  root.append(head, note, scroll, tip);

  scroll.addEventListener('click', onClick);
  scroll.addEventListener('mouseover', onOver);
  scroll.addEventListener('mouseout', onOut);
  scroll.addEventListener('scroll', hideTip);
  view = { root, meta, note, scroll, tip };
  return view;
}

/** 图例：线的四种格子、伏笔的几样记号。 */
function legend(): HTMLElement {
  const box = el('span', 'tov-legend');
  const item = (mark: HTMLElement, text: string): void => {
    const span = el('span', 'tov-legend-item');
    span.append(mark, el('span', undefined, text));
    box.appendChild(span);
  };
  item(lineMark('plan'), '只有计划');
  item(lineMark('actual'), '只有实际');
  item(lineMark('both'), '计划也发生了');
  item(lineMark('dev'), '计划了、定稿了却没发生');
  box.appendChild(el('span', 'tov-legend-sep', '·'));
  item(foreMark('埋', false), '埋');
  item(foreMark('收', false), '收');
  item(foreMark('弃', false), '弃');
  const dashed = el('span', 'tov-legend-dash');
  item(dashed, '没收（到回收章）');
  return box;
}

type LineMarkKind = 'plan' | 'actual' | 'both' | 'dev';

/** 线的格子：○ 只有计划、● 只有实际、◉ 计划也发生了、红圈偏差。借流水线条的 `pstage-mark`。 */
function lineMark(kind: LineMarkKind): HTMLElement {
  const filled = kind === 'actual' || kind === 'both';
  const mark = el('span', `pstage-mark tov-mark tov-mark-${kind}${filled ? ' done' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function lineMarkKind(cell: ThreadsOverviewCell): LineMarkKind {
  if (cell.deviation) {
    return 'dev';
  }
  if (cell.actual.length === 0) {
    return 'plan';
  }
  return cell.planned.length > 0 ? 'both' : 'actual';
}

/** 伏笔的记号：埋 ●、收 ◆、弃 ✕；计划的（还没发生的）画空心 ○ / ◇。 */
function foreMark(type: '埋' | '收' | '弃', planned: boolean): HTMLElement {
  if (type === '弃') {
    const mark = el('span', 'tov-fmark tov-fmark-drop', '✕');
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  const shape = type === '埋' ? `pstage-mark tov-fmark tov-fmark-plant${planned ? '' : ' done'}` : 'tov-fmark tov-fmark-resolve';
  const mark = el('span', `${shape}${planned ? ' tov-fmark-plan' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/** 一格伏笔画哪个记号：实际的先（弃 → 收 → 埋），没有实际的画计划的（收 → 埋）。 */
function foreMarkOf(cell: ThreadsOverviewCell): HTMLElement {
  const actual = new Set(cell.actual.map((e) => e.type));
  const planned = new Set(cell.planned.map((e) => e.type));
  const type: '埋' | '收' | '弃' = actual.has('弃')
    ? '弃'
    : actual.has('收')
      ? '收'
      : actual.has('埋')
        ? '埋'
        : planned.has('收') || planned.has('弃')
          ? '收'
          : '埋';
  const mark = foreMark(type, actual.size === 0);
  if (cell.deviation) {
    mark.classList.add('tov-mark-dev');
  }
  return mark;
}

// ---------------------------------------------------------------- 画

function render(): void {
  const v = ensureView();
  hideTip();
  v.scroll.replaceChildren();
  if (!data) {
    v.meta.textContent = '';
    showNote(document.body.classList.contains('no-workspace') ? NO_WORKSPACE : '正在读取叙事线…');
    return;
  }
  if (!data.initialized) {
    v.meta.textContent = '';
    showNote('这个目录还不是小说工程（没有 .novelforge/），没有叙事线。');
    return;
  }
  const lineCount = data.groups.reduce((n, g) => n + g.lines.length, 0);
  const foreCount =
    data.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.foreshadowing.length, 0), 0) +
    (data.unfiled?.foreshadowing.length ?? 0);
  v.meta.textContent = [
    data.current > 0 ? `定稿到第 ${data.current} 章` : '还没有定稿的章',
    `${lineCount} 条线`,
    foreCount > 0 ? `${foreCount} 条伏笔` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (lineCount === 0 && !data.unfiled) {
    showNote(
      '还没有叙事线。到工程页「叙事线」页签点「从大纲排出」，从情节大纲排出主线、支线、感情线、人物线；定稿时也会从正文里认出新的线。'
    );
    return;
  }
  const notes: string[] = [];
  if (data.chapters.length === 0) {
    notes.push('还没有章节：排出细纲、写了正文之后，这里按章画出每条线走到哪。');
  }
  if (data.clippedFrom !== undefined) {
    notes.push(
      `计划里提到了第 ${data.clippedFrom} 章，太远了，只画到第 ${data.chapters.length} 章（多半是哪一处章号写错了：线的 plan、伏笔的回收章或某条事件）。`
    );
  }
  showNote(notes.join(''));
  v.scroll.appendChild(buildGrid(data));
  applyFocus();
}

function showNote(text: string): void {
  if (!view) {
    return;
  }
  view.note.textContent = text;
  setHidden(view.note, !text);
}

function buildGrid(d: ThreadsOverview): HTMLElement {
  const cols = d.chapters.length;
  const grid = el('div', 'tov-grid');
  grid.style.width = `${NAME_WIDTH + cols * CELL}px`;
  grid.appendChild(buildHeader(d));
  for (const group of d.groups) {
    grid.appendChild(groupRow(group.kind, `${group.lines.length} 条`));
    for (const line of group.lines) {
      grid.appendChild(lineRow(line, cols));
      for (const f of line.foreshadowing) {
        grid.appendChild(foreRow(f, line.relPath, cols, d));
      }
    }
  }
  if (d.unfiled) {
    const head = groupRow('未归属的伏笔', `${d.unfiled.foreshadowing.length} 条`, d.unfiled.relPath);
    grid.appendChild(head);
    for (const f of d.unfiled.foreshadowing) {
      grid.appendChild(foreRow(f, d.unfiled.relPath, cols, d));
    }
  }
  // 「定稿到第 N 章」：一条竖线画在第 N 章右边。
  if (d.current > 0 && d.current <= cols) {
    const now = el('div', 'tov-now');
    now.style.left = `${NAME_WIDTH + d.current * CELL}px`;
    now.title = `定稿到第 ${d.current} 章`;
    grid.appendChild(now);
  }
  return grid;
}

/** 表头：左上角一格，右边一行卷名（分卷的书）、一行章号。 */
function buildHeader(d: ThreadsOverview): HTMLElement {
  const head = el('div', 'tov-header');
  const corner = el('div', 'tov-corner', '叙事线 ＼ 章');
  corner.title = d.current > 0 ? `绿线：定稿到第 ${d.current} 章` : '还没有定稿的章';
  head.appendChild(corner);
  const cols = el('div', 'tov-cols');
  cols.style.width = `${d.chapters.length * CELL}px`;
  if (d.volumes) {
    const row = el('div', 'tov-vols');
    let start = 0;
    for (let i = 1; i <= d.chapters.length; i++) {
      if (i === d.chapters.length || d.chapters[i].volume !== d.chapters[start].volume) {
        const name = d.chapters[start].volume;
        const vol = el('div', `tov-vol${name ? '' : ' tov-vol-root'}`, name);
        vol.style.left = `${start * CELL}px`;
        vol.style.width = `${(i - start) * CELL}px`;
        vol.title = name ? `${name}：第 ${d.chapters[start].no}–${d.chapters[i - 1].no} 章` : '';
        row.appendChild(vol);
        start = i;
      }
    }
    cols.appendChild(row);
    head.classList.add('tov-header-vols');
  }
  const nums = el('div', 'tov-nums');
  for (const c of d.chapters) {
    const col = el('div', `tov-col tov-col-${c.state}${c.no === d.current ? ' tov-col-now' : ''}${c.no >= 1000 ? ' tov-col-wide' : ''}`, String(c.no));
    col.style.left = `${(c.no - 1) * CELL}px`;
    col.dataset.ch = String(c.no);
    col.title = chapterTitle(c);
    nums.appendChild(col);
  }
  cols.appendChild(nums);
  head.appendChild(cols);
  return head;
}

function chapterTitle(c: ThreadsOverviewChapter): string {
  const name = `第 ${c.no} 章${c.title ? `《${c.title}》` : ''}`;
  const where = c.volume ? ` · ${c.volume}` : '';
  const open = c.chapterPath ? '点击打开正文' : c.plotPath ? '点击打开细纲' : '';
  return `${name}${where} · ${STATE_LABEL[c.state]}${open ? `\n${open}` : ''}`;
}

function rowShell(cls: string, cols: number): { row: HTMLElement; name: HTMLElement; track: HTMLElement } {
  const row = el('div', `tov-row ${cls}`);
  const name = el('div', 'tov-name');
  const track = el('div', 'tov-track');
  track.style.width = `${cols * CELL}px`;
  row.append(name, track);
  return { row, name, track };
}

/** 种类那一行（「主线 · 1 条」），「未归属的伏笔」那一行也是它（带路径，点名字打开那份文件）。 */
function groupRow(label: string, count: string, relPath?: string): HTMLElement {
  const row = el('div', 'tov-row tov-row-group');
  const name = el('div', 'tov-name');
  if (relPath) {
    const link = el('span', 'tov-link', label);
    link.dataset.path = relPath;
    link.title = `${relPath}\n挂不上哪一条线的伏笔。点击打开这份文件；把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。`;
    name.appendChild(link);
    row.dataset.path = relPath;
  } else {
    name.appendChild(el('span', 'tov-group-name', label));
  }
  name.appendChild(el('span', 'tov-count', count));
  row.appendChild(name);
  return row;
}

function lineRow(line: ThreadsOverviewLine, cols: number): HTMLElement {
  const closed = line.status === '已收束' || line.status === '已放弃';
  const { row, name, track } = rowShell(`tov-row-line${closed ? ' tov-row-closed' : ''}`, cols);
  row.dataset.path = line.relPath;
  const dot = el('span', 'tov-dot', STATUS_DOT[line.status]);
  dot.title = line.status;
  name.appendChild(dot);
  const link = el('span', 'tov-link', line.name);
  link.dataset.path = line.relPath;
  link.title = [line.detail, ...line.warnings.map((w) => `⚠ ${w}`), line.tip, `${line.relPath}\n点击打开这条线的文件`]
    .filter(Boolean)
    .join('\n');
  name.appendChild(link);
  if (line.warnings.length > 0) {
    const warn = el('span', 'tov-warn', '⚠');
    warn.title = line.warnings.join('\n');
    name.appendChild(warn);
  }

  // 计划区间：一条淡底（只写了开头的延到最后一列，只写了收束章的从第 1 章起）。
  if (line.from !== undefined || line.to !== undefined) {
    const from = Math.max(1, line.from ?? 1);
    const to = Math.min(cols, line.to ?? cols);
    if (from <= to) {
      const band = el('div', 'tov-band');
      band.style.left = `${(from - 1) * CELL}px`;
      band.style.width = `${(to - from + 1) * CELL}px`;
      band.title = line.from !== undefined && line.to !== undefined
        ? `计划第 ${line.from}–${line.to} 章`
        : line.from !== undefined
          ? `计划第 ${line.from} 章起`
          : `计划第 ${line.to} 章收`;
      track.appendChild(band);
    }
  }
  for (const cell of line.cells) {
    track.appendChild(cellEl(cell, line.name, lineMark(lineMarkKind(cell))));
  }
  return row;
}

function foreRow(f: ThreadsOverviewForeshadow, relPath: string, cols: number, d: ThreadsOverview): HTMLElement {
  const closed = f.status === '已收' || f.status === '已弃';
  const { row, name, track } = rowShell(
    `tov-row-fore${closed ? ' tov-row-closed' : ''}${f.overdue ? ' tov-row-overdue' : ''}`,
    cols
  );
  const link = el('span', 'tov-link', f.name);
  link.dataset.path = relPath;
  link.title = [f.tip, '点击打开它所在的文件'].filter(Boolean).join('\n');
  name.appendChild(link);
  if (f.overdue) {
    const warn = el('span', 'tov-warn', '⚠');
    warn.title = `过了第 ${f.resolve} 章还没收（逾期）`;
    name.appendChild(warn);
  }

  if (f.span) {
    const span = el('div', `tov-span tov-span-${f.span.kind}${f.overdue ? ' tov-overdue' : ''}`);
    span.style.left = `${(f.span.from - 1) * CELL + CELL / 2}px`;
    span.style.width = `${(f.span.to - f.span.from) * CELL}px`;
    span.title =
      f.span.kind === 'done'
        ? `第 ${f.span.from}–${f.span.to} 章`
        : f.span.kind === 'open'
          ? `第 ${f.span.from} 章埋下，还没收${f.resolve !== undefined ? `（计划第 ${f.resolve} 章前收）` : ''}`
          : `计划第 ${f.span.from} 章埋、第 ${f.span.to} 章前收`;
    track.appendChild(span);
  }
  // 回收章：没收的伏笔在它那一格画一道竖线（逾期的标红）。
  if (!closed && f.resolve !== undefined && f.resolve <= cols) {
    const due = el('div', `tov-due${f.overdue ? ' tov-overdue' : ''}`);
    due.style.left = `${(f.resolve - 1) * CELL + CELL / 2}px`;
    due.title = `计划第 ${f.resolve} 章前收${f.overdue ? `——现在第 ${d.current} 章，逾期` : ''}`;
    track.appendChild(due);
  }
  for (const cell of f.cells) {
    track.appendChild(cellEl(cell, f.name, foreMarkOf(cell)));
  }
  return row;
}

function cellEl(cell: ThreadsOverviewCell, rowName: string, mark: HTMLElement): HTMLElement {
  const node = el('span', `tov-cell${cell.deviation ? ' tov-cell-dev' : ''}`);
  node.style.left = `${(cell.chapter - 1) * CELL}px`;
  node.dataset.ch = String(cell.chapter);
  node.appendChild(mark);
  cellInfo.set(node, { row: rowName, cell });
  return node;
}

// ---------------------------------------------------------------- 定位

/** 定位到的那一行标出来；刚定位、还没滚过的滚过去（滚一次）。 */
function applyFocus(): void {
  if (!view || !focused) {
    return;
  }
  let target: HTMLElement | undefined;
  for (const row of view.scroll.querySelectorAll<HTMLElement>('.tov-row')) {
    const hit = row.dataset.path === focused;
    row.classList.toggle('tov-focus', hit);
    if (hit && !target) {
      target = row;
    }
  }
  if (target && scrollPending) {
    scrollPending = false;
    const header = view.scroll.querySelector<HTMLElement>('.tov-header');
    view.scroll.scrollTop = Math.max(0, target.offsetTop - (header?.offsetHeight ?? 0) - 4);
  }
}

// ---------------------------------------------------------------- 交互

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const link = target?.closest<HTMLElement>('.tov-link');
  if (link?.dataset.path) {
    // 打开那份文件，开在总览所在的这一块（正常标签：作者明说要看它）。
    post({ type: 'openEditor', path: link.dataset.path, pane: host?.id ?? 'main' });
    return;
  }
  const chapter = target?.closest<HTMLElement>('.tov-cell, .tov-col');
  if (chapter?.dataset.ch) {
    openChapter(Number(chapter.dataset.ch));
  }
}

/** 打开那一章：正文进主区、细纲并排（`openChapter`，同工程页点章节行）；还没写的打开细纲。 */
function openChapter(no: number): void {
  const c = data?.chapters[no - 1];
  const path = c?.chapterPath ?? c?.plotPath;
  if (!path) {
    toast(`第 ${no} 章还没有细纲，也没有正文。`);
    return;
  }
  post({ type: 'openChapter', plotRelPath: path });
}

function onOver(e: MouseEvent): void {
  const node = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tov-cell');
  if (!node) {
    return;
  }
  const info = cellInfo.get(node);
  if (info) {
    showTip(node, info);
  }
}

function onOut(e: MouseEvent): void {
  const from = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tov-cell');
  const to = (e.relatedTarget as HTMLElement | null)?.closest?.('.tov-cell');
  if (from && from !== to) {
    hideTip();
  }
}

/** 悬停一格：第几章、哪一行、计划的与实际的事件（带证据）、偏差说一句。 */
function showTip(node: HTMLElement, info: CellInfo): void {
  if (!view) {
    return;
  }
  const tip = view.tip;
  tip.replaceChildren();
  const c = data?.chapters[info.cell.chapter - 1];
  const head = c ? `第 ${c.no} 章${c.title ? `《${c.title}》` : ''} · ${STATE_LABEL[c.state]}` : `第 ${info.cell.chapter} 章`;
  tip.appendChild(el('div', 'tov-tip-head', head));
  tip.appendChild(el('div', 'tov-tip-row-name', info.row));
  for (const e of info.cell.planned) {
    tip.appendChild(eventLine(e, true));
  }
  for (const e of info.cell.actual) {
    tip.appendChild(eventLine(e, false));
  }
  if (info.cell.deviation) {
    tip.appendChild(el('div', 'tov-tip-dev', '⚠ 计划了，这一章也定稿了，却没有发生'));
  }
  setHidden(tip, false);
  const rect = node.getBoundingClientRect();
  const width = tip.offsetWidth || 280;
  const height = tip.offsetHeight || 0;
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const top = height > 0 && below + height > window.innerHeight - 4 ? Math.max(4, rect.top - height - 4) : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function eventLine(e: ThreadsOverviewEvent, planned: boolean): HTMLElement {
  const line = el('div', `tov-tip-ev${planned ? ' tov-tip-plan' : ''}`);
  const label = `${planned ? '计划 · ' : ''}${e.type}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}：`;
  line.appendChild(el('span', 'tov-tip-type', label));
  line.appendChild(el('span', undefined, e.what));
  if (e.evidence) {
    line.appendChild(el('div', 'tov-tip-evidence', `「${e.evidence}」`));
  }
  return line;
}

function hideTip(): void {
  if (view) {
    setHidden(view.tip, true);
  }
}
