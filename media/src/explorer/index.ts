/**
 * 独立版的资源管理器（侧栏「文件」页）。插件形态里没有这块 DOM，本文件直接
 * 退出——那边由 VS Code 自己的资源管理器承担，不必也不该再画一棵。
 *
 * 与「工程」页的区别：那边是按语义整理过的视图（章节按序号倒序、摘要新鲜度、
 * 角色别名），只看得见三个可管理区里的文件；这里是磁盘上真实的目录结构，
 * 一个都不藏——**包括 `.novelforge/` 这类点开头的目录**，摘要、会话、
 * project.json 都在里面，工程页给不了入口。
 */
import { byId, maybeById } from '../dom';
import { announceFileMoved, onContextMenu, toast } from '../globals';
import { acquireApi, onMessage } from '../vscodeApi';
import { pasteInto, bind, refresh, requestDirs, setClipboard } from './actions';
import { renderDir } from './rows';
import {
  expandTo,
  listings,
  markAllPending,
  openDirs,
  parentOf,
  pending,
  persistOpen,
  restoreOpen,
  state,
} from './state';

const body = maybeById('filesBody');
// 插件形态没有这块 DOM，直接退出。
if (body) {
  start(body);
}

function start(body: HTMLElement): void {
  const vscode = acquireApi();
  bind({ post: (msg) => vscode.postMessage(msg), render });

  /** 整棵树重画。滚动位置留住——刷新/高亮变化不该把用户拽回顶部。 */
  function render(): void {
    const scroll = body.scrollTop;
    body.innerHTML = '';
    for (const row of renderDir('', 0)) {
      body.appendChild(row);
    }
    body.scrollTop = scroll;
  }

  function setActive(path: string | null): void {
    if (state.activeFile === path) {
      return;
    }
    state.activeFile = path || null;
    render();
  }

  // ---------------------------------------------------------------- 工具栏

  byId('filesRefresh').addEventListener('click', refresh);

  byId('filesCollapse').addEventListener('click', () => {
    openDirs.clear();
    openDirs.add('');
    persistOpen();
    requestDirs();
    render();
  });

  byId('filesReveal').addEventListener('click', () => {
    if (!state.activeFile) {
      toast('编辑器里还没有打开文件。');
      return;
    }
    expandTo(state.activeFile);
    persistOpen();
    requestDirs();
    render();
    // 展开的目录可能还没载入，行要等下一次 dirListings 才画得出来；
    // 已经载入的则立刻滚过去。
    body.querySelector('.fx-row.active')?.scrollIntoView({ block: 'nearest' });
  });

  // ---------------------------------------- 空白区菜单与剪贴板快捷键

  // 树里的空白处（没命中任何行）：给一条粘贴到工程根。
  onContextMenu(body, () => [
    { label: '粘贴到工程根目录', disabled: !state.clipboard, run: () => pasteInto('') },
    { sep: true },
    { label: '刷新', run: refresh },
  ]);

  // 快捷键只认「文件」页激活且树里有选中行——编辑器里的文本 Ctrl+C/V
  // 走不到这里（焦点不在树上），互不干扰。
  document.addEventListener('keydown', (e) => {
    const entry = state.selectedEntry;
    if (!(e.ctrlKey || e.metaKey) || !entry) {
      return;
    }
    if (!maybeById('pane-files')?.classList.contains('active')) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      setClipboard('copy', [entry.relPath]);
    } else if (key === 'x') {
      e.preventDefault();
      setClipboard('cut', [entry.relPath]);
    } else if (key === 'v') {
      e.preventDefault();
      pasteInto(entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath));
    }
  });

  // ---------------------------------------------------------------- 收消息

  onMessage((msg) => {
    switch (msg.type) {
      case 'dirListings':
        for (const listing of msg.listings) {
          listings.set(listing.relPath, listing);
          pending.delete(listing.relPath);
        }
        render();
        break;

      case 'filesOpDone':
        // 剪切态清除（仅 move 成功时）；复制态保留——可以在别处再粘一次。
        if (msg.op === 'move' && state.clipboard?.op === 'cut') {
          state.clipboard = null;
        }
        // 改名/搬家的结果广播给编辑器，让它把标签挪到新路径。
        for (const r of msg.results) {
          if (r.ok && r.to && (msg.op === 'rename' || msg.op === 'move')) {
            announceFileMoved(r.from, r.to);
          }
        }
        markAllPending();
        requestDirs();
        render();
        break;

      // 「打开文件」不只来自这棵树——工程页点章节、模型采纳写入后都会开。
      // 跟着高亮，作者才看得出现在编辑的是哪一个。
      case 'editorOpen':
        setActive(msg.file.path);
        break;
    }
  });

  // editor.js 在切标签页/关标签页时广播当前激活的文件，高亮跟着它走。
  window.addEventListener('nf-editor-active', (e) => setActive(e.detail.path));

  // ---------------------------------------------------------------- 启动

  restoreOpen();
  // 首帧就要一份：切到「文件」页时树已经在了，不必等一次往返才看见东西。
  requestDirs();
  render();
}
