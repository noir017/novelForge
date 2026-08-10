/**
 * 行内副标题（别名、设定关键词等）的悬停浮窗。
 *
 * 别名太多时副标题会被 CSS 截断（`max-width: 50%` + 省略号），正名不再被
 * 挤没，但被省略号吃掉的别名只能靠这只浮窗看全。
 *
 * 与 `summaryTip.ts` 的区别：
 * - **只展示不互动**：一行文字，没有滚动、没有选中复制，所以 `pointer-events:
 *   none`，鼠标永远落不进来，收起不需要宽限期。
 * - **只在真的截断时才弹**：`scrollWidth > clientWidth` 才说明有内容被吃掉，
 *   全文都看得见时弹窗只是复读一遍。
 */
import { el as mk, closestFrom } from '../../dom';
import { el } from '../refs';

const HOVER_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;
/** 浮窗与目标副标题之间的缝，以及与视口边缘的留白。 */
const TIP_GAP = 4;
const TIP_MARGIN = 8;

let tip: HTMLElement | null = null;
/** 当前浮窗对应的副标题（浮窗开着时再次悬停它不该关掉重开）。 */
let tipTarget: HTMLElement | null = null;
/** 正在等延迟的那一个副标题（延迟到点时用它定位）。 */
let hoverTarget: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 文本真的被省略号截断了吗？全文可见就不必弹浮窗。 */
function isTruncated(node: HTMLElement): boolean {
  return node.scrollWidth > node.clientWidth;
}

/** 立刻收起。滚动 / Esc / 重渲染用这个，不给宽限。 */
export function hideDetailTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  hoverTarget = null;
  tipTarget = null;
  if (tip) {
    tip.remove();
    tip = null;
  }
}

/** 鼠标挪到别处：给一点宽限再收，鼠标在副标题上微动不会闪。 */
function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideDetailTip();
  }, CLOSE_DELAY_MS);
}

/** 悬停在某个副标题上：截断就延迟后弹浮窗，没截断就什么都不做。 */
function scheduleShow(node: HTMLElement): void {
  // mouseover 在行内子元素之间移动时也会冒泡上来。浮窗正开着、或已经在
  // 为同一个副标题计时时都别重置——否则光标在字上微动一下就闪掉/无限延长。
  if (tipTarget === node || hoverTarget === node) {
    return;
  }
  hideDetailTip();
  if (!isTruncated(node)) {
    return;
  }
  hoverTarget = node;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延迟期间行可能被重渲染丢弃，那就不弹了。
    if (!hoverTarget?.isConnected) {
      hoverTarget = null;
      return;
    }
    showTip(hoverTarget);
    hoverTarget = null;
  }, HOVER_DELAY_MS);
}

/** 建出浮窗并贴在副标题的下方/上方。 */
function showTip(node: HTMLElement): void {
  const box = mk('div', 'detail-tip', node.textContent ?? '');
  document.body.appendChild(box);
  tip = box;
  tipTarget = node;
  place(node, box);
}

/**
 * 定位浮窗，并保证它整个落在视口内。挂在 body 上 `position: fixed`——
 * 工程页有内部滚动，挂在行里会被容器裁掉。横向贴着副标题左缘，右边溢出
 * 就往左收；纵向优先放下方，放不下翻到上方。
 */
function place(node: HTMLElement, box: HTMLElement): void {
  const r = node.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  const below = vh - r.bottom - TIP_GAP - TIP_MARGIN;
  const above = r.top - TIP_GAP - TIP_MARGIN;
  const putBelow = below >= above;

  const h = box.offsetHeight;
  const top = putBelow ? r.bottom + TIP_GAP : Math.max(TIP_MARGIN, r.top - h - TIP_GAP);

  const w = box.offsetWidth;
  let left = r.left;
  if (w > 0 && left + w > vw - TIP_MARGIN) {
    left = vw - w - TIP_MARGIN;
  }
  if (left < TIP_MARGIN) {
    left = TIP_MARGIN;
  }

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

export function installDetailTip(): void {
  // 事件委托挂在 projectBody 上：树每次重渲染都换掉全部行，
  // 逐行 addEventListener 会随重渲染次数堆积（与 summaryTip 同一套取舍）。
  el.projectBody.addEventListener('mouseover', (e) => {
    const detail = closestFrom<HTMLElement>(e.target, '.row-detail');
    if (detail) {
      scheduleShow(detail);
    } else if (tip || hoverTimer) {
      scheduleHide();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    hideDetailTip();
  });

  // 右键菜单弹出来时浮窗该让路，两个都是 fixed 会叠在一起。
  el.projectBody.addEventListener('contextmenu', hideDetailTip);

  // 浮窗是 fixed 的，页面一滚就和目标行脱节（与右键菜单同一个理由）。
  // 捕获阶段才收得到内部容器（.project-body）的滚动。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!tip?.contains(e.target as Node)) {
        hideDetailTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideDetailTip();
    }
  });
}
