import { readConfig } from '../config';
import { BuiltContext, ContextItem } from '../context/builder';
import { Attachment, ChatSession, ChatTurn } from '../model/session';
import { NovelConfig } from '../model/types';
import { modelLabel, providerLabel } from '../model/providers';
import { DEFAULT_THINKING_DEPTH } from '../model/thinking';
import {
  CreationTarget,
} from '../model/pipeline';
import {
  NextStepPlan,
  SerializedAttachment,
  SerializedDigest,
  SerializedSegment,
  SerializedSession,
  SerializedTurn,
} from '../protocol';

/**
 * 流水线 → `deriveNextStep` 要的那几个事实。
 *
 * 实现搬去了 [views/pipeline.ts](../views/pipeline.ts)：agent 的状态注入
 * （`agent/context.ts`）也要用它，而 `agent/` 不能反向依赖 `controller/`。
 * 这里保留转发，同包的调用点不必改。
 */
export { factsOf } from '../views/pipeline';

/**
 * 下一步落在哪个具体产物上。
 *
 * 纯函数那边只说「正文层」，拼成 target 要知道细纲的路径，
 * 而那是 I/O 层的事——`deriveNextStep` 不该也不能查段落列表。
 *
 * `volume` 那一档要的是**卷纲**的路径，而这个函数手上只有段路径。
 * 全书级的下一步（`deriveBookNextStep` 的 `plots` 一档）走的是 controller
 * 那条路，它自己把 target 指向第一卷；按段的下一步永远不会落在卷纲层，
 * 所以这里退回那一段的剧情层——**不猜一个卷路径**，猜错会把作者送到别的卷。
 */
export function targetOf(step: NextStepPlan, plotRelPath: string): CreationTarget {
  switch (step.stage) {
    case 'outline':
      return { kind: 'outline' };
    case 'volume':
    case 'plot':
      return { kind: 'plot', plotRelPath };
    case 'manuscript':
      return { kind: 'manuscript', plotRelPath };
  }
}

export function serializeSession(s: ChatSession): SerializedSession {
  return {
    id: s.id,
    title: s.title,
    target: s.target,
    stage: s.stage,
    capability: s.capability,
    targetNo: s.targetNo,
    targetWords: s.targetWords,
    // 前端只回显，不猜默认值：缺席归一成「不思考」这件事在后端做一次。
    thinking: s.thinking ?? DEFAULT_THINKING_DEPTH,
    turns: s.turns.map(serializeTurn),
  };
}

export function serializeTurn(t: ChatTurn): SerializedTurn {
  return {
    id: t.id,
    role: t.role,
    content: t.content,
    at: t.at,
    command: t.command,
    attachments: t.attachments?.map(serializeAttachment),
    context: t.context,
    acceptedTo: t.acceptedTo,
    interrupted: t.interrupted,
    error: t.error,
    reasoning: t.reasoning,
    artifact: t.artifact,
    segments: segmentsOf(t),
    agentRun: t.agentRun,
  };
}

/**
 * 这一轮排下来的段。**旧会话在这里归一一次，界面因此只认一种形状。**
 *
 * 改成段之前，一轮 agent 存的是 `content` 一整块 + `toolCalls` 一整串，界面把
 * 工具画在正文上方。老会话文件里还是那个样子，读到时就按**旧界面的顺序**拼成
 * 段：工具们，然后正文。顺序信息本来就没存下来，这里不编一个——「先做后说」
 * 至少与作者当时看到的一致。
 *
 * 普通一问一答（单步创作、纯聊天）**不产生段**：一块正文就是全部，气泡照旧
 * 画成一块可就地编辑的正文。
 */
function segmentsOf(t: ChatTurn): SerializedSegment[] | undefined {
  if (t.segments) {
    return t.segments;
  }
  if (!t.toolCalls || t.toolCalls.length === 0) {
    return undefined;
  }
  const segments: SerializedSegment[] = t.toolCalls.map((call) => ({ kind: 'tool' as const, call }));
  if (t.content) {
    segments.push({ kind: 'text', text: t.content });
  }
  return segments;
}

export function serializeAttachment(a: Attachment): SerializedAttachment {
  return { id: a.id, kind: a.kind, label: a.label, relPath: a.relPath, range: a.range, text: a.text };
}

export function serializeDigest(built: BuiltContext): SerializedDigest {
  return {
    usedTokens: built.usedTokens,
    budget: built.budget,
    clamped: built.budgetClampedByProvider,
    items: built.items.map(serializeItem),
  };
}

export function serializeItem(i: ContextItem) {
  return {
    id: i.id,
    label: i.label,
    kind: i.kind,
    priority: i.priority,
    tokens: i.tokens,
    status: i.status,
    note: i.note,
    source: i.source,
  };
}

export function describeProvider(config: NovelConfig = readConfig()): string {
  if (!config.active) {
    return config.model || '未选择模型';
  }
  const { profile, model } = config.active;
  return `${providerLabel(profile)} · ${modelLabel(model)}`;
}
