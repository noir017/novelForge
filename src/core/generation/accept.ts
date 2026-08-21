/**
 * 采纳：把一份产物写进磁盘。按 target 分派到五条落盘路径。
 *
 * ## 与生成分开的那一步
 *
 * `generate` 只把文本交回界面，一个字都不写磁盘；这里才写，且只在用户点了
 * 采纳之后（AGENTS 第 19 条）。中间那一步是用户看着产物决定要不要的机会——
 * 少了它，「不静默覆盖」无从谈起。
 *
 * ## 守卫不在这里
 *
 * 落盘一律经 `workspace/` 网关：越界、同名、大小、乐观锁、覆盖审阅、
 * `.trash`、伴生搬迁、`upstreamHash` 记账，全在那一层做一次。
 * 本模块只做**分派**与**人话消息**——每条路径的「跳过了哪几卷」「原有几段
 * 未动」必须说出来，默默少建三卷，作者要到写到那里才发现。
 */
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, PlotSections, emptyPlotSections } from '../model/plotFile';
import { emptyVolumeSections } from '../model/volumeFile';
import { CreationTarget, plotOfTarget, volumeLabel, volumeOfTarget } from '../model/pipeline';
import { Artifact, PlotOutlineItem, VolumeOutlineItem } from '../features/artifact';
import { volumeContentHash } from '../views/pipeline';
import { Workspace, pathOfTarget } from '../workspace';

const log = scoped('创作');

/** 采纳的结果。`relPath` 是落盘位置，`skipped` 表示用户在审阅时放弃了。 */
export interface AcceptResult {
  relPath?: string;
  skipped?: boolean;
  /** 一句人话，直接进 toast。 */
  message: string;
}

/**
 * 采纳产物，写进磁盘。
 *
 * **每一条覆盖已有内容的路径都走网关的覆盖审阅。** 唯一的例外是正文追加
 * （append）——那本来就是往后加，不覆盖任何东西。
 */
export async function acceptArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact
): Promise<AcceptResult> {
  const ws = new Workspace(project);
  switch (artifact.kind) {
    case 'outlineDoc':
      // 两个阶段都产出 `outlineDoc`：全书大纲、或某一卷的卷纲。两者都是整篇
      // 替换、覆盖前审阅，只是落点不同——落点看 target，不看 stage。
      return target.kind === 'volume'
        ? acceptVolumeDoc(project, ws, target.volumeRelPath, artifact.text)
        : acceptOutline(project, ws, artifact.text);
    case 'volumeList':
      return acceptVolumeList(project, ws, artifact.volumes);
    case 'plotSegment':
      return acceptPlotSegment(project, ws, target, artifact.segment);
    case 'plot':
      return acceptPlot(project, ws, target, artifact.sections);
    case 'manuscript':
      return acceptManuscript(project, ws, target, artifact.text);
  }
}

/** 全书大纲：整篇替换，覆盖前审阅。 */
async function acceptOutline(
  project: NovelProject,
  ws: Workspace,
  text: string
): Promise<AcceptResult> {
  const rel = project.relPath(project.outlinePath);
  const r = await ws.write(
    rel,
    { artifact: { kind: 'outlineDoc', text } },
    { mode: 'overwrite', what: '全书大纲' }
  );
  if (r.skipped) {
    return { skipped: true, message: '没有改动大纲。' };
  }
  log.info('全书大纲已更新', `${rel}｜${text.length} 字`);
  return { relPath: rel, message: `已写入 ${rel}` };
}

/**
 * 卷纲：整篇替换，覆盖前审阅。
 *
 * 卷纲没有自己的结构化产物——「写这一卷的卷纲」产出的就是一段 Markdown
 * （`outlineDoc`），落点由 target 决定。四个小节由 `parseVolumeFile` 从落盘的
 * 文本里再读回来，作者手改的那份也一样读得回来。
 */
async function acceptVolumeDoc(
  project: NovelProject,
  ws: Workspace,
  volumeRelPath: string,
  text: string
): Promise<AcceptResult> {
  const volume = await project.readVolume(volumeRelPath);
  const what = volume ? `${volumeLabel(volume.no, volume.title)}的卷纲` : '这一卷的卷纲';
  const r = await ws.write(volumeRelPath, { text: `${text.trim()}\n` }, { mode: 'overwrite', what });
  if (r.skipped) {
    return { skipped: true, message: '没有改动这一卷。' };
  }
  log.info(`${what}已写入`, r.rel);
  return { relPath: r.rel, message: `已写入 ${r.rel}` };
}

/**
 * 大纲拆卷：为每一卷建一份卷纲。
 *
 * **已存在的卷号一律跳过，绝不覆盖**——作者可能已经把第一卷的卷纲改得很细，
 * 再拆一次大纲不该把它抹掉。跳过的必须说出来。
 *
 * **不建剧情段**：段由「从这一卷拆出剧情段」一次一个地拆出来。拆卷那一步顺手
 * 铺几十个空段，只会让作者以为工具替他排好了剧情。
 */
async function acceptVolumeList(
  project: NovelProject,
  ws: Workspace,
  volumes: VolumeOutlineItem[]
): Promise<AcceptResult> {
  const outlineHash = hash(await project.readOutline());
  let next = await project.nextVolumeNo();
  const taken = new Set((await project.listVolumes()).map((v) => v.no));
  const created: string[] = [];
  const skipped: number[] = [];

  for (const item of volumes) {
    const no = item.no && item.no > 0 ? item.no : next;
    if (taken.has(no)) {
      skipped.push(no);
      next = Math.max(next, no + 1);
      continue;
    }
    taken.add(no);
    const rel = await ws.writeVolume({
      no,
      // 标题原样存进 frontmatter，**不预先清洗**：清洗是为了拼文件名，
      // 由 `writeVolume` 自己做。
      title: item.title,
      upstreamHash: outlineHash,
      done: false,
      // 「目标」+「剧情走向」两节：拆卷这一步能答的就这两样，另两节留空等
      // 作者或下一次「写这一卷的卷纲」补。`isVolumeFilled` 只看「剧情走向」，
      // 所以只给目标时流水线会如实说这一卷还没排。
      sections: { ...emptyVolumeSections(), 目标: item.goal, 剧情走向: item.arc },
    });
    created.push(rel);
    next = Math.max(next, no + 1);
  }

  const note = skipped.length > 0 ? `，跳过已存在的第 ${skipped.join('、')} 卷` : '';
  log.info(`已建 ${created.length} 卷的卷纲`, `${created.join('、') || '（无）'}${note}`);
  return {
    relPath: created[0],
    message: `已新建 ${created.length} 卷${note}。`,
  };
}

/**
 * 卷纲拆段：在这一卷里建**一个**只有「目标」的剧情段。
 *
 * 段号取全书下一个可用号（`nextPlotNo`），落点是这一卷的段目录
 * （`plots/<卷词干>/`）——归属靠目录，不落 frontmatter。
 *
 * **一次一段**是这条路的全部意义（见 features/artifact.ts 的 `plotSegment`）。
 * 只填「目标」：这一步产出的是骨架，剧情脉络要另外一次调用才排得出。
 * 「目标」不算 filled（`isPlotFilled` 只看剧情脉络），所以流水线会如实停在
 * 「待写剧情」，不会因为骨架存在就显示已规划。
 */
async function acceptPlotSegment(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  item: PlotOutlineItem
): Promise<AcceptResult> {
  const volumeRelPath = volumeOfTarget(target);
  if (!volumeRelPath) {
    throw new Error('这个剧情段不属于任何一卷。请先选中要拆的那一卷。');
  }
  const volume = await project.readVolume(volumeRelPath);
  if (!volume) {
    throw new Error(`找不到卷纲 ${volumeRelPath}，可能刚被改名或删除。`);
  }

  const rel = await ws.writePlot(
    {
      no: await project.nextPlotNo(),
      title: item.title,
      arc: item.arc,
      // 上游是**这一卷**，不是全书大纲：改一卷的走向只该让那一卷的段标脏。
      upstreamHash: volumeContentHash(volume),
      done: false,
      chapters: [],
      sections: { ...emptyPlotSections(), 目标: item.goal },
    },
    undefined,
    project.plotsMirrorRelPathForVolume(volumeRelPath)
  );

  await project.syncManifest();
  const count = (await project.listPlotsOfVolume(volumeRelPath)).length;
  log.info(`${volumeLabel(volume.no, volume.title)}拆出一个剧情段`, `${rel}｜本卷已有 ${count} 段`);
  return { relPath: rel, message: `已新建剧情段 ${rel}。` };
}

/**
 * 一章的细纲：整份替换，覆盖前审阅。
 *
 * 渲染与记 `upstreamHash` 都在网关的 plot handler 里——四个小节换新，
 * 标题/幕/目标字数/done 沿用磁盘那份（「重写剧情」不该抹掉作者起的标题）。
 */
async function acceptPlot(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  sections: PlotSections
): Promise<AcceptResult> {
  const plot = await requirePlot(project, target);
  const r = await ws.write(
    plot.relPath,
    { artifact: { kind: 'plot', sections } },
    { mode: 'overwrite', what: `第 ${plot.no} 章的细纲` }
  );
  if (r.skipped) {
    return { skipped: true, message: '没有改动这一章。' };
  }
  log.info(`第 ${plot.no} 章的细纲已写入`, plot.relPath);
  return { relPath: plot.relPath, message: `已写入 ${plot.relPath}` };
}

/**
 * 正文：追加到这一章的中转站正文末尾。
 *
 * `upstreamHash` 由网关的 manuscript handler 记——正文所依据的细纲指纹。
 * 少了它这一章会永远显示「正文与场景对不上」或永远不显示，两种都是错的。
 *
 * **落在 `manuscripts/`，不是 `chapters/`。** 切成发布章节是作者的活，
 * 工具不代劳（见 model/plotFile.ts 的文件头）。
 *
 * 追加是唯一不走覆盖审阅的落盘路径——它不覆盖任何东西。
 */
async function acceptManuscript(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  text: string
): Promise<AcceptResult> {
  const plot = await requirePlot(project, target);
  const r = await ws.write(
    pathOfTarget(project, { kind: 'manuscript', plotRelPath: plot.relPath }),
    { artifact: { kind: 'manuscript', text } },
    { mode: 'append' }
  );
  await project.syncManifest();

  log.info(`已追加 ${text.length} 字到剧情段 ${plot.no}`, `${r.rel}｜该段摘要将变为过期`);
  return { relPath: r.rel, message: `已写入 ${r.rel}` };
}

/** target 指向的细纲。找不到就抛——采纳路径上，写到一个不存在的地方比报错更糟。 */
async function requirePlot(project: NovelProject, target: CreationTarget): Promise<Plot> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    throw new Error('这个产物不属于任何章。');
  }
  const plot = await project.readPlot(relPath);
  if (!plot) {
    throw new Error(`找不到细纲 ${relPath}，可能刚被改名或删除。`);
  }
  return plot;
}
