/**
 * 名词补全（角色名、地名、势力、物品……）：在光标处弹一个候选框，列出这本书的角色卡名字与别名、设定条目的标题与
 * 关键词、设定名录里出现过还没建条目的名字，挑一个补上。**不调模型**（第 4 条），名词表来自后端
 * （`core/views/nameIndex.ts`），匹配与排序在零 DOM 的 `namesCore.ts`。
 *
 * ## 两种弹法
 *
 * - **按键弹（缺省）**：`Alt+/`（⚑ {@link NAMES_KEY_LABEL}；`Ctrl+Space` 在 Windows / Linux 上常被系统拿去切输入法，
 *   浏览器与编辑器都没占 `Alt+/`，它也是 Emacs / Eclipse 的「补全一个词」）或「视图 → 名词补全」。用光标前几个字当查询词
 *   （`queryBefore`：往前 1~4 个字里能匹配上名字开头的最长那段），什么都匹配不上就列全部、最近在本文件出现的排前面。
 *   之后接着打字跟着筛，碰到空白标点、光标退到起点前面、一个都对不上就收起。`↑↓` 选，`Enter` / `Tab` 接受，`Esc` 收起。
 * - **边打边弹**（「视图 → 边打边弹名词补全」，缺省关，记在 `novelforge.editor.prefs` 的 `nameAutoPopup`）：输入法上屏
 *   或直接打字之后，光标前的字是某个名字的开头（至少两个字、还没打完整，`autoPopQuery`）就弹。**不抢回车**：回车照常换段
 *   （顺手收起），`Tab` 接受（⚑），`↑↓` 在框里选，`Esc` 收起；接着打别的字就收起。
 *
 * ## 几条规矩
 *
 * - **输入法组字中途绝不弹、不接管任何键**：按键经 `addKeyHandler`，组字中途的键根本送不到；自动弹只认带 `change` 的
 *   `edit`（上屏那一下）；框开着时一开始组字就先藏起来，上屏之后按新的文字重新筛（取消组字也重新看一眼）。
 * - **插入只走 `Pane.applyEdit`**（`opts.source: 'completion'`），一步撤销：换掉作者已经打的那几个字、补全剩下的，光标落在
 *   名字后面。别名命中时框里写「别名 → 正名」，插入的是那个别名（作者打的就是它，⚑）。码字统计把补上的字算作者码的字
 *   （⚑，见 `writingStats.ts`）。
 * - **只对作者会写到名字的文件**：后端给的 `kind`（`completionApplies`：正文、草稿、细纲、角色卡、设定、大纲、叙事线），
 *   前端不拿路径猜；配置之类按键只说一句、不弹，自动模式不弹。
 * - **贴着光标**：位置借高亮镜像层量（`highlight.ts` 的 `measureOffset`，与打字机滚动同一个办法），不另起测量 DOM；
 *   放在光标那一行下面，靠近底边翻到上面，两边都不够就压高度。挂在 `body` 上 `position: fixed`。
 * - **点外面、切标签、滚动时收起**：document 捕获阶段的 `mousedown`（点在框里的不算，框里按下不夺焦点）、编辑区换了文件 /
 *   切了预览、滚轮、别处滚动、窗口改大小、编辑区失焦；编辑区自己滚（打字机滚动、打到底自动滚）时跟着挪，光标那一行滚出
 *   视口才收。
 * - **名词表按需要**：第一次要用时发 `requestNameIndex`（带 requestId 与手上那份的 `sig`），回 `nameIndex`；收到 `state`
 *   （磁盘上变过）就记一笔「可能过期」，下一次要用时再问（边打边弹时至多 3 秒问一次），没变的话后端只回指纹。问的工夫里照样
 *   拿手上那份筛；手上还没有时按键那一下等表到了再弹。换工程作废。
 */
import { clear, el } from '../dom';
import { toast } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, addKeyHandler, editorOf, onEditorChange } from './api';
import type { EditorContext, EditorEvent, OpenFile, Pane } from './api';
import { measureOffset } from './highlight';
import {
  autoPopQuery,
  autoQueryAt,
  buildNameCatalog,
  completionApplies,
  insertionFor,
  matchNames,
  queryBefore,
  queryBetween,
} from './namesCore';
import type { NameCandidate, NameCatalog, NameQuery } from './namesCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { highlightSegments } from './quickOpenCore';
import { claimRequest, newRequestId } from './replace';

/** 快捷键（⚑）。`view/namesMenu.ts` 写的是同一个。 */
export const NAMES_KEY_LABEL = 'Alt+/';
/** 偏好里边打边弹那一项的键（只认明明白白的 `true`）。 */
const PREF_KEY = 'nameAutoPopup';
/** 边打边弹时，表可能过期了多久最多问一次。 */
const REFRESH_THROTTLE_MS = 3000;
/** 按了键、表还没到：等多久，之后到的不再弹。 */
const PENDING_TRIGGER_MS = 3000;

const NOT_HERE = '名词补全只在正文、草稿、细纲、角色卡、设定、情节大纲与叙事线里用。';

// ---------------------------------------------------------------- 名词表

let post: (msg: InMessage) => void = () => {};
let catalog: NameCatalog | null = null;
let sig: string | undefined;
/** 收到过几次 `state`（磁盘上变过）；问的时候记下当时的数，回来时对不上就还算过期。 */
let epoch = 0;
let fetchedEpoch = -1;
let waiting: { id: string; epoch: number } | null = null;
let lastAsk = 0;
/** 按了键、表还没到：到了就在那里弹（同一块编辑区、同一份文件还开着的话）。 */
let pendingTrigger: { pane: Pane; file: OpenFile; until: number } | null = null;

function fresh(): boolean {
  return !!catalog && fetchedEpoch === epoch;
}

/** 表可能过期了就问一次（在路上的不重复问）。`throttle`：边打边弹时，手上有表就至多 3 秒问一次。 */
function refresh(throttle: boolean): void {
  if (fresh() || waiting) {
    return;
  }
  if (throttle && catalog && Date.now() - lastAsk < REFRESH_THROTTLE_MS) {
    return;
  }
  const id = newRequestId('names');
  waiting = { id, epoch };
  lastAsk = Date.now();
  post({ type: 'requestNameIndex', requestId: id, ...(catalog && sig ? { have: sig } : {}) });
}

function onIndex(msg: Extract<OutMessage, { type: 'nameIndex' }>): void {
  if (!waiting || msg.requestId !== waiting.id || !claimRequest(msg.requestId)) {
    return;
  }
  const askedAt = waiting.epoch;
  waiting = null;
  if (msg.index) {
    catalog = buildNameCatalog(msg.index);
  } else if (!catalog) {
    // 说没变、手上却没有（换过工程之类）：重新要一份整的。
    sig = undefined;
    refresh(false);
    return;
  }
  sig = msg.sig;
  fetchedEpoch = askedAt;
  const pending = pendingTrigger;
  pendingTrigger = null;
  if (pending && Date.now() <= pending.until && !composing) {
    const ctx = editorOf(pending.pane);
    if (ctx && ctx.file === pending.file && !ctx.pane.isPreviewing()) {
      openManual(ctx);
      return;
    }
  }
  if (session) {
    resync();
  }
}

// ---------------------------------------------------------------- 偏好

let auto = false;

function readAuto(): boolean {
  return storedPrefs()[PREF_KEY] === true;
}

function setAuto(on: boolean): void {
  if (auto !== on) {
    setStoredPrefs({ [PREF_KEY]: on || undefined });
  }
}

// ---------------------------------------------------------------- 弹出框

interface Session {
  pane: Pane;
  file: OpenFile;
  mode: 'manual' | 'auto';
  /** 查询词在全文里的起点（`area.value` 的下标）。 */
  start: number;
  query: string;
  items: NameCandidate[];
  total: number;
  active: number;
  box: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  foot: HTMLElement;
  /** 输入法组字中途先藏起来。 */
  hidden: boolean;
}

let session: Session | null = null;
/** 自己调 `applyEdit` 的那一下也会发 `edit`，不当成作者在打字。 */
let accepting = false;
/** 输入法正在组字（document 捕获阶段记，比编辑区自己的 compositionend 先跑）。 */
let composing = false;

function snapshot(ctx: EditorContext): { text: string; selStart: number; selEnd: number } {
  return { text: ctx.area.value, selStart: ctx.area.selectionStart, selEnd: ctx.area.selectionEnd };
}

/** 按键弹。 */
function trigger(ctx: EditorContext): void {
  if (!completionApplies(ctx.file.kind)) {
    toast(NOT_HERE);
    return;
  }
  if (ctx.pane.isPreviewing()) {
    toast('预览里不能补全，先切回编辑。');
    return;
  }
  if (!catalog) {
    pendingTrigger = { pane: ctx.pane, file: ctx.file, until: Date.now() + PENDING_TRIGGER_MS };
    refresh(false);
    return;
  }
  refresh(false);
  openManual(ctx);
}

function openManual(ctx: EditorContext): void {
  if (!catalog) {
    return;
  }
  if (!catalog.initialized) {
    toast('这个文件夹还不是小说工程，没有名词可补全。');
    return;
  }
  if (catalog.items.length === 0) {
    toast('这本书还没有角色卡或设定条目，没有名词可补全。');
    return;
  }
  const { text, selStart } = snapshot(ctx);
  show(ctx, 'manual', queryBefore(catalog, text, selStart));
}

/** 按查询词筛出候选、开（或换掉）弹出框。一个都对不上就收起。 */
function show(ctx: EditorContext, mode: Session['mode'], q: NameQuery): void {
  if (!catalog) {
    return;
  }
  const { text, selEnd } = snapshot(ctx);
  const result = matchNames(catalog, q.query, { text, start: q.start, caret: selEnd, unfinished: mode === 'auto' });
  if (result.total === 0) {
    close();
    return;
  }
  if (!session) {
    const dom = buildBox();
    document.body.appendChild(dom.box);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    session = { pane: ctx.pane, file: ctx.file, mode, start: q.start, query: q.query, items: [], total: 0, active: 0, hidden: false, ...dom };
  }
  const s = session;
  const keep = s.pane === ctx.pane && s.file === ctx.file ? s.items[s.active]?.item : undefined;
  Object.assign(s, { pane: ctx.pane, file: ctx.file, mode, start: q.start, query: q.query, hidden: false });
  s.items = result.items;
  s.total = result.total;
  const kept = keep ? s.items.findIndex((c) => c.item === keep) : -1;
  s.active = kept >= 0 ? kept : 0;
  render();
  position();
}

/** 收起弹出框。 */
function close(): void {
  if (!session) {
    return;
  }
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  session.box.remove();
  session = null;
}

/** 框开着、文字或表变了：按当前文字重新筛（模式不变）。 */
function resync(): void {
  const s = session;
  if (!s || !catalog) {
    return;
  }
  const ctx = editorOf(s.pane);
  if (!ctx || ctx.file !== s.file || ctx.pane.isPreviewing()) {
    close();
    return;
  }
  const { text, selStart, selEnd } = snapshot(ctx);
  if (selStart !== selEnd) {
    close();
    return;
  }
  if (s.mode === 'auto') {
    const q = autoQueryAt(catalog, text, selEnd);
    if (q) {
      show(ctx, 'auto', q);
    } else {
      close();
    }
    return;
  }
  const query = queryBetween(text, s.start, selEnd);
  if (query === undefined) {
    close();
    return;
  }
  show(ctx, 'manual', { query, start: s.start });
}

function hideForComposition(): void {
  if (session && !session.hidden) {
    session.hidden = true;
    session.box.classList.add('hidden');
  }
}

function move(step: number): void {
  const s = session;
  if (!s || s.items.length === 0) {
    return;
  }
  s.active = (s.active + step + s.items.length) % s.items.length;
  markActive();
}

function acceptActive(): void {
  const c = session?.items[session.active];
  if (c) {
    accept(c);
  } else {
    close();
  }
}

/** 接受一条：换掉作者已经打的那几个字，补成整个叫法；一步撤销。 */
function accept(c: NameCandidate): void {
  const s = session;
  if (!s) {
    return;
  }
  const { pane, file, start } = s;
  close();
  if (pane.activeFile() !== file || pane.isPreviewing()) {
    return;
  }
  const area = pane.area;
  const ins = insertionFor(start, area.selectionStart, area.selectionEnd, c.form);
  accepting = true;
  try {
    pane.applyEdit(ins.start, ins.end, ins.text, { start: ins.caret, end: ins.caret }, { source: 'completion' });
  } finally {
    accepting = false;
  }
}

// ---------------------------------------------------------------- DOM

function buildBox(): Pick<Session, 'box' | 'list' | 'note' | 'foot'> {
  const box = el('div', 'nc-box');
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', '名词补全');
  const list = el('div', 'nc-list');
  const note = el('div', 'nc-note hidden');
  const foot = el('div', 'nc-foot');
  box.append(list, note, foot);
  // 框里按下鼠标不夺编辑区的焦点（夺走了 ↑↓ 就不归它了）；点一行接受由那一行的 click 做。
  box.addEventListener('mousedown', (e) => e.preventDefault());
  return { box, list, note, foot };
}

function render(): void {
  const s = session;
  if (!s) {
    return;
  }
  s.box.classList.toggle('hidden', s.hidden);
  s.box.classList.toggle('nc-auto', s.mode === 'auto');
  clear(s.list);
  s.items.forEach((c, i) => s.list.appendChild(buildRow(c, i)));
  const more = s.total > s.items.length ? `只列出前 ${s.items.length} 个（一共 ${s.total} 个），多打几个字缩小范围。` : '';
  s.note.textContent = more;
  s.note.classList.toggle('hidden', more === '');
  s.foot.textContent =
    s.mode === 'auto' ? '↑↓ 选择 · Tab 插入 · 回车照常换段 · Esc 收起' : '↑↓ 选择 · Enter / Tab 插入 · Esc 收起';
  markActive();
}

function buildRow(c: NameCandidate, i: number): HTMLElement {
  const row = el('div', `nc-item nc-${c.item.source}`);
  row.setAttribute('role', 'option');
  row.dataset.index = String(i);
  row.title = c.item.path ?? '还没有条目：设定名录里「出现过 · 未建条目」的名字';

  const name = el('span', 'nc-name');
  for (const seg of highlightSegments(c.form, c.hits)) {
    name.appendChild(seg.hit ? el('mark', undefined, seg.text) : document.createTextNode(seg.text));
  }
  if (c.viaAlias) {
    name.appendChild(el('span', 'nc-canon', ` → ${c.item.name}`));
  }
  row.appendChild(name);
  row.appendChild(el('span', 'nc-badge', c.item.badge));
  const brief = c.item.source === 'unfiled' ? ['未建条目', c.item.brief].filter(Boolean).join(' · ') : c.item.brief;
  row.appendChild(el('span', 'nc-brief', brief));

  row.addEventListener('click', () => accept(c));
  return row;
}

function markActive(): void {
  const s = session;
  if (!s) {
    return;
  }
  const rows = s.list.querySelectorAll<HTMLElement>('.nc-item');
  rows.forEach((row, i) => {
    const on = i === s.active;
    row.classList.toggle('active', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const current = rows[s.active];
  if (current && typeof current.scrollIntoView === 'function') {
    current.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * 贴着光标摆：查询词开头那个字的位置借高亮镜像层量（量不了——文字太大、textarea 藏着——就摆在编辑区左上角附近）。
 * 优先放在那一行下面，放不下翻到上面，两边都不够选空间大的一侧并压高度；横向夹进视口。光标那一行滚出编辑区的视口就收起。
 */
function position(): void {
  const s = session;
  if (!s || s.hidden) {
    return;
  }
  const area = s.pane.area;
  const rect = area.getBoundingClientRect();
  const pos = measureOffset(s.pane, s.start);
  let x = rect.left + 24;
  let lineTop = rect.top + 24;
  let lineBottom = lineTop;
  if (pos) {
    x = rect.left + area.clientLeft + pos.left - area.scrollLeft;
    lineTop = rect.top + area.clientTop + pos.top - area.scrollTop;
    lineBottom = lineTop + pos.height;
    if (rect.height > 0 && (lineBottom <= rect.top || lineTop >= rect.bottom)) {
      close();
      return;
    }
  }
  const box = s.box;
  const gap = 2;
  const margin = 6;
  const minHeight = 72;
  box.style.maxHeight = '';
  const natural = box.offsetHeight;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const below = vh - lineBottom - gap - margin;
  const above = lineTop - gap - margin;
  const putBelow = natural <= below || below >= above;
  const room = Math.max(minHeight, putBelow ? below : above);
  if (natural > room) {
    box.style.maxHeight = `${room}px`;
  }
  const h = box.offsetHeight;
  const top = putBelow ? lineBottom + gap : Math.max(margin, lineTop - h - gap);
  const w = box.offsetWidth;
  let left = x;
  if (w > 0 && left + w > vw - margin) {
    left = vw - w - margin;
  }
  left = Math.max(margin, left);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.classList.toggle('nc-above', !putBelow);
}

// ---------------------------------------------------------------- 收起的时机

function onOutside(e: MouseEvent): void {
  if (session && !session.box.contains(e.target as Node)) {
    close();
  }
}

let repositionQueued = false;

function onScroll(e: Event): void {
  const s = session;
  if (!s || s.box.contains(e.target as Node)) {
    return;
  }
  if (e.target === s.pane.area) {
    // 编辑区自己滚（打字机滚动、打到底自动滚、拖滚动条）：跟着挪，滚出视口才收。滚轮另有一条直接收起。
    if (!repositionQueued) {
      repositionQueued = true;
      queueMicrotask(() => {
        repositionQueued = false;
        position();
      });
    }
    return;
  }
  close();
}

function onResize(): void {
  close();
}

const hooked = new WeakSet<Pane>();

/** 每块编辑区第一次重画时挂上：滚轮与失焦收起。 */
function hook(pane: Pane): void {
  if (hooked.has(pane)) {
    return;
  }
  hooked.add(pane);
  pane.area.addEventListener('wheel', () => {
    if (session?.pane === pane) {
      close();
    }
  });
  pane.area.addEventListener('blur', () => {
    if (session?.pane === pane) {
      close();
    }
  });
}

// ---------------------------------------------------------------- 编辑区的变化

function onEdit(ev: Extract<EditorEvent, { type: 'edit' }>): void {
  if (accepting) {
    return;
  }
  const ctx = editorOf(ev.pane);
  if (!ctx || ev.file !== ctx.file) {
    return;
  }
  const s = session;
  if (s && s.pane === ev.pane) {
    if (s.file !== ev.file || ev.source === 'undo' || ev.source === 'redo') {
      close();
      return;
    }
    if (ev.source === 'composition' && !ev.change) {
      // 组字中途：先藏起来，什么都不接管；上屏那一下再筛。
      hideForComposition();
      return;
    }
    if (ev.change && ev.change.at < s.start && s.mode === 'manual') {
      // 改动落在查询词前面（别处的程序改写）：起点对不上了。
      close();
      return;
    }
    resync();
    return;
  }
  if (!auto || !completionApplies(ev.file.kind) || ctx.pane.isPreviewing()) {
    return;
  }
  // 只认打字与输入法上屏；先看一眼表是不是该更新了（在路上的不重复问）。
  if (ev.source !== 'typing' && ev.source !== 'composition') {
    return;
  }
  refresh(true);
  if (!catalog) {
    return;
  }
  const { text, selStart, selEnd } = snapshot(ctx);
  const q = autoPopQuery(catalog, {
    source: ev.source,
    change: ev.change,
    text,
    selectionStart: selStart,
    selectionEnd: selEnd,
    composing: composing || (ev.source === 'composition' && !ev.change),
  });
  if (q) {
    show(ctx, 'auto', q);
  }
}

// ---------------------------------------------------------------- 按键

function isTriggerKey(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && ((e.code === 'Slash' && !e.shiftKey) || e.key === '/');
}

function onKey(e: KeyboardEvent, ctx: EditorContext): boolean {
  const s = session;
  if (s && s.pane === ctx.pane && !s.hidden) {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (plain) {
          move(e.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        close();
        return false;
      case 'Tab':
        if (plain) {
          acceptActive();
          return true;
        }
        close();
        return false;
      case 'Enter':
        // 边打边弹不抢回车：回车照常换段，框收起。按键弹出来的才拿回车接受。
        if (plain && s.mode === 'manual') {
          acceptActive();
          return true;
        }
        close();
        return false;
      case 'Escape':
        close();
        // 别让查找条、专注模式那几个 document 上的 Esc 再处理一遍。
        e.stopPropagation();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        close();
        return false;
    }
  }
  if (isTriggerKey(e)) {
    trigger(ctx);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 装配

let installed = false;

/**
 * 装上快捷键、边打边弹、名词表的收发、「视图 → 补全」的编辑器那一半。`editor/index.ts` 调一次，**要在
 * `installParagraphTools` 之前**：框开着时回车 / Tab 要先归这里（按键处理按挂的先后跑），不然回车先被分段那一条接走。
 */
export function installNames(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;
  auto = readAuto();

  addKeyHandler(onKey);

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      if (session && session.pane === ev.pane && (ev.pane.activeFile() !== session.file || ev.pane.isPreviewing())) {
        close();
      }
      // 开着边打边弹、正对着一份能补全的文件：表先要一份（之后打字时就有了）。
      const file = ev.pane.activeFile();
      if (auto && file && completionApplies(file.kind)) {
        refresh(true);
      }
      return;
    }
    onEdit(ev);
  });

  // 组字开始 / 结束：document 捕获阶段记，比编辑区自己的监听先跑（上屏那一下的 edit 发出来时已经不算在组字了）。
  document.addEventListener(
    'compositionstart',
    (e) => {
      composing = true;
      if (session && e.target === session.pane.area) {
        hideForComposition();
      }
    },
    true
  );
  document.addEventListener(
    'compositionend',
    () => {
      composing = false;
      // 取消组字（上屏的字与原来一样）时编辑区不发 edit：藏着的框按现在的文字再看一眼。
      setTimeout(() => {
        if (session?.hidden) {
          resync();
        }
      }, 0);
    },
    true
  );

  onPrefsChange(() => {
    const next = readAuto();
    if (next === auto) {
      return;
    }
    auto = next;
    if (!auto && session?.mode === 'auto') {
      close();
    }
    const ed = activeEditor();
    if (auto && ed && completionApplies(ed.file.kind)) {
      refresh(false);
    }
  });

  window.addEventListener('nf-names-query', (e) => {
    const ed = activeEditor();
    e.detail.available = true;
    e.detail.auto = auto;
    e.detail.canTrigger = !!ed && completionApplies(ed.file.kind) && !ed.pane.isPreviewing();
    e.detail.reason = !ed
      ? '没有打开的文件。'
      : !completionApplies(ed.file.kind)
        ? NOT_HERE
        : ed.pane.isPreviewing()
          ? '预览里不能补全，先切回编辑。'
          : undefined;
  });

  window.addEventListener('nf-names-command', (e) => {
    if (e.detail.name === 'toggleAuto') {
      setAuto(!auto);
      return;
    }
    if (e.detail.name === 'trigger') {
      const ed = activeEditor();
      if (!ed) {
        toast('先在编辑区里打开一份文件。');
        return;
      }
      if (document.activeElement !== ed.area && !ed.pane.isPreviewing()) {
        ed.area.focus();
      }
      trigger(ed);
    }
  });

  window.addEventListener('nf-workspace-reset', () => {
    close();
    catalog = null;
    sig = undefined;
    waiting = null;
    pendingTrigger = null;
    fetchedEpoch = -1;
  });

  onMessage((msg) => {
    if (msg.type === 'nameIndex') {
      onIndex(msg);
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁盘上变过（或刚连上）：手上那份可能过期了，下一次要用时再问。
      epoch++;
    }
  });
}
