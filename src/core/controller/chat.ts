import type { ChatController } from './index';
import { describeArtifact, suggestTitle } from '../features/creation';
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
  chapterOfTarget,
  commandOf,
  describeTarget,
  deriveNextStep,
  isCreationStage,
  normalizeTarget,
  outputKindOf,
  stageOfTarget,
} from '../model/pipeline';
import {
  NextStepView,
  SendPayload,
  SerializedArtifact,
} from '../protocol';
import { buildChapterPipelineView } from '../views/projectView';
import { buildChapterPipeline } from '../views/pipeline';
import { buildWorkbench } from '../views/workbench';
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
  // 旧界面一律要求先写点什么才能发送，而「生成细纲」「拆成场景」「写这一场」
  // 本来就不需要作者说任何话——该说的都在细纲和场景卡里了。逼他先编一句
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
    // 命令，界面才说得出「刚才那一下是 /生成细纲」。「讨论」是默认动作，不记。
    command: payload.capability === 'discuss' ? undefined : command?.label,
    attachments: c.pending.length > 0 ? [...c.pending] : undefined,
    excludedIds: payload.excludedIds.length > 0 ? payload.excludedIds : undefined,
  };
  c.current.turns.push(userTurn);
  if (c.current.turns.length === 1) {
    c.current.title = deriveTitle(turnPreview(userTurn));
  }
  applyAction(c, payload);
  c.current.targetOrder = payload.targetOrder;
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
  c.busy = true;
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
  const built = await c.session.generate(
    {
      action,
      target: c.current.target,
      targetOrder: payload.targetOrder,
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
    }
  );

  c.busy = false;
  c.post({ type: 'busy', value: false });

  if (built) {
    assistantTurn.context = serializeDigest(built);
    c.post({ type: 'context', turnId: assistantTurn.id, digest: assistantTurn.context });
  }
  // 产出的是可采纳的东西时，把落点与形状一起带给前端——它才画得出
  // 「拆出了 4 场，采纳？」而不是一个光秃秃的按钮。
  assistantTurn.artifact = await describeArtifactOf(c, assistantTurn.content);
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
 * 解析在这里跑一遍只是为了**画界面**（几场？覆盖谁？），真正落盘时
 * `acceptArtifact` 会拿气泡里当时的文本重新解析——用户可能改过。
 */
export async function describeArtifactOf(
  c: ChatController,
  content: string
): Promise<SerializedArtifact | undefined> {
  const action = { stage: c.current.stage, capability: c.current.capability };
  if (outputKindOf(action) !== 'artifact' || !content.trim()) {
    return undefined;
  }
  const artifact = c.session.parse(action, content);
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
  const relPath = chapterOfTarget(c.current.target);
  if (stage === 'outline') {
    return c.current.capability !== 'split' && (await c.project.readOutline()).trim().length > 0;
  }
  if (!relPath || c.current.capability === 'split') {
    return false;
  }
  if (stage === 'plan') {
    return !!(await c.project.readPlan(relPath));
  }
  if (stage === 'scene') {
    const sceneNo = c.current.target.kind === 'scene' ? c.current.target.sceneNo : undefined;
    return sceneNo !== undefined && !!(await c.project.readScene(relPath, sceneNo));
  }
  // 正文是追加，不覆盖任何东西。
  return false;
}

export async function accept(
  c: ChatController,
  turnId: string,
  mode: 'append' | 'new',
  order: number,
  title: string,
  text: string
): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === turnId);
  if (!turn) {
    return;
  }
  if (!text.trim()) {
    c.toast('内容是空的。', 'error');
    return;
  }
  // 前端可能改过草稿，以传上来的为准。
  turn.content = text;

  // 协议层的 target 在第四阶段接入，这里先按旧的 append/new 桥接。
  let result;
  if (mode === 'append') {
    const chapter = await c.project.getChapter(order);
    if (!chapter) {
      c.toast(`第 ${order} 章不存在。`, 'error');
      return;
    }
    result = await c.session.acceptArtifact(
      { kind: 'manuscript', chapterRelPath: chapter.relPath },
      { kind: 'manuscript', text }
    );
  } else {
    result = await c.session.acceptAsNewChapter(text, order, title.trim() || suggestTitle(text, order));
  }
  if (!result.relPath) {
    c.toast(result.message, 'error');
    return;
  }

  turn.acceptedTo = result.relPath;
  await persist(c);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  c.toast(result.message);

  await getHost().openFile(turn.acceptedTo);
  await c.pushState();
}

/**
 * 采纳一份结构化产物（细纲、场景卡、章节清单、场景清单、大纲）。
 *
 * **重新解析一遍**而不是用生成时缓存的那份：用户可能在气泡里改过。
 * 落盘与否由 creation.ts 决定——目标已有内容时它会先弹审阅。
 */
export async function acceptArtifact(
  c: ChatController,
  turnId: string,
  target: CreationTarget,
  text: string
): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === turnId);
  if (!turn) {
    return;
  }
  if (!text.trim()) {
    c.toast('内容是空的。', 'error');
    return;
  }
  turn.content = text;

  const action = { stage: c.current.stage, capability: c.current.capability };
  const artifact = c.session.parse(action, text);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', `阶段 ${action.stage}·${action.capability}`);
    c.toast('这段内容解析不出可采纳的产物，没有写入任何文件。', 'error');
    return;
  }

  const result = await c.session.acceptArtifact(target, artifact);
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
 * 从「正文·生成」切到细纲还留着「生成」，等于点一下就花钱重写一份细纲。
 */
export async function setTarget(c: ChatController, target: CreationTarget): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，请先停止。', 'error');
    return;
  }
  c.current.target = target;
  c.current.stage = stageOfTarget(target);
  c.current.capability = DEFAULT_CAPABILITY[c.current.stage];
  // 章节已落盘时把序号同步过来：装配器在章节尚未落盘时靠它定位前文边界，
  // 而这里正好知道答案。
  const relPath = chapterOfTarget(target);
  if (relPath) {
    const chapter = (await c.project.listChapters()).find((ch) => ch.relPath === relPath);
    if (chapter) {
      c.current.targetOrder = chapter.order;
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
 * 这是「选中章节 = 进入它当前该做的那一步」的实现。改造前前端一律发
 * `setTarget({kind:'manuscript'})`，于是点开一个连细纲都没有的章节，
 * 界面直接把作者丢进正文层——四层流水线在创作页上等于不存在。
 *
 * 判断必须在后端：前端手上只有当前那一章的 pipeline，不知道别的章
 * 处于什么状态。
 */
export async function selectChapter(c: ChatController, chapterRelPath: string): Promise<void> {
  const chapter = (await c.project.listChapters()).find((ch) => ch.relPath === chapterRelPath);
  if (!chapter) {
    c.toast('这一章不存在，可能刚被改名或删除。', 'error');
    return;
  }
  const pipeline = await buildChapterPipeline(c.project, chapter);
  const next = deriveNextStep(pipeline.stage, factsOf(pipeline));

  // 全做完了（next 为空）就停在正文——那是这一章的终点，也是最可能
  // 要回头改的一层。
  await setTarget(
    c,
    next ? targetOf(next, chapterRelPath) : { kind: 'manuscript', chapterRelPath }
  );
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
  const relPath = chapterOfTarget(c.current.target);
  if (!relPath) {
    return describeTarget(c.current.target);
  }
  const chapter = (await c.project.listChapters()).find((ch) => ch.relPath === relPath);
  const sceneNo =
    c.current.target.kind === 'scene' || c.current.target.kind === 'manuscript'
      ? c.current.target.sceneNo
      : undefined;
  const sceneTitle =
    sceneNo === undefined ? undefined : (await c.project.readScene(relPath, sceneNo))?.title;
  return describeTarget(c.current.target, {
    order: chapter?.order,
    title: chapter?.title,
    sceneTitle,
  });
}

/**
 * 推一份创作页的现场：流水线 + 工作区卡 + 下一步。
 *
 * **全书大纲阶段也推**（改造前那时直接 return）：那一层没有「这一章的四段」，
 * 但一样有产物要看、有下一步要做——大纲是空的就该去写大纲。
 */
export async function pushPipeline(c: ChatController): Promise<void> {
  const target = c.current.target;
  const relPath = chapterOfTarget(target);
  const workbench = await buildWorkbench(c.project, target);

  if (!relPath) {
    c.post({ type: 'pipeline', workbench, next: await outlineNextStep(c) });
    return;
  }
  const pipeline = await buildChapterPipelineView(c.project, relPath);
  const plan = deriveNextStep(pipeline.stage, factsOf(pipeline));
  c.post({
    type: 'pipeline',
    pipeline,
    workbench,
    next: plan ? { ...plan, target: targetOf(plan, relPath), order: pipeline.order } : undefined,
  });
}

/**
 * 全书大纲那一层的下一步。
 *
 * 没有状态机可用（`deriveStage` 是按章算的），判据只有两条，都很直白：
 * 没有大纲就写大纲，有大纲但一章都还没有就拆成章节。都齐了就不催——
 * 此时该做的是挑一章进去，而那是用户的选择，不是系统能替他定的。
 */
export async function outlineNextStep(c: ChatController): Promise<NextStepView | undefined> {
  const outline = (await c.project.readOutline()).trim();
  if (!outline) {
    return {
      stage: 'outline',
      capability: 'generate',
      label: '生成大纲',
      hint: '先定下这个故事讲什么。后面三层都从它展开。',
      target: { kind: 'outline' },
    };
  }
  if ((await c.project.listChapters()).length === 0) {
    return {
      stage: 'outline',
      capability: 'split',
      label: '拆成章节',
      hint: '把大纲拆成一章一章的清单，每章有一个能判断达成没达成的目标。',
      target: { kind: 'outline' },
    };
  }
  return undefined;
}

/**
 * 打开旧会话时把 target 补齐。
 *
 * 0.2.x 的会话只有 `targetOrder`，`normalize` 把它们一律落到全书大纲
 * （那个函数是纯的，查不了章节列表）。这里手上有章节列表，能把它还原成
 * 「正文 · 第 N 章」——那正是旧版唯一做得到的事。
 */
export async function restoreTarget(c: ChatController, session: ChatSession): Promise<void> {
  if (session.target.kind !== 'outline' || session.targetOrder === undefined) {
    return;
  }
  const chapter = await c.project.getChapter(session.targetOrder);
  if (chapter) {
    session.target = { kind: 'manuscript', chapterRelPath: chapter.relPath };
    session.stage = 'manuscript';
    session.capability = DEFAULT_CAPABILITY.manuscript;
  }
}

/**
 * 供命令直接调用：预设创作目标并聚焦。
 *
 * 命令面板给的是序号（它只有这个）；查不到那一章时退回大纲——
 * 拿一个空 relPath 去装配，等于把「前文」的边界搞错。
 */
export async function focusWithTarget(c: ChatController, order: number): Promise<void> {
  const chapter = await c.project.getChapter(order);
  await setTarget(
    c,
    chapter ? { kind: 'manuscript', chapterRelPath: chapter.relPath } : { kind: 'outline' }
  );
  c.current.targetOrder = order;
  for (const host of c.hosts) {
    host.reveal();
  }
}
