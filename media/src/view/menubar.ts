/**
 * 独立版标题栏「文件 / 编辑 / 帮助」。没有 `#wbMenubar` 就直接 return（插件）。
 *
 * 不复用右键菜单引擎：缺悬停切菜单和子菜单。
 */
import { el as mk } from '../dom';
import { commandEditor, queryEditor } from '../globals';
import {
  closeFolder,
  hideWelcome,
  openRecent,
  requestNewProject,
  requestOpenFile,
  requestOpenFolder,
  showAbout,
  showWelcome,
} from './welcome';
import { hasWorkspace, store, vscode } from './store';

type MenuAction = string;

interface MenuEntry {
  label: string;
  action?: MenuAction;
  disabled?: boolean;
  kbd?: string;
  submenu?: SubEntry[];
}

interface SubEntry {
  label: string;
  detail?: string;
  action?: MenuAction;
  arg?: string;
  disabled?: boolean;
}

let openKey: string | null = null;
let drop: HTMLElement | undefined;
let subDrop: HTMLElement | undefined;

export function installMenubar(): void {
  const bar = document.getElementById('wbMenubar');
  if (!bar) {
    return;
  }

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.wb-menu-btn');
    if (!btn?.dataset.menu) {
      return;
    }
    e.stopPropagation();
    if (openKey === btn.dataset.menu) {
      closeMenubar();
      return;
    }
    openMenu(btn.dataset.menu, btn);
  });

  bar.addEventListener('mouseover', (e) => {
    if (!openKey) {
      return;
    }
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.wb-menu-btn');
    if (!btn?.dataset.menu || btn.dataset.menu === openKey) {
      return;
    }
    openMenu(btn.dataset.menu, btn);
  });

  document.addEventListener('click', () => closeMenubar());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenubar();
      hideWelcome();
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'o') {
      e.preventDefault();
      requestOpenFolder();
      closeMenubar();
    } else if (key === 'n') {
      e.preventDefault();
      if (hasWorkspace()) {
        run('newFile');
      }
      closeMenubar();
    }
  });
}

function openMenu(key: string, btn: HTMLElement): void {
  closeMenubar();
  openKey = key;
  btn.classList.add('open');
  drop = buildDrop(entriesOf(key));
  document.body.appendChild(drop);
  const rect = btn.getBoundingClientRect();
  drop.style.left = `${Math.round(rect.left)}px`;
  drop.style.top = `${Math.round(rect.bottom)}px`;
}

function closeMenubar(): void {
  openKey = null;
  drop?.remove();
  drop = undefined;
  subDrop?.remove();
  subDrop = undefined;
  for (const btn of document.querySelectorAll('.wb-menu-btn.open')) {
    btn.classList.remove('open');
  }
}

function entriesOf(key: string): MenuEntry[] {
  const ws = hasWorkspace();
  const editing = isEditing();
  const ed = queryEditor();
  if (key === 'file') {
    return [
      { label: '新建文件', action: 'newFile', disabled: !ws, kbd: 'Ctrl+N' },
      { label: '新建工程…', action: 'newProject' },
      { label: 'sep' },
      { label: '打开文件…', action: 'openFile', disabled: !ws },
      { label: '打开文件夹…', action: 'openFolder', kbd: 'Ctrl+O' },
      { label: '打开最近打开的', submenu: recentEntries() },
      { label: 'sep' },
      { label: '保存', action: 'save', disabled: !ed.dirtyCurrent, kbd: 'Ctrl+S' },
      { label: '另存为…', action: 'saveAs', disabled: !ed.hasFile },
      { label: '全部保存', action: 'saveAll', disabled: !ed.dirtyAny },
      { label: 'sep' },
      { label: '关闭编辑器', action: 'closeEditor', disabled: !ed.hasFile },
      { label: '关闭文件夹', action: 'closeFolder', disabled: !ws },
      { label: 'sep' },
      { label: '退出', action: 'quit' },
    ];
  }
  if (key === 'edit') {
    return [
      { label: '撤销', action: 'undo', disabled: !editing, kbd: 'Ctrl+Z' },
      { label: '重做', action: 'redo', disabled: !editing, kbd: 'Ctrl+Y' },
      { label: 'sep' },
      { label: '剪切', action: 'cut', disabled: !editing, kbd: 'Ctrl+X' },
      { label: '复制', action: 'copy', disabled: !editing, kbd: 'Ctrl+C' },
      { label: '粘贴', action: 'paste', disabled: !editing, kbd: 'Ctrl+V' },
      { label: 'sep' },
      { label: '全选', action: 'selectAll', disabled: !editing, kbd: 'Ctrl+A' },
      { label: 'sep' },
      { label: '查找', action: 'find', disabled: !ws, kbd: 'Ctrl+F' },
    ];
  }
  return [
    { label: '欢迎页面', action: 'welcome' },
    { label: '使用说明', action: 'readme' },
    { label: '打开日志目录', action: 'openLogDir' },
    { label: 'sep' },
    { label: '关于', action: 'about' },
  ];
}

function recentEntries(): SubEntry[] {
  if (store.recents.length === 0) {
    return [{ label: '没有最近打开的工程', disabled: true }];
  }
  return store.recents.map((r) => ({
    label: r.name,
    detail: r.root,
    action: 'recent',
    arg: r.root,
  }));
}

function buildDrop(entries: MenuEntry[], submenu = false): HTMLElement {
  const menu = mk('div', submenu ? 'wb-menu-drop submenu' : 'wb-menu-drop');
  for (const entry of entries) {
    if (entry.label === 'sep') {
      menu.appendChild(mk('div', 'wb-menu-sep'));
      continue;
    }
    const btn = mk('button', 'wb-menu-item');
    btn.type = 'button';
    if (entry.disabled) {
      btn.disabled = true;
    }
    btn.appendChild(mk('span', 'wb-menu-label', entry.label));
    if (entry.kbd) {
      btn.appendChild(mk('span', 'wb-menu-kbd', entry.kbd));
    } else if (entry.submenu) {
      btn.appendChild(mk('span', 'wb-menu-arrow', '›'));
    }
    if (entry.submenu) {
      btn.addEventListener('mouseenter', () => showSubmenu(btn, entry.submenu!));
      btn.addEventListener('click', (e) => e.stopPropagation());
    } else {
      btn.addEventListener('mouseenter', () => hideSubmenu());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.disabled || !entry.action) {
          return;
        }
        run(entry.action);
        closeMenubar();
      });
    }
    menu.appendChild(btn);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
  return menu;
}

function showSubmenu(anchor: HTMLElement, entries: SubEntry[]): void {
  hideSubmenu();
  anchor.classList.add('open');
  subDrop = mk('div', 'wb-menu-drop submenu');
  for (const entry of entries) {
    const btn = mk('button', 'wb-menu-item');
    btn.type = 'button';
    if (entry.disabled) {
      btn.disabled = true;
    }
    const label = mk('span', 'wb-menu-label', entry.label);
    btn.appendChild(label);
    if (entry.detail) {
      btn.title = entry.detail;
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (entry.disabled) {
        return;
      }
      if (entry.action === 'recent' && entry.arg) {
        openRecent(entry.arg);
      }
      closeMenubar();
    });
    subDrop.appendChild(btn);
  }
  document.body.appendChild(subDrop);
  const rect = anchor.getBoundingClientRect();
  subDrop.style.left = `${Math.round(rect.right)}px`;
  subDrop.style.top = `${Math.round(rect.top)}px`;
}

function hideSubmenu(): void {
  drop?.querySelectorAll('.wb-menu-item.open').forEach((n) => n.classList.remove('open'));
  subDrop?.remove();
  subDrop = undefined;
}

function run(action: MenuAction): void {
  switch (action) {
    case 'newFile':
      newFile();
      return;
    case 'newProject':
      requestNewProject();
      return;
    case 'openFile':
      requestOpenFile();
      return;
    case 'openFolder':
      requestOpenFolder();
      return;
    case 'save':
      commandEditor('save');
      return;
    case 'saveAs':
      saveAs();
      return;
    case 'saveAll':
      commandEditor('saveAll');
      return;
    case 'closeEditor':
      commandEditor('close');
      return;
    case 'closeFolder':
      closeFolder();
      return;
    case 'quit':
      window.close();
      return;
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
    case 'selectAll':
      document.execCommand(action === 'selectAll' ? 'selectAll' : action);
      return;
    case 'find':
      commandEditor('find');
      return;
    case 'welcome':
      showWelcome();
      return;
    case 'readme':
      vscode.postMessage({ type: 'openReadme' });
      return;
    case 'openLogDir':
      vscode.postMessage({ type: 'openLogDir' });
      return;
    case 'about':
      showAbout();
      return;
    default:
      return;
  }
}

function newFile(): void {
  if (!hasWorkspace()) {
    return;
  }
  const rel = window.prompt('工程内相对路径（已存在则拒绝）', '');
  if (rel?.trim()) {
    vscode.postMessage({ type: 'createFile', relPath: rel.trim() });
  }
}

function saveAs(): void {
  const ed = queryEditor();
  if (!ed.hasFile) {
    return;
  }
  const rel = window.prompt('另存为（工程内相对路径，不覆盖已有）', '');
  if (!rel?.trim()) {
    return;
  }
  vscode.postMessage({ type: 'createFile', relPath: rel.trim(), text: ed.text });
}

function isEditing(): boolean {
  const node = document.activeElement;
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}
