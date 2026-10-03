/**
 * 空窗口 Get Started、窗口标题、无工程时侧栏短空态。
 *
 * 没有 `#nfWelcome` 就直接 return（插件）。不判断壳名。
 */
import { el as mk } from '../dom';
import { confirmProceedIfDirty, resetEditor, windowProject } from '../globals';
import type { WorkspaceItem, WorkspaceRecent } from '../protocol';
import { el } from './refs';
import { hasWorkspace, store, vscode } from './store';
import { toast } from './toast';

const EMPTY_HINT = '打开文件夹后即可使用';
const SIDE_PANES = ['pane-chat', 'pane-project', 'pane-files', 'pane-history'];

let fileName: string | null = null;
let about: HTMLElement | undefined;
/** 新建工程：打开成功且换了工作区之后再跑初始化。 */
let pendingInit = false;

export function markPendingInit(): void {
  pendingInit = true;
}

export function requestOpenFolder(): void {
  pickFolder('open', '打开文件夹');
}

export function requestNewProject(): void {
  pickFolder('new', '新建工程：选择一个空目录');
}

export function requestOpenFile(): void {
  if (!hasWorkspace()) {
    return;
  }
  pickFolder('file', '打开文件：工程内相对路径');
}

function pickFolder(intent: 'open' | 'new' | 'file', title: string): void {
  const ev = new CustomEvent('nf-pick-folder', { detail: { intent }, cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) {
    return;
  }
  const path = window.prompt(title, '');
  if (!path?.trim()) {
    return;
  }
  if (intent === 'file') {
    vscode.postMessage({ type: 'openEditor', path: path.trim() });
    return;
  }
  openProject(path.trim(), { init: intent === 'new' });
}

export function openRecent(root: string): void {
  openProject(root);
}

/** 新窗口网址上的这个参数：打开之后跑一遍新建工程的初始化。 */
const INIT_PARAM = 'init';

/**
 * 打开一个工程。这个窗口已经开着别的工程、且设置里开着「新窗口中打开项目」时开一个新窗口，
 * 这个窗口不动；否则换掉这个窗口里的工程。`init`：新建工程，打开后跑初始化。
 */
export function openProject(root: string, opts: { init?: boolean } = {}): void {
  if (store.openInNewWindow && store.currentId && store.currentId !== root) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('project', root);
    if (opts.init) {
      url.searchParams.set(INIT_PARAM, '1');
    }
    if (window.open(url.toString(), '_blank')) {
      return;
    }
    toast('浏览器拦下了新窗口，改在当前窗口打开。');
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  if (opts.init) {
    markPendingInit();
  }
  vscode.postMessage({ type: 'openFolder', path: root, mode: 'replace' });
}

/**
 * 网址跟着这个窗口的工程走：刷新、断线重连都回到这个工程（WebSocket 握手带着它），
 * 收藏下来的网址也直接打开它。插件的 webview 没有可改的网址。
 */
function syncUrl(currentId: string | null): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return;
  }
  if (windowProject() === currentId) {
    return;
  }
  const url = new URL(location.href);
  if (currentId) {
    url.searchParams.set('project', currentId);
  } else {
    url.searchParams.delete('project');
  }
  history.replaceState(history.state, '', url.toString());
}

export function closeFolder(): void {
  if (!hasWorkspace()) {
    return;
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  vscode.postMessage({ type: 'closeFolder' });
}

export function showWelcome(): void {
  const node = document.getElementById('nfWelcome');
  if (!node) {
    return;
  }
  if (store.currentId === null) {
    return;
  }
  document.body.classList.add('show-welcome');
}

export function hideWelcome(): void {
  document.body.classList.remove('show-welcome');
}

export function showAbout(): void {
  if (!about) {
    return;
  }
  const version = document.getElementById('wbTitle')?.dataset.version || '0.0.0';
  const ver = about.querySelector('.nf-about-ver');
  const pathLine = about.querySelector('.nf-about-path');
  if (ver) {
    ver.textContent = `版本 ${version}`;
  }
  if (pathLine) {
    const root = store.currentId;
    pathLine.textContent = root ? `工程 ${root}` : '';
  }
  about.classList.add('open');
}

export function applyWorkspaces(msg: {
  currentId: string | null;
  items: WorkspaceItem[];
  recents: WorkspaceRecent[];
  openInNewWindow?: boolean;
}): void {
  const prev = store.currentId;
  store.currentId = msg.currentId;
  store.recents = msg.recents ?? [];
  if (typeof msg.openInNewWindow === 'boolean') {
    store.openInNewWindow = msg.openInNewWindow;
  }
  // 先改网址再重置编辑器：标签页按网址上的工程分开记，重置之后要读的是新工程那一份。
  syncUrl(msg.currentId);
  const empty = msg.currentId === null;
  document.body.classList.toggle('no-workspace', empty);
  if (empty) {
    document.body.classList.remove('show-welcome');
    fileName = null;
  }
  if (prev !== undefined && msg.currentId !== prev) {
    resetEditor();
  }
  if (pendingInit) {
    if (msg.currentId && msg.currentId !== prev) {
      vscode.postMessage({ type: 'projectAction', action: 'initProject' });
    }
    pendingInit = false;
  }
  updateTitle(msg.items[0]);
  renderRecents();
  syncComposerLock();
}

export function installWelcome(): void {
  const root = document.getElementById('nfWelcome');
  if (!root) {
    return;
  }

  ensureSideEmptyHints();
  about = buildAbout();
  document.body.appendChild(about);

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-welcome]');
    if (!btn?.dataset.welcome) {
      return;
    }
    if (btn.dataset.welcome === 'openFolder') {
      requestOpenFolder();
    } else if (btn.dataset.welcome === 'newProject') {
      requestNewProject();
    }
  });

  window.addEventListener('nf-editor-active', (e) => {
    fileName = fileNameOf(e.detail.path);
    if (e.detail.path) {
      hideWelcome();
    }
    updateTitle();
  });

  // 新建工程开在了新窗口里：打开之后由这个窗口跑初始化。参数用过就摘掉，刷新不再跑一遍。
  const url = new URL(location.href);
  if (url.searchParams.has(INIT_PARAM)) {
    markPendingInit();
    url.searchParams.delete(INIT_PARAM);
    history.replaceState(history.state, '', url.toString());
  }

  // 没指定工程的 MCP 调用落到最近操作的那个窗口上：拿到焦点就告诉后端一声。
  window.addEventListener('focus', () => vscode.postMessage({ type: 'windowFocus' }));

  if (document.body.classList.contains('no-workspace')) {
    applyWorkspaces({ currentId: null, items: [], recents: [] });
  }
}

function syncComposerLock(): void {
  const on = hasWorkspace();
  el.input.disabled = !on;
  el.sendBtn.disabled = !on || store.busy;
  el.atBtn.disabled = !on || store.busy;
  el.selBtn.disabled = !on || store.busy;
  el.cmdBtn.disabled = !on || store.busy;
  el.modelSelect.disabled = !on;
  el.thinkSelect.disabled = !on;
  el.targetSelect.disabled = !on;
  el.newSessionBtn.disabled = !on || store.busy;
  el.renamePlotBtn.disabled = !on || store.busy;
  el.nextStepBtn.disabled = !on || store.busy;
}

function updateTitle(item?: WorkspaceItem): void {
  const current = item ?? (store.currentId ? { id: store.currentId, root: store.currentId, name: nameOf(store.currentId) } : undefined);
  const titleText = document.getElementById('wbTitleText');
  let title = 'Novel Forge';
  if (current) {
    title = fileName ? `${fileName} - ${current.name} - Novel Forge` : `${current.name} - Novel Forge`;
  }
  if (titleText) {
    titleText.textContent = title;
  }
  document.title = title;
}

function renderRecents(): void {
  const list = document.getElementById('nfRecentList');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (store.recents.length === 0) {
    list.appendChild(mk('li', 'nf-recent-empty', '没有最近打开的工程'));
    return;
  }
  for (const rec of store.recents) {
    const li = mk('li');
    const btn = mk('button');
    btn.type = 'button';
    btn.appendChild(mk('span', undefined, rec.name));
    btn.appendChild(mk('span', 'nf-recent-path', rec.root));
    btn.addEventListener('click', () => openRecent(rec.root));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function ensureSideEmptyHints(): void {
  for (const id of SIDE_PANES) {
    const pane = document.getElementById(id);
    if (!pane || pane.querySelector('.ws-empty')) {
      continue;
    }
    // 遮罩上也给一颗「打开文件夹…」（W12）：侧栏的每一页都看得见下一步，不必先找到欢迎页。
    const box = mk('div', 'ws-empty');
    const inner = mk('div', 'ws-empty-inner');
    inner.appendChild(mk('p', undefined, EMPTY_HINT));
    const btn = mk('button', 'chip-btn', '打开文件夹…');
    btn.dataset.welcome = 'openFolder';
    btn.addEventListener('click', () => requestOpenFolder());
    inner.appendChild(btn);
    box.appendChild(inner);
    pane.appendChild(box);
  }
}

function buildAbout(): HTMLElement {
  const wrap = mk('div', 'nf-about');
  const card = mk('div', 'nf-about-card');
  card.appendChild(mk('h2', undefined, 'Novel Forge'));
  card.appendChild(mk('p', 'nf-about-ver', '版本'));
  card.appendChild(mk('p', 'nf-about-path'));
  const close = mk('button', 'primary', '关闭');
  close.type = 'button';
  close.addEventListener('click', () => wrap.classList.remove('open'));
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) {
      wrap.classList.remove('open');
    }
  });
  card.appendChild(close);
  wrap.appendChild(card);
  return wrap;
}

function fileNameOf(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function nameOf(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || root;
}
