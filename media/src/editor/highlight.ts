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
 * - **排得一模一样**：字体、字号、行距、内边距（含版心）与 textarea 读同一组 CSS 变量（`css/standalone/look.css`
 *   里那一条共用的规则，外观面板改的就是它们）；每次渲染还从 textarea 的**计算样式**抄字体、字号、行高、字距、内边距、
 *   `white-space` / 断行规则、`tab-size`（`.mono` 文件换了字体也跟得上）；宽度取 textarea 的
 *   内容区（扣掉竖滚动条），滚动用 `transform` 跟着 textarea 平移。外观一变由 `relayoutMirror` 当场重抄。
 * - **命名图层**：查找用 `find`，段落聚焦用 `focus`（那一层的 `<mark>` 不画底色、用实色画字），写作体检用 `check`，
 *   名词高亮用 `names`，互相不覆盖；同一段字落在几层里时，那一段的 `<mark>` 带上这几层的 class。
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
 * ## 按行分块，只换变了的那几块
 *
 * 镜像里一行（按 `\n` 切，行尾的 `\n` 留在这一行里）一个 `<div>`，每块记着「这一行的字 + 落在这一行的那几段」。
 * 重画时与上一次逐块比，头尾一样的块原样留着，只换中间变了的那几块——打一个字只重建、重排一行。从前每次整份
 * `replaceChildren`，三万字的章节、名词高亮那样几百上千处标记时每敲一下要 20~30ms（实测，超过一帧），分块之后
 * 不到 1ms，与章节长短基本无关。
 *
 * 分块不改排版：`pre-wrap` 里 `\n` 本来就是强制断行，块尾的那个 `\n` 不多出一行（与 textarea 一样），空行就是只有
 * 一个 `\n` 的块；最后一行是空的（文字以 `\n` 结尾）时放一个零宽空格把它撑出来。`text-indent` 只给第一块
 * （`highlight.css`）——textarea 里它也只管第一行。块的 `textContent` 连起来就是 textarea 的文字。
 *
 * ## 鼠标底下是哪一段（`rangeAtPoint`）
 *
 * 镜像 `pointer-events: none`，鼠标事件全落在 textarea 上；浏览器按坐标取字（`caretPositionFromPoint`）在 textarea
 * 上靠不住（Chromium 时有时无，WebKit 没有）。所以反过来量镜像：按纵向二分找到那一块，再在块里量那几个 `<mark>`。
 * 名词浮窗用它（`nameMarks.ts`），只认画着的图层。
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
  /** `content` 里此刻的那几块，与它的子元素一一对应（见文件头「按行分块」）。没画着时是空的。 */
  blocks: Block[];
  /** 图层每变一次加一；与 `drawn` 对得上、文字也没变时只重摆位置，不重建文字。 */
  version: number;
  /** 上一次画出来的是哪一版图层、哪一份文字。 */
  drawn?: { version: number; text: string };
  /** 这些图层是给哪个文件算的。当前路径变了就整份作废。 */
  path: string | null;
  frame?: number;
  shown: boolean;
}

/** 镜像里的一行。 */
interface Block {
  /** 这一行在全文里的起点。 */
  start: number;
  /** 这一行的字，含行尾的 `\n`（最后一行没有）。 */
  text: string;
  /** 落在这一行里的那几段，位置相对行首。 */
  marks: HighlightRange[];
  /** 字与那几段拼成的指纹：与上一次的对得上就不重建。 */
  key: string;
  el?: HTMLElement;
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
 * 排版变了（外观面板改了字体、字号、行距、版心，`look.ts` 调）：当场按 textarea 新的计算样式重抄一遍、重摆位置。
 * 尺寸没变的时候 `ResizeObserver` 不会叫，换了字号却必须重排。没造过镜像的什么都不做。
 */
export function relayoutMirror(pane: Pane): void {
  const m = mirrors.get(pane);
  if (m) {
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
 * 量某个字（`area.value` 的下标）在 textarea 内容里的位置：`top` 从内容顶上（含上内边距）算，`left` 从内容左边
 * （含左内边距与版心留白）算，`height` 是那一行的高。textarea 藏着、文字超过 `HIGHLIGHT_LIMIT` 时量不了，返回 undefined。
 * 打字机滚动用 `top`，名词补全的弹出框（`names.ts`）用 `left` / `top` / `height` 贴着光标摆。
 */
export function measureOffset(pane: Pane, offset: number): { top: number; left: number; height: number } | undefined {
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
  const pos = { top: marker.offsetTop, left: marker.offsetLeft, height: marker.offsetHeight };
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

  const m: Mirror = {
    pane,
    box,
    content,
    layers: new Map(),
    blocks: [],
    version: 0,
    path: pane.activePath,
    shown: false,
  };
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
    m.blocks = [];
    m.drawn = undefined;
    return;
  }
  m.box.classList.remove('hidden');
  m.shown = true;
  copyStyles(area, m.content);
  placeBox(area, m.box, m.content);
  // 存盘、切标签条之类的重画：图层与文字都没变，只重摆位置（字体换了也由上面抄样式跟上）。
  if (m.drawn?.version !== m.version || m.drawn.text !== text) {
    patchBlocks(m, splitBlocks(text, ranges));
    m.drawn = { version: m.version, text };
  }
  syncScroll(m);
}

/**
 * 文字按行切成块，每段高亮落到它跨过的那几行里（跨行的切成几截，各带同样的 class）。
 * 最后一块是空行（文字以 `\n` 结尾）时照样给一块，画的时候放零宽空格撑高。
 */
export function splitBlocks(text: string, ranges: readonly HighlightRange[]): Block[] {
  const blocks: Block[] = [];
  for (let pos = 0; ; ) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    blocks.push({ start: pos, text: text.slice(pos, end), marks: [], key: '' });
    if (nl === -1) {
      break;
    }
    pos = end;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
  for (const r of sorted) {
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(0, Math.min(text.length, r.end));
    if (end <= start) {
      continue;
    }
    // 起点落在哪一块：按块的起点二分。
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid].start <= start) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = lo; i < blocks.length && blocks[i].start < end; i++) {
      const b = blocks[i];
      const s = Math.max(start, b.start) - b.start;
      const e = Math.min(end, b.start + b.text.length) - b.start;
      if (e > s) {
        b.marks.push({ start: s, end: e, cls: r.cls });
      }
    }
  }
  for (const b of blocks) {
    b.key = b.marks.length === 0 ? b.text : `${b.text}\u0000${b.marks.map((r) => `${r.start},${r.end},${r.cls}`).join(';')}`;
  }
  return blocks;
}

/** 与上一次逐块比：头尾对得上的块原样留着（只更新起点），中间那一截换成新造的。 */
function patchBlocks(m: Mirror, next: Block[]): void {
  const old = m.blocks;
  let head = 0;
  while (head < old.length && head < next.length && old[head].key === next[head].key) {
    head++;
  }
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail].key === next[next.length - 1 - tail].key
  ) {
    tail++;
  }
  for (let i = head; i < old.length - tail; i++) {
    old[i].el?.remove();
  }
  const frag = document.createDocumentFragment();
  for (let i = 0; i < next.length; i++) {
    if (i < head) {
      next[i].el = old[i].el;
    } else if (i >= next.length - tail) {
      next[i].el = old[old.length - (next.length - i)].el;
    } else {
      const el = blockElement(next[i]);
      next[i].el = el;
      frag.appendChild(el);
    }
  }
  // 留着的块万一被别人动过（不该发生）：对不上就整份重来，不在错的 DOM 上接着补。
  if (m.content.childElementCount !== head + tail) {
    m.content.replaceChildren();
    for (const b of next) {
      b.el = blockElement(b);
      frag.appendChild(b.el);
    }
    m.content.appendChild(frag);
  } else {
    m.content.insertBefore(frag, tail > 0 ? (old[old.length - tail].el ?? null) : null);
  }
  m.blocks = next;
}

function blockElement(b: Block): HTMLElement {
  const div = document.createElement('div');
  if (b.text === '') {
    div.textContent = '​';
  } else {
    div.appendChild(buildContent(b.text, b.marks));
  }
  return div;
}

/**
 * 鼠标底下（`clientX` / `clientY`，视口坐标）是 `layer` 这一层的哪一段。镜像没画着、没指着这一层的字时 undefined。
 * 先按纵向二分找到那一行的块，再在块里量那几个 `<mark>`（`getClientRects`，折行的标记每一截都量）。
 */
export function rangeAtPoint(pane: Pane, layer: string, clientX: number, clientY: number): HighlightRange | undefined {
  const m = mirrors.get(pane);
  const ranges = m?.layers.get(layer);
  if (!m?.shown || !ranges?.length || m.blocks.length === 0) {
    return undefined;
  }
  const box = m.box.getBoundingClientRect();
  if (clientX < box.left || clientX >= box.right || clientY < box.top || clientY >= box.bottom) {
    return undefined;
  }
  // 第一块底边在鼠标下面的那一块。
  let lo = 0;
  let hi = m.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((m.blocks[mid].el?.getBoundingClientRect().bottom ?? 0) <= clientY) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const block = m.blocks[lo];
  if (!block?.el || block.marks.length === 0) {
    return undefined;
  }
  const classes = new Set(ranges.map((r) => r.cls));
  let offset = block.start;
  for (const node of Array.from(block.el.childNodes)) {
    const length = node.textContent?.length ?? 0;
    if (node instanceof HTMLElement && node.tagName === 'MARK' && Array.from(node.classList).some((c) => classes.has(c))) {
      for (const rect of Array.from(node.getClientRects())) {
        if (clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom) {
          const at = offset;
          return ranges.find((r) => r.start <= at && at < r.end);
        }
      }
    }
    offset += length;
  }
  return undefined;
}

/**
 * 一行的字切成段：没有高亮的是文本节点，有的是 `<mark class="ed-hl 各层的 cls">`。几层叠在一起的那一段
 * 带上全部的 class。扫一遍边界，O(n log n)。行尾的 `\n` 不另补零宽空格——末尾的空行是单独一块（`blockElement`）。
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
  return frag;
}

/** 只在值变了时才写：写同样的值也可能让浏览器把这一层的样式标脏、整份重排，分块就白做了。 */
function setStyle(target: HTMLElement, prop: string, value: string): void {
  if (target.style.getPropertyValue(prop) !== value) {
    target.style.setProperty(prop, value);
  }
}

function copyStyles(area: HTMLTextAreaElement, target: HTMLElement): void {
  const cs = getComputedStyle(area);
  for (const prop of COPIED_STYLES) {
    const value = cs.getPropertyValue(prop);
    if (value) {
      setStyle(target, prop, value);
    } else if (target.style.getPropertyValue(prop)) {
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
  setStyle(box, 'left', `${rect.left - (parentRect?.left ?? 0) - (parent?.clientLeft ?? 0) + area.clientLeft}px`);
  setStyle(box, 'top', `${rect.top - (parentRect?.top ?? 0) - (parent?.clientTop ?? 0) + area.clientTop}px`);
  setStyle(box, 'width', `${width}px`);
  setStyle(box, 'height', `${height}px`);
  setStyle(content, 'width', `${width}px`);
}

function syncScroll(m: Mirror): void {
  const area = m.pane.area;
  m.content.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
}
