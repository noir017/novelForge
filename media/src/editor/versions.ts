/**
 * 侧栏「版本」页（独立版；DOM 在 `shells/shared/panes.ts` 的 `versionsPane`，插件形态不装配）：上面「全书改动」，下面编辑区
 * 当前那份文件的时间线。点一行，编辑区里马上开对比标签（`versionDiff.ts`），不经预览、不弹窗。两块的标题点了收起 / 展开。
 *
 * - **全书改动**（像 VS Code 源代码管理的「更改」）：跟一个存档点比，之后全书改过、新建、删掉的文件，按种类分组
 *   （`artifactKinds.ts`）。缺省跟最近一个**手动**存档点比（自动的批量动作之前都存，太密，比出来常常只剩几份），没有手动的
 *   就跟最近那一个；下拉换别的，换过就一直是它（它被裁掉了才回到缺省）。数据与存档点弹窗同一对消息：`listCheckpoints` →
 *   `checkpoints`、`checkpointDiff` → `checkpointDiff`（只认自己那个存档点的；弹窗要的、退回之后后端重推的，是这个就照收）。
 *   这一页显示着时，后端每推一次 `state`（存盘、批量动作之后都推）停一下再比一次；后端按文件的大小与修改时间记着算过的指纹，
 *   每次比不必整本重读。点一份：存档点里那一份 ↔ 现在（没开着的先开成临时标签）；之后新建的左边是空的、删掉的右边是空的。
 *   **退回不在这里**——那是直接写盘的，留在存档点弹窗里；这里只看、只在编辑区里用回。
 *
 * 当前文件的时间线：
 *
 * - **一条时间线，新的在前**：最上面「还没保存的改动」（编辑器里那份与磁盘上的不一样时才有，比的是磁盘上的 ↔ 编辑器里的）；
 *   然后是快照（网关在每次覆盖之前存的，`core/workspace/history.ts`）与这份文件在各存档点里的样子（◆ 手动、◇ 自动，带备注；
 *   内容一样的连着几个只列最早那一个）混排。每行「3 分钟前 · 14:32」、多少字、比现在多 / 少几个字。
 * - **单击 = 这一版 ↔ 现在**（现在 = 编辑器里那一份，没保存的也算）。右键：跟现在比、跟后一版比（那一次改了什么）、
 *   恢复整份到编辑区。对比标签开着时，它比的那一行标成选中。
 * - **跟着编辑区当前的文件走**：换了文件就换列表；对比标签、别的特殊标签显示着时（那一块没有当前文件）留在原来那份上；
 *   那份文件关掉了才清空。保存之后（`hash` 变了）重拉——网关可能刚存了一版（自动保存几秒一次时攒一攒，一秒最多一次）。
 *   这一页藏着时不拉，切过来时拉一次（存档点可能刚存过）。
 * - **入口**：活动栏「版本」；编辑区工具栏「历史」（每块编辑区一颗，第一次重画时插到「保存」前面，与 `layout.ts` 的「排版」
 *   同一个做法）与标题栏「文件 → 历史版本…」（`view/versionsMenu.ts`，经 `nf-versions-query` / `nf-versions-command`）切到
 *   这一页，窄屏上顺手把编辑区翻下去。没开文件、没打开工程、还不是小说工程、文件不是工程里的创作产物（`kind` 是 `other`）时
 *   那两处置灰，提示里说为什么——前端不拿路径猜，后端也会再判一次（`versions.unavailable`）。
 * - 「＋」（现在存一版）把**磁盘上当前**那一份存一个快照（不是编辑器里没保存的那份）。
 * - 存档点弹窗里的「对比」也开在这里的对比标签上（经 `nf-version-diff-query` / `nf-version-diff-command`）。
 */
import { maybeById, el, setHidden } from '../dom';
import { onContextMenu, showVersionsTab } from '../globals';
import type { CheckpointFileDiffCommand, MenuItem } from '../globals';
import type { CheckpointDiffEntry, CheckpointDiffView, CheckpointView, InMessage, OutMessage, VersionView } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { autoSaveEnabled, onPrefsChange } from './paragraphState';
import { revealEditor, revealSide } from './shell';
import { paneOwning } from './store';
import { KIND_LABEL, KIND_ORDER } from './artifactKinds';
import { currentDiff, installVersionDiff, onDiffChange, openDiff, openFileDiff, restoreVersion } from './versionDiff';
import type { DiffRequest, VersionRef } from './versionDiff';
import { countWords } from './words';

type VersionsMessage = Extract<OutMessage, { type: 'versions' }>;

interface Side {
  root: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  save: HTMLButtonElement;
  refresh: HTMLButtonElement;
}

let post: (msg: InMessage) => void = () => {};
let side: Side | undefined;
/** 列着哪份文件、拉列表时它的 hash（保存之后 hash 变了就重拉）。 */
let target: string | null = null;
let targetHash: string | null = null;
/** undefined = 载入中。 */
let entries: VersionView[] | undefined;
let unavailable: string | undefined;
const buttons = new Map<Pane, HTMLButtonElement>();
/** 后端说过「还不是小说工程」（`ViewState.initialized === false`）。没收到之前不拦，后端会再判一次。 */
let notProject = false;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
/** 当前文件那一块收起来了。 */
let fileCollapsed = false;

/** 全书改动：跟哪个存档点比、比出来什么。 */
const book: {
  /** undefined = 还没拉过。 */
  checkpoints?: CheckpointView[];
  unavailable?: string;
  /** 跟哪个比。 */
  base: string | null;
  /** 作者在下拉里挑过：一直是它，它没了才回到缺省。 */
  picked: boolean;
  /** 比的是 `base`；undefined = 比着呢。 */
  diff?: CheckpointDiffView;
  error?: string;
  collapsed: boolean;
} = { base: null, picked: false, collapsed: false };
/** 后端推了 `state` 之后停多久再比（连着存几次只比一次）。 */
const BOOK_REFRESH_MS = 800;
let bookTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- 纯函数

const pad = (n: number) => String(n).padStart(2, '0');

/** 「3 分钟前 · 14:32」「昨天 · 10-17 21:05」「400 天前 · 2025-03-02 08:00」那种说法。 */
export function describeWhen(time: number, now = Date.now()): string {
  const d = new Date(time);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let rel: string;
  if (days <= 0) {
    rel = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
  } else {
    rel = days === 1 ? '昨天' : `${days} 天前`;
  }
  const abs = days <= 0 ? hm : d.getFullYear() === n.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
  return `${rel} · ${abs}`;
}

/** 「比现在多 120 字」「比现在少 3 字」「与现在字数相同」。 */
export function describeDelta(words: number, current: number): string {
  const delta = words - current;
  return delta === 0 ? '与现在字数相同' : delta > 0 ? `比现在多 ${delta} 字` : `比现在少 ${-delta} 字`;
}

/** 这份文件存不存历史版本；不存给原因。与后端 `historyUnavailable` 同一套说法（后端照样再判一次）。 */
export function unavailableReason(file: Pick<OpenFile, 'kind'> | undefined): string | undefined {
  if (!file) {
    return '没有打开的文件。';
  }
  if (file.kind === undefined) {
    return '没打开工程，不存历史版本。';
  }
  if (notProject) {
    return '这个目录还不是小说工程（没有 .novelforge/），不存历史版本。';
  }
  if (file.kind === 'other') {
    return '这份文件不是工程里的创作产物（章节、草稿、细纲、角色卡、设定、架构、大纲、文风、叙事线……），不存历史版本。';
  }
  return undefined;
}

/** 一行在标题、对比标签上怎么称呼：「3 分钟前 · 14:32 的快照」「存档点「第一卷完」（10-20 22:30）」。 */
export function versionLabel(entry: VersionView, now = Date.now()): string {
  const when = describeWhen(entry.time, now);
  if (!entry.checkpoint) {
    return `${when} 的快照`;
  }
  const kind = entry.checkpoint.auto ? '自动存档点' : '存档点';
  return entry.checkpoint.note ? `${kind}「${entry.checkpoint.note}」（${when}）` : `${kind}（${when}）`;
}

/** 一个存档点在对比标签上怎么称呼（同时间线上存档点那几行）。 */
export function checkpointLabel(cp: Pick<CheckpointView, 'time' | 'note' | 'auto'>, now = Date.now()): string {
  return versionLabel({ id: '', time: cp.time, words: 0, bytes: 0, checkpoint: { note: cp.note, auto: cp.auto } }, now);
}

/** 全书改动跟哪个存档点比的缺省：最近一个手动的，没有就最近那一个（`list` 新的在前）。 */
export function defaultBase(list: readonly Pick<CheckpointView, 'id' | 'auto'>[]): string | null {
  return (list.find((cp) => !cp.auto) ?? list[0])?.id ?? null;
}

/** 文件名去掉扩展名（全书改动里那些多半没开着，没有后端给的称呼）。 */
function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// ---------------------------------------------------------------- 侧栏

/** 标签上的那个称呼（后端给的，章节去掉了扩展名）；没给就是文件名。 */
function nameOf(file: OpenFile): string {
  return file.label?.title ?? file.name;
}

const NOTE =
  '每次覆盖保存之前，磁盘上的旧内容先存成一版（10 分钟内的零星小改并成一版，每份文件留最近 50 版）；◆ ◇ 是存档点里的这一份。' +
  '点一行在编辑区对比；用回、恢复都只换编辑区里的内容，存不存由你。';
/** 自动保存开着时多说的那一句（`autosave.ts`：停笔 2 秒就存）。 */
const AUTOSAVE_NOTE = '自动保存开着：放回编辑区的内容停笔 2 秒就会写回磁盘——被它盖掉的那一版会先存进这里，可以再恢复回来。';

function visible(): boolean {
  return !!side && side.root.classList.contains('active');
}

/** 正看着的那份文件（在哪块编辑区里都行）。 */
function targetFile(): OpenFile | undefined {
  return target ? paneOwning(target)?.files.get(target) : undefined;
}

/** 按当前文件重拉列表（藏着就只记一笔）。 */
function load(): void {
  const file = targetFile();
  targetHash = file?.hash ?? null;
  unavailable = unavailableReason(file);
  // 藏着不拉：切过来时（MutationObserver）再拉。
  if (!visible()) {
    return;
  }
  entries = undefined;
  if (file && !unavailable) {
    post({ type: 'listVersions', path: file.path });
  }
  render();
}

/** 换看哪份文件：编辑区当前的那一份（没有当前文件时留在原来那份上，那份关掉了才清空）。 */
function follow(): void {
  const file = activeEditor()?.file;
  const next = file ? file.path : target && paneOwning(target) ? target : null;
  if (next !== target) {
    target = next;
    entries = undefined;
    load();
  } else if (file && file.hash !== targetHash && !unavailable) {
    // 保存过（或换了基线）：网关可能刚存了一版，重拉。
    targetHash = file.hash;
    relist();
  } else if (visible()) {
    render();
  }
}

function render(): void {
  if (!side) {
    return;
  }
  const file = targetFile();
  side.foot.textContent = autoSaveEnabled() ? `${NOTE}${AUTOSAVE_NOTE}` : NOTE;
  setHidden(side.foot, !file || !!unavailable);
  side.save.disabled = !file || !!unavailable;
  side.body.replaceChildren(bookSection(), fileSection(file));
}

/** 一块的标题：点了收起 / 展开。 */
function sectionHead(title: string, count: string, collapsed: boolean, toggle: () => void, tip = ''): HTMLElement {
  const head = el('button', 'vs-section-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!collapsed));
  head.appendChild(el('span', 'vs-caret', collapsed ? '▸' : '▾'));
  head.appendChild(el('span', 'vs-section-title', title));
  if (count) {
    head.appendChild(el('span', 'vs-count', count));
  }
  head.title = tip || title;
  head.addEventListener('click', () => {
    toggle();
    render();
  });
  return head;
}

// ---------------------------------------------------------------- 全书改动

function bookSection(): HTMLElement {
  const box = el('section', 'vs-section vs-book');
  const count = book.diff ? String(book.diff.entries.length) : '';
  box.appendChild(
    sectionHead('全书改动', count, book.collapsed, () => (book.collapsed = !book.collapsed), '跟一个存档点比，之后全书改过、新建、删掉的文件')
  );
  if (book.collapsed) {
    return box;
  }
  if (book.unavailable) {
    box.appendChild(el('p', 'vs-empty', book.unavailable));
    return box;
  }
  if (!book.checkpoints) {
    box.appendChild(el('p', 'vs-empty', '载入中…'));
    return box;
  }
  if (book.checkpoints.length === 0) {
    box.appendChild(el('p', 'vs-empty', '还没有存档点。存一个之后，这里列出它之后全书改过的文件。'));
    const save = el('button', 'chip-btn vs-book-save', '现在存一个存档点');
    save.type = 'button';
    save.addEventListener('click', () => post({ type: 'createCheckpoint', note: '' }));
    box.appendChild(save);
    return box;
  }
  box.appendChild(baseRow(book.checkpoints));
  if (book.error) {
    box.appendChild(el('p', 'vs-empty error', book.error));
    return box;
  }
  if (!book.diff) {
    box.appendChild(el('p', 'vs-empty', '比着呢…'));
    return box;
  }
  if (book.diff.entries.length === 0) {
    box.appendChild(el('p', 'vs-empty', '跟这个存档点比，全书一字没动。'));
    return box;
  }
  const cp = book.checkpoints.find((c) => c.id === book.base);
  const shown = currentDiff();
  for (const kind of KIND_ORDER) {
    const group = book.diff.entries.filter((e) => e.kind === kind);
    if (group.length === 0) {
      continue;
    }
    box.appendChild(el('div', 'vs-group', `${KIND_LABEL[kind]} ${group.length}`));
    for (const entry of group) {
      box.appendChild(bookRow(entry, cp, shown));
    }
  }
  return box;
}

/** 「跟 [下拉] 比」：新的在前，◆ 手动、◇ 自动。 */
function baseRow(list: CheckpointView[]): HTMLElement {
  const row = el('label', 'vs-base');
  row.appendChild(el('span', undefined, '跟'));
  const select = el('select', 'vs-base-select');
  const now = Date.now();
  for (const cp of list) {
    const text = `${cp.auto ? '◇' : '◆'} ${cp.note || (cp.auto ? '自动存档点' : '存档点')} · ${describeWhen(cp.time, now)}`;
    const option = el('option', undefined, text);
    option.value = cp.id;
    option.selected = cp.id === book.base;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    book.base = select.value;
    book.picked = true;
    book.diff = undefined;
    book.error = undefined;
    post({ type: 'checkpointDiff', id: select.value });
    render();
  });
  row.append(select, el('span', undefined, '比'));
  return row;
}

const STATUS_MARK: Record<CheckpointDiffEntry['status'], string> = { changed: '改', added: '新', deleted: '删' };

function bookRow(entry: CheckpointDiffEntry, cp: CheckpointView | undefined, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', `vs-row vs-change vs-${entry.status}`);
  item.type = 'button';
  item.dataset.path = entry.path;
  const left = cp && entry.status !== 'added' ? { id: `cp:${cp.id}`, label: checkpointLabel(cp) } : ('empty' as const);
  const right = entry.status === 'deleted' ? ('empty' as const) : ('now' as const);
  const selected =
    shown?.path === entry.path && (typeof shown.left === 'string' ? shown.left === left : typeof left !== 'string' && shown.left.id === left.id);
  item.classList.toggle('selected', !!selected);
  const line = el('span', 'vs-when');
  line.append(el('span', 'vs-status', STATUS_MARK[entry.status]), document.createTextNode(baseName(entry.path)));
  item.appendChild(line);
  item.appendChild(el('span', 'vs-meta', bookMeta(entry)));
  item.title = entry.path;
  item.addEventListener('click', () => {
    openFileDiff({ path: entry.path, name: baseName(entry.path), left, right });
    revealEditor();
  });
  return item;
}

function bookMeta(entry: CheckpointDiffEntry): string {
  if (entry.status === 'added') {
    return `之后新建的 · ${entry.wordsNow ?? 0} 字`;
  }
  if (entry.status === 'deleted') {
    return `之后删掉了 · 原来 ${entry.wordsThen ?? 0} 字`;
  }
  const delta = (entry.wordsNow ?? 0) - (entry.wordsThen ?? 0);
  return delta === 0 ? '字数没变' : delta > 0 ? `多了 ${delta} 字` : `少了 ${-delta} 字`;
}

/** 拉存档点列表（列表到了再比）。藏着不拉。 */
function refreshBook(): void {
  clearTimeout(bookTimer);
  if (visible()) {
    post({ type: 'listCheckpoints' });
  }
}

function onCheckpoints(msg: Extract<OutMessage, { type: 'checkpoints' }>): void {
  book.checkpoints = msg.entries;
  book.unavailable = msg.unavailable;
  const keep = book.picked && msg.entries.some((cp) => cp.id === book.base);
  const base = keep ? book.base : defaultBase(msg.entries);
  if (!keep) {
    book.picked = false;
  }
  if (base !== book.base) {
    book.base = base;
    book.diff = undefined;
    book.error = undefined;
  }
  if (base && visible()) {
    post({ type: 'checkpointDiff', id: base });
  }
  if (!base) {
    book.diff = undefined;
  }
  render();
}

function onCheckpointDiff(msg: Extract<OutMessage, { type: 'checkpointDiff' }>): void {
  if (msg.id !== book.base) {
    return;
  }
  book.diff = msg.diff;
  book.error = msg.diff ? undefined : (msg.error ?? '没比出来。');
  render();
}

/** 存档点弹窗里「对比」一份：开在对比标签上。 */
function openCheckpointFile(cmd: CheckpointFileDiffCommand): void {
  const label = checkpointLabel(cmd.checkpoint);
  openFileDiff({
    path: cmd.path,
    name: baseName(cmd.path),
    left: cmd.status === 'added' ? 'empty' : { id: `cp:${cmd.checkpoint.id}`, label },
    right: cmd.status === 'deleted' ? 'empty' : 'now',
  });
  revealEditor();
}

// ---------------------------------------------------------------- 当前文件

function fileSection(file: OpenFile | undefined): HTMLElement {
  const box = el('section', 'vs-section vs-timeline');
  const head = sectionHead(file ? nameOf(file) : '当前文件', '', fileCollapsed, () => (fileCollapsed = !fileCollapsed), file?.path);
  head.classList.add('vs-file');
  box.appendChild(head);
  if (fileCollapsed) {
    return box;
  }
  if (!file) {
    box.appendChild(el('p', 'vs-empty', '没有打开的文件。在编辑区打开一份稿子，这里列出它存下的各版。'));
    return box;
  }
  if (unavailable) {
    box.appendChild(el('p', 'vs-empty', unavailable));
    return box;
  }
  const shown = currentDiff();
  if (file.draft !== file.text) {
    box.appendChild(unsavedRow(file, shown));
  }
  if (!entries) {
    box.appendChild(el('p', 'vs-empty', '载入中…'));
    return box;
  }
  if (entries.length === 0) {
    box.appendChild(
      el(
        'p',
        'vs-empty',
        '还没有存下的版本。第一次覆盖保存这份文件时（编辑器里保存、重写、修稿、同步……），磁盘上的旧内容会先存成一版；' +
          '也可以点上面的「＋」把磁盘上现在这一份先存下来。存档点里有它的话，也列在这里。'
      )
    );
    return box;
  }
  const current = countWords(file.draft);
  const now = Date.now();
  entries.forEach((entry, i) => box.appendChild(row(file, entry, i, current, now, shown)));
  return box;
}

function unsavedRow(file: OpenFile, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', 'vs-row vs-unsaved');
  item.type = 'button';
  item.classList.toggle('selected', shown?.path === file.path && shown.left === 'disk');
  item.appendChild(el('span', 'vs-when', '● 还没保存的改动'));
  item.appendChild(el('span', 'vs-meta', describeDelta(countWords(file.draft), countWords(file.text)).replace('现在', '磁盘上')));
  item.title = '磁盘上的（上次保存的）↔ 编辑器里的';
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: 'disk', right: 'now' });
    revealEditor();
  });
  return item;
}

function row(file: OpenFile, entry: VersionView, index: number, current: number, now: number, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', entry.checkpoint ? 'vs-row vs-checkpoint' : 'vs-row');
  item.type = 'button';
  item.dataset.id = entry.id;
  const selected = shown?.path === file.path && typeof shown.left !== 'string' && shown.left.id === entry.id;
  item.classList.toggle('selected', selected);
  const when = el('span', 'vs-when', describeWhen(entry.time, now));
  if (entry.checkpoint) {
    when.prepend(el('span', 'vs-mark', entry.checkpoint.auto ? '◇ ' : '◆ '));
  }
  item.appendChild(when);
  item.appendChild(el('span', 'vs-meta', `${entry.words} 字 · ${describeDelta(entry.words, current)}`));
  if (entry.checkpoint) {
    item.appendChild(el('span', 'vs-note', entry.checkpoint.note || (entry.checkpoint.auto ? '自动存档点' : '存档点')));
  }
  item.title = entry.checkpoint
    ? `${versionLabel(entry, now)}里的这一份`
    : `这一版在 ${new Date(entry.time).toLocaleString()} 被覆盖掉之前在磁盘上`;
  const ref = (): VersionRef => ({ id: entry.id, label: versionLabel(entry, Date.now()) });
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
    revealEditor();
  });
  onContextMenu(item, () => rowMenu(file, index, ref));
  return item;
}

function rowMenu(file: OpenFile, index: number, ref: () => VersionRef): MenuItem[] {
  const newer = index > 0 ? entries?.[index - 1] : undefined;
  return [
    {
      label: '跟现在比',
      run: () => {
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
        revealEditor();
      },
    },
    {
      // 最新的那一版，后面一版就是现在。
      label: '跟后一版比（那一次改了什么）',
      run: () => {
        const right = newer ? { id: newer.id, label: versionLabel(newer) } : ('now' as const);
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right });
        revealEditor();
      },
    },
    { sep: true },
    { label: '恢复整份到编辑区', run: () => void restoreVersion(file.path, ref()) },
  ];
}

/** 保存之后重拉列表：离上一次不到一秒就挪到一秒之后（只发最后那一次）。 */
const RELIST_GAP_MS = 1000;
let relistLast = 0;
let relistTimer: ReturnType<typeof setTimeout> | undefined;

function relist(): void {
  clearTimeout(relistTimer);
  if (!visible()) {
    return;
  }
  const send = () => {
    relistTimer = undefined;
    relistLast = Date.now();
    if (target && !unavailable && visible()) {
      post({ type: 'listVersions', path: target });
    }
  };
  const wait = relistLast + RELIST_GAP_MS - Date.now();
  if (wait <= 0) {
    send();
  } else {
    relistTimer = setTimeout(send, wait);
  }
}

function onVersions(msg: VersionsMessage): void {
  if (msg.path !== target) {
    return;
  }
  entries = msg.entries;
  unavailable = msg.unavailable;
  render();
}

// ---------------------------------------------------------------- 工具栏「历史」

/** 切到「版本」页看这一块的那份文件（窄屏上顺手把编辑区翻下去）。 */
function showFor(pane: Pane | undefined): void {
  const file = pane?.activeFile();
  if (file && file.path !== target) {
    target = file.path;
    entries = undefined;
  }
  showVersionsTab();
  revealSide();
  load();
}

/** 每块编辑区一颗，第一次重画时插到「保存」前面。 */
function syncButton(pane: Pane): void {
  let btn = buttons.get(pane);
  if (!btn) {
    const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
    if (!toolbar) {
      return;
    }
    btn = el('button', 'chip-btn ed-versions-btn', '历史');
    btn.type = 'button';
    btn.addEventListener('click', () => showFor(pane));
    toolbar.insertBefore(btn, toolbar.querySelector('button.primary'));
    buttons.set(pane, btn);
  }
  const reason = unavailableReason(pane.activeFile());
  btn.disabled = !!reason;
  btn.title = reason ?? '历史版本：在侧栏「版本」页列出这份文件存下的各版，点一行在编辑区对比';
}

// ---------------------------------------------------------------- 装

export function installVersions(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  installVersionDiff(postMessage);

  const root = maybeById('pane-versions');
  if (root) {
    side = {
      root,
      body: maybeById('versionsBody')!,
      foot: maybeById('versionsFoot')!,
      save: maybeById('versionsSave') as HTMLButtonElement,
      refresh: maybeById('versionsRefresh') as HTMLButtonElement,
    };
    side.save.addEventListener('click', () => {
      if (target) {
        post({ type: 'saveVersion', path: target });
      }
    });
    side.refresh.addEventListener('click', () => {
      load();
      refreshBook();
    });
    // 切到这一页（活动栏、工具栏「历史」）：拉一次——藏着时换过文件、保存过，存档点也可能刚存过。
    new MutationObserver(() => {
      if (visible()) {
        load();
        refreshBook();
      }
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    render();
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      syncButton(ev.pane);
      follow();
      return;
    }
    // 打字：「还没保存的改动」那一行有没有、「比现在多 / 少几个字」跟着变，攒一下再画。
    if (ev.file.path === target && visible()) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 300);
    }
  });
  onDiffChange(() => {
    if (visible()) {
      render();
    }
  });

  onMessage((msg) => {
    if (msg.type === 'versions') {
      onVersions(msg);
    } else if (msg.type === 'checkpoints') {
      onCheckpoints(msg);
    } else if (msg.type === 'checkpointDiff') {
      onCheckpointDiff(msg);
    } else if (msg.type === 'init' || msg.type === 'state') {
      // 磁盘上可能变过（存盘、批量动作、退回）：显示着就停一下再比一次全书。
      if (visible()) {
        clearTimeout(bookTimer);
        bookTimer = setTimeout(refreshBook, BOOK_REFRESH_MS);
      }
      const was = notProject;
      notProject = msg.state.initialized === false;
      if (was !== notProject) {
        for (const pane of [...buttons.keys()]) {
          syncButton(pane);
        }
        load();
      }
    }
  });

  // 「文件 → 自动保存」切了：底下那句说明跟着变。
  onPrefsChange(() => {
    if (visible()) {
      render();
    }
  });

  window.addEventListener('nf-versions-query', (e) => {
    const reason = unavailableReason(activeEditor()?.file);
    e.detail.available = !reason;
    e.detail.reason = reason;
  });

  window.addEventListener('nf-versions-command', (e) => {
    const ed = activeEditor();
    if (e.detail.name === 'open' && ed && !unavailableReason(ed.file)) {
      showFor(ed.pane);
    }
  });

  // 存档点弹窗里的「对比」：只有这里画得了对比标签（插件形态没有 editor.js，没人回答，按钮就不给）。
  window.addEventListener('nf-version-diff-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-version-diff-command', (e) => openCheckpointFile(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    target = null;
    targetHash = null;
    entries = undefined;
    unavailable = undefined;
    clearTimeout(bookTimer);
    Object.assign(book, { checkpoints: undefined, unavailable: undefined, base: null, picked: false, diff: undefined, error: undefined });
    render();
  });
}
