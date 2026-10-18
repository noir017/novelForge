/**
 * 独立版的资源管理器（侧栏「文件」页）。插件形态里没有这块 DOM，本文件直接
 * 退出——那边由 VS Code 自己的资源管理器承担，不必也不该再画一棵。
 *
 * 与「工程」页的区别：那边是按语义整理过的视图（章节按序号倒序、定稿状态、
 * 角色别名），只看得见三个可管理区里的文件；这里是磁盘上真实的目录结构，
 * 一个都不藏——**包括 `.novelforge/` 这类点开头的目录**，细纲、会话、
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
    // 刚定位的那一行画出来了：滚到它（它所在的目录可能要等下一次 dirListings 才有）。
    if (state.pendingScroll) {
      const row = [...body.querySelectorAll<HTMLElement>('.fx-row')].find((r) => r.dataset.path === state.pendingScroll);
      if (row) {
        state.pendingScroll = null;
        row.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  /**
   * 编辑器那边要在「文件」页定位到某个文件或目录（面包屑的目录段、标签右键「在文件页中定位」）：
   * 展开到它（目录连它自己一起展开）、标出那一行、画出来就滚过去。切页签是 view 的事。
   */
  function reveal(path: string, dir: boolean): void {
    if (path) {
      expandTo(dir ? `${path}/_` : path);
    }
    state.revealed = path || null;
    state.pendingScroll = path || null;
    persistOpen();
    requestDirs();
    render();
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

  // 快捷键只认「文件」页激活、树里有选中行、**这一下按在树上**（焦点在某一行上）。从前只看前两样：
  // 在文件页点开一个文件之后焦点进了编辑区，那一行仍是「选中」的，于是编辑区里的 Ctrl+C / X / V
  // 被这里拦下来，复制的成了那个文件、粘贴的成了文件粘贴（键登记在 editor/shortcuts.ts 的「文件页」那一组）。
  document.addEventListener('keydown', (e) => {
    const entry = state.selectedEntry;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !entry) {
      return;
    }
    if (!(e.target instanceof Node) || !body.contains(e.target)) {
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
  // 编辑器的面包屑目录段、标签右键「在文件页中定位」。
  window.addEventListener('nf-reveal-in-files', (e) => reveal(e.detail.path, e.detail.dir));

  // ---------------------------------------------------------------- 启动

  restoreOpen();
  // 首帧就要一份：切到「文件」页时树已经在了，不必等一次往返才看见东西。
  requestDirs();
  render();
}
