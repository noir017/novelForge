import type { ChatController } from './index';
import { basename } from 'node:path';
import { describeArtifact } from '../features/artifact';
import { acceptArtifact as writeArtifact } from '../generation/accept';
import { Draft, generate, parseDraftArtifact } from '../generation/generate';
import { getHost } from '../host';
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
  const command = commandOf(payload.stage, payload.capability);
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
  // 产出的是可采纳的东西时，把落点与形状一起带给前端——它才画得出
  // 「拆出了 4 场，采纳？」而不是一个光秃秃的按钮。
  //
  // **不再重新解析一遍**：draft 出厂就带 artifact 与 summary。从前这里
  // 是三次解析里多余的那一次。
  if (draft?.artifact) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    assistantTurn.draftId = draft.id;
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
}

/**
 * 这一轮的回复能不能采纳，以及采纳到哪里。
 *
 * 只在**重开旧会话**这类拿不到 draft 的路上用（生成路径直接读
 * `draft.artifact`）。解析在这里跑一遍只是为了**画界面**（几场？覆盖谁？），
 * 真正落盘时 `acceptArtifact` 会拿气泡里当时的文本重新解析——用户可能改过。
 */
export async function describeArtifactOf(
  c: ChatController,
  content: string
): Promise<SerializedArtifact | undefined> {
  const action = { stage: c.current.stage, capability: c.current.capability };
  if (outputKindOf(action) !== 'artifact' || !content.trim()) {
    return undefined;
  }
  const artifact = parseDraftArtifact(action, content);
  if (!artifact) {
    return undefined;
  }
  return {
    where: await describeCurrentTarget(c),
    summary: describeArtifact(artifact),
    overwrites: await targetHasContent(c),
  };
}

/**
 * 采纳的落点上已经有东西了——按钮文案据此改成「覆盖…」。
 *
 * 只看**这一层自己的产物**：拆章/拆场景本来就跳过已存在的，
 * 说「会覆盖」是吓唬人。
 */
export async function targetHasContent(c: ChatController): Promise<boolean> {
  const { stage } = c.current;
  const relPath = plotOfTarget(c.current.target);
  if (stage === 'outline') {
    return c.current.capability !== 'split' && (await c.project.readOutline()).trim().length > 0;
  }
  if (!relPath || c.current.capability === 'split') {
    return false;
  }
  if (stage === 'plot') {
    // 只有**排过剧情**才算有内容。一份只带「目标」的骨架（拆章那一步产出的）
    // 说「会覆盖」是吓唬人——那正是接下来要填的东西。
    const plot = await c.project.readPlot(relPath);
    return !!plot && isPlotFilled(plot.sections);
  }
  if (stage === 'scene') {
    const sceneNo = c.current.target.kind === 'scene' ? c.current.target.sceneNo : undefined;
    return sceneNo !== undefined && !!(await c.project.readScene(relPath, sceneNo));
  }
  // 正文是追加，不覆盖任何东西。
  return false;
}

/**
 * 采纳一份结构化产物（细纲、场景卡、章节清单、场景清单、大纲、正文）。
 *
 * **落点从 draft 里取，不由前端传**：前端猜不出一段讨论该写到哪一层
 * （第 19 条最后一句）。从前它发的是 `store.session.target`——那是**当下**
 * 选中的目标，用户在生成完之后切了一章再点采纳，产物就写到别的地方去了。
 *
 * **文本仍然重新解析一遍**而不是用 `draft.artifact`：用户可能在气泡里改过。
 * `draft.raw` 只是兜底（前端没给文本时）。
 *
 * 落盘与否由 `generation/accept.ts` 经 workspace 网关决定——目标已有内容
 * 时会先弹审阅。
 */
export async function acceptArtifact(
  c: ChatController,
  turnId: string,
  draftId: string,
  text: string
): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === turnId);
  if (!turn) {
    return;
  }
  const draft = c.drafts.get(draftId);
  if (!draft) {
    // 草稿没了（会话很老、被挤掉、或者手改过会话文件）。这时**不猜落点**：
    // 拿当下选中的 target 顶上，会把一份剧情写到别的章去。
    log.warn('找不到这一轮的草稿，未写入', `draftId ${draftId}`);
    c.toast('这一轮的产物已经过期了（会话太久或已被清理），请重新生成一次。', 'error');
    return;
  }
  // 前端给的是气泡里当下那份；空了就退回生成时那份原文。
  const raw = text.trim() ? text : draft.raw;
  if (!raw.trim()) {
    c.toast('内容是空的。', 'error');
    return;
  }
  turn.content = raw;

  const artifact = parseDraftArtifact(draft.action, raw);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', `阶段 ${draft.action.stage}·${draft.action.capability}`);
    c.toast('这段内容解析不出可采纳的产物，没有写入任何文件。', 'error');
    return;
  }

  const result = await writeArtifact(c.project, draft.target, artifact);
  if (result.skipped || !result.relPath) {
    c.toast(result.message);
    return;
  }
  turn.acceptedTo = result.relPath;
  await persist(c);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  c.toast(result.message);

  await getHost().openFile(result.relPath);
  await c.pushState();
  await pushPipeline(c);
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
 * **收的是「哪一章」，不是「哪个细纲文件」。** 界面上三个入口给的路径形状
 * 各不相同，而它们指的都是同一件事：
 *
 * - 工程页点章名 → **主路径**：已发布的章给 `chapters/003-夜访.md`
 * - 对话页下拉框 → 细纲路径，这一章还没规划过时那个文件**并不存在**
 * - 流水线/新建 → 真实的细纲路径
 *
 * 所以这里按**章号**去认（`resolvePlotTarget`），只有章号是两侧共同的身份。
 * 从前它只 `readPlot` 一次、读不到就报「这一章不存在」——于是老工程里每一章、
 * 以及拆分出来的没有细纲的章，一点开就是那句话。而那些章明明就在磁盘上。
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
  // 「去规划这一章」，装配器与工作区卡都能如实退化成空壳。
  const target = entry.plot?.relPath ?? c.project.plotPathForNo(entry.no, entry.chapter?.title ?? '');

  // 全做完了（next 为空）就停在正文——那是这一章的终点，也是最可能
  // 要回头改的一层。
  await setTarget(c, next ? targetOf(next, target) : { kind: 'manuscript', plotRelPath: target });
}

/**
 * 前端给的路径 → 这一章的两面（细纲与成品）。两边都没有才算「不存在」。
 *
 * 章号从三处依次找：细纲文件本身、成品文件本身、文件名的数字前缀。最后那条
 * 是关键——它让一个**还不存在**的细纲路径（`plots/009.md`）也定位得到第 9 章。
 *
 * 只有落在 `plots/` 之下的路径才当细纲读：`readPlot` 是纯解析，喂它一个章节
 * 文件也会**解析成功**（数字前缀 + `# 标题` 一样认得出），于是 target 会指进
 * `chapters/` 去，而场景目录与中转站正文都是按细纲路径镜像的——那一章的
 * 三层产物从此各找各的位置。
 */
async function resolvePlotTarget(
  c: ChatController,
  relPath: string
): Promise<{ no: number; plot?: Plot; chapter?: Chapter } | undefined> {
  const plot = isPlotPath(c.project, relPath) ? await c.project.readPlot(relPath) : undefined;
  const chapters = await c.project.listChapters();
  const direct = chapters.find((ch) => ch.relPath === relPath);
  const no =
    plot?.no ??
    direct?.order ??
    parsePlotFileName(basename(relPath))?.no ??
    parseChapterFileName(basename(relPath))?.order;
  if (no === undefined || no <= 0) {
    return undefined;
  }
  // 传的是章节路径时优先用那一份：同号多个文件（作者手改文件名撞了号）时，
  // 点哪一行就该进哪一行。
  const chapter = direct ?? chapters.find((ch) => ch.order === no);
  // 传的是细纲路径、但那份文件不在时，按章号回查一次：拆分之后新出来的章
  // 只有成品，下拉框给的却是细纲路径。
  const resolved = plot ?? (await c.project.getPlot(no));
  return resolved || chapter ? { no, plot: resolved, chapter } : undefined;
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

/** 当前目标的人话描述。日志、采纳卡片、面包屑共用。 */
export async function describeCurrentTarget(c: ChatController): Promise<string> {
  const relPath = plotOfTarget(c.current.target);
  if (!relPath) {
    return describeTarget(c.current.target);
  }
  const plot = await c.project.readPlot(relPath);
  const sceneNo =
    c.current.target.kind === 'scene' || c.current.target.kind === 'manuscript'
      ? c.current.target.sceneNo
      : undefined;
  const sceneTitle =
    sceneNo === undefined ? undefined : (await c.project.readScene(relPath, sceneNo))?.title;
  return describeTarget(c.current.target, { no: plot?.no, title: plot?.title, sceneTitle });
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
 * 没有大纲就写大纲，有大纲但一章都还没拆就去拆章。都齐了就不催——
 * 此时该做的是挑一章进去，而那是用户的选择，不是系统能替他定的。
 */
export async function bookNextStep(c: ChatController): Promise<NextStepView | undefined> {
  const stage = deriveBookStage({
    outlineFilled: (await c.project.readOutline()).trim().length > 0,
    plotCount: (await c.project.listPlots()).length,
  });
  const step = deriveBookNextStep(stage);
  return step ? { ...step, target: { kind: 'outline' } } : undefined;
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
