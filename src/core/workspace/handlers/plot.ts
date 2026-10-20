/**
 * `plot` handler：一章的细纲。
 *
 * 两件事：
 *
 * 1. **渲染**：`Artifact{kind:'plot'}` → `renderPlotFile`。八个小节换新；
 *    **标题、目标字数、done、writtenFrom、定稿记的 sourceHash 与 cast 沿用磁盘那份**——
 *    「重写细纲」改的是这一章怎么走，不该顺手把作者起的标题、定的字数、标的完成状态抹掉；
 *    `writtenFrom` 是正文那一侧记的账，细纲重写之后它对不上，正是「细纲在正文之后改过」的信号
 *    （定稿过的章照样只挂 ⟳，第 18 条）。**预检的永久放行（`preflightOk`）刻意不沿用**：
 *    重排过的出场是新的安排，要再问一次（五期补遗 §2）。
 * 2. **记账**：`upstreamHash` = 情节大纲里**覆盖本章那一节**的指纹（大纲没有区间
 *    标题时退回情节大纲的指纹）。谁写都记——作者在内置编辑器里改一份细纲，
 *    指纹链照样接得上。
 *
 * 复制出来的副本另有一条（`afterCopy`）：去掉定稿那一侧的指纹，`upstreamHash` 不重记——副本是一份还没写、没定稿的计划。
 *
 * 另有定稿那一次写入的渲染（{@link renderFinalizedPlot}）：它不走 `write`，由
 * `Workspace.finalizePlot` 调，不记大纲指纹——反向更新的依据是正文，不是大纲。
 *
 * ## 两条不能碰的取舍
 *
 * - **手写的产物永不标脏**（第 18a 条）：**没有 frontmatter 的细纲不补
 *   `upstreamHash`**。它为空说明这份细纲不是这条链生出来的，拿一个凭空的过期标记
 *   去催作者重做，他会学会无视所有标记。
 * - **`plotContentHash` 只哈希八个小节，不含 frontmatter**（第 18b 条）：
 *   `upstreamHash` / `writtenFrom` / `sourceHash` 自己就在 frontmatter 里，算进去会让「排一次细纲」
 *   立刻使这一章的正文过期。那个哈希在 `model/plotFile.ts` 里定义。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hash, readTextIfExists } from '../../model/fs';
import { parseMarkdown, rewriteFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import {
  Plot,
  PlotSections,
  WritablePlot,
  parsePlotFile,
  parsePlotFileName,
  plotContentHash,
  renderPlotFile,
} from '../../model/plotFile';
import { SummaryCast } from '../../model/types';
import type { LoreLine } from '../../model/loreFile';
import { outlineUpstreamHash } from '../../model/outlineFile';
import { Handler, HandlerCtx } from './types';

export const plotHandler: Handler = {
  /**
   * 八个小节换新，其余字段按上面的规矩合并。
   *
   * 细纲文件不存在时（拆细纲那一步新建）就用产物自己带的标题与目标字数。
   */
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'plot') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    const current = await ctx.project.readPlot(ctx.rel);
    return renderPlotFile({
      no: current?.no ?? ctx.path.no ?? 0,
      title: current?.title || artifact.title || '',
      targetWords: current?.targetWords ?? artifact.targetWords,
      upstreamHash: await plotUpstreamHash(ctx.project, ctx.rel),
      writtenFrom: current?.writtenFrom,
      sourceHash: current?.sourceHash,
      cast: current?.cast,
      done: current?.done ?? false,
      sections: artifact.sections,
      // 第九节「设定」不在八节里：产物带了就换新（重排的计划），没带就沿用磁盘那份。
      lore: artifact.lore ?? current?.lore,
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

  /**
   * 复制出来的一份细纲（文件页的「复制 → 粘贴」，或整个分卷目录复制一份）：**去掉定稿那一侧的账**，其余一个字不动。
   *
   * - `writtenFrom` / `sourceHash` / `cast` 删掉：它们说的是「有一份正文照这份写成过、定稿时正文是这个指纹、实际出场
   *   这几个人」——那是原件那一章的事。副本落在别的路径上，镜像的是另一章（或者还没有正文），带着它们会被当成
   *   定稿过的细纲：出场统计、设定名录多数一章（第 14 条），镜像位置上要是恰好有正文，还会被说成「定稿之后正文改过」
   *   或「细纲在正文之后改过」（第 18 条）。副本是一份还没写、没定稿的计划。
   * - `upstreamHash` **原样留着，不重算**：内容一字没变、章号没变（文件名照抄），它据以生成的仍是大纲里的同一节——
   *   原件挂着 ⟳ 的副本照样挂着，不被复制顺手刷成「新鲜」（`after` 会按大纲此刻的指纹重记，所以复制不走它）。
   *   **章号变了**（网关直接复制成另一个文件名）就删掉：那是另一章的那一节，留着只会凭空报 ⟳。
   * - 作者自己定的（标题、目标字数、`status: done`、预检与冲突检查的放行）与八节、第九节原样留着。
   * - 没有 frontmatter 的手写细纲不补（第 18a 条）。
   */
  async afterCopy(ctx: HandlerCtx, from: string) {
    const abs = ctx.project.pathOf(ctx.rel);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined) {
      return [];
    }
    const sameNo =
      parsePlotFileName(path.posix.basename(from))?.no === parsePlotFileName(path.posix.basename(ctx.rel))?.no;
    const patch: Record<string, undefined> = { writtenFrom: undefined, sourceHash: undefined, cast: undefined };
    if (!sameNo) {
      patch.upstreamHash = undefined;
    }
    // 一个要去掉的键都没有（手写的、没写过的计划）就一个字节不碰：`rewriteFrontmatter` 会把整段 frontmatter 重新排一遍。
    const keys = Object.keys(parseMarkdown(raw).frontmatter);
    const dropped = Object.keys(patch).filter((key) => keys.includes(key));
    if (dropped.length === 0) {
      return [];
    }
    const next = rewriteFrontmatter(raw, patch);
    if (next === undefined || next === raw) {
      return [];
    }
    await fs.writeFile(abs, next, 'utf8');
    ctx.project.invalidate();
    return [`细纲副本 ${ctx.rel} 去掉了 ${dropped.join(' / ')}（副本没写过、没定稿过）`];
  },
};

/**
 * 定稿反向更新之后的细纲全文。
 *
 * - **八节整体换成更新后的那一版**（作者自加的小节不留——旧版整份进了回收站）。
 * - frontmatter 保留 `no` / `title` / `targetWords` / `upstreamHash` / `status` / `preflightOk` /
 *   `factCheckOk`：那些是作者定的或计划那一侧的账，定稿不该动。
 * - 写入 `sourceHash`（正文的 contentHash）与 `cast`（实际出场），并把 **`writtenFrom` 刷成更新之后的
 *   内容指纹**：不刷的话，定稿刚改完细纲，正文立刻挂 ⟳（「细纲在正文之后改过」）；刷了之后，作者
 *   定稿后再改细纲，正文才挂 ⟳，提醒它可能没跟上（作者定案）。
 *
 * 还没有细纲的章（拆书导入、作者手写的正文）落一份新的：标题取章节的（回落标题不算），其余为空。
 * 指纹按**读回来的样子**算（占位文字读回来是空串），与流水线判脏时同一个口径。
 */
export function renderFinalizedPlot(input: {
  rel: string;
  no: number;
  title: string;
  current?: Plot;
  sections: PlotSections;
  cast: SummaryCast[];
  sourceHash: string;
  lore?: LoreLine[];
}): string {
  const { current } = input;
  const plot: WritablePlot = {
    no: current?.no ?? input.no,
    title: current ? current.title : input.title,
    targetWords: current?.targetWords,
    upstreamHash: current?.upstreamHash ?? '',
    done: current?.done ?? false,
    preflightOk: current?.preflightOk,
    factCheckOk: current?.factCheckOk,
    sourceHash: input.sourceHash,
    cast: input.cast,
    sections: input.sections,
    // 第九节「设定」：定稿记下的实际出现；没给（老调用）就沿用磁盘那份。
    lore: input.lore ?? current?.lore,
  };
  const writtenFrom = plotContentHash(parsePlotFile(renderPlotFile(plot), input.rel));
  return renderPlotFile({ ...plot, writtenFrom });
}

/** 情节大纲的内容指纹。大纲没有区间标题时，它就是每一章细纲的上游。 */
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

/** 磁盘上那份细纲的解析结果；没有就 undefined。零信任地读，绝不抛。 */
export async function readPlotAt(project: NovelProject, rel: string) {
  try {
    const raw = await readTextIfExists(project.pathOf(rel));
    return raw === undefined ? undefined : parsePlotFile(raw, rel);
  } catch {
    return undefined;
  }
}
