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
 * 2. **走 `runTask`**（第 11 条）——日志与可取消照旧，但 `hidden` 不进任务表，
 *    工程页顶部不挂进度条（进度在对话页气泡里自己画）；
 * 3. **把循环的事件翻译成协议消息**——它想的、它说的话、它调的工具、它产出的
 *    正文各走各的通道（`reasoning` / `delta` / `toolCall` + `toolResult` /
 *    `toolDelta`），动手前那一句问走 [gate.ts](gate.ts)（贴在输入框上方，
 *    不弹全局模态框）；
 * 4. **把这一轮的痕迹按发生顺序存进会话**——见下面的 `segments`。
 *
 * ## 顺序是这一轮唯一存不回来的东西
 *
 * 从前这里存的是 `content` 一整块 + `toolCalls` 一整串，于是界面只能画成「所有
 * 工具 / 一整段话」；而 `content` 拿的还是 `outcome.text`——**最后一回合**那段
 * 文字，中间几回合说的话跑完就没了（跑的时候在气泡里见过，刷新之后消失）。
 * 现在改成一边跑一边攒 `segments`：想的、说的与做的交替，工具段里那个
 * `TurnToolCall` 就是 `calls` 里的同一个对象，结果与落盘结论都就地补上去。
 *
 * **思考也是一段**（`kind: 'reasoning'`），不是气泡顶上那一整块：`ChatTurn.reasoning`
 * 那个字段是单步创作的形状（一轮只调一次模型，思考自然只有一份）。agent 一轮
 * 要调好几次，每个回合各想一次——攒成一块就看不出「它读完这三章之后在想什么」。
 *
 * 判断、装配、预算全在 `core/agent/` 里，这里一条都不重复。
 */
import type { ChatController } from './index';
import { readConfig } from '../config';
import { debugEnabled } from '../runtime/debug';
import { buildProvider } from '../llm/registry';
import { runTask } from '../runtime/progress';
import { scoped } from '../runtime/logger';
import { describeModelIssue, providerLabel, resolveModelRef } from '../model/providers';
import { refsForTask } from '../model/tiers';
import {
  Attachment,
  ChatTurn,
  TurnDebug,
  TurnSegment,
  TurnToolCall,
  deriveTitle,
  makeTurnId,
  nowIso,
  pruneSegments,
  pushReasoningSegment,
  pushTextSegment,
  textOfSegments,
  turnPreview,
} from '../model/session';
import { runAgent } from '../agent/loop';
import type { BudgetLimits } from '../agent/budget';
import { createNovelTools } from '../tools/novel';
import { askArtifact, describeArtifactOf, pushPipeline } from './chat';
import { askGate, cancelGates } from './gate';
import { foldSkills } from './skills';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('面板');

/** 参数那一段的上限。路径与查询词都短，几百字够看，一大段内嵌文本没必要全留。 */
const ARGS_LIMIT = 800;
/** 返回那一段的上限。工具按契约本就回短文本，这道闸只防写坏了的那一个。 */
const RESULT_LIMIT = 2000;
/**
 * `generate` 产出的正文上限。
 *
 * 比上面两档宽得多——这不是给作者「核对一下」的明细，而是**产物本身**（一章
 * 正文三千字，一份全书大纲六千字），截短了那张卡就没意义了。仍然要有个头：
 * 它随会话落盘，一轮里连着生成五份的话，会话文件不能被它撑爆。
 */
const OUTPUT_LIMIT = 20000;

/**
 * 调试模式下的那一套上限。
 *
 * 上面三档是按「界面上要画多长」定的，而排查要的恰恰是被截掉的那一段——
 * 「它读那一章时到底拿回了什么」在一个 2000 字的省略号后面就永远查不出来。
 * 所以调试档整体放宽两个数量级，但**仍然有上限**：无限大的话，一次读了整卷
 * 正文的调用就能把会话文件撑到几十兆，那份文件本身也就没法看了。截了照旧
 * 自报（第 2 条），而完整的那一份在调试目录里。
 */
const DEBUG_LIMITS = { args: 20000, result: 200000, output: 200000 };

/** 这一轮按哪一套上限截。开着调试就宽，平时就窄。 */
function limitsNow(): { args: number; result: number; output: number } {
  return debugEnabled()
    ? DEBUG_LIMITS
    : { args: ARGS_LIMIT, result: RESULT_LIMIT, output: OUTPUT_LIMIT };
}

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
function describeArgs(
  args: Record<string, unknown> | undefined,
  limit = ARGS_LIMIT
): string | undefined {
  if (!args || Object.keys(args).length === 0) {
    return undefined;
  }
  try {
    return clip(JSON.stringify(args, null, 2), limit);
  } catch {
    // 循环引用之类的怪东西：明细不是关键路径，画不出来就不画。
    return undefined;
  }
}

/**
 * 把落盘的结论补到那一次调用上。
 *
 * **一次调用一行**：一轮 agent 可能生成三份产物，写了两份、拒了一份——挂在
 * 气泡上的单个「产物」字段说不清这件事，而每一次调用本来就各占一段、随会话
 * 留得住。就地改那个对象（段里存的是同一个引用），再重推一条 `toolResult`，
 * 前端按 callId 换掉那一行。
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
 * 这一轮的排查线索。**只在调试模式下调**。
 *
 * 上下文快照存的是**工程内相对路径**：会话文件跟着工程走（提交、换机器），
 * 一串绝对路径换台机器就全指不到了。日志里那一条仍是绝对路径——那一条是
 * 当场就要点开的。
 */
function describeRun(
  c: ChatController,
  model: string,
  policy: string,
  startedAtMs: number,
  contexts: string[]
): TurnDebug {
  return {
    model,
    thinking: c.current.thinking ?? 'off',
    policy,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: nowIso(),
    elapsedMs: Date.now() - startedAtMs,
    contexts: contexts.length > 0 ? contexts.map((at) => c.project.relPath(at)) : undefined,
  };
}

/**
 * 让 agent 跑一轮。
 *
 * `budgetLimits` 由前端可选带上（日后的设置页），缺省走 `budget.ts` 那三条。
 * （名字里带 budget 是为了跟这一轮的**截断上限** `limits` 分开——后者是
 * 「会话里那几个字段各留多长」，两个都叫 limits 时改错一个不会报错。）
 */
export async function sendAgent(
  c: ChatController,
  text: string,
  budgetLimits?: Partial<BudgetLimits>
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
  // 呼出的技能与附件同一个生命周期：**一次性**。发出去就清空，下一句话不会
  // 莫名其妙又带上刚才那几千字（作者会以为它自己记住了这套方法）。
  const skills = [...c.pendingSkills];
  const userTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'user',
    content: text.trim(),
    at: nowIso(),
    attachments: attachments.length > 0 ? attachments : undefined,
    skills: skills.length > 0 ? skills.map((s) => s.name) : undefined,
  };
  c.current.turns.push(userTurn);
  if (c.current.turns.length === 1) {
    c.current.title = deriveTitle(turnPreview(userTurn));
  }
  // 引用是一次性的，与单步那条路同一套：发出去就清空，下一句话不会莫名其妙
  // 又带上刚才那份文件。
  c.pending = [];
  c.pendingSkills = [];
  c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
  c.post({ type: 'attachments', items: [] });
  c.post({ type: 'pendingSkills', items: [] });
  await persist(c);

  // 并发控制与单步共用同一把锁：两条路同时跑会让 draft 与流式内容互相盖。
  const lease = c.beginGeneration();
  if (!lease) {
    c.toast('已有一个生成任务在进行中。', 'error');
    return;
  }
  c.post({ type: 'busy', value: true });

  const assistantTurn: ChatTurn = { id: makeTurnId(), role: 'assistant', content: '', at: nowIso() };
  const startedAtMs = Date.now();
  c.current.turns.push(assistantTurn);
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });

  /**
   * 这一轮排下来的段：它想的、它说的话与它做的事，**按发生顺序**。存进会话的
   * 就是这个。攒段那几个纯函数在 `model/session.ts`（`pushTextSegment` 等）。
   */
  const segments: TurnSegment[] = [];
  /**
   * 这一轮按哪一套截断上限。**开跑时定一次**：中途去设置页勾上调试，不该让
   * 同一轮里前三次调用截在 2000 字、后两次留全文——那种会话文件比两者中的
   * 任何一种都难读。
   */
  const limits = limitsNow();
  /**
   * 同样这些工具调用，按 callId 找得到的那一面。
   *
   * 里面是**与段里同一个对象**：结果到了、落盘的结论出来了，就地改这一个，
   * 段不必重建。
   */
  const calls: TurnToolCall[] = [];
  const callOf = (callId: string) => calls.find((call) => call.callId === callId);

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
          // 作者那句话 + 他 @ 的材料 + 他用 `/` 呼出的方法论。三样都折进第一条
          // 消息：agent 没有装配器（第 20 条），上下文由它一步步自己读出来。
          ask: foldSkills(foldAttachments(userTurn.content, attachments), skills),
          target: c.current.target,
          limits: budgetLimits,
          // 调试模式下，每回合的完整上下文落在这个会话的调试目录里；
          // 路径随 outcome.contexts 交回来，记进这一轮的 `debug` 块。
          sessionId: c.current.id,
          // 与对话页的单次生成同一档：作者调的是「这件事让它想多深」，
          // 而 agent 的每一回合都是这件事的一部分。
          thinking: c.current.thinking,
          signal: lease.signal,
          on: {
            onStep: (step, message) => {
              task.report({ message, current: step });
              c.post({ type: 'agentStep', turnId: assistantTurn.id, step, message });
            },
            onDelta: (delta) => {
              pushTextSegment(segments, delta);
              c.post({ type: 'delta', turnId: assistantTurn.id, text: delta });
            },
            // 它想的那一段：**另一段**，不进 `content`（`textOf` 只取文字段）。
            // 一轮里每个回合各想一次，按发生顺序排进段里——攒成气泡顶上那一整块
            // 的话，「它读完这三章之后在想什么」就没了，而那正是作者要看的。
            onReasoning: (delta) => {
              pushReasoningSegment(segments, delta);
              c.post({ type: 'reasoning', turnId: assistantTurn.id, text: delta });
            },
            onToolCall: (call) => {
              // 段在**调用开始时**就占上位置：顺序是这一轮唯一存不回来的东西，
              // 等结果到了再记就只剩「所有工具挤在一起」那副样子。
              const row: TurnToolCall = {
                callId: call.callId,
                name: call.name,
                title: call.display?.title ?? call.name,
                ok: false,
                summary: '进行中…',
                elapsedMs: 0,
                argsText: describeArgs(call.args, limits.args),
              };
              calls.push(row);
              segments.push({ kind: 'tool', call: row });
              c.post({
                type: 'toolCall',
                turnId: assistantTurn.id,
                callId: row.callId,
                name: row.name,
                title: row.title,
                detail: call.display?.detail,
                argsText: row.argsText,
              });
            },
            onToolResult: (r) => {
              // 明细在这里截一次，界面与会话里存的是同一份——两处不一样的话，
              // 作者当场看到的和第二天翻回来看到的就对不上。
              const argsText = describeArgs(r.args, limits.args);
              const resultText = r.text ? clip(r.text, limits.result) : undefined;
              // 就地补齐 `onToolCall` 那一刻占下的那一段。认不出的 callId 补一段
              // 在末尾——少画一条不如画在错的位置上（两者都不该发生）。
              const row = callOf(r.callId);
              if (row) {
                row.ok = r.ok;
                row.summary = r.summary;
                row.elapsedMs = r.elapsedMs;
                row.argsText = argsText ?? row.argsText;
                row.resultText = resultText;
              } else {
                const late: TurnToolCall = {
                  callId: r.callId,
                  name: r.name,
                  title: r.name,
                  ok: r.ok,
                  summary: r.summary,
                  elapsedMs: r.elapsedMs,
                  argsText,
                  resultText,
                };
                calls.push(late);
                segments.push({ kind: 'tool', call: late });
              }
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
            // `generate` 产出的正文：**另一条通道**，进它自己那一段（界面上是一
            // 张单独的卡片）。攒的是原文，收尾时才截一次——每来一段就截会把
            // 「已截断」那句话夹进正文中间。
            onToolDelta: ({ callId, text: delta }) => {
              const row = callOf(callId);
              if (row) {
                row.output = (row.output ?? '') + delta;
              }
              c.post({ type: 'toolDelta', turnId: assistantTurn.id, callId, text: delta });
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
                  // 闸门那张卡片画在输入框上方，**永远按界面档截**：调试开着
                  // 时那两万字的参数会把整个对话页挤没，而作者要判断的只是
                  // 「它要动哪个文件」。完整的那一份在调试目录里。
                  argsText: describeArgs(req.args),
                  proceed: req.proceed,
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
                // 解析不出可落盘的形状：没什么可写的，不问作者。
                //
                // 但**必须告诉模型这件事**。`generate` 的返回里写着「要不要落盘
                // 正在问他，结论就在下面」，一句空 note 会让那句话变成谎话——
                // 抓到过的现场就是 agent 转头跟作者说「分卷清单已生成，正在等
                // 你点头」，而作者那边一张卡片都没有。
                return {
                  note: draft
                    ? '这份产出解析不出可落盘的形状（不是这一层要的结构），' +
                      '所以**没有问作者、也没有落盘**。别当成已经写下去了：' +
                      '要么按这一层要的结构重做一次，要么把情况告诉作者。'
                    : '',
                };
              }
              c.current.drafts = c.drafts.bySession(c.current.id);
              const r = await askArtifact(c, {
                turnId: assistantTurn.id,
                draft,
                art,
                callId: req.callId,
                signal: lease.signal,
              });
              // 决定记在那条工具条上（一次调用一行），随会话留住——
              // 翻回来看得出「这一份我当时没要」。
              noteOnToolRow(c, assistantTurn.id, calls, req.callId, r.relPath ? `已写入 ${r.relPath}` : '未采纳');
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
      // hidden：agent 的进度在对话页气泡里自己画（步骤/工具/花销），工程页顶部
      // 不必再挂一块「Agent」进度条。宿主原生进度与日志照旧。
      { scope: 'Agent', hidden: true }
    );

    // 产出的正文在这里截一次（流的时候攒的是原文）：它随会话落盘，一轮里连着
    // 生成五份的话，会话文件不能被它撑爆。截了会自报（第 2 条）。
    for (const call of calls) {
      if (call.output) {
        call.output = clip(call.output, limits.output);
      }
    }
    // 只剩空白的文字段清出去：留着它们，刷新之后气泡里会凭空多出几块空盒子。
    const kept = pruneSegments(segments);
    assistantTurn.segments = kept.length > 0 ? kept : undefined;
    // `content` 是「这一轮说的话」，拼的是那几段文字。回落到 `outcome.text`：
    // 一句话都没说（报错、刚开始就被停）时它至少还有一句「为什么停」。
    assistantTurn.content = textOfSegments(kept) || outcome.text;
    // 第 4 条：花了多少必须留在会话里。只在跑的时候闪一下的话，作者第二天
    // 回来翻这一轮就看不出它花了多少。
    assistantTurn.agentRun = {
      steps: outcome.steps,
      calls: outcome.calls,
      tokens: outcome.tokens,
      stopReason: outcome.stopReason,
      message: outcome.message || undefined,
    };
    // 调试模式：把「哪个模型、想多深、完整上下文在哪几个文件里」记进这一轮。
    // 关着时**一个字都不写**——留一个空对象在会话里，日后读的人会以为这一轮
    // 开过调试却什么都没留下。
    if (debugEnabled()) {
      assistantTurn.debug = describeRun(c, dispatch.ref, config.agentPolicy, startedAtMs, outcome.contexts);
    }
    // 作者叫停与点停止是同一回事：气泡上都标「已中断」，翻回去看得出没跑完。
    if (outcome.stopReason === 'cancelled' || outcome.stopReason === 'declined') {
      assistantTurn.interrupted = true;
    } else if (outcome.stopReason === 'error' || outcome.stopReason === 'protocol') {
      // `protocol` 是「接口把工具调用那一段丢了」（见 loop.ts 的 PROTOCOL_RETRIES）。
      // 归到 error 那一档：它跟别的停因不一样，**不换服务商就一直是这样**，
      // 提示条得是红的，气泡上也要留住这句话——不然作者第二天回来只看到
      // 「agent 说了一句就停」，又要从头查一遍。
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
      c.toast(
        outcome.message,
        outcome.stopReason === 'error' || outcome.stopReason === 'protocol' ? 'error' : 'info'
      );
    }
  } finally {
    lease.release();
    c.post({ type: 'busy', value: false });
  }

  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  await persist(c);
  log.info('agent 这一轮结束', `调了 ${calls.length} 个工具，${segments.length} 段`);
  // 四期的 write / edit / run 会真的改磁盘，流水线必须刷。
  await pushPipeline(c);
  c.post({ type: 'session', session: serializeSession(c.current) });
}
