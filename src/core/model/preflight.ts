/**
 * 一致性预检（五期）：写第 N 章之前，零调用地查一遍细纲有没有把已经死了的人排进本章。
 *
 * **纯函数，零 import**。取数（细纲、角色卡）在 features/preflight.ts。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`shared/consistency-preflight.ts` 的
 * `findBlueprintContinuityRisks`（:84-119）那一条规则：终态角色又被排进当前蓝图。上游那句
 * 「Findings are evidence, never a writing prohibition」照用——这里只亮一张卡，作者可以
 * 「仅本次忽略」照写（回忆、幻象、托梦都是正当的安排）。
 *
 * ## 与上游不同的地方（五期计划 §8 ⚑）
 *
 * - **读角色卡的「当前状态」**（总计划 §1 #19），不读上游的定稿事实投影。四期起这一节由定稿
 *   维护，写着「截至第 K 章」这个人在哪、怎么样。
 * - **只信写到本章之前的状态**：`stateThrough ≥ N`（状态已经更新到本章或更晚，重写早前的章时
 *   常见）不判——那个「已死亡」说的可能正是本章或之后发生的事。没记过 `stateThrough` 的手写卡照判。
 * - **判定按分句、看句首**：上游只认「名字紧挨着死亡 / 身亡 / 牺牲 / 去世」四个词，可卡上的
 *   状态写的是这个人自己，通常不带名字，照搬一条都认不出。这里一句以终态说法开头（可带主语与
 *   「已 / 已经 / 于第 k 章 / 被……」前缀）才算——「险些丧命」「假死脱身」「为已死的师父报仇」
 *   开头都不是终态，自然不算。宁可误报一条让作者点一下「仅本次忽略」，也别漏报。
 */

/** 预检要知道的一张卡。 */
export interface PreflightCard {
  name: string;
  aliases: readonly string[];
  /** 「当前状态」一节的原文。 */
  state: string;
  /** 这一节写到第几章（0 = 开篇状态）。手写的卡没有。 */
  stateThrough?: number;
  relPath?: string;
}

/** 一处风险：谁、卡上那一节怎么写的、写到第几章、是哪一句判出来的。 */
export interface PreflightRisk {
  name: string;
  state: string;
  through?: number;
  clause: string;
  relPath?: string;
}

const NUM = '[0-9０-９一二三四五六七八九十百千两]+';
/** 句首可以有的前缀：已经、于第 k 章、被确认…… */
const LEAD =
  `(?:早已|已经|已|当场|最终|终于|不幸|被确认(?:为)?|被证实(?:为)?|确认|证实|` +
  `(?:(?:于|在)第?|第)\\s*${NUM}\\s*章(?:中|末|里|时)?)*`;
/** 终态说法。刻意不收单字「死」：死守、死敌、死心、拼死都不是终态。 */
const TERMINAL =
  '(?:死亡|身亡|牺牲|去世|过世|亡故|病逝|病故|遇害|遇难|罹难|阵亡|战死|丧生|丧命|殒命|殒身|毙命|气绝|惨死|' +
  '死了|死去|死于|自尽|自刎|被?处决|被?斩首|被[^，。；,;！!？?]{0,12}?(?:杀|害|刺|毒|打|斩|砍|击|射|烧|勒|吊|处|咬|砸|溺|捅)死)';
/** 「已死」「已经死」：单字「死」只在这两种前缀后面才算。 */
const BARE_DEAD = '(?:早已|已经|已)死(?![守战敌士心罪期对磕撑扛咬拼])';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 这一节状态说的是不是「这个人已经死了」。返回判出来的那一句（给作者看）；不是终态时 undefined。
 * `names` 是这个人的名字与别名：状态里偶尔会以名字开头（「沈秋已于第五章身亡」）。
 */
export function terminalClause(state: string, names: readonly string[] = []): string | undefined {
  const subjects = ['他', '她', '其', '此人', '本人', ...names.filter((n) => n.trim().length > 0).map(escapeRe)];
  const subject = `(?:${subjects.join('|')})?`;
  const re = new RegExp(`^${subject}\\s*${LEAD}\\s*(?:${TERMINAL}|${BARE_DEAD})`, 'u');
  for (const raw of (state ?? '').split(/[，,。；;！!？?\n（）()【】\[\]]/u)) {
    const clause = raw.replace(/^[\s\-*•·:：]+/u, '').trim();
    if (clause && re.test(clause)) {
      return clause;
    }
  }
  return undefined;
}

/**
 * 本章细纲 `characters[]` 里的人，卡上写着已经死了 → 一条风险。按名字与别名认卡；
 * 细纲里有、却没有卡的人不查（没有状态可比）。
 */
export function findPreflightRisks(input: {
  no: number;
  planned: readonly string[];
  cards: readonly PreflightCard[];
}): PreflightRisk[] {
  const out: PreflightRisk[] = [];
  const seen = new Set<PreflightCard>();
  for (const raw of input.planned) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const card = input.cards.find((c) => c.name === name || c.aliases.includes(name));
    if (!card || seen.has(card)) {
      continue;
    }
    seen.add(card);
    if (card.stateThrough !== undefined && card.stateThrough >= input.no) {
      continue;
    }
    const clause = terminalClause(card.state, [card.name, ...card.aliases]);
    if (clause) {
      out.push({
        name: card.name,
        state: card.state.trim(),
        ...(card.stateThrough !== undefined ? { through: card.stateThrough } : {}),
        clause,
        ...(card.relPath ? { relPath: card.relPath } : {}),
      });
    }
  }
  return out;
}

/** 「沈秋的当前状态（截至第 5 章）写着『已死亡』，本章细纲仍安排他出场。」卡片与日志共用。 */
export function describeRisk(r: PreflightRisk): string {
  const when = r.through === undefined ? '' : r.through <= 0 ? '（开篇状态）' : `（截至第 ${r.through} 章）`;
  return `${r.name}的当前状态${when}写着「${r.clause}」，本章细纲仍安排这个人出场`;
}

/** 卡片上跟在警告后面的那一句建议（上游 suggestion 的说法）。 */
export const PREFLIGHT_SUGGESTION = '调整细纲的出场角色，或者这本来就是回忆、幻象、托梦一类的刻意安排——那就仅本次忽略，照写。';
