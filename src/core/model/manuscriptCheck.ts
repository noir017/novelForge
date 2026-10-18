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
 * - **续写越过章末的收尾**：第一次调用已经收了尾、只是篇幅不够时，续写接在收尾后面必然越过它。
 *   这种情况先回退到结尾那一场之前（{@link rewindPoint}，见 generation/continuation.ts）。
 *
 * 零 import。内置编辑器的「写作体检」（`media/src/editor/checkCore.ts`）也打包这一份：编辑器里标出来的禁用词、
 * 比喻词、拉丁缩写与写完一章之后数的是**同一个函数**——计数（{@link countBanned} / {@link countSimiles} /
 * {@link latinAcronyms}）都建在找位置的那两个函数上（{@link locateTerms} / {@link latinAcronymRanges}），
 * 编辑器拿位置画高亮，生成链拿个数写说明，两边不会一个说三次、一个画出四处。
 */

// ---------------------------------------------------------------- 找位置

/** 一个词在一段文字里出现在哪几处（起点，按 `text` 的下标，升序）。 */
export interface TermHits {
  term: string;
  offsets: number[];
}

/**
 * 拉丁字母不分大小写时的折法：半角大写、全角大小写一律折成半角小写。**一个字换一个字**（长度不变），
 * 折过之后的下标与原文一一对应。只折拉丁字母——中文没有大小写，别的文字（希腊、西里尔……）不在这里管。
 */
export function foldLatin(text: string): string {
  return (text ?? '').replace(/[A-ZＡ-Ｚａ-ｚ]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code <= 0x5a) {
      return String.fromCharCode(code + 0x20);
    }
    // 全角 Ａ-Ｚ（FF21–FF3A）、ａ-ｚ（FF41–FF5A）→ 半角 a-z。
    return String.fromCharCode((code >= 0xff41 ? code - 0xff41 : code - 0xff21) + 0x61);
  });
}

/**
 * 这几个词各自出现在哪几处。每个词**各找各的**、从左往右、不重叠——与 `text.split(term).length - 1`
 * 数出来的是同一批（{@link countBanned} 就是这么数的）；两个词叠在同一段字上（「数据」与「数据库」）各算各的。
 *
 * 一趟扫完：按词的第一个字建一张表，逐字只试以这个字开头的那几个词——几万字的正文、上千个词也只是一趟循环，
 * 不是「词数 × 全文」。返回与 `terms` 一一对应（重复的词各给一份同样的结果，空串没有命中）。
 *
 * `foldCase`：拉丁字母不分大小写（{@link foldLatin}，全角当半角）。生成链的禁用词不折（与从前的 `split` 一样），
 * 内置编辑器的敏感词表折。
 */
export function locateTerms(text: string, terms: readonly string[], opts: { foldCase?: boolean } = {}): TermHits[] {
  const fold = opts.foldCase ? foldLatin : (s: string) => s ?? '';
  const hay = fold(text ?? '');
  const found = new Map<string, number[]>();
  const byFirst = new Map<string, string[]>();
  for (const raw of terms) {
    const t = fold(raw ?? '');
    if (!t || found.has(t)) {
      continue;
    }
    found.set(t, []);
    const list = byFirst.get(t[0]);
    if (list) {
      list.push(t);
    } else {
      byFirst.set(t[0], [t]);
    }
  }
  if (found.size > 0) {
    /** 每个词下一处最早能从哪里起（上一处的末尾）：同一个词不重叠。 */
    const next = new Map<string, number>();
    for (let i = 0; i < hay.length; i++) {
      const candidates = byFirst.get(hay[i]);
      if (!candidates) {
        continue;
      }
      for (const t of candidates) {
        if ((next.get(t) ?? 0) <= i && hay.startsWith(t, i)) {
          found.get(t)!.push(i);
          next.set(t, i + t.length);
        }
      }
    }
  }
  return terms.map((raw) => ({ term: raw, offsets: found.get(fold(raw ?? '')) ?? [] }));
}

// ---------------------------------------------------------------- 比喻词

/**
 * 去 AI 味禁令里点名的比喻词（context/prompts.ts 的 `ANTI_AI_RULES`）。百章实验只数前三个，模型就改用
 * 「如同」——全书 287 次，比「仿佛」还多。
 */
export const SIMILE_WORDS = ['仿佛', '犹如', '宛如', '如同', '好似', '恍如', '宛若'] as const;
/** 全章合计上限。 */
export const SIMILE_LIMIT = 3;

/** 这几个比喻词各自出现在哪几处（{@link locateTerms}）。内置编辑器的体检拿它画高亮。 */
export function locateSimiles(text: string): TermHits[] {
  return locateTerms(text, SIMILE_WORDS);
}

/** 这几个比喻词在这段文字里一共出现几次。 */
export function countSimiles(text: string): number {
  return locateSimiles(text).reduce((n, h) => n + h.offsets.length, 0);
}

/** 「仿佛 2 次、犹如 1 次」——说明里用，0 次的不列。 */
export function describeSimiles(text: string): string {
  return locateSimiles(text)
    .filter((h) => h.offsets.length > 0)
    .map((h) => `「${h.term}」${h.offsets.length} 次`)
    .join('、');
}

/**
 * 对白段占比低于这个数时，续写那一轮提醒多让人物开口，写完记一条说明。人类网文三部 29–36%；
 * novel-test 百章修仙只有 10–14%，整章像旁白。
 */
export const DIALOGUE_FLOOR = 0.25;

/** 带引号（“”或「」）的段占全部段的比例。没有段时为 1（不提醒）。 */
export function dialogueShare(text: string): number {
  const paragraphs = (text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) {
    return 1;
  }
  return paragraphs.filter((p) => /[“「]/.test(p)).length / paragraphs.length;
}

// ---------------------------------------------------------------- 停在半句

/** 一句话能停在这些字上：句末标点、收引号与括号、省略号、破折号。 */
const SENTENCE_END = /[。！？!?…”’」』）)\]】—~～.]$/;

/**
 * 这段正文是不是停在半句上。网关不报收尾原因、或者报了「正常收尾」却其实断在半句（百章实验
 * 第 3 章停在「他已经到了极限，全身」）时，只能看结尾的那个字。空文本不算。
 */
export function endsMidSentence(text: string): boolean {
  const t = (text ?? '').replace(/\s+$/u, '');
  return t.length > 0 && !SENTENCE_END.test(t);
}

// ---------------------------------------------------------------- 禁用词

/**
 * 古代、修真一类题材里不该出现的现代说法。百章实验的全局要求写着「严禁使用现代科学或心理学词汇」，
 * 正文照样写了「能量」33 次、「神经」17 次、「频率」16 次、「坐标」10 次——规矩只靠模型自觉，没人数。
 */
export const MODERN_TERMS = ['能量', '神经', '频率', '坐标', '逻辑', '数据', '分钟', '秒钟', '物理', '化学', '细胞', '程序', '效率', '信号'] as const;

/** 认作古代、修真一类题材的说法（`config.md` 的 genre / subGenre）。 */
const ANCIENT_GENRE = /仙侠|玄幻|修真|修仙|武侠|奇幻|历史|古言|古代|宫斗|宅斗|洪荒|神话/;

/** 一个禁用词最长几个字：再长就是一句话，不是一个词。 */
const BANNED_MAX_CHARS = 8;
/** 「这一句是在禁止什么」的说法。 */
const BANNING = /禁|不得|不许|不准|不要|不用|不使用|避免|杜绝|别用/;
/** 括起来的词：「」、『』、“”、""。 */
const QUOTED = /[「『“"]([^」』”"\n]{1,16})[」』”"]/g;

/**
 * 这一本书写正文时不该用的词，三个来源，去重、按出现顺序：
 *
 * - `style.md` 的「禁用词表」一节里括起来的词（那一节整节都是禁令）；
 * - 小说配置「全局要求」里**表禁止的那一个分句**里括起来的词——同一句后半句往往是「须用『惊悸』『心病』」，
 *   那是要用的词，不能连着收进来；
 * - 题材是古代、修真一类时，内置的现代说法 {@link MODERN_TERMS}。
 */
export function bannedTerms(input: { styleBanList?: string; guidance?: string; genre?: string }): string[] {
  const out: string[] = [];
  const add = (term: string) => {
    const t = term.trim();
    if (t.length >= 2 && t.length <= BANNED_MAX_CHARS && !out.includes(t)) {
      out.push(t);
    }
  };
  for (const m of (input.styleBanList ?? '').matchAll(QUOTED)) {
    add(m[1]);
  }
  for (const clause of (input.guidance ?? '').split(/[，,。；;！!？?\n]/u)) {
    if (BANNING.test(clause)) {
      for (const m of clause.matchAll(QUOTED)) {
        add(m[1]);
      }
    }
  }
  if (ANCIENT_GENRE.test(input.genre ?? '')) {
    MODERN_TERMS.forEach(add);
  }
  return out;
}

/** 这段文字里用到了哪几个禁用词、各几次（0 次的不列），按出现次数从多到少。 */
export function countBanned(text: string, terms: readonly string[]): { term: string; count: number }[] {
  return locateTerms(text, terms)
    .map((h) => ({ term: h.term, count: h.offsets.length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** 「『能量』3 次、『神经』1 次」。 */
export function describeBanned(list: readonly { term: string; count: number }[]): string {
  return list.map((x) => `「${x.term}」${x.count} 次`).join('、');
}

// ---------------------------------------------------------------- 拉丁字母缩写

/**
 * 正文里每一处连续两个以上大写拉丁字母组成的缩写（PTSD、CPU、DNA……），按出现顺序、不去重。
 * 全角字母先折成半角再找（一个字换一个字，`start` / `end` 仍是原文的下标）；`term` 是折过的写法。
 */
export function latinAcronymRanges(text: string): { term: string; start: number; end: number }[] {
  const half = (text ?? '').replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const out: { term: string; start: number; end: number }[] = [];
  for (const m of half.matchAll(/(?<![A-Za-z])[A-Z]{2,}(?![A-Za-z])/g)) {
    out.push({ term: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** 正文里的拉丁字母缩写（{@link latinAcronymRanges}），去重、按出现顺序。 */
export function latinAcronyms(text: string): string[] {
  const seen: string[] = [];
  for (const r of latinAcronymRanges(text)) {
    if (!seen.includes(r.term)) {
      seen.push(r.term);
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
 * 一个人在正文里可能的几种写法：全名、括号里外各一截（「镇守人（陈道源）」→ 镇守人、陈道源）、
 * 角色卡上的专属称呼。两个字以上才算（单字到处都是）。
 */
export function namesOf(name: string, aliases: readonly string[] = []): string[] {
  const parts = name.split(/[（()）]/u).map((s) => s.trim());
  return [...new Set([name.trim(), ...parts, ...aliases.map((a) => a.trim())])].filter((n) => n.length >= 2);
}

/**
 * 本章细纲自己提到了的人不算「不出场」：细纲要他在本章被提起（钩子里一句警告、一段回忆），这时候
 * 再点名「本章不出场」只会和细纲打架，写完查到他也不是越界。真实模型试跑里第 3 章的钩子就是
 * 「老客提醒他祠堂里的陈老爷正在搜寻」，陈老爷是第 4 章才登场的镇守人的别名。
 */
export function dropMentioned<T extends NotYet & { aliases?: readonly string[] }>(list: readonly T[], selfText: string): T[] {
  return list.filter((who) => !namesOf(who.name, who.aliases).some((n) => selfText.includes(n)));
}

/**
 * 名单里的人（名字、括号里外各一截或角色卡上的专属称呼）在这段正文里出现了。`quote` 是第一次出现的
 * 那一句，长了截到 60 字。
 */
export function findEarlyEntrances(
  text: string,
  notYet: readonly (NotYet & { aliases?: readonly string[] })[]
): EarlyEntrance[] {
  const out: EarlyEntrance[] = [];
  for (const who of notYet) {
    const names = namesOf(who.name, who.aliases);
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

/** 切掉最后多少比例（按字数）…… */
const FALLBACK_CUT = 0.25;
/** ……最多切这么多字：认不出收尾从哪起，切多了是白扔。 */
const FALLBACK_MAX_CHARS = 600;
/** 至少留下这么多比例（按字数）：切多了等于重写一章。 */
const MIN_KEEP = 0.5;

export interface Rewind {
  /** 留下的那一段（续写从它的末尾接下去）。 */
  keep: string;
  /** 切掉的那一截（丢弃，不进正文）。 */
  cut: string;
  /** 切掉了几段。 */
  paragraphs: number;
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 一章写到收尾了、篇幅却不够时，回退到哪里：从结尾那一场之前切开，后面的丢掉重写。
 *
 * - 从末尾往前切，切到约 25%、最多 600 字为止；
 * - 至少切一段、至少留一半。只有一段时没法切，返回 undefined——调用方自己决定怎么办。
 *
 * 从前细纲单列一节「章末钩子」，这里按它找与之最像的那几段起切。钩子并进「看点」之后（看点里还有
 * 爽点，拿来找收尾那一场会切错地方），只按比例切。
 */
export function rewindPoint(text: string): Rewind | undefined {
  const paras = paragraphsOf(text ?? '');
  if (paras.length < 2) {
    return undefined;
  }
  const total = paras.reduce((s, p) => s + p.length, 0);
  // 第 i 段之前一共多少字：切点在 i 时留下的就是它。
  const before = (i: number) => paras.slice(0, i).reduce((s, p) => s + p.length, 0);
  const allowed = (i: number) => i >= 1 && i < paras.length && before(i) >= total * MIN_KEEP;

  // 从末尾往前数，切够四分之一（最多 600 字）为止。
  const want = Math.min(total * FALLBACK_CUT, FALLBACK_MAX_CHARS);
  let at = paras.length - 1;
  while (at > 1 && total - before(at) < want && allowed(at - 1)) {
    at--;
  }
  if (!allowed(at)) {
    return undefined;
  }
  return {
    keep: paras.slice(0, at).join('\n\n'),
    cut: paras.slice(at).join('\n\n'),
    paragraphs: paras.length - at,
  };
}
