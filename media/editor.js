// @ts-check
/*
 * 独立版的内置文件编辑器。只在独立版加载（插件形态由 VS Code 自己的编辑器负责），
 * 因此这里可以自由使用 localStorage、beforeunload 等 webview 里不该用的能力。
 *
 * 与 view.js 完全解耦：各自监听 window 的 message 事件、各自 postMessage，
 * 互不调用。唯一的交集是共用 #toast（经 view.js 暴露的 __nfToast）。
 *
 * 协议：
 *   发 openEditor / saveFile / reloadFile / openExternal
 *   收 editorOpen / editorSaved / editorConflict / editorError
 */
(function () {
  const stage = document.getElementById('wbEditor');
  // 插件形态没有这块 DOM，直接退出。
  if (!stage) return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    tabs: $('edTabs'),
    toolbar: $('edToolbar'),
    path: $('edPath'),
    saveBtn: $('edSaveBtn'),
    revertBtn: $('edRevertBtn'),
    previewBtn: $('edPreviewBtn'),
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
    themeBtn: $('wbThemeBtn'),
    editorToggle: $('wbEditorToggle'),
    side: $('wbSide'),
    resizer: $('wbResizer'),
  };

  const STORE_KEY = 'novelforge.editor.v1';
  const THEME_KEY = 'novelforge.theme';
  const WIDTH_KEY = 'novelforge.sideWidth';

  /**
   * 打开的文件。key 是工程内相对路径。
   * `text` 是磁盘基线，`draft` 是编辑器里的当前内容，两者不等即为脏。
   * `hash` 是保存时的乐观锁基线，磁盘上变了就报冲突而不是覆盖。
   */
  const files = new Map();
  let activePath = null;
  let previewMode = false;
  /** 冲突时暂存的磁盘版本，供「用磁盘版本覆盖」使用。 */
  const conflicts = new Map();

  const toast = (message, isError) => {
    if (typeof window.__nfToast === 'function') window.__nfToast(message, isError);
  };

  // ---------------------------------------------------------------- 持久化

  /**
   * 刷新页面不该丢掉未保存的修改——浏览器里 F5 太容易按到。
   * 存的是草稿与基线 hash，重连后重新拉一次文件再比对。
   */
  function persist() {
    try {
      const open = [...files.values()].map((f) => ({
        path: f.path,
        hash: f.hash,
        draft: f.draft === f.text ? undefined : f.draft,
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify({ open, active: activePath }));
    } catch {
      /* 隐私模式下 localStorage 可能不可写，丢了也不影响主流程 */
    }
  }

  function restore() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch {
      return;
    }
    if (!saved || !Array.isArray(saved.open) || saved.open.length === 0) return;
    // 先记下待恢复的草稿，等 editorOpen 回来时再贴上去。
    for (const item of saved.open) {
      if (!item || typeof item.path !== 'string') continue;
      pendingDrafts.set(item.path, { hash: item.hash, draft: item.draft });
      vscode.postMessage({ type: 'openEditor', path: item.path });
    }
    pendingActive = typeof saved.active === 'string' ? saved.active : null;
  }

  /** path -> { hash, draft }，等对应的 editorOpen 到达时消费。 */
  const pendingDrafts = new Map();
  let pendingActive = null;

  // ---------------------------------------------------------------- 主题

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    el.themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
    el.themeBtn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
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

  el.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // ---------------------------------------------------------------- 侧栏宽度

  function initResizer() {
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(WIDTH_KEY)) || 0;
    } catch {
      /* 用默认宽度 */
    }
    if (saved) setSideWidth(saved);

    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      // 左边还有一条 62px 的活动栏，拖拽位置要把它减掉。
      const bar = document.getElementById('tabbar');
      const offset = bar ? bar.getBoundingClientRect().right : 0;
      setSideWidth(e.clientX - offset);
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      el.resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(currentWidth));
      } catch {
        /* 存不下就只在本次会话生效 */
      }
    };
    el.resizer.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.resizer.classList.add('dragging');
      document.body.classList.add('resizing');
      el.resizer.setPointerCapture(e.pointerId);
    });
    el.resizer.addEventListener('pointermove', onMove);
    el.resizer.addEventListener('pointerup', stop);
    el.resizer.addEventListener('pointercancel', stop);
    // 双击复位到默认宽度。
    el.resizer.addEventListener('dblclick', () => setSideWidth(460));
  }

  let currentWidth = 460;
  function setSideWidth(px) {
    // 两侧都留出可用空间，别让谁被拖没。
    currentWidth = Math.max(300, Math.min(px, Math.max(320, window.innerWidth - 360)));
    el.side.style.width = `${currentWidth}px`;
  }

  // ---------------------------------------------------------------- 标签

  function renderTabs() {
    el.tabs.innerHTML = '';
    for (const file of files.values()) {
      const tab = document.createElement('div');
      tab.className = 'ed-tab';
      tab.classList.toggle('active', file.path === activePath);
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
      el.tabs.appendChild(tab);
    }
  }

  function activate(path) {
    const file = files.get(path);
    if (!file) return;
    // 切走前把光标位置留住，切回来还在原处。
    stashCaret();
    activePath = path;
    previewMode = false;
    renderAll();
    el.area.focus();
    if (file.caret !== undefined) {
      el.area.selectionStart = el.area.selectionEnd = Math.min(file.caret, el.area.value.length);
    }
    el.area.scrollTop = file.scrollTop || 0;
    persist();
  }

  function stashCaret() {
    const file = activeFile();
    if (!file || previewMode) return;
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
    files.delete(path);
    conflicts.delete(path);
    if (activePath === path) {
      const next = [...files.keys()].pop();
      activePath = next || null;
    }
    renderAll();
    persist();
  }

  // ---------------------------------------------------------------- 渲染

  function activeFile() {
    return activePath ? files.get(activePath) : undefined;
  }

  function renderAll() {
    renderTabs();
    const file = activeFile();
    const hasFile = !!file;

    el.welcome.classList.toggle('hidden', hasFile);
    el.toolbar.classList.toggle('hidden', !hasFile);
    el.area.classList.toggle('hidden', !hasFile || previewMode);
    el.preview.classList.toggle('hidden', !hasFile || !previewMode);

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
      return;
    }

    el.path.textContent = file.path;
    el.path.title = file.path;

    const markdown = /\.(md|markdown)$/i.test(file.path);
    el.previewBtn.classList.toggle('hidden', !markdown);
    el.previewBtn.textContent = previewMode ? '编辑' : '预览';
    el.area.classList.toggle('mono', !markdown);

    if (el.area.value !== file.draft) el.area.value = file.draft;
    if (previewMode) renderPreview(file.draft);

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

  let persistTimer;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

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

  el.saveBtn.addEventListener('click', () => save(false));

  el.revertBtn.addEventListener('click', () => {
    const file = activeFile();
    if (!file) return;
    if (file.draft !== file.text && !window.confirm(`放弃「${file.name}」的未保存修改？`)) return;
    vscode.postMessage({ type: 'reloadFile', path: file.path });
  });

  el.previewBtn.addEventListener('click', () => {
    stashCaret();
    previewMode = !previewMode;
    renderAll();
  });

  el.externalBtn.addEventListener('click', () => {
    const file = activeFile();
    if (file) vscode.postMessage({ type: 'openExternal', path: file.path });
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

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      // 浏览器的「保存网页」在这里毫无意义，一律拦掉。
      e.preventDefault();
      if (activeFile()) save(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && activeFile()) {
      // Chrome 不允许拦 Ctrl+W，能拦到就顺手关标签页。
      e.preventDefault();
      closeFile(activePath);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    const dirty = [...files.values()].some((f) => f.draft !== f.text);
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------------------------------------------------------------- 窄屏切换

  el.editorToggle.addEventListener('click', () => {
    document.body.classList.toggle('editor-open');
  });

  function revealEditor() {
    // 窄屏下编辑区是覆盖层，打开文件时得把它翻上来。
    if (window.innerWidth <= 900) document.body.classList.add('editor-open');
  }

  // ---------------------------------------------------------------- Markdown 预览

  /**
   * 够用的块级渲染：标题、引用、列表、代码块、分隔线、frontmatter。
   * 全部走 createElement + textContent，不拼 HTML 字符串——正文里
   * 出现 `<script>` 也只是普通文字。
   */
  function renderPreview(text) {
    el.preview.innerHTML = '';
    const lines = text.split('\n');
    let i = 0;

    // frontmatter 是元数据，单独框起来，不混进正文。
    if (lines[0] !== undefined && lines[0].trim() === '---') {
      const end = lines.indexOf('---', 1);
      if (end > 0) {
        const box = document.createElement('div');
        box.className = 'ed-frontmatter';
        box.textContent = lines.slice(1, end).join('\n');
        el.preview.appendChild(box);
        i = end + 1;
      }
    }

    let paragraph = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      const p = document.createElement('p');
      appendInline(p, paragraph.join('\n'));
      el.preview.appendChild(p);
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
        el.preview.appendChild(pre);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flush();
        endList();
        const h = document.createElement(`h${Math.min(heading[1].length, 3)}`);
        appendInline(h, heading[2]);
        el.preview.appendChild(h);
        continue;
      }

      if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
        flush();
        endList();
        el.preview.appendChild(document.createElement('hr'));
        continue;
      }

      if (trimmed.startsWith('>')) {
        flush();
        endList();
        const quote = document.createElement('blockquote');
        appendInline(quote, trimmed.replace(/^>\s?/, ''));
        el.preview.appendChild(quote);
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
      const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
      if (bullet || ordered) {
        flush();
        const want = bullet ? 'UL' : 'OL';
        if (!list || list.tagName !== want) {
          list = document.createElement(bullet ? 'ul' : 'ol');
          el.preview.appendChild(list);
        }
        const li = document.createElement('li');
        appendInline(li, bullet ? bullet[1] : ordered[2]);
        list.appendChild(li);
        continue;
      }

      endList();
      paragraph.push(line);
    }
    flush();
  }

  /** 行内：**粗**、*斜*、`码`、[文本](链接)。其余原样。 */
  function appendInline(parent, text) {
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
          a.addEventListener('click', () => open(resolveRelative(activePath, href)));
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

  function open(path) {
    vscode.postMessage({ type: 'openEditor', path });
  }

  // ---------------------------------------------------------------- 收消息

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'editorOpen': {
        upsertFile(msg.file);
        break;
      }
      case 'editorSaved': {
        const file = files.get(msg.file.path);
        if (!file) break;
        file.text = msg.file.text;
        file.hash = msg.file.hash;
        // 保存期间用户可能又敲了几个字：只在内容一致时才清脏标记。
        if (file.draft === msg.file.text) {
          toast(`已保存 ${file.path}`);
        }
        conflicts.delete(file.path);
        renderAll();
        persist();
        break;
      }
      case 'editorConflict': {
        const file = files.get(msg.path);
        if (!file) break;
        conflicts.set(msg.path, { text: msg.diskText, hash: msg.diskHash });
        if (activePath !== msg.path) activate(msg.path);
        else renderAll();
        toast('文件已被外部修改，保存已取消。', true);
        break;
      }
      case 'editorError':
        toast(msg.message, true);
        // 恢复时文件可能已被删/改名，别让它卡在待恢复列表里。
        pendingDrafts.delete(msg.path);
        break;
    }
  });

  function upsertFile(incoming) {
    const existing = files.get(incoming.path);
    const pending = pendingDrafts.get(incoming.path);
    pendingDrafts.delete(incoming.path);

    if (existing) {
      // 已打开：这是一次 reload（放弃修改 / 冲突后取磁盘版）。
      existing.text = incoming.text;
      existing.hash = incoming.hash;
      existing.draft = incoming.text;
      conflicts.delete(incoming.path);
      activePath = incoming.path;
    } else {
      const file = {
        path: incoming.path,
        name: incoming.name,
        text: incoming.text,
        hash: incoming.hash,
        draft: incoming.text,
        caret: 0,
        scrollTop: 0,
      };
      // 刷新前的未保存草稿：仅当磁盘内容未变（hash 一致）才贴回去，
      // 否则拿旧草稿盖新内容就是另一种静默覆盖。
      if (pending && pending.draft !== undefined) {
        if (pending.hash === incoming.hash) {
          file.draft = pending.draft;
        } else {
          toast(`「${file.name}」在离开期间被改过，已放弃未保存的草稿。`, true);
        }
      }
      files.set(file.path, file);
      // 恢复阶段按存下来的 active 定位，其余情况新开的就是当前的。
      if (!pendingActive || pendingActive === file.path) {
        activePath = file.path;
        if (pendingActive) pendingActive = null;
      } else if (!activePath) {
        activePath = file.path;
      }
    }

    previewMode = false;
    renderAll();
    revealEditor();
    persist();
  }

  // ---------------------------------------------------------------- 启动

  initTheme();
  initResizer();
  renderAll();
  restore();
})();
