/**
 * 「当前产物」浮窗：**当前这一层的产物本身**。
 *
 * 这是设计文档 §11 里那块「当前工作区」。创作页只有一条进度条和一堆对话气泡时，
 * 作者看不见自己正在改的细纲写了什么、这一场备了哪些素材，只能去开
 * 文件。于是四层流水线在界面上只剩几个百分比，像个进度报表，而不是一个工作台。
 *
 * ## 为什么从「钉在消息流顶部」改成悬停浮窗
 *
 * 它原来是消息流里的一张 `position: sticky` 卡片：滚不出视野，代价是**永远占着
 * 消息流最上面那一块**，而且既关不掉也藏不起来——只能折叠成一条标题栏，那条
 * 标题栏还在。侧边栏本来就只有三百来像素宽，一份六小节的场景卡能吃掉半屏对话。
 *
 * 现在它与工程页那三只浮窗（`project/summaryTip` `detailTip` `errorTip`）同一套
 * 路子：平时只在流水线条上留一个一行高的入口，鼠标停上去（或点一下钉住）才浮
 * 出来，挂在 body 上 `position: fixed`，移开就收。**不占版面，随时够得着。**
 *
 * 与那三只共用 [tip.ts](tip.ts) 的定位，取舍也一致：内容是多行、要能滚动与选中
 * 复制（场景素材是要抄进正文的），所以鼠标必须进得来，收起要留宽限期——
 * 从入口挪到浮窗要跨过一道缝，那一两帧鼠标既不在入口上也不在浮窗上。
 *
 * 有一处与那三只**不同**：它们的目标是工程页里会滚动的行，页面一滚就得收；
 * 这个入口长在流水线条上，那一条不滚（`.pipeline` 是 `flex: 0 0 auto`），
 * 消息流滚动时它一动不动，所以**不监听 scroll**——照抄那条会让「滚上去看前一
 * 轮对话，同时对着这一场的素材」变得不可能，而那正是钉住要解决的场景。
 *
 * 内容全部由后端生成（[core/views/workbench.ts](../../../src/core/views/workbench.ts)），
 * 这里只负责画。正文层刻意只有字数与场景进度，没有全文：三千字塞进一只浮窗
 * 既读不下去，又把「这一层齐没齐」这个真正要看的信息埋掉了。
 */
import { el as mk, closestFrom, setHidden } from '../dom';
import type { WorkbenchView } from '../protocol';
import { el } from './refs';
import { openPath } from './store';
import { placeTip } from './tip';

/** 与另外三只浮窗同一档延迟：够快，又不至于划过时闪。 */
const HOVER_DELAY_MS = 300;
/** 收起的宽限期：够鼠标从入口跨到浮窗，又不至于让它赖着不走。 */
const CLOSE_DELAY_MS = 200;

let current: WorkbenchView | null = null;

let tip: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 钉住：点一下入口就一直开着，直到再点一次 / Esc / 点别处。
 *
 * 悬停版够用于「瞥一眼这一场是个什么情境」，但照着场景素材写正文时鼠标要回
 * 输入框——那一刻浮窗必须留得住。所以点击是钉住，不是又一个悬停。
 */
let pinned = false;

/** 收到新的 `pipeline` 推送时调用。 */
export function renderWorkbench(view: WorkbenchView | null): void {
  current = view;
  redrawEntry();
  if (!current) {
    hideWorkbenchTip();
    return;
  }
  // 开着的浮窗就地换掉内容（不重建节点，免得闪）：切目标、采纳产物都会重推。
  if (tip) {
    fill(tip, current);
    placeTip(el.workbench, tip);
  }
}

/** 流水线条上那个入口：只有一行「▤ 标题」，占一行不到。 */
function redrawEntry(): void {
  const box = el.workbench;
  box.innerHTML = '';
  setHidden(box, !current);
  if (!current) {
    return;
  }

  box.appendChild(mk('span', 'wbt-entry-icon', '▤'));
  box.appendChild(mk('span', 'wbt-entry-title', current.title));
  // 上游变过 / 这一层还是空的：入口上就得看得见，否则用户没有理由把它打开。
  if (current.warning) {
    box.appendChild(mk('span', 'wbt-entry-mark', '⟳'));
  } else if (current.empty) {
    box.appendChild(mk('span', 'wbt-entry-mark is-empty', '○'));
  }
  box.title = `${current.title}——悬停查看这一层的产物，点击钉住`;
}

// ---------------------------------------------------------------- 浮窗

function scheduleShow(): void {
  if (tip || hoverTimer) {
    return;
  }
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    showWorkbenchTip();
  }, HOVER_DELAY_MS);
}

/** 鼠标离开入口或浮窗：给一点宽限再收，好让鼠标能挪到浮窗上去。 */
function scheduleHide(): void {
  if (pinned) {
    return;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideWorkbenchTip();
  }, CLOSE_DELAY_MS);
}

/** 鼠标回到入口上或进了浮窗：撤销待执行的收起。 */
function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 立刻收起。Esc / 点别处 / 右键用这个，不给宽限。 */
export function hideWorkbenchTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  pinned = false;
  if (tip) {
    tip.remove();
    tip = null;
  }
  el.workbench.classList.remove('open');
}

function showWorkbenchTip(): void {
  if (!current || tip) {
    return;
  }
  const box = mk('div', 'workbench-tip');
  fill(box, current);
  // 鼠标进了浮窗就别收——用户正在读，或者要滚动、选中复制。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(box);
  tip = box;
  el.workbench.classList.add('open');
  placeTip(el.workbench, box);
}

function fill(box: HTMLElement, view: WorkbenchView): void {
  box.innerHTML = '';
  box.appendChild(buildHead(view));

  if (view.warning) {
    // 上游变更在这里是一句人话，不只是流水线条上那个 ⟳。作者正盯着这份
    // 产物看，此刻正是告诉他「它依据的东西已经改了」最有用的时机。
    box.appendChild(mk('div', 'wbt-warning', `⟳ ${view.warning}`));
  }
  if (view.empty) {
    box.appendChild(mk('div', 'wbt-empty', view.empty));
    return;
  }
  for (const section of view.sections) {
    const row = mk('div', 'wbt-row');
    row.appendChild(mk('span', 'wbt-key', section.key));
    row.appendChild(mk('span', 'wbt-text', section.text));
    box.appendChild(row);
  }
}

function buildHead(view: WorkbenchView): HTMLElement {
  const head = mk('div', 'wbt-head');
  head.appendChild(mk('span', 'wbt-title', view.title));
  head.appendChild(mk('span', 'spacer'));

  // 浮窗只摊要点（正文层甚至只摊统计）。要看全的、要改的，走「打开」。
  if (view.relPath) {
    const open = mk('button', 'link wbt-open', '打开');
    open.title = view.relPath;
    open.addEventListener('click', () => {
      openPath(view.relPath);
      hideWorkbenchTip();
    });
    head.appendChild(open);
  }

  const close = mk('button', 'icon-btn wbt-close', '×');
  close.title = '关闭（Esc）';
  close.addEventListener('click', hideWorkbenchTip);
  head.appendChild(close);
  return head;
}

export function installWorkbench(): void {
  el.workbench.addEventListener('mouseenter', () => {
    cancelScheduledHide();
    scheduleShow();
  });
  el.workbench.addEventListener('mouseleave', scheduleHide);

  // 点一下钉住：照着场景素材写正文时鼠标要回输入框，那一刻浮窗得留得住。
  // 再点一次收起——同一个入口，同一个键。
  el.workbench.addEventListener('click', (e) => {
    // 不让这一下冒到 document 上被下面那条「点别处就收」当场撤销。
    e.stopPropagation();
    if (tip && pinned) {
      hideWorkbenchTip();
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    cancelScheduledHide();
    showWorkbenchTip();
    pinned = true;
  });

  // 钉住之后点别处就该收。浮窗里点自己不算——里面有「打开」按钮，还要能选字。
  document.addEventListener('click', (e) => {
    if (tip && pinned && !closestFrom(e.target, '.workbench-tip')) {
      hideWorkbenchTip();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideWorkbenchTip();
    }
  });

  // 右键菜单也是 fixed 的，两个叠在一起谁都读不清。
  document.addEventListener('contextmenu', hideWorkbenchTip);
}
