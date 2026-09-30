/**
 * 章节条（W6 章节工作台）：编辑区里正开着某一章的正文或细纲时，主区顶上一条——
 * 「第 3 章《夜访》 · 待写正文 · 1860 / 3000 字」，外加对这一章能做的几件事。
 *
 * ## 为什么在编辑器里
 *
 * 并排看着细纲改正文时，下一步（写这一章、接着写、定稿）从前得切回对话页去按主按钮。
 * 按钮放在正在看的东西旁边，才叫工作台。点下去走的仍是主按钮那一条路（后端
 * `chapterAction`）：生成照样在对话页流式输出、照样当场问写不写（第 19 条）。
 *
 * ## 数据从哪来
 *
 * **不新增推送**：工程树（`project` 消息）本来就带着每一章的状态、字数、两份文件的路径。
 * 当下是哪一章，看编辑器广播的「正在编辑哪个文件」（`nf-editor-active`）。两样一拼就够。
 *
 * ## 按钮
 *
 * 四颗按这一章的状态亮灭：「写这一章」只在细纲排好、还没有正文时亮；「接着写」「重写」
 * 要这一章已经有正文；「定稿」也要有正文。提示里写调用次数，与主按钮同一个数（D16）。
 * 另一份没开着时给「并排看细纲 / 并排看正文」。审稿按钮是五期的事。
 */
import { el } from '../dom';
import { FINALIZE_CALLS, PLOT_STAGE_LABEL, WRITE_CALLS, describeCalls } from '../protocol';
import type { ChapterAction, InMessage, ProjectPlotNode } from '../protocol';
import { onMessage } from '../vscodeApi';
import { paneOwning } from './store';

/** 挂到主区上方（标签栏与工具栏之间）。 */
export function installChapterBar(stage: HTMLElement, post: (msg: InMessage) => void): void {
  const bar = el('div', 'ed-chapter-bar hidden');
  bar.id = 'edChapterBar';
  stage.insertBefore(bar, stage.querySelector('.ed-toolbar'));

  let plots: ProjectPlotNode[] = [];
  let active: string | null = null;

  onMessage((msg) => {
    if (msg.type === 'project') {
      plots = msg.tree.plots;
      render();
    }
  });
  window.addEventListener('nf-editor-active', (e) => {
    active = e.detail.path;
    render();
  });

  function render(): void {
    const row = active ? chapterOf(plots, active) : undefined;
    bar.replaceChildren();
    bar.classList.toggle('hidden', !row);
    if (!row) {
      return;
    }
    const written = !!row.chapterPath && row.wordCount > 0;
    const words = written
      ? row.targetWords
        ? `${row.wordCount} / ${row.targetWords} 字`
        : `${row.wordCount} 字`
      : '还没有正文';
    const info = el('span', 'ed-chapter-info', `${row.label} · ${PLOT_STAGE_LABEL[row.stage]} · ${words}`);
    bar.appendChild(info);

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
      button('定稿', 'finalize', written, `生成摘要与连续性事实，再更新出场角色的当前状态。${describeCalls(FINALIZE_CALLS)}`)
    );

    // 另一份没开着：给一颗把它并排打开的按钮。
    const onChapter = active === row.chapterPath;
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
      b.addEventListener('click', () => post({ type: 'chapterAction', plotRelPath: row!.relPath, action }));
      return b;
    }
  }
}

/** 这个路径是哪一章的正文或细纲。别的文件（角色卡、大纲、草稿）不算。 */
function chapterOf(plots: ProjectPlotNode[], path: string): ProjectPlotNode | undefined {
  return plots.find((p) => (p.chapterPath && p.chapterPath === path) || (p.plotExists && p.plotPath === path));
}
