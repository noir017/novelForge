/**
 * 独立版标题栏「文件 / 编辑 / 视图 / 帮助」。没有 `#wbMenubar` 就直接 return（插件）。
 * 窄屏上这一排藏起来（narrow.css），标题栏右端的「⋯」先列这四个，点一个换成它的下拉、仍贴着「⋯」。
 *
 * 不复用右键菜单引擎：缺悬停切菜单和子菜单。
 */
import { el as mk } from '../dom';
import { matchesShortcut, shortcutLabel } from '../editor/shortcuts';
import { commandEditor, queryEditor } from '../globals';
import { versionsMenuEntry } from './versionsMenu';
import { openCheckpoints } from './checkpoints';
import { quickOpenMenuEntry } from './quickOpenMenu';
import { bookFindMenuEntry } from './bookFindMenu';
import {
  closeFolder,
  hideAbout,
  hideWelcome,
  openRecent,
  requestImportBook,
  requestNewProject,
  requestOpenFile,
  requestOpenFolder,
  showAbout,
  showWelcome,
} from './welcome';
import { hasWorkspace, store, vscode } from './store';
import { placeNear, visibleArea } from './menuPlace';
import type { Placement } from './menuPlace';
import { lastPointerWasTouch, touchDevice, trackPointer } from '../touch';
import { paragraphMenuEntries } from './paragraphMenu';
import { shortcutsMenuEntry } from './shortcutsMenu';
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
  /** 点了换成另一个菜单的下拉（窄屏「⋯」里的文件 / 编辑 / 视图 / 帮助），贴着同一颗按钮。 */
  menu?: string;
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
/** 开着的下拉贴着的那颗按钮（菜单栏上的一个，或窄屏的「⋯」）。 */
let anchor: HTMLElement | undefined;

/** 窄屏「⋯」先列的那一层。 */
const MORE_KEY = 'more';

export function installMenubar(): void {
  const bar = document.getElementById('wbMenubar');
  if (!bar) {
    return;
  }
  trackPointer();

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

  const more = document.getElementById('wbMoreBtn');
  more?.addEventListener('mousedown', keepFocus);
  more?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openKey !== null && anchor === more) {
      closeMenubar();
      return;
    }
    openMenu(MORE_KEY, more);
  });

  // 已经开着一个菜单时移到别的菜单按钮上就换过去。手指点别的按钮之前补发的 mouseover 不算：
  // 不然先换过去、紧接着的 click 又看见「点的正是开着的那个」就把它关了——手指想换菜单却全关掉。
  bar.addEventListener('mouseover', (e) => {
    if (!openKey || lastPointerWasTouch()) {
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
      hideAbout();
    }
    // 键登记在 editor/shortcuts.ts（Ctrl+N 在浏览器里多半拦不住，那一条上写着）。组字中途的是输入法的。
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    if (matchesShortcut(e, 'openFolder')) {
      e.preventDefault();
      requestOpenFolder();
      closeMenubar();
    } else if (matchesShortcut(e, 'newFile')) {
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
  anchor = btn;
  btn.classList.add('open');
  // 功能模块自带的项接在后面（「编辑」里段落那一组，见 paragraphMenu.ts）。
  drop = buildDrop([...entriesOf(key), ...(key === 'edit' ? paragraphMenuEntries() : [])]);
  document.body.appendChild(drop);
  // 整个落在可视区里（窄屏上「帮助」的下拉从前伸出右边，见 menuPlace.ts）。
  place(drop, placeNear(btn.getBoundingClientRect(), drop.offsetWidth, drop.offsetHeight, visibleArea(), 'below'));
}

function place(menu: HTMLElement, at: Placement): void {
  menu.style.left = `${Math.round(at.left)}px`;
  menu.style.top = `${Math.round(at.top)}px`;
  if (at.maxHeight !== undefined) {
    menu.style.maxHeight = `${Math.floor(at.maxHeight)}px`;
  }
}

function closeMenubar(): void {
  openKey = null;
  drop?.remove();
  drop = undefined;
  subDrop?.remove();
  subDrop = undefined;
  anchor?.classList.remove('open');
  anchor = undefined;
  for (const btn of document.querySelectorAll('.wb-menu-btn.open')) {
    btn.classList.remove('open');
  }
}

function entriesOf(key: string): MenuEntry[] {
  const ws = hasWorkspace();
  const editing = isEditing();
  const ed = queryEditor();
  // 手机、平板上没用的几项不列（touch.ts 的 touchDevice）。
  const desktop = !touchDevice();
  if (key === MORE_KEY) {
    return [
      { label: '文件', menu: 'file' },
      { label: '编辑', menu: 'edit' },
      { label: '视图', menu: 'view' },
      { label: '帮助', menu: 'help' },
    ];
  }
  if (key === 'file') {
    return [
      { label: '新建文件', action: 'newFile', disabled: !ws, kbd: shortcutLabel('newFile') },
      { label: '新建一本书…', action: 'newProject' },
      { label: '导入写好的书（txt）…', action: 'importBook' },
      { label: 'sep' },
      { label: '打开文件…', action: 'openFile', disabled: !ws },
      quickOpenMenuEntry(),
      { label: '打开文件夹…', action: 'openFolder', kbd: shortcutLabel('openFolder') },
      { label: '打开最近打开的', submenu: recentEntries() },
      { label: 'sep' },
      { label: '保存', action: 'save', disabled: !ed.dirtyCurrent, kbd: shortcutLabel('save') },
      { label: '另存为…', action: 'saveAs', disabled: !ed.hasFile },
      versionsMenuEntry(),
      // 整本书的存档点（工程页工具栏上那颗 ⚑ 的同一个弹窗）：那颗只是个图标，这里给它一个名字。
      {
        label: '存档点…',
        disabled: !ws,
        detail: '整本书存一版、看之后改了哪几份，整本或单份退回去',
        run: () => openCheckpoints(),
      },
      { label: '全部保存', action: 'saveAll', disabled: !ed.dirtyAny },
      { label: '自动保存', checked: ed.autoSave, run: () => commandEditor('toggleAutoSave') },
      { label: 'sep' },
      { label: '关闭编辑器', action: 'closeEditor', disabled: !ed.hasFile },
      { label: '关闭文件夹', action: 'closeFolder', disabled: !ws },
      ...(desktop ? [{ label: 'sep' }, { label: '退出', action: 'quit' }] : []),
    ];
  }
  if (key === 'view') {
    // 「视图」整个由 viewMenu.ts 给（一组一个函数，之后的阶段往里加）。
    return viewMenuEntries();
  }
  if (key === 'edit') {
    return [
      { label: '撤销', action: 'undo', disabled: !editing, kbd: shortcutLabel('undo') },
      { label: '重做', action: 'redo', disabled: !editing, kbd: shortcutLabel('redo') },
      { label: 'sep' },
      { label: '剪切', action: 'cut', disabled: !editing, kbd: shortcutLabel('cut') },
      { label: '复制', action: 'copy', disabled: !editing, kbd: shortcutLabel('copy') },
      { label: '粘贴', action: 'paste', disabled: !editing, kbd: shortcutLabel('paste') },
      { label: 'sep' },
      { label: '全选', action: 'selectAll', disabled: !editing, kbd: shortcutLabel('selectAll') },
      { label: 'sep' },
      { label: '查找', action: 'find', disabled: !ws, kbd: shortcutLabel('find') },
      { label: '替换', action: 'replace', disabled: !ws, kbd: shortcutLabel('replace') },
      bookFindMenuEntry(),
    ];
  }
  return [
    { label: '欢迎页面', action: 'welcome' },
    { label: '使用说明', action: 'readme' },
    shortcutsMenuEntry(),
    ...(desktop ? [{ label: '打开日志目录', action: 'openLogDir' }] : []),
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
    } else if (entry.submenu || entry.menu) {
      btn.appendChild(mk('span', 'wb-menu-arrow', '›'));
    }
    if (entry.menu) {
      const key = entry.menu;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (anchor) {
          openMenu(key, anchor);
        }
      });
    } else if (entry.submenu) {
      // 置灰的子菜单不展开（「段落格式」在没开工程时就是这样）。
      // 手指点之前补发的 mouseenter 不展开：窄屏上子菜单会贴边盖住手指底下这一点，紧跟着的 click 就落到子菜单的某一项上
      // （Android 实机上点「打开最近打开的」直接打开了最近的第一本书）。手指靠下面的 click 展开。
      btn.addEventListener('mouseenter', () => {
        if (lastPointerWasTouch()) {
          return;
        }
        if (entry.disabled) {
          hideSubmenu();
        } else {
          showSubmenu(btn, entry.submenu!);
        }
      });
      // 点一下也展开：手指没有「移上去」。
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!entry.disabled) {
          showSubmenu(btn, entry.submenu!);
        }
      });
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
  // 父菜单项右边、顶对齐；右边放不下翻到左边，再不行就贴边盖住一点父菜单（窄屏上从前直接伸出屏幕）。
  place(subDrop, placeNear(anchor.getBoundingClientRect(), subDrop.offsetWidth, subDrop.offsetHeight, visibleArea(), 'side'));
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
    case 'importBook':
      requestImportBook();
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
