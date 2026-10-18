/**
 * 一块编辑区。两块（正文 / 草稿）是这个工厂的两个实例，各自持有自己的
 * 文件表、冲突表、当前路径与预览开关，互相不读对方的内部字段——
 * 它们之间只通过 store.ts 的 `panes` 表与 `paneOwning()` 打交道。
 *
 * 保存带**内容 hash 乐观锁**：磁盘上的 hash 与编辑器基线不一致（作者在别处
 * 改过、或插件写入过）时保存被拒，弹冲突条让用户在「用磁盘版本覆盖编辑器」
 * 和「用编辑器内容强制保存」之间选。只有明确点了「强制保存」才会发不带
 * `baseHash` 的 saveFile。
 *
 * **撤销 / 重做是编辑器自己记的**（`history.ts`，每个文件一份）：打字在 `input` 里拿
 * `file.draft` 与 textarea 的当前值求差异记账；程序改写一律走 `applyEdit`；Ctrl+Z / Ctrl+Y /
 * Ctrl+Shift+Z 与 `beforeinput` 的 `historyUndo` / `historyRedo` 都拦下来走自己的，原生撤销不用。
 * 输入法组字期间不记，`compositionend` 之后整段记一步。
 */
import { setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { EditorFileView, InMessage } from '../protocol';
import { locateQuote } from '../protocol';
import {
  clampSelection,
  emitEditorChange,
  indentUnit,
  isImeComposing,
  runKeyHandlers,
} from './api';
import type { EditSource } from './api';
import { areaCopy, areaCut, areaPaste } from './clipboard';
import { scrollToOffset } from './highlight';
import { EditHistory, diffText } from './history';
import type { TextChange, TextSelection } from './history';
import { indentLines, outdentLines } from './indent';
import type { CarriedDraft, OpenFile, PaneId, PaneRefs } from './paneElements';
import { renderPreview } from './preview';
import {
  activePane,
  announceActive,
  pendingActive,
  pendingDrafts,
  persist,
  schedulePersist,
  setActivePane,
  syncDraftVisibility,
} from './store';
import type { ApplyEditOptions, Pane } from './store';
import { countWords, formatWords } from './words';

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
   * 作者点过「还原」、正在等后端回磁盘版的路径。只有它们的 editorOpen 才允许
   * 冲掉未保存的修改；其余的 editorOpen 一律当成「再打开一次」。
   */
  const reloading = new Set<string>();

  const pane: Pane = {
    id,
    root: el.root,
    area: el.area,
    files,
    activePath: null,
    activeFile,
    isPreviewing: () => previewMode,
    hasDirty,
    snapshot,
    activate,
    closeFile,
    closeSilently,
    upsertFile,
    applyEdit,
    undo,
    redo,
    save,
    savePath,
    showFind,
    reveal,
    applySaved,
    applyConflict,
  };

  /** 预览开关是这块区的私事，不进 Pane 接口。 */
  let previewMode = false;

  function activeFile(): OpenFile | undefined {
    return pane.activePath ? files.get(pane.activePath) : undefined;
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
      })),
      active: pane.activePath,
    };
  }

  // ---------------------------------------------------------------- 标签

  function renderTabs(): void {
    el.tabs.innerHTML = '';
    for (const file of files.values()) {
      el.tabs.appendChild(buildTab(file));
    }
  }

  function buildTab(file: OpenFile): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'ed-tab';
    tab.classList.toggle('active', file.path === pane.activePath);
    tab.classList.toggle('dirty', file.draft !== file.text);
    tab.title = file.path;

    const dot = document.createElement('span');
    dot.className = 'ed-tab-dirty';
    tab.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'ed-tab-name';
    name.textContent = file.name;
    tab.appendChild(name);

    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(file.path);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => activate(file.path));
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
   * 批量关闭**逐个确认**：每个脏标签各问一次，取消哪个跳过哪个、继续其余。
   */
  function tabMenuItems(anchor: string): MenuItem[] {
    const order = [...files.keys()];
    const idx = order.indexOf(anchor);
    const left = order.slice(0, idx);
    const right = order.slice(idx + 1);
    const closeMany = (paths: string[]) => {
      for (const p of paths) {
        closeFile(p);
      }
    };

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
    return items;
  }

  function activate(path: string): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    // 切走前把光标位置留住，切回来还在原处；正在打的那一步也收口，切回来再打另起一步。
    stashCaret();
    activeFile()?.history.seal();
    pane.activePath = path;
    previewMode = false;
    setActivePane(pane);
    renderAll();
    announceActive();
    el.area.focus();
    if (file.caret !== undefined) {
      el.area.selectionStart = el.area.selectionEnd = Math.min(file.caret, el.area.value.length);
    }
    el.area.scrollTop = file.scrollTop || 0;
    persist();
  }

  function stashCaret(): void {
    const file = activeFile();
    if (!file || previewMode) {
      return;
    }
    file.caret = el.area.selectionStart;
    file.scrollTop = el.area.scrollTop;
  }

  function closeFile(path: string): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    // 未保存内容不能一点就没，必须问一句。
    if (file.draft !== file.text && !window.confirm(`「${file.name}」有未保存的修改，仍要关闭吗？`)) {
      return;
    }
    dropFile(path);
    renderAll();
    syncDraftVisibility();
    persist();
  }

  function closeSilently(path: string): CarriedDraft | false {
    const file = files.get(path);
    if (!file) {
      return false;
    }
    // 搬家不是关闭：未保存内容与撤销历史都带走，接手的那一块接得上就接。
    const carry: CarriedDraft = { history: file.history, historyText: file.draft };
    if (file.draft !== file.text) {
      carry.hash = file.hash;
      carry.draft = file.draft;
    }
    dropFile(path);
    renderAll();
    return carry;
  }

  function dropFile(path: string): void {
    files.delete(path);
    conflicts.delete(path);
    if (pane.activePath === path) {
      pane.activePath = [...files.keys()].pop() || null;
      announceActive();
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll(): void {
    renderTabs();
    const file = activeFile();

    setHidden(el.welcome, !!file);
    setHidden(el.toolbar, !file);
    setHidden(el.area, !file || previewMode);
    setHidden(el.preview, !file || !previewMode);

    const conflict = file ? conflicts.get(file.path) : undefined;
    setHidden(el.conflict, !conflict);
    if (conflict && file) {
      el.conflictText.textContent = conflict.reopen
        ? `「${file.name}」在磁盘上已被改动（可能刚写入了新内容），编辑器里还有未保存的修改，没有覆盖。`
        : `「${file.name}」在磁盘上已被改动（可能是你在别处编辑，或插件写入了内容）。` +
          '为不覆盖别人的修改，这次保存已取消。';
    }

    if (!file) {
      el.statusWords.textContent = '';
      el.statusPos.textContent = '';
      el.statusSave.textContent = '';
      el.statusSave.classList.remove('dirty');
      el.statusFile.textContent = '';
      el.draftBtn.classList.add('hidden');
      emitEditorChange({ type: 'render', pane });
      return;
    }

    el.path.textContent = file.path;
    el.path.title = file.path;

    setHidden(el.previewBtn, !MARKDOWN_RE.test(file.path));
    el.previewBtn.textContent = previewMode ? '编辑' : '预览';
    el.area.classList.toggle('mono', CODE_RE.test(file.path));
    // draftPath 由后端给出（它知道什么算章节），前端不自己判断。
    setHidden(el.draftBtn, !file.draftPath);

    if (el.area.value !== viewText(file.draft)) {
      el.area.value = file.draft;
    }
    if (previewMode) {
      showPreview(file);
    }

    const dirty = file.draft !== file.text;
    el.saveBtn.disabled = !dirty;
    el.revertBtn.disabled = !dirty;
    updateStatus();
    emitEditorChange({ type: 'render', pane });
  }

  function showPreview(file: OpenFile): void {
    renderPreview(el.preview, file.draft, file.path, (path) =>
      // 在哪一块预览里点的，就开在哪一块。
      post({ type: 'openEditor', path, pane: pane.id })
    );
  }

  function updateStatus(): void {
    const file = activeFile();
    if (!file) {
      return;
    }
    const dirty = file.draft !== file.text;

    el.statusFile.textContent = file.name;
    el.statusWords.textContent = `${formatWords(countWords(file.draft))} · ${file.draft.length} 字符`;

    if (previewMode) {
      el.statusPos.textContent = '预览';
    } else {
      const upto = el.area.value.slice(0, el.area.selectionStart);
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      el.statusPos.textContent = `行 ${line}，列 ${col}`;
    }

    el.statusSave.textContent = dirty ? '● 未保存（Ctrl+S）' : '已保存';
    el.statusSave.classList.toggle('dirty', dirty);
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
    // 内容一变，之前那次冲突提示就过期了。
    conflicts.delete(file.path);
    renderTabs();
    if (file === activeFile()) {
      el.conflict.classList.add('hidden');
      const dirty = file.draft !== file.text;
      el.saveBtn.disabled = !dirty;
      el.revertBtn.disabled = !dirty;
      if (previewMode) {
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
    if (file !== activeFile() || previewMode) {
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
    return file === activeFile() && !previewMode
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
    commitEdit(file, next, change, selectionOf(file), after, 'program', opts?.join);
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
  onContextMenu(el.area, () => {
    if (previewMode) {
      return [];
    }
    const hasSel = el.area.selectionStart !== el.area.selectionEnd;
    return [
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
    savePath(pane.activePath ?? '', force);
  }

  function savePath(path: string, force: boolean): void {
    const file = files.get(path);
    if (!file || (file.draft === file.text && !force)) {
      return;
    }
    post({
      type: 'saveFile',
      path: file.path,
      text: file.draft,
      baseHash: force ? undefined : file.hash,
    });
  }

  function showFind(): void {
    setHidden(el.find, false);
    el.findInput.focus();
    el.findInput.select();
  }

  function hideFind(): void {
    setHidden(el.find, true);
  }

  /**
   * 选中引文那一句。按编辑区里**当下**的文字找（可能有没保存的修改）；预览模式先切回编辑。
   * 滚动用高亮镜像层量出那一句的纵向位置（`highlight.ts` 的 `scrollToOffset`），停在视口偏上三分之一。
   */
  function reveal(path: string, quote: string): boolean {
    if (!files.has(path)) {
      return false;
    }
    if (pane.activePath !== path || previewMode) {
      activate(path);
    }
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

  function findStep(dir: 1 | -1): void {
    const q = el.findInput.value;
    const hay = el.area.value;
    if (!q) {
      el.findCount.textContent = '';
      return;
    }
    const from = dir === 1 ? el.area.selectionEnd : Math.max(0, el.area.selectionStart - q.length);
    let idx = dir === 1 ? hay.indexOf(q, from) : hay.lastIndexOf(q, Math.max(0, from - 1));
    if (idx === -1) {
      idx = dir === 1 ? hay.indexOf(q) : hay.lastIndexOf(q);
    }
    if (idx === -1) {
      el.findCount.textContent = '无结果';
      return;
    }
    el.area.focus();
    el.area.setSelectionRange(idx, idx + q.length);
    let n = 0;
    let current = 0;
    let at = 0;
    while (at <= hay.length) {
      const next = hay.indexOf(q, at);
      if (next === -1) {
        break;
      }
      n++;
      if (next === idx) {
        current = n;
      }
      at = next + (q.length || 1);
    }
    el.findCount.textContent = `${current}/${n}`;
  }

  el.findPrev.addEventListener('click', () => findStep(-1));
  el.findNext.addEventListener('click', () => findStep(1));
  el.findClose.addEventListener('click', hideFind);
  el.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideFind();
    }
  });
  el.findInput.addEventListener('input', () => {
    el.area.selectionStart = el.area.selectionEnd = 0;
    findStep(1);
  });

  function applySaved(incoming: EditorFileView): void {
    const file = files.get(incoming.path);
    if (!file) {
      return;
    }
    file.text = incoming.text;
    file.hash = incoming.hash;
    // 保存期间用户可能又敲了几个字：只在内容一致时才提示成功。
    if (file.draft === incoming.text) {
      toast(`已保存 ${file.path}`);
    }
    // draftPath 后端每次都会带回；万一缺席也不要把已有的值冲掉，
    // 否则工具栏上的「草稿」按钮会在首次保存后消失。
    if (incoming.draftPath !== undefined) {
      file.draftPath = incoming.draftPath;
    }
    if (incoming.kind !== undefined) {
      file.kind = incoming.kind;
    }
    conflicts.delete(file.path);
    renderAll();
    persist();
  }

  function applyConflict(path: string, diskText: string, diskHash: string): void {
    if (!files.has(path)) {
      return;
    }
    conflicts.set(path, { text: diskText, hash: diskHash });
    if (pane.activePath !== path) {
      activate(path);
    } else {
      renderAll();
    }
    toast('文件已被外部修改，保存已取消。', true);
  }

  el.saveBtn.addEventListener('click', () => save(false));

  el.revertBtn.addEventListener('click', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    if (file.draft !== file.text && !window.confirm(`放弃「${file.name}」的未保存修改？`)) {
      return;
    }
    reloading.add(file.path);
    post({ type: 'reloadFile', path: file.path });
  });

  el.previewBtn.addEventListener('click', () => {
    stashCaret();
    previewMode = !previewMode;
    renderAll();
  });

  el.externalBtn.addEventListener('click', () => {
    const file = activeFile();
    if (file) {
      post({ type: 'openExternal', path: file.path });
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
    if (!window.confirm(`确定用编辑器里的内容覆盖磁盘上的「${file.name}」？磁盘上的改动会丢失。`)) {
      return;
    }
    save(true);
  });

  // ---------------------------------------------------------------- 收文件

  function upsertFile(incoming: EditorFileView, carried?: CarriedDraft): void {
    const existing = files.get(incoming.path);
    const pending = pendingDrafts.get(incoming.path);
    pendingDrafts.delete(incoming.path);

    if (existing) {
      // 已打开。只有「还原」发起的那一次才冲掉未保存的修改；其余的（落盘后
      // 自动打开、工程页再点一次）碰上脏草稿就不动它——磁盘版变了就挂冲突条
      // 让作者自己选，没变就只是切过去。
      const reload = reloading.delete(incoming.path);
      const dirty = existing.draft !== existing.text;
      if (reload || !dirty) {
        existing.text = incoming.text;
        existing.hash = incoming.hash;
        // 「还原」也记一步撤销：作者可以退回刚才没保存的那份。
        replaceAll(existing, incoming.text);
        conflicts.delete(incoming.path);
      } else if (incoming.hash !== existing.hash) {
        conflicts.set(incoming.path, { text: incoming.text, hash: incoming.hash, reopen: true });
        toast(`「${existing.name}」在磁盘上已被改过，编辑器里的未保存修改保留着。`, true);
      }
      if (incoming.draftPath !== undefined) {
        existing.draftPath = incoming.draftPath;
      }
      if (incoming.kind !== undefined) {
        existing.kind = incoming.kind;
      }
      pane.activePath = incoming.path;
    } else {
      // 从另一块搬来的（带着草稿或撤销历史）优先；否则看刷新前存下的草稿。
      const restore = carried && (carried.draft !== undefined || carried.history) ? carried : pending;
      files.set(incoming.path, newFile(incoming, restore));
      claimActivePath(incoming.path);
    }

    previewMode = false;
    renderAll();
    announceActive();
    persist();
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
    // 搬家带来的撤销历史：内容与搬走时一字不差才接上，否则那份差异对不上位置。
    if (restore?.history && restore.historyText === file.draft) {
      file.history = restore.history;
    }
    return file;
  }

  /** 恢复阶段按存下来的 active 定位，其余情况新开的就是当前的。 */
  function claimActivePath(path: string): void {
    const wanted = pendingActive.get(pane.id);
    if (!wanted || wanted === path) {
      pane.activePath = path;
      if (wanted) {
        pendingActive.delete(pane.id);
      }
    } else if (!pane.activePath) {
      pane.activePath = path;
    }
  }

  renderAll();
  return pane;
}
