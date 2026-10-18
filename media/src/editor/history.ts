/**
 * 编辑器自己管的撤销 / 重做。**每个打开的文件一份**（挂在 `OpenFile.history` 上）：
 * 切标签不丢，关掉标签随之丢弃，刷新页面不恢复。
 *
 * ## 为什么不用浏览器原生的撤销
 *
 * 一块编辑区的所有标签共用一个 `<textarea>`，切标签时整份换 `value`，原生撤销记录随之作废；
 * Tab 缩进、粘贴兜底、「还原」这类程序改写也会把它截断。原生撤销在不同浏览器 / 桌面 WebView
 * 里跨元素、跨程序改写的行为各不相同，这台机器上测不了，jsdom 里也测不了。所以自己记：
 * 结果确定，jsdom 里能测。原生的那一份一律不用——`Ctrl+Z`、`beforeinput` 的 `historyUndo`、
 * 标题栏「编辑 → 撤销」都拦下来走这里（见 `pane.ts`）。
 *
 * ## 记的是差异，不是快照
 *
 * 一步 = 一串 `TextChange`（起点、删掉的文字、插入的文字）+ 改之前与改之后的选区。
 * 一章几万字，500 步整份快照就是几十 MB；差异通常只有几个字。
 *
 * ## 什么时候并成一步
 *
 * 只有 `record(..., { merge: true })` 记下的（`pane.ts` 里的连续打字 / 连续删除）才可能并：
 * 与上一步同一类（都是插入，或都是删除）、位置紧挨着、间隔不超过 `MERGE_WINDOW_MS`，
 * 且这一下不含换行——敲回车单独成一步，回车之后打的字另起一步。粘贴、拖放、输入法上屏、
 * 程序改写各自一步，前后都不并；撤销 / 重做之后接着打字也另起一步。
 * `join: true` 是程序改写用的：把这一处并进刚记下的那一步（例如成对符号补的后半个），
 * 撤销时两处一起退。
 *
 * ## 纯逻辑
 *
 * 不碰 DOM、不读时钟以外的任何东西：文字由调用方传进来，返回新的文字与选区，由调用方写回编辑区。
 * 撤销前会核对「这一步插入的文字确实还在那个位置」，对不上说明有改动绕过了记账，整份历史作废
 * （宁可退不回去，也不拿错位的差异把正文改乱）。
 */

/** 选区：`start` ≤ `end`，按 UTF-16 下标算（与 textarea 的 `selectionStart` / `selectionEnd` 同一套）。 */
export interface TextSelection {
  start: number;
  end: number;
}

/** 一处改动：在 `at` 处把 `removed` 换成 `inserted`。`at` 按这一处改动**之前**的文字算。 */
export interface TextChange {
  at: number;
  removed: string;
  inserted: string;
}

export interface RecordOptions {
  /** 这是一下打字 / 删除，可以并进上一步（规则见文件头）。 */
  merge?: boolean;
  /** 并进刚记下的那一步（程序改写用）。上一步不存在、或中间撤销 / 重做过时照常另起一步。 */
  join?: boolean;
  /** 现在几点（毫秒）。测试用；缺省 `Date.now()`。 */
  now?: number;
}

/** 撤销 / 重做的结果：整份新文字与该落的选区。 */
export interface HistoryResult {
  text: string;
  selection: TextSelection;
}

/** 连续打字隔多久不再并进同一步。 */
export const MERGE_WINDOW_MS = 1000;
/** 一个文件最多记多少步，再多就丢最早的。 */
export const HISTORY_LIMIT = 500;

interface Entry {
  /** 按发生顺序。撤销时倒着退。 */
  changes: TextChange[];
  before: TextSelection;
  after: TextSelection;
}

/** 还开着、可以继续往里并的那一步打字。 */
interface Typing {
  entry: Entry;
  kind: 'insert' | 'delete';
  time: number;
}

export class EditHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private typing: Typing | undefined;
  /** 刚记下的那一步；`join` 只往它里面并。撤销 / 重做后清掉。 */
  private last: Entry | undefined;

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 撤销栈有多少步（测试与诊断用）。 */
  get size(): number {
    return this.undoStack.length;
  }

  /** 记一处改动。`before` / `after` 是这处改动前后的选区。删掉与插入相同（没改）时什么都不记。 */
  record(change: TextChange, before: TextSelection, after: TextSelection, opts: RecordOptions = {}): void {
    if (change.removed === change.inserted) {
      return;
    }
    const now = opts.now ?? Date.now();
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];

    if (opts.join && top && top === this.last) {
      top.changes.push({ ...change });
      top.after = { ...after };
      this.typing = undefined;
      return;
    }

    if (opts.merge && this.typing && this.typing.entry === top && this.mergeInto(this.typing, change, now)) {
      top.after = { ...after };
      this.typing.time = now;
      return;
    }

    const entry: Entry = { changes: [{ ...change }], before: { ...before }, after: { ...after } };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) {
      this.undoStack.splice(0, this.undoStack.length - this.limit);
    }
    this.last = entry;
    const kind = opts.merge ? typingKind(change) : undefined;
    this.typing = kind ? { entry, kind, time: now } : undefined;
  }

  /** 撤销一步。没有可撤销的、或历史与 `text` 对不上（整份作废）时返回 undefined。 */
  undo(text: string): HistoryResult | undefined {
    const entry = this.undoStack.pop();
    if (!entry) {
      return undefined;
    }
    let out = text;
    for (let i = entry.changes.length - 1; i >= 0; i--) {
      const c = entry.changes[i];
      if (out.slice(c.at, c.at + c.inserted.length) !== c.inserted) {
        this.clear();
        return undefined;
      }
      out = out.slice(0, c.at) + c.removed + out.slice(c.at + c.inserted.length);
    }
    this.redoStack.push(entry);
    this.typing = undefined;
    this.last = undefined;
    return { text: out, selection: { ...entry.before } };
  }

  /** 重做一步。没有可重做的、或历史与 `text` 对不上（整份作废）时返回 undefined。 */
  redo(text: string): HistoryResult | undefined {
    const entry = this.redoStack.pop();
    if (!entry) {
      return undefined;
    }
    let out = text;
    for (const c of entry.changes) {
      if (out.slice(c.at, c.at + c.removed.length) !== c.removed) {
        this.clear();
        return undefined;
      }
      out = out.slice(0, c.at) + c.inserted + out.slice(c.at + c.removed.length);
    }
    this.undoStack.push(entry);
    this.typing = undefined;
    this.last = undefined;
    return { text: out, selection: { ...entry.after } };
  }

  /** 下一下打字不再并进上一步（光标被挪走、切了标签之类）。 */
  seal(): void {
    this.typing = undefined;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.typing = undefined;
    this.last = undefined;
  }

  private mergeInto(typing: Typing, change: TextChange, now: number): boolean {
    if (now - typing.time > MERGE_WINDOW_MS || typing.entry.changes.length !== 1) {
      return false;
    }
    if (typingKind(change) !== typing.kind) {
      return false;
    }
    const prev = typing.entry.changes[0];
    if (typing.kind === 'insert') {
      // 只并纯插入：接着上一步插入的末尾往下打。
      if (change.removed !== '' || change.at !== prev.at + prev.inserted.length) {
        return false;
      }
      prev.inserted += change.inserted;
      return true;
    }
    // 删除：退格往前吃（这一处紧贴在上一处之前），或 Delete 往后吃（同一个位置）。
    if (change.at + change.removed.length === prev.at) {
      prev.at = change.at;
      prev.removed = change.removed + prev.removed;
      return true;
    }
    if (change.at === prev.at) {
      prev.removed += change.removed;
      return true;
    }
    return false;
  }
}

/**
 * 一下打字算哪一类。插入（含打字盖掉选区的第一下）与删除各算一类；带换行的不算——
 * 回车、退格吃掉换行都单独成一步，也不让后面的字并进来。
 */
function typingKind(change: TextChange): 'insert' | 'delete' | undefined {
  if (change.inserted !== '') {
    return change.inserted.includes('\n') ? undefined : 'insert';
  }
  if (change.removed !== '') {
    return change.removed.includes('\n') ? undefined : 'delete';
  }
  return undefined;
}

/**
 * 两份文字的差异：公共前缀与公共后缀之间的那一段。相同时返回 undefined。
 *
 * `caret` 是改完之后的光标位置（可选）：打字与删除时改动总是结束在光标处，拿它把有歧义的情形
 * 认对——在「aab」第一个 a 后面再打一个 a，单看前后缀会认成在第二个 a 后面插的。
 * 光标与前后缀对不上（例如程序改写）时退回单看前后缀。不会把一个代理对（emoji 等）从中间切开。
 */
export function diffText(prev: string, next: string, caret?: number): TextChange | undefined {
  if (prev === next) {
    return undefined;
  }
  const max = Math.min(prev.length, next.length);

  let suffix = -1;
  if (caret !== undefined && caret >= 0 && caret <= next.length) {
    const s = next.length - caret;
    if (s <= prev.length && prev.endsWith(next.slice(caret))) {
      suffix = s;
    }
  }
  let prefix = 0;
  const prefixLimit = suffix >= 0 ? Math.min(prev.length, next.length) - suffix : max;
  while (prefix < prefixLimit && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix++;
  }
  if (suffix < 0) {
    suffix = 0;
    while (
      suffix < max - prefix &&
      prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix++;
    }
  }
  // 别把代理对切成两半。
  if (prefix > 0 && isHighSurrogate(next.charCodeAt(prefix - 1))) {
    prefix--;
  }
  if (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix))) {
    suffix--;
  }
  return {
    at: prefix,
    removed: prev.slice(prefix, prev.length - suffix),
    inserted: next.slice(prefix, next.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
