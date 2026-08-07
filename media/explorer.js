// 独立版的资源管理器（侧栏「文件」页）。插件形态里没有这块 DOM，本文件直接退出——
// 那边由 VS Code 自己的资源管理器承担，不必也不该再画一棵。
//
// 与「工程」页的区别：那边是按语义整理过的视图（章节按序号倒序、摘要新鲜度、
// 角色别名），只看得见三个可管理区里的文件；这里是磁盘上真实的目录结构，
// 一个都不藏——**包括 `.novelforge/` 这类点开头的目录**，摘要、会话、
// project.json 都在里面，工程页给不了入口。
(function () {
  const body = document.getElementById('filesBody');
  if (!body) return;

  const vscode = acquireVsCodeApi();
  const toast = (message, isError) => {
    if (window.__nfToast) window.__nfToast(message, isError);
  };
  /** view.js 的右键菜单登记表。没有就退化为「没有右键菜单」，不影响主流程。 */
  const onContextMenu = window.__nfContextMenu || ((node) => node);

  const OPEN_KEY = 'novelforge.files.open';

  /**
   * 展开着的目录（工程内相对路径，空串是工程根）。
   *
   * 工程根永远在集合里：它就是这棵树本身，折叠它等于把整页清空。
   * 每次变化都把**全量**发给后端（`listDir`），后端据此记住该关注哪些目录，
   * 工程有变动时照着重推——不必等用户手动折叠再展开一次才看到新文件。
   */
  const openDirs = new Set(['']);
  /** relPath -> DirListing。后端整批替换，这里也整批更新。 */
  const listings = new Map();
  /** 已经请求过、还没等到回应的目录：画一行「载入中…」而不是空白。 */
  const pending = new Set();
  /** 编辑器里当前激活的文件路径，树上高亮它。 */
  let activeFile = null;

  // ---------------------------------------------------------------- 与后端往返

  /** 把当前展开集合整个报给后端。折叠也走这条——少一条「取消关注」的消息。 */
  function requestDirs() {
    const dirs = [...openDirs];
    for (const dir of dirs) {
      if (!listings.has(dir)) pending.add(dir);
    }
    vscode.postMessage({ type: 'listDir', dirs });
  }

  function persistOpen() {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...openDirs]));
    } catch {
      /* 隐私模式下写不进去，退化为仅本次会话保留 */
    }
  }

  function restoreOpen() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;
    for (const dir of saved) {
      if (typeof dir === 'string') openDirs.add(dir);
    }
  }

  function toggleDir(relPath) {
    if (openDirs.has(relPath)) {
      openDirs.delete(relPath);
      // 连同子目录一起收起来：再展开时它们不该凭空还开着，
      // 后端那边也不必继续为看不见的目录读盘。
      for (const dir of [...openDirs]) {
        if (dir.startsWith(`${relPath}/`)) openDirs.delete(dir);
      }
    } else {
      openDirs.add(relPath);
    }
    persistOpen();
    // 先请求再画：requestDirs 会把没数据的目录记进 pending，
    // 顺序反了刚展开的那一层会显示「（未载入）」而不是「载入中…」。
    requestDirs();
    render();
  }

  /** 展开到某个路径（含其全部祖先目录）。「定位当前文件」与外部跳转用。 */
  function expandTo(relPath) {
    const parts = relPath.split('/');
    let cur = '';
    // 最后一段是文件本身，不进展开集合。
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      openDirs.add(cur);
    }
    persistOpen();
    requestDirs();
    render();
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * 整棵树重画。与工程页同一套取舍：**产出扁平的行数组**，层级靠
   * paddingLeft 缩进表达而非嵌套 DOM——折叠只是重画一遍，不必搬 DOM 子树。
   */
  function render() {
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const rows = renderDir('', 0);
    for (const row of rows) body.appendChild(row);
    body.scrollTop = scroll;
  }

  function renderDir(relPath, depth) {
    const listing = listings.get(relPath);
    const rows = [];
    if (!listing) {
      rows.push(hintRow(pending.has(relPath) ? '载入中…' : '（未载入）', depth));
      return rows;
    }
    if (listing.error) {
      rows.push(hintRow(listing.error, depth, true));
      return rows;
    }
    if (listing.entries.length === 0) {
      rows.push(hintRow('（空文件夹）', depth));
      return rows;
    }
    for (const entry of listing.entries) {
      if (entry.kind === 'dir') {
        rows.push(dirRow(entry, depth));
        if (openDirs.has(entry.relPath)) {
          rows.push(...renderDir(entry.relPath, depth + 1));
        }
      } else {
        rows.push(fileRow(entry, depth));
      }
    }
    if (listing.truncated) {
      // 不静默截断：让作者知道这个目录里还有东西没画出来。
      rows.push(hintRow(`另有 ${listing.truncated - listing.entries.length} 项未列出（共 ${listing.truncated} 项）`, depth, true));
    }
    return rows;
  }

  /** 一行的公共骨架：缩进 + 可选的折叠箭头 + 图标 + 名字。 */
  function baseRow(depth) {
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    return row;
  }

  function dirRow(entry, depth) {
    const row = baseRow(depth);
    row.classList.add('fx-dir');
    const open = openDirs.has(entry.relPath);

    const caret = document.createElement('span');
    caret.className = 'fx-caret';
    caret.textContent = open ? '⌄' : '›';
    row.appendChild(caret);

    const icon = document.createElement('span');
    icon.className = 'fx-icon';
    icon.textContent = open ? '📂' : '📁';
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'fx-name';
    name.textContent = entry.name;
    // 点开头的目录（.novelforge/.vscode）压暗一点，与 VS Code 一致：
    // 它们看得见、打得开，但不该跟正文抢注意力。
    if (entry.name.startsWith('.')) row.classList.add('fx-dotted');
    row.appendChild(name);

    row.addEventListener('click', () => toggleDir(entry.relPath));
    onContextMenu(row, () => [
      { label: open ? '折叠' : '展开', run: () => toggleDir(entry.relPath) },
      { label: '在系统中打开', run: () => vscode.postMessage({ type: 'openExternal', path: entry.relPath }) },
      { sep: true },
      { label: '复制相对路径', run: () => copyPath(entry.relPath) },
    ]);
    return row;
  }

  function fileRow(entry, depth) {
    const row = baseRow(depth);
    row.classList.add('fx-file');
    if (entry.relPath === activeFile) row.classList.add('active');
    if (!entry.editable) row.classList.add('fx-binary');
    if (entry.name.startsWith('.')) row.classList.add('fx-dotted');

    // 文件行没有折叠箭头，但要占住同样的宽度，名字才与同级目录对齐。
    const spacer = document.createElement('span');
    spacer.className = 'fx-caret';
    row.appendChild(spacer);

    const icon = document.createElement('span');
    icon.className = 'fx-icon';
    icon.textContent = iconFor(entry);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'fx-name';
    name.textContent = entry.name;
    row.appendChild(name);

    const size = document.createElement('span');
    size.className = 'fx-size';
    size.textContent = formatBytes(entry.bytes);
    row.appendChild(size);

    row.title = `${entry.relPath}${entry.editable ? '' : '（不是文本文件，将用系统默认程序打开）'}`;
    row.addEventListener('click', () => openEntry(entry));
    onContextMenu(row, () => [
      {
        label: entry.editable ? '打开' : '打开（外部程序）',
        run: () => openEntry(entry),
      },
      { label: '在系统中打开', run: () => vscode.postMessage({ type: 'openExternal', path: entry.relPath }) },
      { sep: true },
      { label: '复制相对路径', run: () => copyPath(entry.relPath) },
    ]);
    return row;
  }

  function hintRow(text, depth, isError) {
    const row = baseRow(depth);
    row.classList.add('fx-hint');
    if (isError) row.classList.add('err');
    row.textContent = text;
    return row;
  }

  /**
   * 打开一个条目。可编辑的进内置编辑器，其余交系统默认程序——
   * 「能不能编辑」由后端算好（与 fileEditing.ts 同一份规则），
   * 前端不复刻扩展名白名单，也就不会去撞一个必然失败的 openEditor。
   */
  function openEntry(entry) {
    if (entry.editable) {
      vscode.postMessage({ type: 'openEditor', path: entry.relPath });
    } else {
      vscode.postMessage({ type: 'openExternal', path: entry.relPath });
    }
  }

  function copyPath(relPath) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(relPath).then(
        () => toast(`已复制：${relPath}`),
        () => toast('复制失败，请手动选中。', true)
      );
    } else {
      toast('当前环境不支持剪贴板。', true);
    }
  }

  /** 按扩展名给个图标。纯装饰，认不出就用通用的那个。 */
  function iconFor(entry) {
    const name = entry.name.toLowerCase();
    if (/\.(md|markdown)$/.test(name)) return '📝';
    if (/\.(json|ya?ml)$/.test(name)) return '⚙';
    if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/.test(name)) return '🖼';
    if (/\.(zip|rar|7z|gz|tar)$/.test(name)) return '📦';
    if (!entry.editable) return '▪';
    return '📄';
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------- 工具栏

  document.getElementById('filesRefresh').addEventListener('click', () => {
    // 后端重新读盘：把已有结果标记为待刷新，但不清空——清了会闪一下白。
    for (const dir of openDirs) pending.add(dir);
    requestDirs();
  });

  document.getElementById('filesCollapse').addEventListener('click', () => {
    openDirs.clear();
    openDirs.add('');
    persistOpen();
    requestDirs();
    render();
  });

  document.getElementById('filesReveal').addEventListener('click', () => {
    if (!activeFile) {
      toast('编辑器里还没有打开文件。');
      return;
    }
    expandTo(activeFile);
    // 展开的目录可能还没载入，行要等下一次 dirListings 才画得出来；
    // 已经载入的则立刻滚过去。
    scrollToActive();
  });

  function scrollToActive() {
    const row = [...body.querySelectorAll('.fx-row.active')][0];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- 收消息

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'dirListings') {
      for (const listing of msg.listings) {
        listings.set(listing.relPath, listing);
        pending.delete(listing.relPath);
      }
      render();
      return;
    }

    // 「打开文件」不只来自这棵树——工程页点章节、模型采纳写入后都会开。
    // 跟着高亮，作者才看得出现在编辑的是哪一个。
    if (msg.type === 'editorOpen' && msg.file) {
      setActive(msg.file.path);
    }
  });

  // editor.js 在切标签页/关标签页时广播当前激活的文件，树上的高亮跟着它走。
  window.addEventListener('nf-editor-active', (event) => {
    setActive(event.detail && event.detail.path);
  });

  function setActive(path) {
    if (activeFile === path) return;
    activeFile = path || null;
    render();
  }

  // ---------------------------------------------------------------- 启动

  restoreOpen();
  // 首帧就要一份：切到「文件」页时树已经在了，不必等一次往返才看见东西。
  requestDirs();
  render();
})();
