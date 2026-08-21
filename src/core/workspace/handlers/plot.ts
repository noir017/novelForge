/**
 * `plot` handler：细纲。
 *
 * 三件事：
 *
 * 1. **渲染**：`Artifact{kind:'plot'}` → `renderPlotFile`，四个小节换新，
 *    **标题 / 幕 / 目标字数 / done 沿用磁盘那份**——「重写剧情」改的是剧情，
 *    不该顺手把作者起的标题或标的完成状态一起抹掉。
 * 2. **记账**：`upstreamHash` = **这一段所属那一卷**的卷纲指纹（未分卷的段
 *    退回全书大纲的指纹）。**从前只在采纳路径上做**，作者在内置编辑器里改一份
 *    细纲，指纹链就断了——那一段从此再也不挂 ⟳。下沉到这里之后谁写都记。
 * 3. **伴生**：改名/改号时搬走 `manuscripts/<stem>.md`（原 `carryPlotCompanions`），
 *    删除时把它搬进 `.trash/`。
 *
 * ## 三条不能碰的取舍
 *
 * - **手写的产物永不标脏**（第 18a 条）：**没有 frontmatter 的细纲不补
 *   `upstreamHash`**。`upstreamHash` 为空说明它不是这条链生出来的，拿一个
 *   凭空的过期标记去催作者重做，他会学会无视所有标记。
 * - **`plotContentHash` 只哈希四个小节，不含 frontmatter**（第 18b 条）：
 *   `upstreamHash` 自己就在 frontmatter 里，算进去会让「排一次剧情」立刻
 *   使这一段的正文过期。那个哈希在 `views/pipeline.ts` 里定义，这里只是引用它。
 * - **删细纲不碰 `chapters/` 与摘要**：那两样描述的是已经发布的成品。
 *   删掉细纲只是放弃这一章的规划稿。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hash, readTextIfExists } from '../../model/fs';
import { rewriteFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import { parsePlotFile, renderPlotFile } from '../../model/plotFile';
import { volumeContentHash } from '../../views/pipeline';
import { Handler, HandlerCtx } from './types';

export const plotHandler: Handler = {
  /**
   * 四个小节换新，其余字段沿用磁盘那份。
   *
   * 细纲文件不存在时（拆章那一步为每章建骨架）就用产物自己的空壳，
   * 标题等由调用方走 `writePlot` 那条路给。
   */
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'plot') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    const current = await ctx.project.readPlot(ctx.rel);
    return renderPlotFile({
      no: current?.no ?? ctx.path.no ?? 0,
      title: current?.title ?? '',
      arc: current?.arc ?? '',
      targetWords: current?.targetWords,
      upstreamHash: await plotUpstreamHash(ctx.project, ctx.rel),
      done: current?.done ?? false,
      // 已经拆出去的落点沿用磁盘那份：「重写剧情」改的是规划稿，
      // 不该把「这一段交付到哪几章」抹掉。
      chapters: current?.chapters ?? [],
      sections: artifact.sections,
    });
  },

  /**
   * 记账：把当前大纲的指纹落进 frontmatter。
   *
   * `rewriteFrontmatter` 只改 `---` 之间那一段，**正文一个字节不动**——
   * 作者可能加过自定义小节，整份重渲染会把它们悄悄抹平。
   * 没有 frontmatter 时返回 undefined，那正是「手写的产物」，不补。
   */
  async after(ctx: HandlerCtx, text: string) {
    const inVolume = await volumeOfPlot(ctx.project, ctx.rel);
    return recordUpstream(
      ctx,
      text,
      await plotUpstreamHash(ctx.project, ctx.rel),
      inVolume ? '卷纲指纹' : '大纲指纹'
    );
  },

  async companions(ctx: HandlerCtx, from: string, to: string) {
    return carryPlotCompanions(ctx.project, from, to);
  },

  async onRemove(ctx: HandlerCtx, rel: string) {
    return trashPlotCompanions(ctx.project, rel);
  },
};

/** 全书大纲的内容指纹——卷纲的上游，也是未分卷的段的上游。 */
export async function outlineHash(project: NovelProject): Promise<string> {
  return hash(await project.readOutline());
}

/**
 * 这一段的上游指纹：**所属那一卷的卷纲**，未分卷时退回全书大纲。
 *
 * 上游是谁由**目录**决定，与 `listPlotsOfVolume` 同一条判据——段的归属不落
 * frontmatter，目录已经说了。找不到那一卷的文件（作者手删了卷纲、或手工把段
 * 放进了一个没有对应卷纲的目录）时也退回大纲：一个凭空的指纹会让整卷立刻
 * 标脏，而那不是真的。
 */
export async function plotUpstreamHash(project: NovelProject, plotRelPath: string): Promise<string> {
  const volume = await volumeOfPlot(project, plotRelPath);
  return volume ? volumeContentHash(volume) : outlineHash(project);
}

/** 这一段所属的那一卷；未分卷（段直接躺在 `plots/` 根下）时 undefined。 */
export async function volumeOfPlot(project: NovelProject, plotRelPath: string) {
  const root = `${project.relPath(project.plotsDir)}/`;
  const under = plotRelPath.startsWith(root) ? plotRelPath.slice(root.length) : '';
  const slash = under.lastIndexOf('/');
  if (slash < 0) {
    return undefined;
  }
  const stem = under.slice(0, slash);
  return (await project.listVolumes()).find(
    (v) => project.plotsMirrorRelPathForVolume(v.relPath) === `${root}${stem}`
  );
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

/**
 * 细纲改名（或改号）后，把中转站正文跟着搬过去。
 *
 * 目标已存在时**不动**（不静默覆盖）——那说明磁盘上已经有一份叫这个名字的，
 * 覆盖会把它的东西吞掉。搬不过去的那份留在原处，不凭空消失。
 *
 * 摘要不在此列：它挂在 `chapters/` 上，跟着章节文件改名走（见 fileOps 的
 * `carrySummary`）。**场景目录也不在此列**——那一层已经删掉，老工程里剩下的
 * 那个目录不再是这一段的伴生物，跟着改名搬只会让人以为它还在用。
 */
export async function carryPlotCompanions(
  project: NovelProject,
  fromRel: string,
  toRel: string
): Promise<string[]> {
  const pairs: [string, string][] = [
    [project.manuscriptMirrorRelPath(fromRel), project.manuscriptMirrorRelPath(toRel)],
  ];
  const side: string[] = [];
  for (const [from, to] of pairs) {
    const fromAbs = project.pathOf(from);
    const toAbs = project.pathOf(to);
    if (from === to || !(await pathExists(fromAbs)) || (await pathExists(toAbs))) {
      continue;
    }
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    side.push(`${from} → ${to}`);
  }
  return side;
}

/** 删细纲时把中转站正文一起搬进 `.trash/`（保留原相对路径）。 */
export async function trashPlotCompanions(
  project: NovelProject,
  plotRelPath: string
): Promise<string[]> {
  const side: string[] = [];
  for (const rel of [project.manuscriptMirrorRelPath(plotRelPath)]) {
    if (await trashRel(project, rel)) {
      side.push(`${rel} → .trash/`);
    }
  }
  return side;
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
