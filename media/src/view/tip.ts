/**
 * 悬停浮窗的定位。四只浮窗共用这一份几何：章节摘要、行内副标题、失败标记
 * （`view/project/` 下那三只）与创作页的「当前产物」（`view/workbench.ts`）。
 *
 * 它们都挂在 body 上 `position: fixed`——工程页与消息流各有内部滚动，挂在行里
 * 会被容器裁掉。代价是位置得自己算，而这套算法此前在三个文件里各抄了一遍：
 *
 * - 横向左对齐目标，右边溢出就往左收，最左不越过边距。
 * - 纵向优先放目标下方（顺着视线），放不下翻到上方；**两边都放不下时选空间
 *   大的那一侧，并把高度压进那点空间**——内容可以滚，但绝不能长到屏幕外面去。
 *   只翻转不压高度的话，一份长摘要在矮窗口里会有一截永远够不到。
 *
 * `minHeight: 0` 关掉压高度那一步：`detail-tip` 只复读一行被截断的副标题，
 * 它 `pointer-events: none`、滚不动，压出来的 max-height 等于把字截掉。
 */

export interface PlaceTipOptions {
  /** 浮窗与目标之间的缝。 */
  gap?: number;
  /** 与视口边缘的留白。 */
  margin?: number;
  /** 压高度时的下限：再挤也得看得见一行字。给 0 表示不压高度。 */
  minHeight?: number;
}

/** 把 `box` 贴在 `anchor` 的下方/上方，并保证它整个落在视口内。 */
export function placeTip(anchor: Element, box: HTMLElement, opts: PlaceTipOptions = {}): void {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 8;
  const minHeight = opts.minHeight ?? 48;

  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  // 先撤掉上一次的限制再量，否则会一直沿用之前那个更矮的值。
  // 量到的「自然高度」已经含 CSS 里 60vh 的可读性上限。
  if (minHeight > 0) {
    box.style.maxHeight = '';
  }
  const natural = box.offsetHeight;

  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const putBelow = natural <= below || below >= above;
  if (minHeight > 0) {
    // 窗口特别矮时算出来的空间可能是 0 甚至负数，直接拿去当 max-height 会得到
    // 一个看不见的浮窗。给一个下限，宁可稍微出界一点也得留得住内容。
    const room = Math.max(minHeight, putBelow ? below : above);
    if (natural > room) {
      box.style.maxHeight = `${room}px`;
    }
  }

  // 压过高度之后才量得到最终高度，上翻时要用它算 top。
  const h = box.offsetHeight;
  const top = putBelow ? r.bottom + gap : Math.max(margin, r.top - h - gap);

  const w = box.offsetWidth;
  let left = r.left;
  if (w > 0 && left + w > vw - margin) {
    left = vw - w - margin;
  }
  if (left < margin) {
    left = margin;
  }

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}
