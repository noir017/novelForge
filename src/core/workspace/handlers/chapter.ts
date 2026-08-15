/**
 * `chapter` handler：发布区里的成品。
 *
 * 与创作轴上那三层（细纲 / 场景 / 中转站正文）不同，**章节不在生产链上**：
 * 它是拆分之后的产物，没有上游指纹要记。这一层管的是两件伴生的事：
 *
 * 1. **草稿跟随**（原 `fileOps.carryDraft`）：草稿按章节在 `chapters/` 之下的
 *    相对路径镜像，章节路径一变归属路径就跟着变。不搬的话旧位置的东西成了
 *    孤儿，新位置又读不到，**而界面上一切正常**。
 * 2. **manifest 同步**：章节列表与字数索引跟着刷新。
 *
 * **删章节不删草稿**（AGENTS 第 10 条）——那是作者另写的东西，删正文不代表
 * 要连草稿一起丢。确认框里会说一句，否则「删了这一章」之后草稿还在，
 * 下次看见会以为闹鬼。所以这里没有 `onRemove`：删除时什么伴生都不搬。
 *
 * 摘要同理不跟着删：它挂在成品上，但那是 `fileOps` 的 `carrySummary` 管的
 * 交互流程（工程页的删除要说清连带什么），不是网关的默认行为。
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
    // 目录也要搬：移动 `chapters/卷一/` 时 `drafts/卷一/` 得跟着走。
    const isDir = ctx.path.kind === 'other';
    const side = await carryDraft(ctx.project, from, to, isDir);
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
  const from = project.draftRelPathFor(fromRel);
  const to = project.draftRelPathFor(toRel);
  if (!from) {
    return [];
  }
  const fromAbs = project.pathOf(from);
  if (!(await pathExists(fromAbs))) {
    return [];
  }
  if (!to) {
    log.warn(`章节被移出 chapters/，草稿留在原处`, `草稿仍在 ${from}`);
    return [`草稿留在 ${from}（新位置推导不出镜像路径）`];
  }
  if (from === to) {
    return [];
  }
  const toAbs = project.pathOf(to);
  if (await pathExists(toAbs)) {
    // **不覆盖**：两份都留着，提示作者自己去合（AGENTS 第 3 条）。
    // 只打日志不够——日志要用户主动去翻，而这一刻他正盯着工程页。
    log.warn(`新位置已有草稿，旧草稿未动`, `目标 ${to}｜旧草稿仍在 ${from}`);
    getHost().toast(`新位置已有草稿${isDir ? '目录' : ''}：${to}，旧草稿留在 ${from} 未动。`, 'error');
    return [`新位置已有草稿 ${to}，旧草稿留在 ${from} 未动`];
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  log.info(`草稿已跟随移动`, `${from} → ${to}`);
  return [`草稿 ${from} → ${to}`];
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
