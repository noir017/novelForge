/**
 * `setting` handler：架构层的三份文档（小说配置 / 故事前提 / 世界观）。
 *
 * **渲染**：`Artifact{kind:'settingDoc'}` → 按那一件的小节表重排成文件。
 * 小节换新；配置的 frontmatter（类型、结构、总章数、每章字数……）**产物给了就用
 * 产物的，没给就沿用磁盘那份**——作者手定的「全书 100 章」不该因为重写一次梗概
 * 就被抹掉。
 *
 * **不记账**：架构在指纹链的最上游，它自己没有上游可记。它的下游（大纲）记它的
 * 指纹那一步留到二期（大纲的生成移植过来之后）。
 */
import { parseBookConfig, renderBookConfig, renderSettingDoc } from '../../model/settingFile';
import { readTextIfExists } from '../../model/fs';
import { Handler, HandlerCtx } from './types';

export const settingHandler: Handler = {
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'settingDoc') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    const doc = ctx.path.doc;
    if (!doc || doc === 'characters' || doc !== artifact.doc) {
      throw new Error(`「${ctx.rel}」不是${artifact.doc}的落点`);
    }
    if (doc !== 'config') {
      return renderSettingDoc(doc, artifact.sections);
    }
    const raw = (await readTextIfExists(ctx.project.pathOf(ctx.rel)).catch(() => undefined)) ?? '';
    const current = parseBookConfig(raw, ctx.rel);
    const fields = artifact.config ?? {};
    return renderBookConfig({
      genre: fields.genre || current.genre,
      subGenre: fields.subGenre || current.subGenre,
      audience: fields.audience || current.audience,
      structure: fields.structure ?? current.structure,
      pov: fields.pov ?? current.pov,
      totalChapters: fields.totalChapters ?? current.totalChapters,
      wordsPerChapter: fields.wordsPerChapter ?? current.wordsPerChapter,
      sections: { ...current.sections, ...artifact.sections } as typeof current.sections,
    });
  },
};
