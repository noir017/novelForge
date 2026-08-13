import { STAGE_ROLE } from '../../model/pipeline';
import { buildSystemPrompt } from '../prompts';
import { estimateTokens, takeHead, takeTail } from '../tokenizer';
import { ContextItem } from '../types';
import type { LayerFn } from './assembly';
import { ATTACHMENT_NOTE, resolveAttachment } from './render';

/** 历史里单条消息的上限，超出取结尾（越靠后越相关）。 */
const HISTORY_TURN_CAP_RATIO = 0.12;

export const system: LayerFn = async (a, spec) => {
  a.admit(
    {
      id: 'system',
      kind: 'system',
      priority: spec.priority,
      label: `系统提示 · ${STAGE_ROLE[a.request.action.stage]}`,
      text: buildSystemPrompt(a.request.action, a.config, a.request.targetWords),
    },
    { force: spec.force }
  );
};

export const ask: LayerFn = async (a, spec) => {
  const { stage, capability } = a.request.action;
  const isDraftOrder = stage === 'manuscript' && (capability === 'generate' || capability === 'rewrite');
  a.admit(
    {
      id: 'ask',
      kind: 'ask',
      priority: spec.priority,
      label: isDraftOrder ? '本章剧情纲要' : '我的要求',
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
