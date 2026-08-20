/**
 * `volume` handler：卷纲。
 *
 * 两件事（没有 `render`——卷纲不是一次生成的结构化产物，它由「大纲拆卷」那一步
 * 经 `Workspace.writeVolume` 整份写出来，之后作者手改；走路径的写入只有内置
 * 编辑器保存那一条，那条本来就是 `{text}`）：
 *
 * 1. **记账**：`upstreamHash = hash(outline.md)`。卷纲的上游是全书大纲，
 *    与细纲从前那条一样——只是链现在多了一环
 *    （`outline.md → volumes/ → plots/ → scenes/ → manuscripts/`）。
 *    下沉到这里，作者在编辑器里手改一份卷纲也照样记，指纹链不会断。
 * 2. **伴生**：卷词干就是它收纳的剧情段的目录名，所以改名/删除必须连带
 *    `plots/<词干>/`，以及那些段的两套镜像 `scenes/<词干>/` 与
 *    `manuscripts/<词干>/`。
 *
 * ## 为什么伴生是三棵目录树而不是一棵
 *
 * 段的归属靠目录（`plots/01-觉醒之日/003-楼道.md`），而段的场景与中转站正文
 * 又镜像段在 `plots/` 之下的**整段路径**（见 model/project.ts 的 `plotStem`）。
 * 所以卷改名会同时改掉三处的第一级目录名。只搬 `plots/` 那一棵的话，一卷改名
 * 之后每一段都会显示「还没拆场景」，而那些场景就躺在旁边一个孤儿目录里。
 *
 * **不碰 `chapters/` 与摘要**：与 `deletePlot` 同一条理由——那是作者已经发布
 * 出去的成品，删一份规划稿不该顺手带走它。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NovelProject } from '../../model/project';
import { Handler, HandlerCtx } from './types';
import { outlineHash, trashRel } from './plot';
import { rewriteFrontmatter } from '../../model/markdown';

export const volumeHandler: Handler = {
  async after(ctx: HandlerCtx, text: string) {
    const upstream = await outlineHash(ctx.project);
    if (!upstream) {
      return [];
    }
    const next = rewriteFrontmatter(text, { upstreamHash: upstream });
    // 手写的卷纲（没有 frontmatter）不补：凭空补一个指纹等于凭空标脏。
    if (next === undefined || next === text) {
      return [];
    }
    await fs.writeFile(ctx.project.pathOf(ctx.rel), next, 'utf8');
    ctx.project.invalidate();
    return [`记下大纲指纹 ${upstream}`];
  },

  async companions(ctx: HandlerCtx, from: string, to: string) {
    return carryVolumeCompanions(ctx.project, from, to);
  },

  async onRemove(ctx: HandlerCtx, rel: string) {
    return trashVolumeCompanions(ctx.project, rel);
  },
};

/**
 * 一卷的三棵伴生目录（工作区相对路径）：剧情段、它们的场景、它们的中转站正文。
 *
 * 三者同名同结构，这是 `plots/` 那条镜像规则的直接结果。只有一个地方定义它，
 * 改名与删除两条路共用。
 */
function volumeDirs(project: NovelProject, volumeRelPath: string): string[] {
  const stem = path.parse(volumeRelPath).name;
  return [
    project.relPath(path.join(project.plotsDir, stem)),
    project.relPath(path.join(project.scenesDir, stem)),
    project.relPath(path.join(project.manuscriptsDir, stem)),
  ];
}

/**
 * 卷纲改名（或改号）后，把三棵伴生目录跟着搬过去。
 *
 * 目标已存在时**不动**（不静默覆盖）：那说明磁盘上已经有一棵叫这个名字的，
 * 覆盖会把它的东西吞掉。搬不过去的那棵留在原处，不凭空消失。
 */
export async function carryVolumeCompanions(
  project: NovelProject,
  fromRel: string,
  toRel: string
): Promise<string[]> {
  const froms = volumeDirs(project, fromRel);
  const tos = volumeDirs(project, toRel);
  const side: string[] = [];
  for (const [i, from] of froms.entries()) {
    const to = tos[i];
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

/** 删卷纲时把三棵伴生目录一起搬进 `.trash/`（保留原相对路径）。 */
export async function trashVolumeCompanions(
  project: NovelProject,
  volumeRelPath: string
): Promise<string[]> {
  const side: string[] = [];
  for (const rel of volumeDirs(project, volumeRelPath)) {
    if (await trashRel(project, rel)) {
      side.push(`${rel} → .trash/`);
    }
  }
  return side;
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
