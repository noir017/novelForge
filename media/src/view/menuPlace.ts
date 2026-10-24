/**
 * 菜单摆在哪：右键菜单、标题栏的下拉与子菜单共用的几何（纯函数、零 DOM，`tests/unit/view/menuPlace.test.js` 钉着）。
 *
 * 一条规矩：**菜单整个落在可视区里**。从前右键菜单只翻转、不平移不压高——手机竖屏上在下半屏长按，菜单比剩下的空间高、
 * 往上翻又顶出屏幕顶，被截掉一截；标题栏的「帮助」下拉与「打开最近打开的」子菜单在窄屏上直接伸出右边。现在：
 *
 * - **贴着一点弹**（右键）：右边放不下往左翻，翻过去还放不下就贴着右边缘；下面放不下往上翻，上面也放不下就平移到刚好
 *   贴着底边（菜单盖住按下去的那一点，手指在那儿也不碍事）；比整个可视区还高就从顶上开始、压 `max-height` 在菜单里滚。
 * - **贴着一个矩形弹**（下拉：在按钮下方左对齐；子菜单：在父菜单项右边、顶对齐，右边放不下翻到左边）：横向夹进可视区，
 *   纵向照上面同一套（下拉只往下，放不下就压高度）。
 *
 * 可视区不一定是 `innerWidth × innerHeight`：手机浏览器缩放过、或者软键盘顶起了可视区时，`visualViewport` 才是人眼看得到的
 * 那一块（`fixed` 的坐标仍以布局视口为准，可视区相对它偏了 `offsetLeft / offsetTop`）。取法见 {@link visibleArea}。
 */

/** 一块矩形区域（坐标与 `position: fixed` 同一个参照）。 */
export interface Area {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 摆出来的位置。`maxHeight` 只在菜单比能用的高度还高时给（菜单里滚）。 */
export interface Placement {
  left: number;
  top: number;
  maxHeight?: number;
}

/** 与可视区边缘的留白。 */
export const MENU_MARGIN = 4;

/** 横向：从 `preferred` 起放 `w` 宽；放不下用 `fallback`（翻到另一边），还放不下就贴边。 */
function fitX(preferred: number, fallback: number, w: number, area: Area, margin: number): number {
  const min = area.left + margin;
  const max = area.left + area.width - margin;
  if (preferred + w <= max) {
    return Math.max(min, preferred);
  }
  if (fallback >= min && fallback + w <= max) {
    return fallback;
  }
  return Math.max(min, max - w);
}

/**
 * 纵向：从 `preferred` 往下放 `h` 高；放不下且 `flip` 给了就试往上翻（以 `flip` 为下沿），还放不下就平移到贴着底边；
 * 比整块还高就顶着上边缘压高度。
 */
function fitY(preferred: number, flip: number | undefined, h: number, area: Area, margin: number): Pick<Placement, 'top' | 'maxHeight'> {
  const min = area.top + margin;
  const max = area.top + area.height - margin;
  const room = Math.max(0, max - min);
  if (h > room) {
    return { top: min, maxHeight: room };
  }
  if (preferred + h <= max) {
    return { top: Math.max(min, preferred) };
  }
  if (flip !== undefined && flip - h >= min) {
    return { top: flip - h };
  }
  return { top: max - h };
}

/**
 * 在点 (x, y) 弹一个 `w × h` 的菜单（右键）。量不出尺寸（jsdom 里 `offsetWidth` 恒为 0）时就贴着那一点。
 */
export function placeAtPoint(x: number, y: number, w: number, h: number, area: Area, margin = MENU_MARGIN): Placement {
  if (w <= 0 || h <= 0 || area.width <= 0 || area.height <= 0) {
    return { left: x, top: y };
  }
  return { left: fitX(x, x - w, w, area, margin), ...fitY(y, y, h, area, margin) };
}

/** 一个矩形（按钮、父菜单项）的四边。 */
export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 贴着 `anchor` 弹：`below` 是标题栏下拉（按钮下方、左对齐，右边放不下往左收，只往下、放不下压高度）；`side` 是子菜单
 * （父菜单项右边、顶对齐，右边放不下翻到父菜单项左边，再不行就贴边盖住一点父菜单；下面放不下往上平移）。
 */
export function placeNear(anchor: Anchor, w: number, h: number, area: Area, mode: 'below' | 'side', margin = MENU_MARGIN): Placement {
  const near = mode === 'below' ? { x: anchor.left, y: anchor.bottom } : { x: anchor.right, y: anchor.top };
  if (w <= 0 || h <= 0 || area.width <= 0 || area.height <= 0) {
    return { left: near.x, top: near.y };
  }
  if (mode === 'below') {
    const left = fitX(anchor.left, anchor.right - w, w, area, margin);
    const max = area.top + area.height - margin;
    const top = Math.max(area.top + margin, anchor.bottom);
    return h > max - top ? { left, top, maxHeight: Math.max(0, max - top) } : { left, top };
  }
  return { left: fitX(anchor.right, anchor.left - w, w, area, margin), ...fitY(anchor.top, undefined, h, area, margin) };
}

/** 人眼看得到的那一块（`fixed` 坐标系里）。有 `visualViewport` 用它，没有就是整个窗口。 */
export function visibleArea(win: Window = window): Area {
  const vv = win.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
  }
  return { left: 0, top: 0, width: win.innerWidth || 0, height: win.innerHeight || 0 };
}
