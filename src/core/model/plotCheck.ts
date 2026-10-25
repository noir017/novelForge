/**
 * 写前冲突检查（百章实验复盘）：写第 N 章之前，比对本章细纲与前面定稿留下的连续性事实，找**硬矛盾**。
 *
 * **纯函数**：提示词、选哪些事实、校验模型交回来的冲突。取数与调模型在 features/plotCheck.ts。
 *
 * ## 为什么要有它
 *
 * 一致性预检（preflight.ts）零调用，只认一种矛盾：细纲排了已经死了的人。百章实验里更多的是别的：
 * 第 50、60、70 章各「彻底摧毁」一次同一座大阵，已经交出去的玉简在下一章又从怀里掏出来，境界写了
 * 突破又退回去。这些只有读得懂两边的模型才认得出，所以花一次调用。
 *
 * ## 只认能逐字对上的
 *
 * 模型说的每一处冲突都要带两句原文：细纲里的那一句、事实里的那一条。两句都要在原文里找得到
 * （审稿引文那一套归一化：NFKC、去空白与标点），找不到的丢掉——这一步会让批量写章停下来，
 * 拿一条模型编出来的矛盾去拦作者，比漏掉一条更糟。
 *
 * 2026-10-25 起改成转写：比对的模型按格式写（两句原句用「」括出来），转写模型照抄成 JSON（{@link PLOT_CHECK_JSON_CONTRACT}）。
 */
import { normalizeQuote } from './review';
import { CONTEXT_DETAIL_LIMITS, DEFAULT_CONTEXT_DETAIL } from './contextDetail';

/*
 * 下面两个与审稿的近章事实是同一组数，随上下文详细度变（`factsChapters` / `factsChars`）。
 * 这里是缺省那一级的值，给 {@link selectCheckFacts} 当默认参数。
 */
/** 冲突检查最多带几章的近章事实。 */
export const PLOT_CHECK_RECENT = CONTEXT_DETAIL_LIMITS[DEFAULT_CONTEXT_DETAIL].factsChapters;
/** 事实一共带多少字。 */
export const PLOT_CHECK_BUDGET_CHARS = CONTEXT_DETAIL_LIMITS[DEFAULT_CONTEXT_DETAIL].factsChars;
/** 引文归一之后至少几个字才算数：太短的「他」「玉简」到处都对得上。 */
const MIN_QUOTE = 4;
/** 一次最多报几处。 */
export const PLOT_CHECK_MAX = 5;

/** 交给检查的一章定稿事实。 */
export interface CheckFacts {
  no: number;
  title?: string;
  statements: readonly string[];
}

/** 一处冲突：细纲里哪一句、与第几章的哪一条事实、为什么矛盾。 */
export interface PlotConflict {
  plot: string;
  fact: string;
  chapter: number;
  why: string;
}

export const PLOT_CHECK_SYSTEM = [
  '你是长篇小说的连续性编辑。下面给你本章的细纲（计划），和前面各章定稿之后留下的连续性事实（已经发生、不可更改的历史）。',
  '找出细纲与事实之间的**硬矛盾**，只认这几种：',
  '1. 事实里已经死了、离场了的人，细纲又安排他出场行动（明说是回忆、幻象、托梦、尸体的不算）；',
  '2. 事实里已经毁掉、用掉、交出去、丢了的东西，细纲又让人拿着、用着；',
  '3. 事实里已经发生过的终局级事件（大阵被毁、反派身死、秘境崩塌、某人突破到某一境界），细纲又让它从头再发生一次；',
  '4. 境界、身份、地点与事实相反且细纲没有交代变化（事实说已经突破到三层，细纲说还在二层；事实说已经离开宗门，细纲说他一直在宗门里）。',
  '风格、节奏、合不合理不归你管；细纲比事实多出来的新东西不算矛盾；拿不准的不报。',
  '',
  '按下面的格式写，不写 JSON：',
  '- 没有矛盾就只写「无矛盾」三个字。',
  `- 有矛盾的，一处一段，最多 ${PLOT_CHECK_MAX} 处；每段以「### 矛盾 N」开头，下面三行：「细纲：」后面是细纲里的原句，「事实：」后面是事实里的原句、括号里写它在第几章，「为什么：」后面一句话说清哪里矛盾。`,
  '- 两句原句都用「」括起来，必须逐字摘自下面给的原文，不拼接、不改写。',
  '【格式示例】',
  '### 矛盾 1',
  '细纲：「细纲里的原句」',
  '事实：「事实里的原句」（第 N 章）',
  '为什么：一句话说清哪里矛盾',
].join('\n');

/**
 * 转写那一步的 JSON 合同（2026-10-25 起）：把上面那份按格式写的结果搬成 `{"conflicts":[…]}`，形状与 features/plotCheck.ts
 * 原来认的一致（`jsonList(raw, 'conflicts')` + {@link verifyConflicts}）。两句原句照抄，之后照旧拿细纲与事实逐字核对。
 */
export const PLOT_CHECK_JSON_CONTRACT = [
  '【写前冲突检查 JSON 合同】',
  '只输出 {"conflicts":[...]}，原文里的一段「矛盾」是一项 {"plot":"…","fact":"…","chapter":N,"why":"…"}：',
  '- plot：「细纲：」后面「」里的那一句，不带「」；fact：「事实：」后面「」里的那一句，不带「」。',
  '- chapter：事实那一句后面括号里的第几章（数字），没写给 0；why：「为什么：」后面那一句。',
  '- 原文写「无矛盾」或一处都没写的：{"conflicts":[]}。',
  '- 文字一律从原文照抄：不改写、不总结、不润色，不补原文没有的，也不删原文写了的；两句原句一个字都不能改。chapter 按上面的对应关系填。',
  '只输出一个可由 JSON.parse 读取的 JSON 对象，不要解释、Markdown 或代码围栏。',
  '【JSON 形状】{"conflicts":[{"plot":"…","fact":"…","chapter":10,"why":"…"}]}',
].join('\n');

/** 只写了「无矛盾」（或「无」「没有矛盾」）：一处都没有，不必转写。 */
export function saysNoConflict(source: string): boolean {
  return /^[#*\s]*(?:无|没有)(?:硬)?(?:矛盾)?[。.！!]?[*\s]*$/u.test(source.trim());
}

/** 有没有冲突检查的样子：提到矛盾、细纲、事实，或括了原句。连这都没有的（「我不太确定」）不花转写那一次。 */
export function looksLikePlotCheck(source: string): boolean {
  return /矛盾|细纲|事实|「/u.test(source);
}

/**
 * 选哪些事实：提到本章计划出场的人的事实（不论多早），加上最近 `limits.recent` 章的全部事实；
 * 由近及远、一共不超过 `limits.chars` 字（缺省 {@link PLOT_CHECK_RECENT} 章、{@link PLOT_CHECK_BUDGET_CHARS} 字）。
 * 返回按章号升序。
 */
export function selectCheckFacts(
  chapters: readonly CheckFacts[],
  names: readonly string[],
  limits: { recent?: number; chars?: number } = {}
): CheckFacts[] {
  const keys = names.map((n) => n.trim()).filter((n) => n.length >= 2);
  const ordered = chapters.slice().sort((a, b) => b.no - a.no);
  const recent = new Set(ordered.slice(0, Math.max(0, limits.recent ?? PLOT_CHECK_RECENT)).map((c) => c.no));
  let budget = limits.chars ?? PLOT_CHECK_BUDGET_CHARS;
  const out: CheckFacts[] = [];
  for (const ch of ordered) {
    const picked: string[] = [];
    for (const s of ch.statements) {
      const text = s.trim();
      if (!text || (!recent.has(ch.no) && !keys.some((k) => text.includes(k)))) {
        continue;
      }
      if (text.length > budget) {
        budget = 0;
        break;
      }
      budget -= text.length;
      picked.push(text);
    }
    if (picked.length > 0) {
      out.push({ ...ch, statements: picked });
    }
    if (budget <= 0) {
      break;
    }
  }
  return out.sort((a, b) => a.no - b.no);
}

/** 交给模型的那一条用户消息。 */
export function plotCheckUser(plot: { no: number; title: string; text: string }, facts: readonly CheckFacts[]): string {
  const factBlock = facts
    .map((c) => `【第${c.no}章${c.title ? ` ${c.title}` : ''}】\n${c.statements.map((s) => `- ${s}`).join('\n')}`)
    .join('\n\n');
  return `# 前面各章定稿的连续性事实\n\n${factBlock}\n\n# 本章细纲（第${plot.no}章${plot.title ? ` ${plot.title}` : ''}）\n\n${plot.text}\n\n请按要求的格式写。`;
}

/**
 * 校验模型交回来的冲突：细纲那一句要在细纲原文里找得到，事实那一句要对上某一条事实（包含或被包含，
 * 归一之后比）。章号以对上的那一条为准（模型写错章号的也认）。对不上的计入 `dropped`。
 */
export function verifyConflicts(
  list: readonly unknown[],
  plotText: string,
  facts: readonly CheckFacts[]
): { conflicts: PlotConflict[]; dropped: number } {
  const plotNorm = normalizeQuote(plotText);
  const index = facts.flatMap((c) => c.statements.map((s) => ({ no: c.no, text: s, norm: normalizeQuote(s) })));
  const conflicts: PlotConflict[] = [];
  let dropped = 0;
  for (const item of list) {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const plot = typeof o.plot === 'string' ? o.plot.trim() : '';
    const fact = typeof o.fact === 'string' ? o.fact.trim() : '';
    const why = typeof o.why === 'string' ? o.why.trim() : '';
    const p = normalizeQuote(plot);
    const f = normalizeQuote(fact);
    const hit = f.length >= MIN_QUOTE ? index.find((x) => x.norm.includes(f) || (x.norm.length >= MIN_QUOTE && f.includes(x.norm))) : undefined;
    if (p.length < MIN_QUOTE || !plotNorm.includes(p) || !hit || conflicts.length >= PLOT_CHECK_MAX) {
      dropped++;
      continue;
    }
    conflicts.push({ plot, fact: hit.text, chapter: hit.no, why: clip(why, 120) });
  }
  return { conflicts, dropped };
}

/** 「细纲『……』与第 10 章的定稿事实『……』矛盾：……」。日志、失败记录与完成提示共用。 */
export function describeConflict(c: PlotConflict): string {
  return `细纲「${clip(c.plot, 40)}」与第 ${c.chapter} 章同步下来的事实「${clip(c.fact, 40)}」矛盾${c.why ? `：${c.why}` : ''}`;
}

/** 写在失败记录与完成提示里的那一句建议。 */
export const PLOT_CHECK_SUGGESTION = '改这一章的细纲；如果这本来就是刻意的安排，在这一章细纲的 frontmatter 里加一行 factCheckOk: true 放行。';

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}
