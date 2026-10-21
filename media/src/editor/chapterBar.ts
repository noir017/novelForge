/**
 * 章节条（W6 章节工作台）：编辑区里正开着某一章的正文或细纲时，主区顶上一条——
 * 「‹ 上一章 · 第 3 章《夜访》 · 待写正文 · 1860 / 3000 字 · 下一章 ›」，外加对这一章能做的几件事。
 *
 * ## 为什么在编辑器里
 *
 * 并排看着细纲改正文时，下一步（写这一章、接着写、定稿）从前得切回对话页去按主按钮。
 * 按钮放在正在看的东西旁边，才叫工作台。点下去走的仍是主按钮那一条路（后端
 * `chapterAction`）：生成照样在对话页流式输出、照样当场问写不写（第 19 条）。
 *
 * ## 数据从哪来
 *
 * 章节索引（`chapterIndex.ts`，后端 `chapterIndex` 消息）：每一章的状态、字数、目标字数、两份文件的路径，
 * **哪个页签都推**、内容变了才推。从前只吃工程树（`project` 消息），而那棵树只在「工程」页签开着时才推——
 * 作者待在对话页时条上的数是旧的。当下是哪一章，看编辑器广播的「正在编辑哪个文件」（`nf-editor-active`）。
 *
 * ## 按钮
 *
 * 四颗按这一章的状态亮灭：「写这一章」只在细纲排好、还没有正文时亮；「接着写」「重写」
 * 要这一章已经有正文；「定稿」也要有正文。提示里写调用次数，与主按钮同一个数（D16）。
 * 另一份没开着时给「并排看细纲 / 并排看正文」。「审稿」（五期）要有正文：只出报告、不写文件，
 * 报告出在对话页，勾选之后按勾选的条目修稿。「‹ 上一章」「下一章 ›」见 `chapterNav.ts`，到头了禁用。
 */
import { el } from '../dom';
import { FINALIZE_CALLS, PLOT_STAGE_LABEL, REVIEW_CALLS, WRITE_CALLS, describeCalls } from '../protocol';
import type { ChapterAction, ChapterIndexEntry, InMessage } from '../protocol';
import { SIDE_LABEL, onChapterIndex, pathOn } from './chapterIndex';
import { goChapter, neighborsOf } from './chapterNav';
import { shortcutLabel } from './shortcuts';
import { paneOwning } from './store';

/** 挂到主区上方（标签栏与工具栏之间）。 */
export function installChapterBar(stage: HTMLElement, post: (msg: InMessage) => void): void {
  const bar = el('div', 'ed-chapter-bar hidden');
  bar.id = 'edChapterBar';
  stage.insertBefore(bar, stage.querySelector('.ed-toolbar'));
  // 条上说的是「当前那份文件」那一章，而它可能开在右侧那一块：在条上按下去不该把「当前这一块」抢到左侧来
  // （主区根节点上的 pointerdown / focusin 会认领）——不然按钮刚按下条就换成了左侧那一章，点击落空。
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('focusin', (e) => e.stopPropagation());

  let active: string | null = null;

  onChapterIndex(render);
  window.addEventListener('nf-editor-active', (e) => {
    active = e.detail.path;
    render();
  });

  function render(): void {
    const around = neighborsOf(active);
    bar.replaceChildren();
    bar.classList.toggle('hidden', !around);
    if (!around) {
      return;
    }
    const row = around.entry;
    bar.appendChild(navButton(-1, around.prev, around.side));

    const written = !!row.chapterPath && row.wordCount > 0;
    const words = written
      ? row.targetWords
        ? `${row.wordCount} / ${row.targetWords} 字`
        : `${row.wordCount} 字`
      : '还没有正文';
    const info = el('span', 'ed-chapter-info', `${row.label} · ${PLOT_STAGE_LABEL[row.stage]} · ${words}`);
    bar.appendChild(info);
    bar.appendChild(navButton(1, around.next, around.side));

    const actions = el('span', 'ed-chapter-actions');
    const plotReady = row.plotExists && row.stage !== 'plot';
    actions.appendChild(
      button('写这一章', 'write', plotReady && !written, plotReady ? describeCalls(WRITE_CALLS) : '先把这一章的细纲排好')
    );
    actions.appendChild(button('接着写', 'continue', written, `从末尾往下写，新写的追加在后面。${describeCalls(WRITE_CALLS)}`));
    actions.appendChild(
      button('重写', 'rewrite', written && row.plotExists, `照细纲整章重写，写入前会让你先对比。${describeCalls(WRITE_CALLS)}`)
    );
    actions.appendChild(
      button('审稿', 'review', written, `逐条引原文挑出这一章的问题，逐项核对细纲的关键事件；只出报告，不改文件。${describeCalls(REVIEW_CALLS)}`)
    );
    actions.appendChild(
      button('定稿', 'finalize', written, `照正文更新细纲（带连续性事实），再更新出场角色的当前状态、认这一章在叙事线上发生了什么（带原文证据记下事件、更新各条线的当前进度，正文里新长出来的线也认出来）。${describeCalls(FINALIZE_CALLS)}`)
    );

    // 另一份没开着：给一颗把它并排打开的按钮。
    const onChapter = around.side === 'chapter';
    const other = onChapter ? (row.plotExists ? row.plotPath : '') : row.chapterPath;
    if (other && !paneOwning(other)) {
      const pair = el('button', 'chip-btn ed-chapter-pair', onChapter ? '并排看细纲' : '并排看正文');
      pair.addEventListener('click', () =>
        post({ type: 'openEditor', path: other, pane: onChapter ? 'draft' : 'main' })
      );
      actions.appendChild(pair);
    }
    bar.appendChild(actions);

    function button(text: string, action: ChapterAction, enabled: boolean, hint: string): HTMLButtonElement {
      const b = el('button', 'chip-btn', text);
      b.dataset.action = action;
      b.disabled = !enabled;
      b.title = hint;
      b.addEventListener('click', () => post({ type: 'chapterAction', plotRelPath: row.relPath, action }));
      return b;
    }
  }
}

/** 「‹ 上一章」「下一章 ›」。到头了禁用；相邻那一章还没有这一面时照样能点（点了说一句），提示里先写明。 */
function navButton(step: -1 | 1, to: ChapterIndexEntry | undefined, side: 'chapter' | 'plot'): HTMLButtonElement {
  const b = el('button', 'chip-btn ed-chapter-nav', step < 0 ? '‹ 上一章' : '下一章 ›');
  b.dataset.nav = step < 0 ? 'prev' : 'next';
  const key = shortcutLabel(step < 0 ? 'prevChapter' : 'nextChapter');
  b.disabled = !to;
  b.title = !to
    ? step < 0
      ? '已经是第一章了'
      : '已经是最后一章了'
    : pathOn(to, side)
      ? `${to.label}的${SIDE_LABEL[side]}（${key}）`
      : `${to.label}还没有${SIDE_LABEL[side]}（${key}）`;
  b.addEventListener('click', () => goChapter(step));
  return b;
}
