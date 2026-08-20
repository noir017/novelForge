/**
 * 空窗口 Get Started、窗口标题、无工程时侧栏短空态。
 *
 * 没有 `#nfWelcome` 就直接 return（插件）。不判断壳名。
 */
import { el as mk } from '../dom';
import type { WorkspaceItem, WorkspaceRecent } from '../protocol';
import { el } from './refs';
import { hasWorkspace, store, vscode } from './store';

const EMPTY_HINT = '打开文件夹后即可使用';
const SIDE_PANES = ['pane-chat', 'pane-project', 'pane-files', 'pane-history'];

let fileName: string | null = null;
let about: HTMLElement | undefined;

export function requestOpenFolder(): void {
  pickFolder('open', '打开文件夹');
}

export function requestNewProject(): void {
  pickFolder('new', '新建工程：选择一个空目录');
}

function pickFolder(intent: 'open' | 'new', title: string): void {
  const ev = new CustomEvent('nf-pick-folder', { detail: { intent }, cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) {
    return;
  }
  // 目录选择器在下一期接上；在那之前先用路径框，Recent 条目仍直接打开。
  const path = window.prompt(title, '');
  if (path?.trim()) {
    openRecent(path.trim());
  }
}

export function openRecent(root: string): void {
  vscode.postMessage({ type: 'openFolder', path: root, mode: 'replace' });
}

export function closeFolder(): void {
  if (!hasWorkspace()) {
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
}): void {
  store.currentId = msg.currentId;
  store.recents = msg.recents ?? [];
  const empty = msg.currentId === null;
  document.body.classList.toggle('no-workspace', empty);
  if (empty) {
    document.body.classList.remove('show-welcome');
    fileName = null;
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
  el.targetSelect.disabled = !on;
  el.targetWords.disabled = !on;
  el.agentToggle.disabled = !on;
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
    pane.appendChild(mk('div', 'ws-empty', EMPTY_HINT));
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
