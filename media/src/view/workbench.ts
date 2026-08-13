/**
 * 工作区卡：**当前这一层的产物本身**。
 *
 * 这是设计文档 §11 里那块「当前工作区」。改造前创作页只有一条进度条和一堆
 * 对话气泡——作者看不见自己正在改的细纲写了什么、这一场的「必须发生」有
 * 哪几条，只能去开文件。于是四层流水线在界面上只剩几个百分比，像个进度
 * 报表，而不是一个工作台。
 *
 * ## 为什么钉在消息流顶部而不是单独一栏
 *
 * 侧边栏只有三百来像素宽，分不出两栏；做成常驻的第三块又会把消息流压扁。
 * `position: sticky` 是这两者之间唯一的解：它在消息流里（跟着一起滚），
 * 但滚不出视野——聊到第十轮回头看「这一场到底不能发生什么」，它还在。
 *
 * 内容全部由后端生成（[core/views/workbench.ts](../../../src/core/views/workbench.ts)），
 * 这里只负责画。正文层刻意只有字数与场景进度，没有全文：三千字塞进一张
 * 常驻卡片既读不下去，又把消息流挤没了。
 */
import { el as mk, clear, setHidden } from '../dom';
import type { WorkbenchView } from '../protocol';
import { el } from './refs';
import { openPath } from './store';

/** 折叠状态由用户自己控制，切目标不重置——他收起来多半是嫌占地方。 */
let collapsed = false;

let current: WorkbenchView | null = null;

export function renderWorkbench(view: WorkbenchView | null): void {
  current = view;
  redraw();
}

function redraw(): void {
  const box = el.workbench;
  clear(box);
  setHidden(box, !current);
  if (!current) {
    return;
  }

  box.classList.toggle('collapsed', collapsed);
  box.appendChild(buildHead(current));
  if (collapsed) {
    return;
  }

  if (current.warning) {
    // 上游变更在这里是一句人话，不只是流水线条上那个 ⟳。作者正盯着这份
    // 产物看，此刻正是告诉他「它依据的东西已经改了」最有用的时机。
    box.appendChild(mk('div', 'wb-warning', `⟳ ${current.warning}`));
  }
  if (current.empty) {
    box.appendChild(mk('div', 'wb-empty', current.empty));
    return;
  }
  for (const section of current.sections) {
    const row = mk('div', 'wb-row');
    row.appendChild(mk('span', 'wb-key', section.key));
    row.appendChild(mk('span', 'wb-text', section.text));
    box.appendChild(row);
  }
}

function buildHead(view: WorkbenchView): HTMLElement {
  const head = mk('div', 'wb-head');

  const toggle = mk('button', 'wb-toggle', collapsed ? '▸' : '▾');
  toggle.title = collapsed ? '展开' : '收起';
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    redraw();
  });
  head.appendChild(toggle);

  head.appendChild(mk('span', 'wb-title', view.title));
  head.appendChild(mk('span', 'spacer'));

  // 卡片只摊要点（正文层甚至只摊统计）。要看全的、要改的，走「打开」。
  if (view.relPath) {
    const open = mk('button', 'link wb-open', '打开');
    open.title = view.relPath;
    open.addEventListener('click', () => openPath(view.relPath));
    head.appendChild(open);
  }
  return head;
}
