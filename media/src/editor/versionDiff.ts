/**
 * 「版本」的对比标签（独立版的内置编辑器）：左边一版、右边现在（或后一版），按行比，一处改动里逐字标出删了什么、
 * 加了什么。在「版本」侧栏（`versions.ts`）里点一行就开在这里，不经预览、不弹窗。比的口径在 `versionDiffCore.ts`。
 *
 * - **一个不对应文件的特殊标签**（`store.ts` 的 `SpecialTab`，同「叙事线总览」），**只有一个**：再点别的一行就换掉里面
 *   的内容（像 VS Code 的预览标签）；开在那份文件所在的那一块里。**不进刷新恢复**（`transient`）：看的是哪两版只在这一页里记着。
 * - **三种比法**：一版 ↔ 现在（缺省：右边是编辑器里那一份，没保存的也算）；一版 ↔ 它后面一版（侧栏右键「跟后一版比」：
 *   看那一次改了什么，两边都是存下的，只能看）；磁盘上的 ↔ 编辑器里的（侧栏最上面那一行「还没保存的改动」）。
 * - **跟得上**：右边是编辑器里那一份时，那份文件一改（这里放回一处、另一块里在打字、磁盘上的新版进来、保存）就重比；
 *   藏着时只记一笔，下次显示再比。那份文件关掉了就照实说，不拿旧的比。
 * - **用回这一处 / 恢复整份**（只在右边是编辑器里那一份时有）：只换编辑区里的内容——一步撤销、成为未保存、**不写盘**（第 3 条）。
 *   换之前先发一条不说话的 `saveVersion { quiet }`：放回的内容一存盘（开着自动保存时停笔两秒就存）就盖掉磁盘上那一份，节流
 *   可能不存它。用回一处要改的那份文件就藏在这个标签后面（`applyEdit` 只作用于当前文件）：同一个任务里切过去、改、再切回来，
 *   中间不画，看不出闪；对比区滚到哪先记下、切回来放回去（藏起来那一下滚动位置会丢）。「恢复整份」换完停在那份文件上。
 * - **没改的折起来**：每处改动前后各留一行，中间相同的折成「⋯ 相同的 N 段 ⋯」，点开就展开（重比之后照旧展开着）。
 *
 * 用户内容一律 `textContent`。样式在 `css/standalone/versions.css`。
 */
import { el, setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { onEditorChange } from './api';
import { scrollToOffset } from './highlight';
import { claimRequest, newRequestId, replaceInEditor } from './replace';
import { paneOwning, panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';
import { blockText, charDiff, diffLines, normalizeEol, onlyWhitespace, revertEdit } from './versionDiffCore';
import type { DiffBlock, LineDiff } from './versionDiffCore';

/** 特殊标签的 id。 */
export const VERSION_DIFF_TAB = 'version-diff';

/** 一版：读它用的 id，标题上怎么说。 */
export interface VersionRef {
  id: string;
  label: string;
}

/** 要比的两边。左边 `disk`：磁盘上的（上次保存的那一份）；右边 `now`：编辑器里的。 */
export interface DiffRequest {
  path: string;
  /** 标签与标题上写的文件名。 */
  name: string;
  left: VersionRef | 'disk';
  right: VersionRef | 'now';
}

/** 每处改动前后各留几行没改的。 */
const CONTEXT = 1;
/** 编辑器里那一份变了之后停多久再比（连着打字只比一次）。 */
const REDIFF_MS = 200;
/** 读过的版本全文最多记几份（快照、存档点里的那一份都不会变，记着不用再要）。 */
const TEXT_CACHE = 20;

interface View {
  root: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  restore: HTMLButtonElement;
  open: HTMLButtonElement;
  leftHead: HTMLElement;
  rightHead: HTMLElement;
  body: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 显示在哪一块。 */
let host: Pane | undefined;
let req: DiffRequest | undefined;
/** 两边的全文（`now` 那边每次从编辑区取，不记）。undefined = 还在路上；`error` = 读不到。 */
let leftText: string | undefined;
let rightText: string | undefined;
let loadError: string | undefined;
/** 上一次画的那一份比较，与画的时候编辑器里那份的文字（用回一处之前核对：变了就重比，不拿旧下标改）。 */
let shownDiff: LineDiff | undefined;
let shownRight: string | undefined;
/** 展开了的那几截相同的（按左边第一行的行号认：重比之后左边不变，照旧展开着）。 */
const expanded = new Set<number>();
/** 上一处 / 下一处停在第几处（-1 = 还没停过）。 */
let current = -1;
/** 新换上的这一对还没画出改动：画出来时停到第一处。 */
let jumpPending = false;
/** 藏着的时候编辑器里那份变过：下次显示再比。 */
let stale = false;
let rediffTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

// ---------------------------------------------------------------- 读一版的全文

const textCache = new Map<string, string>();
const waiting = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }>();

/** 一版的全文（快照或存档点里的那一份）。读过的记着。 */
export function versionText(path: string, id: string): Promise<string> {
  const key = `${path}\u0000${id}`;
  const cached = textCache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const requestId = newRequestId('version');
    waiting.set(requestId, {
      resolve: (text) => {
        textCache.delete(key);
        textCache.set(key, text);
        if (textCache.size > TEXT_CACHE) {
          textCache.delete(textCache.keys().next().value!);
        }
        resolve(text);
      },
      reject,
    });
    post({ type: 'readVersion', path, id, requestId });
  });
}

function onVersionText(msg: Extract<OutMessage, { type: 'versionText' }>): void {
  const w = waiting.get(msg.requestId);
  if (!w || !claimRequest(msg.requestId)) {
    return;
  }
  waiting.delete(msg.requestId);
  if (msg.text !== undefined) {
    w.resolve(msg.text);
  } else {
    w.reject(new Error(msg.error ?? '读不到这一版。'));
  }
}

// ---------------------------------------------------------------- 对外

/** 对比标签此刻在比的是什么（侧栏据此标出选中的那一行）。没开就是 undefined。 */
export function currentDiff(): DiffRequest | undefined {
  return req && paneWithSpecial(VERSION_DIFF_TAB) ? req : undefined;
}

/** 比的东西换了、标签关了：侧栏跟着重画选中的那一行。 */
export function onDiffChange(listener: () => void): void {
  listeners.add(listener);
}

/** 在那份文件所在的那一块开对比标签（已经开着就换掉里面的内容）。 */
export function openDiff(next: DiffRequest): void {
  const pane = paneOwning(next.path) ?? paneWithSpecial(VERSION_DIFF_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  const same = req && sameRequest(req, next);
  req = next;
  if (!same) {
    leftText = next.left === 'disk' ? undefined : textCache.get(`${next.path}\u0000${next.left.id}`);
    rightText = next.right === 'now' ? undefined : textCache.get(`${next.path}\u0000${next.right.id}`);
    loadError = undefined;
    expanded.clear();
    current = -1;
    jumpPending = true;
    shownDiff = undefined;
    if (view) {
      view.body.scrollTop = 0;
    }
    load(next);
  }
  pane.openSpecial(VERSION_DIFF_TAB);
  render();
  notify();
}

/**
 * 「恢复整份」：把编辑区里这份文件换成那一版（一步撤销，成为未保存，不写盘），停在那份文件上。换之前先让后端把磁盘上
 * 现在那一份存一版（不说话、跳过节流）。
 */
export async function restoreVersion(path: string, ref: VersionRef): Promise<void> {
  let text: string;
  try {
    text = await versionText(path, ref.id);
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  const file = paneOwning(path)?.files.get(path);
  if (file && normalizeEol(file.draft) !== normalizeEol(text)) {
    // 消息按顺序到：排在之后任何一次 saveFile 前面。
    post({ type: 'saveVersion', path, quiet: true });
  }
  const result = replaceInEditor(path, text);
  if (result === 'closed') {
    toast('这份文件已经关掉了。', true);
  } else if (result === 'unchanged') {
    toast('编辑区里已经是这一版了。');
  } else {
    toast(`已把「${ref.label}」放进编辑区：还没保存，Ctrl+Z 可以退回。`);
  }
}

function sameRequest(a: DiffRequest, b: DiffRequest): boolean {
  const key = (s: VersionRef | 'disk' | 'now') => (typeof s === 'string' ? s : s.id);
  return a.path === b.path && key(a.left) === key(b.left) && key(a.right) === key(b.right);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function load(r: DiffRequest): void {
  const fetch = (side: VersionRef, set: (text: string) => void) => {
    versionText(r.path, side.id).then(
      (text) => {
        if (req === r) {
          set(text);
          render();
        }
      },
      (err: Error) => {
        if (req === r) {
          loadError = err.message;
          render();
        }
      }
    );
  };
  if (r.left !== 'disk' && leftText === undefined) {
    fetch(r.left, (text) => (leftText = text));
  }
  if (r.right !== 'now' && rightText === undefined) {
    fetch(r.right, (text) => (rightText = text));
  }
}

// ---------------------------------------------------------------- 装

export function installVersionDiff(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: VERSION_DIFF_TAB,
    label: () => ({
      title: req ? `对比 · ${req.name}` : '对比',
      tip: req ? `${sideLabel('left')} ↔ ${sideLabel('right')}` : '对比',
    }),
    show,
    hide,
    transient: true,
  });

  onMessage((msg) => {
    if (msg.type === 'versionText') {
      onVersionText(msg);
    }
  });

  // 编辑器里那份变了（打字、放回一处、磁盘上的新版、保存换了基线）：显示着就停一下再比，藏着就记一笔。
  onEditorChange((ev) => {
    if (!req || (req.right !== 'now' && req.left !== 'disk')) {
      return;
    }
    if (ev.type === 'edit' && ev.file.path !== req.path) {
      return;
    }
    if (!visible()) {
      stale = true;
      return;
    }
    clearTimeout(rediffTimer);
    rediffTimer = setTimeout(render, REDIFF_MS);
  });

  window.addEventListener('nf-workspace-reset', () => {
    req = undefined;
    textCache.clear();
    shownDiff = undefined;
  });
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === VERSION_DIFF_TAB;
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
  const wasHidden = v.root.classList.contains('hidden') || host !== pane;
  host = pane;
  setHidden(v.root, false);
  if (wasHidden && stale) {
    stale = false;
    render();
  }
}

function hide(pane: Pane): void {
  if (!view || host !== pane) {
    return;
  }
  setHidden(view.root, true);
  // 关掉了（不只是切走）：侧栏不再标选中的那一行。
  if (!pane.specials.includes(VERSION_DIFF_TAB)) {
    notify();
  }
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'vd hidden');
  root.setAttribute('aria-label', '对比');
  const head = el('div', 'vd-head');
  const title = el('span', 'vd-title');
  const meta = el('span', 'vd-meta');
  const button = (cls: string, text: string, tip: string) => {
    const b = el('button', `chip-btn ${cls}`, text);
    b.type = 'button';
    b.title = tip;
    return b;
  };
  const prev = button('vd-prev', '↑ 上一处', '滚到上一处改动');
  const next = button('vd-next', '↓ 下一处', '滚到下一处改动');
  const restore = button('vd-restore', '恢复整份', '把编辑区换成左边这一版（一步撤销，不写盘，存不存由你）');
  const open = button('vd-open', '打开文件', '回到这份文件');
  head.append(title, meta, el('span', 'spacer'), prev, next, restore, open);
  const cols = el('div', 'vd-cols');
  const leftHead = el('div', 'vd-col vd-col-left');
  const rightHead = el('div', 'vd-col vd-col-right');
  cols.append(leftHead, rightHead);
  const body = el('div', 'vd-body');
  root.append(head, cols, body);

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  restore.addEventListener('click', () => {
    if (req && req.left !== 'disk' && req.right === 'now') {
      void restoreVersion(req.path, req.left);
    }
  });
  open.addEventListener('click', () => {
    if (req) {
      paneOwning(req.path)?.activate(req.path);
    }
  });
  view = { root, title, meta, prev, next, restore, open, leftHead, rightHead, body };
  return view;
}

function sideLabel(side: 'left' | 'right'): string {
  if (!req) {
    return '';
  }
  const s = req[side];
  if (s === 'disk') {
    return '磁盘上的（上次保存的）';
  }
  if (s === 'now') {
    const file = paneOwning(req.path)?.files.get(req.path);
    return file && file.draft !== file.text ? '现在（编辑器里，还没保存）' : '现在';
  }
  return s.label;
}

/** 右边是编辑器里那一份时，从编辑区取；那份文件关了是 undefined。左边是磁盘上的同样从编辑区取（它的基线）。 */
function sideText(side: 'left' | 'right'): string | undefined {
  if (!req) {
    return undefined;
  }
  const s = req[side];
  if (s === 'now' || s === 'disk') {
    const file = paneOwning(req.path)?.files.get(req.path);
    return file ? (s === 'now' ? file.draft : file.text) : undefined;
  }
  return side === 'left' ? leftText : rightText;
}

/** 编辑器里那一份能不能改：右边是它时才能用回、恢复。 */
function editable(): boolean {
  return !!req && req.right === 'now' && !!paneOwning(req.path);
}

function render(): void {
  clearTimeout(rediffTimer);
  if (!view || !req) {
    return;
  }
  const v = view;
  const top = v.body.scrollTop;
  v.title.textContent = req.name;
  v.title.title = req.path;
  v.leftHead.textContent = sideLabel('left');
  v.rightHead.textContent = sideLabel('right');
  setHidden(v.restore, !(req.left !== 'disk' && editable()));
  host?.refresh();

  const before = sideText('left');
  const after = sideText('right');
  v.body.replaceChildren();
  shownDiff = undefined;
  const say = (text: string, error = false) => {
    v.meta.textContent = '';
    setNav(0);
    v.body.appendChild(el('p', error ? 'vd-note error' : 'vd-note', text));
  };
  if (loadError) {
    say(loadError, true);
    return;
  }
  if ((req.right === 'now' || req.left === 'disk') && !paneOwning(req.path)) {
    say('这份文件已经关掉了：重新打开它，再在「版本」里点一行。');
    return;
  }
  if (before === undefined || after === undefined) {
    say('载入中…');
    return;
  }

  const diff = diffLines(before, after);
  shownDiff = diff;
  shownRight = after;
  if (diff.changes === 0) {
    say(
      onlyWhitespace(diff)
        ? '只有空白不同（缩进、空行、行尾空格），文字一样。'
        : req.left === 'disk'
          ? '没有还没保存的改动了。'
          : '两边一样。'
    );
    return;
  }
  const changes = diff.blocks.filter((b) => b.kind === 'change');
  let removed = 0;
  let added = 0;
  diff.blocks.forEach((block, k) => {
    if (block.kind === 'same') {
      renderSame(v.body, diff, block, k === 0, k === diff.blocks.length - 1);
      return;
    }
    const counts = renderChange(v.body, diff, block, changes.indexOf(block));
    removed += counts.removed;
    added += counts.added;
  });
  v.meta.textContent = `${changes.length} 处改动 · 删 ${removed} 字 · 加 ${added} 字`;
  if (jumpPending) {
    // 刚换上的：停到第一处（同 VS Code 打开 diff）。
    jumpPending = false;
    current = -1;
    step(1);
    return;
  }
  current = Math.min(current, changes.length - 1);
  setNav(changes.length);
  markCurrent();
  v.body.scrollTop = top;
}

function setNav(count: number): void {
  if (!view) {
    return;
  }
  view.prev.disabled = count === 0 || current <= 0;
  view.next.disabled = count === 0 || current >= count - 1;
}

/** 一截相同的：前后各留 {@link CONTEXT} 行，中间折起来（开头那截只留后面的、结尾那截只留前面的）。 */
function renderSame(body: HTMLElement, diff: LineDiff, block: DiffBlock, first: boolean, last: boolean): void {
  const lines = diff.left.slice(block.left[0], block.left[1]);
  const keepHead = first ? 0 : CONTEXT;
  const keepTail = last ? 0 : CONTEXT;
  const box = el('div', 'vd-same');
  const line = (text: string) => box.appendChild(el('div', 'vd-line', text));
  if (expanded.has(block.left[0]) || lines.length <= keepHead + keepTail + 1) {
    lines.forEach((l) => line(l.text));
  } else {
    lines.slice(0, keepHead).forEach((l) => line(l.text));
    const hidden = lines.length - keepHead - keepTail;
    const fold = el('button', 'vd-fold', `⋯ 相同的 ${hidden} 段 ⋯`);
    fold.type = 'button';
    fold.title = '展开';
    fold.addEventListener('click', () => {
      expanded.add(block.left[0]);
      render();
    });
    box.appendChild(fold);
    lines.slice(lines.length - keepTail).forEach((l) => line(l.text));
  }
  body.appendChild(box);
}

/** 一处改动：左边删的、右边加的，逐字标；底下「用回这一处」。返回删了几个字、加了几个字（不算空白）。 */
function renderChange(body: HTMLElement, diff: LineDiff, block: DiffBlock, index: number): { removed: number; added: number } {
  const a = blockText(diff, block, 'left');
  const b = blockText(diff, block, 'right');
  const marks = charDiff(a, b);
  const box = el('div', 'vd-change');
  box.dataset.change = String(index);
  const side = (cls: string, text: string, ranges: [number, number][] | undefined, tag: 'del' | 'ins') => {
    const cell = el('div', `vd-side ${cls}`);
    if (text === '') {
      cell.appendChild(el('div', 'vd-empty', tag === 'del' ? '（原来没有）' : '（删掉了）'));
      return cell;
    }
    let at = 0;
    for (const lineText of text.split('\n')) {
      const row = el('div', 'vd-line');
      appendMarked(row, lineText, at, ranges ?? [[at, at + lineText.length]], tag);
      cell.appendChild(row);
      at += lineText.length + 1;
    }
    return cell;
  };
  box.append(side('vd-old', a, marks?.left, 'del'), side('vd-new', b, marks?.right, 'ins'));
  if (editable()) {
    const bar = el('div', 'vd-bar');
    const revert = el('button', 'chip-btn vd-revert', '用回这一处');
    revert.type = 'button';
    revert.title = '把编辑区里这一处换回左边那样（一步撤销，不写盘）';
    revert.addEventListener('click', () => revertBlock(index));
    bar.appendChild(revert);
    box.appendChild(bar);
  }
  onContextMenu(box, () => changeMenu(index));
  body.appendChild(box);
  const count = (text: string, ranges: [number, number][] | undefined) =>
    (ranges ? ranges.map(([s, e]) => text.slice(s, e)).join('') : text).replace(/\s+/g, '').length;
  return { removed: count(a, marks?.left), added: count(b, marks?.right) };
}

/** 一行文字（在那一处全文里从 `offset` 开始），落在 `ranges` 里的包进 `<del>` / `<ins>`。 */
function appendMarked(row: HTMLElement, text: string, offset: number, ranges: [number, number][], tag: 'del' | 'ins'): void {
  let pos = 0;
  for (const [s, e] of ranges) {
    const from = Math.max(s - offset, pos);
    const to = Math.min(e - offset, text.length);
    if (to <= from) {
      continue;
    }
    if (from > pos) {
      row.appendChild(document.createTextNode(text.slice(pos, from)));
    }
    row.appendChild(el(tag, undefined, text.slice(from, to)));
    pos = to;
  }
  if (pos < text.length) {
    row.appendChild(document.createTextNode(text.slice(pos)));
  }
}

function changeMenu(index: number): MenuItem[] {
  const items: MenuItem[] = [];
  if (editable()) {
    items.push({ label: '用回这一处', run: () => revertBlock(index) });
  }
  if (req && paneOwning(req.path) && req.right === 'now') {
    items.push({ label: '在编辑器里打开这里', run: () => openHere(index) });
  }
  return items;
}

// ---------------------------------------------------------------- 上一处 / 下一处

function step(delta: number): void {
  const count = shownDiff?.changes ?? 0;
  if (count === 0) {
    return;
  }
  current = Math.max(0, Math.min(count - 1, current + delta));
  setNav(count);
  markCurrent();
  view?.body.querySelector(`.vd-change[data-change="${current}"]`)?.scrollIntoView({ block: 'center' });
}

function markCurrent(): void {
  for (const box of view?.body.querySelectorAll<HTMLElement>('.vd-change') ?? []) {
    box.classList.toggle('current', box.dataset.change === String(current));
  }
}

// ---------------------------------------------------------------- 用回这一处、在编辑器里打开

/** 第 `index` 处改动（按画出来的那一份比较）。编辑器里那份在画完之后又变了：先重比，不拿旧下标改。 */
function changeBlock(index: number): DiffBlock | undefined {
  if (!req || !shownDiff) {
    return undefined;
  }
  if (sideText('right') !== shownRight) {
    render();
    toast('编辑区里这份刚变过，重新比过了：再点一次。');
    return undefined;
  }
  return shownDiff.blocks.filter((b) => b.kind === 'change')[index];
}

function revertBlock(index: number): void {
  const block = changeBlock(index);
  const pane = req && paneOwning(req.path);
  if (!req || !block || !shownDiff || !pane) {
    return;
  }
  const edit = revertEdit(shownDiff, block);
  post({ type: 'saveVersion', path: req.path, quiet: true });
  // 那份文件可能就藏在这个标签后面：切过去改了再切回来（同一个任务里，中间不画）。对比区的滚动位置先记下。
  const top = view?.body.scrollTop ?? 0;
  const back = pane.activeSpecial() === VERSION_DIFF_TAB;
  if (pane.activePath !== req.path) {
    pane.activate(req.path, { focus: false });
  }
  pane.applyEdit(edit.start, edit.end, edit.text, { start: edit.start, end: edit.start + edit.text.length });
  if (back) {
    pane.openSpecial(VERSION_DIFF_TAB, { focus: false });
  }
  render();
  if (view) {
    view.body.scrollTop = top;
  }
}

function openHere(index: number): void {
  const block = changeBlock(index);
  const pane = req && paneOwning(req.path);
  if (!req || !block || !shownDiff || !pane) {
    return;
  }
  const lines = shownDiff.right;
  const [j1, j2] = block.right;
  const start = j2 > j1 ? lines[j1].start : j1 > 0 ? lines[j1 - 1].end : 0;
  const end = j2 > j1 ? lines[j2 - 1].end : start;
  pane.activate(req.path);
  pane.setPreviewing(false);
  pane.area.setSelectionRange(start, end);
  scrollToOffset(pane, start);
}
