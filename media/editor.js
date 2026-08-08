// @ts-check
/*
 * 独立版的内置文件编辑器。只在独立版加载（插件形态由 VS Code 自己的编辑器负责），
 * 因此这里可以自由使用 localStorage、beforeunload 等 webview 里不该用的能力。
 *
 * 与 view.js 完全解耦：各自监听 window 的 message 事件、各自 postMessage，
 * 互不调用。唯一的交集是共用 #toast（经 view.js 暴露的 __nfToast）。
 *
 * **两块编辑区**：主区放正文，草稿区（`pane: 'draft'`）放草稿，左右并列。
 * 两块各有自己的标签条 / 工具栏 / 冲突条 / 状态栏与文件表，由同一个
 * createPane 工厂产出；草稿区的 DOM 在首次用到时克隆主区结构生成。
 * **一个路径同一时刻只属于一块**——editorSaved / editorConflict / editorError
 * 都只带 path，靠这条不变量才认得出该送给谁。
 *
 * 协议：
 *   发 openEditor{path,pane} / openDraft{path} / saveFile / reloadFile / openExternal
 *   收 editorOpen{file,pane} / editorSaved / editorConflict / editorError
 */
(function () {
  const stage = document.getElementById('wbEditor');
  // 插件形态没有这块 DOM，直接退出。
  if (!stage) return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'novelforge.editor.v1';
  const THEME_KEY = 'novelforge.theme';
  const WIDTH_KEY = 'novelforge.sideWidth';
  const DRAFT_WIDTH_KEY = 'novelforge.draftWidth';
  const DEFAULT_DRAFT_WIDTH = 420;

  const shell = {
    themeBtn: $('wbThemeBtn'),
    editorToggle: $('wbEditorToggle'),
    side: $('wbSide'),
    resizer: $('wbResizer'),
    editors: $('wbEditors'),
    draftResizer: $('wbDraftResizer'),
  };

  const toast = (message, isError) => {
    if (typeof window.__nfToast === 'function') window.__nfToast(message, isError);
  };

  // view.js 的右键菜单登记表。独立版里 view.js 先加载，必有；兜底成
  // 「不登记」只是让菜单缺席，不影响编辑主流程。
  const onCtx = window.__nfContextMenu || ((node) => node);

  /** path -> { hash, draft }，等对应的 editorOpen 到达时消费。 */
  const pendingDrafts = new Map();
  /** paneId -> 恢复完成后应该激活的 path。 */
  const pendingActive = new Map();

  /**
   * 广播「现在编辑的是哪个文件」。资源管理器（explorer.js）据此高亮那一行。
   *
   * 用自定义事件而不是让 explorer.js 直接读 panes：那会把编辑器的内部状态
   * 变成两个文件之间的契约，而且资源管理器在插件形态里根本不存在。
   * 没人监听时事件白发一趟，代价可以忽略。
   */
  function announceActive() {
    const file = activePane && activePane.activeFile();
    window.dispatchEvent(
      new CustomEvent('nf-editor-active', { detail: { path: file ? file.path : null } })
    );
  }

  // ---------------------------------------------------------------- 一块编辑区

  /**
   * 造一块编辑区。`refs` 是这块区里各个 DOM 节点的引用（主区取自页面上的
   * 固定 id，草稿区由 createPaneElements 现造）。
   *
   * 返回的对象是这块区的全部状态与行为；两块区之间只通过下面的 panes
   * 表和 paneOwning() 打交道，不互相读对方的内部字段。
   */
  function createPane(id, refs) {
    /**
     * 打开的文件。key 是工程内相对路径。
     * `text` 是磁盘基线，`draft` 是编辑器里的当前内容，两者不等即为脏。
     * `hash` 是保存时的乐观锁基线，磁盘上变了就报冲突而不是覆盖。
     */
    const files = new Map();
    /** 冲突时暂存的磁盘版本，供「用磁盘版本覆盖」使用。 */
    const conflicts = new Map();
    const el = refs;

    const pane = {
      id,
      el,
      files,
      conflicts,
      activePath: null,
      previewMode: false,
      activeFile,
      renderAll,
      activate,
      closeFile,
      closeSilently,
      upsertFile,
      save,
      applySaved,
      applyConflict,
      hasDirty,
      snapshot,
    };

    function activeFile() {
      return pane.activePath ? files.get(pane.activePath) : undefined;
    }

    function hasDirty() {
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

    function renderTabs() {
      el.tabs.innerHTML = '';
      for (const file of files.values()) {
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
        onCtx(tab, () => tabMenuItems(file.path));
        el.tabs.appendChild(tab);
      }
    }

    /**
     * 标签右键菜单：关闭当前/左侧/右侧/其它。
     * 批量关闭**逐个确认**：每个脏标签各问一次，取消哪个跳过哪个、继续其余。
     */
    function tabMenuItems(anchor) {
      const order = [...files.keys()];
      const idx = order.indexOf(anchor);
      const left = order.slice(0, idx);
      const right = order.slice(idx + 1);
      const closeMany = (paths) => {
        for (const p of paths) closeFile(p);
      };
      const items = [{ label: '关闭', run: () => closeFile(anchor) }];
      if (left.length > 0) items.push({ label: `关闭左侧（${left.length}）`, run: () => closeMany(left) });
      if (right.length > 0) items.push({ label: `关闭右侧（${right.length}）`, run: () => closeMany(right) });
      if (left.length + right.length > 0) {
        items.push({ label: `关闭其它（${left.length + right.length}）`, run: () => closeMany([...left, ...right]) });
      }
      return items;
    }

    function activate(path) {
      const file = files.get(path);
      if (!file) return;
      // 切走前把光标位置留住，切回来还在原处。
      stashCaret();
      pane.activePath = path;
      pane.previewMode = false;
      activePane = pane;
      renderAll();
      announceActive();
      el.area.focus();
      if (file.caret !== undefined) {
        el.area.selectionStart = el.area.selectionEnd = Math.min(file.caret, el.area.value.length);
      }
      el.area.scrollTop = file.scrollTop || 0;
      persist();
    }

    function stashCaret() {
      const file = activeFile();
      if (!file || pane.previewMode) return;
      file.caret = el.area.selectionStart;
      file.scrollTop = el.area.scrollTop;
    }

    function closeFile(path) {
      const file = files.get(path);
      if (!file) return;
      if (file.draft !== file.text) {
        // 未保存内容不能一点就没，必须问一句。
        if (!window.confirm(`「${file.name}」有未保存的修改，仍要关闭吗？`)) return;
      }
      dropFile(path);
      renderAll();
      syncDraftVisibility();
      persist();
    }

    /**
     * 不问不提示地移走一个文件。用于「同一路径被另一块编辑区接管」——
     * 那不是关闭，是搬家，草稿内容会在新的一块里原样出现。
     */
    function closeSilently(path) {
      if (!files.has(path)) return false;
      const file = files.get(path);
      const carry = file.draft !== file.text ? { hash: file.hash, draft: file.draft } : undefined;
      dropFile(path);
      renderAll();
      return carry ?? true;
    }

    function dropFile(path) {
      files.delete(path);
      conflicts.delete(path);
      if (pane.activePath === path) {
        pane.activePath = [...files.keys()].pop() || null;
        announceActive();
      }
    }

    // ---------------------------------------------------------------- 渲染

    function renderAll() {
      renderTabs();
      const file = activeFile();
      const hasFile = !!file;

      el.welcome.classList.toggle('hidden', hasFile);
      el.toolbar.classList.toggle('hidden', !hasFile);
      el.area.classList.toggle('hidden', !hasFile || pane.previewMode);
      el.preview.classList.toggle('hidden', !hasFile || !pane.previewMode);

      const conflict = hasFile ? conflicts.get(file.path) : undefined;
      el.conflict.classList.toggle('hidden', !conflict);
      if (conflict) {
        el.conflictText.textContent =
          `「${file.name}」在磁盘上已被改动（可能是你在别处编辑，或插件写入了内容）。` +
          '为不覆盖别人的修改，这次保存已取消。';
      }

      if (!hasFile) {
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

      // 预览与字体是两件事：章节可以是 .txt / 无扩展名，那时没有 Markdown
      // 可预览，但它仍是正文，该用正文字体而不是代码字体。
      const markdown = /\.(md|markdown)$/i.test(file.path);
      const code = /\.(json|ya?ml)$/i.test(file.path);
      el.previewBtn.classList.toggle('hidden', !markdown);
      el.previewBtn.textContent = pane.previewMode ? '编辑' : '预览';
      el.area.classList.toggle('mono', code);
      // draftPath 由后端给出（它知道什么算章节），前端不自己判断。
      el.draftBtn.classList.toggle('hidden', !file.draftPath);

      if (el.area.value !== file.draft) el.area.value = file.draft;
      if (pane.previewMode) renderPreview(el.preview, file.draft, file.path, pane);

      const dirty = file.draft !== file.text;
      el.saveBtn.disabled = !dirty;
      el.revertBtn.disabled = !dirty;
      updateStatus();
    }

    function updateStatus() {
      const file = activeFile();
      if (!file) return;
      const dirty = file.draft !== file.text;

      el.statusFile.textContent = file.name;
      el.statusWords.textContent = `${formatWords(countWords(file.draft))} · ${file.draft.length} 字符`;

      if (pane.previewMode) {
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
      if (!file) return;
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

    for (const evt of ['keyup', 'click', 'select']) {
      el.area.addEventListener(evt, updateStatus);
    }

    // 标签条空白处右键：以当前激活标签为准。
    onCtx(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));

    // 正文区菜单：预览模式没有可编辑内容，provider 返回空数组即不弹。
    onCtx(el.area, () => {
      if (pane.previewMode) return [];
      const hasSel = el.area.selectionStart !== el.area.selectionEnd;
      return [
        { label: '剪切', disabled: !hasSel, run: () => areaCut(el.area) },
        { label: '复制', disabled: !hasSel, run: () => areaCopy(el.area) },
        { label: '粘贴', run: () => areaPaste(el.area) },
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

    el.area.addEventListener('scroll', () => {
      const file = activeFile();
      if (file) file.scrollTop = el.area.scrollTop;
    });

    // Tab 在 textarea 里默认是切焦点；写作时更需要它插缩进。
    el.area.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const start = el.area.selectionStart;
      const end = el.area.selectionEnd;
      const value = el.area.value;
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        if (value.slice(lineStart, lineStart + 2) === '  ') {
          el.area.value = value.slice(0, lineStart) + value.slice(lineStart + 2);
          el.area.selectionStart = el.area.selectionEnd = Math.max(lineStart, start - 2);
          el.area.dispatchEvent(new Event('input'));
        }
        return;
      }
      el.area.value = `${value.slice(0, start)}  ${value.slice(end)}`;
      el.area.selectionStart = el.area.selectionEnd = start + 2;
      el.area.dispatchEvent(new Event('input'));
    });

    // 谁被点/被聚焦，谁就是「当前」这一块——Ctrl+S 保存的是它。
    // 换了一块就等于换了「正在编辑的文件」，资源管理器的高亮要跟着走。
    const claimFocus = () => {
      if (activePane === pane) return;
      activePane = pane;
      announceActive();
    };
    el.root.addEventListener('focusin', claimFocus);
    el.root.addEventListener('pointerdown', claimFocus);

    // ---------------------------------------------------------------- 保存

    function save(force) {
      const file = activeFile();
      if (!file) return;
      if (file.draft === file.text && !force) return;
      vscode.postMessage({
        type: 'saveFile',
        path: file.path,
        text: file.draft,
        // 空 baseHash = 放弃乐观锁，仅在用户明确选择「强制覆盖」时发生。
        baseHash: force ? undefined : file.hash,
      });
    }

    function applySaved(incoming) {
      const file = files.get(incoming.path);
      if (!file) return;
      file.text = incoming.text;
      file.hash = incoming.hash;
      // 保存期间用户可能又敲了几个字：只在内容一致时才提示成功。
      if (file.draft === incoming.text) {
        toast(`已保存 ${file.path}`);
      }
      // draftPath 后端每次都会带回；万一缺席也不要把已有的值冲掉，
      // 否则工具栏上的「草稿」按钮会在首次保存后消失。
      if (incoming.draftPath !== undefined) file.draftPath = incoming.draftPath;
      conflicts.delete(file.path);
      renderAll();
      persist();
    }

    function applyConflict(path, diskText, diskHash) {
      if (!files.has(path)) return;
      conflicts.set(path, { text: diskText, hash: diskHash });
      if (pane.activePath !== path) activate(path);
      else renderAll();
      toast('文件已被外部修改，保存已取消。', true);
    }

    el.saveBtn.addEventListener('click', () => save(false));

    el.revertBtn.addEventListener('click', () => {
      const file = activeFile();
      if (!file) return;
      if (file.draft !== file.text && !window.confirm(`放弃「${file.name}」的未保存修改？`)) return;
      vscode.postMessage({ type: 'reloadFile', path: file.path });
    });

    el.previewBtn.addEventListener('click', () => {
      stashCaret();
      pane.previewMode = !pane.previewMode;
      renderAll();
    });

    el.externalBtn.addEventListener('click', () => {
      const file = activeFile();
      if (file) vscode.postMessage({ type: 'openExternal', path: file.path });
    });

    el.draftBtn.addEventListener('click', () => {
      const file = activeFile();
      // 传的是**章节**路径：草稿路径由后端推导，并在缺席时按需创建。
      if (file) vscode.postMessage({ type: 'openDraft', path: file.path });
    });

    el.conflictTake.addEventListener('click', () => {
      const file = activeFile();
      const disk = file && conflicts.get(file.path);
      if (!file || !disk) return;
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
      if (!file) return;
      if (!window.confirm(`确定用编辑器里的内容覆盖磁盘上的「${file.name}」？磁盘上的改动会丢失。`)) return;
      save(true);
    });

    // ---------------------------------------------------------------- 收文件

    function upsertFile(incoming, carried) {
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
        const file = {
          path: incoming.path,
          name: incoming.name,
          text: incoming.text,
          hash: incoming.hash,
          draft: incoming.text,
          draftPath: incoming.draftPath,
          caret: 0,
          scrollTop: 0,
        };
        // 刷新前的未保存草稿（或从另一块编辑区搬过来的）：仅当磁盘内容未变
        // （hash 一致）才贴回去，否则拿旧内容盖新内容就是另一种静默覆盖。
        const restore = carried && carried.draft !== undefined ? carried : pending;
        if (restore && restore.draft !== undefined) {
          // moved：文件刚改名/搬家，hash 基线必然变了，草稿照贴；
          // 其余情况（刷新恢复）仍要求磁盘没变过。
          if (restore.moved || restore.hash === incoming.hash) {
            file.draft = restore.draft;
          } else {
            toast(`「${file.name}」在离开期间被改过，已放弃未保存的草稿。`, true);
          }
        }
        files.set(file.path, file);
        // 恢复阶段按存下来的 active 定位，其余情况新开的就是当前的。
        const wanted = pendingActive.get(pane.id);
        if (!wanted || wanted === file.path) {
          pane.activePath = file.path;
          if (wanted) pendingActive.delete(pane.id);
        } else if (!pane.activePath) {
          pane.activePath = file.path;
        }
      }

      pane.previewMode = false;
      renderAll();
      announceActive();
      persist();
    }

    renderAll();
    return pane;
  }

  // ---------------------------------------------------------------- 两块编辑区

  /** 从页面上固定的 id 收集主区的节点引用。 */
  function mainRefs() {
    return {
      root: stage,
      tabs: $('edTabs'),
      toolbar: $('edToolbar'),
      path: $('edPath'),
      saveBtn: $('edSaveBtn'),
      revertBtn: $('edRevertBtn'),
      previewBtn: $('edPreviewBtn'),
      draftBtn: $('edDraftBtn'),
      externalBtn: $('edExternalBtn'),
      area: $('edArea'),
      preview: $('edPreview'),
      welcome: $('edWelcome'),
      conflict: $('edConflict'),
      conflictText: $('edConflictText'),
      conflictTake: $('edConflictTake'),
      conflictForce: $('edConflictForce'),
      statusWords: $('edStatusWords'),
      statusPos: $('edStatusPos'),
      statusSave: $('edStatusSave'),
      statusFile: $('edStatusFile'),
    };
  }

  /**
   * 现造一块编辑区的 DOM，结构与 html.ts 里的主区一致。
   * 不给 id——引用直接握在手里，省得和主区的 id 撞车。
   */
  function createPaneElements(welcomeText) {
    const mk = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };

    const root = mk('section', 'wb-editor wb-editor-draft');
    const tabs = mk('div', 'ed-tabs');

    const toolbar = mk('div', 'ed-toolbar hidden');
    const path = mk('span', 'ed-path');
    const previewBtn = mk('button', 'chip-btn', '预览');
    previewBtn.title = '预览 Markdown';
    const draftBtn = mk('button', 'chip-btn hidden', '草稿');
    const revertBtn = mk('button', 'chip-btn', '还原');
    revertBtn.title = '放弃修改，重新从磁盘读取';
    const externalBtn = mk('button', 'chip-btn', '外部打开');
    externalBtn.title = '用系统默认程序打开';
    const saveBtn = mk('button', 'primary', '保存');
    saveBtn.title = '保存（Ctrl+S）';
    toolbar.append(path, previewBtn, draftBtn, revertBtn, externalBtn, saveBtn);

    const conflict = mk('div', 'ed-conflict hidden');
    const conflictText = mk('span', 'ed-conflict-text');
    const conflictTake = mk('button', 'chip-btn', '用磁盘版本覆盖编辑器');
    const conflictForce = mk('button', 'chip-btn', '用编辑器内容强制保存');
    conflict.append(conflictText, conflictTake, conflictForce);

    const stageEl = mk('div', 'ed-stage');
    const welcome = mk('div', 'ed-welcome');
    welcome.appendChild(mk('h2', undefined, welcomeText));
    const area = mk('textarea', 'ed-area hidden');
    area.spellcheck = false;
    area.wrap = 'soft';
    const preview = mk('div', 'ed-preview hidden');
    stageEl.append(welcome, area, preview);

    const status = mk('div', 'ed-status');
    const statusFile = mk('span');
    const statusWords = mk('span');
    const statusPos = mk('span');
    const statusSave = mk('span', 'ed-save-state');
    status.append(statusFile, statusWords, mk('span', 'spacer'), statusPos, statusSave);

    root.append(tabs, toolbar, conflict, stageEl, status);
    return {
      root, tabs, toolbar, path, saveBtn, revertBtn, previewBtn, draftBtn, externalBtn,
      area, preview, welcome, conflict, conflictText, conflictTake, conflictForce,
      statusWords, statusPos, statusSave, statusFile,
    };
  }

  const panes = { main: createPane('main', mainRefs()) };
  let activePane = panes.main;

  /** 草稿区惰性创建：没用过草稿的人不该多出一块空编辑区。 */
  function ensureDraftPane() {
    if (!panes.draft) {
      const refs = createPaneElements('这一块用来放草稿');
      shell.editors.appendChild(refs.root);
      panes.draft = createPane('draft', refs);
    }
    syncDraftVisibility();
    return panes.draft;
  }

  /** 草稿区里没有打开的文件时整块收起来，连同那条分隔条。 */
  function syncDraftVisibility() {
    const open = !!panes.draft && panes.draft.files.size > 0;
    if (panes.draft) panes.draft.el.root.classList.toggle('hidden', !open);
    shell.draftResizer.classList.toggle('hidden', !open);
  }

  /** 哪一块编辑区持有这个路径。单 pane 拥有权保证结果唯一。 */
  function paneOwning(path) {
    for (const pane of Object.values(panes)) {
      if (pane.files.has(path)) return pane;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- 持久化

  /**
   * 刷新页面不该丢掉未保存的修改——浏览器里 F5 太容易按到。
   * 存的是草稿与基线 hash，重连后重新拉一次文件再比对。
   */
  function persist() {
    try {
      const data = { v: 2, panes: {}, activePane: activePane.id };
      for (const [id, pane] of Object.entries(panes)) {
        data.panes[id] = pane.snapshot();
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* 隐私模式下 localStorage 可能不可写，丢了也不影响主流程 */
    }
  }

  let persistTimer;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

  function restore() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch {
      return;
    }
    if (!saved) return;
    // v1 只有一块编辑区，形状是 { open, active }——老用户的标签页不该在
    // 升级后凭空消失，按主区读进来。
    const stored = Array.isArray(saved.open)
      ? { main: { open: saved.open, active: saved.active } }
      : saved.panes || {};

    for (const paneId of ['main', 'draft']) {
      const data = stored[paneId];
      if (!data || !Array.isArray(data.open) || data.open.length === 0) continue;
      pendingActive.set(paneId, typeof data.active === 'string' ? data.active : null);
      for (const item of data.open) {
        if (!item || typeof item.path !== 'string') continue;
        // 先记下待恢复的草稿，等 editorOpen 回来时再贴上去。
        pendingDrafts.set(item.path, { hash: item.hash, draft: item.draft });
        vscode.postMessage({ type: 'openEditor', path: item.path, pane: paneId });
      }
    }
  }

  // ---------------------------------------------------------------- 主题

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    shell.themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
    shell.themeBtn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 存不下就只在本次会话生效 */
    }
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* 读不到就跟随系统 */
    }
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(saved === 'light' || saved === 'dark' ? saved : prefersLight ? 'light' : 'dark');
  }

  shell.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // ---------------------------------------------------------------- 拖拽调宽

  /** 两条分隔条共用一套指针拖拽：区别只在「拖到哪算多宽」。 */
  function makeResizer(handle, onDrag, onCommit, onReset) {
    let dragging = false;
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      onCommit();
    };
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) onDrag(e);
    });
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', onReset);
  }

  let sideWidth = 460;
  function setSideWidth(px) {
    // 两侧都留出可用空间，别让谁被拖没。
    sideWidth = Math.max(300, Math.min(px, Math.max(320, window.innerWidth - 360)));
    shell.side.style.width = `${sideWidth}px`;
  }

  let draftWidth = DEFAULT_DRAFT_WIDTH;
  function setDraftWidth(px) {
    draftWidth = Math.max(240, Math.min(px, Math.max(260, window.innerWidth - 640)));
    shell.editors.style.setProperty('--nf-draft-width', `${draftWidth}px`);
  }

  function readStoredNumber(key) {
    try {
      return Number(localStorage.getItem(key)) || 0;
    } catch {
      return 0;
    }
  }

  function storeNumber(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* 存不下就只在本次会话生效 */
    }
  }

  function initResizers() {
    const savedSide = readStoredNumber(WIDTH_KEY);
    if (savedSide) setSideWidth(savedSide);
    const savedDraft = readStoredNumber(DRAFT_WIDTH_KEY);
    setDraftWidth(savedDraft || DEFAULT_DRAFT_WIDTH);

    makeResizer(
      shell.resizer,
      (e) => {
        // 左边还有一条 62px 的活动栏，拖拽位置要把它减掉。
        const bar = document.getElementById('tabbar');
        const offset = bar ? bar.getBoundingClientRect().right : 0;
        setSideWidth(e.clientX - offset);
      },
      () => storeNumber(WIDTH_KEY, sideWidth),
      () => setSideWidth(460)
    );

    makeResizer(
      shell.draftResizer,
      // 草稿区在分隔条右边：往右拖是把它压窄。
      (e) => setDraftWidth(shell.editors.getBoundingClientRect().right - e.clientX),
      () => storeNumber(DRAFT_WIDTH_KEY, draftWidth),
      () => setDraftWidth(DEFAULT_DRAFT_WIDTH)
    );
  }

  // ---------------------------------------------------------------- 全局快捷键

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      // 浏览器的「保存网页」在这里毫无意义，一律拦掉。
      e.preventDefault();
      if (activePane.activeFile()) activePane.save(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && activePane.activeFile()) {
      // Chrome 不允许拦 Ctrl+W，能拦到就顺手关标签页。
      e.preventDefault();
      activePane.closeFile(activePane.activePath);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!Object.values(panes).some((p) => p.hasDirty())) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------------------------------------------------------------- 窄屏切换

  shell.editorToggle.addEventListener('click', () => {
    document.body.classList.toggle('editor-open');
  });

  function revealEditor() {
    // 窄屏下编辑区是覆盖层，打开文件时得把它翻上来。
    if (window.innerWidth <= 900) document.body.classList.add('editor-open');
  }

  // ---------------------------------------------------------------- 字数

  /** 与 core 的 countWords 同口径：中文按字、英文按词。 */
  function countWords(text) {
    const stripped = text.replace(/\s+/g, '');
    const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) || []).length;
    const words = (text.match(/[A-Za-z0-9']+/g) || []).length;
    return cjk + words;
  }

  function formatWords(n) {
    return n >= 10000 ? `${(n / 10000).toFixed(2)} 万字` : `${n} 字`;
  }

  // ---------------------------------------------------------------- 正文区剪贴板

  /**
   * 正文区的剪切/复制/粘贴。优先 execCommand——它保留 textarea 的
   * 原生撤销栈；Clipboard API 作为读剪贴板的正路（粘贴）与兜底（复制）。
   */
  function areaCopy(area) {
    area.focus();
    if (document.execCommand && document.execCommand('copy')) return;
    const text = area.value.slice(area.selectionStart, area.selectionEnd);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => toast('复制失败，请手动选中复制。', true));
    } else {
      toast('当前环境不支持剪贴板。', true);
    }
  }

  function areaCut(area) {
    area.focus();
    if (document.execCommand && document.execCommand('cut')) return;
    // 兜底：先复制再手动删选区。
    areaCopy(area);
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s;
    area.dispatchEvent(new Event('input'));
  }

  async function areaPaste(area) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('当前环境不支持剪贴板读取。', true);
      return;
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('粘贴失败：浏览器未授权剪贴板读取。', true);
      return;
    }
    area.focus();
    // insertText 保留撤销栈；不支持时退回手动拼接（丢撤销，但能贴上）。
    if (document.execCommand && document.execCommand('insertText', false, text)) return;
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + text + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s + text.length;
    area.dispatchEvent(new Event('input'));
  }

  // ---------------------------------------------------------------- Markdown 预览

  /**
   * 够用的块级渲染：标题、引用、列表、代码块、分隔线、frontmatter。
   * 全部走 createElement + textContent，不拼 HTML 字符串——正文里
   * 出现 `<script>` 也只是普通文字。
   */
  function renderPreview(target, text, fromPath, pane) {
    target.innerHTML = '';
    const lines = text.split('\n');
    let i = 0;

    // frontmatter 是元数据，单独框起来，不混进正文。
    if (lines[0] !== undefined && lines[0].trim() === '---') {
      const end = lines.indexOf('---', 1);
      if (end > 0) {
        const box = document.createElement('div');
        box.className = 'ed-frontmatter';
        box.textContent = lines.slice(1, end).join('\n');
        target.appendChild(box);
        i = end + 1;
      }
    }

    let paragraph = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      const p = document.createElement('p');
      appendInline(p, paragraph.join('\n'), fromPath, pane);
      target.appendChild(p);
      paragraph = [];
    };

    let list = null;
    const endList = () => {
      list = null;
    };

    for (; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '') {
        flush();
        endList();
        continue;
      }

      if (trimmed.startsWith('```')) {
        flush();
        endList();
        const buf = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) buf.push(lines[i]);
        const pre = document.createElement('pre');
        pre.textContent = buf.join('\n');
        target.appendChild(pre);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flush();
        endList();
        const h = document.createElement(`h${Math.min(heading[1].length, 3)}`);
        appendInline(h, heading[2], fromPath, pane);
        target.appendChild(h);
        continue;
      }

      if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
        flush();
        endList();
        target.appendChild(document.createElement('hr'));
        continue;
      }

      if (trimmed.startsWith('>')) {
        flush();
        endList();
        const quote = document.createElement('blockquote');
        appendInline(quote, trimmed.replace(/^>\s?/, ''), fromPath, pane);
        target.appendChild(quote);
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
      const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
      if (bullet || ordered) {
        flush();
        const want = bullet ? 'UL' : 'OL';
        if (!list || list.tagName !== want) {
          list = document.createElement(bullet ? 'ul' : 'ol');
          target.appendChild(list);
        }
        const li = document.createElement('li');
        appendInline(li, bullet ? bullet[1] : ordered[2], fromPath, pane);
        list.appendChild(li);
        continue;
      }

      endList();
      paragraph.push(line);
    }
    flush();
  }

  /** 行内：**粗**、*斜*、`码`、[文本](链接)。其余原样。 */
  function appendInline(parent, text, fromPath, pane) {
    const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const token = m[0];
      if (token.startsWith('**')) {
        const b = document.createElement('strong');
        b.textContent = token.slice(2, -2);
        parent.appendChild(b);
      } else if (token.startsWith('`')) {
        const c = document.createElement('code');
        c.textContent = token.slice(1, -1);
        parent.appendChild(c);
      } else if (token.startsWith('[')) {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const href = token.slice(split + 2, -1);
        // 工程内的相对 md 链接点开就是另一个标签页，比跳浏览器有用。
        if (/^https?:\/\//i.test(href)) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noreferrer noopener';
          a.textContent = label;
          parent.appendChild(a);
        } else {
          const a = document.createElement('button');
          a.className = 'link';
          a.textContent = label;
          // 在哪一块预览里点的，就开在哪一块。
          a.addEventListener('click', () =>
            vscode.postMessage({ type: 'openEditor', path: resolveRelative(fromPath, href), pane: pane.id })
          );
          parent.appendChild(a);
        }
      } else {
        const it = document.createElement('em');
        it.textContent = token.slice(1, -1);
        parent.appendChild(it);
      }
      last = m.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /** `.novelforge/characters/a.md` + `../lore/b.md` → `.novelforge/lore/b.md` */
  function resolveRelative(fromPath, href) {
    const target = decodeURI(href.split('#')[0]);
    if (!fromPath || target.startsWith('/')) return target.replace(/^\//, '');
    const parts = fromPath.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  // ---------------------------------------------------------------- 标签搬家

  /**
   * explorer.js 在 rename/move 成功后广播的搬家事件：把旧标签连同
   * 未保存草稿整体挪到新路径。
   *
   * 走 pendingDrafts 的 `moved` 标记绕开 hash 相等检查——改名后
   * 文件的 hash 基线必然变化，但草稿本身没有理由丢。
   */
  window.addEventListener('nf-files-moved', (event) => {
    const from = event.detail && event.detail.from;
    const to = event.detail && event.detail.to;
    if (!from || !to) return;
    const pane = paneOwning(from);
    if (!pane) return;
    const file = pane.files.get(from);
    const carry = file.draft !== file.text ? { hash: file.hash, draft: file.draft, moved: true } : undefined;
    pane.closeSilently(from);
    rekeyStorage(from, to);
    if (carry) pendingDrafts.set(to, carry);
    pendingActive.set(pane.id, to);
    vscode.postMessage({ type: 'openEditor', path: to, pane: pane.id });
  });

  /** 刷新恢复用的 localStorage 里，旧路径条目改写成新路径，草稿不丢。 */
  function rekeyStorage(from, to) {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data || !data.panes) return;
      for (const paneData of Object.values(data.panes)) {
        if (!paneData || !Array.isArray(paneData.open)) continue;
        for (const item of paneData.open) {
          if (item && item.path === from) item.path = to;
        }
        if (paneData.active === from) paneData.active = to;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* 读不下/写不进都无所谓，最坏退化为丢一次刷新恢复 */
    }
  }

  // ---------------------------------------------------------------- 收消息

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'editorOpen': {
        const target = msg.pane === 'draft' ? ensureDraftPane() : panes.main;
        // 一个路径同一时刻只属于一块编辑区。已经开在另一块里的，
        // 连同未保存的内容一起搬过来，不留两份各自漂移的副本。
        let carried;
        for (const pane of Object.values(panes)) {
          if (pane !== target) {
            const moved = pane.closeSilently(msg.file.path);
            if (moved && moved !== true) carried = moved;
          }
        }
        // 先认下当前这一块，再收文件：upsertFile 末尾会广播「正在编辑哪个
        // 文件」，那句读的是 activePane，顺序反了会报出上一块的文件。
        activePane = target;
        target.upsertFile(msg.file, carried);
        syncDraftVisibility();
        revealEditor();
        break;
      }
      case 'editorSaved': {
        (paneOwning(msg.file.path) ?? panes.main).applySaved(msg.file);
        break;
      }
      case 'editorConflict': {
        const owner = paneOwning(msg.path);
        if (owner) owner.applyConflict(msg.path, msg.diskText, msg.diskHash);
        break;
      }
      case 'editorError':
        toast(msg.message, true);
        // 恢复时文件可能已被删/改名，别让它卡在待恢复列表里。
        pendingDrafts.delete(msg.path);
        break;
    }
  });

  // ---------------------------------------------------------------- 启动

  initTheme();
  initResizers();
  syncDraftVisibility();
  restore();
})();
