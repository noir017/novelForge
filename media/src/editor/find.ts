/**
 * 查找替换条：每块编辑区各一条，作用于**这一块的当前文件**。
 *
 * ## 结构
 *
 * 第一行：展开 / 收起替换行的小按钮、查找框、「Aa」区分大小写、「.*」正则、计数「3/17」、上一个 / 下一个、×。
 * 第二行（替换行，缺省收着）：替换框、「替换」「全部替换」。下面还有一行提示（正则写错了、文件太大不画高亮），
 * 平时藏着。
 *
 * **DOM 只在这里生成一份**（`buildFindDom`），两块编辑区都是第一次用到时现造、插在 `.ed-stage` 前面——
 * 页面模板（`page.ts`）与草稿区的克隆（`paneElements.ts`）里都没有它。查找条从前是两边各写一份、
 * 靠人对齐的（主区在 `page.ts`，草稿区在 `createPaneElements`），加了替换行与两颗开关之后再抄两份
 * 只会越抄越歪；它又是交互件、首屏用不到，与章节条（`chapterBar.ts`）一样由前端自己造最省事。
 *
 * ## 行为
 *
 * - `Ctrl+F` 打开（当前选区是一行之内的短文字时预填它）；`Ctrl+H` 打开并展开替换行；预览模式下先切回编辑。
 *   焦点在编辑区之外的输入框 / 文本框（左侧对话输入框之类）时不拦，留给浏览器。
 * - 查找框里打字：**从当前光标往后**找最近的一处，选中并滚过去（目标停在视口偏上三分之一，已经看得见就不滚）。
 *   选中时不把焦点拿回编辑区，人还在查找框里接着打字；textarea 没焦点时原生选区看不见，所以当前那一处
 *   另用一种颜色画在高亮层上（`highlight.ts`）。
 * - Enter 下一个、Shift+Enter 上一个；编辑器里 F3 / Shift+F3 也是；到头绕回。替换框里 Enter = 替换当前这一处并跳下一处。
 * - Esc 关掉、清高亮、焦点回编辑区（选区停在当前那一处）。
 * - 替换：选区**正好是**当前那一处时才换（否则这一下只是选中下一处，与常见编辑器一样按两下）；
 *   经 `pane.applyEdit`，一处一步撤销。
 * - 全部替换：一次 `applyEdit` 换掉从第一处到最后一处的那一段，**只记一步撤销**；提示「替换了 N 处」。
 * - 文字一变（打字、撤销、替换）下一帧重算，当前序号尽量留在原处附近；换了文件就按新文件重算（不动选区）。
 */
import { el } from '../dom';
import { toast } from '../globals';
import { isImeComposing, onEditorChange } from './api';
import type { EditorEvent } from './api';
import {
  escapeRegExp,
  findMatches,
  matchAfter,
  matchAt,
  matchBefore,
  nearestMatch,
  replaceAllIn,
  replacementFor,
  seedFromSelection,
} from './findCore';
import type { FindMatch, FindOptions } from './findCore';
import {
  HIGHLIGHT_LIMIT,
  cancelFrame,
  clearHighlights,
  mapOffset,
  nextFrame,
  scrollToOffset,
  setHighlights,
  tooLargeToHighlight,
} from './highlight';
import { activePane, panes } from './store';
import type { Pane } from './store';

/** 高亮层的名字。 */
const LAYER = 'find';
const CLS_MATCH = 'ed-hl-find';
const CLS_CURRENT = 'ed-hl-find-current';

/** 查找条的节点。class 名是对外的（测试按它取），**没有 id**：两块编辑区各有一条。 */
interface FindDom {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  input: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  replaceRow: HTMLElement;
  replaceInput: HTMLInputElement;
  replaceOne: HTMLButtonElement;
  replaceAll: HTMLButtonElement;
  note: HTMLElement;
}

function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  return b;
}

function textInput(cls: string, placeholder: string): HTMLInputElement {
  const input = el('input', cls);
  // 不用 type="search"：Chrome 里在 search 框按 Esc 是清空文字，与「Esc 关掉查找条」打架。
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function toggleButton(cls: string, text: string, title: string): HTMLButtonElement {
  const b = button(`ed-find-opt ${cls}`, text, title);
  b.setAttribute('aria-pressed', 'false');
  return b;
}

/** 查找条的 DOM，两块编辑区共用这一份生成函数。 */
function buildFindDom(): FindDom {
  const root = el('div', 'ed-find hidden');
  root.setAttribute('role', 'search');

  const findRow = el('div', 'ed-find-row');
  const toggle = button('ed-find-toggle', '▸', '展开替换（Ctrl+H）');
  toggle.setAttribute('aria-expanded', 'false');
  const input = textInput('ed-find-input', '查找');
  const caseBtn = toggleButton('ed-find-case', 'Aa', '区分大小写');
  const regexBtn = toggleButton('ed-find-regex', '.*', '正则表达式（替换里可以用 $1 引用分组）');
  const count = el('span', 'ed-find-count');
  count.setAttribute('aria-live', 'polite');
  const prev = button('chip-btn ed-find-prev', '上一个', '上一个（Shift+Enter / Shift+F3）');
  const next = button('chip-btn ed-find-next', '下一个', '下一个（Enter / F3）');
  const close = button('chip-btn ed-find-close', '×', '关闭查找（Esc）');
  findRow.append(toggle, input, caseBtn, regexBtn, count, prev, next, close);

  const replaceRow = el('div', 'ed-find-row ed-replace-row hidden');
  const replaceInput = textInput('ed-replace-input', '替换为');
  const replaceOne = button('chip-btn ed-replace-one', '替换', '替换当前这一处并跳到下一处（在替换框里按 Enter）');
  const replaceAll = button('chip-btn ed-replace-all', '全部替换', '替换全部，一次撤销就能全部退回');
  replaceRow.append(el('span', 'ed-find-gap'), replaceInput, replaceOne, replaceAll);

  const note = el('div', 'ed-find-note hidden');
  root.append(findRow, replaceRow, note);
  return {
    root, toggle, input, caseBtn, regexBtn, count, prev, next, close,
    replaceRow, replaceInput, replaceOne, replaceAll, note,
  };
}

// ---------------------------------------------------------------- 一条查找条

interface FindBar {
  open(opts?: { replace?: boolean; focus?: boolean; seed?: boolean }): void;
  close(): void;
  isOpen(): boolean;
  /** F3 / Shift+F3：没开着就开（焦点不动），有查找串就跳一处。 */
  stepFromEditor(dir: 1 | -1): void;
  onChange(ev: EditorEvent): void;
}

const bars = new WeakMap<Pane, FindBar>();

function barOf(pane: Pane): FindBar {
  let bar = bars.get(pane);
  if (!bar) {
    bar = createFindBar(pane);
    bars.set(pane, bar);
  }
  return bar;
}

function createFindBar(pane: Pane): FindBar {
  const dom = buildFindDom();
  const stage = pane.area.parentElement;
  (stage?.parentElement ?? pane.root).insertBefore(dom.root, stage);

  const opts: Required<FindOptions> = { caseSensitive: false, regex: false };
  let matches: FindMatch[] = [];
  let truncated = false;
  let error: string | undefined;
  /** 当前是第几处（`matches` 的下标），-1 表示还没落在哪一处上（计数写「共 N 处」）。 */
  let current = -1;
  /** 当前那一处的起点。文字变了按改动平移，重算之后挑离它最近的那一处当当前。 */
  let currentPos: number | undefined;
  /** 匹配是给哪个文件算的。 */
  let path = pane.activePath;
  let frame: number | undefined;

  const area = pane.area;
  const isOpen = () => !dom.root.classList.contains('hidden');
  const query = () => dom.input.value;

  /**
   * 预览模式下先切回编辑（`activate` 同一个文件就是切回来，光标与滚动位置照旧）。`activate` 会把焦点给
   * textarea；人正在查找条里打字的话，焦点还回去。
   */
  function ensureEditing(): void {
    if (pane.isPreviewing() && pane.activePath) {
      const focused = document.activeElement;
      pane.activate(pane.activePath);
      if (focused instanceof HTMLElement && dom.root.contains(focused)) {
        focused.focus();
      }
    }
  }

  /** 按当前文字重算全部匹配；当前那一处取离 `currentPos` 最近的。`repaint: false` 时由调用方接着画。 */
  function compute(repaint = true): void {
    if (frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    const result = findMatches(area.value, query(), opts);
    matches = result.matches;
    truncated = result.truncated;
    error = result.error;
    current = currentPos === undefined ? -1 : nearestMatch(matches, currentPos);
    currentPos = current >= 0 ? matches[current].start : undefined;
    if (repaint) {
      paint();
    }
  }

  function schedule(): void {
    if (frame === undefined) {
      frame = nextFrame(() => {
        frame = undefined;
        compute();
      });
    }
  }

  /** 计数、提示、高亮。 */
  function paint(): void {
    const q = query();
    const total = truncated ? `${matches.length}+` : `${matches.length}`;
    dom.count.textContent = !q || error
      ? ''
      : matches.length === 0
        ? '无结果'
        : current >= 0
          ? `${current + 1}/${total}`
          : `共 ${total} 处`;
    dom.input.classList.toggle('invalid', !!error);

    const note = error
      ? '正则写错了'
      : q && tooLargeToHighlight(area.value)
        ? `这份文件超过 ${HIGHLIGHT_LIMIT / 10000} 万字，不画高亮（查找替换照常）`
        : '';
    dom.note.textContent = note;
    dom.note.title = error ?? '';
    dom.note.classList.toggle('hidden', !note);

    if (!isOpen() || matches.length === 0) {
      clearHighlights(pane, LAYER);
      return;
    }
    setHighlights(
      pane,
      LAYER,
      matches.map((m, i) => ({ start: m.start, end: m.end, cls: i === current ? CLS_CURRENT : CLS_MATCH }))
    );
  }

  /** 选中第 i 处并滚过去。不夺焦点：人可能还在查找框里打字。 */
  function select(i: number): void {
    current = i;
    const m = matches[i];
    currentPos = m.start;
    area.setSelectionRange(m.start, m.end);
    scrollToOffset(pane, m.start, { onlyIfHidden: true });
    paint();
  }

  /** 重算，再选中 `pick` 挑出来的那一处；一处都没有时只画计数。高亮只画一次。 */
  function recomputeAndSelect(pick: () => number): void {
    compute(false);
    if (matches.length > 0) {
      select(pick());
    } else {
      paint();
    }
  }

  /** 查找框里的字变了 / 开关换了：从当前光标（选区起点）往后找最近的一处。 */
  function searchFromCaret(): void {
    ensureEditing();
    currentPos = undefined;
    recomputeAndSelect(() => matchAfter(matches, area.selectionStart));
  }

  function step(dir: 1 | -1): void {
    ensureEditing();
    if (!query()) {
      dom.input.focus();
      return;
    }
    recomputeAndSelect(() => {
      const { selectionStart: s, selectionEnd: e } = area;
      return dir === 1 ? matchAfter(matches, e > s ? e : s) : matchBefore(matches, s);
    });
  }

  function replaceCurrent(): void {
    ensureEditing();
    if (!query()) {
      return;
    }
    compute(false);
    const i = matchAt(matches, area.selectionStart, area.selectionEnd);
    const m = matches[i];
    const text = m && replacementFor(area.value, m, query(), dom.replaceInput.value, opts);
    if (!m || text === undefined) {
      // 选区不是当前那一处（刚打开、或光标挪过）：这一下只选中下一处，看清楚了再按一下才换。
      if (matches.length > 0) {
        select(matchAfter(matches, area.selectionStart));
      } else {
        paint();
      }
      return;
    }
    pane.applyEdit(m.start, m.end, text, { start: m.start, end: m.start + text.length });
    currentPos = undefined;
    recomputeAndSelect(() => matchAfter(matches, m.start + text.length));
  }

  function replaceEverything(): void {
    ensureEditing();
    if (!query()) {
      return;
    }
    const edit = replaceAllIn(area.value, query(), dom.replaceInput.value, opts);
    if (!edit) {
      compute();
      toast(error ? '正则写错了，没有替换。' : '没有可替换的。', !!error);
      return;
    }
    pane.applyEdit(edit.start, edit.end, edit.text);
    currentPos = undefined;
    compute();
    toast(`替换了 ${edit.count} 处`);
  }

  function setReplaceOpen(on: boolean): void {
    dom.replaceRow.classList.toggle('hidden', !on);
    dom.toggle.textContent = on ? '▾' : '▸';
    dom.toggle.title = on ? '收起替换' : '展开替换（Ctrl+H）';
    dom.toggle.setAttribute('aria-expanded', String(on));
  }

  function setOption(btn: HTMLButtonElement, key: keyof FindOptions): void {
    opts[key] = !opts[key];
    btn.classList.toggle('on', opts[key]);
    btn.setAttribute('aria-pressed', String(opts[key]));
    dom.input.focus();
    if (query()) {
      searchFromCaret();
    }
  }

  /**
   * 打开（已经开着就是回到查找框）。`seed`：一行之内的短选区预填进查找框——焦点已经在查找条里时不填
   * （那时 textarea 的选区就是当前那一处，填进去会把人刚写好的正则换成它的字面量）。
   */
  function open(o: { replace?: boolean; focus?: boolean; seed?: boolean } = {}): void {
    if (!pane.activeFile()) {
      return;
    }
    const fromBar = isOpen() && dom.root.contains(document.activeElement);
    ensureEditing();
    dom.root.classList.remove('hidden');
    if (o.replace) {
      setReplaceOpen(true);
    }
    const seed = o.seed === false || fromBar
      ? undefined
      : seedFromSelection(area.value, area.selectionStart, area.selectionEnd);
    if (seed !== undefined) {
      dom.input.value = opts.regex ? escapeRegExp(seed) : seed;
    }
    if (o.focus !== false) {
      dom.input.focus();
      dom.input.select();
    }
    path = pane.activePath;
    currentPos = undefined;
    compute();
    // 选区正好是一处（预填的就是）：它就是当前这一处。
    const i = matchAt(matches, area.selectionStart, area.selectionEnd);
    if (i >= 0) {
      current = i;
      currentPos = matches[i].start;
      paint();
    }
  }

  function close(): void {
    if (!isOpen()) {
      return;
    }
    dom.root.classList.add('hidden');
    if (frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    clearHighlights(pane, LAYER);
    if (pane.activeFile() && !pane.isPreviewing()) {
      area.focus();
    }
  }

  function stepFromEditor(dir: 1 | -1): void {
    if (!isOpen()) {
      // 没有查找串时等于 Ctrl+F（预填选区、焦点进查找框）；有就只把条亮出来，焦点留在编辑区。
      const empty = !query();
      open({ focus: empty, seed: empty });
    }
    if (query()) {
      step(dir);
    }
  }

  function onChange(ev: EditorEvent): void {
    if (ev.type === 'render') {
      if (pane.activePath === path) {
        return;
      }
      // 换了文件：上一个文件的匹配作废，按新文件重算（不动选区）；标签全关了就收起来。
      path = pane.activePath;
      matches = [];
      current = -1;
      currentPos = undefined;
      if (!pane.activeFile()) {
        dom.root.classList.add('hidden');
        clearHighlights(pane, LAYER);
      } else if (isOpen()) {
        schedule();
      }
      return;
    }
    if (!isOpen() || ev.file !== pane.activeFile()) {
      return;
    }
    if (ev.change && currentPos !== undefined) {
      currentPos = mapOffset(currentPos, ev.change);
    }
    schedule();
  }

  // ---- 事件
  dom.input.addEventListener('input', (e) => {
    // 拼音还没上屏时不找（找的是那几个字母），上屏时 compositionend 再找。
    if (!(e as InputEvent).isComposing) {
      searchFromCaret();
    }
  });
  dom.input.addEventListener('compositionend', searchFromCaret);
  dom.input.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
  dom.replaceInput.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    }
  });
  // 查找条里任何一处（两个输入框、按钮）按 Esc 都是关掉。
  dom.root.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  dom.prev.addEventListener('click', () => step(-1));
  dom.next.addEventListener('click', () => step(1));
  dom.close.addEventListener('click', close);
  dom.toggle.addEventListener('click', () => {
    const on = dom.replaceRow.classList.contains('hidden');
    setReplaceOpen(on);
    (on ? dom.replaceInput : dom.input).focus();
  });
  dom.caseBtn.addEventListener('click', () => setOption(dom.caseBtn, 'caseSensitive'));
  dom.regexBtn.addEventListener('click', () => setOption(dom.regexBtn, 'regex'));
  dom.replaceOne.addEventListener('click', replaceCurrent);
  dom.replaceAll.addEventListener('click', replaceEverything);

  return { open, close, isOpen, stepFromEditor, onChange };
}

// ---------------------------------------------------------------- 全局

/** 打开某块编辑区的查找条（`replace` 时连替换行一起展开）。没开文件时什么都不做。 */
export function openFind(pane: Pane | undefined, opts: { replace?: boolean } = {}): void {
  if (pane?.activeFile()) {
    barOf(pane).open(opts);
  }
}

/** 事件目标落在哪一块编辑区里（查找条也算在那一块里）。 */
function paneContaining(target: EventTarget | null): Pane | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  return Object.values(panes).find((p) => p.root.contains(target));
}

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * 这一下查找快捷键该给哪块编辑区：焦点在某块里就是那一块；焦点在编辑区之外的输入框 / 文本框
 * （左侧对话输入框之类）时谁都不给，留给浏览器；其余（焦点在页面上、按钮上）给当前那一块。
 * 那一块没开文件也不给。
 */
function paneForShortcut(e: KeyboardEvent): Pane | undefined {
  const inside = paneContaining(e.target);
  const pane = inside ?? (isTextField(e.target) ? undefined : activePane);
  return pane?.activeFile() ? pane : undefined;
}

let installed = false;

/** 装上查找的快捷键、菜单命令与变化订阅。editor/index.ts 启动时调一次。 */
export function installFind(): void {
  if (installed) {
    return;
  }
  installed = true;

  document.addEventListener('keydown', (e) => {
    // 输入法组字中途的按键是输入法的。
    if (isImeComposing(e)) {
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (ctrl && !e.altKey && (key === 'f' || key === 'h')) {
      const pane = paneForShortcut(e);
      if (pane) {
        // Chrome 允许拦 Ctrl+H（历史记录），拦得到。
        e.preventDefault();
        openFind(pane, { replace: key === 'h' });
      }
      return;
    }
    if (key === 'F3' && !ctrl && !e.altKey) {
      const pane = paneForShortcut(e);
      if (pane) {
        e.preventDefault();
        barOf(pane).stepFromEditor(e.shiftKey ? -1 : 1);
      }
      return;
    }
    if (key === 'Escape' && !ctrl) {
      // 编辑区里按 Esc 也收起这一块的查找条（查找框、替换框里的 Esc 它们自己处理了）。
      const pane = paneContaining(e.target);
      const bar = pane && bars.get(pane);
      if (pane && bar?.isOpen() && e.target === pane.area) {
        e.preventDefault();
        bar.close();
      }
    }
  });

  // 标题栏「编辑 → 查找 / 替换」。
  window.addEventListener('nf-editor-command', (e) => {
    if (e.detail.name === 'find' || e.detail.name === 'replace') {
      openFind(activePane, { replace: e.detail.name === 'replace' });
    }
  });

  onEditorChange((ev) => bars.get(ev.pane)?.onChange(ev));
}
