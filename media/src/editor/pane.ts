/**
 * 一块编辑区。两块（正文 / 草稿）是这个工厂的两个实例，各自持有自己的
 * 文件表、冲突表、当前路径与预览开关，互相不读对方的内部字段——
 * 它们之间只通过 store.ts 的 `panes` 表与 `paneOwning()` 打交道。
 *
 * 保存带**内容 hash 乐观锁**：磁盘上的 hash 与编辑器基线不一致（作者在别处
 * 改过、或插件写入过）时保存被拒，弹冲突条让用户在「用磁盘版本覆盖编辑器」
 * 和「用编辑器内容强制保存」之间选。只有明确点了「强制保存」才会发不带
 * `baseHash` 的 saveFile。
 */
import { setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { EditorFileView, InMessage } from '../protocol';
import { areaCopy, areaCut, areaPaste, handleTabKey } from './clipboard';
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
import type { Pane } from './store';
import { countWords, formatWords } from './words';

/** 哪些扩展名有 Markdown 可预览。 */
const MARKDOWN_RE = /\.(md|markdown)$/i;
/**
 * 哪些用等宽字体。**预览与等宽是两件事**：章节可以是 .txt / 无扩展名，
 * 那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；
 * 只有 .json / .yml 这类结构化文件才加 .mono。
 */
const CODE_RE = /\.(json|ya?ml)$/i;

export function createPane(
  id: PaneId,
  el: PaneRefs,
  post: (msg: InMessage) => void
): Pane {
  const files = new Map<string, OpenFile>();
  /** 冲突时暂存的磁盘版本，供「用磁盘版本覆盖」使用。 */
  const conflicts = new Map<string, { text: string; hash: string }>();

  const pane: Pane = {
    id,
    root: el.root,
    files,
    activePath: null,
    activeFile,
    hasDirty,
    snapshot,
    activate,
    closeFile,
    closeSilently,
    upsertFile,
    save,
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
    // 切走前把光标位置留住，切回来还在原处。
    stashCaret();
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

  function closeSilently(path: string): CarriedDraft | boolean {
    const file = files.get(path);
    if (!file) {
      return false;
    }
    const carry =
      file.draft !== file.text ? { hash: file.hash, draft: file.draft } : undefined;
    dropFile(path);
    renderAll();
    return carry ?? true;
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
      el.conflictText.textContent =
        `「${file.name}」在磁盘上已被改动（可能是你在别处编辑，或插件写入了内容）。` +
        '为不覆盖别人的修改，这次保存已取消。';
    }

    if (!file) {
      el.statusWords.textContent = '';
      el.statusPos.textContent = '';
      el.statusSave.textContent = '';
      el.statusSave.classList.remove('dirty');
      el.statusFile.textContent = '';
      el.draftBtn.classList.add('hidden');
      return;
    }

    el.path.textContent = file.path;
    el.path.title = file.path;

    setHidden(el.previewBtn, !MARKDOWN_RE.test(file.path));
    el.previewBtn.textContent = previewMode ? '编辑' : '预览';
    el.area.classList.toggle('mono', CODE_RE.test(file.path));
    // draftPath 由后端给出（它知道什么算章节），前端不自己判断。
    setHidden(el.draftBtn, !file.draftPath);

    if (el.area.value !== file.draft) {
      el.area.value = file.draft;
    }
    if (previewMode) {
      renderPreview(el.preview, file.draft, file.path, (path) =>
        // 在哪一块预览里点的，就开在哪一块。
        post({ type: 'openEditor', path, pane: pane.id })
      );
    }

    const dirty = file.draft !== file.text;
    el.saveBtn.disabled = !dirty;
    el.revertBtn.disabled = !dirty;
    updateStatus();
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

  el.area.addEventListener('input', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    file.draft = el.area.value;
    // 内容一变，之前那次冲突提示就过期了。
    conflicts.delete(file.path);
    el.conflict.classList.add('hidden');
    renderTabs();
    el.saveBtn.disabled = false;
    el.revertBtn.disabled = false;
    updateStatus();
    schedulePersist();
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

  el.area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      handleTabKey(el.area, e);
    }
  });

  // 标签条空白处右键：以当前激活标签为准。
  onContextMenu(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));

  // 正文区菜单：预览模式没有可编辑内容，provider 返回空数组即不弹。
  onContextMenu(el.area, () => {
    if (previewMode) {
      return [];
    }
    const hasSel = el.area.selectionStart !== el.area.selectionEnd;
    return [
      { label: '剪切', disabled: !hasSel, run: () => areaCut(el.area) },
      { label: '复制', disabled: !hasSel, run: () => areaCopy(el.area) },
      { label: '粘贴', run: () => void areaPaste(el.area) },
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
    const file = activeFile();
    if (!file || (file.draft === file.text && !force)) {
      return;
    }
    post({
      type: 'saveFile',
      path: file.path,
      text: file.draft,
      // 空 baseHash = 放弃乐观锁，仅在用户明确选择「强制覆盖」时发生。
      baseHash: force ? undefined : file.hash,
    });
  }

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
    file.draft = disk.text;
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
      // 已打开：这是一次 reload（放弃修改 / 冲突后取磁盘版）。
      existing.text = incoming.text;
      existing.hash = incoming.hash;
      existing.draft = incoming.text;
      existing.draftPath = incoming.draftPath;
      conflicts.delete(incoming.path);
      pane.activePath = incoming.path;
    } else {
      files.set(incoming.path, newFile(incoming, carried?.draft !== undefined ? carried : pending));
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
      caret: 0,
      scrollTop: 0,
    };
    if (restore?.draft === undefined) {
      return file;
    }
    // 刷新前的未保存草稿（或从另一块编辑区搬过来的）：仅当磁盘内容未变
    // （hash 一致）才贴回去，否则拿旧内容盖新内容就是另一种静默覆盖。
    // moved 是例外——文件刚改名/搬家，hash 基线必然变了，草稿照贴。
    if (restore.moved || restore.hash === incoming.hash) {
      file.draft = restore.draft;
    } else {
      toast(`「${file.name}」在离开期间被改过，已放弃未保存的草稿。`, true);
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
