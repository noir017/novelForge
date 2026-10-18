/**
 * 一键排版与半角标点转全角（只对正文）。排什么样由 core 的纯函数说了算（`model/paragraphFormat.ts` 的
 * `layoutProse` / `fullWidthPunct`），这里只管：处理哪一段、交给 `Pane.applyEdit`（一步撤销）、光标落回哪、
 * 报一句改了几处。
 *
 * - **范围**：有选区只处理选区碰到的那几行（排版时再收到首尾的非空行上，免得把选区边上的段间隔吃掉），
 *   否则整份。
 * - **入口**：工具栏「排版」按钮（只对正文显示，挨着「预览」）；标题栏「编辑 → 一键排版 / 半角标点转全角」
 *   （`nf-paragraph-command`）。
 *
 * 「排版」按钮不写进 `page.ts` / `createPaneElements`：它只对正文出现，显隐跟着当前文件走，由这里在每块
 * 编辑区第一次重画时插到「预览」后面——两块编辑区（主区与草稿区）走同一条路，pane.ts 不必知道它。
 */
import { el } from '../dom';
import { toast } from '../globals';
import { fullWidthPunct, layoutProse } from '../protocol';
import { isProse, onEditorChange } from './api';
import type { EditorContext, Pane } from './api';
import type { TextSelection } from './history';
import { touchedLines } from './lines';
import { paragraphStyle } from './paragraphState';

/** 选区碰到的那几行的范围 `[from, to)`：第一行行首到最后一行行尾（不含换行）。 */
function lineSpan(value: string, sel: TextSelection): { from: number; to: number } {
  const { first, last } = touchedLines(value, sel);
  const lines = value.split('\n');
  let from = 0;
  for (let i = 0; i < first; i++) {
    from += lines[i].length + 1;
  }
  let to = from;
  for (let i = first; i <= last; i++) {
    to += lines[i].length + (i < last ? 1 : 0);
  }
  return { from, to };
}

/** 排版的范围：选区碰到的那几行，首尾的空行收掉。全是空行时 undefined。 */
export function layoutSpan(value: string, sel: TextSelection): { from: number; to: number } | undefined {
  const span = lineSpan(value, sel);
  const text = value.slice(span.from, span.to);
  const lead = /^\s*/.exec(text)![0];
  if (lead.length === text.length) {
    return undefined;
  }
  // 收到第一个非空行的行首、最后一个非空行的行尾。
  const from = span.from + (lead.lastIndexOf('\n') + 1);
  const trail = /\s*$/.exec(text)![0];
  const nl = trail.indexOf('\n');
  const to = span.to - (nl === -1 ? 0 : trail.length - nl);
  return { from, to };
}

/** 光标在第几段（非空行，从 0 数）的第几个字（去掉段首空白之后）。落在空行上算下一段的开头。 */
function blockPosition(text: string, caret: number): { index: number; offset: number } {
  let index = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (line.trim() !== '') {
      if (caret <= end) {
        const lead = /^\s*/.exec(line)![0].length;
        return { index, offset: Math.max(0, Math.min(caret - pos - lead, line.trim().length)) };
      }
      index++;
    } else if (caret <= end) {
      return { index, offset: 0 };
    }
    pos = end + 1;
  }
  return { index, offset: 0 };
}

/** 第 `index` 段第 `offset` 个字在 `text` 里的位置。段数不够时落在文末。 */
function positionOfBlock(text: string, index: number, offset: number): number {
  let n = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      if (n === index) {
        const lead = /^\s*/.exec(line)![0].length;
        return pos + lead + Math.min(offset, line.trim().length);
      }
      n++;
    }
    pos += line.length + 1;
  }
  return text.length;
}

/** 一键排版（规则见 `layoutProse`）。 */
export function formatProseIn({ pane, file, area }: EditorContext): void {
  if (!isProse(file)) {
    toast('一键排版只对正文（章节与草稿）有用。', true);
    return;
  }
  const value = area.value;
  const sel = { start: area.selectionStart, end: area.selectionEnd };
  const style = paragraphStyle();
  if (sel.start !== sel.end) {
    const span = layoutSpan(value, sel);
    if (!span) {
      toast('选中的都是空行，没有可排的。');
      return;
    }
    const old = value.slice(span.from, span.to);
    const res = layoutProse(old, style, { fragment: true });
    finish(res.text === old, res.changes, () =>
      pane.applyEdit(span.from, span.to, res.text, { start: span.from, end: span.from + res.text.length })
    );
    return;
  }
  const res = layoutProse(value, style);
  const at = blockPosition(value, sel.start);
  const caret = positionOfBlock(res.text, at.index, at.offset);
  finish(res.text === value, res.changes, () =>
    pane.applyEdit(0, value.length, res.text, { start: caret, end: caret })
  );
}

function finish(same: boolean, changes: number, apply: () => void): void {
  if (same) {
    toast('已经是这个格式了');
    return;
  }
  apply();
  toast(`排版完成，改了 ${Math.max(1, changes)} 处`);
}

/** 半角标点转全角（规则见 `fullWidthPunct`）。 */
export function fullWidthIn({ pane, file, area }: EditorContext): void {
  if (!isProse(file)) {
    toast('半角标点转全角只对正文（章节与草稿）有用。', true);
    return;
  }
  const value = area.value;
  const sel = { start: area.selectionStart, end: area.selectionEnd };
  const span = sel.start !== sel.end ? lineSpan(value, sel) : undefined;
  const res = fullWidthPunct(value, span ? { range: { start: span.from, end: span.to } } : {});
  if (res.changes === 0) {
    toast('没有要转的半角标点。');
    return;
  }
  /** 原文里的位置挪到新文字里：之前的每一处替换带来的长短差都算上。 */
  const map = (p: number) =>
    p + res.edits.filter((e) => e.at + e.from.length <= p).reduce((n, e) => n + e.to.length - e.from.length, 0);
  const selection = span ? { start: map(span.from), end: map(span.to) } : { start: map(sel.start), end: map(sel.start) };
  pane.applyEdit(0, value.length, res.text, selection);
  toast(`半角标点转全角：改了 ${res.changes} 处`);
}

/** 工具栏「排版」按钮：每块编辑区一颗，第一次重画时插到「预览」后面，只对正文显示。 */
export function installLayoutButton(): void {
  const buttons = new WeakMap<Pane, HTMLButtonElement>();
  onEditorChange((ev) => {
    if (ev.type !== 'render') {
      return;
    }
    const pane = ev.pane;
    let btn = buttons.get(pane);
    if (!btn) {
      const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
      if (!toolbar) {
        return;
      }
      btn = el('button', 'chip-btn ed-format-btn', '排版');
      btn.type = 'button';
      btn.title = '一键排版：按工程的分段格式重排正文（有选区只排选中的那几行）';
      btn.addEventListener('click', () => {
        const file = pane.activeFile();
        if (file) {
          formatProseIn({ pane, file, area: pane.area });
        }
      });
      // 「预览」紧跟在路径后面（page.ts 与 createPaneElements 同一个顺序）。
      const preview = toolbar.querySelector('.ed-path')?.nextElementSibling ?? null;
      toolbar.insertBefore(btn, preview ? preview.nextSibling : toolbar.firstChild);
      buttons.set(pane, btn);
    }
    btn.classList.toggle('hidden', !isProse(pane.activeFile()));
  });
}
