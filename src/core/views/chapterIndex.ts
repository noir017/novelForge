/**
 * 内置编辑器的章节索引（`chapterIndex` 消息）：章节条与上一章 / 下一章要的那几个字段。
 *
 * 与工程树里章节那一行（`ProjectPlotNode`）**由同一个函数算**——`projectView.ts` 在它上面再加定稿、
 * 草稿、⟳ 那几项。两处各写一份的话，章节条上说的「待定稿 · 2980 / 3000 字」迟早会与工程页对不上。
 *
 * 数据来自流水线索引（`buildPipelineIndex`）：controller 每次 `pushState` 构建 `ViewState` 时本来就要
 * 跑这一趟（目标下拉框），章节索引只是从同一份 rows 里多投影几个字段，不多读一次盘。
 */
import { chapterLabel } from '../model/pipeline';
import type { ChapterIndexEntry } from '../protocol';
import type { PlotPipeline } from './pipeline';

/** 一章的那一行。 */
export function chapterIndexEntryOf(p: PlotPipeline): ChapterIndexEntry {
  const chapterPath = p.chapter.relPath;
  return {
    no: p.no,
    label: chapterLabel(p.no, p.title),
    title: p.title,
    relPath: chapterPath || p.plot.relPath,
    plotPath: p.plot.relPath,
    plotExists: p.plot.exists,
    chapterPath,
    wordCount: p.chapter.words,
    targetWords: p.chapter.targetWords,
    stage: p.stage,
  };
}

/** 全书的章节索引，按章号升序（流水线索引本来就是升序）。 */
export function chapterIndexOf(rows: readonly PlotPipeline[]): ChapterIndexEntry[] {
  return rows.map(chapterIndexEntryOf);
}
