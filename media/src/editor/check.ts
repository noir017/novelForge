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
 * 什么时候重查、改了字之后画着的那几段怎么跟上、输入法组字中途不重查、两万字以上节流，都在 `liveLayer.ts`（名词高亮
 * 也用它，两层一个口径）。这里只说「哪份文件查」（`isProse`）与「这份文字画哪几段」；查过的结果按「哪一份文字、
 * 哪一版词表」缓存在每份文件上（`freshResult`）。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import type { CheckTermsView, InMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isProse } from './api';
import type { OpenFile, Pane } from './api';
import {
  EMPTY_VOCAB,
  checkRanges,
  describeCounts,
  nextOccurrence,
  occurrenceAt,
  replaceAllEdit,
  runCheck,
} from './checkCore';
import type { CheckCategory, CheckEntry, CheckResult, CheckVocab } from './checkCore';
import { checkPanelAnchor, closeCheckPanel, refreshCheckPanel, toggleCheckPanel } from './checkPanel';
import type { CheckPanelData } from './checkPanel';
import { scrollToOffset, tooLargeToHighlight } from './highlight';
import { createLiveLayer, shownText } from './liveLayer';
import type { LiveLayer } from './liveLayer';
import { setStoredPrefs, storedPrefs } from './paragraphState';

/** 高亮镜像层上的图层名。 */
export const CHECK_LAYER = 'check';

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
  layer?.recheckAll(true);
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

// ---------------------------------------------------------------- 重查（liveLayer.ts）

/** 跟着正文重查的那一套（`installCheck` 里造）。 */
let layer: LiveLayer | undefined;

/** 现在就按当前文字重查、重画（不节流），状态栏与面板跟着。 */
function checkNow(pane: Pane): void {
  layer?.checkNow(pane);
}

function recheckAll(): void {
  layer?.recheckAll();
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
  if (results.get(file)?.draft !== file.draft || layer?.composing(pane)) {
    checkNow(pane);
  }
  const result = freshResult(file);
  return { file, entry: result.entries.find((e) => e.category === entry.category && e.term === entry.term) };
}

/** 预览里先切回编辑（`setPreviewing(false)`：滚到预览里看着的那一处）。 */
function ensureEditing(pane: Pane): void {
  if (pane.isPreviewing()) {
    pane.setPreviewing(false);
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

  layer = createLiveLayer({
    layer: CHECK_LAYER,
    applies: isProse,
    ranges: (file, text) => {
      // 结果总要算（状态栏那一格与面板用），画不画看开关。
      const result = freshResult(file);
      return prefs.highlight && !tooLargeToHighlight(text) ? checkRanges(result) : [];
    },
    checked: (pane) => {
      renderCell(pane);
      refreshCheckPanel();
    },
    rendered: renderCell,
  });

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
