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
 *
 * **接管要接得够早、够全**，否则原生菜单会漏出来——触控板双指点击尤其容易
 * （它经过的事件序列与按实体右键并不完全一样）。两处防线：
 *
 * 1. `contextmenu` 挂在 **window 的捕获阶段**，也就是这个事件在页面里最早
 *    到得了的地方。挂在 document 的冒泡阶段会被中途任何一处 `stopPropagation()`
 *    挡住，那时 `preventDefault()` 根本没机会调用，原生菜单就照常弹出来。
 * 2. `auxclick`（副键的「点击」）兜底：这一次手势里 `contextmenu` 压根没来过，
 *    就用它弹我们的菜单，并把它自己的默认行为也挡掉。双指点击在部分浏览器/
 *    驱动上走的就是这一路。落点没动、又紧挨着刚弹过的那一次，则只挡不弹——
 *    那是同一次点击的尾巴。
 *
 * **不碰 `pointerdown` / `mousedown` 的默认行为**：按规范取消 `pointerdown`
 * 拦不住 `contextmenu`（`click` / `auxclick` / `contextmenu` 明确不在被压制的
 * 兼容事件之列），却会顺手把 `mousedown` 吃掉——于是文本域里右键不再挪光标，
 * 菜单里的「粘贴」会贴到上一次光标的位置去。得不到好处，只会坏事。
 *
 * 触摸长按的 callout 是另一路，JS 管不着，在 CSS 里用
 * `-webkit-touch-callout: none` 关掉（见 css/view/base.css）。
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

  /** 副键（右键 / 触控板双指点击 / 长按）。主键与中键不接管。 */
  const isSecondary = (e: MouseEvent): boolean => e.button === 2;

  /**
   * 上一次弹菜单的时刻与落点。一次右键在 Chromium 里是
   * pointerdown → contextmenu → auxclick，后两个都会落到这儿；`auxclick`
   * 据此认出「这是刚才那一下的尾巴」，不重复弹。
   *
   * 认的是**时刻 + 落点**而不是一个「这一次手势里弹过没有」的布尔量：那个量
   * 要靠某个事件来复位，而这里的前提恰恰是**不知道哪些事件会来**（不同浏览器 /
   * 驱动发的序列不一样）。复位的那一发没来，布尔量就永远卡在 true，右键从此
   * 失灵。只看时刻也不够：只发 auxclick 的环境里，300ms 内在别处再点一下
   * 会被无声吃掉。
   */
  let served = { at: 0, x: NaN, y: NaN };

  /** 同一次点击的尾巴：紧挨着、且落点没动。 */
  const isSameClick = (e: MouseEvent): boolean =>
    Date.now() - served.at <= 300 && e.clientX === served.x && e.clientY === served.y;

  /** 在事件的落点弹出菜单。`contextmenu` 与兜底的 `auxclick` 共用。 */
  const openAt = (e: MouseEvent): void => {
    served = { at: Date.now(), x: e.clientX, y: e.clientY };
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
  };

  // window 的捕获阶段：页面里最早的一站，谁都没机会先把它拦掉。
  window.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      openAt(e);
    },
    true
  );

  // 兜底：双指点击只发了 auxclick、没发 contextmenu 的那些环境。
  window.addEventListener(
    'auxclick',
    (e) => {
      if (!isSecondary(e)) {
        return;
      }
      e.preventDefault();
      if (!isSameClick(e)) {
        openAt(e);
      }
    },
    true
  );

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
