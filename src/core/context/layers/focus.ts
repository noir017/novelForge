import { chapterOfTarget, CreationTarget } from '../../model/pipeline';
import { ChapterPlan } from '../../model/planFile';
import { NovelProject } from '../../model/project';
import { Scene } from '../../model/sceneFile';
import { Chapter } from '../../model/types';
import { BuildRequest, LayerId, LayerSpec } from '../types';

/** 这一次装配围绕哪个产物转。 */
export interface Focus {
  target: CreationTarget;
  /** 目标章节。尚未落盘时为 undefined（正要写全书的下一章）。 */
  chapter?: Chapter;
  /** 「前文」的边界序号。全书大纲阶段为 +∞，即全书都算前文。 */
  order: number;
  previous: Chapter[];
  /** 目标章节的细纲。 */
  plan?: ChapterPlan;
  /** 上一章的细纲。 */
  prevPlan?: ChapterPlan;
  /** 目标章节的全部场景，按 no 升序。 */
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
  const chapters = await project.listChapters();
  const chapterRelPath = chapterOfTarget(target);
  const chapter = chapterRelPath ? chapters.find((c) => c.relPath === chapterRelPath) : undefined;

  const order =
    target.kind === 'outline'
      ? Number.POSITIVE_INFINITY
      : (chapter?.order ?? request.targetOrder ?? Number.POSITIVE_INFINITY);
  const previous = chapters.filter((c) => c.order < order);
  const prevChapter = previous[previous.length - 1];

  const plan = chapterRelPath && wants('planSelf') ? await project.readPlan(chapterRelPath) : undefined;
  const prevPlan = prevChapter && wants('planPrev') ? await project.readPlan(prevChapter.relPath) : undefined;
  const scenes =
    chapterRelPath && (wants('sceneSelf') || wants('sceneSiblings'))
      ? await project.listScenes(chapterRelPath)
      : [];

  const sceneNo = target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;
  const scene = sceneNo === undefined ? undefined : scenes.find((s) => s.no === sceneNo);

  return {
    target,
    chapter,
    order,
    previous,
    plan,
    prevPlan,
    scenes,
    scene,
    castNames: scene ? scene.characters : [],
  };
}
