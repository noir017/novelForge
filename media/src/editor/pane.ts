/**
 * 一块编辑区。两块（正文 / 草稿）是这个工厂的两个实例，各自持有自己的
 * 文件表、冲突表与当前路径（预览还是编辑按文件记），互相不读对方的内部字段——
 * 它们之间只通过 store.ts 的 `panes` 表与 `paneOwning()` 打交道。
 *
 * 保存带**内容 hash 乐观锁**：磁盘上的 hash 与编辑器基线不一致（作者在别处
 * 改过、或插件写入过）时保存被拒，弹冲突条让用户在「用磁盘版本覆盖编辑器」
 * 和「用编辑器内容强制保存」之间选。只有明确点了「强制保存」（页内对话框里再确认一次）
 * 才会发不带 `baseHash` 的 saveFile。
 *
 * **不丢稿那几样不在这里写**：保存本身（同一份只有一个在路上、状态栏的保存状态、磁盘上没了先问）
 * 经 `saving.ts`，关标签时的三选一经 `closing.ts`，对话框是 `dialog.ts`；这里只认它们的几个函数。
 * 磁盘上的改动由 `diskSync.ts` 收来，经 `applyDiskChange` / `markGone` 落到标签上。
 *
 * **撤销 / 重做是编辑器自己记的**（`history.ts`，每个文件一份）：打字在 `input` 里拿
 * `file.draft` 与 textarea 的当前值求差异记账；程序改写一律走 `applyEdit`；Ctrl+Z / Ctrl+Y /
 * Ctrl+Shift+Z 与 `beforeinput` 的 `historyUndo` / `historyRedo` 都拦下来走自己的，原生撤销不用。
 * 输入法组字期间不记，`compositionend` 之后整段记一步。
 *
 * **标签**：名字与短标记来自后端（`OpenFile.label`），同名的加区分目录（`tabLabels.ts`）；标签条的滚动与
 * 「▾」在 `tabStrip.ts`，右键菜单里关闭类之后的那几项（移到另一侧、定位、复制路径、重新打开、固定）在
 * `tabMenu.ts`。**临时标签**（`OpenFile.preview`）的规矩都在 `upsertFile` / `slotFor` 与几处转正的地方。
 *
 * **Markdown 预览按标签记**（`OpenFile.markdownPreview`，方案 D3）：切走再切回来还是原来那样，刷新恢复也记着（⚑）。
 * 切换走 `setPreviewing`（工具栏「预览 / 编辑」、`Ctrl+Shift+V`、查找与体检之类「先切回编辑」的地方）：编辑区视口
 * 顶上那一行与预览里对应的那一块互相滚到一处（`previewSync.ts`）。`activate` 只是切标签，不再顺手切回编辑。
 *
 * **特殊标签**（叙事线重做三期，`store.ts` 的 `SpecialTab`：「叙事线总览」）：不对应文件的标签排在文件标签前面。切过去时
 * `activePath` 是 null——这一块此刻没有当前文件，对当前文件做事的模块都当没开文件；画的东西由那个模块挂在 `.ed-stage` 上
 * （`show` / `hide`），这里只管标签、谁在显示、刷新恢复。切回一份文件（`activate`、从别处打开一份到这一块）它就藏起来；
 * 关掉它回到切过去之前的那一份。
 */
import { setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import { avoidSoftKeyboard } from '../touch';
import type { MenuItem } from '../globals';
import type { EditorFileView, EditorOpenIntent, InMessage } from '../protocol';
import { locateQuote } from '../protocol';
import {
  areaMenuItems,
  clampSelection,
  emitEditorChange,
  indentUnit,
  isImeComposing,
  runKeyHandlers,
} from './api';
import type { EditSource } from './api';
import { renderBreadcrumb } from './breadcrumb';
import { areaCopy, areaCut, areaPaste } from './clipboard';
import { requestClose } from './closing';
import { askDialog } from './dialog';
import { scrollToOffset } from './highlight';
import { EditHistory, diffText } from './history';
import type { TextChange, TextSelection } from './history';
import { indentLines, outdentLines } from './indent';
import { previewTabsEnabled } from './paragraphState';
import type { CarriedDraft, OpenFile, PaneId, PaneRefs } from './paneElements';
import { renderPreview } from './preview';
import { lineOfOffset, lineStarts } from './previewCore';
import { areaScrollForLine, areaTopLine, previewTopLine, scrollPreviewToLine } from './previewSync';
import {
  blockAutoSave,
  holdSave,
  isAutoSaving,
  isSaving,
  noteStatus,
  releaseSave,
  renderSaveState,
  requestSave,
  settleSave,
  unblockAutoSave,
} from './saving';
import {
  activePane,
  allOpenFiles,
  announceActive,
  forgetClosed,
  noteClosed,
  paneWithSpecial,
  pendingActive,
  pendingDrafts,
  persist,
  refreshOtherTabs,
  schedulePersist,
  setActivePane,
  specialTabOf,
  syncDraftVisibility,
} from './store';
import type { ApplyEditOptions, Pane } from './store';
import { extraTabItems } from './tabMenu';
import { tabNames } from './tabLabels';
import type { TabName } from './tabLabels';
import { createTabStrip, tabText } from './tabStrip';
import { shortcutLabel } from './shortcuts';
import { renderWordStatus } from './stats';

/** 哪些扩展名有 Markdown 可预览。 */
const MARKDOWN_RE = /\.(md|markdown)$/i;
/**
 * 哪些用等宽字体。**预览与等宽是两件事**：章节可以是 .txt / 无扩展名，
 * 那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；
 * 只有 .json / .yml 这类结构化文件才加 .mono。
 */
const CODE_RE = /\.(json|ya?ml)$/i;

/**
 * 哪些原生输入算「打字」，可以与前后几下并成一步撤销。粘贴、拖放、剪切各自一步；
 * 没有 `inputType` 的（老浏览器、测试里合成的事件）当打字。
 */
const TYPING_INPUT = new Set([
  'insertText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
]);

/**
 * textarea 的 value 会把 `\r\n` / `\r` 归一成 `\n`。比较「编辑区里显示的是不是这一份」、
 * 算 `applyEdit` 的下标都得用同一个口径——`file.draft` 刚从磁盘读来时可能还带着 `\r\n`。
 */
function viewText(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

export function createPane(
  id: PaneId,
  el: PaneRefs,
  post: (msg: InMessage) => void
): Pane {
  const files = new Map<string, OpenFile>();
  /**
   * 冲突时暂存的磁盘版本，供「用磁盘版本覆盖」使用。
   * `reopen`：不是保存撞上的，是已打开的文件被再次打开（多半是刚落盘了新产物）
   * 而编辑器里还有未保存的修改——文案不能说「这次保存已取消」。
   */
  const conflicts = new Map<string, { text: string; hash: string; reopen?: boolean }>();
  /**
   * 见过、但还没载入编辑器的那份磁盘版本的 hash（保存撞上冲突、再次打开、核对磁盘时知道的）。
   * 冲突条会因为作者接着打字而收起，这一笔不跟着丢：核对磁盘时带它，同一个新版不再报第二次。
   * 基线换了（载入了、存成了）就清掉。
   */
  const diskSeen = new Map<string, string>();
  /**
   * 作者点过「还原」、正在等后端回磁盘版的路径。只有它们的 editorOpen 才允许
   * 冲掉未保存的修改；其余的 editorOpen 一律当成「再打开一次」。
   */
  const reloading = new Set<string>();
  /** 开着的特殊标签（`store.ts` 的 `SpecialTab`），按打开的先后。 */
  const specials: string[] = [];
  /** 正显示着的特殊标签。不是 null 时 `activePath` 是 null。 */
  let shownSpecial: string | null = null;
  /** 切到特殊标签之前的那份文件：关掉特殊标签时回到它（刷新恢复时是存下来的那一份）。 */
  let specialReturn: string | null = null;

  const pane: Pane = {
    id,
    root: el.root,
    area: el.area,
    files,
    activePath: null,
    activeFile,
    isPreviewing: () => previewing(activeFile()),
    canPreview: () => canPreview(activeFile()),
    setPreviewing,
    hasDirty,
    snapshot,
    activate,
    closeFile,
    discard,
    closeSilently,
    moveOut,
    upsertFile,
    pin,
    applyEdit,
    undo,
    redo,
    save,
    savePath,
    reveal,
    applySaved,
    applyConflict,
    applyDiskChange,
    markGone,
    knownDiskHash,
    refresh,
    rebase,
    specials,
    activeSpecial: () => shownSpecial,
    openSpecial,
    closeSpecial,
  };

  function activeFile(): OpenFile | undefined {
    return pane.activePath ? files.get(pane.activePath) : undefined;
  }

  /** 这份文件有没有 Markdown 可预览（`.txt` / 无扩展名的章节没有，隐藏「预览」按钮）。 */
  function canPreview(file: OpenFile | undefined): boolean {
    return !!file && MARKDOWN_RE.test(file.path);
  }

  /** 这份文件此刻是不是在预览里（每个标签各记各的）。 */
  function previewing(file: OpenFile | undefined): boolean {
    return !!file?.markdownPreview && canPreview(file);
  }

  function hasDirty(): boolean {
    return [...files.values()].some((f) => f.draft !== f.text);
  }

  function snapshot() {
    return {
      open: [...files.values()].map((f) => ({
        path: f.path,
        hash: f.hash,
        draft: f.draft === f.text ? undefined : f.draft,
        preview: f.preview || undefined,
        markdownPreview: f.markdownPreview || undefined,
      })),
      // 特殊标签正显示着：记切过去之前的那一份，刷新之后关掉特殊标签还回得去。
      active: shownSpecial ? (specialReturn && files.has(specialReturn) ? specialReturn : null) : pane.activePath,
      ...(specials.length > 0 ? { specials: [...specials] } : {}),
      ...(shownSpecial ? { special: shownSpecial } : {}),
    };
  }

  // ---------------------------------------------------------------- 标签

  /** 标签条：横着滚、当前那个滚进视野、末尾的「▾」（`tabStrip.ts`）。 */
  const strip = createTabStrip(el.tabs);

  /** 每份文件在标签上怎么写：两块编辑区开着的放在一起比，同名的加区分目录。 */
  function currentNames(): Map<string, TabName> {
    const all = new Map(allOpenFiles().map((f) => [f.path, f]));
    for (const f of files.values()) {
      all.set(f.path, f);
    }
    return tabNames([...all.values()]);
  }

  function renderTabs(): void {
    const keep = strip.beforeRender();
    const names = currentNames();
    let active: HTMLElement | null = null;
    strip.list.replaceChildren();
    // 特殊标签排在文件标签前面（⚑）：它是这一块的一张「总表」，不随开开关关的文件挪位置。
    for (const id of specials) {
      const tab = buildSpecialTab(id);
      if (tab) {
        if (id === shownSpecial) {
          active = tab;
        }
        strip.list.appendChild(tab);
      }
    }
    for (const file of files.values()) {
      const tab = buildTab(file, names.get(file.path) ?? { tag: '', title: file.name, desc: '' });
      if (file.path === pane.activePath) {
        active = tab;
      }
      strip.list.appendChild(tab);
    }
    setHidden(el.tabs, files.size === 0 && specials.length === 0);
    strip.afterRender(keep, active);
  }

  /** 特殊标签：没有脏标记、没有类型短标记；点了切过去，× 与中键关掉，右键「关闭」加它自己给的几项。 */
  function buildSpecialTab(id: string): HTMLElement | undefined {
    const spec = specialTabOf(id);
    if (!spec) {
      return undefined;
    }
    const { title, tip } = spec.label();
    const tab = document.createElement('div');
    tab.className = 'ed-tab ed-tab-special';
    tab.classList.toggle('active', id === shownSpecial);
    tab.dataset.special = id;
    tab.title = tip;

    const name = document.createElement('span');
    name.className = 'ed-tab-name';
    name.textContent = title;
    tab.appendChild(name);

    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSpecial(id);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => openSpecial(id));
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeSpecial(id);
      }
    });
    onContextMenu(tab, () => [{ label: '关闭', run: () => closeSpecial(id) }, ...(spec.menu?.(pane) ?? [])]);
    return tab;
  }

  function openSpecial(id: string, opts?: { focus?: boolean; background?: boolean; restoring?: boolean }): void {
    if (!specialTabOf(id)) {
      return;
    }
    // 同一个特殊标签同一时刻只在一块里：开在另一块里的先从那边拿走。
    const elsewhere = paneWithSpecial(id);
    if (elsewhere && elsewhere !== pane) {
      elsewhere.closeSpecial(id, { quiet: true });
    }
    if (!specials.includes(id)) {
      specials.push(id);
    }
    if (!opts?.background && shownSpecial !== id) {
      // 切走前把光标位置留住、正在打的那一步收口（同切标签）。
      stashCaret();
      activeFile()?.history.seal();
      if (pane.activePath) {
        specialReturn = pane.activePath;
      }
      pane.activePath = null;
      shownSpecial = id;
    }
    if (opts?.focus !== false && !opts?.background) {
      setActivePane(pane);
    }
    renderAll();
    announceActive();
    syncDraftVisibility();
    if (!opts?.restoring) {
      persist();
    }
  }

  function closeSpecial(id: string, opts?: { quiet?: boolean }): void {
    const i = specials.indexOf(id);
    if (i < 0) {
      return;
    }
    specials.splice(i, 1);
    specialTabOf(id)?.hide(pane);
    const wasShown = shownSpecial === id;
    if (wasShown) {
      shownSpecial = null;
    }
    const back = specialReturn && files.has(specialReturn) ? specialReturn : [...files.keys()].pop();
    if (wasShown && back && !opts?.quiet) {
      // 回到切过去之前的那一份：光标、滚动、预览都照它切走时的样子（`activate` 那一套）。
      specialReturn = null;
      activate(back);
      refreshOtherTabs(pane);
      syncDraftVisibility();
      return;
    }
    if (wasShown) {
      pane.activePath = back ?? null;
      specialReturn = null;
      // 文件都关了、还开着别的特殊标签：显示最后那一个。
      if (!pane.activePath && specials.length > 0) {
        shownSpecial = specials[specials.length - 1];
      }
    }
    renderAll();
    if (!opts?.quiet) {
      announceActive();
      syncDraftVisibility();
      persist();
    }
  }

  /** 这一块认下一份文件当当前的：正显示着的特殊标签藏起来。 */
  function leaveSpecial(): void {
    if (shownSpecial) {
      shownSpecial = null;
      specialReturn = null;
    }
  }

  function buildTab(file: OpenFile, label: TabName): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'ed-tab';
    tab.classList.toggle('active', file.path === pane.activePath);
    tab.classList.toggle('dirty', file.draft !== file.text);
    // 临时标签：名字斜体，下一次单击打开别的文件时这个位置被换掉。
    tab.classList.toggle('preview', !!file.preview);
    tab.dataset.path = file.path;
    tab.title = file.preview ? `${file.path}\n临时标签：编辑、保存或双击就会固定下来` : file.path;

    const dot = document.createElement('span');
    dot.className = 'ed-tab-dirty';
    tab.appendChild(dot);

    // 类型短标记（细纲 / 草稿 / 角色……，后端给的）：同一章的正文、细纲、草稿一眼分得开。
    if (label.tag) {
      const tag = document.createElement('span');
      tag.className = 'ed-tab-tag';
      tag.textContent = label.tag;
      tab.appendChild(tag);
    }

    const name = document.createElement('span');
    name.className = 'ed-tab-name';
    name.textContent = label.title;
    tab.appendChild(name);

    // 仍然同名的（同一种、不同目录）：后面淡一点写区分它们的最短目录。
    if (label.desc) {
      const desc = document.createElement('span');
      desc.className = 'ed-tab-desc';
      desc.textContent = label.desc;
      tab.appendChild(desc);
    }

    // 磁盘上被改了而编辑器里的修改没覆盖、或磁盘上已经没有这一份：标签上挂一个醒目的「!」（不切过去）。
    const flag = conflicts.has(file.path)
      ? '磁盘上已被改动，编辑器里的修改没有覆盖'
      : file.gone
        ? '磁盘上已经没有这个文件（被删或改名）'
        : '';
    tab.classList.toggle('conflict', conflicts.has(file.path));
    tab.classList.toggle('gone', !!file.gone);
    if (flag) {
      const mark = document.createElement('span');
      mark.className = 'ed-tab-flag';
      mark.textContent = '!';
      mark.title = flag;
      tab.appendChild(mark);
      tab.title = `${tab.title}\n${flag}`;
    }

    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(file.path);
    });
    tab.appendChild(close);

    tab.addEventListener('click', (e) => {
      // 双击临时标签：转正。点第一下 activate 就把整排标签重画了，第二下落在新的那个元素上——
      // 所以按这一下的点击次数认，不指望 dblclick 落在同一个元素上（下面那个 dblclick 是兜底）。
      if (e.detail >= 2 && file.preview) {
        file.preview = false;
      }
      activate(file.path);
    });
    tab.addEventListener('dblclick', () => pin(file.path));
    // 中键关闭，与浏览器/编辑器一致。
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeFile(file.path);
      }
    });
    onContextMenu(tab, () => tabMenuItems(file.path));
    return tab;
  }

  /**
   * 标签右键菜单：关闭当前/左侧/右侧/其它。
   * 批量关闭**合成一个对话框问一次**（几份没保存就列出几份），见 `closing.ts`。
   */
  function tabMenuItems(anchor: string): MenuItem[] {
    const order = [...files.keys()];
    const idx = order.indexOf(anchor);
    const left = order.slice(0, idx);
    const right = order.slice(idx + 1);
    const closeMany = (paths: string[]) => void requestClose(pane, paths);

    const items: MenuItem[] = [{ label: '关闭', run: () => closeFile(anchor) }];
    if (left.length > 0) {
      items.push({ label: `关闭左侧（${left.length}）`, run: () => closeMany(left) });
    }
    if (right.length > 0) {
      items.push({ label: `关闭右侧（${right.length}）`, run: () => closeMany(right) });
    }
    if (left.length + right.length > 0) {
      items.push({
        label: `关闭其它（${left.length + right.length}）`,
        run: () => closeMany([...left, ...right]),
      });
    }
    // 移到另一侧、在文件页中定位、复制相对路径、重新打开刚关闭的、固定（tabMenu.ts）。
    return [...items, ...extraTabItems(pane, anchor)];
  }

  /** 临时标签转正。 */
  function pin(path: string): void {
    const file = files.get(path);
    if (!file?.preview) {
      return;
    }
    file.preview = false;
    renderTabs();
    persist();
  }

  function activate(path: string, opts?: { focus?: boolean }): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    // 不抢焦点地切（上一章 / 下一章时另一块里配对的那一份）：不认下「当前这一块」，焦点留在原处。
    const quiet = opts?.focus === false;
    // 切走前把光标位置留住，切回来还在原处；正在打的那一步也收口，切回来再打另起一步。
    stashCaret();
    activeFile()?.history.seal();
    leaveSpecial();
    pane.activePath = path;
    if (!quiet) {
      setActivePane(pane);
    }
    renderAll();
    announceActive();
    if (previewing(file)) {
      // 这一份切走时在预览里：照旧在预览里，滚到切走时的位置。
      el.preview.scrollTop = file.previewScrollTop ?? 0;
      if (!quiet) {
        el.preview.focus({ preventScroll: true });
      }
    } else {
      // 手机上切过来只是看：不把焦点放进正文区（一聚焦就弹软键盘），点进正文才打字。
      if (!quiet && !avoidSoftKeyboard()) {
        el.area.focus();
      }
      if (file.caret !== undefined) {
        el.area.selectionStart = el.area.selectionEnd = Math.min(file.caret, el.area.value.length);
      }
      el.area.scrollTop = file.scrollTop || 0;
    }
    persist();
  }

  /** 切走之前把这一份的光标与滚动（在预览里就是预览的滚动）留住。 */
  function stashCaret(): void {
    const file = activeFile();
    if (!file) {
      return;
    }
    if (previewing(file)) {
      file.previewScrollTop = el.preview.scrollTop;
      return;
    }
    file.caret = el.area.selectionStart;
    file.scrollTop = el.area.scrollTop;
  }

  /**
   * 当前这一份切到预览 / 切回编辑（工具栏「预览 / 编辑」、`Ctrl+Shift+V`，以及查找、体检、对比合并这些「先切回编辑」的地方）。
   * 两边滚到同一处：编辑区视口顶上那一行（带小数，一段折成几行时滚到一半就是一半）在预览里对应的那一块停在顶上，反过来同理
   * （`previewSync.ts`）。切回编辑时光标留在原处——它要是不在视口里了，就放到视口顶上那一行的行首（⚑），免得一打字又跳回去。
   * 没有文件、要预览的不是 Markdown 时返回 false。`focus: false`：焦点不动（缺省进正文区 / 预览）。
   */
  function setPreviewing(on: boolean, opts?: { focus?: boolean }): boolean {
    const file = activeFile();
    if (!file || (on && !canPreview(file))) {
      return false;
    }
    if (previewing(file) === on) {
      return true;
    }
    const focus = opts?.focus !== false;
    const lineCount = lineStarts(el.area.value).length;
    if (on) {
      const pos = areaTopLine(pane);
      stashCaret();
      file.markdownPreview = true;
      renderAll();
      scrollPreviewToLine(el.preview, pos, lineCount);
      file.previewScrollTop = el.preview.scrollTop;
      if (focus) {
        el.preview.focus({ preventScroll: true });
      }
    } else {
      const pos = previewTopLine(el.preview, lineCount);
      file.previewScrollTop = el.preview.scrollTop;
      file.markdownPreview = false;
      renderAll();
      if (focus) {
        el.area.focus({ preventScroll: true });
      }
      const target = areaScrollForLine(pane, pos);
      const starts = lineStarts(el.area.value);
      const caretLine = lineOfOffset(starts, Math.min(file.caret, el.area.value.length));
      if (caretLine < Math.floor(target.top) || caretLine > target.bottom) {
        file.caret = starts[Math.min(starts.length - 1, Math.ceil(target.top - 1e-6))];
      }
      // 先落光标、再滚：落选区时浏览器可能自己把光标滚进视野。
      el.area.setSelectionRange(file.caret, file.caret);
      el.area.scrollTop = target.scrollTop;
      file.scrollTop = el.area.scrollTop;
    }
    persist();
    return true;
  }

  function closeFile(path: string): void {
    // 未保存内容不能一点就没：先问「保存 / 不保存 / 取消」，保存的要等回执回来才关。
    void requestClose(pane, [path]);
  }

  function discard(paths: string[]): void {
    let dropped = false;
    const names = currentNames();
    for (const path of paths) {
      if (files.has(path)) {
        // 作者亲手关的才进「最近关闭」（右键「重新打开刚关闭的」、「▾」列表底下）。
        const name = names.get(path);
        noteClosed({ path, pane: pane.id, title: name ? tabText(name) : path });
        dropFile(path);
        dropped = true;
      }
    }
    if (!dropped) {
      return;
    }
    renderAll();
    syncDraftVisibility();
    persist();
    refreshOtherTabs(pane);
  }

  function closeSilently(path: string): CarriedDraft | false {
    const file = files.get(path);
    if (!file) {
      return false;
    }
    if (file === activeFile()) {
      stashCaret();
    }
    // 搬家不是关闭：未保存内容与撤销历史都带走，接手的那一块接得上就接。冲突条、见过的磁盘新版、
    // 「磁盘上没了」与光标只有页面里直接搬（`moveOut`，`local`）才接——经后端重读来的那一份可能已经不是它们说的那一份。
    const carry: CarriedDraft = {
      history: file.history,
      historyText: file.draft,
      preview: !!file.preview,
      markdownPreview: !!file.markdownPreview,
      gone: !!file.gone,
      conflict: conflicts.get(path),
      diskSeen: diskSeen.get(path),
      caret: file.caret,
      scrollTop: file.scrollTop,
    };
    if (file.draft !== file.text) {
      carry.hash = file.hash;
      carry.draft = file.draft;
    }
    dropFile(path);
    renderAll();
    refreshOtherTabs(pane);
    return carry;
  }

  function moveOut(path: string): { view: EditorFileView; carried: CarriedDraft } | undefined {
    const file = files.get(path);
    if (!file) {
      return undefined;
    }
    // 接手的那一块收到的就是这一份的基线（不经后端重读），未保存内容按 hash 对得上原样接上。
    const view: EditorFileView = {
      path: file.path,
      name: file.name,
      text: file.text,
      hash: file.hash,
      bytes: file.text.length,
      draftPath: file.draftPath,
      kind: file.kind,
      label: file.label,
    };
    const carried = closeSilently(path);
    if (!carried) {
      return undefined;
    }
    syncDraftVisibility();
    persist();
    return { view, carried: { ...carried, hash: file.hash, local: true } };
  }

  function dropFile(path: string): void {
    files.delete(path);
    conflicts.delete(path);
    diskSeen.delete(path);
    if (pane.activePath === path) {
      pane.activePath = [...files.keys()].pop() || null;
      // 文件都关了、还开着特殊标签：切到它（同关掉一个标签之后显示旁边那一个）。
      if (!pane.activePath && !shownSpecial && specials.length > 0) {
        shownSpecial = specials[specials.length - 1];
      }
      announceActive();
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll(): void {
    renderTabs();
    const file = activeFile();
    // 特殊标签：正显示着的那一个挂上、露出来，其余藏起来（画什么由那个模块管）。
    for (const id of specials) {
      const spec = specialTabOf(id);
      if (id === shownSpecial) {
        spec?.show(pane);
      } else {
        spec?.hide(pane);
      }
    }

    const showing = previewing(file);
    setHidden(el.welcome, !!file || !!shownSpecial);
    setHidden(el.toolbar, !file);
    setHidden(el.area, !file || showing);
    setHidden(el.preview, !file || !showing);

    const conflict = file ? conflicts.get(file.path) : undefined;
    const gone = !!file?.gone && !conflict;
    setHidden(el.conflict, !conflict && !gone);
    // 磁盘上已经没有这一份：没有磁盘版本可载入。保存（含冲突条上的强制保存）会先问要不要在原路径重建。
    setHidden(el.conflictTake, gone);
    if (gone && file) {
      el.conflictText.textContent =
        `磁盘上已经没有「${file.name}」这个文件（被删或改名）。编辑器里的内容还在；` +
        '要保存的话，会先问你要不要在原路径重建。';
    } else if (conflict && file) {
      el.conflictText.textContent = conflict.reopen
        ? `「${file.name}」在磁盘上已被改动（刚写入了新内容，或在别处改过），编辑器里还有未保存的修改，没有覆盖。`
        : `「${file.name}」在磁盘上已被改动（可能是你在别处编辑，或插件写入了内容）。` +
          '为不覆盖别人的修改，这次保存已取消。';
    }

    if (!file) {
      renderWordStatus(el.statusWords, pane, undefined);
      el.statusPos.textContent = '';
      renderSaveState(el.statusSave, undefined);
      el.statusFile.textContent = '';
      el.plotBtn.classList.add('hidden');
      el.draftBtn.classList.add('hidden');
      emitEditorChange({ type: 'render', pane });
      return;
    }

    // 面包屑（后端给的称呼），原始路径在悬停提示上；目录段点了在「文件」页定位。
    renderBreadcrumb(el.path, file);

    setHidden(el.previewBtn, !canPreview(file));
    el.previewBtn.textContent = showing ? '编辑' : '预览';
    el.previewBtn.title = `${showing ? '回到编辑' : '预览 Markdown'}（${shortcutLabel('preview')}）`;
    el.area.classList.toggle('mono', CODE_RE.test(file.path));
    // draftPath 由后端给出（它知道什么算章节），前端不自己判断。细纲与草稿一样只对章节给。
    setHidden(el.plotBtn, !file.draftPath);
    setHidden(el.draftBtn, !file.draftPath);

    if (el.area.value !== viewText(file.draft)) {
      el.area.value = file.draft;
    }
    if (showing) {
      showPreview(file);
    }

    const dirty = file.draft !== file.text;
    el.saveBtn.disabled = !dirty;
    el.revertBtn.disabled = !dirty;
    updateStatus();
    emitEditorChange({ type: 'render', pane });
  }

  /** 重画预览。滚动位置留着：保存回执、磁盘上的新版进来都会重画，不该把人弹回顶上。 */
  function showPreview(file: OpenFile): void {
    const top = el.preview.scrollTop;
    renderPreview(el.preview, file.draft, file.path, (path) =>
      // 在哪一块预览里点的，就开在哪一块。
      post({ type: 'openEditor', path, pane: pane.id })
    );
    el.preview.scrollTop = top;
  }

  function updateStatus(): void {
    const file = activeFile();
    if (!file) {
      return;
    }

    el.statusFile.textContent = file.name;
    // 字数那一格（全文 / 选中、距目标、本次 / 今日码字，点开是码字统计面板）归 stats.ts。
    renderWordStatus(el.statusWords, pane, file);

    if (previewing(file)) {
      el.statusPos.textContent = '预览';
    } else {
      const upto = el.area.value.slice(0, el.area.selectionStart);
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      el.statusPos.textContent = `行 ${line}，列 ${col}`;
    }

    // 「● 未保存」→「保存中…」→「已保存 14:32」，自动保存开着时旁边挂一枚（saving.ts）。
    renderSaveState(el.statusSave, file);
  }

  /** 保存状态变了（saving.ts 调）：标签与状态栏重画，正文不动。 */
  function refresh(): void {
    renderTabs();
    updateStatus();
  }

  // ---------------------------------------------------------------- 编辑

  function currentSelection(): TextSelection {
    return { start: el.area.selectionStart, end: el.area.selectionEnd };
  }

  /**
   * 改动之前的选区。`beforeinput` 那一刻的选区最准（浏览器还没动 textarea）；拿不到时
   * （老浏览器、测试里合成的 `input`）照差异推：退格前光标在被删那段的末尾，Delete 前在开头，
   * 打字盖掉选区时选中的就是被盖掉的那段，纯插入是光标停在起点。
   */
  let selectionBefore: TextSelection | undefined;
  /** 输入法组字中：拼音还没上屏，这期间的 `input` 只刷新显示，不记撤销。 */
  let composing = false;
  /** 组字开始那一刻的内容与选区，`compositionend` 时整段算一步。 */
  let compositionBase: { text: string; selection: TextSelection } | undefined;

  function derivedBefore(change: TextChange, inputType: string | undefined): TextSelection {
    const end = change.at + change.removed.length;
    if (change.inserted === '') {
      const caret = inputType?.endsWith('Forward') ? change.at : end;
      return { start: caret, end: caret };
    }
    return { start: change.at, end };
  }

  /**
   * 内容变了之后的那一串收尾：冲突条过期、标签圆点、按钮、状态栏、草稿持久化、通知订阅者。
   * 文字已经写进 `file.draft`（当前文件也已写进 textarea）。
   */
  function afterContentChange(file: OpenFile, source: EditSource, change?: TextChange): void {
    // 内容一变，之前那次冲突提示就过期了（磁盘上没了这件事不会因为打字就过期）。
    conflicts.delete(file.path);
    // 在临时标签里改了东西：转正。有未保存修改的标签永远不会被换掉，靠的就是这一句。
    if (file.preview && file.draft !== file.text) {
      file.preview = false;
      schedulePersist();
    }
    renderTabs();
    if (file === activeFile()) {
      setHidden(el.conflict, !file.gone);
      const dirty = file.draft !== file.text;
      el.saveBtn.disabled = !dirty;
      el.revertBtn.disabled = !dirty;
      if (previewing(file)) {
        showPreview(file);
      }
      updateStatus();
    }
    schedulePersist();
    emitEditorChange({ type: 'edit', pane, file, source, change });
  }

  /** 把 `file.draft` 写进 textarea 并落选区（当前文件、不在预览时）。保住滚动位置。 */
  function showDraft(file: OpenFile, selection: TextSelection): void {
    const sel = clampSelection(selection, viewText(file.draft).length);
    file.caret = sel.start;
    if (file !== activeFile() || previewing(file)) {
      return;
    }
    const top = el.area.scrollTop;
    if (el.area.value !== viewText(file.draft)) {
      el.area.value = file.draft;
    }
    el.area.scrollTop = top;
    el.area.setSelectionRange(sel.start, sel.end);
  }

  /** 记一步撤销、换内容、写回编辑区、收尾。打字以外的改动最后都落到这里。 */
  function commitEdit(
    file: OpenFile,
    next: string,
    change: TextChange,
    before: TextSelection,
    after: TextSelection,
    source: EditSource,
    join?: boolean
  ): void {
    file.history.record(change, before, after, { join });
    file.draft = next;
    showDraft(file, after);
    afterContentChange(file, source, change);
  }

  /** 改动之前的选区：当前文件取 textarea 的，否则取切走时留下的光标。 */
  function selectionOf(file: OpenFile): TextSelection {
    return file === activeFile() && !previewing(file)
      ? currentSelection()
      : { start: file.caret, end: file.caret };
  }

  function applyEdit(
    start: number,
    end: number,
    text: string,
    selection?: TextSelection,
    opts?: ApplyEditOptions
  ): boolean {
    const file = activeFile();
    if (!file) {
      return false;
    }
    const view = viewText(file.draft);
    const range = clampSelection({ start, end }, view.length);
    const inserted = viewText(text);
    const next = view.slice(0, range.start) + inserted + view.slice(range.end);
    const caret = range.start + inserted.length;
    const after = clampSelection(selection ?? { start: caret, end: caret }, next.length);
    if (next === view) {
      showDraft(file, after);
      return false;
    }
    // 磁盘上读来的 `\r\n` 还没被编辑区归一过时，这一步连归一一起记：撤销回去仍是原样。
    const change =
      view === file.draft
        ? trimChange(range.start, view.slice(range.start, range.end), inserted)
        : diffText(file.draft, next);
    if (!change) {
      return false;
    }
    commitEdit(file, next, change, selectionOf(file), after, opts?.source ?? 'program', opts?.join);
    return true;
  }

  /** 去掉替换前后相同的头尾，只记真正变了的那一段。 */
  function trimChange(at: number, removed: string, inserted: string): TextChange | undefined {
    const d = diffText(removed, inserted);
    return d && { at: at + d.at, removed: d.removed, inserted: d.inserted };
  }

  /**
   * 整份换内容（「还原」、用磁盘版本覆盖、未改过的文件被再次打开时换成磁盘新版）：也记一步，
   * 作者可以撤销回去——那时它又是脏的，与磁盘不一致，逻辑自洽。光标尽量留在原处。
   */
  function replaceAll(file: OpenFile, next: string): void {
    const change = diffText(file.draft, next);
    if (!change) {
      return;
    }
    const before = selectionOf(file);
    commitEdit(file, next, change, before, clampSelection(before, viewText(next).length), 'program');
  }

  function undo(): boolean {
    return stepHistory('undo');
  }

  function redo(): boolean {
    return stepHistory('redo');
  }

  function stepHistory(dir: 'undo' | 'redo'): boolean {
    const file = activeFile();
    // 组字中途不动：组字开始时记下的那份底稿会对不上。
    if (!file || composing) {
      return false;
    }
    const result = dir === 'undo' ? file.history.undo(file.draft) : file.history.redo(file.draft);
    if (!result) {
      return false;
    }
    file.draft = result.text;
    showDraft(file, result.selection);
    afterContentChange(file, dir);
    return true;
  }

  el.area.addEventListener('beforeinput', (e) => {
    // 浏览器自己的撤销 / 重做（右键菜单、系统快捷键）也走编辑器的记录。
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      stepHistory(e.inputType === 'historyUndo' ? 'undo' : 'redo');
      return;
    }
    if (!composing) {
      selectionBefore = currentSelection();
    }
  });

  el.area.addEventListener('input', (e) => {
    const file = activeFile();
    if (!file) {
      return;
    }
    const next = el.area.value;
    if (composing || (e as InputEvent).isComposing) {
      // 组字中途：只刷新显示（字数、圆点），不记撤销；底稿留到 compositionend。
      compositionBase ??= { text: file.draft, selection: selectionBefore ?? currentSelection() };
      if (next !== file.draft) {
        file.draft = next;
        afterContentChange(file, 'composition');
      }
      return;
    }
    const before = selectionBefore;
    selectionBefore = undefined;
    const change = diffText(file.draft, next, el.area.selectionEnd);
    if (!change) {
      return;
    }
    const inputType = (e as InputEvent).inputType || undefined;
    const typing = !inputType || TYPING_INPUT.has(inputType);
    file.history.record(change, before ?? derivedBefore(change, inputType), currentSelection(), { merge: typing });
    file.draft = next;
    afterContentChange(file, typing ? 'typing' : 'input', change);
  });

  el.area.addEventListener('compositionstart', () => {
    const file = activeFile();
    composing = true;
    compositionBase = file ? { text: file.draft, selection: currentSelection() } : undefined;
  });

  el.area.addEventListener('compositionend', () => {
    composing = false;
    const base = compositionBase;
    compositionBase = undefined;
    selectionBefore = undefined;
    const file = activeFile();
    if (!file || !base) {
      return;
    }
    // 上屏的那一整段算一步（取消组字时前后一样，什么都不记）。
    const next = el.area.value;
    const change = diffText(base.text, next, el.area.selectionEnd);
    if (change) {
      file.history.record(change, base.selection, currentSelection());
    }
    if (next !== file.draft) {
      file.draft = next;
      afterContentChange(file, 'composition', change);
    } else if (change) {
      emitEditorChange({ type: 'edit', pane, file, source: 'composition', change });
    }
  });

  for (const evt of ['keyup', 'click', 'select'] as const) {
    el.area.addEventListener(evt, updateStatus);
  }

  el.area.addEventListener('scroll', () => {
    const file = activeFile();
    if (file) {
      file.scrollTop = el.area.scrollTop;
    }
  });

  /** Ctrl/Cmd+Z 撤销，Ctrl+Y 与 Ctrl/Cmd+Shift+Z 重做。认出来返回 true。 */
  function historyKey(e: KeyboardEvent): 'undo' | 'redo' | undefined {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) {
      return undefined;
    }
    const key = e.key.toLowerCase();
    if (key === 'z') {
      return e.shiftKey ? 'redo' : 'undo';
    }
    if (key === 'y' && e.ctrlKey && !e.shiftKey) {
      return 'redo';
    }
    return undefined;
  }

  el.area.addEventListener('keydown', (e) => {
    // 输入法组字中途的按键一律放行：Tab、回车、Ctrl 组合键都是输入法的。
    if (isImeComposing(e)) {
      return;
    }
    const file = activeFile();
    if (!file) {
      return;
    }
    const step = historyKey(e);
    if (step) {
      e.preventDefault();
      stepHistory(step);
      return;
    }
    if (runKeyHandlers(e, { pane, file, area: el.area })) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleTab(e.shiftKey);
    }
  });

  /**
   * Tab 在 textarea 里默认是切焦点；写作时更需要它缩进（规则见 `indent.ts`，单位见 `indentUnit`：
   * 正文两个全角空格，其余两个半角空格）。没有选区时在光标处插一级；有选区时给碰到的每一行
   * 行首加一级，**选中的字一个不删**；Shift+Tab 去掉一级。一次按键一步撤销。
   */
  function handleTab(shift: boolean): void {
    const file = activeFile();
    if (!file) {
      return;
    }
    const value = el.area.value;
    const sel = currentSelection();
    const unit = indentUnit(file);
    if (!shift && sel.start === sel.end) {
      applyEdit(sel.start, sel.end, unit);
      return;
    }
    const edit = shift ? outdentLines(value, sel) : indentLines(value, sel, unit);
    if (edit) {
      applyEdit(edit.start, edit.end, edit.text, edit.selection);
    }
  }

  // 标签条空白处右键：以当前激活标签为准。
  onContextMenu(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));

  // 正文区菜单：预览模式没有可编辑内容，provider 返回空数组即不弹。
  // 功能模块加的项（按在名字上：打开它的卡或条目）排在最前面，见 api.ts 的 addAreaMenu。
  onContextMenu(el.area, (at) => {
    if (previewing(activeFile())) {
      return [];
    }
    const hasSel = el.area.selectionStart !== el.area.selectionEnd;
    const extra = areaMenuItems(pane, at);
    return [
      ...extra,
      ...(extra.length > 0 ? [{ sep: true } as const] : []),
      { label: '剪切', disabled: !hasSel, run: () => areaCut(pane) },
      { label: '复制', disabled: !hasSel, run: () => areaCopy(el.area) },
      { label: '粘贴', run: () => void areaPaste(pane) },
      { sep: true },
      {
        label: '全选',
        run: () => {
          el.area.focus();
          el.area.select();
        },
      },
    ];
  });

  // 谁被点/被聚焦，谁就是「当前」这一块——Ctrl+S 保存的是它。
  // 换了一块就等于换了「正在编辑的文件」，资源管理器的高亮要跟着走。
  const claimFocus = () => {
    if (activePane !== pane) {
      setActivePane(pane);
      announceActive();
    }
  };
  el.root.addEventListener('focusin', claimFocus);
  el.root.addEventListener('pointerdown', claimFocus);

  // ---------------------------------------------------------------- 保存

  function save(force: boolean): void {
    // 在临时标签上按了保存（Ctrl+S、工具栏、「文件 → 保存」）：转正，哪怕没有可存的。
    if (pane.activePath) {
      pin(pane.activePath);
    }
    savePath(pane.activePath ?? '', force);
  }

  function savePath(path: string, force: boolean): void {
    // 经 saving.ts：同一份同一时刻只有一个保存在路上，状态栏跟着走；磁盘上没了的先问要不要重建。
    void requestSave(pane, path, { force });
  }

  /**
   * 选中引文那一句。按编辑区里**当下**的文字找（可能有没保存的修改）；预览模式先切回编辑。
   * 滚动用高亮镜像层量出那一句的纵向位置（`highlight.ts` 的 `scrollToOffset`），停在视口偏上三分之一。
   */
  function reveal(path: string, quote: string): boolean {
    if (!files.has(path)) {
      return false;
    }
    if (pane.activePath !== path) {
      activate(path);
    }
    setPreviewing(false);
    const at = locateQuote(el.area.value, quote);
    if (!at) {
      return false;
    }
    el.area.focus();
    el.area.setSelectionRange(at.start, at.end);
    scrollToOffset(pane, at.start);
    stashCaret();
    return true;
  }

  function applySaved(incoming: EditorFileView): void {
    const file = files.get(incoming.path);
    if (!file) {
      settleSave(incoming.path, 'saved');
      return;
    }
    // 这边没有保存在路上：是别的窗口存了同一份（回执是广播的）。对这边来说那是磁盘变了，不是存成了——
    // 照「磁盘上变了」处理。从前这里直接把基线换成别人存的那一份，下一次保存就把别人的改动盖掉了。
    if (!isSaving(incoming.path)) {
      applyDiskChange(incoming);
      return;
    }
    file.text = incoming.text;
    file.hash = incoming.hash;
    file.gone = false;
    diskSeen.delete(file.path);
    // draftPath 后端每次都会带回；万一缺席也不要把已有的值冲掉，
    // 否则工具栏上的「草稿」按钮会在首次保存后消失。
    if (incoming.draftPath !== undefined) {
      file.draftPath = incoming.draftPath;
    }
    if (incoming.kind !== undefined) {
      file.kind = incoming.kind;
    }
    if (incoming.label !== undefined) {
      file.label = incoming.label;
    }
    conflicts.delete(file.path);
    renderAll();
    persist();
    // 存成了不弹 toast：状态栏写「已保存 14:32」。保存期间又敲了字的仍是脏的，状态栏照实写「未保存」；
    // 在路上时又要存过的，settleSave 接着再存一次。
    settleSave(file.path, 'saved');
  }

  function applyConflict(path: string, diskText: string, diskHash: string): void {
    const file = files.get(path);
    if (!file) {
      settleSave(path, 'conflict');
      return;
    }
    if (!isSaving(path)) {
      // 不是这边那一次（别的窗口的保存撞了冲突，回执是广播的）：只当它带来了一份磁盘版本。
      applyDiskChange({ path, name: file.name, text: diskText, hash: diskHash, bytes: diskText.length });
      return;
    }
    const auto = isAutoSaving(path);
    conflicts.set(path, { text: diskText, hash: diskHash });
    diskSeen.set(path, diskHash);
    file.gone = false;
    // 撞上冲突：这一份不再自动保存，直到作者在冲突条上选了（基线换了）。绝不替他强制保存。
    blockAutoSave(path, file.hash);
    settleSave(path, 'conflict');
    // 手动保存撞上的切过去给人看；自动保存撞上的不切（作者可能正在别的标签里写），标签上挂着「!」。
    if (!auto && pane.activePath !== path) {
      activate(path);
    } else {
      renderAll();
    }
    toast(
      auto
        ? `「${file.name}」在磁盘上已被改过，这一份先不自动保存了，编辑器里的修改留着。`
        : '文件已被外部修改，保存已取消。',
      true
    );
  }

  function applyDiskChange(incoming: EditorFileView): void {
    const file = files.get(incoming.path);
    if (!file) {
      return;
    }
    const wasGone = !!file.gone;
    file.gone = false;
    if (incoming.draftPath !== undefined) {
      file.draftPath = incoming.draftPath;
    }
    if (incoming.kind !== undefined) {
      file.kind = incoming.kind;
    }
    if (incoming.label !== undefined) {
      file.label = incoming.label;
    }
    if (incoming.hash === file.hash) {
      // 磁盘上就是基线那一份（又出现了、或别处存回了同一份）：之前见过的新版与冲突都作废。
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
      renderAll();
      return;
    }
    if (!wasGone && incoming.hash === diskSeen.get(file.path)) {
      return; // 这一份新版已经知道了（冲突条收起了也一样），不再报第二次。
    }
    if (file.draft === file.text) {
      // 没改过：就地换成新内容。记一步撤销（与「再次打开时磁盘有新版」同一处理），不切标签、不抢焦点，
      // 光标与滚动留在原处（夹进新长度）。
      file.text = incoming.text;
      file.hash = incoming.hash;
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
      replaceAll(file, incoming.text);
      if (file === activeFile()) {
        noteStatus(file.path, '磁盘上有新版本，已载入');
      }
    } else if (viewText(incoming.text) === viewText(file.draft)) {
      // 磁盘上的正好就是编辑器里这一份（别处存了同样的字）：认下来，不算冲突。
      file.text = incoming.text;
      file.hash = incoming.hash;
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
    } else {
      // 改过：编辑器里的修改一个字不动，挂冲突条，标签上标出来；自动保存先停下（存了也是撞冲突）。
      conflicts.set(file.path, { text: incoming.text, hash: incoming.hash, reopen: true });
      diskSeen.set(file.path, incoming.hash);
      blockAutoSave(file.path, file.hash);
      toast(`「${file.name}」在磁盘上被改过，编辑器里的修改留着、没有覆盖（标签上标了「!」）。`, true);
    }
    renderAll();
    persist();
  }

  function markGone(path: string): void {
    const file = files.get(path);
    const saving = isSaving(path);
    settleSave(path, 'gone');
    if (!file) {
      return;
    }
    const fresh = !file.gone;
    file.gone = true;
    conflicts.delete(path);
    diskSeen.delete(path);
    if (saving) {
      toast(`「${file.name}」在磁盘上已经没有了（被删或改名），这次没有保存。再按一次保存会先问你要不要在原路径重建。`, true);
    } else if (fresh && file.draft !== file.text) {
      toast(`「${file.name}」在磁盘上已经没有了（被删或改名），编辑器里的修改还在。`, true);
    }
    renderAll();
  }

  function knownDiskHash(path: string): string {
    const file = files.get(path);
    if (!file || file.gone) {
      return '';
    }
    return diskSeen.get(path) ?? file.hash;
  }

  /**
   * 「对比合并…」放回编辑器之后（`replace.ts`）：基线换成合并时读到的磁盘那份，冲突就此解决——与冲突条上
   * 「用磁盘版本覆盖」同一套收尾：冲突条收起、见过的磁盘新版（`diskSeen`）作废（之后磁盘再变、哪怕变回那一份，
   * 核对时照样报）、自动保存的闸放开（之后照常停笔就存，带的是新基线）。磁盘上读得到才合并得了，所以也不再是「没了」。
   */
  function rebase(path: string, text: string, hash: string): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    file.text = text;
    file.hash = hash;
    file.gone = false;
    diskSeen.delete(path);
    unblockAutoSave(path);
    conflicts.delete(path);
    renderAll();
    persist();
  }

  // 按钮上写的键按平台（Mac 上 ⌘S），从快捷键表取；页面模板里那一句只是没跑脚本时的样子。
  el.saveBtn.title = `保存（${shortcutLabel('save')}）`;
  el.saveBtn.addEventListener('click', () => save(false));

  el.revertBtn.addEventListener('click', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    const reload = (): void => {
      reloading.add(file.path);
      // 磁盘版回来之前别让自动保存把要丢掉的修改存下去。
      holdSave(file.path);
      post({ type: 'reloadFile', path: file.path });
    };
    if (file.draft === file.text) {
      reload();
      return;
    }
    void askDialog({
      title: '还原',
      message: `放弃「${file.name}」的未保存修改，重新从磁盘读取？`,
      detail: '放弃之后还能按 Ctrl+Z 撤销回来。',
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'revert', label: '放弃修改', primary: true, danger: true },
      ],
      cancel: 'cancel',
    }).then((answer) => {
      if (answer === 'revert' && files.get(file.path) === file) {
        reload();
      }
    });
  });

  el.previewBtn.addEventListener('click', () => {
    setPreviewing(!previewing(activeFile()));
  });

  // 预览能拿焦点（不进 Tab 顺序）：切到预览之后方向键、翻页键滚的是它，再按一下 Ctrl+Shift+V 也认得出是这一块。
  el.preview.tabIndex = -1;
  el.preview.addEventListener('scroll', () => {
    const file = activeFile();
    if (file && previewing(file)) {
      file.previewScrollTop = el.preview.scrollTop;
    }
  });

  el.externalBtn.addEventListener('click', () => {
    const file = activeFile();
    if (file) {
      post({ type: 'openExternal', path: file.path });
    }
  });

  el.plotBtn.addEventListener('click', () => {
    const file = activeFile();
    // 与「草稿」一样传**章节**路径：细纲落在哪由后端推导，还没有就按模板建一份。
    if (file) {
      post({ type: 'openPlot', path: file.path });
    }
  });

  el.draftBtn.addEventListener('click', () => {
    const file = activeFile();
    // 传的是**章节**路径：草稿路径由后端推导，并在缺席时按需创建。
    if (file) {
      post({ type: 'openDraft', path: file.path });
    }
  });

  el.conflictTake.addEventListener('click', () => {
    const file = activeFile();
    const disk = file && conflicts.get(file.path);
    if (!file || !disk) {
      return;
    }
    file.text = disk.text;
    file.hash = disk.hash;
    diskSeen.delete(file.path);
    // 整份换内容也记一步：点错了可以撤销回编辑器里原来那份。
    replaceAll(file, disk.text);
    conflicts.delete(file.path);
    renderAll();
    persist();
    toast('已载入磁盘上的版本。');
  });

  el.conflictForce.addEventListener('click', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    // 磁盘上已经没有这一份：没有「别人的改动」可丢，保存那条路会问要不要在原路径重建（重建照样带基线）。
    if (file.gone) {
      savePath(file.path, true);
      return;
    }
    void askDialog({
      title: '用编辑器内容强制保存',
      message: `确定用编辑器里的内容覆盖磁盘上的「${file.name}」？磁盘上的改动会丢失。`,
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'force', label: '覆盖磁盘上的版本', primary: true, danger: true },
      ],
      cancel: 'cancel',
    }).then((answer) => {
      if (answer === 'force') {
        savePath(file.path, true);
      }
    });
  });

  // ---------------------------------------------------------------- 收文件

  function upsertFile(incoming: EditorFileView, carried?: CarriedDraft, intent?: EditorOpenIntent): void {
    const existing = files.get(incoming.path);
    const pending = pendingDrafts.get(incoming.path);
    pendingDrafts.delete(incoming.path);
    // 单击打开（工程页 / 文件页的一行）且开关开着：开成临时标签。
    const wantPreview = !!intent?.preview && previewTabsEnabled();

    if (existing) {
      // 已打开。只有「还原」发起的那一次才冲掉未保存的修改；其余的（落盘后
      // 自动打开、工程页再点一次）碰上脏草稿就不动它——磁盘版变了就挂冲突条
      // 让作者自己选，没变就只是切过去。
      const reload = reloading.delete(incoming.path);
      if (reload) {
        releaseSave(incoming.path);
      }
      const dirty = existing.draft !== existing.text;
      if (reload || !dirty) {
        existing.text = incoming.text;
        existing.hash = incoming.hash;
        existing.gone = false;
        diskSeen.delete(incoming.path);
        // 「还原」也记一步撤销：作者可以退回刚才没保存的那份。
        replaceAll(existing, incoming.text);
        conflicts.delete(incoming.path);
      } else if (incoming.hash !== existing.hash) {
        conflicts.set(incoming.path, { text: incoming.text, hash: incoming.hash, reopen: true });
        diskSeen.set(incoming.path, incoming.hash);
        existing.gone = false;
        blockAutoSave(incoming.path, existing.hash);
        toast(`「${existing.name}」在磁盘上已被改过，编辑器里的未保存修改保留着。`, true);
      }
      if (incoming.draftPath !== undefined) {
        existing.draftPath = incoming.draftPath;
      }
      if (incoming.kind !== undefined) {
        existing.kind = incoming.kind;
      }
      if (incoming.label !== undefined) {
        existing.label = incoming.label;
      }
      // 已经开着的被别的路子正常打开了一次（落盘后自动打开、点引文、双击那一行……）：临时标签就此转正。
      // 单击打开一份已经开着的什么都不改——不把一个固定的标签降回临时的。
      if (!intent?.preview) {
        existing.preview = false;
      }
      leaveSpecial();
      pane.activePath = incoming.path;
    } else {
      // 从另一块搬来的（带着草稿或撤销历史）优先；否则看刷新前存下的草稿。
      const restore = carried && (carried.draft !== undefined || carried.history) ? carried : pending;
      const file = newFile(incoming, restore);
      if (restore?.local) {
        // 页面里直接搬过来的：冲突条与见过的磁盘新版照旧挂着（基线没换，它们还作数）。
        if (restore.conflict) {
          conflicts.set(file.path, restore.conflict);
        }
        if (restore.diskSeen) {
          diskSeen.set(file.path, restore.diskSeen);
        }
      }
      file.preview = previewOf(file, carried, pending, wantPreview);
      insertFile(file, slotFor(file, intent));
      forgetClosed(file.path);
      claimActivePath(incoming.path, !!pending && !carried);
    }

    renderAll();
    announceActive();
    persist();
    refreshOtherTabs(pane);
  }

  /**
   * 新收进来的这一份是不是临时标签。有未保存修改的一律不是；从另一块经 `editorOpen` 搬来的保持原样
   * （单击打开才保持临时，别的路子打开的转正）；「移到另一侧」搬来的转正（作者明说要它在那边）；刷新恢复、
   * 改名搬家的照存下来的那样（开关关了就不是）；其余看这一次是不是单击打开的。
   */
  function previewOf(
    file: OpenFile,
    carried: CarriedDraft | undefined,
    pending: CarriedDraft | undefined,
    wantPreview: boolean
  ): boolean {
    if (file.draft !== file.text) {
      return false;
    }
    if (carried) {
      return !carried.local && !!carried.preview && wantPreview;
    }
    if (pending?.preview !== undefined) {
      return pending.preview && previewTabsEnabled();
    }
    return wantPreview;
  }

  /**
   * 新的一份占谁的位置：
   * 1. `replace`（上一章 / 下一章）指着的那一份**没改过**就在它的位置换掉（它是临时的，新的一份接着是临时的）；
   *    改过了就另开一个标签。
   * 2. 新的一份是临时标签：这一块已有的那个临时标签被换掉（它一改就转正了，所以总是没改过的；万一改过，转正、不换）。
   * 3. 都不是：开在最后。
   */
  function slotFor(file: OpenFile, intent: EditorOpenIntent | undefined): string | undefined {
    const target = intent?.replace;
    if (target && target !== file.path) {
      const old = files.get(target);
      if (old && old.draft === old.text) {
        if (old.preview && previewTabsEnabled() && file.draft === file.text) {
          file.preview = true;
        }
        return target;
      }
    }
    if (file.preview) {
      const old = [...files.values()].find((f) => f.preview && f.path !== file.path);
      if (old && old.draft === old.text) {
        return old.path;
      }
      if (old) {
        old.preview = false;
      }
    }
    return undefined;
  }

  /** 把新的一份放进标签表：给了 `at` 就占它的位置（它被换掉，不进「最近关闭」），否则排在最后。 */
  function insertFile(file: OpenFile, at: string | undefined): void {
    if (!at || !files.has(at)) {
      files.set(file.path, file);
      return;
    }
    const entries = [...files.entries()];
    files.clear();
    for (const [path, f] of entries) {
      if (path === at) {
        files.set(file.path, file);
      } else if (path !== file.path) {
        files.set(path, f);
      }
    }
    conflicts.delete(at);
    diskSeen.delete(at);
    if (pane.activePath === at) {
      pane.activePath = file.path;
    }
  }

  function newFile(incoming: EditorFileView, restore?: CarriedDraft): OpenFile {
    const file: OpenFile = {
      path: incoming.path,
      name: incoming.name,
      text: incoming.text,
      hash: incoming.hash,
      draft: incoming.text,
      draftPath: incoming.draftPath,
      kind: incoming.kind,
      label: incoming.label,
      caret: 0,
      scrollTop: 0,
      history: new EditHistory(),
    };
    if (restore?.draft !== undefined) {
      // 刷新前的未保存草稿（或从另一块编辑区搬过来的）：仅当磁盘内容未变
      // （hash 一致）才贴回去，否则拿旧内容盖新内容就是另一种静默覆盖。
      // moved 是例外——文件刚改名/搬家，hash 基线必然变了，草稿照贴。
      if (restore.moved || restore.hash === incoming.hash) {
        file.draft = restore.draft;
      } else {
        toast(`「${file.name}」在离开期间被改过，已放弃未保存的草稿。`, true);
      }
    }
    // 预览还是编辑：搬家、刷新恢复都照原样（⚑ 刷新恢复也记着）。
    if (restore?.markdownPreview) {
      file.markdownPreview = true;
    }
    // 搬家带来的撤销历史：内容与搬走时一字不差才接上，否则那份差异对不上位置。
    if (restore?.history && restore.historyText === file.draft) {
      file.history = restore.history;
    }
    // 页面里直接搬过来的（「移到另一侧」）：「磁盘上没了」与光标、滚动位置也接上。
    if (restore?.local) {
      file.gone = !!restore.gone;
      file.caret = restore.caret ?? 0;
      file.scrollTop = restore.scrollTop ?? 0;
    }
    return file;
  }

  /**
   * 恢复阶段按存下来的 active 定位，其余情况新开的就是当前的。`restoring`：这一份是刷新恢复回来的——特殊标签正显示着时
   * 不把它换下去（存下来的那一份记成「关掉特殊标签时回到它」）；作者此刻从别处打开的照常切过去。
   */
  function claimActivePath(path: string, restoring: boolean): void {
    const wanted = pendingActive.get(pane.id);
    if (shownSpecial && restoring) {
      if (wanted === path) {
        specialReturn = path;
        pendingActive.delete(pane.id);
      }
      return;
    }
    if (!wanted || wanted === path) {
      leaveSpecial();
      pane.activePath = path;
      if (wanted) {
        pendingActive.delete(pane.id);
      }
    } else if (!pane.activePath) {
      leaveSpecial();
      pane.activePath = path;
    }
  }

  renderAll();
  return pane;
}
