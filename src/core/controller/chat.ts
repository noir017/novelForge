import type { ChatController } from './index';
import { basename } from 'node:path';
import { describeArtifact } from '../features/artifact';
import { acceptArtifact as writeArtifact } from '../generation/accept';
import { Draft, parseDraftArtifact } from '../generation/generate';
import type { GateVerdict } from '../agent/policy';
import { askGate } from './gate';
import { scoped } from '../runtime/logger';
import { ChatSession } from '../model/session';
import {
  CreationJob,
  CreationTarget,
  JOB_LABEL,
  deriveNextStep,
  describeTarget,
  plotOfTarget,
  stageOfTarget,
} from '../model/pipeline';
import { SerializedArtifact } from '../protocol';
import { buildPlotPipelineView } from '../views/projectView';
import { buildPlotPipeline } from '../views/pipeline';
import { buildWorkbench } from '../views/workbench';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { isVolumeFilled } from '../model/volumeFile';
import { parseChapterFileName } from '../model/chapterFile';
import { isPlotPath } from '../files/fileOps';
import { Chapter } from '../model/types';
import { factsOf, serializeSession, targetOf } from './serialize';

const log = scoped('面板');

/** 创作页：采纳、目标与流水线。字段只给 controller/ 同包用。 */

/**
 * 这一轮的回复能不能采纳，以及采纳到哪里。
 *
 * **落点以 draft 为准**，不看会话当下选中的是哪一章：agent 可能在作者选着
 * 第 12 章时去改了第 9 章，拿 `c.current` 顶上会把落点说成另一章。
 *
 * 解析在这里跑一遍只是为了**画界面**（几段？覆盖谁？），真正落盘时
 * `acceptArtifact` 会拿气泡里当时的文本重新解析——用户可能改过。
 */
export async function describeArtifactOf(
  c: ChatController,
  content: string,
  draft: Pick<Draft, 'job' | 'target'>
): Promise<SerializedArtifact | undefined> {
  if (!content.trim()) {
    return undefined;
  }
  const artifact = parseDraftArtifact(draft.job, content);
  if (!artifact) {
    return undefined;
  }
  return {
    where: await describeTargetOf(c, draft.target),
    summary: describeArtifact(artifact),
    overwrites: await targetHasContent(c, draft.job, draft.target),
  };
}

/**
 * 采纳的落点上已经有东西了——卡片文案据此改成「覆盖…」。
 *
 * 只看**这一层自己的产物**。两件「拆」一律返回 false：拆卷与拆段都是往下加
 * 一份新的空壳，落点上本来就没东西，说「会覆盖」是吓唬人。
 */
export async function targetHasContent(
  c: ChatController,
  job: CreationJob,
  target: CreationTarget
): Promise<boolean> {
  switch (job) {
    case 'volumeList':
    case 'plotSegment':
      return false;

    case 'outline':
      return (await c.project.readOutline()).trim().length > 0;

    case 'volume': {
      // 落点是某一卷的卷纲。看错文件的话，写一卷空壳卷纲时会说「会覆盖」
      // ——覆盖的是 `outline.md`，而那份根本不动。
      if (target.kind !== 'volume') {
        return false;
      }
      const volume = await c.project.readVolume(target.volumeRelPath);
      return !!volume && isVolumeFilled(volume.sections);
    }

    case 'plot': {
      const relPath = plotOfTarget(target);
      if (!relPath) {
        return false;
      }
      // 只有**排过剧情**才算有内容。一份只带「目标」的骨架（拆段那一步产出的）
      // 说「会覆盖」是吓唬人——那正是接下来要填的东西。
      const plot = await c.project.readPlot(relPath);
      return !!plot && isPlotFilled(plot.sections);
    }

    // 正文是追加，不覆盖任何东西。
    case 'manuscript':
      return false;
  }
}

/**
 * 产物落盘前那一句问，以及同意之后的落盘。**第 19 条的落点。**
 *
 * ## 为什么是一张卡片，不是一颗按钮
 *
 * 从前这里是气泡末尾那颗「采纳写入」：它可以拖到第二天再点，于是
 * 「产物落盘前必须过一遍人」在界面上是一颗**可以永远不点的按钮**——而
 * agent 早就接着往下做了，作者手上攒着三份没落地的产物，谁也说不清哪份
 * 已经写过。现在它和别的动手请求（写文件、改一段字）长一个样、在同一个
 * 位置、**产出的当下就问**（[gate.ts](gate.ts)）。
 *
 * ## 与策略无关
 *
 * `agent/policy.ts` 那张五档表管的是「动手之前要不要先问一句」，三种模式
 * 各有各的松紧。这一问不在那张表里：**任何模式下都问**，包括「放手」。
 * 那是产品承诺（第 19 条），不是偏好设置。
 *
 * ## 落点从 draft 里取，不由前端传
 *
 * 前端猜不出一份产物该写到哪一层，而 agent 可能在作者选着第 12 章时去改了
 * 第 9 章——拿「当下选中的目标」当落点会把它写到别的地方去。
 *
 * **不打开写好的文件**：一轮里 agent 可能连着写好几份，一次次抢编辑器。
 *
 * 目标已有内容时，落盘那一步还会走 workspace 网关的覆盖审阅（插件开 diff）
 * ——那是另一层，与这一问无关，两层都过了才真的改磁盘。
 */
export async function askArtifact(
  c: ChatController,
  ask: {
    turnId: string;
    draft: Draft;
    art: SerializedArtifact;
    callId?: string;
    signal?: AbortSignal;
  }
): Promise<{ verdict: GateVerdict; relPath?: string; message: string }> {
  const { art, draft } = ask;
  const what = art.overwrites ? '覆盖' : '写入';
  const verdict = await askGate(
    c,
    {
      turnId: ask.turnId,
      callId: ask.callId,
      name: 'artifact',
      title: `Agent 要把生成的产物${what}到「${art.where}」`,
      detail: art.overwrites ? `${art.summary}
那里已经有内容了，写入前会让你先对比一遍。` : art.summary,
      skip: '不采纳',
    },
    ask.signal
  );
  if (verdict !== 'proceed') {
    return { verdict, message: '作者没有采纳这份产物，磁盘上什么都没变。' };
  }

  if (!draft.raw.trim()) {
    c.toast('内容是空的。', 'error');
    return { verdict, message: '内容是空的，没有写入任何文件。' };
  }
  const artifact = parseDraftArtifact(draft.job, draft.raw);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', JOB_LABEL[draft.job]);
    c.toast('这段内容解析不出可采纳的产物，没有写入任何文件。', 'error');
    return { verdict, message: '这段内容解析不出可写入的产物，没有写入任何文件。' };
  }

  const result = await writeArtifact(c.project, draft.target, artifact);
  c.toast(result.message);
  if (result.skipped || !result.relPath) {
    return { verdict, message: result.message };
  }
  await c.pushState();
  await pushPipeline(c);
  return { verdict, relPath: result.relPath, message: result.message };
}

/**
 * 切换当前在改哪个产物。阶段跟着 target 走。
 */
export async function setTarget(c: ChatController, target: CreationTarget): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，请先停止。', 'error');
    return;
  }
  c.current.target = target;
  c.current.stage = stageOfTarget(target);
  // 细纲已落盘时把章号同步过来：装配器在细纲尚未落盘时靠它定位前文边界，
  // 而这里正好知道答案。
  const relPath = plotOfTarget(target);
  if (relPath) {
    const plot = await c.project.readPlot(relPath);
    if (plot) {
      c.current.targetNo = plot.no;
    }
  }
  log.info(`创作目标切到 ${await describeCurrentTarget(c)}`);
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  await pushPipeline(c);
}

/**
 * 进入某一章：**由状态机决定落在哪一层**。
 *
 * 这是「选中一章 = 进入它当前该做的那一步」的实现。改造前前端一律发
 * `setTarget({kind:'manuscript'})`，于是点开一个连细纲都没排的章，
 * 界面直接把作者丢进正文层——四层流水线在创作页上等于不存在。
 *
 * 判断必须在后端：前端手上只有当前那一章的 pipeline，不知道别的章
 * 处于什么状态。
 *
 * **收的是「哪一段」或「哪一章」。** 界面上几个入口给的路径形状各不相同：
 *
 * - 剧情段那一行 → 真实的细纲路径
 * - 已发布的章那一行 → `chapters/003-夜访.md`（可能有来源段，也可能没有）
 * - 老工程的章 / 下拉框 → 一份**并不存在**的细纲路径（`plotPathForNo` 算出来的）
 *
 * `resolvePlotTarget` 把这三种都收敛成「一段 + 它交付的那几章」。
 */
export async function selectPlot(c: ChatController, plotRelPath: string): Promise<void> {
  const entry = await resolvePlotTarget(c, plotRelPath);
  if (!entry) {
    c.toast('这一章不存在，可能刚被改名或删除。', 'error');
    return;
  }
  const pipeline = await buildPlotPipeline(c.project, entry);
  const next = deriveNextStep(pipeline.stage, factsOf(pipeline));
  // 细纲还没有时落点用它**应该**在的位置（`plotPathForNo`，落在 `plots/` 根下）：
  // 选中它就是「去给这一章补规划」，装配器与工作区卡都能如实退化成空壳。
  const target = entry.plot?.relPath ?? c.project.plotPathForNo(entry.no, entry.chapter?.title ?? '');

  // 全做完了（next 为空）就停在正文——那是这一章的终点，也是最可能
  // 要回头改的一层。
  await setTarget(c, next ? targetOf(next, target) : { kind: 'manuscript', plotRelPath: target });
}

/**
 * 前端给的路径 → 这一段（含它交付的那几章）。两边都没有才算「不存在」。
 *
 * 三条路依次试：
 *
 * 1. 路径本身就是一份细纲 → 就是它。
 * 2. 路径是一个已发布的章 → 找**它的来源段**（拆分时记进 frontmatter 的落点）。
 *    找不到来源就只带这一章：那是老工程里的章，作者点开它是要去补规划。
 * 3. 路径是一份**还不存在**的细纲（`plotPathForNo` 算出来的）→ 按文件名里的
 *    号去找同号的章，让老工程的每一章都定位得到。
 *
 * 只有落在 `plots/` 之下的路径才当细纲读：`readPlot` 是纯解析，喂它一个章节
 * 文件也会**解析成功**（数字前缀 + `# 标题` 一样认得出），于是 target 会指进
 * `chapters/` 去，而场景目录与中转站正文都是按细纲路径镜像的——那一段的
 * 三层产物从此各找各的位置。
 *
 * **不再按号在两条轴之间互认**：段号与章号是两条轴（一段可以拆成三章），
 * 拿号去猜会指到一个毫不相干的段上。
 */
async function resolvePlotTarget(
  c: ChatController,
  relPath: string
): Promise<{ no: number; plot?: Plot; chapter?: Chapter } | undefined> {
  const chapters = await c.project.listChapters();

  // 1. 就是一份细纲。
  const plot = isPlotPath(c.project, relPath) ? await c.project.readPlot(relPath) : undefined;
  if (plot) {
    return { no: plot.no, plot };
  }

  // 2. 是一个已发布的章：找它的来源段。
  const direct = chapters.find((ch) => ch.relPath === relPath);
  if (direct) {
    const source = (await c.project.listPlots()).find((p) => p.chapters.includes(direct.relPath));
    return { no: source?.no ?? direct.order, plot: source, chapter: direct };
  }

  // 3. 是一份还不存在的细纲路径（老工程的章走这条）：按号找同号的章。
  const no =
    parsePlotFileName(basename(relPath))?.no ?? parseChapterFileName(basename(relPath))?.order;
  if (no === undefined || no <= 0) {
    return undefined;
  }
  const chapter = chapters.find((ch) => ch.order === no);
  return chapter ? { no, chapter } : undefined;
}

/**
 * 细纲改名后，把当前会话的目标指到新路径。
 *
 * 少了这一步，`current.target.plotRelPath` 还指着旧路径，创作页会拿到一份
 * 「这一章找不到」的空壳 pipeline——徽章回落成「待写剧情」、进度全归零、
 * 工作区卡说这一章不存在。而作者刚做的只是给它起个名字。
 *
 * **不走 `setTarget`**：那会把页签切到创作页。改个名不该把作者从工程页拽走。
 */
export async function retargetPlot(
  c: ChatController,
  fromRel: string,
  toRel: string
): Promise<void> {
  const current = plotOfTarget(c.current.target);
  if (!current || fromRel === toRel || current !== fromRel) {
    return;
  }
  c.current.target = { ...c.current.target, plotRelPath: toRel } as CreationTarget;
  log.info(`创作目标跟随改名`, `${current} → ${toRel}`);
  c.post({ type: 'session', session: serializeSession(c.current) });
  await pushPipeline(c);
}

/** 当前目标的人话描述。日志、落盘卡片、面包屑共用。 */
export async function describeCurrentTarget(c: ChatController): Promise<string> {
  return describeTargetOf(c, c.current.target);
}

/**
 * 任意 target 的人话描述。
 *
 * 与 `describeCurrentTarget` 分开是因为落点由 draft 决定，
 * 未必是作者当下选中的那一章——拿 `c.current` 顶上会把落点说成另一章。
 */
export async function describeTargetOf(c: ChatController, target: CreationTarget): Promise<string> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await c.project.readPlot(relPath);
  return describeTarget(target, { no: plot?.no, title: plot?.title });
}

/**
 * 推一份创作页的现场：流水线 + 工作区卡。
 *
 * **不推「下一步」**：那个判断现在只有 agent 一个消费者，它每回合自己算
 * （`agent/context.ts` 的状态注入，同一个 `deriveNextStep`）。界面上曾有一颗
 * 主按钮吃这一份，按钮删掉之后再推等于让两处各算一遍。
 *
 * **全书大纲阶段也推**：那一层没有「这一段的四层」，但一样有产物要看。
 */
export async function pushPipeline(c: ChatController): Promise<void> {
  const target = c.current.target;
  const relPath = plotOfTarget(target);
  const workbench = await buildWorkbench(c.project, target);

  if (!relPath) {
    c.post({ type: 'pipeline', workbench });
    return;
  }
  c.post({
    type: 'pipeline',
    pipeline: await buildPlotPipelineView(c.project, relPath),
    workbench,
  });
}

/**
 * 打开旧会话时把 target 补齐。
 *
 * `normalize` 是纯函数，查不了磁盘，所以只记得 `targetNo` 的会话会一律落到
 * 全书大纲。这里手上能读盘，把它还原成「正文 · 第 N 章」。
 */
export async function restoreTarget(c: ChatController, session: ChatSession): Promise<void> {
  if (session.target.kind !== 'outline' || session.targetNo === undefined) {
    return;
  }
  const plot = await c.project.getPlot(session.targetNo);
  if (plot) {
    session.target = { kind: 'manuscript', plotRelPath: plot.relPath };
    session.stage = 'manuscript';
  }
}
