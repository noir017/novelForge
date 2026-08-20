import type { ChatController } from './index';
import { basename } from 'node:path';
import { describeArtifact } from '../features/artifact';
import { acceptArtifact as writeArtifact } from '../generation/accept';
import { Draft, generate, parseDraftArtifact } from '../generation/generate';
import { getHost } from '../host';
import type { GateVerdict } from '../agent/policy';
import { askGate, cancelGates } from './gate';
import { scoped } from '../runtime/logger';
import {
  ChatSession,
  ChatTurn,
  deriveTitle,
  makeTurnId,
  nowIso,
  turnPreview,
} from '../model/session';
import {
  Capability,
  CreationStage,
  CreationTarget,
  DEFAULT_CAPABILITY,
  STAGE_CAPABILITIES,
  commandOf,
  deriveBookNextStep,
  deriveBookStage,
  deriveNextStep,
  describeTarget,
  isCreationStage,
  normalizeTarget,
  outputKindOf,
  plotOfTarget,
  stageOfTarget,
} from '../model/pipeline';
import {
  NextStepView,
  SendPayload,
  SerializedArtifact,
} from '../protocol';
import { buildPlotPipelineView } from '../views/projectView';
import { buildPlotPipeline } from '../views/pipeline';
import { buildWorkbench } from '../views/workbench';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { isVolumeFilled } from '../model/volumeFile';
import { parseChapterFileName } from '../model/chapterFile';
import { isPlotPath } from '../files/fileOps';
import { Chapter } from '../model/types';
import { persist } from './persist';
import {
  factsOf,
  serializeDigest,
  serializeSession,
  serializeTurn,
  targetOf,
} from './serialize';

const log = scoped('面板');

/** 创作页：发送、采纳、目标与流水线。字段只给 controller/ 同包用。 */

export async function send(c: ChatController, payload: SendPayload): Promise<void> {
  if (c.busy) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  // 空输入只挡「讨论」。
  //
  // 旧界面一律要求先写点什么才能发送，而「落定剧情」「拆成场景」「写这一场」
  // 本来就不需要作者说任何话——该说的都在剧情和场景卡里了。逼他先编一句
  // 「请生成」，那句话还会被当成要求装进 prompt。
  //
  // 讨论例外：它的全部内容就是作者那句话，没有话就没有讨论。
  const command = commandOf(payload.stage, payload.capability, c.current.target.kind);
  if (!payload.text.trim() && (command?.needsText ?? true)) {
    c.toast('请先输入内容。', 'error');
    return;
  }

  const userTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'user',
    content: payload.text.trim(),
    at: nowIso(),
    // 点命令时输入框可以是空的，气泡里就只剩一片空白。记下这一轮下的是哪个
    // 命令，界面才说得出「刚才那一下是 /落定剧情」。「讨论」是默认动作，不记。
    command: payload.capability === 'discuss' ? undefined : command?.label,
    attachments: c.pending.length > 0 ? [...c.pending] : undefined,
    excludedIds: payload.excludedIds.length > 0 ? payload.excludedIds : undefined,
  };
  c.current.turns.push(userTurn);
  if (c.current.turns.length === 1) {
    c.current.title = deriveTitle(turnPreview(userTurn));
  }
  applyAction(c, payload);
  c.current.targetNo = payload.targetNo;
  c.current.targetWords = payload.targetWords;
  c.pending = [];

  c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
  c.post({ type: 'attachments', items: [] });
  await persist(c);

  await runTurn(c, payload, userTurn);
}

/** 重来一轮：丢掉旧回复，用同一条用户消息重新生成。 */
export async function retry(c: ChatController, turnId: string, payload: SendPayload): Promise<void> {
  if (c.busy) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  const idx = c.current.turns.findIndex((t) => t.id === turnId);
  if (idx === -1) {
    return;
  }
  const userTurn = c.current.turns[idx];
  if (userTurn.role !== 'user') {
    return;
  }
  // 丢掉这条用户消息之后的所有轮次——重来意味着从这里分叉。
  c.current.turns.splice(idx + 1);
  c.post({ type: 'session', session: serializeSession(c.current) });
  await runTurn(c, { ...payload, text: userTurn.content }, userTurn);
}

export async function runTurn(c: ChatController, payload: SendPayload, userTurn: ChatTurn): Promise<void> {
  // 上一轮那张还没答的落盘卡片就此作废：它挂在上一条气泡上，点下去写的是
  // 一份作者已经翻篇的产物。
  cancelGates(c);
  // 并发控制在 controller：生成那一层是无状态的，「有没有在跑」是调度的事。
  const lease = c.beginGeneration();
  if (!lease) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  c.post({ type: 'busy', value: true });

  const assistantTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'assistant',
    content: '',
    at: nowIso(),
  };
  // 先插一条空回复，前端好挂流式内容。
  c.current.turns.push(assistantTurn);
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });

  // 历史是本轮之前的所有轮次（不含刚插入的两条）。
  const history = c.current.turns.slice(0, -2).filter((t) => t.content.trim());

  const action = { stage: c.current.stage, capability: c.current.capability };
  let built;
  let draft: Draft | undefined;
  try {
    ({ built, draft } = await generate(
      c.project,
      {
        action,
        target: c.current.target,
        targetNo: payload.targetNo,
        ask: userTurn.content,
        targetWords: payload.targetWords > 0 ? payload.targetWords : undefined,
        excludedIds: userTurn.excludedIds,
        attachments: userTurn.attachments,
        history,
      },
      {
        onDelta: (delta) => c.post({ type: 'delta', turnId: assistantTurn.id, text: delta }),
        // 推理模型可能先思考几十秒才开始吐正文。把思考也推给前端，
        // 否则那段时间气泡是空的，看起来就像卡住、最后一次性蹦出来。
        onReasoning: (delta, full) => {
          assistantTurn.reasoning = full;
          c.post({ type: 'reasoning', turnId: assistantTurn.id, text: delta });
        },
        onDone: (full) => {
          assistantTurn.content = full;
        },
        onError: (message) => {
          assistantTurn.error = message;
        },
        onCancelled: () => {
          assistantTurn.interrupted = true;
        },
      },
      { signal: lease.signal }
    ));
  } finally {
    lease.release();
  }

  c.post({ type: 'busy', value: false });

  if (built) {
    assistantTurn.context = serializeDigest(built);
    c.post({ type: 'context', turnId: assistantTurn.id, digest: assistantTurn.context });
  }
  // 产出的是可落盘的东西时，把落点与形状一起记下——卡片上要说清
  // 「拆出了 4 场，写到哪」，而不是一句光秃秃的「确定吗」。
  //
  // **不再重新解析一遍**：draft 出厂就带 artifact 与 summary。从前这里
  // 是三次解析里多余的那一次。
  if (draft?.artifact) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    assistantTurn.artifact = {
      where: await describeCurrentTarget(c),
      summary: draft.summary ?? describeArtifact(draft.artifact),
      overwrites: await targetHasContent(c),
    };
  }
  if (assistantTurn.error) {
    c.toast(assistantTurn.error, 'error');
  }
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  await persist(c);
  // 这一轮可能把某一层的产物写过（正文追加）——刷新流水线条。
  await pushPipeline(c);

  // 第 19 条：产物落盘前必须过一遍人。**在这里问，不是留一颗按钮**——
  // 先推完 turnDone（气泡定稿、可以就地改）再问，作者要改完再写得来及。
  if (draft?.artifact && assistantTurn.artifact && !assistantTurn.error && !assistantTurn.interrupted) {
    const r = await askArtifact(c, {
      turnId: assistantTurn.id,
      draft,
      art: assistantTurn.artifact,
      // 气泡里当下那份：作者在卡片上点写入之前可能刚改过（blur 时经
      // `editTurn` 落在这里），改了的那份才是他要的。
      raw: () => assistantTurn.content,
    });
    if (r.relPath) {
      assistantTurn.acceptedTo = r.relPath;
    } else {
      // 没写成也要留痕：翻回来看得出这一轮产出过什么、以及它没落盘。
      assistantTurn.artifact = { ...assistantTurn.artifact, declined: true };
    }
    await persist(c);
    c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  }
}

/**
 * 这一轮的回复能不能采纳，以及采纳到哪里。
 *
 * 两条路进来：
 *
 * - **重开旧会话**这类拿不到 draft 的（单步生成路径直接读 `draft.artifact`）——
 *   那时按会话当下的 stage/capability/target 算；
 * - **agent 那条路**：draft 的 action 与 target 是它自己定的（agent 可能在
 *   作者选着第 12 章时去改了第 9 章），所以**必须以 draft 为准**，拿
 *   `c.current` 顶上会把落点说成另一章。
 *
 * 解析在这里跑一遍只是为了**画界面**（几场？覆盖谁？），真正落盘时
 * `acceptArtifact` 会拿气泡里当时的文本重新解析——用户可能改过。
 */
export async function describeArtifactOf(
  c: ChatController,
  content: string,
  draft?: Pick<Draft, 'action' | 'target'>
): Promise<SerializedArtifact | undefined> {
  const action = draft?.action ?? { stage: c.current.stage, capability: c.current.capability };
  const target = draft?.target ?? c.current.target;
  if (outputKindOf(action) !== 'artifact' || !content.trim()) {
    return undefined;
  }
  const artifact = parseDraftArtifact(action, target, content);
  if (!artifact) {
    return undefined;
  }
  return {
    where: await describeTargetOf(c, target),
    summary: describeArtifact(artifact),
    overwrites: await targetHasContent(c, action, target),
  };
}

/**
 * 采纳的落点上已经有东西了——按钮文案据此改成「覆盖…」。
 *
 * 只看**这一层自己的产物**：拆章/拆场景本来就跳过已存在的，
 * 说「会覆盖」是吓唬人。
 */
export async function targetHasContent(
  c: ChatController,
  action: { stage: CreationStage; capability: Capability } = {
    stage: c.current.stage,
    capability: c.current.capability,
  },
  target: CreationTarget = c.current.target
): Promise<boolean> {
  const { stage, capability } = action;
  const relPath = plotOfTarget(target);
  if (stage === 'outline') {
    if (capability === 'split') {
      return false;
    }
    // 大纲这一层有两种落点：全书大纲，或某一卷的卷纲。看错文件的话，写一卷
    // 空壳卷纲时会说「会覆盖」——覆盖的是 `outline.md`，而那份根本不动。
    if (target.kind === 'volume') {
      const volume = await c.project.readVolume(target.volumeRelPath);
      return !!volume && isVolumeFilled(volume.sections);
    }
    return (await c.project.readOutline()).trim().length > 0;
  }
  if (!relPath || capability === 'split') {
    return false;
  }
  if (stage === 'plot') {
    // 只有**排过剧情**才算有内容。一份只带「目标」的骨架（拆章那一步产出的）
    // 说「会覆盖」是吓唬人——那正是接下来要填的东西。
    const plot = await c.project.readPlot(relPath);
    return !!plot && isPlotFilled(plot.sections);
  }
  if (stage === 'scene') {
    const sceneNo = target.kind === 'scene' ? target.sceneNo : undefined;
    return sceneNo !== undefined && !!(await c.project.readScene(relPath, sceneNo));
  }
  // 正文是追加，不覆盖任何东西。
  return false;
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
 * 前端猜不出一段讨论该写到哪一层。从前采纳按钮发的是 `store.session.target`
 * ——那是**当下**选中的目标，作者生成完切了一章再点采纳，产物就写到别的
 * 地方去了。
 *
 * `raw` 缺省用 `draft.raw`（模型产出的原文）。单步创作那条路传的是气泡里
 * 当下的文本：作者可以先在气泡里改完再点写入，那份改动经 `editTurn` 已经
 * 落在 `turn.content` 上。
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
    /** 谁在要求写。agent 那条路多一颗「停止 agent」，主语也不一样。 */
    byAgent?: boolean;
    callId?: string;
    /**
     * 要落盘的那份文本，**答完之后才取**（所以是个函数）：作者在卡片上点写入
     * 之前可能刚在气泡里改过，取早了拿到的是他改之前那份。
     */
    raw?: () => string;
    /** 写完要不要顺手打开它。单步创作打开（作者正盯着这一份），agent 不打开——它可能连着写好几份。 */
    open?: boolean;
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
      title: `${ask.byAgent ? 'Agent 要把生成的产物' : '把这份产物'}${what}到「${art.where}」`,
      detail: art.overwrites ? `${art.summary}\n那里已经有内容了，写入前会让你先对比一遍。` : art.summary,
      proceed: art.overwrites ? '覆盖并写入' : '写入',
      skip: '不采纳',
      stoppable: ask.byAgent,
    },
    ask.signal
  );
  if (verdict !== 'proceed') {
    return { verdict, message: '作者没有采纳这份产物，磁盘上什么都没变。' };
  }

  // 气泡里当下那份优先（作者可能改过），空了退回生成时那份原文。
  const edited = ask.raw?.();
  const raw = edited?.trim() ? edited : draft.raw;
  if (!raw.trim()) {
    c.toast('内容是空的。', 'error');
    return { verdict, message: '内容是空的，没有写入任何文件。' };
  }
  // **重新解析一遍**而不是用 `draft.artifact`：作者可能在气泡里改过。
  const artifact = parseDraftArtifact(draft.action, draft.target, raw);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', `阶段 ${draft.action.stage}·${draft.action.capability}`);
    c.toast('这段内容解析不出可采纳的产物，没有写入任何文件。', 'error');
    return { verdict, message: '这段内容解析不出可写入的产物，没有写入任何文件。' };
  }

  const result = await writeArtifact(c.project, draft.target, artifact);
  c.toast(result.message);
  if (result.skipped || !result.relPath) {
    return { verdict, message: result.message };
  }
  if (ask.open !== false) {
    await getHost().openFile(result.relPath);
  }
  await c.pushState();
  await pushPipeline(c);
  return { verdict, relPath: result.relPath, message: result.message };
}

/**
 * 切换当前在改哪个产物。
 *
 * 阶段跟着 target 走，能力回落到该阶段的默认值（一律 discuss）——
 * 从「正文·生成」切到剧情还留着「生成」，等于点一下就花钱重写一章的细纲。
 */
export async function setTarget(c: ChatController, target: CreationTarget): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，请先停止。', 'error');
    return;
  }
  c.current.target = target;
  c.current.stage = stageOfTarget(target);
  c.current.capability = DEFAULT_CAPABILITY[c.current.stage];
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
 * **不走 `setTarget`**：那会把 capability 重置成 discuss、把页签切到创作页。
 * 改个名不该让他刚挑好的命令消失，也不该把他从工程页拽走。
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

/**
 * 把这一轮请求里的 stage/capability/target 记进会话。
 *
 * 前端每次发送都带全量（它才知道用户点了哪个按钮），后端**校验一遍**：
 * 阶段认不出、或该阶段不支持这个能力时回落，绝不照单全收——那会让
 * `STAGE_CAPABILITIES` 这张表形同虚设。
 */
export function applyAction(c: ChatController, payload: SendPayload): void {
  const stage = isCreationStage(payload.stage) ? payload.stage : c.current.stage;
  const capability: Capability = STAGE_CAPABILITIES[stage].includes(payload.capability)
    ? payload.capability
    : DEFAULT_CAPABILITY[stage];
  if (capability !== payload.capability) {
    log.warn(
      `「${payload.capability}」不是${stage}阶段的能力，已回落到${capability}`,
      '前端的按钮组与 STAGE_CAPABILITIES 对不上了'
    );
  }
  c.current.stage = stage;
  c.current.capability = capability;
  c.current.target = normalizeTarget(payload.target);
}

/** 当前目标的人话描述。日志、落盘卡片、面包屑共用。 */
export async function describeCurrentTarget(c: ChatController): Promise<string> {
  return describeTargetOf(c, c.current.target);
}

/**
 * 任意 target 的人话描述。
 *
 * 与 `describeCurrentTarget` 分开是因为 agent 那条路上的落点由 draft 决定，
 * 未必是作者当下选中的那一章——拿 `c.current` 顶上会把落点说成另一章。
 */
export async function describeTargetOf(c: ChatController, target: CreationTarget): Promise<string> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await c.project.readPlot(relPath);
  const sceneNo =
    target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;
  const sceneTitle =
    sceneNo === undefined ? undefined : (await c.project.readScene(relPath, sceneNo))?.title;
  return describeTarget(target, { no: plot?.no, title: plot?.title, sceneTitle });
}

/**
 * 推一份创作页的现场：流水线 + 工作区卡 + 下一步。
 *
 * **全书大纲阶段也推**（改造前那时直接 return）：那一层没有「这一章的四段」，
 * 但一样有产物要看、有下一步要做——大纲是空的就该去写大纲。
 */
export async function pushPipeline(c: ChatController): Promise<void> {
  const target = c.current.target;
  const relPath = plotOfTarget(target);
  const workbench = await buildWorkbench(c.project, target);

  if (!relPath) {
    c.post({ type: 'pipeline', workbench, next: await bookNextStep(c) });
    return;
  }
  const pipeline = await buildPlotPipelineView(c.project, relPath);
  const step = deriveNextStep(pipeline.stage, factsOf(pipeline));
  c.post({
    type: 'pipeline',
    pipeline,
    workbench,
    next: step ? { ...step, target: targetOf(step, relPath), no: pipeline.no } : undefined,
  });
}

/**
 * 全书大纲那一层的下一步。
 *
 * 判据在纯函数层（`deriveBookStage` / `deriveBookNextStep`），这里只取数：
 * 没有大纲就写大纲，有大纲一卷都没拆就拆卷，有卷一段都没拆就去第一卷拆段。
 * 都齐了就不催——此时该做的是挑一段进去，而那是用户的选择，不是系统能替他定的。
 *
 * `plots` 那一档的落点是**第一卷**：纯函数层挑不了卷（它手上没有卷列表），
 * 而「去拆段」必须指着某一卷才点得下去。
 */
export async function bookNextStep(c: ChatController): Promise<NextStepView | undefined> {
  const [outline, plots, chapters, volumes] = await Promise.all([
    c.project.readOutline(),
    c.project.listPlots(),
    c.project.listChapters(),
    c.project.listVolumes(),
  ]);
  const stage = deriveBookStage({
    outlineFilled: outline.trim().length > 0,
    volumeCount: volumes.length,
    plotCount: plots.length + chapters.length,
  });
  const step = deriveBookNextStep(stage);
  if (!step) {
    return undefined;
  }
  const target: CreationTarget =
    stage === 'plots' && volumes[0]
      ? { kind: 'volume', volumeRelPath: volumes[0].relPath }
      : { kind: 'outline' };
  return { ...step, target };
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
    session.capability = DEFAULT_CAPABILITY.manuscript;
  }
}
