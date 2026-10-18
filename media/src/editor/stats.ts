/**
 * 码字统计（独立版内置编辑器，阶段四）的装配：状态栏字数那一格、本次码字、今日码字、「视图 → 统计」那一组的
 * 编辑器一半。口径在 `writingStats.ts`（纯函数），「今日」怎么存在 `statsDaily.ts`，面板在 `statsPanel.ts`。
 *
 * ## 状态栏字数那一格
 *
 * 每块编辑区一格（`#edStatusWords` 与草稿区那一格），`pane.ts` 的 `updateStatus` 调 {@link renderWordStatus}，
 * 别的都是这里自己挂上的：
 *
 * - 全文：「全文 3,120 字」；有选区时前面加「选中 120 字 / 」（口径同 `countWords`）。
 * - 距目标（缺省开）：当前标签是某一章的**正文**、章节索引里这一章有 `targetWords`（细纲的目标字数，没写就是
 *   `config.md` 的每章字数——与写正文时判「写够没有」的是同一个数，后端 `views/pipeline.ts` 算）时，换成
 *   「3,120 / 4,000 字，还差 880」（超了写「超出 120」）＋一条细进度条，到八成换色。字数用编辑区里的当前内容
 *   实时算、不等保存；细纲、草稿、角色卡不显示目标；没写目标、索引里还没有这一章也不显示。
 * - 本次码字 / 今日码字（缺省关）：「· 本次 +356 字」「· 今日 1,820 字」。
 * - 章节（Markdown）开头的「# 标题」那一行不算字数——后端数章节字数就是这么数的（`countWords(stripH1(body))`），
 *   状态栏与工程页、章节条才对得上。
 * - 点一下（或获得焦点时回车 / 空格）弹出码字统计面板。按下鼠标不夺编辑区的焦点。
 *
 * ## 大章节不卡
 *
 * 每敲一下都可能要数一遍全文。做法：
 * 1. `countWords` 一趟循环数完（`words.ts`），不造中间字符串与数组。
 * 2. 每份文件缓存「数过的是哪一份文字、几个字」。打字、上屏、粘贴、程序改写都带着这一处改动（`change`），
 *    核对缓存的正是改动之前那一份，就只数改动那一段（`wordDelta`，英文按词往两边扩到词边界）——几万字的章节
 *    每敲一下也只数几个字。
 * 3. 没有改动可用（撤销 / 重做、输入法组字中途）时整份重数：两万字以内当场数，更长的至多每 300ms 数一次
 *    （其间先显示上一次的数）。
 * 4. 选中字数只数选中的那一段，按（文字、起止）记住，光标挪动不重数。
 * 5. 本次 / 今日码字只看改动那一段，与全文多长无关。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import { onEditorChange } from './api';
import type { EditSource } from './api';
import { chapterAt, onChapterIndex } from './chapterIndex';
import type { EditHistory, TextChange } from './history';
import type { OpenFile } from './paneElements';
import { PREFS_KEY, storedPrefs } from './paragraphState';
import { flushDaily, installDaily, onDailyChange, recordDaily, todayTally } from './statsDaily';
import { closeStatsPanel, refreshStatsPanel, toggleStatsPanel } from './statsPanel';
import type { StatsPanelData } from './statsPanel';
import type { Pane } from './store';
import {
  StepLedger,
  WritingSession,
  countsAsWriting,
  goalProgress,
  headingWords,
  isWritingActivity,
  signedWords,
  wordDelta,
} from './writingStats';
import type { GoalProgress } from './writingStats';
import { countWords, groupDigits } from './words';

/** 这么长以内的文字没有改动可用时当场整份重数；更长的节流。 */
export const SYNC_COUNT_LIMIT = 20_000;
/** 长文字整份重数至多这么久一次。 */
export const RECOUNT_MS = 300;
/** 与 core 的 `isMarkdownExt` 同一组扩展名：只有这些章节认开头的 `# 标题`。 */
const MARKDOWN_RE = /\.(md|markdown)$/i;

// ---------------------------------------------------------------- 偏好

/** 状态栏字数那一格除了全文 / 选中还显示哪几项。按浏览器记在 `novelforge.editor.prefs` 的 `stats` 里。 */
interface StatsPrefs {
  goal: boolean;
  session: boolean;
  today: boolean;
}

let prefs: StatsPrefs = loadPrefs();

function loadPrefs(): StatsPrefs {
  const raw = storedPrefs().stats as Partial<StatsPrefs> | undefined;
  const s = raw && typeof raw === 'object' ? raw : {};
  // 距目标缺省开（只认明明白白的 false）；本次 / 今日缺省关（只认明明白白的 true）。
  return { goal: s.goal !== false, session: s.session === true, today: s.today === true };
}

function setPref(key: keyof StatsPrefs, on: boolean): void {
  prefs = { ...prefs, [key]: on };
  try {
    // 同一个键里还有段落那几项（`paragraphState.ts`）：读出来合上再写。
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...storedPrefs(), stats: prefs }));
  } catch {
    /* 不可写就只在内存里生效 */
  }
  refreshCells();
}

// ---------------------------------------------------------------- 全文字数（带缓存）

interface WordCache {
  /** 数过的是哪一份文字。 */
  text: string;
  words: number;
  /** 上一次整份重数的时刻（节流用）。 */
  countedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const wordCache = new WeakMap<OpenFile, WordCache>();

/** 这份文件（编辑区里的当前内容）一共几个字。 */
function textWords(file: OpenFile): number {
  const cache = wordCache.get(file);
  if (cache && cache.text === file.draft) {
    return cache.words;
  }
  if (!cache || file.draft.length <= SYNC_COUNT_LIMIT) {
    return recount(file);
  }
  scheduleRecount(file, cache);
  return cache.words;
}

function recount(file: OpenFile): number {
  const words = countWords(file.draft);
  const cache = wordCache.get(file);
  if (cache) {
    clearTimeout(cache.timer);
    Object.assign(cache, { text: file.draft, words, countedAt: Date.now(), timer: undefined });
  } else {
    wordCache.set(file, { text: file.draft, words, countedAt: Date.now() });
  }
  return words;
}

function scheduleRecount(file: OpenFile, cache: WordCache): void {
  if (cache.timer !== undefined) {
    return;
  }
  const wait = Math.max(0, cache.countedAt + RECOUNT_MS - Date.now());
  cache.timer = setTimeout(() => {
    cache.timer = undefined;
    if (cache.text !== file.draft) {
      recount(file);
      refreshCells();
      refreshStatsPanel();
    }
  }, wait);
}

/** 内容变了（`edit` 事件）：带着改动、缓存又正是改动之前那一份，就只数改动那一段。 */
function syncWordCache(file: OpenFile, change: TextChange | undefined): void {
  const cache = wordCache.get(file);
  if (!cache || cache.text === file.draft) {
    return;
  }
  if (change) {
    const after = file.draft;
    const tail = change.at + change.inserted.length;
    if (
      cache.text.length === after.length - change.inserted.length + change.removed.length &&
      after.slice(0, change.at) + change.removed + after.slice(tail) === cache.text
    ) {
      cache.text = after;
      cache.words += wordDelta(after, change);
      return;
    }
  }
  if (file.draft.length <= SYNC_COUNT_LIMIT) {
    recount(file);
  } else {
    scheduleRecount(file, cache);
  }
}

/** 章节（Markdown）不算开头的 `# 标题` 那一行——与后端数章节字数同一个数法。 */
function skipsHeading(file: OpenFile): boolean {
  return file.kind === 'chapter' && MARKDOWN_RE.test(file.path);
}

/** 状态栏与面板上说的「全文 N 字」。 */
function fileWords(file: OpenFile): number {
  const words = textWords(file);
  return skipsHeading(file) ? words - headingWords(file.draft) : words;
}

/** 当前标签是某一章的正文、且这一章有目标字数时的进度。 */
function goalOf(file: OpenFile, words: number): GoalProgress | undefined {
  const at = chapterAt(file.path);
  return at && at.side === 'chapter' ? goalProgress(words, at.entry.targetWords) : undefined;
}

// ---------------------------------------------------------------- 选中字数

const selectionMemo = new WeakMap<Pane, { text: string; start: number; end: number; words: number }>();

function selectionWords(pane: Pane, file: OpenFile): number {
  if (pane.isPreviewing() || pane.activeFile() !== file) {
    return 0;
  }
  const { selectionStart: start, selectionEnd: end, value } = pane.area;
  if (start === end) {
    return 0;
  }
  const memo = selectionMemo.get(pane);
  if (memo && memo.start === start && memo.end === end && memo.text === value) {
    return memo.words;
  }
  const words = countWords(value.slice(start, end));
  selectionMemo.set(pane, { text: value, start, end, words });
  return words;
}

// ---------------------------------------------------------------- 本次码字

let session = new WritingSession(Date.now());
/** 每份撤销历史一本账：撤销 / 重做的是哪一步、那一步计入过几个字。重新开始计时就换一批新的。 */
let ledgers = new WeakMap<EditHistory, StepLedger>();

function ledgerOf(history: EditHistory): StepLedger {
  let ledger = ledgers.get(history);
  if (!ledger) {
    ledger = new StepLedger();
    ledgers.set(history, ledger);
  }
  return ledger;
}

/** 明细上怎么称呼这份文件：章节用章节索引的说法，别的用标签上的名字。 */
function titleOf(file: OpenFile): string {
  const at = chapterAt(file.path);
  if (at) {
    return at.side === 'plot' ? `${at.entry.label} · 细纲` : at.entry.label;
  }
  if (file.label) {
    return file.label.tag ? `${file.label.tag} · ${file.label.title}` : file.label.title;
  }
  return file.name;
}

/** 一次内容变化：算这一下码了几个字、记时长，记进本次与今日。 */
function onEdit(file: OpenFile, source: EditSource, change: TextChange | undefined): void {
  syncWordCache(file, change);
  const now = Date.now();
  const ledger = ledgerOf(file.history);
  let words = 0;
  if (source === 'undo') {
    words = ledger.afterUndo(file.history.topId);
  } else if (source === 'redo') {
    words = ledger.afterRedo(file.history.topId);
  } else {
    words = countsAsWriting(source, change) ? wordDelta(file.draft, change!) : 0;
    ledger.afterEdit(file.history.topId, words);
  }
  const title = titleOf(file);
  const ms = isWritingActivity(source) ? session.touch(file.path, title, now) : 0;
  session.add(file.path, title, words);
  recordDaily(now, words, ms);
}

function restart(quiet = false): void {
  session = new WritingSession(Date.now());
  ledgers = new WeakMap();
  refreshCells();
  refreshStatsPanel();
  if (!quiet) {
    toast('本次码字从现在起重新算。');
  }
}

// ---------------------------------------------------------------- 状态栏那一格

interface Cell {
  root: HTMLElement;
  sel: HTMLElement;
  total: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  extra: HTMLElement;
}

const cells = new Map<Pane, Cell>();

function cellOf(root: HTMLElement, pane: Pane): Cell {
  const known = cells.get(pane);
  if (known && known.root === root && known.sel.parentNode === root) {
    return known;
  }
  root.classList.add('ed-words');
  root.setAttribute('role', 'button');
  root.setAttribute('aria-expanded', 'false');
  root.tabIndex = 0;
  const cell: Cell = {
    root,
    sel: el('span', 'ed-words-sel'),
    total: el('span', 'ed-words-total'),
    bar: el('span', 'ed-words-bar hidden'),
    fill: el('span', 'ed-words-fill'),
    extra: el('span', 'ed-words-extra'),
  };
  cell.bar.appendChild(cell.fill);
  root.replaceChildren(cell.sel, cell.total, cell.bar, cell.extra);
  if (known?.root !== root) {
    // 按下鼠标不夺编辑区的焦点（点开面板看一眼，回来接着打字）。
    root.addEventListener('mousedown', (e) => e.preventDefault());
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(root, pane);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel(root, pane);
      }
    });
  }
  cells.set(pane, cell);
  return cell;
}

/**
 * 画一块编辑区状态栏上字数那一格（`pane.ts` 的 `updateStatus` 调；没开文件时传 undefined：清空）。
 * 打字、挪光标、换选区都会调到，所以只用缓存过的数（见文件头「大章节不卡」）。
 */
export function renderWordStatus(root: HTMLElement, pane: Pane, file: OpenFile | undefined): void {
  const cell = cellOf(root, pane);
  if (!file) {
    cell.sel.textContent = '';
    cell.total.textContent = '';
    cell.extra.textContent = '';
    setHidden(cell.bar, true);
    root.title = '';
    return;
  }
  const words = fileWords(file);
  const sel = selectionWords(pane, file);
  const goal = prefs.goal ? goalOf(file, words) : undefined;

  cell.sel.textContent = sel > 0 ? `选中 ${groupDigits(sel)} 字${goal ? ' · ' : ' / '}` : '';
  cell.total.textContent = goal ? `${goal.count}，${goal.rest}` : `全文 ${groupDigits(words)} 字`;
  setHidden(cell.bar, !goal);
  cell.bar.classList.toggle('enough', !!goal?.enough);
  cell.bar.classList.toggle('over', !!goal?.over);
  cell.fill.style.width = goal ? `${Math.min(100, Math.round(goal.ratio * 100))}%` : '0%';

  const extras: string[] = [];
  if (prefs.session) {
    extras.push(`本次 ${signedWords(session.words)} 字`);
  }
  if (prefs.today) {
    extras.push(`今日 ${groupDigits(todayTally(Date.now()).words)} 字`);
  }
  cell.extra.textContent = extras.length ? ` · ${extras.join(' · ')}` : '';

  const tips = [`${groupDigits(file.draft.length)} 字符（含标点与空白）`];
  if (skipsHeading(file)) {
    tips.push('开头的「# 标题」那一行不算字数，与工程页同一个数法');
  }
  if (goal) {
    tips.push(`本章目标 ${groupDigits(goal.target)} 字（细纲的目标字数，没写就是小说配置的每章字数）`);
  }
  tips.push('点一下看码字统计（本次、今日、按文件）');
  root.title = tips.join('\n');
}

/** 两块编辑区的那一格都重画（本次 / 今日码字是全局的，章节索引变了目标可能变）。 */
function refreshCells(): void {
  for (const [pane, cell] of cells) {
    renderWordStatus(cell.root, pane, pane.activeFile());
  }
}

// ---------------------------------------------------------------- 面板

function togglePanel(root: HTMLElement, pane: Pane): void {
  toggleStatsPanel(root, () => panelData(pane), () => restart());
}

function panelData(pane: Pane): StatsPanelData {
  const file = pane.activeFile();
  const today = todayTally(Date.now());
  let info: StatsPanelData['file'];
  if (file) {
    const words = fileWords(file);
    const at = chapterAt(file.path);
    const chapter = at?.side === 'chapter';
    const goal = chapter ? goalOf(file, words) : undefined;
    info = {
      title: titleOf(file),
      path: file.path,
      words,
      chars: file.draft.length,
      goal,
      goalNote: chapter && !goal ? '这一章没有目标字数（细纲里没写，小说配置里也没写每章字数）。' : undefined,
      headingExcluded: skipsHeading(file),
    };
  }
  return {
    file: info,
    session: { startedAt: session.startedAt, words: session.words, ms: session.ms, files: session.breakdown() },
    today,
  };
}

// ---------------------------------------------------------------- 装配

/** 装一次（`index.ts`）。 */
export function installWritingStats(): void {
  installDaily();

  onEditorChange((ev) => {
    if (ev.type !== 'edit') {
      return;
    }
    onEdit(ev.file, ev.source, ev.change);
    refreshCells();
    refreshStatsPanel();
  });

  onChapterIndex(() => {
    refreshCells();
    refreshStatsPanel();
  });
  // 别的窗口记了今日码字。
  onDailyChange(() => {
    refreshCells();
    refreshStatsPanel();
  });

  window.addEventListener('nf-files-moved', (e) => {
    if (e.detail.from && e.detail.to) {
      session.rename(e.detail.from, e.detail.to);
    }
  });

  // 换了工程（或关掉了）：还没写进去的今日码字按原来那个工程的键写掉；本次从头算（明细里是上一个工程的文件）。
  window.addEventListener('nf-workspace-reset', () => {
    flushDaily();
    closeStatsPanel();
    restart(true);
  });

  window.addEventListener('nf-stats-query', (e) => {
    e.detail.available = true;
    e.detail.goal = prefs.goal;
    e.detail.session = prefs.session;
    e.detail.today = prefs.today;
  });

  window.addEventListener('nf-stats-command', (e) => {
    switch (e.detail.name) {
      case 'toggleGoal':
        setPref('goal', !prefs.goal);
        break;
      case 'toggleSession':
        setPref('session', !prefs.session);
        break;
      case 'toggleToday':
        setPref('today', !prefs.today);
        break;
      case 'restart':
        restart();
        break;
    }
  });
}
