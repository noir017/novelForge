/**
 * 写完一章正文之后的几项确定性检查，以及续写回退到哪里（五期补遗 §1）。**纯函数，零 I/O**。
 *
 * 都是三期真实模型首跑自查出来的：
 *
 * - **比喻词超标**：规则「『仿佛』『犹如』『宛如』全章合计不超过 3 次」写在系统提示里，三章光「仿佛」
 *   就有 9 处。执行卡末尾重列一遍、续写那一轮告诉它已经用了几次，写完再数一遍（{@link countSimiles}）。
 * - **后面几章的人提前登场**：第 3 章续写的结尾让第 4 章才登场的沈秋出现在巷口。执行卡点名
 *   「本章不出场」的人（{@link notYetOnStage}），写完查一遍（{@link findEarlyEntrances}）。
 * - **年代不符的现代术语**：民国背景的书里冒出「PTSD」。正文里的拉丁字母缩写提示一句
 *   （{@link latinAcronyms}）——只提示：都市、科幻题材里的 CEO、AI 是正常的。
 * - **续写越过章末钩子**：第一次调用已经收在钩子上、只是篇幅不够时，续写接在钩子后面必然越过它。
 *   这种情况先回退到结尾那一场之前（{@link rewindPoint}，见 generation/continuation.ts）。
 *
 * 只依赖 continuity.ts 的 bigram（钩子落在哪一段与证据句用的是同一种相似度），不进前端打包。
 */
import { textBigrams } from './continuity';

// ---------------------------------------------------------------- 比喻词

/** 去 AI 味禁令里点名的三个比喻词（context/prompts.ts 的 `ANTI_AI_RULES`）。 */
export const SIMILE_WORDS = ['仿佛', '犹如', '宛如'] as const;
/** 全章合计上限。 */
export const SIMILE_LIMIT = 3;

/** 三个比喻词在这段文字里一共出现几次。 */
export function countSimiles(text: string): number {
  let n = 0;
  for (const w of SIMILE_WORDS) {
    n += (text ?? '').split(w).length - 1;
  }
  return n;
}

/** 「仿佛 2 次、犹如 1 次」——说明里用，0 次的不列。 */
export function describeSimiles(text: string): string {
  return SIMILE_WORDS.map((w) => [w, (text ?? '').split(w).length - 1] as const)
    .filter(([, n]) => n > 0)
    .map(([w, n]) => `「${w}」${n} 次`)
    .join('、');
}

// ---------------------------------------------------------------- 拉丁字母缩写

/**
 * 正文里连续两个以上大写拉丁字母组成的缩写（PTSD、CPU、DNA……），去重、按出现顺序。
 * 全角字母先折成半角再找。
 */
export function latinAcronyms(text: string): string[] {
  const half = (text ?? '').replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const seen: string[] = [];
  for (const m of half.matchAll(/(?<![A-Za-z])[A-Z]{2,}(?![A-Za-z])/g)) {
    if (!seen.includes(m[0])) {
      seen.push(m[0]);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- 提前登场

/** 一章细纲里计划出场的人。 */
export interface PlannedCast {
  no: number;
  characters: readonly string[];
}

/** 后面几章才登场的一个人：名字与他第一次排进细纲的那一章。 */
export interface NotYet {
  name: string;
  no: number;
}

/**
 * 「本章不出场」的名单：后面几章细纲里排了、而本章与前面各章的细纲都没排过的人，按第一次
 * 排进细纲的章号升序。前面排过的不算——他已经登场过了，本章提一句是正常的回顾。
 */
export function notYetOnStage(input: {
  self: readonly string[];
  previous: readonly PlannedCast[];
  ahead: readonly PlannedCast[];
}): NotYet[] {
  const known = new Set<string>();
  for (const name of input.self) {
    known.add(name.trim());
  }
  for (const p of input.previous) {
    for (const name of p.characters) {
      known.add(name.trim());
    }
  }
  const out: NotYet[] = [];
  for (const p of [...input.ahead].sort((a, b) => a.no - b.no)) {
    for (const raw of p.characters) {
      const name = raw.trim();
      if (name && !known.has(name) && !out.some((x) => x.name === name)) {
        out.push({ name, no: p.no });
      }
    }
  }
  return out;
}

/** 提前写进本章的一个人：名字、按细纲第几章才登场、第一次出现的那一句。 */
export interface EarlyEntrance extends NotYet {
  quote: string;
}

/**
 * 名单里的人（名字或角色卡上的专属称呼）在这段正文里出现了。别名短于两个字的不认
 * （单字到处都是）。`quote` 是第一次出现的那一句，长了截到 60 字。
 */
export function findEarlyEntrances(
  text: string,
  notYet: readonly (NotYet & { aliases?: readonly string[] })[]
): EarlyEntrance[] {
  const out: EarlyEntrance[] = [];
  for (const who of notYet) {
    const names = [who.name, ...(who.aliases ?? [])].map((n) => n.trim()).filter((n) => n.length >= 2);
    let at = -1;
    for (const n of names) {
      const i = text.indexOf(n);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
      }
    }
    if (at >= 0) {
      out.push({ name: who.name, no: who.no, quote: sentenceAround(text, at) });
    }
  }
  return out;
}

function sentenceAround(text: string, at: number): string {
  const stops = /[。！？!?\n]/u;
  let from = at;
  while (from > 0 && !stops.test(text[from - 1])) {
    from--;
  }
  let to = at;
  while (to < text.length && !stops.test(text[to])) {
    to++;
  }
  const s = text.slice(from, Math.min(text.length, to + 1)).trim();
  const chars = Array.from(s);
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : s;
}

// ---------------------------------------------------------------- 续写回退

/** 结尾那一段与章末钩子的 bigram 覆盖率到这个数，算「钩子落在这里」。 */
export const HOOK_MATCH = 0.35;
/** 只在最后这么多比例的段落里找钩子：再往前就不是结尾了。 */
const HOOK_SEARCH_SPAN = 0.4;
/** 找不到钩子时切掉最后多少比例（按字数）。 */
const FALLBACK_CUT = 0.25;
/** 至少留下这么多比例（按字数）：切多了等于重写一章。 */
const MIN_KEEP = 0.5;

export interface Rewind {
  /** 留下的那一段（续写从它的末尾接下去）。 */
  keep: string;
  /** 切掉的那一截（丢弃，不进正文）。 */
  cut: string;
  /** 切掉了几段。 */
  paragraphs: number;
  /** 是按钩子找到的切点（否则是按比例切的）。 */
  byHook: boolean;
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function coverage(hook: Set<string>, paragraph: string): number {
  if (hook.size === 0) {
    return 0;
  }
  const own = textBigrams(paragraph);
  let hit = 0;
  for (const b of hook) {
    if (own.has(b)) {
      hit++;
    }
  }
  return hit / hook.size;
}

/**
 * 一章写到收尾了、篇幅却不够时，回退到哪里：从结尾那一场之前切开，后面的丢掉重写。
 *
 * - 在最后 40% 的段落里找与章末钩子最像的那一段（bigram 覆盖率 ≥ {@link HOOK_MATCH}，并列取靠前的），
 *   从它开始切——那一段就是收尾的地方；
 * - 找不到（钩子空着、或者模型没写到它）就从末尾往前切，切到约 25% 为止；
 * - 至少切一段、至少留一半。只有一段时没法切，返回 undefined——调用方照旧往后接。
 */
export function rewindPoint(text: string, hook: string): Rewind | undefined {
  const paras = paragraphsOf(text ?? '');
  if (paras.length < 2) {
    return undefined;
  }
  const total = paras.reduce((s, p) => s + p.length, 0);
  // 第 i 段之前一共多少字：切点在 i 时留下的就是它。
  const before = (i: number) => paras.slice(0, i).reduce((s, p) => s + p.length, 0);
  const allowed = (i: number) => i >= 1 && i < paras.length && before(i) >= total * MIN_KEEP;

  const bigrams = textBigrams(hook ?? '');
  const from = Math.max(1, Math.floor(paras.length * (1 - HOOK_SEARCH_SPAN)));
  let best = -1;
  let bestScore = 0;
  for (let i = from; i < paras.length; i++) {
    const score = coverage(bigrams, paras[i]);
    if (score >= HOOK_MATCH && score > bestScore && allowed(i)) {
      best = i;
      bestScore = score;
    }
  }
  let at = best;
  if (at < 0) {
    // 从末尾往前数，切够四分之一为止。
    at = paras.length - 1;
    while (at > 1 && total - before(at) < total * FALLBACK_CUT && allowed(at - 1)) {
      at--;
    }
    if (!allowed(at)) {
      return undefined;
    }
  }
  return {
    keep: paras.slice(0, at).join('\n\n'),
    cut: paras.slice(at).join('\n\n'),
    paragraphs: paras.length - at,
    byHook: best >= 0,
  };
}
