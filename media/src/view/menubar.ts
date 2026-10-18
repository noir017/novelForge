/**
 * 独立版标题栏「文件 / 编辑 / 视图 / 帮助」。没有 `#wbMenubar` 就直接 return（插件）。
 *
 * 不复用右键菜单引擎：缺悬停切菜单和子菜单。
 */
import { el as mk } from '../dom';
import { commandEditor, queryEditor } from '../globals';
import { versionsMenuEntry } from './versionsMenu';
import { quickOpenMenuEntry } from './quickOpenMenu';
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
import { paragraphMenuEntries } from './paragraphMenu';
import { viewMenuEntries } from './viewMenu';

type MenuAction = string;

export interface MenuEntry {
  label: string;
  action?: MenuAction;
  disabled?: boolean;
  kbd?: string;
  submenu?: SubEntry[];
  /** 可勾选的项：给了就在左边画 ✓（true）或留空（false）。 */
  checked?: boolean;
  /** 点了做什么。给了就不走 `action` 那张表（功能模块自带的项用它，不必往 `run` 里加分支）。 */
  run?: () => void;
  /** 悬停提示（置灰时说为什么）。 */
  detail?: string;
}

export interface SubEntry {
  label: string;
  detail?: string;
  action?: MenuAction;
  arg?: string;
  disabled?: boolean;
  checked?: boolean;
  run?: () => void;
}

let openKey: string | null = null;
let drop: HTMLElement | undefined;
let subDrop: HTMLElement | undefined;

export function installMenubar(): void {
  const bar = document.getElementById('wbMenubar');
  if (!bar) {
    return;
  }

  // 点菜单不抢焦点：「编辑」里的撤销 / 剪切 / 粘贴作用于点菜单之前光标所在的那个输入框，
  // 按钮在 mousedown 时把焦点拿走的话（Chromium 会），那几项就一律置灰、也没处可作用。
  bar.addEventListener('mousedown', keepFocus);

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
  // 功能模块自带的项接在后面（「编辑」里段落那一组，见 paragraphMenu.ts）。
  drop = buildDrop([...entriesOf(key), ...(key === 'edit' ? paragraphMenuEntries() : [])]);
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
      quickOpenMenuEntry(),
      { label: '打开文件夹…', action: 'openFolder', kbd: 'Ctrl+O' },
      { label: '打开最近打开的', submenu: recentEntries() },
      { label: 'sep' },
      { label: '保存', action: 'save', disabled: !ed.dirtyCurrent, kbd: 'Ctrl+S' },
      { label: '另存为…', action: 'saveAs', disabled: !ed.hasFile },
      versionsMenuEntry(),
      { label: '全部保存', action: 'saveAll', disabled: !ed.dirtyAny },
      { label: '自动保存', checked: ed.autoSave, run: () => commandEditor('toggleAutoSave') },
      { label: 'sep' },
      { label: '关闭编辑器', action: 'closeEditor', disabled: !ed.hasFile },
      { label: '关闭文件夹', action: 'closeFolder', disabled: !ws },
      { label: 'sep' },
      { label: '退出', action: 'quit' },
    ];
  }
  if (key === 'view') {
    // 「视图」整个由 viewMenu.ts 给（一组一个函数，之后的阶段往里加）。
    return viewMenuEntries();
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
      { label: '替换', action: 'replace', disabled: !ws, kbd: 'Ctrl+H' },
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
    if (entry.detail) {
      btn.title = entry.detail;
    }
    addCheck(btn, entry.checked);
    btn.appendChild(mk('span', 'wb-menu-label', entry.label));
    if (entry.kbd) {
      btn.appendChild(mk('span', 'wb-menu-kbd', entry.kbd));
    } else if (entry.submenu) {
      btn.appendChild(mk('span', 'wb-menu-arrow', '›'));
    }
    if (entry.submenu) {
      // 置灰的子菜单不展开（「段落格式」在没开工程时就是这样）。
      btn.addEventListener('mouseenter', () => (entry.disabled ? hideSubmenu() : showSubmenu(btn, entry.submenu!)));
      btn.addEventListener('click', (e) => e.stopPropagation());
    } else {
      btn.addEventListener('mouseenter', () => hideSubmenu());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.disabled || (!entry.action && !entry.run)) {
          return;
        }
        if (entry.run) {
          entry.run();
        } else {
          run(entry.action!);
        }
        closeMenubar();
      });
    }
    menu.appendChild(btn);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('mousedown', keepFocus);
  return menu;
}

/** 可勾选的项在左边距里画一个 ✓（没勾时留空位），不挤动标签，与不可勾选的项对齐。 */
function addCheck(btn: HTMLElement, checked: boolean | undefined): void {
  if (checked === undefined) {
    return;
  }
  btn.classList.add('checkable');
  btn.setAttribute('role', 'menuitemcheckbox');
  btn.setAttribute('aria-checked', String(checked));
  btn.appendChild(mk('span', 'wb-menu-check', checked ? '✓' : ''));
}

/** 菜单按钮与菜单项上按下鼠标时不夺走焦点（只拦默认动作，click 照常触发）。 */
function keepFocus(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest('.wb-menu-btn, .wb-menu-item')) {
    e.preventDefault();
  }
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
    addCheck(btn, entry.checked);
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
      if (entry.run) {
        entry.run();
      } else if (entry.action === 'recent' && entry.arg) {
        openRecent(entry.arg);
      }
      closeMenubar();
    });
    subDrop.appendChild(btn);
  }
  subDrop.addEventListener('mousedown', keepFocus);
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
      // 焦点在内置编辑器的正文区：撤销 / 重做是编辑器自己记的（每个文件一份），不走浏览器原生的。
      if (queryEditor().areaFocused) {
        commandEditor(action === 'undo' ? 'undo' : 'redo');
        return;
      }
      document.execCommand(action);
      return;
    case 'cut':
    case 'copy':
    case 'paste':
    case 'selectAll':
      document.execCommand(action === 'selectAll' ? 'selectAll' : action);
      return;
    case 'find':
      commandEditor('find');
      return;
    case 'replace':
      commandEditor('replace');
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
