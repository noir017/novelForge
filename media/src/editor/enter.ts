/**
 * 回车。纯函数只算「把哪一段换成什么、之后选区落在哪」，由 {@link installEnter} 挂的按键处理函数
 * 交给 `Pane.applyEdit`——一次回车一步撤销。
 *
 * ## 正文（`isProse`：章节与草稿）
 *
 * 按工程的分段格式另起一段：空行分段插 `\n\n`，段首缩进插 `\n` + 两个全角空格，缩进加空行插
 * `\n\n` + 两个全角空格（`paragraphBreak`）。有选区先替换选区；光标后面紧跟的空白删掉（新段开头不留空格）。
 *
 * - 这一行只有空白 / 缩进：只换行、不加缩进，并清掉这一行的空白——连按回车不会堆出一串只有缩进的行。
 * - 光标在段首（或段首的缩进里）：这一段整个往下推一行、格式原样，光标仍停在这一段的字前面。
 * - 标题行（`#` 开头）后面回车与段落一样：插段分隔，下一行是正文的一段（缩进的格式就带缩进）——与
 *   「一键排版」排出来的样子一致（标题与第一段之间也是段间隔）。
 * - `Shift+Enter` 只插 `\n`：诗、信、短句排列用。
 *
 * ## 非正文
 *
 * - Markdown（`.md` / `.markdown`）：新行沿用这一行行首的空白；列表接着写（`- ` / `* ` / `+ ` 照抄，
 *   `1. ` / `1) ` 递增），在空的列表项上回车就去掉标记、结束列表（那一行变成空行，不再往下加一行）。
 * - json / yml / 其他：只沿用缩进。
 */
import type { ParagraphStyle } from '../protocol';
import { paragraphBreak } from '../protocol';
import { addKeyHandler, isProse } from './api';
import type { TextSelection } from './history';
import { paragraphStyle } from './paragraphState';

/** 一次回车要做的替换，参数与 `Pane.applyEdit` 一一对应。 */
export interface EnterEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

/** 哪些文件按 Markdown 处理（列表接续）。与 `pane.ts` 判「能不能预览」是同一个口径。 */
export const MARKDOWN_RE = /\.(md|markdown)$/i;

const caret = (at: number): TextSelection => ({ start: at, end: at });

/** `pos` 所在行的行首。 */
export function lineStartOf(value: string, pos: number): number {
  return pos <= 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1;
}

/** `pos` 所在行的行尾（不含换行）。 */
export function lineEndOf(value: string, pos: number): number {
  const nl = value.indexOf('\n', pos);
  return nl === -1 ? value.length : nl;
}

/** 行内空白：半角空格、制表符、全角空格、不换行空格。 */
const INLINE_SPACE = /^[ \t　 ]*/;

const isBlank = (s: string) => s.trim() === '';

/** 正文里的回车（规则见文件头）。 */
export function proseEnter(value: string, sel: TextSelection, style: ParagraphStyle): EnterEdit {
  const lineStart = lineStartOf(value, sel.start);
  const lineEnd = lineEndOf(value, sel.end);
  const head = value.slice(lineStart, sel.start);
  const tail = value.slice(sel.end, lineEnd);
  if (isBlank(head) && isBlank(tail)) {
    // 这一行只有空白：只换行、不加缩进，顺手清掉这一行的空白。
    return { start: lineStart, end: lineEnd, text: '\n', selection: caret(lineStart + 1) };
  }
  if (isBlank(head)) {
    // 光标在段首或段首的缩进里：整段往下推一行，光标停在字前面。
    const line = head + tail;
    const lead = INLINE_SPACE.exec(line)![0].length;
    return { start: lineStart, end: lineEnd, text: `\n${line}`, selection: caret(lineStart + 1 + lead) };
  }
  const skip = INLINE_SPACE.exec(tail)![0].length;
  const br = paragraphBreak(style);
  return { start: sel.start, end: sel.end + skip, text: br, selection: caret(sel.start + br.length) };
}

const BULLET = /^([ \t]*)([-*+])([ \t]+)/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/;
/** 分隔线（`---`、`* * *`）不是列表项。 */
const RULE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;

/** Markdown 里的回车：列表接着写，空的列表项结束列表，其余沿用缩进。 */
export function markdownEnter(value: string, sel: TextSelection): EnterEdit {
  const lineStart = lineStartOf(value, sel.start);
  const lineEnd = lineEndOf(value, sel.end);
  const head = value.slice(lineStart, sel.start);
  const tail = value.slice(sel.end, lineEnd);
  if (!RULE.test(head + tail)) {
    const ordered = ORDERED.exec(head);
    const bullet = ordered ? null : BULLET.exec(head);
    const m = ordered ?? bullet;
    if (m) {
      const rest = head.slice(m[0].length) + tail;
      if (isBlank(rest)) {
        // 空的列表项：去掉标记、结束列表。
        return { start: lineStart, end: lineEnd, text: '', selection: caret(lineStart) };
      }
      const marker = ordered
        ? `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}${ordered[4]}`
        : `${bullet![1]}${bullet![2]}${bullet![3]}`;
      const text = `\n${marker}`;
      return { start: sel.start, end: sel.end, text, selection: caret(sel.start + text.length) };
    }
  }
  return plainEnter(value, sel);
}

/** 其余文件的回车：新行沿用这一行行首的空白（光标在缩进中间时只沿用光标前那一截）。 */
export function plainEnter(value: string, sel: TextSelection): EnterEdit {
  const head = value.slice(lineStartOf(value, sel.start), sel.start);
  const text = `\n${INLINE_SPACE.exec(head)![0]}`;
  return { start: sel.start, end: sel.end, text, selection: caret(sel.start + text.length) };
}

/** 挂回车的按键处理函数。`Ctrl/Cmd+Enter`（另起一段）在 `lines.ts`，这里不接。 */
export function installEnter(): void {
  addKeyHandler((e, { pane, file, area }) => {
    if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) {
      return false;
    }
    const sel = { start: area.selectionStart, end: area.selectionEnd };
    let edit: EnterEdit;
    if (isProse(file)) {
      edit = e.shiftKey
        ? { start: sel.start, end: sel.end, text: '\n', selection: caret(sel.start + 1) }
        : proseEnter(area.value, sel, paragraphStyle());
    } else if (e.shiftKey) {
      // 非正文的 Shift+Enter 交给浏览器（就是插一个换行）。
      return false;
    } else {
      edit = MARKDOWN_RE.test(file.path) ? markdownEnter(area.value, sel) : plainEnter(area.value, sel);
    }
    pane.applyEdit(edit.start, edit.end, edit.text, edit.selection);
    return true;
  });
}
