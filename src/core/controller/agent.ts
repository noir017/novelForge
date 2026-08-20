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
 * 3. **把循环的事件翻译成协议消息**——工具调用画成气泡里的折叠条，动手前那一句
 *    问也画在同一串上（[gate.ts](gate.ts)），不弹全局模态框；
 * 4. **把这一轮的痕迹存进会话**——摘要，加上截断过的参数与返回文本。
 *
 * 判断、装配、预算全在 `core/agent/` 里，这里一条都不重复。
 */
import type { ChatController } from './index';
import { readConfig } from '../config';
import { buildProvider } from '../llm/registry';
import { runTask } from '../runtime/progress';
import { scoped } from '../runtime/logger';
import { describeModelIssue, providerLabel, resolveModelRef } from '../model/providers';
import { refsForTask } from '../model/tiers';
import { Attachment, ChatTurn, TurnToolCall, deriveTitle, makeTurnId, nowIso, turnPreview } from '../model/session';
import { runAgent } from '../agent/loop';
import type { BudgetLimits } from '../agent/budget';
import { createNovelTools } from '../tools/novel';
import { askArtifact, describeArtifactOf, pushPipeline } from './chat';
import { askGate, cancelGates } from './gate';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('面板');

/** 参数那一段的上限。路径与查询词都短，几百字够看，一大段内嵌文本没必要全留。 */
const ARGS_LIMIT = 800;
/** 返回那一段的上限。工具按契约本就回短文本，这道闸只防写坏了的那一个。 */
const RESULT_LIMIT = 2000;

/**
 * 截一段给界面看的文本。**说出自己截了**（第 2 条：不静默截断）——
 * 作者展开明细就是为了核对，看不出后面还有内容的话，他会把半截当全部。
 */
function clip(text: string, limit: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…（还有 ${trimmed.length - limit} 字，已截断）`;
}

/**
 * 模型这一次填的参数，排成折叠条里那一段 JSON。
 *
 * 没参数的工具（`status` 那类）回 undefined 而不是 `{}`——空花括号只是让作者
 * 多点开一次才发现没东西可看。
 */
function describeArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) {
    return undefined;
  }
  try {
    return clip(JSON.stringify(args, null, 2), ARGS_LIMIT);
  } catch {
    // 循环引用之类的怪东西：明细不是关键路径，画不出来就不画。
    return undefined;
  }
}

/**
 * 把落盘的结论补到那条工具条上。
 *
 * **一次调用一行**：一轮 agent 可能生成三份产物，写了两份、拒了一份——挂在
 * 气泡上的单个「产物」字段说不清这件事，而工具条本来就是一次一行、随会话
 * 留得住。就地重推一条 `toolResult`，前端按 callId 换掉那一行。
 */
function noteOnToolRow(
  c: ChatController,
  turnId: string,
  rows: TurnToolCall[],
  callId: string | undefined,
  note: string
): void {
  const row = rows.find((r) => r.callId === callId);
  if (!row) {
    return;
  }
  row.summary = `${row.summary} · ${note}`;
  c.post({
    type: 'toolResult',
    turnId,
    callId: row.callId,
    name: row.name,
    ok: row.ok,
    summary: row.summary,
    elapsedMs: row.elapsedMs,
    argsText: row.argsText,
    resultText: row.resultText,
  });
}

/**
 * 调度模型：「Agent 调度」档里第一个解析得出的模型。
 *
 * 那一档没配（或配的引用全都认不出来）就回落到对话页选定的那个——**不是硬
 * 失败**：对话本身现在就走这条路，硬失败会让「发一句话」变成一条要先读文档
 * 才走得通的路。
 */
function pickDispatchModel(config: ReturnType<typeof readConfig>) {
  for (const ref of refsForTask(config, 'agent').refs) {
    const active = resolveModelRef(config.providers, ref);
    if (active) {
      return active;
    }
  }
  return config.active;
}

/**
 * 把 `@ 引用` 折进作者那句话。
 *
 * agent 没有装配器（第 20 条：上下文由它一步步自己读出来），引用没法像单步
 * 那条路一样交给装配器——但也不能就这么丢掉：作者点了「@ 引用」就是在说
 * 「先看这个」。所以整文件只给**路径**（它手里有 `read`，自己读比把几万字
 * 塞进第一条消息便宜得多），选区则必须**内联**：那份快照只存在会话里，
 * 磁盘上的文件可能早就改了。
 */
function foldAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const lines = [text, '', '# 作者引用的材料'];
  for (const a of attachments) {
    if (a.text) {
      lines.push(`## ${a.label}${a.relPath ? `（${a.relPath}）` : ''}`, '```', a.text.trim(), '```');
    } else if (a.relPath) {
      lines.push(`- ${a.relPath}（需要就用 read 读它）`);
    } else {
      lines.push(`- ${a.label}`);
    }
  }
  return lines.join('\n');
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
  // 调度模型取「Agent 调度」那一档里第一个解析得出的；那一档没配时沿用对话页
  // 选定的那个（那是分档之前的行为，能跑）。
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

  // 上一轮那张还没答的落盘卡片就此作废（同 `runTurn`）。
  cancelGates(c);

  const attachments = [...c.pending];
  const userTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'user',
    content: text.trim(),
    at: nowIso(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  c.current.turns.push(userTurn);
  if (c.current.turns.length === 1) {
    c.current.title = deriveTitle(turnPreview(userTurn));
  }
  // 引用是一次性的，与单步那条路同一套：发出去就清空，下一句话不会莫名其妙
  // 又带上刚才那份文件。
  c.pending = [];
  c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
  c.post({ type: 'attachments', items: [] });
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

  /** 这一轮调过的工具。摘要 + 截断过的参数与返回——完整返回值可能是几万字。 */
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
          // 工具在这里绑环境：循环自己碰不到 workspace 与 draft store
          // （`core/tools/README.md` 的分层）。
          tools: createNovelTools({
            project: c.project,
            workspace: c.workspace,
            drafts: c.drafts,
            sessionId: c.current.id,
          }),
          provider,
          ask: foldAttachments(userTurn.content, attachments),
          target: c.current.target,
          limits,
          // 与对话页的单次生成同一档：作者调的是「这件事让它想多深」，
          // 而 agent 的每一回合都是这件事的一部分。
          thinking: c.current.thinking,
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
                argsText: describeArgs(call.args),
              });
            },
            onToolResult: (r) => {
              // 明细在这里截一次，界面与会话里存的是同一份——两处不一样的话，
              // 作者当场看到的和第二天翻回来看到的就对不上。
              const argsText = describeArgs(r.args);
              const resultText = r.text ? clip(r.text, RESULT_LIMIT) : undefined;
              toolCalls.push({
                callId: r.callId,
                name: r.name,
                title: titles.get(r.callId) ?? r.name,
                ok: r.ok,
                summary: r.summary,
                elapsedMs: r.elapsedMs,
                argsText,
                resultText,
              });
              c.post({
                type: 'toolResult',
                turnId: assistantTurn.id,
                callId: r.callId,
                name: r.name,
                ok: r.ok,
                summary: r.summary,
                elapsedMs: r.elapsedMs,
                argsText,
                resultText,
              });
            },
            // 闸门那一句问在对话页里（`gate.ts`），不是一个盖住窗口的模态框——
            // 作者要判断的上下文（它刚读了什么、正要写哪个文件）就在气泡里。
            onGate: (req) =>
              askGate(
                c,
                {
                  turnId: assistantTurn.id,
                  callId: req.callId,
                  name: req.name,
                  title: req.title,
                  detail: req.detail,
                  // 参数与工具条上展开看到的是同一份截断（同一个 describeArgs）：
                  // 两处不一样的话，作者点头时看到的和随后核对的就对不上。
                  argsText: describeArgs(req.args),
                  proceed: req.proceed,
                  stoppable: true,
                },
                lease.signal
              ),
            // 产出了可落盘的产物：**当场问一句**（第 19 条，与策略无关）。
            // 从前这是气泡末尾那颗「采纳写入」，可以拖到第二天再点，而
            // agent 早就接着往下做了。
            onArtifact: async (req) => {
              const draftId = req.draftIds[req.draftIds.length - 1];
              const draft = draftId ? c.drafts.get(draftId) : undefined;
              const art = draft?.artifact ? await describeArtifactOf(c, draft.raw, draft) : undefined;
              if (!draft || !art) {
                // 解析不出可落盘的形状（讨论类的产出）：没什么可写的，不问。
                return { note: '' };
              }
              c.current.drafts = c.drafts.bySession(c.current.id);
              const r = await askArtifact(c, {
                turnId: assistantTurn.id,
                draft,
                art,
                byAgent: true,
                callId: req.callId,
                // **不打开文件**：一轮里它可能连着写好几份，一次次抢编辑器。
                open: false,
                signal: lease.signal,
              });
              // 决定记在那条工具条上（一次调用一行），随会话留住——
              // 翻回来看得出「这一份我当时没要」。
              noteOnToolRow(c, assistantTurn.id, toolCalls, req.callId, r.relPath ? `已写入 ${r.relPath}` : '未采纳');
              return {
                note: r.relPath
                  ? `${r.message}这份产物已经落盘，**不要再写一遍**。`
                  : `${r.message}**不要重复生成同一份**——问问作者要改什么。`,
                stop: r.verdict === 'stop',
              };
            },
            onNote: (message) => c.toast(message),
          },
        });
      },
      { scope: 'Agent' }
    );

    assistantTurn.content = outcome.text;
    assistantTurn.toolCalls = toolCalls.length > 0 ? toolCalls : undefined;
    // 第 4 条：花了多少必须留在会话里。只在跑的时候闪一下的话，作者第二天
    // 回来翻这一轮就看不出它花了多少。
    assistantTurn.agentRun = {
      steps: outcome.steps,
      calls: outcome.calls,
      tokens: outcome.tokens,
      stopReason: outcome.stopReason,
      message: outcome.message || undefined,
    };
    // 作者叫停与点停止是同一回事：气泡上都标「已中断」，翻回去看得出没跑完。
    if (outcome.stopReason === 'cancelled' || outcome.stopReason === 'declined') {
      assistantTurn.interrupted = true;
    } else if (outcome.stopReason === 'error') {
      assistantTurn.error = outcome.message;
    }

    // 这一轮的产物落没落盘，在产出的当下就问过了（`onArtifact`），结论记在
    // 各自那条工具条上。所以气泡上**没有**一个「最后那份产物」——一轮里
    // 它可能写了三份，也可能三份都被拒了。

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
