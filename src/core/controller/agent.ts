/**
 * 对话页的 agent 入口。
 *
 * 与 `chat.ts` 的 `send` **并存**而不是取代它：点「写剧情」是确定性的单步，
 * 多一次调度调用只是加钱加延迟（设计文档的第一条决策）。这里管的是另一类
 * 请求——「第 9 章里主角说过他没去过北境吗」「这一章的剧情有什么问题」，
 * 那些事先不知道要读几份文件。
 *
 * 这一层自己只做四件事：
 *
 * 1. **占生成位**（`beginGeneration`）——与单步共用同一把锁，两条路不会同时跑；
 * 2. **走 `runTask`**（第 11 条）——工程页顶部有进度条、看得见、能停；
 * 3. **把循环的事件翻译成协议消息**——工具调用画成气泡里的折叠条；
 * 4. **把这一轮的痕迹存进会话**——只存展示摘要，不存工具的完整返回值。
 *
 * 判断、装配、预算全在 `core/agent/` 里，这里一条都不重复。
 */
import type { ChatController } from './index';
import { readConfig } from '../config';
import { buildProvider } from '../llm/registry';
import { runTask } from '../runtime/progress';
import { scoped } from '../runtime/logger';
import { describeModelIssue, providerLabel, resolveModelRef, toolCapableRefs } from '../model/providers';
import { refsForTask } from '../model/tiers';
import { ChatTurn, TurnToolCall, deriveTitle, makeTurnId, nowIso, turnPreview } from '../model/session';
import { runAgent } from '../agent/loop';
import type { BudgetLimits } from '../agent/budget';
import { describeArtifactOf, pushPipeline } from './chat';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('面板');

/**
 * 调度模型：「Agent 调度」档里第一个勾了「支持工具调用」的。
 *
 * 一个都没勾就回落到对话页选定的那个——**不是硬失败**：那个模型八成也支持
 * 工具调用，只是作者还没去勾。硬失败会让「打开 Agent 开关」变成一条要先读
 * 文档才走得通的路。
 */
function pickDispatchModel(config: ReturnType<typeof readConfig>) {
  for (const ref of toolCapableRefs(config.providers, refsForTask(config, 'agent').refs)) {
    const active = resolveModelRef(config.providers, ref);
    if (active) {
      return active;
    }
  }
  return config.active;
}

/**
 * 让 agent 跑一轮。
 *
 * `limits` 由前端可选带上（日后的设置页），缺省走 `budget.ts` 那三条。
 */
export async function sendAgent(
  c: ChatController,
  text: string,
  limits?: Partial<BudgetLimits>
): Promise<void> {
  if (c.busy) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  if (!text.trim()) {
    // agent 没有「命令」这回事，它的全部输入就是作者这句话。
    c.toast('请先说说你要它做什么。', 'error');
    return;
  }

  const config = readConfig();
  // 调度模型取「Agent 调度」那一档里**标记过支持工具调用**的第一个；一个都没
  // 标记时沿用对话页选定的那个（那是分档之前的行为，能跑）。**不做自动探测**：
  // 探测要真发一次带 tools 的请求，那是在作者没点任何东西的时候花钱（第 4 条）。
  const dispatch = pickDispatchModel(config);
  if (!dispatch) {
    c.toast(describeModelIssue(config.providers, config.model), 'error');
    return;
  }
  const provider = await buildProvider(dispatch);
  if (!provider) {
    c.toast(
      `未配置「${providerLabel(dispatch.profile)}」的 API Key。可在设置页录入，或换一个已配置好的模型。`,
      'error'
    );
    return;
  }
  log.info(`Agent 调度模型 ${dispatch.ref}`, config.agentPolicy);

  const userTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'user',
    content: text.trim(),
    at: nowIso(),
    // 气泡上标一枚 `/Agent`，翻回去看得出这一轮走的是哪条路。
    command: 'Agent',
  };
  c.current.turns.push(userTurn);
  if (c.current.turns.length === 1) {
    c.current.title = deriveTitle(turnPreview(userTurn));
  }
  c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
  await persist(c);

  // 并发控制与单步共用同一把锁：两条路同时跑会让 draft 与流式内容互相盖。
  const lease = c.beginGeneration();
  if (!lease) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  c.post({ type: 'busy', value: true });

  const assistantTurn: ChatTurn = { id: makeTurnId(), role: 'assistant', content: '', at: nowIso() };
  c.current.turns.push(assistantTurn);
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });

  /** 这一轮调过的工具。**只记展示摘要**——完整返回值可能是几万字。 */
  const toolCalls: TurnToolCall[] = [];
  const titles = new Map<string, string>();

  try {
    // 第 11 条：任何要调模型的动作都得看得见、能停。取消经 lease.signal 传下去，
    // 所以进度条上的「停止」与对话页的「停止」是同一件事。
    const outcome = await runTask(
      'Agent',
      async (task) => {
        // 宿主/进度条的取消也要能中断循环。
        const relay = () => lease.abort();
        if (task.signal.aborted) {
          relay();
        } else {
          task.signal.addEventListener('abort', relay, { once: true });
        }
        return runAgent({
          project: c.project,
          workspace: c.workspace,
          drafts: c.drafts,
          sessionId: c.current.id,
          provider,
          ask: userTurn.content,
          target: c.current.target,
          limits,
          signal: lease.signal,
          on: {
            onStep: (step, message) => {
              task.report({ message, current: step });
              c.post({ type: 'agentStep', turnId: assistantTurn.id, step, message });
            },
            onDelta: (delta) => c.post({ type: 'delta', turnId: assistantTurn.id, text: delta }),
            onToolCall: (call) => {
              const title = call.display?.title ?? call.name;
              titles.set(call.callId, title);
              c.post({
                type: 'toolCall',
                turnId: assistantTurn.id,
                callId: call.callId,
                name: call.name,
                title,
                detail: call.display?.detail,
              });
            },
            onToolResult: (r) => {
              toolCalls.push({
                callId: r.callId,
                name: r.name,
                title: titles.get(r.callId) ?? r.name,
                ok: r.ok,
                summary: r.summary,
                elapsedMs: r.elapsedMs,
              });
              c.post({ type: 'toolResult', turnId: assistantTurn.id, ...r });
            },
            onNote: (message) => c.toast(message),
          },
        });
      },
      { scope: 'Agent' }
    );

    assistantTurn.content = outcome.text;
    assistantTurn.toolCalls = toolCalls.length > 0 ? toolCalls : undefined;
    // 作者叫停与点停止是同一回事：气泡上都标「已中断」，翻回去看得出没跑完。
    if (outcome.stopReason === 'cancelled' || outcome.stopReason === 'declined') {
      assistantTurn.interrupted = true;
    } else if (outcome.stopReason === 'error') {
      assistantTurn.error = outcome.message;
    }

    // 最后一份草稿就是它给作者的那份产物——采纳按钮吃它。
    // 一轮里生成多次时只挂最后那一份：更早的那些是它自己迭代的中间稿，
    // 摊在一个气泡上给三个采纳按钮，作者分不清该点哪个。
    const draftId = outcome.draftIds[outcome.draftIds.length - 1];
    const draft = draftId ? c.drafts.get(draftId) : undefined;
    if (draft?.artifact) {
      c.current.drafts = c.drafts.bySession(c.current.id);
      assistantTurn.draftId = draft.id;
      assistantTurn.artifact = await describeArtifactOf(c, draft.raw, draft);
    }

    c.post({
      type: 'agentDone',
      turnId: assistantTurn.id,
      stopReason: outcome.stopReason,
      message: outcome.message,
      steps: outcome.steps,
      calls: outcome.calls,
      tokens: outcome.tokens,
    });
    if (outcome.message && outcome.stopReason !== 'done') {
      c.toast(outcome.message, outcome.stopReason === 'error' ? 'error' : 'info');
    }
  } finally {
    lease.release();
    c.post({ type: 'busy', value: false });
  }

  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  await persist(c);
  log.info('agent 这一轮结束', `调了 ${toolCalls.length} 个工具`);
  // 四期的 write / edit / run 会真的改磁盘，流水线必须刷。
  await pushPipeline(c);
  c.post({ type: 'session', session: serializeSession(c.current) });
}
