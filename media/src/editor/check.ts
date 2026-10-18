/**
 * 写作体检（独立版内置编辑器，阶段五）的装配：正文里标出禁用词、敏感词、超出上限的比喻词与英文缩写（高亮镜像层的
 * `check` 图层），状态栏一格「体检 N」与它的面板，「视图 → 体检」那一组的编辑器一半。口径在 `checkCore.ts`（纯函数），
 * 面板在 `checkPanel.ts`。**不调模型**：只是按词表在正文里找字。
 *
 * ## 词从哪来
 *
 * 后端推 `checkTerms`（`controller/check.ts`）：禁用词与写正文时写完数的是同一份（`views/checkTerms.ts` 的
 * `readBannedTerms`，`generate.ts` 也调它），敏感词表是 `.novelforge/sensitive.txt` 解析好的结果。`style.md`、
 * `config.md`、敏感词表变了才推。比喻词与英文缩写不随书变，编辑器直接打包 core 那一份（`manuscriptCheck.ts`）。
 *
 * ## 只看正文
 *
 * 当前标签是正文（`isProse`：后端给的 `kind` 是 `chapter` / `draft`，前端不拿路径猜）才查；细纲、角色卡、敏感词表
 * 本身都不查（状态栏那一格藏起来）。
 *
 * ## 与别的图层同时开着
 *
 * 一层镜像、几个命名图层（`highlight.ts`）：同一段字落在几层里时那一段 `<mark>` 带上几层的 class。`check` 这一层**只画
 * 下划线**（`text-decoration` 不占排版，镜像层与 textarea 照样对得齐），敏感词另加一层很淡的底色；查找（`find`）画的是
 * 底色，两层叠在同一段字上时查找的底色盖过敏感词的（`check.css` 的选择器用 `:where()` 降一级），下划线照画；段落聚焦
 * （`focus`）管的是字色，与下划线互不相干。
 *
 * ## 几万字的章节每敲一下也不卡
 *
 * 1. 找词是一趟扫描（`locateTerms` 按第一个字建表，不是「词数 × 全文」），每份文件缓存「查过的是哪一份文字」。
 * 2. 两万字以内：改了字之后在**微任务**里重查（`highlight.ts` 的同步订阅先把各层平移完、压在改动上的丢掉，之后才轮到
 *    这里落新的一份；浏览器两次绘制之间只画一次）。更长的：至多每 300ms 重查一次（尾随），其间已经画着的那几段跟着改动平移
 *    （`highlight.ts` 自己做），只是新冒出来的词晚一点标出来。
 * 3. 重查的结果与镜像层上此刻画着的一模一样（多数按键都是这样）就不再画一遍。
 * 4. **输入法组字中途不重查**：拼音字母不该被当成英文敏感词，计数也不该跟着拼音跳；已经画着的那几段按组字前后的文字差
 *    挪到新位置（`diffChange`），不乱跳。上屏（`compositionend`）之后再查。撤销 / 重做同样先挪、再查。
 *
 * 镜像层本身（整份文字排两遍）是各图层共用的开销：查找、段落聚焦开着时本来也是这样；超过 30 万字不画，面板照样数。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import type { CheckTermsView, InMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isProse, onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import {
  EMPTY_VOCAB,
  checkRanges,
  describeCounts,
  diffChange,
  nextOccurrence,
  occurrenceAt,
  replaceAllEdit,
  runCheck,
  sameRanges,
  shiftRanges,
} from './checkCore';
import type { CheckCategory, CheckEntry, CheckRange, CheckResult, CheckVocab } from './checkCore';
import { checkPanelAnchor, closeCheckPanel, refreshCheckPanel, toggleCheckPanel } from './checkPanel';
import type { CheckPanelData } from './checkPanel';
import { clearHighlights, scrollToOffset, setHighlights, tooLargeToHighlight } from './highlight';
import { setStoredPrefs, storedPrefs } from './paragraphState';
import { panes } from './store';

/** 高亮镜像层上的图层名。 */
export const CHECK_LAYER = 'check';
/** 这么长以内的正文改了字就当场（微任务里）重查；更长的节流。与码字统计的 `SYNC_COUNT_LIMIT` 同一条线。 */
export const CHECK_SYNC_LIMIT = 20_000;
/** 长正文至多这么久重查一次。 */
export const CHECK_RECHECK_MS = 300;

// ---------------------------------------------------------------- 偏好

/** 「视图 → 体检」那两个开关。按浏览器记在 `novelforge.editor.prefs` 的 `check` 里。 */
interface CheckPrefs {
  /** 正文里画体检高亮（缺省开 ⚑）。 */
  highlight: boolean;
  /** 状态栏显示「体检」那一格（缺省开 ⚑）。 */
  status: boolean;
}

let prefs: CheckPrefs = loadPrefs();

function loadPrefs(): CheckPrefs {
  const raw = storedPrefs().check as Partial<CheckPrefs> | undefined;
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 两个都缺省开，只认明明白白的 false。
  return { highlight: c.highlight !== false, status: c.status !== false };
}

function setPref(key: keyof CheckPrefs, on: boolean): void {
  prefs = { ...prefs, [key]: on };
  // 同一个键里还有段落、外观、专注、统计那几项：读出整份、合上自己这一项再整份写回（setStoredPrefs）。
  setStoredPrefs({ check: prefs });
  for (const pane of Object.values(panes)) {
    if (pane) {
      stateOf(pane).dirty = true;
      checkNow(pane);
    }
  }
}

// ---------------------------------------------------------------- 词表

let vocab: CheckVocab = EMPTY_VOCAB;
/** 敏感词表那几样说明（面板里说）。还没收到过 `checkTerms` 时 `received` 是 false。 */
let meta: Pick<CheckTermsView, 'sensitivePath' | 'sensitiveExists' | 'sensitiveBad'> & { received: boolean } = {
  sensitivePath: '.novelforge/sensitive.txt',
  sensitiveExists: false,
  sensitiveBad: [],
  received: false,
};
/** 词表每换一次加一：缓存里查过的结果按它作废。 */
let vocabVersion = 0;

function takeTerms(terms: CheckTermsView): void {
  vocab = {
    banned: Array.isArray(terms?.banned) ? terms.banned.filter((t) => typeof t === 'string') : [],
    sensitive: Array.isArray(terms?.sensitive) ? terms.sensitive.filter((t) => t && typeof t.term === 'string') : [],
  };
  meta = {
    sensitivePath: typeof terms?.sensitivePath === 'string' ? terms.sensitivePath : meta.sensitivePath,
    sensitiveExists: !!terms?.sensitiveExists,
    sensitiveBad: Array.isArray(terms?.sensitiveBad) ? terms.sensitiveBad : [],
    received: true,
  };
  vocabVersion++;
  recheckAll();
}

// ---------------------------------------------------------------- 结果（带缓存）

/** 编辑区里显示的那一份（textarea 把 `\r\n` 归一成 `\n`，位置都按它算）。 */
function shownText(file: OpenFile): string {
  return file.draft.includes('\r') ? file.draft.replace(/\r\n?/g, '\n') : file.draft;
}

const results = new WeakMap<OpenFile, { draft: string; version: number; result: CheckResult }>();

/** 这份文件此刻的体检结果（文字或词表变了就重查）。 */
function freshResult(file: OpenFile): CheckResult {
  const known = results.get(file);
  if (known && known.draft === file.draft && known.version === vocabVersion) {
    return known.result;
  }
  const result = runCheck(shownText(file), vocab);
  results.set(file, { draft: file.draft, version: vocabVersion, result });
  return result;
}

/** 上一次查出来的（可能是几百毫秒之前那一份文字的，节流中）；没查过就现查。状态栏与面板只用它，不额外触发重查。 */
function lastResult(file: OpenFile): CheckResult {
  const known = results.get(file);
  return known && known.version === vocabVersion ? known.result : freshResult(file);
}

/** 当前标签是正文时给出它。 */
function proseOf(pane: Pane): OpenFile | undefined {
  const file = pane.activeFile();
  return file && isProse(file) ? file : undefined;
}

// ---------------------------------------------------------------- 每块编辑区的状态

interface PaneState {
  /** 下面几样是给哪个文件记的。当前路径变了就作废（`highlight.ts` 换文件时清掉所有图层）。 */
  path: string | null;
  /** 镜像层 `check` 图层上此刻画着的那几段（照 `highlight.ts` 的规则跟着改动平移）。 */
  painted: CheckRange[];
  /** `painted` 对应的是哪一份文字。 */
  text: string;
  /** 镜像层上那一份与 `painted` 对不上了（撤销、组字中途、上屏：`highlight.ts` 没平移或平移的不是这一份），下次必须重画。 */
  dirty: boolean;
  /** 输入法组字中。 */
  composing: boolean;
  /** 上一次查的时候当前标签是不是正文（保存回执换了 `kind` 时据此重查）。 */
  prose: boolean;
  /** 长正文的节流。 */
  timer?: ReturnType<typeof setTimeout>;
  checkedAt: number;
}

const states = new Map<Pane, PaneState>();

function stateOf(pane: Pane): PaneState {
  let st = states.get(pane);
  if (!st) {
    st = { path: pane.activePath, painted: [], text: '', dirty: false, composing: false, prose: false, checkedAt: 0 };
    states.set(pane, st);
  }
  return st;
}

function clearTimer(st: PaneState): void {
  if (st.timer !== undefined) {
    clearTimeout(st.timer);
    st.timer = undefined;
  }
}

/** 把 `want` 画到 `check` 图层上（与此刻画着的一样、又没弄脏就不画）。 */
function paint(pane: Pane, st: PaneState, want: CheckRange[], text: string): void {
  st.text = text;
  if (!st.dirty && sameRanges(st.painted, want)) {
    return;
  }
  if (want.length > 0) {
    setHighlights(pane, CHECK_LAYER, want);
  } else {
    clearHighlights(pane, CHECK_LAYER);
  }
  st.painted = want;
  st.dirty = false;
}

/** 现在就按当前文字重查、重画（不节流），状态栏与面板跟着。 */
function checkNow(pane: Pane): void {
  const st = stateOf(pane);
  clearTimer(st);
  st.checkedAt = Date.now();
  if (st.path !== pane.activePath) {
    resetFor(pane, st);
  }
  const file = proseOf(pane);
  st.prose = !!file;
  if (!file) {
    paint(pane, st, [], pane.activeFile() ? shownText(pane.activeFile()!) : '');
  } else {
    const text = shownText(file);
    const result = freshResult(file);
    paint(pane, st, prefs.highlight && !tooLargeToHighlight(text) ? checkRanges(result) : [], text);
  }
  renderCell(pane);
  refreshCheckPanel();
}

/** 只把已经挪过位置的那几段画上去（组字中途、长正文节流的空档里），不重查。 */
function displayNow(pane: Pane): void {
  const st = stateOf(pane);
  if (st.dirty && st.path === pane.activePath) {
    paint(pane, st, st.painted, st.text);
  }
}

/** 换了文件：镜像层那边已经（或马上就会）清掉所有图层。 */
function resetFor(pane: Pane, st: PaneState): void {
  clearTimer(st);
  st.path = pane.activePath;
  st.painted = [];
  const file = pane.activeFile();
  st.text = file ? shownText(file) : '';
  st.dirty = false;
}

/** 同一轮里攒着要做的：`check` 重查（盖过 `display`）、`display` 只画挪过位置的那几段。 */
const pending = new Map<Pane, 'check' | 'display'>();

function soon(pane: Pane, kind: 'check' | 'display'): void {
  if (pending.size === 0) {
    queueMicrotask(() => {
      const list = [...pending];
      pending.clear();
      for (const [p, k] of list) {
        if (k === 'check') {
          checkNow(p);
        } else {
          displayNow(p);
        }
      }
    });
  }
  if (pending.get(pane) !== 'check') {
    pending.set(pane, kind);
  }
}

/** 改了字之后什么时候重查（见文件头「几万字的章节每敲一下也不卡」）。 */
function scheduleCheck(pane: Pane, st: PaneState, length: number): void {
  if (st.composing) {
    if (st.dirty) {
      soon(pane, 'display');
    }
    return;
  }
  if (length <= CHECK_SYNC_LIMIT) {
    soon(pane, 'check');
    return;
  }
  if (st.dirty) {
    soon(pane, 'display');
  }
  if (st.timer === undefined) {
    st.timer = setTimeout(() => {
      st.timer = undefined;
      checkNow(pane);
    }, Math.max(0, st.checkedAt + CHECK_RECHECK_MS - Date.now()));
  }
}

function recheckAll(): void {
  for (const pane of Object.values(panes)) {
    if (pane) {
      checkNow(pane);
    }
  }
}

/** 一处改动之后：先让「此刻画着的」跟上，再安排重查。 */
function onEdit(pane: Pane, file: OpenFile, change: { at: number; removed: string; inserted: string } | undefined): void {
  const st = stateOf(pane);
  if (!isProse(file) && !st.prose && st.painted.length === 0) {
    // 不是正文：什么都没画，也不用查（几 MB 的 json 每敲一下不必过这一趟）。
    return;
  }
  if (st.path !== pane.activePath) {
    resetFor(pane, st);
    scheduleCheck(pane, st, file.draft.length);
    return;
  }
  const after = shownText(file);
  if (
    change &&
    !st.composing &&
    st.text.length - change.removed.length + change.inserted.length === after.length &&
    st.text.slice(change.at, change.at + change.removed.length) === change.removed
  ) {
    // 与 highlight.ts 平移图层同一条规则：它那一份与这里记的仍然一样，不必重画。
    st.painted = shiftRanges(st.painted, change);
  } else {
    // 撤销 / 重做、组字中途、上屏（改动是对着组字之前那一份算的）：按前后文字差挪，镜像层那一份必须重画。
    const d = diffChange(st.text, after);
    if (d) {
      st.painted = shiftRanges(st.painted, d);
    }
    st.dirty = true;
  }
  st.text = after;
  scheduleCheck(pane, st, after.length);
}

// ---------------------------------------------------------------- 输入法

const hooked = new WeakSet<Pane>();

function hook(pane: Pane): void {
  if (hooked.has(pane)) {
    return;
  }
  hooked.add(pane);
  pane.area.addEventListener('compositionstart', () => {
    stateOf(pane).composing = true;
  });
  // pane.ts 自己的 compositionend 先跑（它先挂），上屏那一下的 `edit` 已经发过了；这里收尾、安排重查。
  pane.area.addEventListener('compositionend', () => {
    const st = stateOf(pane);
    st.composing = false;
    const file = pane.activeFile();
    if (file) {
      scheduleCheck(pane, st, file.draft.length);
    }
  });
}

// ---------------------------------------------------------------- 状态栏那一格

const cells = new Map<Pane, HTMLElement>();

function cellOf(pane: Pane): HTMLElement | undefined {
  const known = cells.get(pane);
  if (known?.isConnected) {
    return known;
  }
  const status = pane.root.querySelector<HTMLElement>('.ed-status');
  if (!status) {
    return undefined;
  }
  const cell = el('span', 'ed-check hidden');
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-expanded', 'false');
  cell.tabIndex = 0;
  // 紧跟字数那一格（`.spacer` 之前）。page.ts 与 createPaneElements 里没有它：两块编辑区都由这里现造。
  status.insertBefore(cell, status.querySelector('.spacer'));
  // 按下鼠标不夺编辑区的焦点（与码字统计那一格一样）。
  cell.addEventListener('mousedown', (e) => e.preventDefault());
  cell.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(pane, cell);
  });
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePanel(pane, cell);
    }
  });
  cells.set(pane, cell);
  return cell;
}

/** 画这一块的「体检」那一格。不是正文、关掉了这一格时藏起来（面板开着就收起）。 */
function renderCell(pane: Pane): void {
  const cell = cellOf(pane);
  if (!cell) {
    return;
  }
  const file = proseOf(pane);
  if (!prefs.status || !file) {
    setHidden(cell, true);
    if (checkPanelAnchor() === cell) {
      closeCheckPanel();
    }
    return;
  }
  const result = lastResult(file);
  setHidden(cell, false);
  cell.textContent = result.total > 0 ? `体检 ${result.total}` : '体检 ✓';
  cell.classList.toggle('has-issues', result.total > 0);
  const tips = [
    result.total > 0 ? describeCounts(result) : '没有发现敏感词、禁用词、超出上限的比喻词与英文缩写',
    '点一下看是哪几个词，点词跳到它在正文里的位置',
  ];
  if (!prefs.highlight) {
    tips.push('正文里的体检高亮关着（「视图 → 体检高亮」）');
  }
  cell.title = tips.join('\n');
}

// ---------------------------------------------------------------- 面板

/** 面板上点过的那个词跳到了第几处（「2/5」）。 */
let cursor: { path: string; category: CheckCategory; term: string; index: number } | undefined;

let post: (msg: InMessage) => void = () => {};

function togglePanel(pane: Pane, cell: HTMLElement): void {
  toggleCheckPanel(cell, () => panelData(pane), {
    jump: (entry) => jump(pane, entry),
    replaceOne: (entry) => replaceOne(pane, entry),
    replaceAll: (entry) => replaceAll(pane, entry),
    editList: () => editList(),
  });
}

function panelData(pane: Pane): CheckPanelData {
  const file = proseOf(pane);
  const base = {
    highlight: prefs.highlight,
    sensitivePath: meta.sensitivePath,
    sensitiveExists: meta.sensitiveExists,
    sensitiveBad: meta.sensitiveBad,
    received: meta.received,
  };
  if (!file) {
    return { ...base, prose: false };
  }
  const result = lastResult(file);
  return {
    ...base,
    prose: true,
    result,
    tooLarge: tooLargeToHighlight(shownText(file)),
    cursor: cursor && cursor.path === file.path ? cursor : undefined,
  };
}

/** 面板上的动作要的是此刻的位置：节流中（长正文）先当场重查一遍，再按类别与词认回那一条。 */
function freshEntry(pane: Pane, entry: Pick<CheckEntry, 'category' | 'term'>): { file: OpenFile; entry?: CheckEntry } | undefined {
  const file = proseOf(pane);
  if (!file) {
    return undefined;
  }
  if (results.get(file)?.draft !== file.draft || stateOf(pane).composing) {
    checkNow(pane);
  }
  const result = freshResult(file);
  return { file, entry: result.entries.find((e) => e.category === entry.category && e.term === entry.term) };
}

/** 预览里先切回编辑（`activate` 同一个文件就是切回来，光标与滚动位置照旧）。 */
function ensureEditing(pane: Pane): void {
  if (pane.isPreviewing() && pane.activePath) {
    pane.activate(pane.activePath);
  }
}

function select(pane: Pane, file: OpenFile, entry: CheckEntry, index: number): void {
  const area = pane.area;
  const start = entry.offsets[index];
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, start + entry.length);
  scrollToOffset(pane, start, { onlyIfHidden: true });
  cursor = { path: file.path, category: entry.category, term: entry.term, index };
  refreshCheckPanel();
}

/** 点面板上的一个词：跳到它的下一处并选中（到底了绕回第一处）。 */
function jump(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  if (!got) {
    return;
  }
  if (!got.entry) {
    toast(`「${entry.term}」已经不在正文里了。`);
    refreshCheckPanel();
    return;
  }
  select(pane, got.file, got.entry, nextOccurrence(got.entry, pane.area.selectionStart, pane.area.selectionEnd));
}

/**
 * 「替换本处」：选区正好是这个词的某一处才换（一步撤销），换完选中下一处；不是的话这一下只选中下一处——看清楚了再按
 * 一下才换（与查找替换的「替换」同一个规矩）。
 */
function replaceOne(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  const e = got?.entry;
  if (!got || !e?.replacement) {
    refreshCheckPanel();
    return;
  }
  const area = pane.area;
  const i = occurrenceAt(e, area.selectionStart, area.selectionEnd);
  if (i < 0) {
    select(pane, got.file, e, nextOccurrence(e, area.selectionStart, area.selectionEnd));
    return;
  }
  const start = e.offsets[i];
  const replacement = e.replacement;
  pane.applyEdit(start, start + e.length, replacement, { start, end: start + replacement.length });
  checkNow(pane);
  const next = freshEntry(pane, e);
  if (next?.entry) {
    const after = next.entry.offsets.findIndex((o) => o >= start + replacement.length);
    select(pane, next.file, next.entry, after >= 0 ? after : 0);
  } else {
    cursor = undefined;
    area.focus({ preventScroll: true });
    refreshCheckPanel();
  }
}

/** 「本文件全部替换」：从第一处到最后一处一次 `applyEdit`，只记一步撤销（与查找替换的「全部替换」同一条路）。 */
function replaceAll(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  const e = got?.entry;
  if (!got || !e?.replacement) {
    refreshCheckPanel();
    return;
  }
  const edit = replaceAllEdit(pane.area.value, e, e.replacement);
  if (!edit) {
    return;
  }
  pane.applyEdit(edit.start, edit.end, edit.text);
  cursor = undefined;
  checkNow(pane);
  toast(`替换了 ${edit.count} 处：「${e.term}」→「${e.replacement}」（Ctrl+Z 一步退回）`);
}

/** 「编辑敏感词表…」：后端没有就新建一份模板，然后在编辑器里打开它。 */
function editList(): void {
  closeCheckPanel();
  if (document.body.classList.contains('no-workspace')) {
    toast('先打开一个工程。', true);
    return;
  }
  post({ type: 'editSensitiveWords' });
}

// ---------------------------------------------------------------- 装配

/** 装一次（`index.ts`）。 */
export function installCheck(send: (msg: InMessage) => void): void {
  post = send;
  onMessage((msg) => {
    if (msg.type === 'checkTerms') {
      takeTerms(msg.terms);
    }
  });

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      const pane = ev.pane;
      hook(pane);
      const st = stateOf(pane);
      const file = pane.activeFile();
      if (st.path !== pane.activePath) {
        // 换了文件、关了标签：当场按新文件画（缓存里有就不重查）。
        resetFor(pane, st);
        checkNow(pane);
      } else if (!!proseOf(pane) !== st.prose) {
        // 同一个文件换了 `kind`（保存回执带来的）：正文与否变了，重查。
        checkNow(pane);
      } else if (file && st.text !== shownText(file)) {
        // 同一个文件、文字却换了（没改过的标签被磁盘上的新版换掉）：先挪、再查。
        onEdit(pane, file, undefined);
      } else {
        renderCell(pane);
      }
      return;
    }
    if (ev.file === ev.pane.activeFile()) {
      onEdit(ev.pane, ev.file, ev.change);
    }
  });

  for (const pane of Object.values(panes)) {
    if (pane) {
      hook(pane);
    }
  }

  // 换了工程（或关掉了）：词表作废，等新工程的那一份；面板收起。
  window.addEventListener('nf-workspace-reset', () => {
    closeCheckPanel();
    cursor = undefined;
    takeTerms({ banned: [], sensitive: [], sensitivePath: meta.sensitivePath, sensitiveExists: false, sensitiveBad: [] });
    meta.received = false;
  });

  window.addEventListener('nf-check-query', (e) => {
    e.detail.available = true;
    e.detail.highlight = prefs.highlight;
    e.detail.status = prefs.status;
    e.detail.canEditList = !document.body.classList.contains('no-workspace');
  });

  window.addEventListener('nf-check-command', (e) => {
    switch (e.detail.name) {
      case 'toggleHighlight':
        setPref('highlight', !prefs.highlight);
        break;
      case 'toggleStatus':
        setPref('status', !prefs.status);
        break;
      case 'editList':
        editList();
        break;
    }
  });
}
