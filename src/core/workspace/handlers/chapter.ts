/**
 * `chapter` handler：正文。
 *
 * 正文直接落在 `chapters/` 里（一章一纲，没有中间层），上游指纹记在**这一章细纲**的
 * `writtenFrom` 上（正文落盘那一步调 `Workspace.recordWrittenFrom`），这里不记账。这一层管的是两件
 * 伴生的事：
 *
 * 1. **草稿与细纲跟随**（原 `fileOps.carryDraft`）：两样都按章节在 `chapters/` 之下的
 *    相对路径镜像（草稿在 `drafts/`，细纲在 `.novelforge/summaries/`），章节路径一变归属路径就跟着变。
 *    不搬的话旧位置的东西成了孤儿，新位置又读不到，**而界面上一切正常**。
 * 2. **manifest 同步**：章节列表与字数索引跟着刷新。
 *
 * **删章节不删草稿**（AGENTS 第 10 条）——那是作者另写的东西，删正文不代表
 * 要连草稿一起丢。确认框里会说一句，否则「删了这一章」之后草稿还在，
 * 下次看见会以为闹鬼。细纲同理不跟着删：正文没了，它退回这一章的计划。所以 `onRemove`
 * 只重算 manifest，什么伴生都不搬。
 *
 * 只有经网关的改名、移动才搬得动伴生：作者在外面直接给正文改名，细纲留在原处，那就是一章新的。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../../host';
import { scoped } from '../../runtime/logger';
import { NovelProject } from '../../model/project';
import { Handler, HandlerCtx } from './types';

const log = scoped('工作区');

export const chapterHandler: Handler = {
  /** 章节没有上游指纹，只同步 manifest。 */
  async after(ctx: HandlerCtx) {
    await ctx.project.syncManifest();
    return [];
  },

  async companions(ctx: HandlerCtx, from: string, to: string) {
    // 目录也要搬：移动 `chapters/卷一/` 时 `drafts/卷一/`、`summaries/卷一/` 都得跟着走。
    const isDir = ctx.path.kind === 'other';
    const side = [...(await carryDraft(ctx.project, from, to, isDir)), ...(await carryPlot(ctx.project, from, to, isDir))];
    await ctx.project.syncManifest();
    return side;
  },

  /**
   * 删章节：**草稿不跟着删**（第 10 条）。manifest 要重算——那一行没了。
   */
  async onRemove(ctx: HandlerCtx) {
    await ctx.project.syncManifest();
    return [];
  },
};

/**
 * 章节改名/移动后，把它的草稿一并搬过去。
 *
 * 不搬的话草稿就成了孤儿：下次点「打开草稿」会在新位置静默新建一个空文件，
 * 之前写的东西还躺在旧路径下，没人告诉作者。
 *
 * 目标位置已有同名的东西时**不覆盖**：两份都留着，提示作者自己去合
 * （AGENTS 第 3 条）。章节被移出 `chapters/` 时新镜像路径推导不出，
 * 草稿留在原处——**要说出来**，不说的话作者会以为它跟着走了。
 */
export async function carryDraft(
  project: NovelProject,
  fromRel: string,
  toRel: string,
  isDir = false
): Promise<string[]> {
  return carryMirror(project.draftRelPathFor(fromRel), project.draftRelPathFor(toRel), '草稿', isDir, project);
}

/**
 * 章节改名/移动后，把它的细纲一并搬过去（细纲镜像正文的相对路径，`NovelProject.plotMirrorOf`）。
 *
 * 不搬的话这一章在工程页上立刻变成「还没有细纲」，排好的计划与定稿的档案都还躺在旧路径下。
 * 规矩与草稿一样：目标已有就不覆盖、移出 `chapters/` 就留在原处，两种都说出来。
 */
export async function carryPlot(
  project: NovelProject,
  fromRel: string,
  toRel: string,
  isDir = false
): Promise<string[]> {
  const side = await carryMirror(project.plotMirrorOf(fromRel, isDir), project.plotMirrorOf(toRel, isDir), '细纲', isDir, project);
  if (side.length > 0) {
    project.invalidate();
  }
  return side;
}

/** 草稿与细纲共用的搬法：`from` / `to` 是两边的镜像路径（推导不出时 undefined）。 */
async function carryMirror(
  from: string | undefined,
  to: string | undefined,
  what: string,
  isDir: boolean,
  project: NovelProject
): Promise<string[]> {
  if (!from) {
    return [];
  }
  const fromAbs = project.pathOf(from);
  if (!(await pathExists(fromAbs))) {
    return [];
  }
  if (!to) {
    log.warn(`章节被移出 chapters/，${what}留在原处`, `${what}仍在 ${from}`);
    return [`${what}留在 ${from}（新位置推导不出镜像路径）`];
  }
  if (from === to) {
    return [];
  }
  const toAbs = project.pathOf(to);
  if (await pathExists(toAbs)) {
    // **不覆盖**：两份都留着，提示作者自己去合（AGENTS 第 3 条）。
    // 只打日志不够——日志要用户主动去翻，而这一刻他正盯着工程页。
    log.warn(`新位置已有${what}，旧${what}未动`, `目标 ${to}｜旧${what}仍在 ${from}`);
    getHost().toast(`新位置已有${what}${isDir ? '目录' : ''}：${to}，旧${what}留在 ${from} 未动。`, 'error');
    return [`新位置已有${what} ${to}，旧${what}留在 ${from} 未动`];
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  log.info(`${what}已跟随移动`, `${from} → ${to}`);
  return [`${what} ${from} → ${to}`];
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
