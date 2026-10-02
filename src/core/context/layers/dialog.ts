import { STAGE_ROLE } from '../../model/pipeline';
import { notYetOnStage } from '../../model/manuscriptCheck';
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
  const drafting = r.action.stage === 'manuscript' && r.action.capability === 'generate' && r.writeMode !== 'revise';
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
    ...(r.derive ? { derive: r.derive } : {}),
    // 「本章不出场」（五期补遗 §1.2）：生成层交过来的那一份优先（与写完查的同源）；没给就按 focus 现算。
    ...(drafting
      ? {
          ...(r.banned?.length ? { banned: r.banned } : {}),
          notYet: r.notYet ?? notYetOnStage({
            self: plot?.characters ?? [],
            previous: a.focus.previous.map((c) => ({ no: c.no, characters: c.plot?.characters ?? [] })),
            ahead: a.focus.aheadPlots.map((c) => ({ no: c.no, characters: c.plot?.characters ?? [] })),
          }),
        }
      : {}),
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

/**
 * 历史对话。
 *
 * **已经写入的那一轮不再带**（五期补遗 §1.4）：同一个会话跟着主按钮一路走，配置、前提、角色图谱、
 * 大纲、细纲、前几章正文都留在历史里，写第 3 章时又整份装一遍。它们早就落盘了，专门的层按磁盘带
 * （设定、大纲切片、本章细纲、上一章结尾、前文全文、证据），而作者落盘之后可能手改过——历史里的
 * 还是改之前那一版。发起那一轮的命令（用户轮，带 `command`）一起跳过：要求已经落在产物里了。
 * 讨论（没有 `command`）与没写入的产物（作者点了不采纳，那份只在历史里有）照旧带。跳过的都记在
 * 明细里（第 2 条）。
 */
export const history: LayerFn = async (a, spec) => {
  const turns = a.request.history ?? [];
  if (turns.length === 0) {
    return;
  }
  const historyCap = Math.floor(a.budget * (spec.cap ?? 1));
  const turnCap = Math.floor(a.budget * HISTORY_TURN_CAP_RATIO);
  let historyRemaining = Math.min(historyCap, Math.max(0, a.remaining));

  // 已写入的那一轮 → 落点；发起它的命令轮 → 同一个落点。
  const landed = new Map<string, string>();
  turns.forEach((turn, i) => {
    if (turn.role === 'assistant' && turn.acceptedTo) {
      landed.set(turn.id, turn.acceptedTo);
      const asked = turns[i - 1];
      if (asked && asked.role === 'user' && asked.command) {
        landed.set(asked.id, turn.acceptedTo);
      }
    }
  });

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
    const to = landed.get(turn.id);
    if (to) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: 'dropped',
        note:
          turn.role === 'assistant'
            ? `已写入「${to}」，以磁盘上那一份为准，不再随历史带`
            : `这一轮的产物已写入「${to}」，要求已经落在产物里`,
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
