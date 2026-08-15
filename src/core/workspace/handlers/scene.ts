/**
 * `scene` handler：场景卡。
 *
 * 三件事：
 *
 * 1. **渲染**：`Artifact{kind:'scene'}` → `renderSceneFile`。
 *    - **标题沿用磁盘那份**：标题决定文件名，改写一张卡不该顺手改文件名，
 *      否则同一场在磁盘上换个位置。标题不在场景卡的产出契约里，它由拆场景
 *      那一步定下来。
 *    - **status 由 `isSceneReady(sections)` 推**，不靠调用方记得传：
 *      设计过了就是可以开写了。
 * 2. **记账**：`upstreamHash = plotContentHash(plot)`。同样**从前只在采纳
 *    路径上做**，现在谁写都记。
 * 3. **落点裁决**：场景文件名由「场号 + 标题」决定，而标题在磁盘上——
 *    调用方给的 `scenes/012-入宗/02.md` 只是占位，真正的落点由这里定。
 *
 * ## `plotContentHash` 只哈希四个小节（第 18b 条）
 *
 * 不含 frontmatter：`upstreamHash` 自己就在 frontmatter 里，算进去会让
 * 「排一次剧情」立刻使全部场景过期。同理不含 `status`——作者把这一章标成
 * done 不该让四个场景一起标脏。哈希在 `views/pipeline.ts` 里定义一次。
 */
import * as fs from 'node:fs/promises';
import { sanitizeFileName } from '../../model/fs';
import { rewriteFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import { isSceneReady, renderSceneFile, sceneFileName } from '../../model/sceneFile';
import { plotContentHash } from '../../views/pipeline';
import { Handler, HandlerCtx } from './types';

export const sceneHandler: Handler = {
  /**
   * 落点最终由这里定：文件名带标题，而标题在磁盘上那份里。
   *
   * 找不到磁盘上那一场（新拆出来的）时沿用调用方给的路径——那时它已经是
   * `sceneFileName(no, safeTitle)` 拼出来的了。
   */
  async resolve(ctx: HandlerCtx) {
    const { plotRelPath, sceneNo } = ctx.path;
    if (!plotRelPath || sceneNo === undefined) {
      return ctx.rel;
    }
    const existing = await ctx.project.readScene(plotRelPath, sceneNo);
    return existing?.relPath ?? ctx.rel;
  },

  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'scene') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    const { plotRelPath, sceneNo } = ctx.path;
    if (!plotRelPath || sceneNo === undefined) {
      throw new Error(`认不出这是第几章的第几场：${ctx.rel}`);
    }
    const existing = await ctx.project.readScene(plotRelPath, sceneNo);

    return renderSceneFile({
      plotRelPath,
      no: sceneNo,
      // 标题不在产出契约里——它决定文件名，由拆场景那一步定下来。
      title: existing?.title || `场景${sceneNo}`,
      place: artifact.place || existing?.place || '',
      time: artifact.time || existing?.time || '',
      characters: artifact.characters.length > 0 ? artifact.characters : (existing?.characters ?? []),
      targetWords: artifact.targetWords ?? existing?.targetWords,
      upstreamHash: await upstreamOf(ctx.project, plotRelPath),
      // 设计过了就是可以开写了——状态由内容推，不靠调用方记得传。
      status: isSceneReady(artifact.sections) ? 'ready' : 'draft',
      sections: artifact.sections,
    });
  },

  async after(ctx: HandlerCtx, text: string) {
    const upstream = ctx.path.plotRelPath
      ? await upstreamOf(ctx.project, ctx.path.plotRelPath)
      : '';
    if (!upstream) {
      return [];
    }
    const next = rewriteFrontmatter(text, { upstreamHash: upstream });
    // 没有 frontmatter = 作者手写的场景，不给它补一个凭空的指纹。
    if (next === undefined || next === text) {
      return [];
    }
    await fs.writeFile(ctx.project.pathOf(ctx.rel), next, 'utf8');
    return [`记下剧情指纹 ${upstream}`];
  },
};

/** 这一场的上游指纹：所属细纲的内容 hash。细纲不在时给空串（不标脏）。 */
export async function upstreamOf(project: NovelProject, plotRelPath: string): Promise<string> {
  const plot = await project.readPlot(plotRelPath);
  return plot ? plotContentHash(plot) : '';
}

/** 场号 + 标题 → 场景文件的工作区相对路径。清洗只在这一处做。 */
export function sceneRelPathFor(
  project: NovelProject,
  plotRelPath: string,
  no: number,
  title: string
): string {
  const dir = project.sceneMirrorRelPath(plotRelPath);
  return `${dir}/${sceneFileName(no, title.trim() ? sanitizeFileName(title) : '')}`;
}
