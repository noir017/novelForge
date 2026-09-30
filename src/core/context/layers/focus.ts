import { plotOfTarget, CreationTarget } from '../../model/pipeline';
import { Plot, isPlotFilled, parsePlotFileName } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Chapter } from '../../model/types';
import { BuildRequest, LayerId, LayerSpec } from '../types';
import { basename } from 'node:path';

/** 写/改某一章时，前后各带几章**细纲**。摘要不受这个数限制（它便宜得多）。 */
export const PREV_PLOTS = 3;
export const NEXT_PLOTS = 1;
/**
 * 写正文时往后看几章的细纲（边界）。移植自 AI-Novel-Writer 的「后续章节大纲预告」
 * （GD:464-466：`chapterNumber > N && chapterNumber <= N + 5`）——按章号算窗口，
 * 不是「后面排过的五章」：第 N+9 章的事离这一章太远，写进边界只会让模型分心。
 */
export const AHEAD_PLOTS = 5;

/**
 * 一章在装配器眼里的样子：细纲与正文各有可能缺席。
 *
 * 必须两边都带，否则老工程（只有 `chapters/`）装配出来的上下文是空的——
 * 「前面发生了什么」全靠 `chapter`，「这一章打算写什么」全靠 `plot`。
 */
export interface ChapterRef {
  no: number;
  title: string;
  /** 细纲。老工程里那些从没规划过的章没有。 */
  plot?: Plot;
  /** 正文。还没写的章没有。 */
  chapter?: Chapter;
}

/** 一章正文的纯文本（不含 `# 标题` 行）。 */
export interface ChapterText {
  relPath: string;
  text: string;
  wordCount: number;
  contentHash: string;
}

/** 这一次装配围绕哪个产物转。 */
export interface Focus {
  target: CreationTarget;
  /** 目标章的细纲。尚未落盘时为 undefined（正要写全书的下一章）。 */
  plot?: Plot;
  /** 「前文」的边界章号。架构与大纲阶段为 +∞，即全书都算前文。 */
  no: number;
  /** 这一章之前的全部章，按章号升序。 */
  previous: ChapterRef[];
  /** 紧邻的前几章（`plotPrev` 用），按章号升序。 */
  prevPlots: ChapterRef[];
  /** 紧邻的后一章（`plotNext` 用）。它已经排好时，本章的收尾要接得上它的开头。 */
  nextPlots: ChapterRef[];
  /** 后 {@link AHEAD_PLOTS} 章里排过细纲的（`plotAhead` 用），按章号升序。 */
  aheadPlots: ChapterRef[];
  /** 目标章自己的正文（「接着写」要从它的末尾往下接）。还没写时缺席。 */
  chapter?: Chapter;
}

/** 按配方只读用得上的文件。 */
export async function resolveFocus(
  project: NovelProject,
  request: BuildRequest,
  recipe: LayerSpec[]
): Promise<Focus> {
  const wants = (id: LayerId): boolean => recipe.some((s) => s.layer === id);
  const target = request.target;
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);

  // 两边按章号并起来（细纲号 = 章号）。老工程只有右边，新规划的章只有左边，
  // 正常走完流水线的章两边都有。
  const byNo = new Map<number, ChapterRef>();
  for (const chapter of chapters) {
    if (!byNo.has(chapter.order)) {
      byNo.set(chapter.order, { no: chapter.order, title: chapter.title, chapter });
    }
  }
  for (const plot of plots) {
    const found = byNo.get(plot.no);
    if (found?.plot) {
      continue; // 撞号时认路径排序第一份，与 views/pipeline.ts 同一条规则。
    }
    byNo.set(plot.no, {
      no: plot.no,
      // 细纲的标题优先：它是作者在流水线里给的那个名字。
      title: plot.title || found?.title || '',
      plot,
      chapter: found?.chapter,
    });
  }
  const all = [...byNo.values()].sort((a, b) => a.no - b.no);

  const plotRelPath = plotOfTarget(target);
  // 路径上没有就按章号认同号那份（与 `NovelProject.resolvePlot` 同一条规则）：主按钮
  // 给的落点可能是纯序号的占位路径，而细纲已经按标题落成了 `003-雪夜.md`——认不出的话，
  // 写正文时本章细纲那一层（P0 force）就空着。
  const pathNo = plotRelPath ? parsePlotFileName(basename(plotRelPath))?.no : undefined;
  const plot = plotRelPath
    ? (plots.find((p) => p.relPath === plotRelPath) ?? (pathNo !== undefined ? plots.find((p) => p.no === pathNo) : undefined))
    : undefined;

  // 细纲批次（给了区间）：前文的边界是区间第一章，后文从区间最后一章之后算起——
  // 区间里那几章正是这一次要写的，既不是前文也不是后文。
  const range = target.kind === 'plot' ? request.range : undefined;
  const no =
    target.kind === 'outline' || target.kind === 'setting'
      ? Number.POSITIVE_INFINITY
      : (range?.from ??
        plot?.no ??
        // 细纲还没落盘时按路径里的章号定位——老工程选中某一章、拆细纲给下一章
        // 找落点都是这条路。
        (plotRelPath ? parsePlotFileName(basename(plotRelPath))?.no : undefined) ??
        request.targetNo ??
        Number.POSITIVE_INFINITY);
  const previous = all.filter((c) => c.no < no);
  // 后文只在这一章确实有定位时才有意义：`no` 是 +∞ 时「后面」是空的。
  const last = range?.to ?? no;
  const following = Number.isFinite(last) ? all.filter((c) => c.no > last) : [];

  return {
    target,
    plot,
    no,
    previous,
    // 「上文」只在有细纲时才有内容可带（那一层渲染的是细纲的小节）。
    prevPlots: wants('plotPrev') ? previous.filter((c) => c.plot).slice(-PREV_PLOTS) : [],
    nextPlots: wants('plotNext') ? following.filter((c) => c.plot).slice(0, NEXT_PLOTS) : [],
    aheadPlots: wants('plotAhead')
      ? following.filter((c) => c.no <= last + AHEAD_PLOTS && c.plot && isPlotFilled(c.plot.sections))
      : [],
    chapter: Number.isFinite(no) ? byNo.get(no)?.chapter : undefined,
  };
}

/**
 * 某一章的正文。没写过（或是空文件）就是 undefined。
 *
 * 一章一纲之后正文只在 `chapters/` 一处——从前还要回落到中转站 `manuscripts/`。
 */
export async function readChapterText(
  project: NovelProject,
  ref: ChapterRef
): Promise<ChapterText | undefined> {
  if (!ref.chapter) {
    return undefined;
  }
  const text = await project.readChapterText(ref.chapter);
  return text.trim()
    ? {
        relPath: ref.chapter.relPath,
        text,
        wordCount: ref.chapter.wordCount,
        contentHash: ref.chapter.contentHash,
      }
    : undefined;
}

/**
 * 前一章的正文。写正文时要从它的结尾无缝接下去。
 *
 * 单独一个函数而不是塞进 `Focus`：`prevTail` 与 `manuscriptFull` 两层都要读
 * 正文，而多数装配（讨论、排细纲）一份都不读——放进 focus 等于每次装配
 * 都多读几个几千字的文件。
 */
export async function readPrevManuscript(
  project: NovelProject,
  focus: Focus
): Promise<ChapterText | undefined> {
  const prev = focus.previous[focus.previous.length - 1];
  return prev ? readChapterText(project, prev) : undefined;
}
