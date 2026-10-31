/**
 * 「版本」对比标签的纯函数（`versionDiff.ts` 用，**零 DOM、零 import**，单测直接跑）：两版按行比、一处改动里逐字标出
 * 删了什么加了什么、「用回这一处」该把现在这份的哪一截换成什么。
 *
 * ## 按行比，不按空行切段
 *
 * 合并视图（`model/paragraphDiff.ts`）按空行切段：「段首缩进」格式的书段与段之间没有空行，整章会切成一段。这里按行
 * 比——三种分段格式里一行都是一段。**空行不算行，行首行尾的空白不算不同**（VS Code 的 diff 缺省也忽略首尾空白）：
 * 一键排版补上的缩进、多一个空行不是作者要找的改动；两版只差这些时界面上照实说「只有空白不同」（{@link onlyWhitespace}）。
 *
 * ## Myers
 *
 * 最短编辑脚本（Myers 1986），先去掉两头相同的行。编辑步数超过上限（{@link MAX_LINE_EDITS}）就不再找，中间那一截整个
 * 当一处改动——整章重写时找最短脚本既慢又没意义。一处改动里逐字比也是它（按码点，上限 {@link MAX_CHAR_EDITS}，
 * 超了就只标整行），比完把夹在两处改动中间的一两个字并进改动：中文没有词界，「的」「了」这种碰巧相同的单字会把
 * 一句改写切成碎片。
 *
 * ## 位置
 *
 * 两边先把 `\r\n` / `\r` 归一成 `\n`（textarea 的 `value` 就是这样），所有下标按归一后的文字算——与编辑区
 * `area.value` 同一套，{@link revertEdit} 给的范围可以直接交给 `Pane.applyEdit`。
 */

/** 一行（不算空行）：在全文里的 `[start, end)`（不含换行）。 */
export interface DiffLine {
  start: number;
  end: number;
  text: string;
}

/** 连着的一截：两边一样的几行，或一处改动（左边删掉的几行、右边加上的几行，可以一边是空的）。行号是 `[from, to)`。 */
export interface DiffBlock {
  kind: 'same' | 'change';
  left: [number, number];
  right: [number, number];
}

export interface LineDiff {
  /** 归一换行之后的两份全文。 */
  before: string;
  after: string;
  left: DiffLine[];
  right: DiffLine[];
  blocks: DiffBlock[];
  /** 几处改动。 */
  changes: number;
}

/** 行级编辑步数的上限：超了中间整个当一处。 */
export const MAX_LINE_EDITS = 2000;
/** 一处改动里逐字比的编辑步数上限：超了只标整行。 */
export const MAX_CHAR_EDITS = 1200;
/** 夹在两处改动中间、并进改动的相同文字最多几个字。 */
const NOISE_CHARS = 2;

export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** 全文里的非空行（只有空白的行也不算）。 */
export function textLines(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(start, end);
    if (line.trim() !== '') {
      out.push({ start, end, text: line });
    }
    start = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------- Myers

/** 0 两边一样（各进一步），1 删掉左边一个，2 加上右边一个。 */
type Op = 0 | 1 | 2;

/** `a` → `b` 的最短编辑脚本；步数超过 `maxD` 给 undefined。 */
function editScript<T>(a: readonly T[], b: readonly T[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) {
    return [];
  }
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 第 d 步开始时存下第 d-1 步的结果（只存这一步用得到的 [-d-1, d+1] 那一截），倒推时认它。
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) {
      return undefined;
    }
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m);
      }
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], last: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (down) {
      ops.push(2);
      y--;
    } else {
      ops.push(1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  return ops.reverse();
}

// ---------------------------------------------------------------- 按行

/** 两版按行比。空行不算，行首行尾的空白不算不同。 */
export function diffLines(beforeText: string, afterText: string): LineDiff {
  const before = normalizeEol(beforeText);
  const after = normalizeEol(afterText);
  const left = textLines(before);
  const right = textLines(after);
  const ka = left.map((l) => l.text.trim());
  const kb = right.map((l) => l.text.trim());

  // 两头一样的先去掉，只在中间那一截上找。
  let head = 0;
  while (head < ka.length && head < kb.length && ka[head] === kb[head]) {
    head++;
  }
  let tail = 0;
  while (tail < ka.length - head && tail < kb.length - head && ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]) {
    tail++;
  }
  const midA = ka.slice(head, ka.length - tail);
  const midB = kb.slice(head, kb.length - tail);
  const script = editScript(midA, midB, MAX_LINE_EDITS) ?? [...midA.map((): Op => 1), ...midB.map((): Op => 2)];
  const ops: Op[] = [...Array<Op>(head).fill(0), ...script, ...Array<Op>(tail).fill(0)];

  const blocks: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    const kind = op === 0 ? 'same' : 'change';
    let last = blocks[blocks.length - 1];
    if (last?.kind !== kind) {
      last = { kind, left: [i, i], right: [j, j] };
      blocks.push(last);
    }
    if (op !== 2) {
      i++;
      last.left[1] = i;
    }
    if (op !== 1) {
      j++;
      last.right[1] = j;
    }
  }
  return { before, after, left, right, blocks, changes: blocks.filter((b) => b.kind === 'change').length };
}

/** 两版文字不一样，但按行比没有一处改动：只差空行、行首行尾的空白（缩进）。 */
export function onlyWhitespace(diff: LineDiff): boolean {
  return diff.changes === 0 && diff.before !== diff.after;
}

/** 一处改动两边各自的文字：那几行原样（行首空白也在），行与行之间一个换行。 */
export function blockText(diff: LineDiff, block: DiffBlock, side: 'left' | 'right'): string {
  const lines = side === 'left' ? diff.left : diff.right;
  const [from, to] = block[side];
  return lines
    .slice(from, to)
    .map((l) => l.text)
    .join('\n');
}

// ---------------------------------------------------------------- 逐字

/** 一处改动里两边逐字比：左边删掉的、右边加上的各是哪几截（下标按 {@link blockText} 那段文字，UTF-16）。 */
export interface CharMarks {
  left: [number, number][];
  right: [number, number][];
}

/** 逐字比。太长、改得太多（超过上限）给 undefined：只标整行。 */
export function charDiff(a: string, b: string): CharMarks | undefined {
  const ca = Array.from(a);
  const cb = Array.from(b);
  // 两头一样的先去掉。
  let head = 0;
  while (head < ca.length && head < cb.length && ca[head] === cb[head]) {
    head++;
  }
  let tail = 0;
  while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail]) {
    tail++;
  }
  const script = editScript(ca.slice(head, ca.length - tail), cb.slice(head, cb.length - tail), MAX_CHAR_EDITS);
  if (!script) {
    return undefined;
  }
  const ops = absorbNoise([...Array<Op>(head).fill(0), ...script, ...Array<Op>(tail).fill(0)]);

  // 码点 → UTF-16 下标。
  const units = (chars: string[]) => {
    const at = [0];
    for (const c of chars) {
      at.push(at[at.length - 1] + c.length);
    }
    return at;
  };
  const ua = units(ca);
  const ub = units(cb);
  const marks: CharMarks = { left: [], right: [] };
  const push = (list: [number, number][], from: number, to: number) => {
    const last = list[list.length - 1];
    if (last && last[1] === from) {
      last[1] = to;
    } else {
      list.push([from, to]);
    }
  };
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 0) {
      i++;
      j++;
    } else if (op === 1) {
      push(marks.left, ua[i], ua[i + 1]);
      i++;
    } else {
      push(marks.right, ub[j], ub[j + 1]);
      j++;
    }
  }
  return marks;
}

/** 夹在两处改动中间、不超过 {@link NOISE_CHARS} 个字的相同文字：两边都当改了（先删后加）。 */
function absorbNoise(ops: Op[]): Op[] {
  const runs: { op: Op; len: number }[] = [];
  for (const op of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === op) {
      last.len++;
    } else {
      runs.push({ op, len: 1 });
    }
  }
  const out: Op[] = [];
  runs.forEach((run, k) => {
    const between = run.op === 0 && k > 0 && k < runs.length - 1;
    if (between && run.len <= NOISE_CHARS) {
      out.push(...Array<Op>(run.len).fill(1), ...Array<Op>(run.len).fill(2));
    } else {
      out.push(...Array<Op>(run.len).fill(run.op));
    }
  });
  return out;
}

// ---------------------------------------------------------------- 用回这一处

/** 对右边（现在这份）全文的一次替换：把 `[start, end)` 换成 `text`。 */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * 「用回这一处」：把右边这一处换回左边那样。换的是右边那几行连同它们之间的分隔；左边那几行连同它们之间原来的分隔原样搬过来。
 * - 两边都有：右边第一行行首到最后一行行尾，换成左边第一行行首到最后一行行尾。
 * - 只有右边（现在多出来的）：连同它前面那道分隔一起删（在开头就连同后面那道）。
 * - 只有左边（现在少了的）：插在右边前一行之后，前面补上左边原来的那道分隔（在开头就插在右边第一行之前，后面补分隔）。
 */
export function revertEdit(diff: LineDiff, block: DiffBlock): TextEdit {
  const { left, right, before, after } = diff;
  const [i1, i2] = block.left;
  const [j1, j2] = block.right;
  const oldText = i2 > i1 ? before.slice(left[i1].start, left[i2 - 1].end) : '';
  if (j2 > j1 && i2 > i1) {
    return { start: right[j1].start, end: right[j2 - 1].end, text: oldText };
  }
  if (j2 > j1) {
    if (j1 > 0) {
      return { start: right[j1 - 1].end, end: right[j2 - 1].end, text: '' };
    }
    return { start: right[j1].start, end: j2 < right.length ? right[j2].start : right[j2 - 1].end, text: '' };
  }
  // 只有左边：现在少了这几行，插回去。
  const sepBefore = i1 > 0 ? before.slice(left[i1 - 1].end, left[i1].start) : '\n';
  const sepAfter = i2 < left.length ? before.slice(left[i2 - 1].end, left[i2].start) : '\n';
  if (j1 > 0) {
    const at = right[j1 - 1].end;
    return { start: at, end: at, text: `${sepBefore}${oldText}` };
  }
  if (right.length > 0) {
    const at = right[0].start;
    return { start: at, end: at, text: `${oldText}${sepAfter}` };
  }
  return { start: after.length, end: after.length, text: oldText };
}
