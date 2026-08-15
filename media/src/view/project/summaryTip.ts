/**
 * 章节摘要的悬停浮窗。
 *
 * 摘要此前只能在 `.novelforge/summaries/` 里手动翻，或右键「看摘要」开一个
 * 编辑器标签页——想快速回忆「第 37 章讲了什么」代价太大。悬停浮窗把这件事
 * 变成不打断写作的一瞥。
 *
 * 四条设计取舍：
 * - **摘要正文不进 `ProjectTree`**：那棵树每次文件变动都全量重推，两百章
 *   每章上千字等于每保存一次就推几百 KB。改成悬停时按路径单章去取。
 * - **前端缓存、收到新树即作废**：同一章反复扫过去只请求一次；正文一改
 *   （后端会重推树）缓存整体清掉，不会拿旧摘要糊弄人。
 * - **半秒延迟**：鼠标从工具栏划到某一行的路上会扫过好几行，立刻弹会闪。
 * - **浮窗可以进得去**：摘要有六个小节、可能上千字，一瞥看不完。鼠标移上去
 *   浮窗就一直留着（可滚动、可选中复制），移开才收。为此收起要延迟一点——
 *   从行挪到浮窗中间要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，
 *   立刻收会让浮窗永远够不着。
 *
 * 定位（挂 body、`position: fixed`、夹进视口）在 [../tip.ts](../tip.ts)，
 * 四只浮窗共用一份。
 */
import { el as mk, closestFrom } from '../../dom';
import type { PlotSummaryView } from '../../protocol';
import { el } from '../refs';
import { vscode } from '../store';
import { placeTip } from '../tip';

const HOVER_DELAY_MS = 450;
/** 收起的宽限期：够鼠标从行跨到浮窗，又不至于让它赖着不走。 */
const CLOSE_DELAY_MS = 200;

/** 章节路径 -> PlotSummaryView。收到新的树时整体作废。 */
const summaryCache = new Map<string, PlotSummaryView>();
/** 已经发出请求、还没等到回音的路径，避免同一章连发好几次。 */
const summaryPending = new Set<string>();

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
/** 收起的宽限计时。与 hoverTimer 是两件事，别合并。 */
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前浮窗。 */
let hoverTip: { relPath: string; box: HTMLElement } | null = null;
/** 正在等延迟的那一行（延迟到点时用它定位）。 */
let hoverRow: HTMLElement | null = null;

/** 收到 `project` 消息时调用：那说明磁盘变过，缓存一律作废。 */
export function invalidateSummaries(): void {
  summaryCache.clear();
  summaryPending.clear();
}

/** 立刻收起。滚动 / Esc / 右键 / 重渲染用这个，不给宽限。 */
export function hideSummaryTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  hoverRow = null;
  if (hoverTip) {
    hoverTip.box.remove();
    hoverTip = null;
  }
}

/** 鼠标离开行或浮窗：给一点宽限再收，好让鼠标能挪到浮窗上去。 */
function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideSummaryTip();
  }, CLOSE_DELAY_MS);
}

/** 鼠标回到行上或进了浮窗：撤销待执行的收起。 */
function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 悬停在某一行上：延迟后弹浮窗，数据没有就先要一份。 */
function scheduleSummaryTip(row: HTMLElement): void {
  const relPath = row.dataset.plot;
  if (!relPath) {
    return;
  }
  // mouseover 在行内子元素之间移动时也会冒泡上来。已经为这一行开着浮窗、
  // 或已经在为它计时了，就什么都别做——否则光标在行上微动一下就重置延迟，
  // 浮窗永远弹不出来。
  if (hoverTip?.relPath === relPath || hoverRow === row) {
    return;
  }
  hideSummaryTip();
  hoverRow = row;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延迟期间行可能被重渲染丢弃，那就不弹了。
    if (!hoverRow?.isConnected) {
      return;
    }
    showSummaryTip(hoverRow, relPath);
    if (!summaryCache.has(relPath) && !summaryPending.has(relPath)) {
      summaryPending.add(relPath);
      vscode.postMessage({ type: 'requestSummary', plotRelPath: relPath });
    }
  }, HOVER_DELAY_MS);
}

/** 建出浮窗并贴在行的下方/上方。数据还没到就先显示「读取中」。 */
function showSummaryTip(row: HTMLElement, relPath: string): void {
  const box = mk('div', 'summary-tip');
  box.appendChild(buildBody(summaryCache.get(relPath)));
  // 鼠标进了浮窗就别收——用户正在读，或者要滚动、选中复制。
  // 监听挂在 box 上，box 每次都是新建的，收起时随元素一起回收。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(box);
  hoverTip = { relPath, box };
  placeTip(row, box);
}

/** 浮窗内容。`view` 为 undefined 表示还在等后端。 */
function buildBody(view?: PlotSummaryView): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (!view) {
    frag.appendChild(mk('div', 'hint', '读取摘要…'));
    return frag;
  }

  const head = mk('div', 'summary-tip-head');
  head.appendChild(mk('span', 'summary-tip-title', `第 ${view.no} 章 ${view.title}`.trim()));
  // 过期必须说出来：照着一份写于三次修改之前的摘要做判断比没有摘要更糟。
  if (view.exists && view.stale) {
    head.appendChild(mk('span', 'summary-tip-stale', '已过期'));
  }
  frag.appendChild(head);

  if (!view.exists) {
    frag.appendChild(mk('div', 'hint', '这一章还没有摘要。右键「总结这一章」可以生成。'));
    return frag;
  }

  for (const section of view.sections) {
    frag.appendChild(mk('div', 'summary-tip-section', section.name));
    // textContent 而非 innerHTML：摘要是模型写的，里面可能有任何字符。
    frag.appendChild(mk('div', 'summary-tip-text', section.text));
  }
  if (view.sections.length === 0) {
    frag.appendChild(mk('div', 'hint', '摘要文件是空的。'));
  }
  return frag;
}

/**
 * 摘要到了：填进缓存，正开着的浮窗就地换掉内容（不重建，免得闪）。
 *
 * 摘要文件的路径与章节的路径不同（一个在 summaries/，一个在 plots/），
 * 所以按**当前开着的那一章**回填——同一时刻只可能有一个浮窗。
 */
export function applySummary(view: PlotSummaryView): void {
  const relPath = hoverTip?.relPath;
  if (!relPath) {
    return;
  }
  summaryPending.delete(relPath);
  summaryCache.set(relPath, view);
  hoverTip!.box.innerHTML = '';
  hoverTip!.box.appendChild(buildBody(view));
  // 内容换了尺寸也变了，重新定位一次。
  const row = el.projectBody.querySelector<HTMLElement>(`.row-plot[data-plot="${cssEscape(relPath)}"]`);
  if (row) {
    placeTip(row, hoverTip!.box);
  }
}

/** 属性选择器里的路径要转义（含 `/`、可能含引号）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export function installSummaryTip(): void {
  // 事件委托挂在 projectBody 上：树每次重渲染都换掉全部行，
  // 逐行 addEventListener 会随重渲染次数堆积。
  el.projectBody.addEventListener('mouseover', (e) => {
    const row = closestFrom<HTMLElement>(e.target, '.row-plot');
    if (row) {
      // 回到行上就撤销待执行的收起（从浮窗挪回行上时会走到这儿）。
      cancelScheduledHide();
      scheduleSummaryTip(row);
    } else if (hoverTip) {
      // 挪到了别的行/空白处：给宽限而不是立刻收——鼠标要去浮窗的话，
      // 半路会先扫过行下方的那道缝。
      scheduleHide();
    } else if (hoverTimer) {
      hideSummaryTip();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    // 往浮窗方向移出去也会触发这里，同样给宽限。
    if (hoverTip) {
      scheduleHide();
    } else {
      hideSummaryTip();
    }
  });

  // 右键菜单弹出来时浮窗该让路，两个都是 fixed 会叠在一起。
  el.projectBody.addEventListener('contextmenu', hideSummaryTip);

  // 浮窗是 fixed 的，页面一滚就和目标行脱节（与右键菜单同一个理由）。
  // 但**浮窗自己内部的滚动不算**——摘要有六个小节，滚动是要给用户用的，
  // 一滚就把浮窗收掉等于这个滚动条形同虚设。捕获阶段才收得到内部容器
  // （.project-body）的滚动。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!hoverTip?.box.contains(e.target as Node)) {
        hideSummaryTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSummaryTip();
    }
  });
}
