/**
 * 高亮镜像层：在编辑区的 textarea 背后叠一层镜像 div，画 `<mark>` 的底色。
 *
 * ## 为什么要这一层
 *
 * textarea 里画不了高亮——它只有一份纯文字和一段原生选区。查找的「全部匹配 + 当前那一处」、
 * 往后的禁用词、段落聚焦都要在字底下涂颜色，只能另起一层排得一模一样的文字，在那一层上涂，
 * 再让 textarea 透明地盖在上面：
 *
 * - **镜像在下、textarea 在上**。textarea 背景透明（底色由编辑区外框给），文字照常画；镜像里的文字是
 *   透明的，只有 `<mark>` 的底色看得见。所以光标、选区、输入法、点击、右键全是 textarea 自己的，
 *   镜像 `pointer-events: none`，一点都不碰。
 * - **排得一模一样**：每次渲染都从 textarea 的**计算样式**抄字体、字号、行高、字距、内边距、
 *   `white-space` / 断行规则、`tab-size`（`.mono` 文件换了字体也跟得上）；宽度取 textarea 的
 *   内容区（扣掉竖滚动条），滚动用 `transform` 跟着 textarea 平移。
 * - **命名图层**：查找用 `find`，日后的禁用词、段落聚焦各用各的名字，互相不覆盖；
 *   同一段字落在几层里时，那一段的 `<mark>` 带上这几层的 class。
 *
 * ## 什么时候重画
 *
 * - `setHighlights` / `clearHighlights`：当场重画。
 * - 内容变了（`onEditorChange` 的 `edit`）：各层的范围先按这一处改动平移（压在改动上的那几处丢掉），
 *   下一帧重画；调用方自己在下一帧重算了再 `setHighlights` 的话，那一帧只画一次。
 * - 换了文件（`render` 时当前路径变了）：**所有图层清空**——范围是给上一个文件算的。
 * - 切预览 / 关标签等（`render`）：当场按新状态重画（textarea 藏起来时镜像跟着藏）。
 * - 尺寸变了（`ResizeObserver`；没有就不管）：只重摆位置和宽度，文字留着让浏览器自己重排。
 * - 文字超过 `HIGHLIGHT_LIMIT`（30 万字符）不画：整份文字排两遍太费。调用方自己决定要不要说一句
 *   （查找条会说）。
 *
 * ## 顺带：精确滚到某个字
 *
 * `scrollToOffset` 在一个看不见的镜像里，把这个字之前的文字和它所在那一行排出来，量这个字的纵向位置，
 * 再把 textarea 滚到让它停在视口偏上三分之一处。从前审稿引文定位是按字符位置占全文的比例估的，
 * 段落长短不一时能差出好几屏。
 */
import { onEditorChange } from './api';
import type { TextChange } from './history';
import type { Pane } from './store';

/** 一段要涂色的字：`[start, end)`（按 `area.value` 的下标），`cls` 是这一段 `<mark>` 的 class。 */
export interface HighlightRange {
  start: number;
  end: number;
  cls: string;
}

/** 超过这么多字符就不画（也不精确量位置，滚动退回按比例估）。 */
export const HIGHLIGHT_LIMIT = 300_000;

/** 这份文字大到不画高亮了没有。 */
export function tooLargeToHighlight(text: string): boolean {
  return text.length > HIGHLIGHT_LIMIT;
}

/** 从 textarea 抄到镜像上的计算样式：凡是影响文字怎么排的都在这里。 */
const COPIED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'font-synthesis',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-indent',
  'text-transform',
  'text-align',
  'text-rendering',
  'text-spacing-trim',
  'text-autospace',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'line-break',
  'hyphens',
  'direction',
  'unicode-bidi',
  'writing-mode',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  '-webkit-text-size-adjust',
] as const;

interface Mirror {
  pane: Pane;
  /** `.ed-mirror`：盖在 textarea 内容区（不含滚动条）上的框，`overflow: hidden`。 */
  box: HTMLElement;
  /** `.ed-mirror-content`：文字与 `<mark>`，随 textarea 的滚动平移。 */
  content: HTMLElement;
  /** 量位置用的那一份（看不见），第一次量的时候才造。 */
  probe?: { box: HTMLElement; content: HTMLElement };
  layers: Map<string, HighlightRange[]>;
  /** 图层每变一次加一；与 `drawn` 对得上、文字也没变时只重摆位置，不重建文字。 */
  version: number;
  /** 上一次画出来的是哪一版图层、哪一份文字。 */
  drawn?: { version: number; text: string };
  /** 这些图层是给哪个文件算的。当前路径变了就整份作废。 */
  path: string | null;
  frame?: number;
  shown: boolean;
}

const mirrors = new WeakMap<Pane, Mirror>();

// ---------------------------------------------------------------- 帧

/** 下一帧做。jsdom 没有 rAF（测试里），退回 16ms 的定时器。 */
export const nextFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => window.setTimeout(cb, 16);

export const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle)
    : (handle) => window.clearTimeout(handle);

// ---------------------------------------------------------------- 对外

/** 换掉这块编辑区某一层的高亮（当前文件），当场重画。空数组等于清掉这一层。 */
export function setHighlights(pane: Pane, layer: string, ranges: HighlightRange[]): void {
  const m = ensureMirror(pane);
  if (m.path !== pane.activePath) {
    // 别的图层还是给上一个文件算的：一起作废。
    m.layers.clear();
    m.path = pane.activePath;
  }
  if (ranges.length > 0) {
    m.layers.set(layer, ranges);
  } else {
    m.layers.delete(layer);
  }
  m.version++;
  render(m);
}

/** 清掉这块编辑区的某一层，当场重画。 */
export function clearHighlights(pane: Pane, layer: string): void {
  const m = mirrors.get(pane);
  if (m?.layers.delete(layer)) {
    m.version++;
    render(m);
  }
}

/**
 * 一处改动之后，原来的某个位置挪到了哪里：改动之前的不动，之后的跟着平移，落在被换掉的那一段里的
 * 挪到改动的起点。
 */
export function mapOffset(pos: number, change: TextChange): number {
  const removedEnd = change.at + change.removed.length;
  if (pos <= change.at) {
    return pos;
  }
  if (pos >= removedEnd) {
    return pos + change.inserted.length - change.removed.length;
  }
  return change.at;
}

/**
 * 量某个字（`area.value` 的下标）在 textarea 内容里的纵向位置：`top` 从内容顶上（含上内边距）算，
 * `height` 是那一行的高。textarea 藏着、文字超过 `HIGHLIGHT_LIMIT` 时量不了，返回 undefined。
 */
export function measureOffset(pane: Pane, offset: number): { top: number; height: number } | undefined {
  const area = pane.area;
  const text = area.value;
  if (tooLargeToHighlight(text) || !areaVisible(pane)) {
    return undefined;
  }
  const m = ensureMirror(pane);
  m.probe ??= createProbe(area);
  const { box, content } = m.probe;
  copyStyles(area, content);
  placeBox(area, box, content);

  const at = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const lineEnd = text.indexOf('\n', at);
  const tailEnd = lineEnd === -1 ? text.length : lineEnd;
  // 把这个字本身包进标记里（不另插字符，断行机会与原文一样）；行尾 / 文末没有字可包，放一个零宽空格。
  const marker = document.createElement('span');
  const code = at < tailEnd ? text.codePointAt(at) : undefined;
  marker.textContent = code === undefined ? '​' : String.fromCodePoint(code);
  const markerEnd = code === undefined ? at : at + marker.textContent.length;
  // 这一行剩下的字也排上：英文长词会整个折到下一行，只排到这个字为止会量错。
  content.replaceChildren(text.slice(0, at), marker, text.slice(markerEnd, tailEnd));
  const pos = { top: marker.offsetTop, height: marker.offsetHeight };
  content.replaceChildren();
  return pos;
}

/**
 * 把 textarea 滚到让这个字停在视口偏上三分之一处（查找跳转、审稿引文定位都用它）。
 * `onlyIfHidden`：这个字已经整行在视口里就不动（查找连按「下一个」时视口不乱跳）。
 * 量不了（文字太大）时按字符位置占全文的比例估。
 */
export function scrollToOffset(pane: Pane, offset: number, opts: { onlyIfHidden?: boolean } = {}): void {
  const area = pane.area;
  const measured = measureOffset(pane, offset);
  const top = measured
    ? measured.top
    : (Math.max(0, offset) / Math.max(1, area.value.length)) * area.scrollHeight;
  const height = measured?.height ?? 0;
  if (opts.onlyIfHidden && top >= area.scrollTop && top + height <= area.scrollTop + area.clientHeight) {
    return;
  }
  area.scrollTop = Math.max(0, top - area.clientHeight / 3);
  const m = mirrors.get(pane);
  if (m?.shown) {
    syncScroll(m);
  }
}

// ---------------------------------------------------------------- 镜像

function ensureMirror(pane: Pane): Mirror {
  const existing = mirrors.get(pane);
  if (existing) {
    return existing;
  }
  const area = pane.area;
  const box = document.createElement('div');
  box.className = 'ed-mirror hidden';
  box.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'ed-mirror-content';
  box.appendChild(content);
  area.parentElement?.insertBefore(box, area);

  const m: Mirror = { pane, box, content, layers: new Map(), version: 0, path: pane.activePath, shown: false };
  mirrors.set(pane, m);

  area.addEventListener('scroll', () => {
    if (m.shown) {
      syncScroll(m);
    }
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (m.shown) {
        placeBox(area, m.box, m.content);
        syncScroll(m);
      }
    }).observe(area);
  }
  subscribe();
  return m;
}

function createProbe(area: HTMLTextAreaElement): { box: HTMLElement; content: HTMLElement } {
  const box = document.createElement('div');
  box.className = 'ed-mirror ed-mirror-probe';
  box.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'ed-mirror-content';
  box.appendChild(content);
  area.parentElement?.insertBefore(box, area);
  return { box, content };
}

let subscribed = false;

function subscribe(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  onEditorChange((ev) => {
    const m = mirrors.get(ev.pane);
    if (!m) {
      return;
    }
    if (ev.type === 'render') {
      if (ev.pane.activePath !== m.path) {
        m.layers.clear();
        m.version++;
        m.path = ev.pane.activePath;
      }
      // 切预览、换文件这些：当场按新状态画（藏起来的那一下不能晚一帧，否则底色会叠在预览上闪一下）。
      render(m);
      return;
    }
    if (ev.file !== ev.pane.activeFile() || m.layers.size === 0) {
      return;
    }
    if (ev.change) {
      for (const [layer, ranges] of m.layers) {
        m.layers.set(layer, shiftRanges(ranges, ev.change));
      }
      m.version++;
    }
    schedule(m);
  });
}

/** 一处改动之后各段跟着平移；压在改动上的那几段丢掉（调用方下一帧会重算）。 */
function shiftRanges(ranges: HighlightRange[], change: TextChange): HighlightRange[] {
  const removedEnd = change.at + change.removed.length;
  const delta = change.inserted.length - change.removed.length;
  const out: HighlightRange[] = [];
  for (const r of ranges) {
    if (r.end <= change.at) {
      out.push(r);
    } else if (r.start >= removedEnd) {
      out.push({ start: r.start + delta, end: r.end + delta, cls: r.cls });
    }
  }
  return out;
}

function schedule(m: Mirror): void {
  if (m.frame === undefined) {
    m.frame = nextFrame(() => {
      m.frame = undefined;
      render(m);
    });
  }
}

function areaVisible(pane: Pane): boolean {
  return !!pane.activeFile() && !pane.isPreviewing() && !pane.area.classList.contains('hidden');
}

function render(m: Mirror): void {
  if (m.frame !== undefined) {
    cancelFrame(m.frame);
    m.frame = undefined;
  }
  const area = m.pane.area;
  const text = area.value;
  const ranges = [...m.layers.values()].flat();
  if (ranges.length === 0 || !areaVisible(m.pane) || tooLargeToHighlight(text)) {
    if (m.shown || m.content.firstChild) {
      m.content.replaceChildren();
      m.box.classList.add('hidden');
      m.shown = false;
    }
    m.drawn = undefined;
    return;
  }
  m.box.classList.remove('hidden');
  m.shown = true;
  copyStyles(area, m.content);
  placeBox(area, m.box, m.content);
  // 存盘、切标签条之类的重画：图层与文字都没变，只重摆位置（字体换了也由上面抄样式跟上）。
  if (m.drawn?.version !== m.version || m.drawn.text !== text) {
    m.content.replaceChildren(buildContent(text, ranges));
    m.drawn = { version: m.version, text };
  }
  syncScroll(m);
}

/**
 * 文字切成段：没有高亮的是文本节点，有的是 `<mark class="ed-hl 各层的 cls">`。几层叠在一起的那一段
 * 带上全部的 class。扫一遍边界，O(n log n)。
 */
function buildContent(text: string, ranges: HighlightRange[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const events: { at: number; open: boolean; cls: string }[] = [];
  for (const r of ranges) {
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(0, Math.min(text.length, r.end));
    if (end > start) {
      events.push({ at: start, open: true, cls: r.cls }, { at: end, open: false, cls: r.cls });
    }
  }
  // 同一位置先收后开，相邻两段不会粘成一个 mark。
  events.sort((a, b) => a.at - b.at || Number(a.open) - Number(b.open));

  const active = new Map<string, number>();
  let pos = 0;
  const emit = (end: number) => {
    if (end <= pos) {
      return;
    }
    const piece = text.slice(pos, end);
    if (active.size === 0) {
      frag.appendChild(document.createTextNode(piece));
    } else {
      const mark = document.createElement('mark');
      mark.className = `ed-hl ${[...active.keys()].join(' ')}`;
      mark.textContent = piece;
      frag.appendChild(mark);
    }
    pos = end;
  };
  for (const ev of events) {
    emit(ev.at);
    const n = (active.get(ev.cls) ?? 0) + (ev.open ? 1 : -1);
    if (n > 0) {
      active.set(ev.cls, n);
    } else {
      active.delete(ev.cls);
    }
  }
  emit(text.length);
  // textarea 里末尾的换行后面还有一个空行；div 里没有，补一个零宽空格把那一行撑出来。
  if (text.endsWith('\n')) {
    frag.appendChild(document.createTextNode('​'));
  }
  return frag;
}

function copyStyles(area: HTMLTextAreaElement, target: HTMLElement): void {
  const cs = getComputedStyle(area);
  for (const prop of COPIED_STYLES) {
    const value = cs.getPropertyValue(prop);
    if (value) {
      target.style.setProperty(prop, value);
    } else {
      target.style.removeProperty(prop);
    }
  }
}

/**
 * 把镜像框摆到 textarea 的内容区上：左上角对齐它的边框以内，宽度扣掉竖滚动条。
 * 宽度用 `getBoundingClientRect` 的小数值，整数的 `clientWidth` 在小数宽度的布局里会差半个像素，
 * 正好卡在行尾的那个字就会折得不一样。
 */
function placeBox(area: HTMLTextAreaElement, box: HTMLElement, content: HTMLElement): void {
  const parent = area.parentElement;
  const rect = area.getBoundingClientRect();
  const parentRect = parent?.getBoundingClientRect();
  const scrollbar = Math.max(0, area.offsetWidth - area.clientWidth - area.clientLeft * 2);
  const width = Math.max(0, rect.width - area.clientLeft * 2 - scrollbar);
  const height = Math.max(0, area.clientHeight);
  box.style.left = `${rect.left - (parentRect?.left ?? 0) - (parent?.clientLeft ?? 0) + area.clientLeft}px`;
  box.style.top = `${rect.top - (parentRect?.top ?? 0) - (parent?.clientTop ?? 0) + area.clientTop}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  content.style.width = `${width}px`;
}

function syncScroll(m: Mirror): void {
  const area = m.pane.area;
  m.content.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
}
