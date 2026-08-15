import { readConfig } from '../config';
import { BuiltContext, ContextItem } from '../context/builder';
import { Attachment, ChatSession, ChatTurn } from '../model/session';
import { NovelConfig } from '../model/types';
import { modelLabel, providerLabel } from '../model/providers';
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
 * 实现搬去了 [views/pipeline.ts](../views/pipeline.ts)：agent 的状态注入
 * （`agent/context.ts`）也要用它，而 `agent/` 不能反向依赖 `controller/`。
 * 这里保留转发，同包的调用点不必改。
 */
export { factsOf } from '../views/pipeline';

/**
 * 下一步落在哪个具体产物上。
 *
 * 纯函数那边只说「细节层、第 2 场」，拼成 target 要知道细纲的路径，
 * 而那是 I/O 层的事——`deriveNextStep` 不该也不能查段落列表。
 */
export function targetOf(step: NextStepPlan, plotRelPath: string): CreationTarget {
  switch (step.stage) {
    case 'outline':
      return { kind: 'outline' };
    case 'plot':
      return { kind: 'plot', plotRelPath };
    case 'scene':
      return { kind: 'scene', plotRelPath, sceneNo: step.sceneNo ?? 1 };
    case 'manuscript':
      return { kind: 'manuscript', plotRelPath, sceneNo: step.sceneNo };
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
    draftId: t.draftId,
    artifact: t.artifact,
    toolCalls: t.toolCalls,
    agentRun: t.agentRun,
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
