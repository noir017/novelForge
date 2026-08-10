/**
 * 失败标记的悬停浮窗。
 *
 * 工程页的行上挂着一个感叹号（`rows.ts` 建的 `.row-failure`），鼠标移上去
 * 才说清「哪一步失败了、卡有没有被改、下次会不会重来」。
 *
 * 为什么不用 `title` 属性了事：原生 tooltip 不换行、延迟不可控、而且**选不中**
 * ——失败信息里常有模型返回的片段，用户要复制它去搜。
 *
 * 与另外两只浮窗的取舍：
 * - 不像 `detailTip.ts`（`pointer-events: none`，只复读一行被截断的副标题）：
 *   这里是多行、要能选中复制，所以**鼠标必须进得来**，于是收起要留宽限期
 *   ——从行挪到浮窗要跨一道缝，那一两帧鼠标既不在行上也不在浮窗上。
 * - 不像 `summaryTip.ts` 要向后端单取数据：失败记录已经随 `ProjectTree.failures`
 *   全量推过来了（每条几十字、只有出错的目标才有），直接读缓存即可。
 */
import { el as mk, closestFrom } from '../../dom';
import type { FailureView } from '../../protocol';
import { logTime } from '../format';
import { el } from '../refs';
import { lastTree } from './treeState';

const HOVER_DELAY_MS = 300;
/** 收起的宽限期：够鼠标从行跨到浮窗，又不至于让它赖着不走。 */
const CLOSE_DELAY_MS = 200;
/** 浮窗与目标之间的缝，以及与视口边缘的留白。 */
const TIP_GAP = 4;
const TIP_MARGIN = 8;
/** 再挤也得看得见一行字，否则等于浮窗没弹。 */
const MIN_TIP_HEIGHT = 48;

let tip: { key: string; box: HTMLElement } | null = null;
/** 正在等延迟的那个感叹号（延迟到点时用它定位）。 */
let hoverTarget: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 立刻收起。滚动 / Esc / 右键 / 重渲染用这个，不给宽限。 */
export function hideFailureTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  hoverTarget = null;
  if (tip) {
    tip.box.remove();
    tip = null;
  }
}

function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideFailureTip();
  }, CLOSE_DELAY_MS);
}

function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 悬停在某个感叹号上：延迟后弹浮窗。 */
function scheduleShow(node: HTMLElement): void {
  const key = node.dataset.failureKey ?? '';
  if (!key) {
    return;
  }
  // mouseover 在行内子元素之间移动时也会冒泡上来。已经为它开着浮窗、或已经
  // 在为它计时了就什么都别做——否则光标微动一下就重置延迟，浮窗永远弹不出来。
  if (tip?.key === key || hoverTarget === node) {
    return;
  }
  hideFailureTip();
  hoverTarget = node;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延迟期间行可能被重渲染丢弃，那就不弹了。
    if (!hoverTarget?.isConnected) {
      hoverTarget = null;
      return;
    }
    const target = hoverTarget;
    hoverTarget = null;
    const failures = lastTree?.failures?.[key];
    if (!failures || failures.length === 0) {
      return;
    }
    showTip(target, key, failures);
  }, HOVER_DELAY_MS);
}

function showTip(node: HTMLElement, key: string, failures: FailureView[]): void {
  const box = mk('div', 'failure-tip');
  box.appendChild(buildBody(failures));
  // 鼠标进了浮窗就别收——用户正在读，或者要选中复制。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(box);
  tip = { key, box };
  place(node, box);
}

function buildBody(failures: FailureView[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const failure of failures) {
    const item = mk('div', 'failure-tip-item');

    const head = mk('div', 'failure-tip-head');
    head.appendChild(
      mk(
        'span',
        `failure-tip-badge failure-${failure.severity}`,
        failure.severity === 'error' ? '未改动' : '部分完成'
      )
    );
    head.appendChild(mk('span', 'failure-tip-time', logTime(failure.at)));
    item.appendChild(head);

    // textContent（mk 内部就是）而非 innerHTML：这些文本里有模型返回的片段。
    item.appendChild(mk('div', 'failure-tip-msg', failure.message));
    if (failure.detail) {
      item.appendChild(mk('div', 'failure-tip-detail', failure.detail));
    }
    frag.appendChild(item);
  }
  frag.appendChild(mk('div', 'hint failure-tip-foot', '成功一次后这个标记会自动消失。日志页有完整记录。'));
  return frag;
}

/**
 * 定位浮窗并夹进视口。挂在 body 上 `position: fixed`——工程页有内部滚动，
 * 挂在行里会被容器裁掉。与 `summaryTip.place` 同一套算法（横向左对齐、
 * 右溢出往左收、纵向优先下方、放不下翻上方、两边都不够就压高度）。
 */
function place(node: HTMLElement, box: HTMLElement): void {
  const r = node.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  // 先撤掉上一次的限制再量，否则会一直沿用之前那个更矮的值。
  box.style.maxHeight = '';
  const natural = box.offsetHeight;

  const below = vh - r.bottom - TIP_GAP - TIP_MARGIN;
  const above = r.top - TIP_GAP - TIP_MARGIN;
  const putBelow = natural <= below || below >= above;
  const room = Math.max(MIN_TIP_HEIGHT, putBelow ? below : above);
  if (natural > room) {
    box.style.maxHeight = `${room}px`;
  }

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

export function installFailureTip(): void {
  // 事件委托挂在 projectBody 上：树每次重渲染都换掉全部行，逐行
  // addEventListener 会随重渲染次数堆积（与另两只浮窗同一套取舍）。
  el.projectBody.addEventListener('mouseover', (e) => {
    const mark = closestFrom<HTMLElement>(e.target, '.row-failure');
    if (mark) {
      cancelScheduledHide();
      scheduleShow(mark);
    } else if (tip) {
      // 挪到了别处：给宽限而不是立刻收——鼠标要去浮窗的话，半路会先扫过
      // 感叹号下方的那道缝。
      scheduleHide();
    } else if (hoverTimer) {
      hideFailureTip();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    if (tip) {
      scheduleHide();
    } else {
      hideFailureTip();
    }
  });

  // 右键菜单弹出来时浮窗该让路，两个都是 fixed 会叠在一起。
  el.projectBody.addEventListener('contextmenu', hideFailureTip);

  // 浮窗是 fixed 的，页面一滚就和目标脱节。但**浮窗自己内部的滚动不算**
  // （详情可能好几行，一滚就收等于滚动条形同虚设）。捕获阶段才收得到
  // 内部容器（.project-body）的滚动。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!tip?.box.contains(e.target as Node)) {
        hideFailureTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideFailureTip();
    }
  });
}
