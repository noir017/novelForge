/**
 * Tab / Shift+Tab 缩进。纯函数：只算「把哪一段换成什么、之后选区落在哪」，由 `pane.ts` 交给
 * `Pane.applyEdit` 执行——一次按键一步撤销。缩进单位（正文两个全角空格、其余两个半角空格）
 * 由调用方按 `api.ts` 的 `indentUnit(file)` 给。
 *
 * - **有选区**（哪怕只在一行里选了几个字）：**绝不删选中的字**，给选区碰到的每一行行首加一级缩进
 *   （空行、只有空白的行跳过），之后选区仍覆盖这几行，起止位置随插入量平移。
 * - **Shift+Tab**：选区碰到的每一行（没有选区就是光标所在那一行）去掉行首一级缩进——认
 *   `　　`、单个 `　`、两个半角空格、一个半角空格、`\t`，按这个顺序试，每行最多去一级。
 * - 「碰到」：选区止于某一行的行首时（选整行时常见，光标落在下一行开头），那一行不算。
 *
 * 没有选区时的 Tab（在光标处插一级缩进）不经这里，`pane.ts` 直接 `applyEdit(光标, 光标, 单位)`。
 */
import type { TextSelection } from './history';

/** 一次缩进 / 去缩进要做的替换，参数与 `Pane.applyEdit` 一一对应。 */
export interface IndentEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

/** Shift+Tab 认的行首缩进，按先后试，每行最多去一级。 */
const OUTDENT_PREFIXES = ['　　', '　', '  ', ' ', '\t'];

/** 选区碰到的那几行：`[from, to)`，`from` 是第一行行首，`to` 是最后一行行尾（不含换行）。 */
function touchedLines(value: string, sel: TextSelection): { from: number; to: number } {
  const from = sel.start === 0 ? 0 : value.lastIndexOf('\n', sel.start - 1) + 1;
  // 选区止于某一行的行首：那一行不算。
  const last = sel.end > sel.start && value[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = value.indexOf('\n', last);
  return { from, to: nl === -1 ? value.length : nl };
}

/** 选区碰到的每一行行首加一级缩进。一行都没加（全是空行）时返回 undefined。 */
export function indentLines(value: string, sel: TextSelection, unit: string): IndentEdit | undefined {
  const { from, to } = touchedLines(value, sel);
  /** 在旧文字里哪些位置插了缩进。 */
  const inserts: number[] = [];
  let pos = from;
  const lines = value
    .slice(from, to)
    .split('\n')
    .map((line) => {
      const at = pos;
      pos += line.length + 1;
      if (line.trim() === '') {
        return line;
      }
      inserts.push(at);
      return unit + line;
    });
  if (inserts.length === 0) {
    return undefined;
  }
  // 插在某个位置之前的缩进才把它往后推：选区起点正好在行首时留在行首（新缩进算进选区）。
  const map = (p: number) => p + unit.length * inserts.filter((q) => q < p).length;
  return { start: from, end: to, text: lines.join('\n'), selection: { start: map(sel.start), end: map(sel.end) } };
}

/** 选区碰到的每一行（没有选区就是光标所在行）去掉行首一级缩进。一处都没去时返回 undefined。 */
export function outdentLines(value: string, sel: TextSelection): IndentEdit | undefined {
  const { from, to } = touchedLines(value, sel);
  /** 在旧文字里去掉了哪几段：`[at, at + len)`。 */
  const removals: { at: number; len: number }[] = [];
  let pos = from;
  const lines = value
    .slice(from, to)
    .split('\n')
    .map((line) => {
      const at = pos;
      pos += line.length + 1;
      const prefix = OUTDENT_PREFIXES.find((p) => line.startsWith(p));
      if (!prefix) {
        return line;
      }
      removals.push({ at, len: prefix.length });
      return line.slice(prefix.length);
    });
  if (removals.length === 0) {
    return undefined;
  }
  // 落在被删那段之后的往前挪整段，落在那段中间的挪到那段的起点。
  const map = (p: number) =>
    p - removals.reduce((sum, r) => sum + Math.max(0, Math.min(p - r.at, r.len)), 0);
  return { start: from, end: to, text: lines.join('\n'), selection: { start: map(sel.start), end: map(sel.end) } };
}
