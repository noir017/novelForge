import { readConfig } from '../config';
import { BuiltContext, ContextItem } from '../context/builder';
import { Attachment, ChatSession, ChatTurn, contextMessagesOf, isBuiltinAgentTurn } from '../model/session';
import { NovelConfig } from '../model/types';
import { modelLabel, providerLabel } from '../model/providers';
import { DEFAULT_THINKING_DEPTH } from '../model/thinking';
import { defaultPicks, normalizeReport } from '../model/review';
import {
  CreationTarget,
} from '../model/pipeline';
import {
  NextStepPlan,
  SerializedAttachment,
  SerializedDigest,
  SerializedSession,
  SerializedTurn,
} from '../protocol';

/**
 * 流水线 → `deriveNextStep` 要的那几个事实。
 *
 * 实现在 [views/pipeline.ts](../views/pipeline.ts)：状态简报（`views/stateBrief.ts`）
 * 也要用它。这里保留转发，同包的调用点不必改。
 */
export { factsOf } from '../views/pipeline';

/**
 * 下一步落在哪个具体产物上。
 *
 * 单章的下一步只说「细纲层 / 正文层」，拼成 target 要知道那一章细纲的路径，
 * 而那是 I/O 层的事。全书级的下一步自己带着 target（架构、大纲），这里原样用它。
 */
export function targetOf(step: NextStepPlan, plotRelPath: string): CreationTarget {
  if (step.target) {
    return step.target;
  }
  switch (step.stage) {
    case 'setting':
      return { kind: 'setting', doc: 'config' };
    case 'outline':
      return { kind: 'outline' };
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
    ...(contextMessagesOf(t) ? { fullContext: true } : {}),
    acceptedTo: t.acceptedTo,
    interrupted: t.interrupted,
    error: t.error,
    reasoning: t.reasoning,
    artifact: t.artifact,
    ...reviewOf(t),
    ...(t.revise ? { revise: { items: t.revise.items } } : {}),
    segments: t.segments,
    ...(t.mcp ? { mcp: true } : {}),
    ...(isBuiltinAgentTurn(t) ? { builtinAgent: true } : {}),
  };
}

/**
 * 审稿那一轮的报告（五期）。会话文件里的那一份按容错读取重新归一一次：作者可能手改过，
 * 报告卡照着一份坏掉的报告画，点引文、修稿都会出错。认不出就当这一轮没有报告（气泡里
 * 仍有给人读的那一份文字）。
 */
function reviewOf(t: ChatTurn): Pick<SerializedTurn, 'review'> {
  const report = t.review ? normalizeReport(t.review.report) : undefined;
  if (!t.review || !report) {
    return {};
  }
  return {
    review: {
      report,
      picks: defaultPicks(report),
      ...(t.review.notes?.length ? { notes: t.review.notes } : {}),
      ...(t.review.calls ? { calls: t.review.calls } : {}),
    },
  };
}

export function serializeAttachment(a: Attachment): SerializedAttachment {
  return { id: a.id, kind: a.kind, label: a.label, relPath: a.relPath, range: a.range, text: a.text };
}

export function serializeDigest(built: BuiltContext): SerializedDigest {
  return {
    usedTokens: built.usedTokens,
    budget: built.budget,
    clamped: built.budgetClampedByProvider,
    detail: built.detail,
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
