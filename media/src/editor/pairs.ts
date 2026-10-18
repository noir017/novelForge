/**
 * 成对符号自动补全（正文与 Markdown；json / yml 等不做）。
 *
 * 对：“” ‘’ 「」 『』 （） 《》 【】 〈〉。半角括号不做——正文里它们多半是英文、公式或作者有意用的半角。
 *
 * ## 为什么挂在 `onEditorChange` 上，而不是 keydown
 *
 * 中文标点几乎都是输入法打出来的：拼音输入法里按 `"`，有的直接上屏（一条 `insertText`），有的走一遍组字
 * （`compositionend` 才上屏），keydown 里根本看不到「“」这个字。所以只认 `onEditorChange` 里**带 `change`**
 * 的那一下（`typing` 或 `composition`）：用户刚刚确实往编辑区里放了什么、替换掉了什么，都在里面。
 *
 * ## 四条
 *
 * 1. 敲出左半边 → 在后面补右半边，光标停在中间。补的那一下 `join: true` 并进那次输入：一次撤销两个一起退。
 *    只在光标后面是行尾、空白或收尾的标点时补——后面紧跟着正文时补上去，作者还得回头删（⚑）。
 * 2. 有选区时敲左半边 → 把选中的字包起来（`change.removed` 就是被替换掉的那段，输入法上屏时也拿得到），
 *    之后选中被包的那段。
 * 3. 紧挨着一个**自动补上**的右半边再敲同一个右半边 → 跳过，不重复。中文输入法常自己交替出 “ ”：
 *    补完 ” 之后作者照习惯再按一次 `"`，输入法给的正是 ”，这一条把它吸收掉。
 * 4. 刚补完、中间还空着就退格删左半边 → 右半边一起删。
 *
 * 「自动补上的」按文件记（每份打开的文件一张小表），每一处改动都把记着的位置跟着挪；改动碰到了那两个字、
 * 撤销 / 重做、开关关掉，记录就作废——宁可少跳过一次，也不删错字。
 */
import { isProse, onEditorChange } from './api';
import type { EditorEvent, OpenFile, Pane, TextChange } from './api';
import { MARKDOWN_RE } from './enter';
import { autoPairEnabled, onPrefsChange } from './paragraphState';

/** 左半边 → 右半边。 */
export const PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
  '（': '）',
  '《': '》',
  '【': '】',
  '〈': '〉',
};

const RIGHTS = new Set(Object.values(PAIRS));

/** 光标后面紧跟这些（或行尾、文末）时才补右半边。 */
const CLOSE_BEFORE = /[\s，。、；：？！…—）」』”’》】〉,.;:?!)\]}]/;

/** 光标后面是 `next` 时补不补右半边。 */
export function shouldAutoClose(next: string | undefined): boolean {
  return next === undefined || next === '' || CLOSE_BEFORE.test(next);
}

/** 一对自动补上的符号：两个字各在哪（按这份文件当下的文字算）。 */
export interface AutoPair {
  left: number;
  right: number;
  open: string;
  close: string;
}

/** 一份文件最多记几对。 */
const MAX_PAIRS = 32;

/**
 * 一处改动之后这一对挪到哪。改动碰到了左右两个字之一就作废（undefined）。
 * 纯插入时插在某个字之前（含同一个位置）的把它往后推；删除 / 替换时落在被删那段之后的往前挪。
 */
export function mapPair(p: AutoPair, c: TextChange): AutoPair | undefined {
  const end = c.at + c.removed.length;
  const delta = c.inserted.length - c.removed.length;
  const hit = (pos: number) => c.removed.length > 0 && pos >= c.at && pos < end;
  if (hit(p.left) || hit(p.right)) {
    return undefined;
  }
  const from = c.removed.length === 0 ? c.at : end;
  const move = (pos: number) => (pos >= from ? pos + delta : pos);
  return { ...p, left: move(p.left), right: move(p.right) };
}

/** 哪些文件做成对补全：正文（不论扩展名）与 Markdown。 */
function applies(file: OpenFile): boolean {
  return isProse(file) || MARKDOWN_RE.test(file.path);
}

let tracked = new WeakMap<OpenFile, AutoPair[]>();

function pairsOf(file: OpenFile): AutoPair[] {
  return tracked.get(file) ?? [];
}

function setPairs(file: OpenFile, pairs: (AutoPair | undefined)[]): void {
  const kept = pairs.filter((p): p is AutoPair => !!p).slice(-MAX_PAIRS);
  if (kept.length > 0) {
    tracked.set(file, kept);
  } else {
    tracked.delete(file);
  }
}

const mapAll = (pairs: AutoPair[], c: TextChange) => pairs.map((p) => mapPair(p, c));

export function installPairs(): void {
  /** 自己调 `applyEdit` 的那一下：它也会发 `edit`，记录由这里手动挪，不再走一遍。 */
  let applying = false;

  onPrefsChange(() => {
    if (!autoPairEnabled()) {
      tracked = new WeakMap();
    }
  });

  onEditorChange((ev) => {
    if (ev.type !== 'edit' || applying) {
      return;
    }
    handle(ev);
  });

  function apply(pane: Pane, start: number, end: number, text: string, sel: { start: number; end: number }): void {
    applying = true;
    try {
      pane.applyEdit(start, end, text, sel, { join: true });
    } finally {
      applying = false;
    }
  }

  function handle(ev: Extract<EditorEvent, { type: 'edit' }>): void {
    const { pane, file, source, change } = ev;
    if (!change) {
      // 撤销 / 重做一次可能退好几处，位置对不上了。组字中途也不带 change，那时不动（上屏那一下才算）。
      if (source === 'undo' || source === 'redo') {
        tracked.delete(file);
      }
      return;
    }
    const pairs = pairsOf(file);
    const live =
      autoPairEnabled() &&
      applies(file) &&
      pane.activeFile() === file &&
      (source === 'typing' || source === 'composition');
    if (live && (skipClose(pane, file, change, pairs) || deletePair(pane, file, change, pairs) || open(pane, file, change, pairs, source))) {
      return;
    }
    if (pairs.length > 0) {
      setPairs(file, mapAll(pairs, change));
    }
  }

  /** 第 3 条：紧挨着自动补上的右半边又敲了同一个右半边。 */
  function skipClose(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[]): boolean {
    if (c.removed !== '' || c.inserted.length !== 1 || !RIGHTS.has(c.inserted)) {
      return false;
    }
    // 敲进去的字落在 c.at，原来那个自动补的右半边被推到了 c.at + 1。
    const hit = pairs.find((p) => p.right === c.at && p.close === c.inserted && file.draft[c.at + 1] === p.close);
    if (!hit) {
      return false;
    }
    const others = mapAll(
      pairs.filter((p) => p !== hit),
      c
    ).filter((p): p is AutoPair => !!p);
    apply(pane, c.at + 1, c.at + 2, '', { start: c.at + 1, end: c.at + 1 });
    setPairs(file, mapAll(others, { at: c.at + 1, removed: hit.close, inserted: '' }));
    return true;
  }

  /** 第 4 条：中间还空着，退格删了左半边。 */
  function deletePair(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[]): boolean {
    if (c.inserted !== '' || c.removed.length !== 1 || !PAIRS[c.removed]) {
      return false;
    }
    // 左半边删掉之后，右半边落在 c.at。
    const hit = pairs.find(
      (p) => p.left === c.at && p.right === c.at + 1 && p.open === c.removed && file.draft[c.at] === p.close
    );
    if (!hit) {
      return false;
    }
    const others = mapAll(
      pairs.filter((p) => p !== hit),
      c
    ).filter((p): p is AutoPair => !!p);
    apply(pane, c.at, c.at + 1, '', { start: c.at, end: c.at });
    setPairs(file, mapAll(others, { at: c.at, removed: hit.close, inserted: '' }));
    return true;
  }

  /** 第 1、2 条：敲出了左半边（键盘一下一个字；输入法上屏可能连着别的字，看最后一个）。 */
  function open(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[], source: string): boolean {
    const typed = c.inserted[c.inserted.length - 1];
    const close = typed ? PAIRS[typed] : undefined;
    if (!close || (c.inserted.length !== 1 && source !== 'composition')) {
      return false;
    }
    const pos = c.at + c.inserted.length;
    const moved = mapAll(pairs, c).filter((p): p is AutoPair => !!p);
    if (c.removed !== '' && c.inserted.length === 1) {
      // 有选区：包起来，选中被包的那段。
      const text = c.removed + close;
      apply(pane, pos, pos, text, { start: pos, end: pos + c.removed.length });
      setPairs(file, [
        ...mapAll(moved, { at: pos, removed: '', inserted: text }),
        { left: pos - 1, right: pos + c.removed.length, open: typed, close },
      ]);
      return true;
    }
    if (!shouldAutoClose(file.draft[pos])) {
      return false;
    }
    apply(pane, pos, pos, close, { start: pos, end: pos });
    setPairs(file, [
      ...mapAll(moved, { at: pos, removed: '', inserted: close }),
      { left: pos - 1, right: pos, open: typed, close },
    ]);
    return true;
  }
}
