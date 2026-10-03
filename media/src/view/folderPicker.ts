/**
 * VS Code 远程风目录选择器。没有菜单栏（插件）就不装。
 *
 * 文件夹模式走 `listHostDir`；文件模式锁在当前工程，走 `listDir`（ephemeral，
 * 不冲掉资源管理器的关注集合）。选本机文件模式（`hostFile`，后端 `Host.pickHostFile` 推来的
 * `prompt kind: 'file'`）也走 `listHostDir`，只列目录与允许的扩展名，选定或取消都回 `promptResult`。
 */
import { el as mk } from '../dom';
import type { DirListing, OutMessage } from '../protocol';
import { hasWorkspace, store, vscode } from './store';
import { openProject } from './welcome';
import { onMessage } from '../vscodeApi';

type Intent = 'open' | 'new' | 'file' | 'hostFile';

interface PickerState {
  intent: Intent;
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  selected?: string;
  /** 选本机文件：后端在等的那个弹窗，与允许的扩展名（小写、不带点）。 */
  requestId?: string;
  extensions?: string[];
  title?: string;
}

let wrap: HTMLElement | undefined;
let titleEl: HTMLElement | undefined;
let pathInput: HTMLInputElement | undefined;
let listEl: HTMLElement | undefined;
let okBtn: HTMLButtonElement | undefined;
let mkdirBtn: HTMLButtonElement | undefined;
let state: PickerState | undefined;

export function installFolderPicker(): void {
  if (!document.getElementById('wbMenubar')) {
    return;
  }

  wrap = build();
  document.body.appendChild(wrap);

  window.addEventListener('nf-pick-folder', (e) => {
    e.preventDefault();
    openPicker(e.detail.intent);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap?.classList.contains('open')) {
      closePicker();
    }
  });

  onMessage((msg) => {
    if (!state) {
      return;
    }
    if (msg.type === 'hostDir' && state.intent !== 'file') {
      applyHostDir(msg);
    } else if (msg.type === 'dirListings' && state.intent === 'file') {
      const listing = msg.listings[0];
      if (listing) {
        applyDirListing(listing);
      }
    }
  });
}

export function openPicker(intent: Intent): void {
  if (!wrap || !titleEl || !pathInput) {
    return;
  }
  if (intent === 'file' && !hasWorkspace()) {
    return;
  }
  state = { intent, path: '', entries: [], truncated: 0 };
  wrap.classList.add('open');
  titleEl.textContent = titleOf(intent);
  if (mkdirBtn) {
    mkdirBtn.hidden = intent === 'file';
  }
  if (intent === 'file') {
    vscode.postMessage({ type: 'listDir', dirs: [''], ephemeral: true });
  } else {
    // 起点是这个窗口开着的工程，空窗口才落到家目录。
    vscode.postMessage({ type: 'listHostDir', path: store.currentId || '~' });
  }
  pathInput.focus();
}

/**
 * 选本机文件：后端那头的 `pickHostFile` 在等，选定之外的一切关法（取消、×、Esc、点空白）都回一个
 * undefined，不能只把遮罩藏起来。
 */
export function openHostFilePicker(requestId: string, title: string, startDir: string, extensions: string[]): void {
  if (!wrap || !titleEl || !pathInput) {
    vscode.postMessage({ type: 'promptResult', requestId, value: undefined });
    return;
  }
  if (state?.intent === 'hostFile') {
    closePicker();
  }
  state = {
    intent: 'hostFile',
    path: '',
    entries: [],
    truncated: 0,
    requestId,
    title,
    extensions: extensions.map((e) => e.replace(/^\./, '').toLowerCase()),
  };
  wrap.classList.add('open');
  titleEl.textContent = titleOf('hostFile');
  if (mkdirBtn) {
    mkdirBtn.hidden = true;
  }
  vscode.postMessage({ type: 'listHostDir', path: startDir || '~' });
  pathInput.focus();
}

function closePicker(answer?: string): void {
  if (state?.intent === 'hostFile' && state.requestId) {
    vscode.postMessage({ type: 'promptResult', requestId: state.requestId, value: answer });
  }
  wrap?.classList.remove('open');
  state = undefined;
}

function allowed(name: string): boolean {
  const exts = state?.extensions ?? [];
  const dot = name.lastIndexOf('.');
  return exts.length === 0 || (dot > 0 && exts.includes(name.slice(dot + 1).toLowerCase()));
}

function titleOf(intent: Intent): string {
  if (intent === 'new') {
    return '新建工程：选择一个空目录';
  }
  if (intent === 'file') {
    return '打开文件';
  }
  if (intent === 'hostFile') {
    const exts = state?.extensions?.length ? `（${state.extensions.map((e) => `.${e}`).join(' / ')}）` : '';
    return `${state?.title ?? '选择文件'}${exts}`;
  }
  return '打开文件夹';
}

function applyHostDir(msg: Extract<OutMessage, { type: 'hostDir' }>): void {
  if (!state || !pathInput) {
    return;
  }
  state.path = msg.path;
  state.parent = msg.parent;
  state.entries = state.intent === 'hostFile' ? msg.entries.filter((e) => e.kind === 'dir' || allowed(e.name)) : msg.entries;
  state.truncated = msg.truncated;
  state.error = msg.error;
  state.selected = undefined;
  pathInput.value = msg.path;
  renderList(msg.roots);
  syncOk();
}

function applyDirListing(listing: DirListing): void {
  if (!state || !pathInput) {
    return;
  }
  state.path = listing.relPath;
  state.parent = listing.relPath ? parentOf(listing.relPath) : undefined;
  state.entries = listing.entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    absPath: e.relPath,
  }));
  state.truncated = listing.truncated;
  state.error = listing.error;
  state.selected = undefined;
  pathInput.value = listing.relPath || '/';
  renderList(false);
  syncOk();
}

function renderList(roots?: boolean): void {
  if (!listEl || !state) {
    return;
  }
  listEl.innerHTML = '';
  if (state.error) {
    listEl.appendChild(mk('div', 'nf-picker-error', state.error));
  }
  if (state.parent !== undefined && !roots) {
    listEl.appendChild(row('..', 'dir', state.parent, true));
  }
  for (const entry of state.entries) {
    listEl.appendChild(row(entry.name, entry.kind, entry.absPath, false));
  }
  if (state.truncated) {
    listEl.appendChild(mk('div', 'nf-picker-more', `另有条目未列出（共 ${state.truncated}）`));
  }
}

function row(name: string, kind: 'dir' | 'file', target: string, up: boolean): HTMLElement {
  const btn = mk('button', 'nf-picker-row');
  btn.type = 'button';
  btn.dataset.kind = kind;
  btn.dataset.target = target;
  btn.appendChild(mk('span', 'nf-picker-kind', kind === 'dir' ? '📁' : '📄'));
  btn.appendChild(mk('span', undefined, name));
  if (up) {
    btn.classList.add('up');
  }
  btn.addEventListener('click', () => onRow(kind, target, up));
  return btn;
}

function onRow(kind: 'dir' | 'file', target: string, up: boolean): void {
  if (!state) {
    return;
  }
  if (kind === 'dir' || up) {
    navigate(target);
    return;
  }
  if (state.intent !== 'file' && state.intent !== 'hostFile') {
    return;
  }
  state.selected = target;
  highlightSelection();
  syncOk();
}

function highlightSelection(): void {
  if (!listEl || !state) {
    return;
  }
  for (const node of listEl.querySelectorAll('.nf-picker-row')) {
    node.classList.toggle('selected', (node as HTMLElement).dataset.target === state.selected);
  }
}

function navigate(target: string): void {
  if (!state) {
    return;
  }
  if (state.intent === 'file') {
    vscode.postMessage({ type: 'listDir', dirs: [target], ephemeral: true });
    return;
  }
  vscode.postMessage({ type: 'listHostDir', path: target });
}

function syncOk(): void {
  if (!okBtn || !state) {
    return;
  }
  okBtn.disabled = state.intent === 'file' || state.intent === 'hostFile' ? !state.selected : !state.path;
}

function confirm(): void {
  if (!state) {
    return;
  }
  if (state.intent === 'hostFile') {
    if (state.selected) {
      closePicker(state.selected);
    }
    return;
  }
  if (state.intent === 'file') {
    if (!state.selected) {
      return;
    }
    vscode.postMessage({ type: 'openEditor', path: state.selected });
    closePicker();
    return;
  }
  const chosen = state.path;
  const intent = state.intent;
  closePicker();
  openProject(chosen, { init: intent === 'new' });
}

function mkdir(): void {
  if (!state || state.intent === 'file') {
    return;
  }
  const name = window.prompt('新建文件夹名称', '');
  if (!name?.trim()) {
    return;
  }
  vscode.postMessage({ type: 'createHostDir', parent: state.path, name: name.trim() });
}

function jumpToTyped(): void {
  if (!state || !pathInput) {
    return;
  }
  const typed = pathInput.value.trim();
  if (state.intent === 'file') {
    const rel = typed === '/' ? '' : typed.replace(/^\/+/, '');
    vscode.postMessage({ type: 'listDir', dirs: [rel], ephemeral: true });
    return;
  }
  // 直接粘了一个文件的完整路径：扩展名对得上就当选定，读不读得到由后端说。
  if (state.intent === 'hostFile' && typed && allowed(typed.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')) {
    closePicker(typed);
    return;
  }
  vscode.postMessage({ type: 'listHostDir', path: typed });
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function build(): HTMLElement {
  const root = mk('div', 'nf-picker');
  const card = mk('div', 'nf-picker-card');
  titleEl = mk('h2');
  pathInput = mk('input');
  pathInput.type = 'text';
  pathInput.spellcheck = false;
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToTyped();
    }
  });
  listEl = mk('div', 'nf-picker-list');

  const actions = mk('div', 'nf-picker-actions');
  mkdirBtn = mk('button', 'chip-btn', '新建文件夹');
  mkdirBtn.type = 'button';
  mkdirBtn.addEventListener('click', mkdir);
  const cancel = mk('button', 'chip-btn', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => closePicker());
  okBtn = mk('button', 'primary', '确定');
  okBtn.type = 'button';
  okBtn.addEventListener('click', confirm);
  actions.append(mkdirBtn, cancel, okBtn);

  card.append(titleEl, pathInput, listEl, actions);
  root.appendChild(card);
  root.addEventListener('click', (e) => {
    if (e.target === root) {
      closePicker();
    }
  });
  return root;
}
