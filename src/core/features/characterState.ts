/**
 * 定稿时更新本章出场角色的「当前状态」（D15），以及作者改过、没被覆盖的那几张卡的对比入口。
 *
 * ## 谁的卡、写不写
 *
 * 出场人物以本章摘要为准（第 14 条：摘要是出场人物的唯一真相），按 `views/cast.ts` 同一张表
 * 认卡。一次调用出所有人的新状态；归属看 model/characterState.ts：
 *
 * | 情形 | 做法 |
 * |---|---|
 * | 这一节归机器 | 换成新的那一版、盖章（`stateThrough` / `stateHash`） |
 * | 作者改过 | 不写；挂黄 ❗，说明里带上机器给的那一版，右键「对比…」决定 |
 * | 卡上已经是更晚那一章的状态 | 不回退（重新定稿早前的章时） |
 * | 出场了、状态没变 | 机器的卡把「写到第几章」推到这一章；作者的卡不动 |
 * | 模型给了名单外的名字 | 忽略，记日志 |
 *
 * 写卡**只动那一节与两个 frontmatter 字段**（`patchCardState`）：整卡重渲染会抹掉作者自加的
 * 小节。这里不走覆盖审阅——归属判据就是那道闸（与批量路径「只补空白」同一个理由）。
 */
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { LlmProvider, StreamOptions } from '../llm/provider';
import { readConfig } from '../config';
import { describeError, scoped } from '../runtime/logger';
import { activeFailure, clearFailures, recordFailure } from '../runtime/errorLog';
import { readText } from '../model/fs';
import { NovelProject } from '../model/project';
import { Chapter, CharacterCard, SummaryCast } from '../model/types';
import { hasContent } from '../model/markdown';
import { patchCardState, patchCardThrough, stateOwnedByMachine } from '../model/characterState';
import { clipLine } from '../context/layers/render';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { cardLookup } from '../views/cast';
import { Workspace } from '../workspace';
import { extractJsonObject, stripCodeFence } from './parse';
import { STATE_SYSTEM } from './characterCardPrompt';

const log = scoped('角色卡');

/** 失败记录的 op：作者改过的状态没被覆盖、以及这一步调用失败，都记在它名下。 */
export const STATE_OP = 'cardState';

export interface StateUpdateOutcome {
  /** 调了几次模型：出场的人都没建卡时是 0。 */
  calls: number;
  /** 当前状态换成了这一章的那一版。 */
  updated: string[];
  /** 出场了、状态没变：机器的卡把「写到第几章」推到了这一章。 */
  carried: string[];
  /** 作者改过，没有覆盖（挂了黄 ❗）。 */
  guarded: string[];
  /** 卡上已经是更晚那一章的状态，没有回退。 */
  newer: string[];
  /** 模型给了名单外的名字。 */
  unknown: string[];
}

/**
 * 更新本章出场角色的当前状态。
 *
 * `run` 决定怎么调模型：单章入口直接用对话页选定的那个；批量入口传分档池（失败换同档其余，
 * 第 12 条）。调用失败或返回解析不出来时抛错——摘要已经写好了，由调用方把失败挂在章节上。
 */
export async function updateCharacterStates(
  project: NovelProject,
  chapter: Chapter,
  cast: readonly SummaryCast[],
  opts: {
    run: <T>(what: string, fn: (llm: LlmProvider) => Promise<T>) => Promise<T>;
    budget: { contextWindow: number; maxOutputTokens: number };
    signal?: AbortSignal;
  }
): Promise<StateUpdateOutcome> {
  const out: StateUpdateOutcome = { calls: 0, updated: [], carried: [], guarded: [], newer: [], unknown: [] };
  const cards = await project.listCharacters();
  const lookup = cardLookup(cards);
  const present: CharacterCard[] = [];
  for (const entry of cast) {
    const card = lookup(entry);
    if (card && !present.some((c) => c.relPath === card.relPath)) {
      present.push(card);
    }
  }
  if (present.length === 0) {
    log.info(`第 ${chapter.order} 章出场的人都还没有角色卡，不更新角色状态`);
    return out;
  }

  const text = await project.readChapterText(chapter);
  const config = readConfig();
  const roster = present
    .map((c) => {
      const identity = hasContent(c.sections.身份) ? clipLine(c.sections.身份, 60) : '';
      const now = hasContent(c.sections.当前状态) ? c.sections.当前状态.trim() : '（空）';
      return `- ${c.name}${identity ? `（${identity}）` : ''}\n  现在的当前状态：${now}`;
    })
    .join('\n');
  const inputBudget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - 1500 - estimateTokens(roster));
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${chapter.order} 章正文超出输入预算，更新角色状态时已截断`, `${text.length} 字 → ${body.length} 字`);
  }
  const user =
    `【第${chapter.order}章 ${chapter.title}】\n\n${body}\n\n` +
    `【本章出场、已经建档的人物】\n${roster}\n\n请按要求输出 JSON。`;
  const options: StreamOptions = {
    maxOutputTokens: Math.min(opts.budget.maxOutputTokens, 1500),
    temperature: 0.3,
    timeoutMs: config.requestTimeoutMs,
    signal: opts.signal,
  };

  out.calls = 1;
  const raw = await opts.run(`第 ${chapter.order} 章 · 角色状态`, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: STATE_SYSTEM },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const updates = parseStateUpdates(raw);
  if (!updates) {
    throw new Error('模型返回的角色状态解析不出来');
  }

  const ws = new Workspace(project);
  const touched = new Set<string>();
  const byName = cardLookup(present);
  for (const u of updates) {
    const card = byName(u.name);
    if (!card) {
      out.unknown.push(u.name);
      continue;
    }
    if (touched.has(card.relPath)) {
      continue;
    }
    touched.add(card.relPath);
    if (card.stateThrough !== undefined && card.stateThrough > chapter.order) {
      out.newer.push(card.name);
      continue;
    }
    if (!stateOwnedByMachine(card)) {
      out.guarded.push(card.name);
      await recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: card.relPath,
        severity: 'warn',
        op: STATE_OP,
        message: `第 ${chapter.order} 章定稿给出了新的「当前状态」，这一节你改过，没有覆盖`,
        detail: `${proposalHead(chapter.order)}\n${u.state}\n\n右键这张卡「对比第 ${chapter.order} 章给出的状态…」可以对比后决定用不用。`,
      });
      continue;
    }
    const file = await readText(project.pathOf(card.relPath));
    await ws.write(card.relPath, { text: patchCardState(file, u.state, chapter.order) }, { mode: 'overwrite', review: false });
    await clearFailures(project, 'character', card.relPath, STATE_OP);
    out.updated.push(card.name);
  }

  // 出场了、状态没变：状态仍然成立到这一章。只推机器的卡，作者的卡一个字不动。
  for (const card of present) {
    if (touched.has(card.relPath) || !hasContent(card.sections.当前状态) || !stateOwnedByMachine(card)) {
      continue;
    }
    if ((card.stateThrough ?? -1) >= chapter.order) {
      continue;
    }
    const file = await readText(project.pathOf(card.relPath));
    await ws.write(card.relPath, { text: patchCardThrough(file, card.sections.当前状态, chapter.order) }, { mode: 'overwrite', review: false });
    out.carried.push(card.name);
  }

  log.info(
    `第 ${chapter.order} 章的角色状态已处理`,
    [
      out.updated.length > 0 ? `更新 ${out.updated.join('、')}` : '',
      out.carried.length > 0 ? `沿用 ${out.carried.join('、')}` : '',
      out.guarded.length > 0 ? `你改过、没覆盖 ${out.guarded.join('、')}` : '',
      out.newer.length > 0 ? `已是更晚的状态 ${out.newer.join('、')}` : '',
      out.unknown.length > 0 ? `名单外的名字 ${out.unknown.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜') || '没有人的状态变了'
  );
  return out;
}

/** 黄 ❗ 说明里机器那一版的开头。对比入口按它把那一版取回来。 */
function proposalHead(no: number): string {
  return `【第 ${no} 章给出的当前状态】`;
}

const PROPOSAL = /【第 (\d+) 章给出的当前状态】\n([\s\S]*?)(?:\n\n右键这张卡|$)/;

/** 从黄 ❗ 的说明里取回机器给的那一版。认不出返回 undefined。 */
export function proposalOf(detail: string | undefined): { no: number; state: string } | undefined {
  const m = PROPOSAL.exec(detail ?? '');
  return m ? { no: Number(m[1]), state: m[2].trim() } : undefined;
}

/**
 * `{"updates":[{"name","当前状态"}]}`。字段名写成 `state` / `currentState`（上游的叫法，可能是
 * 对象）也收；`updates` 缺了、根本不是 JSON 时返回 undefined。当前状态是空的那一条丢掉——
 * 空字符串换掉一段有内容的状态，比不换更糟。
 */
export function parseStateUpdates(raw: string): { name: string; state: string }[] | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  const list = (data as { updates?: unknown })?.updates;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: { name: string; state: string }[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const value = o['当前状态'] ?? o.state ?? o.currentState;
    const state =
      typeof value === 'string'
        ? value.trim()
        : typeof value === 'object' && value !== null
          ? Object.values(value as Record<string, unknown>)
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .join('；')
          : '';
    if (name && state) {
      out.push({ name, state });
    }
  }
  return out;
}

/**
 * 「对比第 N 章给出的状态…」：作者改过的那张卡，拿机器给的那一版做一次覆盖审阅。
 *
 * 采用 → 按机器写入（盖章、清 ❗，这一节从此又归机器）；放弃 → 清 ❗、不写（这一节仍然归作者，
 * 下一次定稿照样不覆盖、照样挂 ❗）；关掉审阅框什么都不做。
 */
export async function reviewCharacterState(project: NovelProject, relPath: string): Promise<void> {
  const card = (await project.listCharacters()).find((c) => c.relPath === relPath);
  if (!card) {
    getHost().toast('找不到这张角色卡，可能刚被改名或删除。', 'error');
    return;
  }
  const failure = await activeFailure(project, 'character', relPath, STATE_OP);
  const proposal = proposalOf(failure?.detail);
  if (!proposal) {
    getHost().toast(`「${card.name}」没有待对比的状态。`);
    return;
  }
  const raw = await readText(project.pathOf(relPath));
  const next = patchCardState(raw, proposal.state, proposal.no);
  const host = getHost();
  let verdict: 'apply' | 'discard' | undefined;
  try {
    verdict = host.reviewReplace
      ? await host.reviewReplace(`角色卡「${card.name}」的当前状态`, raw, next, relPath)
      : (await host.confirm(`用第 ${proposal.no} 章给出的状态换掉「${card.name}」现在的当前状态？`, ['换', '不换'], {
            modal: true,
            detail: proposal.state,
          })) === '换'
        ? 'apply'
        : 'discard';
  } catch (err) {
    log.error(`对比「${card.name}」的状态失败：${describeError(err)}`, err);
    return;
  }
  if (verdict === 'apply') {
    await new Workspace(project).write(relPath, { text: next }, { mode: 'overwrite', review: false });
    await clearFailures(project, 'character', relPath, STATE_OP);
    log.info(`「${card.name}」换成了第 ${proposal.no} 章给出的状态`, relPath);
    host.toast(`「${card.name}」的当前状态已更新到第 ${proposal.no} 章。`);
  } else if (verdict === 'discard') {
    await clearFailures(project, 'character', relPath, STATE_OP);
    log.info(`「${card.name}」保留作者写的状态`, `没有用第 ${proposal.no} 章给出的那一版`);
  }
}
