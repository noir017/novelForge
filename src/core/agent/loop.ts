/**
 * agent 循环。
 *
 * ## 它只有一件事要做：把回合串起来
 *
 * 循环本身很短，因为**工具体全是前三期成果的薄包装**，状态判断全在
 * `model/pipeline.ts`，装配全在 `context/`。这里剩下的只有三件真正属于
 * 「调度」的事：
 *
 * 1. **每回合注入状态**（`buildStateBrief`）——agent 与界面主按钮读的是同一个
 *    `deriveNextStep`，不可能分叉（AGENTS 第 20 条）。
 * 2. **压缩自己的历史**（`buildAgentMessages`）——工具结果会一条条涨起来。
 * 3. **看着预算**（`budget.ts`）——三条上限 + 无进展检测。
 * 4. **过闸门**（`policy.ts`）——写盘之前要不要先问作者一句。**闸门不是保护**：
 *    八条守卫与覆盖前审阅在 `workspace/` 那一层，任何策略下都在。
 *
 * ## 一个回合
 *
 * ```
 * 1. 触顶 / 无进展 → 最后一轮（toolChoice: 'none'）让它总结，然后停
 * 2. buildAgentMessages(system + 状态注入, turns, 预算)
 * 3. provider.stream(messages, { tools })
 * 4. 收流：text → 推气泡；toolCall → 收集；usage → 记账
 * 5. 没有 toolCall → 模型给出了最终回答，结束
 * 6. 有 toolCall → 逐个过闸门、执行，结果作为 role:'tool' 追加，回到 1
 * ```
 *
 * ## 取消停在工具边界
 *
 * `signal.aborted` 时不再发起下一次模型调用，也不再执行下一个工具；**正在跑的
 * `generate` 靠它自己的 signal 停**（`ToolContext.signal` 就是同一个）。已经
 * 产出的 draft 保留——那是花过钱的东西，取消的是「接着往下做」，不是「刚才
 * 做的作废」。
 *
 * ## 不静默停
 *
 * 无论因为什么停（触顶、原地打转、压不下上下文），都给模型最后一次机会说明
 * 「做到哪了、还差什么」。直接掐断的话作者只看到一段没头没尾的输出，不知道
 * 该从哪接着做（第 2 / 4 条）。
 */
import { AgentMessage, LlmProvider, StreamOptions, ToolCall } from '../llm/provider';
import { collect } from '../llm/collect';
import { getHost } from '../host';
import { readConfig } from '../config';
import { CancelledError } from '../llm/provider';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { CreationTarget } from '../model/pipeline';
import { Workspace } from '../workspace';
import { DraftStore } from '../generation/drafts';
import { Budget, BudgetLimits } from './budget';
import { buildAgentMessages, buildStateBrief } from './context';
import {
  AgentPolicy,
  Gate,
  GateVerdict,
  SKIP_ACTION,
  STOP_ACTION,
  declinedText,
  gateFor,
} from './policy';
import { ToolContext, ToolDef, ToolResult, toolSpecs } from './registry';
import { ALL_TOOLS } from './tools';

const log = scoped('Agent');

/**
 * agent 的身份提示词。
 *
 * **刻意很短，而且不写任何领域知识**：「剧情不写画面天气台词」那几句在
 * `context/prompts.ts` 里，由 `generate` **内部那次调用**自己带着。在这里再写
 * 一遍会白烧 token（每一轮都要发），而且两处迟早跑偏——跑偏之后没有任何测试
 * 会红，只有产出会一点点变味。
 *
 * 这里要说清的是**它在这套流程里是什么角色**：调度者，不是作者。
 */
export const AGENT_SYSTEM = [
  '你是 Novel Forge 的助手，帮一位中文长篇小说作者在他的工程里做事。',
  '',
  '工程里的一切都是普通 Markdown 文件，路径就是产物的身份。你有四个工具：',
  'list / read / search 查询，generate 调用模型创作产出内容。',
  '',
  '几条要守住的：',
  '- **「下一步该做什么」由状态机算，下面会告诉你结论，你拿着它去执行，不要另做判断。**',
  '  作者问的如果是别的事，就答别的事，不必硬往下一步上靠。',
  '- 动手之前先看清楚：跨章的问题用 search，具体内容用 read。凭印象回答会编出看着很像的细节。',
  '- generate 会调用llm。同一份产物不要重复生成；作者没要你写东西时不要主动写。',
  '- 你产出的内容**不会自动写盘**，作者点采纳卡片才落盘。所以不必问「要不要保存」。',
  '- 说结论时给出依据在哪一章哪一行——作者要能自己去核对。',
].join('\n');

export interface AgentHandlers {
  /** 新的一个回合开始。 */
  onStep?(step: number, message: string): void;
  /** 模型的文字增量（含 `generate` 内部那次调用的正文）。进气泡。 */
  onDelta?(text: string): void;
  /** 要调一个工具了。 */
  onToolCall?(call: { callId: string; name: string; display?: { title: string; detail?: string } }): void;
  /** 工具跑完了。 */
  onToolResult?(result: {
    callId: string;
    name: string;
    ok: boolean;
    summary: string;
    elapsedMs: number;
  }): void;
  /** 工具或循环想说点什么给作者看（用量、提示）。**不进 agent 上下文。** */
  onNote?(message: string): void;
}

export type StopReason =
  /** 模型自己给出了最终回答。 */
  | 'done'
  | 'steps'
  | 'calls'
  | 'tokens'
  /** 原地打转（连续三次同工具同参数）。 */
  | 'stalled'
  /** 上下文压到底仍然超预算。 */
  | 'overBudget'
  /** 作者在确认框里选了「停止 agent」。 */
  | 'declined'
  | 'cancelled'
  | 'error';

export interface AgentOutcome {
  /** 模型最后那段话。进气泡，也存进会话。 */
  text: string;
  stopReason: StopReason;
  /** 为什么停的一句人话。非 `done` 时进气泡。 */
  message: string;
  steps: number;
  calls: number;
  tokens: number;
  /** 本次产出的草稿 id，按产生顺序。采纳按钮吃它们。 */
  draftIds: string[];
}

export interface RunAgentOptions {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  sessionId: string;
  /** 必须支持工具调用。 */
  provider: LlmProvider;
  /** 作者这一轮说的话。 */
  ask: string;
  /** 当前选中的那一章，用于状态注入。没选就不给。 */
  target?: CreationTarget;
  limits?: Partial<BudgetLimits>;
  signal: AbortSignal;
  /** 注册哪些工具。缺省七件套（含 write / edit / run）。 */
  tools?: ToolDef[];
  /**
   * 哪些动作动手前先问一句。缺省读配置。
   *
   * **只管「要不要先问」**：覆盖前审阅与批量动作的确认框在任何模式下都在。
   */
  policy?: AgentPolicy;
  on?: AgentHandlers;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentOutcome> {
  const { project, signal, on = {} } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const budget = new Budget(opts.limits);
  const config = readConfig();
  const policy = opts.policy ?? config.agentPolicy;
  const startedAt = Date.now();

  const draftIds: string[] = [];
  const turns: AgentMessage[] = [{ role: 'user', content: opts.ask }];
  const specs = toolSpecs(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const ctx: ToolContext = {
    project,
    workspace: opts.workspace,
    drafts: opts.drafts,
    sessionId: opts.sessionId,
    signal,
    budget,
    report: (m) => on.onNote?.(m),
    onDelta: (d) => on.onDelta?.(d),
  };

  // 输入预算：与创作那一层同源（对话页选定模型的窗口减去输出预留）。
  const inputBudget = Math.max(2000, config.contextWindow - config.maxOutputTokens - 1024);

  log.info(`开始 agent 循环`, `上限 ${budget.limits.steps} 回合 / ${budget.limits.calls} 次生成`);

  let text = '';
  let stopReason: StopReason = 'done';
  let message = '';
  /** 下一回合是最后一轮：不给工具，只让它总结。 */
  let finalRound = false;

  try {
    for (;;) {
      if (signal.aborted) {
        stopReason = 'cancelled';
        message = '已停止。已经生成的内容仍然在，可以照常采纳。';
        break;
      }

      const over = budget.exceeded();
      if (over && !finalRound) {
        finalRound = true;
        stopReason = over.what;
        message = over.message;
        on.onNote?.(`${over.message} 让它先说明一下做到哪了。`);
      }

      const brief = await buildStateBrief(project, opts.target);
      const built = buildAgentMessages(`${AGENT_SYSTEM}\n\n${brief}`, turns, inputBudget);
      if (built.overBudget && !finalRound) {
        // 压到底还超：停下来说清楚，好过默默丢掉一半上下文再给一个看着正常的答案。
        finalRound = true;
        stopReason = 'overBudget';
        message = '这一轮攒下的资料已经超出模型窗口，先收尾。可以拆成几个小问题分别问。';
        on.onNote?.(message);
      }

      budget.step();
      on.onStep?.(budget.steps, finalRound ? '收尾' : `第 ${budget.steps} 步`);

      const streamOptions: StreamOptions = {
        maxOutputTokens: config.maxOutputTokens,
        temperature: config.temperature,
        timeoutMs: config.requestTimeoutMs,
        signal,
        // 最后一轮不给工具：`toolChoice: 'none'` 之外还得真的把 tools 摘掉，
        // 有些兼容实现见到 tools 就还会调。
        ...(finalRound ? {} : { tools: specs, toolChoice: 'auto' as const }),
      };

      let round = '';
      const result = await collect(opts.provider.stream(built.messages, streamOptions), {
        onDelta: (delta) => {
          round += delta;
          on.onDelta?.(delta);
        },
        onUsage: (usage) => budget.addTokens((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      });
      // provider 没给用量时按估算记一笔——不记的话 token 上限形同虚设。
      if (result.usage.inputTokens === undefined && result.usage.outputTokens === undefined) {
        budget.addTokens(built.tokens);
      }
      text = result.text.trim() || text;

      // 取消可能发生在流中间。规矩的 provider 会抛 `CancelledError`，但也有
      // 直接把流收掉、正常返回的——那时手里是一段半截的回答，**不能当成
      // 「模型给出了最终回答」**。
      if (signal.aborted) {
        stopReason = 'cancelled';
        message = '已停止。已经生成的内容仍然在，可以照常采纳。';
        break;
      }
      if (finalRound) {
        break;
      }
      if (result.toolCalls.length === 0) {
        // 没有工具调用 = 模型给出了最终回答。
        stopReason = 'done';
        break;
      }

      turns.push({ role: 'assistant', content: round, toolCalls: result.toolCalls });

      let stalledOut = false;
      let declined = false;
      let done = 0;
      for (const call of result.toolCalls) {
        if (signal.aborted) {
          break;
        }
        done += 1;
        const record = budget.recordTool(call.name, call.args);
        if (record.stop) {
          // 提示过了还来第三次：不再执行，直接收尾。这是最常见的烧钱方式。
          turns.push(toolMessage(call, budget.stallHint(call.name)));
          stalledOut = true;
          break;
        }
        if (record.stalled) {
          turns.push(toolMessage(call, budget.stallHint(call.name)));
          on.onNote?.(`它在重复同一个动作（${call.name}），已经提示换个思路。`);
          continue;
        }

        // 闸门：这一步要不要先问作者一句（`policy.ts`）。守卫与覆盖审阅在
        // 下面两层，与策略无关——这里只决定「动手之前问不问」。
        const tool = byName.get(call.name);
        const gate = tool ? gateFor(policy, tool, call.args ?? {}, project) : { confirm: false };
        const verdict = await askGate(gate, on, call.name);
        if (verdict !== 'proceed') {
          turns.push(toolMessage(call, declinedText(verdict, gate)));
          on.onToolCall?.({ callId: call.id, name: call.name, display: { title: `${call.name}（未执行）` } });
          on.onToolResult?.({
            callId: call.id,
            name: call.name,
            ok: false,
            summary: verdict === 'skip' ? '作者跳过了这一步' : '作者叫停',
            elapsedMs: 0,
          });
          if (verdict === 'stop') {
            declined = true;
            break;
          }
          continue;
        }

        turns.push(toolMessage(call, await runTool(tool, call, ctx, on, draftIds, [...byName.keys()])));
      }

      // 中途停下（取消 / 原地打转）时**剩下的调用也要各回一条**：
      // 一次 `tool_use` 少一条 `tool_result`，Anthropic 与不少 OpenAI 兼容实现
      // 会直接 400，于是收尾那一轮连「我做到哪了」都说不出来。
      for (const call of result.toolCalls.slice(done)) {
        turns.push(toolMessage(call, '这一步没有执行：本次任务已经停下。'));
      }

      if (stalledOut) {
        finalRound = true;
        stopReason = 'stalled';
        message = '它在重复同一个动作，已经停下。换个说法再问一次多半就好了。';
        on.onNote?.(message);
      }
      if (declined) {
        // 作者叫停：**不掐断**，照旧给最后一轮说清做到哪了（第 24 条的
        // 「触顶不静默停」在这条路上同样成立）。
        finalRound = true;
        stopReason = 'declined';
        message = '已按你的选择停下。已经写下的都在，没执行的那一步什么都没改。';
        on.onNote?.(message);
      }
    }
  } catch (err) {
    if (err instanceof CancelledError || signal.aborted) {
      stopReason = 'cancelled';
      message = '已停止。已经生成的内容仍然在，可以照常采纳。';
      log.warn('agent 循环被取消', `已跑 ${budget.steps} 步，用时 ${elapsed(startedAt)}`);
    } else {
      stopReason = 'error';
      message = describeError(err);
      log.error(`agent 循环失败：${message}`, err);
    }
  }

  log.info(
    `agent 循环结束（${stopReason}）`,
    `${budget.steps} 步，${budget.calls} 次生成，约 ${budget.tokens} token，用时 ${elapsed(startedAt)}`
  );

  return {
    text,
    stopReason,
    message,
    steps: budget.steps,
    calls: budget.calls,
    tokens: budget.tokens,
    draftIds,
  };
}

// ---------------------------------------------------------------- 内部

/**
 * 跑一个工具。**绝不抛**——工具抛异常时变成 `error` 回给模型，循环继续。
 *
 * 一个工具炸掉不该带走整轮对话：模型看到错误说明会换条路，而抛出去的话作者
 * 只得到一句「处理消息时出错」，之前几步的成果全丢。
 */
async function runTool(
  tool: ToolDef | undefined,
  call: ToolCall,
  ctx: ToolContext,
  on: AgentHandlers,
  draftIds: string[],
  available: string[]
): Promise<string> {
  const startedAt = Date.now();
  // 第 11 条：**只记工具名与参数的键名**，不记值——值里可能有正文片段。
  log.debug(`调用工具 ${call.name}`, `参数键：${Object.keys(call.args ?? {}).join(', ') || '（无）'}`);

  if (!tool) {
    // 名单从**实际注册的那一份**来。写死一串名字，加了工具之后这句话就在撒谎。
    const error = `没有叫 ${call.name} 的工具。可用的是：${available.join(' / ')}。`;
    on.onToolCall?.({ callId: call.id, name: call.name });
    on.onToolResult?.({ callId: call.id, name: call.name, ok: false, summary: error, elapsedMs: 0 });
    return error;
  }

  let result: ToolResult;
  try {
    on.onToolCall?.({ callId: call.id, name: call.name });
    result = await tool.run(ctx, call.args ?? {});
  } catch (err) {
    result = { text: '', error: `工具执行失败：${describeError(err)}` };
    log.warn(`工具 ${call.name} 抛异常`, describeError(err));
  }

  // 草稿 id 从返回文本里认出来太脏，让工具自己在 display 里说不合适——
  // 直接看 store 里这一次多出来什么最实在。
  const latest = ctx.drafts.bySession(ctx.sessionId);
  for (const draft of latest) {
    if (!draftIds.includes(draft.id)) {
      draftIds.push(draft.id);
    }
  }

  const ok = !result.error;
  on.onToolResult?.({
    callId: call.id,
    name: call.name,
    ok,
    summary: result.error ?? result.display?.detail ?? firstLine(result.text),
    elapsedMs: Date.now() - startedAt,
  });
  return result.error ?? result.text;
}

/**
 * 问作者那一句。**三个选项，不是两个**：跳过这一步 / 停止 agent / 同意。
 *
 * 关掉对话框（Esc / 点外面）当**停止**：他被问「要不要动你的磁盘」而没有回答，
 * 不该替他答「继续」。停止不丢东西——已经写下的还在，模型还有最后一轮说明。
 */
async function askGate(gate: Gate, on: AgentHandlers, toolName: string): Promise<GateVerdict> {
  if (!gate.confirm) {
    return 'proceed';
  }
  const proceed = gate.proceed ?? '继续';
  const pick = await getHost().confirm(gate.message ?? `Agent 要执行 ${toolName}。`, [proceed, SKIP_ACTION, STOP_ACTION], {
    modal: true,
    detail: gate.detail,
  });
  if (pick === proceed) {
    return 'proceed';
  }
  const verdict: GateVerdict = pick === SKIP_ACTION ? 'skip' : 'stop';
  log.info(`作者${verdict === 'skip' ? '跳过了' : '叫停了'} ${toolName}`, gate.message);
  on.onNote?.(verdict === 'skip' ? `已跳过这一步（${toolName}）。` : '已叫停这一轮。');
  return verdict;
}

function toolMessage(call: ToolCall, content: string): AgentMessage {
  return { role: 'tool', toolCallId: call.id, name: call.name, content };
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return (idx === -1 ? text : text.slice(0, idx)).slice(0, 80);
}
