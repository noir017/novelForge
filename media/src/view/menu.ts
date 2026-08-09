/**
 * 一套菜单引擎，两个入口：气泡右上角的 ⋯ 按钮（贴着按钮绝对定位），
 * 以及任意位置的右键（挂在 body 上、跟着光标走）。
 *
 * 菜单项由 `{ label, run, danger, disabled }` 描述，`{ sep: true }` 是分隔线。
 *
 * **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 /
 * 内置编辑器里也一样，所以原生的复制/粘贴菜单不会出现。这是有意的取舍
 * （菜单风格统一），代价是那几处的编辑项要自己实现（见 editor/clipboard.ts）。
 * 插件形态另需 webviewHtml.ts 里 body 上的 `data-vscode-context`——
 * VS Code 给 webview 加的菜单由宿主渲染，JS 的 preventDefault 压不住。
 */
import { el as mk } from '../dom';
import type { ContextMenuRegistrar, MenuItem } from '../globals';

/** 当前打开的菜单（同时只允许一个）。`btn` 有值即为 ⋯ 菜单。 */
let openMenu: { btn: HTMLElement | null; menu: HTMLElement } | null = null;

export function closeMenu(): void {
  if (!openMenu) {
    return;
  }
  openMenu.menu.remove();
  openMenu.btn?.classList.remove('active');
  openMenu = null;
}

/** 由菜单项数组建出菜单 DOM。两个入口共用，差别只在挂到哪儿、怎么定位。 */
export function buildMenuElement(items: MenuItem[], className: string): HTMLElement {
  const menu = mk('div', className);
  for (const item of items) {
    if (item.sep) {
      // 首尾与连续的分隔线都没有意义（构建方按需拼接，这里兜一下）。
      if (menu.lastElementChild && !menu.lastElementChild.classList.contains('menu-sep')) {
        menu.appendChild(mk('div', 'menu-sep'));
      }
      continue;
    }
    const b = mk('button', undefined, item.label);
    if (item.danger) {
      b.classList.add('danger');
    }
    if (item.disabled) {
      b.disabled = true;
    }
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (item.disabled) {
        return;
      }
      closeMenu();
      item.run?.();
    });
    menu.appendChild(b);
  }
  // 拼完后可能落下一条尾部分隔线。
  const tail = menu.lastElementChild;
  if (tail?.classList.contains('menu-sep')) {
    tail.remove();
  }
  return menu;
}

/**
 * 在视口坐标 (x, y) 处弹出菜单。挂在 body 上、position: fixed——
 * 右键可能发生在任何容器里（含内部滚动的工程页），跟着容器走会被裁掉。
 * 贴近右/下边缘时向左/向上翻转，不让菜单掉出屏幕。
 */
function showContextMenu(items: MenuItem[], x: number, y: number): void {
  closeMenu();
  if (items.length === 0) {
    return;
  }

  const menu = buildMenuElement(items, 'ctx-menu');
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  openMenu = { btn: null, menu };

  // jsdom 里 offsetWidth 恒为 0，翻转逻辑自动退化为「贴光标」，不影响断言。
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  menu.style.left = `${w > 0 && x + w > vw ? Math.max(0, x - w) : x}px`;
  menu.style.top = `${h > 0 && y + h > vh ? Math.max(0, y - h) : y}px`;
}

/** 贴着某个按钮弹出的 ⋯ 菜单。挂在按钮的容器里，跟着气泡一起滚。 */
export function toggleButtonMenu(btn: HTMLElement, items: MenuItem[]): void {
  // 再点一次同一个按钮就是收起。
  if (openMenu?.btn === btn) {
    closeMenu();
    return;
  }
  closeMenu();
  // 挂到 body 上就得手算坐标，还要跟着 .messages 滚动；贴在容器里省这一层。
  const menu = buildMenuElement(items, 'msg-menu');
  btn.parentElement?.appendChild(menu);
  btn.classList.add('active');
  openMenu = { btn, menu };
}

/**
 * 「这个元素上右键给什么菜单」的登记表。
 *
 * 用 WeakMap 而不是在右键时按 relPath 反查最近一次收到的树：菜单项在构建
 * 那一行时就已经知道全部上下文（节点、所属区、落点目录），反查得把这些
 * 再拼一遍。行被重渲染丢弃后条目自动回收。
 */
const menuProviders = new WeakMap<Element, () => MenuItem[]>();

/** 给一个元素登记右键菜单。`provide` 返回菜单项数组，右键那一刻才调用。 */
export const onContextMenu: ContextMenuRegistrar = (node, provide) => {
  menuProviders.set(node, provide);
  return node;
};

/** 从事件目标往上找第一个登记过菜单的祖先。 */
function resolveMenuItems(target: EventTarget | null): MenuItem[] | null {
  let node = target instanceof Element ? target : null;
  for (; node; node = node.parentElement) {
    const provide = menuProviders.get(node);
    if (provide) {
      return provide();
    }
  }
  return null;
}

/**
 * 装上全局监听。**只能装一次**——另起一套会两层菜单一起弹，所以
 * editor / explorer 都经 `window.__nfContextMenu` 复用这里的登记表。
 *
 * `fallback` 是所有页面都有的兜底菜单（一个刷新）。
 */
export function installMenus(fallback: () => MenuItem[]): void {
  window.__nfContextMenu = onContextMenu;

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 在已弹出的菜单上右键：收起就好，不要再叠一层兜底菜单。
    if (openMenu?.menu.contains(e.target as Node)) {
      closeMenu();
      return;
    }
    let { clientX: x, clientY: y } = e;
    // 键盘的「菜单键」触发时 clientX/Y 为 0，改用目标元素的位置，
    // 否则菜单会跑到屏幕左上角。
    if (!x && !y && e.target instanceof Element) {
      const rect = e.target.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom;
    }
    showContextMenu(resolveMenuItems(e.target) ?? fallback(), x, y);
  });

  // 点别处、按 Esc 都要收起菜单。
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  // 右键菜单是 fixed 定位的，内容一滚它就和目标行脱节了，收起来。
  // **只收右键菜单**：⋯ 菜单挂在气泡里会跟着滚，而且流式输出每来一段都会
  // scrollToBottom()，一起收会让它刚点开就消失。捕获阶段才收得到内部容器
  // （.messages / .project-body）的滚动。
  document.addEventListener(
    'scroll',
    () => {
      if (openMenu && !openMenu.btn) {
        closeMenu();
      }
    },
    true
  );
}
