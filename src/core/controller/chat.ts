import type { ChatController } from './index';
import { basename } from 'node:path';
import { describeArtifact } from '../features/artifact';
import { acceptArtifact as writeArtifact, plannedCards } from '../generation/accept';
import { Draft, generate, parseDraftArtifact } from '../generation/generate';
import { getHost } from '../host';
import type { GateVerdict } from '../agent/policy';
import { askGate, askGateNoted, cancelGates } from './gate';
import { scoped } from '../runtime/logger';
import {
  ChatSession,
  ChatTurn,
  deriveTitle,
  makeTurnId,
  normalizeRange,
  nowIso,
  turnPreview,
} from '../model/session';
import {
  Capability,
  CreationStage,
  CreationTarget,
  DEFAULT_CAPABILITY,
  PLOT_BATCH,
  STAGE_CAPABILITIES,
  WriteMode,
  commandOf,
  describeWriteLength,
  deriveBookStage,
  deriveNextStep,
  describeTarget,
  isCreationStage,
  normalizeTarget,
  outputKindOf,
  plotOfTarget,
  stageOfTarget,
} from '../model/pipeline';
import { isSettingFilled } from '../model/settingFile';
import { isOutlineFilled, outlineOverlaps } from '../model/outlineFile';
import {
  ChapterAction,
  NextStepView,
  SendPayload,
  SerializedArtifact,
} from '../protocol';
import { bookStepView, buildPlotPipelineView } from '../views/projectView';
import { buildBookFacts, buildPlotPipeline, chapterOfPlotNo } from '../views/pipeline';
import { buildWorkbench } from '../views/workbench';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { isPlotPath } from '../files/fileOps';
import { Chapter } from '../model/types';
import {
  ReviewIssueEdit,
  applyReviewEdits,
  describePicks,
  normalizeReport,
  pickableIds,
  relocatePicks,
  renderReport,
  renderRevisionBrief,
} from '../model/review';
import { PREFLIGHT_SUGGESTION, describeExempted, describeRisks, preflightChapter } from '../features/preflight';
import { clearFailures } from '../runtime/errorLog';
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

/**
 * `extra`：后端自己发起的那几种轮次要记在用户轮上的东西（按审稿修稿的清单与写法）。前端发的
 * `send` 不带它——`SendPayload.writeMode` 只认「接着写 / 重写」，修稿只能从报告卡进来。
 */
export async function send(
  c: ChatController,
  payload: SendPayload,
  extra?: Pick<ChatTurn, 'writeMode' | 'command' | 'revise'>
): Promise<void> {
  // 占位必须在**任何 await 之前**：下面 `await persist(c)` 会让出事件循环，
  // 那一瞬间 currentAbort 还没设，紧跟着进来的第二条请求照样能过 busy 检查，
  // 于是两条都跑起来、烧两份 token。本机磁盘快，第一条往往一路同步跑完，
  // 所以这个竞态只在 CI（或慢盘）上现形。
  const lease = c.beginGeneration();
  if (!lease) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  // 从这里往下任何一条提前 return 都要还位，否则这个 controller 从此发不出
  // 第二条消息。
  let handedOff = false;
  try {
    // 空输入只挡「讨论」（它不是命令，`commandOf` 查不到它）。
    //
    // 旧界面一律要求先写点什么才能发送，而「落定细纲」「写细纲」「写正文」
    // 本来就不需要作者说任何话——该说的都在架构、大纲与细纲里了。逼他先编一句
    // 「请生成」，那句话还会被当成要求装进 prompt。
    //
    // 讨论例外：它的全部内容就是作者那句话，没有话就没有讨论。
    const command = commandOf(payload.stage, payload.capability);
    if (!payload.text.trim() && !command) {
      c.toast('请先输入内容。', 'error');
      return;
    }

    const userTurn: ChatTurn = {
      id: makeTurnId(),
      role: 'user',
      content: payload.text.trim(),
      at: nowIso(),
      // 点命令时输入框可以是空的，气泡里就只剩一片空白。记下这一轮下的是哪个
      // 命令，界面才说得出「刚才那一下是 /落定细纲」。「讨论」是默认动作，不记。
      command: payload.capability === 'discuss' ? undefined : command?.label,
      attachments: c.pending.length > 0 ? [...c.pending] : undefined,
      excludedIds: payload.excludedIds.length > 0 ? payload.excludedIds : undefined,
      // 重来一轮时要原样重跑，而那条路上前端给的是输入框当下的参数。
      range: normalizeRange(payload.range),
      setup: normalizeSetup(payload.setup),
      writeMode: normalizeWriteMode(payload.writeMode),
      ...(extra ?? {}),
    };
    c.current.turns.push(userTurn);
    if (c.current.turns.length === 1) {
      c.current.title = deriveTitle(turnPreview(userTurn));
    }
    applyAction(c, payload);
    c.current.targetNo = payload.targetNo;
    c.pending = [];

    c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
    c.post({ type: 'attachments', items: [] });
    await persist(c);

    // 位子交给 runTurn，由它在 finally 里还——这里不能再还一次。
    handedOff = true;
    await runTurn(c, payload, userTurn, lease);
  } finally {
    if (!handedOff) {
      lease.release();
    }
  }
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

export async function runTurn(
  c: ChatController,
  payload: SendPayload,
  userTurn: ChatTurn,
  held?: ReturnType<ChatController['beginGeneration']>
): Promise<void> {
  // 上一轮那张还没答的落盘卡片就此作废：它挂在上一条气泡上，点下去写的是
  // 一份作者已经翻篇的产物。
  cancelGates(c);
  // 并发控制在 controller：生成那一层是无状态的，「有没有在跑」是调度的事。
  //
  // `send` 已经在它的第一行占过位了（那里必须早于任何 await，否则两条请求
  // 会双双过检）。它把位子传进来，这里就不再抢第二次——同一个 controller
  // 上抢不到，会把自己拒掉。retry 那条路没有前置占位，仍走这里现抢。
  const lease = held ?? c.beginGeneration();
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
  const range = rangeFor(action, normalizeRange(payload.range) ?? userTurn.range);
  const setup = action.stage === 'setting' ? (normalizeSetup(payload.setup) ?? userTurn.setup) : undefined;
  // 修稿那一轮的写法记在用户轮上（前端的 payload 永远不带 revise）；重来一轮时照样认得出来。
  const writeMode =
    action.stage === 'manuscript' && action.capability === 'generate'
      ? userTurn.writeMode === 'revise'
        ? 'revise'
        : (normalizeWriteMode(payload.writeMode) ?? userTurn.writeMode)
      : undefined;

  // 动手之前的两道：修稿先按报告与此刻的正文拼好清单；写一章之前先做一致性预检（零调用）。
  // 任何一道拦下，这一轮就不调模型，回复里写明为什么停。
  const before = await beforeGenerate(c, { action, writeMode, userTurn, assistantTurn, signal: lease.signal });
  if (!before.go) {
    lease.release();
    c.post({ type: 'busy', value: false });
    if (before.error) {
      assistantTurn.error = before.error;
      c.toast(before.error, 'error');
    } else {
      assistantTurn.content = before.content ?? '';
      assistantTurn.interrupted = before.interrupted || undefined;
    }
    c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
    await persist(c);
    return;
  }

  let built;
  let draft: Draft | undefined;
  try {
    ({ built, draft } = await generate(
      c.project,
      {
        action,
        target: c.current.target,
        targetNo: range?.from ?? payload.targetNo,
        ask: userTurn.content,
        range,
        setup,
        writeMode,
        ...(before.reviseBrief ? { reviseBrief: before.reviseBrief } : {}),
        // 目标字数只有一处来源：细纲的 `targetWords`，没写就是配置的每章字数。
        // 从前输入框下面还有一个（默认 2000），作者分不清哪个生效（W1）。
        targetWords: await targetWordsOf(c, c.current.target),
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
        // 写正文时气泡顶上那条进度（W7）：第几轮、写到多少字、目标多少。
        onProgress: (p) => c.post({ type: 'writeProgress', turnId: assistantTurn.id, ...p }),
        onReset: (full) => c.post({ type: 'streamReset', turnId: assistantTurn.id, text: full }),
      },
      // 作者在这个会话上选的那一档。第 12 条的另一面：**只有对话页选定的
      // 那个模型**吃它，工程页的批量任务不吃。
      { signal: lease.signal, thinking: c.current.thinking }
    ));
  } finally {
    lease.release();
  }

  c.post({ type: 'busy', value: false });

  if (built) {
    assistantTurn.context = serializeDigest(built);
    c.post({ type: 'context', turnId: assistantTurn.id, digest: assistantTurn.context });
  }
  // 修稿时重新定位清单的说明排在最前：「正文在审稿之后改过，两条作废」比续写几轮更要紧。
  if (draft && before.notes?.length) {
    draft.notes = [...before.notes, ...(draft.notes ?? [])];
  }
  // 审稿报告（D22）：不落盘，随会话保存——草稿表里一份、这一轮上一份（报告卡照它画）。
  // 没有 artifact，所以下面那张落盘卡片不会出现。
  if (draft?.review) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    assistantTurn.review = {
      report: draft.review,
      ...(draft.notes?.length ? { notes: draft.notes } : {}),
      ...(draft.calls ? { calls: draft.calls } : {}),
    };
  }
  // 产出的是可落盘的东西时，把落点与形状一起记下——卡片上要说清
  // 「新建 5 张角色卡，写到哪」，而不是一句光秃秃的「确定吗」。
  //
  // **不再重新解析一遍**：draft 出厂就带 artifact 与 summary。从前这里
  // 是三次解析里多余的那一次。
  if (draft?.artifact) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    const creates = await plannedCards(c.project, draft.artifact);
    assistantTurn.artifact = {
      where: await describeTargetOf(c, draft.target, draft.range),
      summary: draft.summary ?? describeArtifact(draft.artifact),
      overwrites: await targetHasContent(c, action, draft.target, draft.range, draft.writeMode),
      ...(creates.length > 0 ? { creates } : {}),
      ...(draft.notes?.length ? { notes: draft.notes } : {}),
      ...(draft.calls ? { calls: draft.calls } : {}),
      ...writingOf(draft),
    };
  }
  if (assistantTurn.error) {
    c.toast(assistantTurn.error, 'error');
  }
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  await persist(c);
  // 这一轮可能把某一层的产物写过——刷新流水线条。
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
  draft?: Pick<Draft, 'action' | 'target' | 'range' | 'notes' | 'calls' | 'writeMode' | 'length' | 'replay'>
): Promise<SerializedArtifact | undefined> {
  const action = draft?.action ?? { stage: c.current.stage, capability: c.current.capability };
  const target = draft?.target ?? c.current.target;
  if (outputKindOf(action) !== 'artifact' || !content.trim()) {
    return undefined;
  }
  const artifact = parseDraftArtifact(action, content, target, draft?.range);
  if (!artifact) {
    return undefined;
  }
  const creates = await plannedCards(c.project, artifact);
  return {
    where: await describeTargetOf(c, target, draft?.range),
    summary: describeArtifact(artifact),
    overwrites: await targetHasContent(c, action, target, draft?.range, draft?.writeMode),
    ...(creates.length > 0 ? { creates } : {}),
    ...(draft?.notes?.length ? { notes: draft.notes } : {}),
    ...(draft?.calls ? { calls: draft.calls } : {}),
    ...(draft ? writingOf(draft) : {}),
  };
}

/** 正文那几样要摊在卡片上的事：写了多长、是不是追加、有没有重演上一章结尾（W7）。 */
function writingOf(draft: Pick<Draft, 'length' | 'replay' | 'writeMode'>): Partial<SerializedArtifact> {
  return {
    ...(draft.length ? { length: draft.length } : {}),
    ...(draft.replay ? { replay: draft.replay } : {}),
    ...(draft.writeMode === 'continue' ? { append: true } : {}),
  };
}

/**
 * 这一轮请求真正带下去的区间。只有两处认它：细纲的「生成」（给了就是一批，
 * 对话页一批最多 {@link PLOT_BATCH} 章——更长的区间走工程页的批量拆细纲）与
 * 大纲的「生成」（只写那一段）。落定细纲只落一章，讨论不需要区间。
 */
function rangeFor(
  action: { stage: CreationStage; capability: Capability },
  range: { from: number; to: number } | undefined
): { from: number; to: number } | undefined {
  if (!range || action.capability !== 'generate') {
    return undefined;
  }
  if (action.stage === 'plot') {
    return { from: range.from, to: Math.min(range.to, range.from + PLOT_BATCH - 1) };
  }
  return action.stage === 'outline' ? range : undefined;
}

/** 前端给的写法：只认「接着写」「重写」两种，其余当没给（由磁盘定）。 */
function normalizeWriteMode(raw: unknown): 'continue' | 'rewrite' | undefined {
  return raw === 'continue' || raw === 'rewrite' ? raw : undefined;
}

/** 一句话弹窗的规模：两个数都得是正整数，否则当没给。 */
function normalizeSetup(raw: unknown): { totalChapters: number; wordsPerChapter: number } | undefined {
  const o = (raw ?? {}) as { totalChapters?: unknown; wordsPerChapter?: unknown };
  const total = typeof o.totalChapters === 'number' ? Math.floor(o.totalChapters) : NaN;
  const words = typeof o.wordsPerChapter === 'number' ? Math.floor(o.wordsPerChapter) : NaN;
  return total > 0 && words > 0 ? { totalChapters: total, wordsPerChapter: words } : undefined;
}

/**
 * 采纳的落点上已经有东西了——按钮文案据此改成「覆盖…」。
 *
 * 只看**这一层自己的产物**，而且只认「填过」：一份只有占位的模板说「会覆盖」
 * 是吓唬人。角色图谱永远是 false——只建新卡（同名走各自的审阅）。正文看写法：
 * 「接着写」是追加，不覆盖；其余在这一章已有正文时是整章覆盖。
 */
export async function targetHasContent(
  c: ChatController,
  action: { stage: CreationStage; capability: Capability } = {
    stage: c.current.stage,
    capability: c.current.capability,
  },
  target: CreationTarget = c.current.target,
  range?: { from: number; to: number },
  writeMode?: WriteMode
): Promise<boolean> {
  void action;
  // 带区间时只看区间里：续写第 21–40 章的大纲不覆盖前 20 章，一批细纲只覆盖这几章。
  if (range && target.kind === 'outline') {
    return outlineOverlaps(await c.project.readOutline(), range);
  }
  if (range && target.kind === 'plot') {
    const plots = await c.project.listPlots();
    return plots.some((p) => p.no >= range.from && p.no <= range.to && isPlotFilled(p.sections));
  }
  switch (target.kind) {
    case 'setting': {
      if (target.doc === 'characters') {
        return false;
      }
      const doc = await c.project.readSettingDoc(target.doc);
      return isSettingFilled(target.doc, doc.sections);
    }
    case 'outline':
      return isOutlineFilled(await c.project.readOutline());
    case 'plot': {
      const plot = await c.project.resolvePlot(target.plotRelPath);
      return !!plot && isPlotFilled(plot.sections);
    }
    case 'manuscript': {
      if (writeMode === 'continue') {
        return false;
      }
      const no = parsePlotFileName(basename(target.plotRelPath))?.no ?? (await c.project.resolvePlot(target.plotRelPath))?.no;
      const chapter = no !== undefined ? await c.project.getChapter(no) : undefined;
      return !!chapter && chapter.wordCount > 0;
    }
  }
}

/**
 * 这一轮生成的目标字数：细纲的 `targetWords`，没写就是 `config.md` 的每章字数。
 * 只有细纲与正文两层谈得上「这一章写多长」。
 */
async function targetWordsOf(c: ChatController, target: CreationTarget): Promise<number | undefined> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return undefined;
  }
  const plot = await c.project.resolvePlot(relPath);
  return plot?.targetWords ?? (await c.project.readBookConfig()).wordsPerChapter;
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
    /** 谁在要求写。只影响那句话的主语（「Agent 要把生成的产物…」）。 */
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
  const what = art.overwrites ? '覆盖' : art.append ? '追加' : '写入';
  const verdict = await askGate(
    c,
    {
      turnId: ask.turnId,
      callId: ask.callId,
      name: 'artifact',
      title: `${ask.byAgent ? 'Agent 要把生成的产物' : '把这份产物'}${what}到「${art.where}」`,
      detail: artifactDetail(art),
      skip: '不采纳',
      // 重演上一章结尾：标红、写明重合的原句，写入要点两下（总计划 §2.4）。不替作者拒收——
      // 有时重合的是一句刻意呼应的台词。
      ...(art.replay
        ? {
            danger: `开头与上一章结尾大段重合，可能把上一章最后一场又演了一遍：\n「${clipQuote(art.replay)}」`,
            confirm: '确定仍要写入',
          }
        : {}),
    },
    ask.signal
  );
  if (verdict !== 'proceed') {
    return { verdict, message: '作者没有采纳这份产物，磁盘上什么都没变。' };
  }

  // 气泡里当下那份优先（作者可能改过），空了退回生成时那份原文。
  const edited = ask.raw?.();
  let raw = edited?.trim() ? edited : draft.raw;
  if (!raw.trim()) {
    c.toast('内容是空的。', 'error');
    return { verdict, message: '内容是空的，没有写入任何文件。' };
  }
  // 删修饰删过字：逐段对照删之前那一版，作者可以把删错的退回原文。作者已经在气泡里改过就不问——
  // 合并视图拿删之前那版对着他改过的那份，标出来的改动里混着他自己的字。
  const host = getHost();
  if (draft.untrimmed && host.mergeTexts && raw.trim() === draft.raw.trim()) {
    const picked = await host.mergeTexts('删修饰：删之前 ↔ 删之后（可以逐段退回原文）', draft.untrimmed, raw);
    if (typeof picked === 'object') {
      raw = picked.merged;
    } else if (picked !== 'apply') {
      return { verdict, message: '作者在删修饰的对照里放弃了写入，磁盘上什么都没变。' };
    }
  }
  // **重新解析一遍**而不是用 `draft.artifact`：作者可能在气泡里改过。
  const artifact = parseDraftArtifact(draft.action, raw, draft.target, draft.range);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', `阶段 ${draft.action.stage}·${draft.action.capability}`);
    c.toast('这段内容解析不出可采纳的产物，没有写入任何文件。', 'error');
    return { verdict, message: '这段内容解析不出可写入的产物，没有写入任何文件。' };
  }

  // 正文按生成那一刻定下的写法落盘：「接着写」追加，其余在已有正文时覆盖审阅。
  const result = await writeArtifact(c.project, draft.target, artifact, { writeMode: draft.writeMode });
  c.toast(result.message);
  if (result.skipped || !result.relPath) {
    return { verdict, message: result.message };
  }
  // 细纲落在占位路径（`plots/003.md`）上时，文件其实按标题落成了 `003-雪夜.md`。
  // 会话还指着占位路径的话，下一轮写正文、再点一次写细纲都会对着一份「不存在」的细纲
  // ——改成真实路径。不走 setTarget：那会把能力重置、把页签切走。
  if (draft.target.kind === 'plot' && result.relPath !== draft.target.plotRelPath && isPlotPath(c.project, result.relPath)) {
    await retargetPlot(c, draft.target.plotRelPath, result.relPath);
  }
  if (ask.open !== false) {
    await getHost().openFile(result.relPath);
  }
  // pushState 连流水线条一起推。
  await c.pushState();
  return { verdict, relPath: result.relPath, message: result.message };
}

/**
 * 落盘卡片上那几行字：形状、会新建哪几张角色卡（D19）、会不会先对比、调了几次模型、
 * 这一路上的降级（第 2 条）。**动手之前全摊开**——写完再说「顺便建了三张卡」就晚了。
 */
function artifactDetail(art: SerializedArtifact): string {
  const lines = [art.summary];
  if (art.length) {
    lines.push(describeWriteLength(art.length, art.append));
  }
  if (art.creates?.length) {
    lines.push(`会新建角色卡：${art.creates.join('、')}`);
  }
  if (art.overwrites) {
    lines.push('那里已经有内容了，写入前会让你先对比一遍。');
  }
  if (art.calls && art.calls > 1) {
    const rounds = art.length?.rounds ? `（续写 ${art.length.rounds} 轮）` : '';
    lines.push(`这一轮一共调了 ${art.calls} 次模型${rounds}。`);
  }
  for (const note of art.notes ?? []) {
    lines.push(`· ${note}`);
  }
  return lines.join('\n');
}

/** 重演的那一段太长时只摊开头：卡片上放不下一整段，作者认得出是哪一段就够了。 */
function clipQuote(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 章节工作台工具条上的按钮（W6）：对这一章做一件事。
 *
 * 写这一章 / 接着写 / 重写 **等于对这一章按下主按钮**：切到它的正文层，按那种写法发一轮
 * 生成（输入框里没有话——该说的都在细纲里）。生成照样在对话页流式输出、照样当场问写不写
 * （第 19 条），与主按钮是同一条路，只是入口在编辑器上方。定稿走工程动作。
 */
export async function chapterAction(c: ChatController, plotRelPath: string, action: ChapterAction): Promise<void> {
  if (c.busy) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  const entry = await resolvePlotTarget(c, plotRelPath);
  if (!entry) {
    c.toast('这一章不存在，可能刚被改名或删除。', 'error');
    return;
  }
  if (action === 'finalize') {
    if (!entry.chapter) {
      c.toast('这一章还没有正文，无法定稿。', 'error');
      return;
    }
    await c.dispatch({ type: 'projectAction', action: 'finalizeChapter', relPath: entry.chapter.relPath });
    return;
  }
  if (action === 'review' && !(entry.chapter && entry.chapter.wordCount > 0)) {
    c.toast('这一章还没有正文，没法审稿。', 'error');
    return;
  }
  const target: CreationTarget = {
    kind: 'manuscript',
    plotRelPath: entry.plot?.relPath ?? c.project.plotPathForNo(entry.no, entry.chapter?.title ?? ''),
  };
  await setTarget(c, target);
  await send(c, {
    text: '',
    stage: 'manuscript',
    // 审稿（五期）：与写这一章同一条路，只是能力换成 review——只出报告，没有落盘卡片。
    capability: action === 'review' ? 'review' : 'generate',
    target,
    targetNo: entry.no,
    attachments: [],
    excludedIds: [],
    ...(action === 'continue' || action === 'rewrite' ? { writeMode: action } : {}),
  });
}

/**
 * 审稿报告卡底部「按勾选的 n 条修稿」（五期 W10）。
 *
 * 发的是一轮正文层的生成，写法 `revise`：用户气泡是 `/按审稿修稿` + 勾选的那几条，清单在
 * 动手之前按此刻的正文重新拼（{@link planRevision}），修订稿照样当场问写不写、覆盖前先对比
 * （第 19 条、第 3 条）。能勾的只有问题与没完成的目标；认不出的 id 丢掉。
 */
export async function reviseChapter(c: ChatController, turnId: string, picks: readonly string[]): Promise<void> {
  if (c.busy) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  const turn = c.current.turns.find((t) => t.id === turnId && t.role === 'assistant');
  const report = turn?.review ? normalizeReport(turn.review.report) : undefined;
  if (!report) {
    c.toast('找不到这份审稿报告，可能那一轮已经被删掉了。', 'error');
    return;
  }
  const allowed = new Set(pickableIds(report));
  const chosen = [...new Set(picks)].filter((id) => allowed.has(id));
  if (chosen.length === 0) {
    c.toast('没有勾选任何可以修的条目。', 'error');
    return;
  }
  const plot = await c.project.getPlot(report.chapterNo);
  const target: CreationTarget = {
    kind: 'manuscript',
    plotRelPath: plot?.relPath ?? c.project.plotPathForNo(report.chapterNo, report.chapterTitle ?? ''),
  };
  await setTarget(c, target);
  await send(
    c,
    { text: '', stage: 'manuscript', capability: 'generate', target, targetNo: report.chapterNo, attachments: [], excludedIds: [] },
    {
      writeMode: 'revise',
      command: '按审稿修稿',
      revise: { reviewTurnId: turnId, picks: chosen, items: describePicks(report, chosen) },
    }
  );
}

/**
 * 报告卡编辑模式点了「保存」（五期补遗 §3）：把那张问题表合回那一轮的报告（`applyReviewEdits`：
 * 模型给的不能删、作者加的接着编号、引文按正文校验），气泡正文换成新的文字版，落盘、推回。
 * 不调模型。引文按磁盘上此刻的正文找——审稿之后改过的话，作者对着的正是现在这一版。
 */
export async function editReview(c: ChatController, turnId: string, edits: readonly ReviewIssueEdit[]): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === turnId && t.role === 'assistant');
  const report = turn?.review ? normalizeReport(turn.review.report) : undefined;
  if (!turn || !turn.review || !report) {
    c.toast('找不到这份审稿报告，可能那一轮已经被删掉了。', 'error');
    return;
  }
  const chapter = await c.project.getChapter(report.chapterNo);
  const text = chapter ? await c.project.readChapterText(chapter) : '';
  const { report: next, notes } = applyReviewEdits(report, edits, text);
  turn.review = { ...turn.review, report: next };
  turn.content = renderReport(next);
  log.info(`编辑了第 ${report.chapterNo} 章的审稿报告`, notes.join('；') || `${next.issues.length} 条问题`);
  await persist(c);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  c.toast(notes.length > 0 ? `审稿报告已保存。${notes.join('；')}。` : '审稿报告已保存。');
}

/** {@link beforeGenerate} 的结论：放行（修稿时带上拼好的清单），或者拦下并说明。 */
type BeforeGenerate =
  | { go: true; reviseBrief?: string; notes?: string[] }
  | { go: false; content?: string; error?: string; interrupted?: boolean };

/**
 * 调模型之前的两道（五期）。
 *
 * - **修稿**：按那一轮的报告与磁盘上此刻的正文拼清单。正文在审稿之后改过（指纹对不上），
 *   逐条重新定位勾选的问题，引文已经不在的作废并写进说明；一条都不剩就不调模型。
 * - **一致性预检**：写一章（新写或重写）之前，零调用地查细纲有没有把角色卡上已经死了的人排进
 *   本章。有就在对话页亮一张卡：「仅本次忽略，照写」/「先不写」，或者填一句理由「记为刻意安排，
 *   照写」——记进这一章细纲的 `preflightOk`，以后写这一章不再为这几个人亮卡（五期补遗 §2）。记过的
 *   不拦，写章卡片的说明里提一句。接着写与修稿不查——开头已经写下了，这时候拦它没有意义。
 */
async function beforeGenerate(
  c: ChatController,
  ctx: {
    action: { stage: CreationStage; capability: Capability };
    writeMode?: WriteMode;
    userTurn: ChatTurn;
    assistantTurn: ChatTurn;
    signal: AbortSignal;
  }
): Promise<BeforeGenerate> {
  if (ctx.action.stage !== 'manuscript' || ctx.action.capability !== 'generate') {
    return { go: true };
  }
  if (ctx.writeMode === 'revise') {
    return planRevision(c, ctx.userTurn);
  }
  if (ctx.writeMode === 'continue') {
    return { go: true };
  }
  const relPath = plotOfTarget(c.current.target);
  const no =
    (relPath ? (await c.project.resolvePlot(relPath))?.no ?? parsePlotFileName(basename(relPath))?.no : undefined) ??
    c.current.targetNo;
  const { risks, exempted, plotRelPath: plotRel } = no ? await preflightChapter(c.project, no) : { risks: [], exempted: [], plotRelPath: undefined };
  const notes = exempted.map(describeExempted);
  // 批量写章在这一章前面停下时挂过一个黄 ❗：这一次查过了（没问题，或作者说仅本次忽略）就收掉。
  if (!no || risks.length === 0) {
    if (plotRel) {
      await clearFailures(c.project, 'plot', plotRel, 'preflight');
    }
    return { go: true, ...(notes.length > 0 ? { notes } : {}) };
  }
  const lines = describeRisks(no, risks);
  log.warn(`写第 ${no} 章之前的一致性预检：${risks.length} 处`, lines.join('\n'));
  const answer = await askGateNoted(
    c,
    {
      turnId: ctx.assistantTurn.id,
      name: 'preflight',
      title: `写第 ${no} 章之前的一致性预检：${risks.length} 处要留意`,
      detail: `${PREFLIGHT_SUGGESTION}\n这一步没有调用模型。`,
      danger: lines.join('\n'),
      proceed: '仅本次忽略，照写',
      skip: '先不写',
      ...(plotRel
        ? {
            remember: {
              label: '记为刻意安排，照写',
              placeholder: '为什么这是刻意的安排（如：回忆里的一场）。记进这一章的细纲，以后写这一章不再为这几个人提醒',
            },
          }
        : {}),
    },
    ctx.signal
  );
  if (answer.verdict === 'proceed') {
    if (answer.remember && plotRel) {
      const ok = await c.workspace.recordPreflightOk(plotRel, risks.map((r) => ({ name: r.name, reason: answer.remember! })));
      const who = risks.map((r) => r.name).join('、');
      log.info(`一致性预检：作者把${who}记为第 ${no} 章的刻意安排`, answer.remember);
      notes.unshift(
        ok
          ? `一致性预检：${who}在第 ${no} 章出场已记为刻意安排（${answer.remember}），写进了这一章细纲的 preflightOk，以后写这一章不再提醒`
          : `一致性预检：这一章细纲是手写的（没有 frontmatter），没能记下「${answer.remember}」；这一次照写`
      );
    } else {
      log.info(`一致性预检：作者选择仅本次忽略，照写第 ${no} 章`);
    }
    if (plotRel) {
      await clearFailures(c.project, 'plot', plotRel, 'preflight');
    }
    return { go: true, ...(notes.length > 0 ? { notes } : {}) };
  }
  return {
    go: false,
    interrupted: answer.verdict === 'stop',
    content: [
      `一致性预检发现 ${risks.length} 处问题，这一次先不写——没有调用模型。`,
      '',
      ...lines.map((l) => `- ${l}`),
      '',
      '改好细纲的出场角色或角色卡之后再写；如果这本来就是回忆、幻象一类的刻意安排，再点一次写这一章，选「仅本次忽略，照写」或「记为刻意安排，照写」。',
    ].join('\n'),
  };
}

/** 修稿那一轮的清单。见 {@link beforeGenerate}。 */
async function planRevision(c: ChatController, userTurn: ChatTurn): Promise<BeforeGenerate> {
  const r = userTurn.revise;
  const reviewTurn = r ? c.current.turns.find((t) => t.id === r.reviewTurnId) : undefined;
  const report = reviewTurn?.review ? normalizeReport(reviewTurn.review.report) : undefined;
  if (!r || !report) {
    return { go: false, error: '找不到这一轮修稿依据的那份审稿报告（可能已经被删掉了），没法按它修稿。' };
  }
  const chapter = await c.project.getChapter(report.chapterNo);
  const text = chapter ? await c.project.readChapterText(chapter) : '';
  if (!chapter || !text.trim()) {
    return { go: false, error: `第 ${report.chapterNo} 章已经没有正文了，没法修稿。` };
  }
  const notes: string[] = [];
  let picks = r.picks;
  if (chapter.contentHash !== report.chapterHash) {
    const { kept, lost } = relocatePicks(report, picks, text);
    picks = kept;
    notes.push('正文在审稿之后改过，勾选的条目已按现在的正文重新定位');
    if (lost.length > 0) {
      notes.push(
        `${lost.length} 条的引文已经不在正文里了，没有交给模型：${lost.map((i) => `「${clipQuote(i.description, 24)}」`).join('、')}`
      );
    }
  }
  const brief = renderRevisionBrief(report, picks);
  if (!brief) {
    return { go: false, error: '勾选的条目在现在的正文里都找不到了，没有可以修的。正文改过的话，重新审一遍这一章。' };
  }
  notes.unshift(`按 ${picks.length} 条勾选的审稿意见修稿`);
  log.info(`按审稿修第 ${report.chapterNo} 章`, notes.join('；'));
  return { go: true, reviseBrief: brief, notes };
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
  // 把章号同步过来：装配器在细纲尚未落盘时靠它定位前文边界，而这里正好知道答案。
  const relPath = plotOfTarget(target);
  if (relPath) {
    const no = parsePlotFileName(basename(relPath))?.no;
    if (no !== undefined) {
      c.current.targetNo = no;
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
 * 这是「选中一章 = 进入它当前该做的那一步」的实现：还没排细纲就落细纲层，
 * 细纲排好了就落正文层。判断必须在后端：前端手上只有当前那一章的 pipeline。
 *
 * **收的是「哪一章」**，界面上几个入口给的路径形状各不相同——细纲路径（可能还
 * 不存在，下拉框与老工程的章给的就是 `plotPathForNo` 算出来的位置）或章节路径。
 * `resolvePlotTarget` 按章号把它们认到同一章（第 20 条：只在细纲号 = 章号这一条轴上认）。
 */
export async function selectPlot(c: ChatController, plotRelPath: string): Promise<void> {
  const entry = await resolvePlotTarget(c, plotRelPath);
  if (!entry) {
    c.toast('这一章不存在，可能刚被改名或删除。', 'error');
    return;
  }
  const pipeline = await buildPlotPipeline(c.project, entry);
  const next = deriveNextStep(pipeline.stage, factsOf(pipeline));
  // 细纲还没有时落点用它**应该**在的位置（`plotPathForNo`）：选中它就是
  // 「去给这一章补规划」，装配器与工作区卡都能如实退化成空壳。
  const target = entry.plot?.relPath ?? c.project.plotPathForNo(entry.no, entry.chapter?.title ?? '');

  // 全做完了（next 为空）就停在正文——那是这一章的终点，也是最可能
  // 要回头改的一层。
  await setTarget(c, next ? targetOf(next, target) : { kind: 'manuscript', plotRelPath: target });
}

/**
 * 前端给的路径 → 这一章（细纲与正文各自可能缺席）。两边都没有才算「不存在」。
 *
 * 只有落在 `plots/` 之下的路径才当细纲读：`readPlot` 是纯解析，喂它一个章节
 * 文件也会**解析成功**（数字前缀 + `# 标题` 一样认得出），于是 target 会指进
 * `chapters/` 去。其余情况一律按章号认：章节路径取它的章号，还不存在的细纲路径
 * 取文件名里的号。
 */
async function resolvePlotTarget(
  c: ChatController,
  relPath: string
): Promise<{ no: number; plot?: Plot; chapter?: Chapter } | undefined> {
  const chapters = await c.project.listChapters();

  const direct = chapters.find((ch) => ch.relPath === relPath);
  const asPlot = !direct && isPlotPath(c.project, relPath) ? await c.project.readPlot(relPath) : undefined;
  const no =
    direct?.order ??
    asPlot?.no ??
    parsePlotFileName(basename(relPath))?.no ??
    parseChapterFileName(basename(relPath))?.order;
  if (no === undefined || no <= 0) {
    return undefined;
  }
  const plot = asPlot ?? (await c.project.getPlot(no));
  const chapter = direct ?? chapterOfPlotNo(chapters, no);
  return plot || chapter ? { no, plot, chapter } : undefined;
}

/**
 * 细纲改名后，把当前会话的目标指到新路径。
 *
 * 少了这一步，`current.target.plotRelPath` 还指着旧路径，创作页会拿到一份
 * 「这一章找不到」的空壳 pipeline——徽章回落成「待写细纲」、进度全归零、
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
export async function describeTargetOf(
  c: ChatController,
  target: CreationTarget,
  range?: { from: number; to: number }
): Promise<string> {
  // 一批细纲 / 续写的那一段大纲：落点是一段章号，不是某一章。
  if (range && (target.kind === 'plot' || target.kind === 'outline')) {
    const span = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
    return target.kind === 'plot' ? `${span} · 细纲` : `情节大纲 · ${span}`;
  }
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await c.project.resolvePlot(relPath);
  return describeTarget(target, { no: plot?.no ?? parsePlotFileName(basename(relPath))?.no, title: plot?.title });
}

/**
 * 推一份创作页的现场：流水线 + 工作区卡 + 下一步。
 *
 * 架构与大纲两层没有「这一章」，下一步问全书状态机。选中一章时问那一章的；
 * **那一章做完了就转去问全书**——主按钮于是自然落到下一个该写的章上，
 * 而不是一段做完就沉默（从前 `done` 之后没有按钮，作者得自己去找下一段）。
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
    next: step
      ? { ...step, target: targetOf(step, pipeline.plot.relPath), no: pipeline.no }
      : await bookNextStep(c),
  });
}

/**
 * 全书级的下一步。
 *
 * 判据在纯函数层（`deriveBookStage` / `deriveBookNextStep`），这里只取数：
 *
 * - 架构、大纲、拆细纲三档：`bookStepView` 补上落点（工程页的空状态用的是同一份）。
 * - 在写那一档：转去问**下一个该写的章**的单章状态机，主按钮就是「写第 N 章」一类。
 * - 写完了：不给按钮。
 */
export async function bookNextStep(c: ChatController): Promise<NextStepView | undefined> {
  const facts = await buildBookFacts(c.project);
  const stage = deriveBookStage(facts);
  const step = await bookStepView(stage, facts, {
    config: () => c.project.readBookConfig(),
    plotPathOf: async (no) => (await c.project.getPlot(no))?.relPath ?? c.project.plotPathForNo(no, ''),
  });
  if (step || stage !== 'writing') {
    return step;
  }
  const no = facts.nextChapterNo;
  const chapters = await c.project.listChapters();
  const plot = await c.project.getPlot(no);
  const pipeline = await buildPlotPipeline(c.project, { no, plot, chapter: chapterOfPlotNo(chapters, no) }, { chapters });
  const chapterStep = deriveNextStep(pipeline.stage, factsOf(pipeline));
  return chapterStep
    ? { ...chapterStep, target: targetOf(chapterStep, pipeline.plot.relPath), no }
    : undefined;
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
