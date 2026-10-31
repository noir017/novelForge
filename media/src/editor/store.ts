/**
 * 两块编辑区之间共享的那点东西：登记表、当前是哪一块、待恢复的草稿，
 * 以及刷新恢复用的 localStorage 读写。
 *
 * 单独一层的理由是打破环：`pane.ts`（一块编辑区的行为）要调 `persist()`、
 * 要认下自己是 activePane；而「有哪几块」这件事又得等 pane 造出来才知道。
 * 把状态放这儿，方向就只剩 index → pane → store 一条。
 */
import { announceEditorActive, projectStorageKey } from '../globals';
import type { MenuItem } from '../globals';
import type { EditorFileView, EditorOpenIntent, InMessage } from '../protocol';
import type { TextSelection } from './history';
import type { CarriedDraft, OpenFile, PaneId } from './paneElements';

/** `Pane.applyEdit` 的选项。 */
export interface ApplyEditOptions {
  /**
   * 并进上一步撤销，而不是另起一步——例如成对标点补上的后半个，撤销时与前半个一起退。
   * 只往**刚记下的那一步**里并：上一步不存在、或中间撤销 / 重做过时照常另起一步。
   */
  join?: boolean;
  /**
   * 这一下是作者在名词补全里挑了一个名字（`names.ts`）：`edit` 事件的 `source` 报 `completion` 而不是 `program`，
   * 码字统计据此当作者打的字算（⚑，见 `writingStats.ts`）。别的程序改写不给。
   */
  source?: 'completion';
}

/** 一块编辑区对外的样子。createPane 的返回值实现它。 */
export interface Pane {
  readonly id: PaneId;
  /** 这块区的根节点，供整块显示/隐藏。 */
  readonly root: HTMLElement;
  /**
   * 这块区的 textarea（所有标签共用一个，显示的是当前文件）。**只读**它的 value 与选区；
   * 改内容一律走 `applyEdit`，直接写 `value` 会绕过撤销记账与脏标记。
   */
  readonly area: HTMLTextAreaElement;
  readonly files: Map<string, OpenFile>;
  activePath: string | null;
  activeFile(): OpenFile | undefined;
  /** 当前这一份是不是在 Markdown 预览里（textarea 藏着，收不到按键）。每个标签各记各的（`OpenFile.markdownPreview`）。 */
  isPreviewing(): boolean;
  /** 当前这一份有没有 Markdown 可预览（`.md` / `.markdown`）。 */
  canPreview(): boolean;
  /**
   * 当前这一份切到预览 / 切回编辑，两边滚到同一处（编辑区视口顶上那一行 ↔ 预览里对应的那一块，`previewSync.ts`）。
   * 要「先切回编辑」的地方（查找、体检、对比合并、点引文……）调 `setPreviewing(false)`——`activate` 只切标签、不改预览。
   * 没开文件、要预览的不是 Markdown 时返回 false。`focus: false`：焦点不动（缺省进正文区 / 预览）。
   */
  setPreviewing(on: boolean, opts?: { focus?: boolean }): boolean;
  hasDirty(): boolean;
  snapshot(): PaneSnapshot;
  /**
   * 切到这份文件（认下这一块、焦点进正文区；这一份在预览里就照旧在预览里、焦点进预览）。`focus: false`：只换这一块显示的
   * 那份，不抢「当前这一块」与焦点。
   */
  activate(path: string, opts?: { focus?: boolean }): void;
  /** 关一个标签。有未保存的修改时先问「保存 / 不保存 / 取消」（`closing.ts`），所以可能过一会儿才关、或者不关。 */
  closeFile(path: string): void;
  /** 关掉这几份，不再问（`closing.ts` 已经问过了）。不在这块里的跳过。 */
  discard(paths: string[]): void;
  /**
   * 不问不提示地移走一个文件。用于「同一路径被另一块编辑区接管」——
   * 那不是关闭，是搬家：返回要带过去的东西（未保存内容与撤销历史）好让新的一块接上；
   * 没开着这个文件时返回 false。
   */
  closeSilently(path: string): CarriedDraft | false;
  /**
   * 「移到另一侧」的搬出一半：不经后端，把这份文件连同未保存内容、撤销历史、冲突条、「磁盘上没了」、
   * 光标一起交出来（`carried.local`），`view` 是它此刻的基线（不重读磁盘）。没开着时 undefined。
   */
  moveOut(path: string): { view: EditorFileView; carried: CarriedDraft } | undefined;
  /**
   * 收一份文件（`editorOpen`，或「移到另一侧」从另一块搬来）。`intent` 是打开请求上带的那两个标记，
   * 后端原样带回：`preview` 开成临时标签（换掉这一块现有的临时标签），`replace` 没改过就在原位置换掉那一份。
   */
  upsertFile(incoming: EditorFileView, carried?: CarriedDraft, intent?: EditorOpenIntent): void;
  /** 临时标签转正（双击标签、右键「固定」、关掉「单击打开为临时标签」）。不是临时的什么都不做。 */
  pin(path: string): void;
  /**
   * **编辑区里唯一的程序改写入口**（缩进、成对标点、一键排版、全部替换、剪切 / 粘贴……都走它，
   * 不许直接写 `textarea.value`）。作用于这块区的**当前文件**。
   *
   * - **范围**：把 `[start, end)` 换成 `text`。位置按编辑区里**当下显示的文字**算，即
   *   `area.value` 的下标（与 `selectionStart` / `selectionEnd` 同一套）；越界的夹进去，
   *   `start > end` 时对调。整份替换就传 `0, area.value.length`。`text` 里的 `\r\n` / `\r`
   *   归一成 `\n`（textarea 只认 `\n`）。
   * - **选区**：`selection` 是改完之后的选区，位置按**新文字**算；缺省是光标落在插入文字末尾
   *   （`start + text.length`）。越界的夹进去。
   * - **撤销**：一次调用记**一步**，不与前后的打字合并（`opts.join` 例外，见 `ApplyEditOptions`）。
   *   撤销回到改之前的文字与改之前的选区，重做回到改之后的文字与 `selection`。
   * - **其余**：同时更新 `file.draft`、脏标记、状态栏、标签圆点、草稿持久化，清掉过期的冲突条，
   *   并发一条 `onEditorChange` 的 `edit`（`source: 'program'`；名词补全给了 `opts.source` 时是 `completion`）。
   *   预览模式下也能用，预览跟着重画。
   *
   * 返回内容是否真的变了：没开文件、或替换前后一字不差时返回 false（这时只设选区，不记撤销）。
   */
  applyEdit(start: number, end: number, text: string, selection?: TextSelection, opts?: ApplyEditOptions): boolean;
  /** 撤销当前文件的一步。没有可撤销的返回 false。 */
  undo(): boolean;
  /** 重做当前文件的一步。没有可重做的返回 false。 */
  redo(): boolean;
  save(force: boolean): void;
  /** 保存这一份（经 `saving.ts`：同一份同一时刻只有一个保存在路上；磁盘上没了的先问要不要重建）。 */
  savePath(path: string, force: boolean): void;
  /**
   * 切到这份文件、选中这一句并滚到它（五期：点审稿报告上的引文）。定位按 `locateQuote`——与后端
   * 校验引文同一个归一化。找不到返回 false。
   */
  reveal(path: string, quote: string): boolean;
  applySaved(incoming: EditorFileView): void;
  applyConflict(path: string, diskText: string, diskHash: string): void;
  /**
   * 磁盘上这一份变了（`editorDiskChanged`；或别的窗口存了它，那条 `editorSaved` 不是这边要的）。
   * 没改过的标签就地换成新内容（记一步撤销、光标与滚动夹进新长度、正看着的在状态栏说一句），
   * 改过的一个字不动、挂冲突条、标签上标出来。**不切标签、不抢焦点。**
   */
  applyDiskChange(incoming: EditorFileView): void;
  /** 磁盘上已经没有这一份了（`editorDiskGone`）：标签标成已删除，正在路上的那次保存就此作罢。 */
  markGone(path: string): void;
  /**
   * 编辑器知道的这一份在磁盘上的 hash，核对磁盘时带给后端：标成已删除的给空串（磁盘上又出现了就会回话），
   * 见过一份还没载入的磁盘新版就给那一份的（同一个新版不必再报一次），否则是保存基线。
   */
  knownDiskHash(path: string): string;
  /** 重画标签与状态栏（保存状态变了，`saving.ts` 调）。 */
  refresh(): void;
  /**
   * 换掉这份文件的乐观锁基线（`text` / `hash`，即「磁盘上是什么」），并收起它的冲突条。编辑区里的内容
   * 不动。冲突时「对比合并」采纳之后用（`editor/replace.ts`）：作者看过了磁盘上的那一份，之后照常保存。
   */
  rebase(path: string, text: string, hash: string): void;
  /** 这一块开着的特殊标签（不对应文件，见 {@link SpecialTab}），按打开的先后。 */
  readonly specials: readonly string[];
  /**
   * 正显示着的特殊标签。显示它的时候这一块**没有当前文件**（`activePath` 是 null、`activeFile()` 是 undefined）：
   * 保存、查找、体检、历史版本这些「对当前文件做事」的都当这一块没开文件，不会对着藏在后面的那一份动手。
   */
  activeSpecial(): string | null;
  /**
   * 打开（已经开着就切到）一个特殊标签。同一个特殊标签同一时刻只在一块里：开在另一块里的先从那边拿走（同「一个路径只属于
   * 一块」）。`focus: false`：不认下「当前这一块」；`background`：只把标签放上标签条、不切过去（刷新恢复那些没在显示的）；
   * `restoring`：刷新恢复时打开的，不写 localStorage（文件还没回来，这时写下去会把它们从待恢复的清单里冲掉）。
   */
  openSpecial(id: string, opts?: { focus?: boolean; background?: boolean; restoring?: boolean }): void;
  /**
   * 关掉一个特殊标签；它正显示着就回到切过去之前的那份文件（还开着的话，否则最后一份）。`quiet`：换工程时一并关掉，
   * 不写 localStorage、不广播。
   */
  closeSpecial(id: string, opts?: { quiet?: boolean }): void;
}

export interface PaneSnapshot {
  open: { path: string; hash: string; draft?: string; preview?: boolean; markdownPreview?: boolean }[];
  /** 当前那份文件。特殊标签正显示着时是切过去之前的那一份（关掉特殊标签回到它）。 */
  active: string | null;
  /** 开着的特殊标签（叙事线总览，三期）。 */
  specials?: string[];
  /** 正显示着的特殊标签。 */
  special?: string;
}

// ---------------------------------------------------------------- 特殊标签

/**
 * 编辑区里**不对应文件**的标签（叙事线重做三期：「叙事线总览」；之后有「时间线总览」与「版本」的对比标签）。编辑区原本
 * 只认文件——标签就是一份打开的文件、显示的是 textarea——这是给它开的唯一一道口子：`pane.ts` 只认这个接口，不知道里面
 * 画的是什么；画的东西挂在这一块的 `.ed-stage` 上，盖住正文区（模块自己现造、自己藏）。
 *
 * - 标签排在文件标签前面，写 `label().title`，没有脏标记；点了切过去、× 与中键关掉、右键「关闭」加 `menu()` 给的几项。
 * - 切过去时这一块没有当前文件（见 `Pane.activeSpecial`）；切回一份文件、或从别处打开一份文件到这一块，它就藏起来。
 * - 刷新记着（`PaneSnapshot.specials` / `special`），恢复时先于文件打开，陆续回来的文件不把正显示着的它换下去；`transient` 的不记。
 */
export interface SpecialTab {
  /** 稳定的 id，记进 localStorage。 */
  readonly id: string;
  /** 标签上写什么、悬停看什么。 */
  label(): { title: string; tip: string };
  /** 这一块要显示它：挂上覆盖层（第一次现造）、露出来。每次重画都会调，要便宜、可以重复调。 */
  show(pane: Pane): void;
  /** 这一块不再显示它（切到了一份文件、关掉了、搬到了另一块）。 */
  hide(pane: Pane): void;
  /** 标签右键「关闭」之后的那几项。 */
  menu?(pane: Pane): MenuItem[];
  /** 不进刷新恢复（「版本」的对比标签：看的是哪两版只在这一页里记着，刷新之后没有可画的）。 */
  readonly transient?: boolean;
}

const specialTabs = new Map<string, SpecialTab>();

/** 登记一种特殊标签（模块装的时候）。 */
export function registerSpecialTab(tab: SpecialTab): void {
  specialTabs.set(tab.id, tab);
}

export function specialTabOf(id: string): SpecialTab | undefined {
  return specialTabs.get(id);
}

/** 哪一块开着这个特殊标签。同一时刻至多一块。 */
export function paneWithSpecial(id: string): Pane | undefined {
  return Object.values(panes).find((p) => p.specials.includes(id));
}

const STORE_KEY = 'novelforge.editor.v1';

/** path -> 待恢复的未保存内容，等对应的 editorOpen 到达时消费。 */
export const pendingDrafts = new Map<string, CarriedDraft>();

/** paneId -> 恢复完成后应该激活的 path。 */
export const pendingActive = new Map<PaneId, string | null>();

/** 已经造出来的编辑区。草稿区惰性创建，一开始只有主区。 */
export const panes: Partial<Record<PaneId, Pane>> = {};

/** 把新造的一块登记进来。造与登记分开，createPane 就不必知道这张表。 */
export function registerPane(pane: Pane): Pane {
  panes[pane.id] = pane;
  return pane;
}

/** 由 index.ts 在启动时装上。 */
let post: (msg: InMessage) => void = () => {};
/** 草稿区没有打开的文件时，连同那条分隔条一起收起来。 */
let draftResizer: HTMLElement | undefined;
/** 第二块编辑区惰性创建：要往那里搬东西的模块（「移到另一侧」）经它拿，没有就现造。 */
let makePane: (id: PaneId) => Pane = (id) => panes[id]!;

export function bindStore(deps: {
  post: (msg: InMessage) => void;
  draftResizer: HTMLElement;
  ensurePane?: (id: PaneId) => Pane;
}): void {
  post = deps.post;
  draftResizer = deps.draftResizer;
  if (deps.ensurePane) {
    makePane = deps.ensurePane;
  }
}

/** 另一块编辑区。`create`：第二块还没造出来时现造（往那边搬东西时）；否则没有就是 undefined。 */
export function otherPane(pane: Pane, create = false): Pane | undefined {
  const id: PaneId = pane.id === 'main' ? 'draft' : 'main';
  return panes[id] ?? (create ? makePane(id) : undefined);
}

/** 两块编辑区里开着的全部文件（标签上同名的要放在一起比，见 `tabLabels.ts`）。 */
export function allOpenFiles(): OpenFile[] {
  return Object.values(panes).flatMap((p) => [...p.files.values()]);
}

/**
 * 一块的文件开了 / 关了，另一块的标签可能要改写法（同名的区分目录）。开着的每一块都重画一遍标签
 * （`Pane.refresh`：只画标签与状态栏，正文不动）。
 */
export function refreshOtherTabs(except: Pane): void {
  for (const pane of Object.values(panes)) {
    if (pane !== except) {
      pane.refresh();
    }
  }
}

// ---------------------------------------------------------------- 关掉之后的光标与滚动

/**
 * 关掉的（含被换掉的临时标签、搬去另一块的）文件最后的光标与滚动：这一页里再打开它时放回去，不从顶上重新找。
 * 单击浏览章节时临时标签一直在被换掉，回到看过的那一章应该还在原处。按路径记、两块共用，不进 localStorage。
 */
export interface FileView {
  caret: number;
  scrollTop: number;
}

const VIEW_LIMIT = 100;
const closedViews = new Map<string, FileView>();

export function rememberView(path: string, view: FileView): void {
  closedViews.delete(path);
  closedViews.set(path, view);
  if (closedViews.size > VIEW_LIMIT) {
    closedViews.delete(closedViews.keys().next().value!);
  }
}

/** 取走这份文件关掉时记下的光标与滚动（取一次就没了：开着时由 `OpenFile` 自己记）。 */
export function takeView(path: string): FileView | undefined {
  const view = closedViews.get(path);
  closedViews.delete(path);
  return view;
}

// ---------------------------------------------------------------- 最近关闭

/** 最近关掉的标签，**按块记**（最新的在最后）。只记作者亲手关的（关标签、关闭其它……），搬家、换掉临时标签不算。 */
export interface ClosedTab {
  path: string;
  pane: PaneId;
  /** 关掉那一刻标签上写的名字（「▾」列表与右键菜单上说「重新打开 003-夜访」）。 */
  title: string;
}

const CLOSED_LIMIT = 20;
const closedTabs: ClosedTab[] = [];

export function noteClosed(entry: ClosedTab): void {
  forgetClosed(entry.path);
  closedTabs.push(entry);
  if (closedTabs.length > CLOSED_LIMIT) {
    closedTabs.shift();
  }
}

/** 又开着了（不论从哪条路）：从最近关闭里拿掉。 */
export function forgetClosed(path: string): void {
  const i = closedTabs.findIndex((c) => c.path === path);
  if (i >= 0) {
    closedTabs.splice(i, 1);
  }
}

/** 这一块最近关掉的那一个。 */
export function lastClosed(pane: PaneId): ClosedTab | undefined {
  for (let i = closedTabs.length - 1; i >= 0; i--) {
    if (closedTabs[i].pane === pane) {
      return closedTabs[i];
    }
  }
  return undefined;
}

/** 最近关掉的几个，新的在前。 */
export function recentClosed(limit = 8): ClosedTab[] {
  return closedTabs.slice(-limit).reverse();
}

/** 重新打开：开回它原来那一块（正常标签）。 */
export function reopenClosed(entry: ClosedTab): void {
  forgetClosed(entry.path);
  post({ type: 'openEditor', path: entry.path, pane: entry.pane });
}

/** 换工程：上一个工程关掉的那些不再有意义。 */
export function clearClosed(): void {
  closedTabs.length = 0;
}

/** 发一条消息给后端（不在某一块编辑区里的模块用：保存、核对磁盘）。 */
export function postToHost(msg: InMessage): void {
  post(msg);
}

/** 当前这一块——Ctrl+S / Ctrl+W 作用于它。 */
export let activePane: Pane;

export function setActivePane(pane: Pane): void {
  activePane = pane;
}

/**
 * 广播「现在编辑的是哪个文件」。资源管理器据此高亮那一行。
 *
 * `activePane` 每次易主都要跟一句，否则高亮会停在上一个文件上。
 */
export function announceActive(): void {
  const file = activePane?.activeFile();
  announceEditorActive(file ? file.path : null);
}

/** 哪一块编辑区持有这个路径。单 pane 拥有权保证结果唯一。 */
export function paneOwning(path: string): Pane | undefined {
  for (const pane of Object.values(panes)) {
    if (pane.files.has(path)) {
      return pane;
    }
  }
  return undefined;
}

/** 草稿区里没有打开的文件（也没有特殊标签）时整块收起来，连同那条分隔条。 */
export function syncDraftVisibility(): void {
  const draft = panes.draft;
  const open = !!draft && (draft.files.size > 0 || draft.specials.length > 0);
  draft?.root.classList.toggle('hidden', !open);
  draftResizer?.classList.toggle('hidden', !open);
}

// ---------------------------------------------------------------- 持久化

/**
 * 刷新页面不该丢掉未保存的修改——浏览器里 F5 太容易按到。
 * 存的是草稿与基线 hash，重连后重新拉一次文件再比对。
 */
export function persist(): void {
  try {
    const data = {
      v: 2,
      panes: Object.fromEntries(
        Object.entries(panes).map(([id, pane]) => [id, pane.snapshot()])
      ),
      activePane: activePane?.id,
    };
    localStorage.setItem(projectStorageKey(STORE_KEY), JSON.stringify(data));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，丢了也不影响主流程 */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** 敲字时每次都写 localStorage 太浪费，攒一下。 */
export function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

/** 换工程时：攒着的那一次不写了——它记的是上一个工程的标签页，写下去会落到新工程的键上。 */
export function cancelScheduledPersist(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
}

/**
 * 刷新后重开上次的标签页。
 *
 * 这里只发 `openEditor`、把草稿记进 `pendingDrafts`；真正贴回去由
 * `upsertFile` 在文件到达时做，并且要比对 hash——磁盘变过就丢弃草稿，
 * 不拿旧内容盖新内容。
 */
export function restore(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(projectStorageKey(STORE_KEY)) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') {
    return;
  }
  const raw = saved as { open?: unknown; active?: unknown; panes?: unknown };
  type StoredPane = { open?: unknown; active?: unknown; specials?: unknown; special?: unknown };

  // v1 只有一块编辑区，形状是 { open, active }——老用户的标签页不该在
  // 升级后凭空消失，按主区读进来。
  const stored: Record<string, StoredPane> = Array.isArray(raw.open)
    ? { main: { open: raw.open, active: raw.active } }
    : ((raw.panes as Record<string, StoredPane>) ?? {});

  for (const paneId of ['main', 'draft'] as const) {
    const data = stored[paneId];
    // 特殊标签（叙事线总览）：认得出的才开、同一个只开一次（记坏了的、改过名的不认，至多少一个标签，不崩）。
    const specials = Array.isArray(data?.specials)
      ? (data!.specials as unknown[]).filter(
          (id): id is string => typeof id === 'string' && !!specialTabOf(id) && !paneWithSpecial(id)
        )
      : [];
    const hasFiles = !!data && Array.isArray(data.open) && data.open.length > 0;
    if (!data || (!hasFiles && specials.length === 0)) {
      continue;
    }
    // 先开特殊标签：正显示着的那一个先切过去，之后陆续回来的文件不把它换下去（`claimActivePath`）。
    const shown = typeof data.special === 'string' && specials.includes(data.special) ? data.special : undefined;
    if (specials.length > 0) {
      const pane = makePane(paneId);
      for (const id of specials) {
        pane.openSpecial(id, { focus: false, restoring: true, background: id !== shown });
      }
    }
    if (!hasFiles) {
      continue;
    }
    pendingActive.set(paneId, typeof data.active === 'string' ? data.active : null);
    for (const item of data.open as { path?: unknown; hash?: unknown; draft?: unknown; preview?: unknown; markdownPreview?: unknown }[]) {
      if (!item || typeof item.path !== 'string') {
        continue;
      }
      // 临时标签记着（⚑）：刷新前斜体的那一个，刷新后还是它。在预览里的也照旧在预览里（⚑）。
      // 两个标记都只记在前端，不随打开请求发出去。
      pendingDrafts.set(item.path, {
        hash: typeof item.hash === 'string' ? item.hash : undefined,
        draft: typeof item.draft === 'string' ? item.draft : undefined,
        preview: item.preview === true,
        markdownPreview: item.markdownPreview === true,
      });
      post({ type: 'openEditor', path: item.path, pane: paneId });
    }
  }
}

/**
 * 文件改名/搬家后，把 localStorage 里的旧路径条目改写成新路径，草稿不丢。
 * 读不下/写不进都无所谓，最坏退化为丢一次刷新恢复。
 */
export function rekeyStorage(from: string, to: string): void {
  try {
    const data = JSON.parse(localStorage.getItem(projectStorageKey(STORE_KEY)) || 'null');
    if (!data?.panes) {
      return;
    }
    for (const paneData of Object.values(data.panes) as { open?: unknown; active?: unknown }[]) {
      if (Array.isArray(paneData?.open)) {
        for (const item of paneData.open as { path?: string }[]) {
          if (item?.path === from) {
            item.path = to;
          }
        }
      }
      if (paneData?.active === from) {
        paneData.active = to;
      }
    }
    localStorage.setItem(projectStorageKey(STORE_KEY), JSON.stringify(data));
  } catch {
    /* 同上 */
  }
}
