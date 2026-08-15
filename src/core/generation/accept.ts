/**
 * 采纳：把一份产物写进磁盘。按 target 分派到六条落盘路径。
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
 * `.trash`、伴生搬迁、`upstreamHash` / `beatsHash` 记账，全在那一层做一次。
 * 本模块只做**分派**与**人话消息**——每条路径的「跳过了哪几章」「原有几场
 * 未动」必须说出来，默默少建三章，作者要到写到那里才发现。
 */
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, PlotSections, emptyPlotSections } from '../model/plotFile';
import { emptySceneSections } from '../model/sceneFile';
import { CreationTarget, plotOfTarget } from '../model/pipeline';
import { Artifact, PlotOutlineItem, SceneOutlineItem } from '../features/artifact';
import { plotContentHash } from '../views/pipeline';
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
      return acceptOutline(project, ws, artifact.text);
    case 'plotList':
      return acceptPlotList(project, ws, artifact.plots);
    case 'plot':
      return acceptPlot(project, ws, target, artifact.sections);
    case 'sceneList':
      return acceptSceneList(project, ws, target, artifact.scenes);
    case 'scene':
      return acceptScene(project, ws, target, artifact);
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
 * 大纲拆章：为每一章建一份只有「目标」的细纲文件。
 *
 * **不建章节文件**。从前这里会顺手为每一章建一个 0 字的正文文件，因为那时
 * 细纲/场景/摘要三套镜像路径全挂在章节的 relPath 上，没有章节文件产物就
 * 无处安放。现在伴生路径挂在细纲自己身上，`chapters/` 是作者拆好正文之后
 * 才会有东西的发布区——拆个章就往那里塞几十个空文件，只会让他以为工具替他
 * 分好了章。
 *
 * **已存在的章号一律跳过，绝不覆盖。**
 */
async function acceptPlotList(
  project: NovelProject,
  ws: Workspace,
  plots: PlotOutlineItem[]
): Promise<AcceptResult> {
  const outlineHash = hash(await project.readOutline());
  let next = await project.nextPlotNo();
  const taken = new Set((await project.listPlots()).map((p) => p.no));
  const created: string[] = [];
  const skipped: number[] = [];

  for (const item of plots) {
    const no = item.no && item.no > 0 ? item.no : next;
    if (taken.has(no)) {
      skipped.push(no);
      next = Math.max(next, no + 1);
      continue;
    }
    taken.add(no);
    const rel = await ws.writePlot({
      no,
      // 标题原样存进 frontmatter，**不预先清洗**：清洗是为了拼文件名，
      // 由 `writePlot` 自己做。在这里洗一遍的话，标题里的空格会变成短横线，
      // 而空标题会变成「未命名」四个字——那是个假标题，还会进上下文。
      title: item.title,
      arc: item.arc,
      upstreamHash: outlineHash,
      done: false,
      // 只填「目标」：这一步产出的是骨架，剧情脉络要另外一次调用才排得出。
      // 「目标」不算 filled（isPlotFilled 只看剧情脉络），所以流水线会如实
      // 停在「待写剧情」，不会因为骨架存在就显示已规划。
      sections: { ...emptyPlotSections(), 目标: item.goal },
    });
    created.push(rel);
    next = Math.max(next, no + 1);
  }

  await project.syncManifest();
  // 跳过的必须说出来。默默少建三章，作者要到写到那里才发现。
  const note = skipped.length > 0 ? `，跳过已存在的第 ${skipped.join('、')} 章` : '';
  log.info(`已建 ${created.length} 章的细纲`, `${created.join('、') || '（无）'}${note}`);
  return {
    relPath: created[0],
    message: `已新建 ${created.length} 章${note}。`,
  };
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
 * 剧情拆场景：为每一场建一个场景文件。
 *
 * 与拆章一样**不覆盖**：已经存在的场号跳过。作者花时间设计过的场景
 * 被一次重新拆分抹掉，是这条路上最贵的错误。
 */
async function acceptSceneList(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  scenes: SceneOutlineItem[]
): Promise<AcceptResult> {
  const plot = await requirePlot(project, target);
  const upstreamHash = plotContentHash(plot);
  const existing = await project.listScenes(plot.relPath);
  const taken = new Set(existing.map((s) => s.no));

  let no = 0;
  const created: string[] = [];
  for (const item of scenes) {
    do {
      no++;
    } while (taken.has(no));
    taken.add(no);
    const rel = await ws.writeScene(plot.relPath, {
      plotRelPath: plot.relPath,
      no,
      title: item.title,
      place: item.place,
      time: item.time,
      characters: item.characters,
      targetWords: item.targetWords,
      upstreamHash,
      // 刚拆出来的是壳，还没设计过——status 如实说 draft。
      status: 'draft',
      sections: {
        ...emptySceneSections(),
        目的: item.goal,
      },
    });
    created.push(rel);
  }

  const note = existing.length > 0 ? `，原有 ${existing.length} 场未动` : '';
  log.info(`第 ${plot.no} 章拆出 ${created.length} 场`, `${created.join('、')}${note}`);
  return { relPath: created[0], message: `已拆出 ${created.length} 场${note}。` };
}

/**
 * 单张场景卡：整张替换，覆盖前审阅。
 *
 * 落点、渲染与记 `upstreamHash` 都在网关的 scene handler 里：标题沿用磁盘
 * 那份（标题决定文件名，改写一张卡不该顺手改文件名），status 由
 * `isSceneReady` 推，改了标题时清掉旧文件名。
 */
async function acceptScene(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  artifact: Extract<Artifact, { kind: 'scene' }>
): Promise<AcceptResult> {
  const plot = await requirePlot(project, target);
  const sceneNo = target.kind === 'scene' ? target.sceneNo : undefined;
  if (sceneNo === undefined) {
    throw new Error('没有指定是哪一场。');
  }

  const r = await ws.write(
    pathOfTarget(project, { kind: 'scene', plotRelPath: plot.relPath, sceneNo }),
    { artifact },
    { mode: 'overwrite', what: `第 ${plot.no} 章 · 场景 ${sceneNo}` }
  );
  if (r.skipped) {
    return { skipped: true, message: '没有改动这一场。' };
  }
  log.info(`第 ${plot.no} 章场景 ${sceneNo} 已写入`, r.rel);
  return { relPath: r.rel, message: `已写入 ${r.rel}` };
}

/**
 * 正文：追加到这一章的中转站正文末尾。
 *
 * `beatsHash` 由网关的 manuscript handler 记——正文所依据的场景指纹。
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

  // 写的是某一场时，把那一场标成 written，流水线进度才走得动。
  const sceneNo = target.kind === 'manuscript' ? target.sceneNo : undefined;
  if (sceneNo !== undefined) {
    const scene = await project.readScene(plot.relPath, sceneNo);
    if (scene && scene.status !== 'written') {
      await ws.writeScene(plot.relPath, { ...scene, status: 'written' });
    }
  }
  await project.syncManifest();

  log.info(
    `已追加 ${text.length} 字到第 ${plot.no} 章`,
    `${r.rel}｜该章摘要将变为过期${sceneNo !== undefined ? `｜场景 ${sceneNo} 已标记写完` : ''}`
  );
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
