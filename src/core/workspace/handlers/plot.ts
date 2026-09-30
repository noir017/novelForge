/**
 * `plot` handler：一章的细纲。
 *
 * 两件事：
 *
 * 1. **渲染**：`Artifact{kind:'plot'}` → `renderPlotFile`。三个小节换新；
 *    **标题、目标字数、done、writtenFrom 沿用磁盘那份**——「重写细纲」改的是这一章
 *    怎么走，不该顺手把作者起的标题、定的字数、标的完成状态抹掉；`writtenFrom`
 *    是正文那一侧记的账，细纲重写之后它对不上，正是「细纲在正文之后改过」的信号。
 *    结构功能与计划出场的人随产物更新（那是规划的一部分）。
 * 2. **记账**：`upstreamHash` = 情节大纲里**覆盖本章那一节**的指纹（大纲没有区间
 *    标题时退回全书大纲的指纹）。谁写都记——作者在内置编辑器里改一份细纲，
 *    指纹链照样接得上。
 *
 * 从前还有第三件：改名 / 删除时搬走中转站里那份正文。一章一纲之后正文就是章节，
 * 细纲改名不必带走任何东西。
 *
 * ## 两条不能碰的取舍
 *
 * - **手写的产物永不标脏**（第 18a 条）：**没有 frontmatter 的细纲不补
 *   `upstreamHash`**。它为空说明这份细纲不是这条链生出来的，拿一个凭空的过期标记
 *   去催作者重做，他会学会无视所有标记。
 * - **`plotContentHash` 只哈希三个小节，不含 frontmatter**（第 18b 条）：
 *   `upstreamHash` / `writtenFrom` 自己就在 frontmatter 里，算进去会让「排一次细纲」
 *   立刻使这一章的正文过期。那个哈希在 `views/pipeline.ts` 里定义。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hash, readTextIfExists } from '../../model/fs';
import { rewriteFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import { parsePlotFile, parsePlotFileName, renderPlotFile } from '../../model/plotFile';
import { outlineUpstreamHash } from '../../model/outlineFile';
import { Handler, HandlerCtx } from './types';

export const plotHandler: Handler = {
  /**
   * 三个小节换新，其余字段按上面的规矩合并。
   *
   * 细纲文件不存在时（拆细纲那一步新建）就用产物自己带的标题与规划字段。
   */
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'plot') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    const current = await ctx.project.readPlot(ctx.rel);
    return renderPlotFile({
      no: current?.no ?? ctx.path.no ?? 0,
      title: current?.title || artifact.title || '',
      role: artifact.role || current?.role || '',
      characters: artifact.characters?.length ? artifact.characters : (current?.characters ?? []),
      targetWords: current?.targetWords ?? artifact.targetWords,
      upstreamHash: await plotUpstreamHash(ctx.project, ctx.rel),
      writtenFrom: current?.writtenFrom,
      done: current?.done ?? false,
      sections: artifact.sections,
    });
  },

  /**
   * 记账：把大纲切片的指纹落进 frontmatter。
   *
   * `rewriteFrontmatter` 只改 `---` 之间那一段，**正文一个字节不动**——
   * 作者可能加过自定义小节，整份重渲染会把它们悄悄抹平。
   * 没有 frontmatter 时返回 undefined，那正是「手写的产物」，不补。
   */
  async after(ctx: HandlerCtx, text: string) {
    return recordUpstream(ctx, text, await plotUpstreamHash(ctx.project, ctx.rel), '大纲指纹');
  },
};

/** 全书大纲的内容指纹。大纲没有区间标题时，它就是每一章细纲的上游。 */
export async function outlineHash(project: NovelProject): Promise<string> {
  return hash(await project.readOutline());
}

/**
 * 这一章细纲的上游指纹：情节大纲里**覆盖本章的那一节**（见 model/outlineFile.ts 的
 * `outlineUpstreamHash`，流水线判脏用的是同一个函数）。
 *
 * 章号从细纲的**文件名**取（文件名是身份），取不到就用全书指纹。
 */
export async function plotUpstreamHash(project: NovelProject, plotRelPath: string): Promise<string> {
  const no = parsePlotFileName(path.posix.basename(plotRelPath))?.no;
  return outlineUpstreamHash(await project.readOutline(), no);
}

/**
 * 把上游指纹记进这份产物的 frontmatter。返回 `side` 说明（没记就是空数组）。
 *
 * **两种情况不记**：
 * - 文件没有 frontmatter（作者手写的）——补一个凭空的指纹等于凭空标脏
 * - 算出来的指纹是空串（大纲还是空的）——同上
 */
async function recordUpstream(
  ctx: HandlerCtx,
  text: string,
  upstream: string,
  label: string
): Promise<string[]> {
  if (!upstream) {
    return [];
  }
  const next = rewriteFrontmatter(text, { upstreamHash: upstream });
  if (next === undefined) {
    // 手写的产物：没有 frontmatter，就没有这条链。不给它补一个。
    return [];
  }
  if (next === text) {
    return [];
  }
  await fs.writeFile(ctx.project.pathOf(ctx.rel), next, 'utf8');
  ctx.project.invalidate();
  return [`记下${label} ${upstream}`];
}

/** 把某个工作区相对路径搬进 `.trash/`（保留原相对路径）。不存在就跳过。 */
export async function trashRel(project: NovelProject, relPath: string): Promise<boolean> {
  const abs = project.pathOf(relPath);
  if (!(await pathExists(abs))) {
    return false;
  }
  const target = path.join(project.trashDir, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(abs, target).catch(() => undefined);
  return true;
}

/** 磁盘上那份细纲的解析结果；没有就 undefined。零信任地读，绝不抛。 */
export async function readPlotAt(project: NovelProject, rel: string) {
  try {
    const raw = await readTextIfExists(project.pathOf(rel));
    return raw === undefined ? undefined : parsePlotFile(raw, rel);
  } catch {
    return undefined;
  }
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
