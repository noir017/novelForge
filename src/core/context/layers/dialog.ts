import { STAGE_ROLE } from '../../model/pipeline';
import { PromptFacts, buildSystemPrompt } from '../prompts';
import { estimateTokens, takeHead, takeTail } from '../tokenizer';
import { ContextItem } from '../types';
import type { Assembly, LayerFn } from './assembly';
import { ATTACHMENT_NOTE, resolveAttachment } from './render';

/**
 * 这一次装配交给提示词的事实。系统提示（这里）与输出契约（builder.ts）必须拿同一份，
 * 不然一个说「写第 6–10 章」，另一个说「写这一章」。
 */
export function promptFactsOf(a: Pick<Assembly, 'request' | 'book' | 'focus'>): PromptFacts {
  const r = a.request;
  const plot = a.focus.plot;
  return {
    target: r.target,
    targetWords: r.targetWords,
    range: r.range,
    setup: r.setup,
    step: r.step,
    book: a.book,
    no: Number.isFinite(a.focus.no) ? a.focus.no : undefined,
    plot: plot ? { keyEvents: plot.sections.关键事件, hook: plot.sections.章末钩子 } : undefined,
    ask: r.ask,
    writeMode: r.writeMode,
    written: r.writeMode === 'continue' ? a.focus.chapter?.wordCount : undefined,
    reviewGoals: r.reviewGoals,
  };
}

/** 历史里单条消息的上限，超出取结尾（越靠后越相关）。 */
const HISTORY_TURN_CAP_RATIO = 0.12;

export const system: LayerFn = async (a, spec) => {
  a.admit(
    {
      id: 'system',
      kind: 'system',
      priority: spec.priority,
      label: `系统提示 · ${STAGE_ROLE[a.request.action.stage]}`,
      text: buildSystemPrompt(a.request.action, a.config, promptFactsOf(a)),
    },
    { force: spec.force }
  );
};

export const ask: LayerFn = async (a, spec) => {
  const { stage, capability } = a.request.action;
  const isDraftOrder = stage === 'manuscript' && capability === 'generate';
  const label =
    capability === 'review'
      ? '要求重点检查的方面'
      : isDraftOrder && a.request.writeMode === 'revise'
        ? '修稿的补充要求'
        : isDraftOrder
          ? '这一章的补充要求'
          : '我的要求';
  a.admit(
    {
      id: 'ask',
      kind: 'ask',
      priority: spec.priority,
      label,
      text: a.request.ask.trim(),
    },
    { force: spec.force }
  );
};

export const attachments: LayerFn = async (a, spec) => {
  const attachmentCap = Math.floor(a.budget * (spec.cap ?? 1));
  for (const att of a.request.attachments ?? []) {
    const id = `attachment:${att.id}`;
    const base = {
      id,
      kind: 'attachment' as const,
      priority: spec.priority,
      label: att.label,
      source: att.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const body = await resolveAttachment(a.project, att);
    if (!body.trim()) {
      a.reject({ ...base, text: '' }, 'dropped', '内容为空或文件已不存在');
      continue;
    }

    const raw = `【引用 · ${att.label}】\n${body}`;
    const rawTokens = estimateTokens(raw);
    const cap = Math.min(attachmentCap, Math.max(0, a.remaining));
    if (rawTokens <= cap) {
      a.accept({ ...base, text: raw, status: 'included', note: ATTACHMENT_NOTE[att.kind] }, rawTokens);
      continue;
    }
    if (cap < 200) {
      a.reject(
        { ...base, text: '' },
        'dropped',
        `预算不足（需 ${rawTokens} token，剩 ${Math.max(0, a.remaining)}）`
      );
      continue;
    }
    const clipped = `【引用 · ${att.label}】\n${takeHead(body, cap - 40)}`;
    const clippedTokens = estimateTokens(clipped);
    a.accept(
      {
        ...base,
        text: clipped,
        status: 'degraded',
        note: `原文需 ${rawTokens} token，已截断至 ${clippedTokens}`,
      },
      clippedTokens
    );
  }
};

export const history: LayerFn = async (a, spec) => {
  const turns = a.request.history ?? [];
  if (turns.length === 0) {
    return;
  }
  const historyCap = Math.floor(a.budget * (spec.cap ?? 1));
  const turnCap = Math.floor(a.budget * HISTORY_TURN_CAP_RATIO);
  let historyRemaining = Math.min(historyCap, Math.max(0, a.remaining));

  const kept: ContextItem[] = [];
  const skipped: ContextItem[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const id = `history:${turn.id}`;
    const base = {
      id,
      kind: 'history' as const,
      priority: spec.priority,
      label: `${turn.role === 'user' ? '我' : '模型'} · 第 ${i + 1} 轮`,
    };

    if (a.excluded.has(id) || !turn.content.trim()) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: a.excluded.has(id) ? 'excluded' : 'dropped',
        note: a.excluded.has(id) ? '已被手动排除' : '空消息',
      });
      continue;
    }

    const content = takeTail(turn.content, turnCap);
    const tokens = estimateTokens(content);
    if (tokens > historyRemaining) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: '历史对话预算已满，更早的轮次不再注入',
      });
      continue;
    }
    historyRemaining -= tokens;
    a.remaining -= tokens;
    kept.push({
      ...base,
      text: content,
      tokens,
      status: content.length < turn.content.length ? 'degraded' : 'included',
      note: content.length < turn.content.length ? '过长，仅注入结尾部分' : undefined,
    });
  }
  a.items.push(...kept.reverse(), ...skipped.reverse());
};
