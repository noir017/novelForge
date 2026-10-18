/**
 * 段落快捷键（所有文件）。「段」= 一个逻辑行（编辑区里的一行，自动折行不算断开）；空白行被跳过。
 * 纯函数只算「把哪一段换成什么、之后选区落在哪」，由 {@link installLineKeys} 交给 `Pane.applyEdit`——
 * 每个操作一步撤销。
 *
 * | 按键 | 做什么 |
 * |---|---|
 * | `Alt+↑` / `Alt+↓` | 光标所在行（有选区就是碰到的那几行，当成一块）与上 / 下一个非空行交换，中间的空行原地不动，选区跟着走 |
 * | `Shift+Alt+↓` / `Shift+Alt+↑` | 在下 / 上方复制这几行（正文按分段格式补段间隔）；向下复制时选区跟到新的那份上 |
 * | `Ctrl+Shift+K` | 删掉这几行（正文空行分段 / 缩进加空行下顺带删一个相邻的空行，不留下两个连着的空行） |
 * | `Ctrl+Enter` | 在当前段下面另起一段（正文按分段格式，其余沿用缩进） |
 *
 * Mac 上 `Ctrl` 也认 `Cmd`。「碰到」与 Tab 缩进同一个口径：选区止于某一行的行首时，那一行不算。
 */
import { paragraphBreak, paragraphGap } from '../protocol';
import { addKeyHandler, isProse } from './api';
import type { OpenFile } from './api';
import type { TextSelection } from './history';
import { paragraphStyle } from './paragraphState';

/** 一次操作要做的替换，参数与 `Pane.applyEdit` 一一对应。 */
export interface LineEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

interface Lines {
  lines: string[];
  /** 每一行在原文里的起点。 */
  starts: number[];
}

function split(value: string): Lines {
  const lines = value.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return { lines, starts };
}

const isBlank = (s: string) => s.trim() === '';

/** 第几行（从 0 起）。 */
function lineIndexOf(value: string, pos: number): number {
  let n = 0;
  for (let i = value.indexOf('\n'); i !== -1 && i < pos; i = value.indexOf('\n', i + 1)) {
    n++;
  }
  return n;
}

/** 选区碰到的那几行：`[first, last]`（行号）。选区止于某一行的行首时那一行不算。 */
export function touchedLines(value: string, sel: TextSelection): { first: number; last: number } {
  const first = lineIndexOf(value, sel.start);
  const end = sel.end > sel.start && value[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  return { first, last: Math.max(first, lineIndexOf(value, end)) };
}

const lengthWithBreaks = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

/**
 * 与上（`dir = -1`）/ 下（`dir = 1`）一个非空行交换。这几行全是空行、或那一边没有非空行时 undefined。
 */
export function moveLines(value: string, sel: TextSelection, dir: 1 | -1): LineEdit | undefined {
  const { lines, starts } = split(value);
  const { first, last } = touchedLines(value, sel);
  const block = lines.slice(first, last + 1);
  if (block.every(isBlank)) {
    return undefined;
  }
  if (dir === 1) {
    let j = last + 1;
    while (j < lines.length && isBlank(lines[j])) {
      j++;
    }
    if (j >= lines.length) {
      return undefined;
    }
    const blanks = lines.slice(last + 1, j);
    const shift = lines[j].length + 1 + lengthWithBreaks(blanks);
    return {
      start: starts[first],
      end: starts[j] + lines[j].length,
      text: [lines[j], ...blanks, ...block].join('\n'),
      selection: { start: sel.start + shift, end: sel.end + shift },
    };
  }
  let i = first - 1;
  while (i >= 0 && isBlank(lines[i])) {
    i--;
  }
  if (i < 0) {
    return undefined;
  }
  const blanks = lines.slice(i + 1, first);
  const shift = lines[i].length + 1 + lengthWithBreaks(blanks);
  return {
    start: starts[i],
    end: starts[last] + lines[last].length,
    text: [...block, ...blanks, lines[i]].join('\n'),
    selection: { start: sel.start - shift, end: sel.end - shift },
  };
}

/**
 * 在下（`dir = 1`）/ 上（`dir = -1`）方复制这几行，两份之间隔着 `gap`（`\n`，或正文空一行的 `\n\n`）。
 * 两个方向写出来的字一样，只是选区落在哪一份上不同（向下落在新的那份，向上留在上面那份）。
 * 这几行全是空行时 undefined。
 */
export function duplicateLines(value: string, sel: TextSelection, dir: 1 | -1, gap: string): LineEdit | undefined {
  const { lines, starts } = split(value);
  const { first, last } = touchedLines(value, sel);
  const block = lines.slice(first, last + 1);
  if (block.every(isBlank)) {
    return undefined;
  }
  const at = starts[last] + lines[last].length;
  const text = gap + block.join('\n');
  const shift = dir === 1 ? text.length : 0;
  return { start: at, end: at, text, selection: { start: sel.start + shift, end: sel.end + shift } };
}

/**
 * 删掉这几行。`collapseBlank`（正文空行分段 / 缩进加空行）时顺带删一个相邻的空行：两边都是空行时删后面那个，
 * 删的是第一段时删后面那个空行，删的是最后一段时删前面那个——不留下两个连着的空行，也不在文首文末留空行。
 * 光标落在原来那几行之后的那一行行首。
 */
export function deleteLines(value: string, sel: TextSelection, collapseBlank: boolean): LineEdit {
  const { lines } = split(value);
  const { first, last } = touchedLines(value, sel);
  const remove = new Set<number>();
  for (let i = first; i <= last; i++) {
    remove.add(i);
  }
  if (collapseBlank) {
    const prevBlank = first > 0 && isBlank(lines[first - 1]);
    const nextBlank = last + 1 < lines.length && isBlank(lines[last + 1]);
    if (nextBlank && (prevBlank || first === 0)) {
      remove.add(last + 1);
    } else if (prevBlank && last + 1 >= lines.length) {
      remove.add(first - 1);
    }
  }
  const kept = lines.filter((_, i) => !remove.has(i));
  const firstRemoved = Math.min(...remove);
  const landing = Math.max(0, Math.min(firstRemoved, kept.length - 1));
  const caret = lengthWithBreaks(kept.slice(0, landing));
  return { start: 0, end: value.length, text: kept.join('\n'), selection: { start: caret, end: caret } };
}

/** 在选区碰到的最后一行下面另起一段：行尾插 `insert`，光标落在插入之后。 */
export function paragraphBelow(value: string, sel: TextSelection, insert: (line: string) => string): LineEdit {
  const { lines, starts } = split(value);
  const { last } = touchedLines(value, sel);
  const at = starts[last] + lines[last].length;
  const text = insert(lines[last]);
  return { start: at, end: at, text, selection: { start: at + text.length, end: at + text.length } };
}

/** 正文按分段格式、其余按 `\n` 隔开复制出来的那一份。 */
function gapFor(file: OpenFile): string {
  return isProse(file) ? paragraphGap(paragraphStyle()) : '\n';
}

/** 挂段落快捷键。 */
export function installLineKeys(): void {
  addKeyHandler((e, { pane, file, area }) => {
    const mod = e.ctrlKey || e.metaKey;
    const value = area.value;
    const sel = { start: area.selectionStart, end: area.selectionEnd };
    let edit: LineEdit | undefined;
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      edit = e.shiftKey ? duplicateLines(value, sel, dir, gapFor(file)) : moveLines(value, sel, dir);
    } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      edit = deleteLines(value, sel, isProse(file) && paragraphStyle() !== 'indent');
    } else if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') {
      const prose = isProse(file);
      const style = paragraphStyle();
      edit = paragraphBelow(value, sel, (line) =>
        prose ? paragraphBreak(style) : `\n${/^[ \t　 ]*/.exec(line)![0]}`
      );
    } else {
      return false;
    }
    // 没得可做（到顶 / 到底、全是空行）也接下这一下：浏览器对这几个组合键的缺省动作在编辑区里没有用。
    if (edit) {
      pane.applyEdit(edit.start, edit.end, edit.text, edit.selection);
    }
    return true;
  });
}
