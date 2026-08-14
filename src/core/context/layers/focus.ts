import { plotOfTarget, CreationTarget } from '../../model/pipeline';
import { Plot } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Scene } from '../../model/sceneFile';
import { Manuscript } from '../../model/types';
import { BuildRequest, LayerId, LayerSpec } from '../types';

/** 写/改某一段时，前后各带几段**原文**。摘要不受这个数限制（它便宜得多）。 */
export const PREV_PLOTS = 3;
export const NEXT_PLOTS = 1;

/** 这一次装配围绕哪个产物转。 */
export interface Focus {
  target: CreationTarget;
  /** 目标剧情段。尚未落盘时为 undefined（正要写全书的下一段）。 */
  plot?: Plot;
  /** 「前文」的边界段号。全书大纲阶段为 +∞，即全书都算前文。 */
  no: number;
  /** 这一段之前的全部段，按段号升序。 */
  previous: Plot[];
  /** 紧邻的前几段（`plotPrev` 用），按段号升序。 */
  prevPlots: Plot[];
  /** 紧邻的后一段（`plotNext` 用）。它已经排好时，本段的收尾要接得上它的开头。 */
  nextPlots: Plot[];
  /** 目标段的全部场景，按 no 升序。 */
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
  const plots = await project.listPlots();
  const plotRelPath = plotOfTarget(target);
  const plot = plotRelPath ? plots.find((p) => p.relPath === plotRelPath) : undefined;

  const no =
    target.kind === 'outline'
      ? Number.POSITIVE_INFINITY
      : (plot?.no ?? request.targetNo ?? Number.POSITIVE_INFINITY);
  const previous = plots.filter((p) => p.no < no);
  // 后文只在这一段确实落盘时才有意义：`no` 是 +∞ 时「后面」是空的。
  const following = Number.isFinite(no) ? plots.filter((p) => p.no > no) : [];

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
    prevPlots: wants('plotPrev') ? previous.slice(-PREV_PLOTS) : [],
    nextPlots: wants('plotNext') ? following.slice(0, NEXT_PLOTS) : [],
    scenes,
    scene,
    castNames: scene ? scene.characters : [],
  };
}

/**
 * 前一段的正文。写正文时要从它的结尾无缝接下去。
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
  return prev ? project.readManuscript(prev.relPath) : undefined;
}
