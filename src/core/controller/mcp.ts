/**
 * MCP 的执行端：**外部 agent 的一次工具调用，落到当前打开的这个工程上。**
 *
 * 协议在 [mcp/server.ts](../mcp/server.ts)，它只认 {@link McpBackend}。这里把那两个方法绑到
 * 一个 `ChatController` 上。每次调用各自做完，没有循环：
 *
 * | 调用的性质（工具自报的 `gate`） | 这里做什么 |
 * |---|---|
 * | `auto`（list / read / search、查技能） | 直接跑，只进日志。不占生成位、不进对话页 |
 * | 其余（generate / write / edit / run） | 占生成位、走 `runTask`（看得见、能停），在对话页挂一条工具条 |
 * | `always`（edit、装/绑技能、改技能文件） | 另外**先在对话页问作者一句**（[gate.ts](gate.ts)） |
 * | 产出了草稿（generate） | **当场问一句写不写**（第 19 条），结论接在返回后面 |
 *
 * 宿主（Claude Code 之类）自己还有一层「要不要让它调这个工具」的权限；那一层管的是
 * 「让不让调」，这里的两问管的是「下游没有 diff 的改动」与「产物落盘」——第 19 / 25 条的
 * 承诺不交给宿主的配置。覆盖已有内容走 workspace 的覆盖审阅，与这里无关，任何路径都在。
 *
 * ## 对话页上的样子
 *
 * 外部 agent 的调用挂在当前会话里一个标着 MCP 的气泡上，连着几次调用接在同一个气泡里，
 * 作者在中间说了话就另起一个。正文照旧流进那一条工具条下的卡片（`toolDelta`），**不回给
 * 外部 agent**：它拿到的只有形状与 draftId（`tools/novel/generate.ts`）。
 */
import type { ChatController } from './index';
import type { McpBackend, McpCallResult } from '../mcp/server';
import { createNovelTools } from '../tools/novel';
import type { ToolIntent, ToolRun } from '../tools/types';
import { buildStateBrief } from '../views/stateBrief';
import { runTask } from '../runtime/progress';
import { describeError, scoped } from '../runtime/logger';
import { ChatTurn, TurnToolCall, makeTurnId, nowIso } from '../model/session';
import { askArtifact, describeArtifactOf, pushPipeline } from './chat';
import { askGate } from './gate';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('MCP');

/** 参数那一段的上限。路径与查询词都短，几百字够看，一大段内嵌文本没必要全留。 */
const ARGS_LIMIT = 800;
/** 返回那一段的上限。工具按契约本就回短文本，这道闸只防写坏了的那一个。 */
const RESULT_LIMIT = 2000;
/**
 * `generate` 产出的正文上限。这是**产物本身**（一章三千字、一份大纲六千字），截短了那张卡
 * 就没意义了；仍然要有个头：它随会话落盘。
 */
const OUTPUT_LIMIT = 20000;

/** 把这个工程端给 MCP。**每次调用现取**当前会话：作者可能在中途换了会话。 */
export function createMcpBackend(c: ChatController): McpBackend {
  return {
    brief: () => buildStateBrief(c.project, c.current.target),
    call: (name, args, signal) => callTool(c, name, args, signal),
  };
}

async function callTool(
  c: ChatController,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpCallResult> {
  const session = c.current;
  const tools = createNovelTools({
    project: c.project,
    workspace: c.workspace,
    drafts: c.drafts,
    sessionId: session.id,
  });
  const intent = tools.intent(name, args);

  // 查询：不花钱不改东西，挂上对话页只会把作者要看的那几条淹掉。认不出的名字也走这条——
  // 注册表会回一句「没有叫 X 的工具，可用的是…」。
  if (!intent || intent.gate === 'auto') {
    const r = await tools.invoke(name, args, quietRun(signal));
    return { text: r.text, isError: !r.ok };
  }

  // 参数本来就不对的调用当场回话：不占锁、不挂气泡，更不在对话页问一句「改「」里的一段文字」。
  const issue = tools.check(name, args);
  if (issue) {
    return { text: issue, isError: true };
  }

  // 与对话页的单步创作共用同一把锁：两条路同时跑会让草稿与流式内容互相盖。
  const lease = c.beginGeneration();
  if (!lease) {
    return {
      text: 'Novel Forge 的对话页里正在跑另一个生成任务。等它结束再试，或者请作者先停掉它。',
      isError: true,
    };
  }
  const relay = () => lease.abort();
  if (signal.aborted) {
    relay();
  } else {
    signal.addEventListener('abort', relay, { once: true });
  }
  c.post({ type: 'busy', value: true });

  const turn = openTurn(c);
  const row: TurnToolCall = {
    callId: makeTurnId(),
    name,
    title: intent.title,
    ok: false,
    summary: '进行中…',
    elapsedMs: 0,
    argsText: describeArgs(args),
  };
  turn.segments = [...(turn.segments ?? []), { kind: 'tool', call: row }];
  c.post({
    type: 'toolCall',
    turnId: turn.id,
    callId: row.callId,
    name,
    title: row.title,
    detail: intent.detail,
    argsText: row.argsText,
  });

  try {
    return await runTask(
      'MCP',
      async (task) => {
        // 进度条上的「停止」与对话页的「停止」是同一件事。
        if (task.signal.aborted) {
          relay();
        } else {
          task.signal.addEventListener('abort', relay, { once: true });
        }
        task.report({ message: intent.title });

        if (intent.gate === 'always') {
          const declined = await askFirst(c, turn.id, row, intent, lease.signal);
          if (declined) {
            settleRow(c, turn.id, row, { ok: true, summary: '作者没有同意', elapsedMs: 0, text: declined });
            return { text: declined, isError: false };
          }
        }

        const r = await tools.invoke(name, args, {
          signal: lease.signal,
          report: (message) => c.toast(message),
          onDelta: (delta) => {
            row.output = (row.output ?? '') + delta;
            c.post({ type: 'toolDelta', turnId: turn.id, callId: row.callId, text: delta });
          },
          usage: { record: (calls) => log.info(`${name} 调了 ${calls} 次模型`) },
        });
        settleRow(c, turn.id, row, {
          ok: r.ok,
          summary: r.error ?? r.display?.detail ?? firstLine(r.text),
          elapsedMs: r.elapsedMs,
          text: r.text,
        });

        // 产出了东西就当场问一句写不写（第 19 条）。结论要回给外部 agent：不说的话它不知道
        // 那份产物落没落盘，下一步多半是再生成一遍。
        const note = r.draftIds.length > 0 ? await adopt(c, turn.id, row, r.draftIds, lease.signal) : '';
        return { text: note ? `${r.text}\n\n${note}` : r.text, isError: !r.ok };
      },
      { scope: 'MCP' }
    );
  } catch (err) {
    const message = describeError(err);
    log.warn(`MCP 调用 ${name} 失败`, message);
    settleRow(c, turn.id, row, { ok: false, summary: message, elapsedMs: 0, text: message });
    return { text: `执行失败：${message}`, isError: true };
  } finally {
    signal.removeEventListener('abort', relay);
    if (row.output) {
      row.output = clip(row.output, OUTPUT_LIMIT);
    }
    lease.release();
    c.post({ type: 'busy', value: false });
    c.post({ type: 'turnDone', turn: serializeTurn(turn) });
    await persist(c);
    // write / edit / run 会真的改磁盘，流水线必须刷。
    await pushPipeline(c);
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
}

/** 查询那一条路的 `ToolRun`：没人看，说的话进日志。 */
function quietRun(signal: AbortSignal): ToolRun {
  return {
    signal,
    report: (message) => log.debug(message),
    usage: { record: () => undefined },
  };
}

/**
 * 这次调用挂在哪个气泡上：会话最后一轮就是 MCP 的气泡就接着用，否则另起一个。
 * 作者在中间说过话，那就是另一段事了。
 */
function openTurn(c: ChatController): ChatTurn {
  const turns = c.current.turns;
  const last = turns[turns.length - 1];
  if (last?.role === 'assistant' && last.mcp) {
    return last;
  }
  const turn: ChatTurn = { id: makeTurnId(), role: 'assistant', content: '', at: nowIso(), mcp: true };
  turns.push(turn);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  return turn;
}

/**
 * `always` 那一档：动手前先问。同意返回 undefined，否则返回回给外部 agent 的那句话。
 *
 * **必须有信息量**：只回一句「被拒绝」，它多半会把同一个动作再发一遍。
 */
async function askFirst(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  intent: ToolIntent,
  signal: AbortSignal
): Promise<string | undefined> {
  const verdict = await askGate(
    c,
    {
      turnId,
      callId: row.callId,
      name: row.name,
      title: `Agent 要${intent.title}`,
      detail: intent.detail,
      argsText: row.argsText,
    },
    signal
  );
  if (verdict === 'proceed') {
    return undefined;
  }
  log.info(`作者${verdict === 'skip' ? '跳过了' : '没有回答'} ${row.name}`, intent.title);
  return verdict === 'skip'
    ? `作者跳过了这一步（${intent.title}），它没有执行，磁盘上什么都没变。**不要重试同一个动作**——换个做法，或者问问他想怎么做。`
    : `这一步（${intent.title}）被取消了，没有执行。不要再发起新的动作，把已经做到哪、还差什么说清楚就行。`;
}

/** 产出的草稿：当场问一句写不写。返回接在工具结果后面的那句话。 */
async function adopt(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  draftIds: string[],
  signal: AbortSignal
): Promise<string> {
  const draftId = draftIds[draftIds.length - 1];
  const draft = c.drafts.get(draftId);
  const art = draft?.artifact ? await describeArtifactOf(c, draft.raw, draft) : undefined;
  if (!draft || !art) {
    // 解析不出可落盘的形状（讨论类的产出）：没什么可写的，不问。
    return '';
  }
  c.current.drafts = c.drafts.bySession(c.current.id);
  const r = await askArtifact(c, {
    turnId,
    draft,
    art,
    byAgent: true,
    callId: row.callId,
    // **不打开文件**：外部 agent 可能连着写好几份，一次次抢编辑器。
    open: false,
    signal,
  });
  // 决定记在那条工具条上，随会话留住——翻回来看得出「这一份我当时没要」。
  row.summary = `${row.summary} · ${r.relPath ? `已写入 ${r.relPath}` : '未采纳'}`;
  postRow(c, turnId, row);
  return r.relPath
    ? `${r.message}这份产物已经落盘，**不要再写一遍**。`
    : `${r.message}**不要重复生成同一份**——问问作者要改什么。`;
}

function settleRow(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  r: { ok: boolean; summary: string; elapsedMs: number; text: string }
): void {
  row.ok = r.ok;
  row.summary = r.summary;
  row.elapsedMs = r.elapsedMs;
  row.resultText = r.text ? clip(r.text, RESULT_LIMIT) : undefined;
  postRow(c, turnId, row);
}

function postRow(c: ChatController, turnId: string, row: TurnToolCall): void {
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

/** 截一段给界面看的文本。**说出自己截了**（第 2 条：不静默截断）。 */
function clip(text: string, limit: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…（还有 ${trimmed.length - limit} 字，已截断）`;
}

function describeArgs(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length === 0) {
    return undefined;
  }
  try {
    return clip(JSON.stringify(args, null, 2), ARGS_LIMIT);
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}
