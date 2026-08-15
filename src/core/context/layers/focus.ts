import { plotOfTarget, CreationTarget } from '../../model/pipeline';
import { Plot, parsePlotFileName } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Scene } from '../../model/sceneFile';
import { Chapter, Manuscript } from '../../model/types';
import { BuildRequest, LayerId, LayerSpec } from '../types';
import { basename } from 'node:path';

/** 写/改某一章时，前后各带几章**原文**。摘要不受这个数限制（它便宜得多）。 */
export const PREV_PLOTS = 3;
export const NEXT_PLOTS = 1;

/**
 * 一章在装配器眼里的样子：细纲与成品各有可能缺席。
 *
 * 必须两边都带，否则老工程（只有 `chapters/`）装配出来的上下文是空的——
 * 「前面发生了什么」全靠 `chapter`，「这一章打算写什么」全靠 `plot`。
 */
export interface ChapterRef {
  no: number;
  title: string;
  /** 细纲。老工程里那些从没规划过的章没有。 */
  plot?: Plot;
  /** 发布成品。还没拆分的章没有。 */
  chapter?: Chapter;
}

/** 这一次装配围绕哪个产物转。 */
export interface Focus {
  target: CreationTarget;
  /** 目标章的细纲。尚未落盘时为 undefined（正要写全书的下一章）。 */
  plot?: Plot;
  /** 「前文」的边界章号。全书大纲阶段为 +∞，即全书都算前文。 */
  no: number;
  /** 这一章之前的全部章，按章号升序。 */
  previous: ChapterRef[];
  /** 紧邻的前几章（`plotPrev` 用），按章号升序。 */
  prevPlots: ChapterRef[];
  /** 紧邻的后一章（`plotNext` 用）。它已经排好时，本章的收尾要接得上它的开头。 */
  nextPlots: ChapterRef[];
  /** 目标章的全部场景，按 no 升序。 */
  scenes: Scene[];
  /** 当前这一场。target 没指定场号时为 undefined。 */
  scene?: Scene;
  /** 场景 frontmatter 里写明的出场人物——角色卡据此精确取，不靠子串匹配。 */
  castNames: string[];
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

  // 两边按章号并起来。老工程只有右边，新规划的章只有左边，正常走完
  // 流水线的章两边都有。
  const byNo = new Map<number, ChapterRef>();
  for (const chapter of chapters) {
    byNo.set(chapter.order, { no: chapter.order, title: chapter.title, chapter });
  }
  for (const plot of plots) {
    const found = byNo.get(plot.no);
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
  const plot = plotRelPath ? plots.find((p) => p.relPath === plotRelPath) : undefined;

  const no =
    target.kind === 'outline'
      ? Number.POSITIVE_INFINITY
      : (plot?.no ??
        // 细纲还没落盘时按路径里的章号定位——老工程选中某一章就是这条路。
        (plotRelPath ? parsePlotFileName(basename(plotRelPath))?.no : undefined) ??
        request.targetNo ??
        Number.POSITIVE_INFINITY);
  const previous = all.filter((c) => c.no < no);
  // 后文只在这一章确实有定位时才有意义：`no` 是 +∞ 时「后面」是空的。
  const following = Number.isFinite(no) ? all.filter((c) => c.no > no) : [];

  const scenes =
    plotRelPath && (wants('sceneSelf') || wants('sceneSiblings'))
      ? await project.listScenes(plotRelPath)
      : [];

  const sceneNo = target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;
  const scene = sceneNo === undefined ? undefined : scenes.find((s) => s.no === sceneNo);

  return {
    target,
    plot,
    no,
    previous,
    // 「上文」只在有细纲时才有内容可带（那一层渲染的是四个小节）。
    prevPlots: wants('plotPrev') ? previous.filter((c) => c.plot).slice(-PREV_PLOTS) : [],
    nextPlots: wants('plotNext') ? following.filter((c) => c.plot).slice(0, NEXT_PLOTS) : [],
    scenes,
    scene,
    castNames: scene ? scene.characters : [],
  };
}

/**
 * 某一章的正文：**成品优先，其次是中转站里那份**。
 *
 * 两处都要读得到：已经拆分的章正文在 `chapters/`，刚写完还没拆的在
 * `manuscripts/`。只读其中一边的话，要么老工程的前文全是空的，
 * 要么刚写完那一章接不上。
 *
 * 返回统一成 `Manuscript` 形状，调用方不必分辨来自哪一侧。
 */
export async function readChapterText(
  project: NovelProject,
  ref: ChapterRef
): Promise<Manuscript | undefined> {
  if (ref.chapter) {
    const text = await project.readChapterText(ref.chapter);
    return text.trim()
      ? {
          plotRelPath: ref.plot?.relPath ?? '',
          relPath: ref.chapter.relPath,
          text,
          wordCount: ref.chapter.wordCount,
          contentHash: ref.chapter.contentHash,
          beatsHash: '',
        }
      : undefined;
  }
  return ref.plot ? project.readManuscript(ref.plot.relPath) : undefined;
}

/**
 * 前一章的正文。写正文时要从它的结尾无缝接下去。
 *
 * 单独一个函数而不是塞进 `Focus`：`prevTail` 与 `manuscriptFull` 两层都要读
 * 正文，而多数装配（讨论、排剧情）一份都不读——放进 focus 等于每次装配
 * 都多读几个几千字的文件。
 */
export async function readPrevManuscript(
  project: NovelProject,
  focus: Focus
): Promise<Manuscript | undefined> {
  const prev = focus.previous[focus.previous.length - 1];
  return prev ? readChapterText(project, prev) : undefined;
}
