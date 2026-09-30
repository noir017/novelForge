/**
 * 正文的自动续写：一章写不到目标字数、或者被输出上限截断时，接着再调几次把它写完。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts`
 * 的 `extendDraftIfNeeded` / `shouldAutoContinue`（GD:930-1186）与 `bounded-completion.ts`
 * 的 `appendVisibleTextContinuation`（拼接时去掉与已写末尾重叠的开头）。
 *
 * 这一份先放纯函数：该不该续、续出来的那一段怎么接到已写的后面。
 */
import { StopSignal } from '../llm/provider';
import { countWords } from '../model/fs';
import { MANUSCRIPT_DONE_RATIO, MAX_CONTINUE_ROUNDS } from '../model/pipeline';

// 续写时带已写正文的最后 1600 字：取法在装配那一层（「接着写」的第一次调用也要它）。
export { CONTINUE_TAIL_CHARS, continuationTail } from '../context/layers/render';

/** 一轮续写少于这么多字算「没进展」（上游 GD:1121）。 */
export const MIN_ROUND_GAIN = 300;
/** 被截断、而正文还不到这么多字：输出预算被思考吃光了（上游 GD:973-986）。 */
export const STARVED_CHARS = 100;
/**
 * 续写的开头与已写末尾重合这么多个非空白字符才算「重复了一截」，要去掉。
 * 太短会误伤：两段都以「他」开头不算重叠（上游 `MIN_VISIBLE_OVERLAP_CHARS`）。
 */
export const MIN_OVERLAP_CHARS = 48;
/** 比对重叠时各取多少字（上游 `CONTINUATION_VISIBLE_TAIL_CHARS`）。 */
const OVERLAP_WINDOW = 1600;
/** 整段重复：去掉空白后不短于这么多字、又与已写的某一段一字不差（上游 `sanitizeDraftText`）。 */
const DUPLICATE_PARAGRAPH_CHARS = 40;

/**
 * 这一轮之后还要不要续。
 *
 * - 没有目标字数：不续——「有字就算写够」，不拿猜出来的数去续（总计划 D6 的另一半）；
 * - 到了 {@link MAX_CONTINUE_ROUNDS} 轮：不续；
 * - 被输出上限截断：续——结尾停在半句上，哪怕字数够了；
 * - 因为别的原因停了（`other`：多半是内容审查）：不续，再调一次多半还是停；
 * - 其余看字数：不到目标的八成就续（与 `deriveStage` 同一个 {@link MANUSCRIPT_DONE_RATIO}）。
 */
export function shouldContinue(s: { words: number; target?: number; stop?: StopSignal; rounds: number }): boolean {
  if (!s.target || s.target <= 0 || s.rounds >= MAX_CONTINUE_ROUNDS) {
    return false;
  }
  if (s.stop === 'maxTokens') {
    return true;
  }
  if (s.stop === 'other') {
    return false;
  }
  return s.words < lowerBound(s.target);
}

/** 目标字数的八成：到了这个数就算写够。 */
export function lowerBound(target: number): number {
  return Math.floor(target * MANUSCRIPT_DONE_RATIO);
}

/**
 * 去掉模型自己加的界面话术：「点我继续生成后续内容」「未完待续」这类单独成行的提示，
 * 以及三个以上的连续空行。只动这几样，正文一个字不碰。
 */
export function sanitizeAddition(text: string): string {
  return text
    .replace(/^\s*(?:点我继续生成后续内容|继续生成后续内容|请点击继续|未完待续)[。.！!…]*\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 续出来的这一段开头与已写末尾重叠的那一截去掉（按非空白字符比，≥ {@link MIN_OVERLAP_CHARS}）。
 *
 * 模型接着写时常把已写的最后一两句复述一遍再往下走——拼上去就是一句话出现两次。
 */
export function stripOverlap(existing: string, addition: string): string {
  const tail = existing.slice(-OVERLAP_WINDOW).replace(/\s+/g, '');
  const head = addition.slice(0, OVERLAP_WINDOW).replace(/\s+/g, '');
  const maximum = Math.min(tail.length, head.length);
  let overlap = 0;
  for (let length = maximum; length >= MIN_OVERLAP_CHARS; length--) {
    if (tail.slice(-length) === head.slice(0, length)) {
      overlap = length;
      break;
    }
  }
  if (overlap === 0) {
    return addition;
  }
  // 按非空白字符数往后数，跳过重叠的那一截。
  let consumed = 0;
  for (let i = 0; i < addition.length; i++) {
    if (!/\s/.test(addition[i])) {
      consumed++;
    }
    if (consumed >= overlap) {
      return addition.slice(i + 1).trimStart();
    }
  }
  return '';
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function paragraphKey(p: string): string {
  return p.replace(/\s+/g, '');
}

/**
 * 把续写的这一段接到已写的后面：去话术、去重叠、去整段重复，段与段之间空一行。
 *
 * 返回拼好的全文与**真正新增**的那一段——`continue` 写法落盘时只追加后者，
 * 「这一轮多了几个字」也按后者算。
 */
export function joinContinuation(existing: string, addition: string): { text: string; added: string } {
  const base = existing.trim();
  const trimmed = stripOverlap(base, sanitizeAddition(addition));
  const seen = new Set(paragraphsOf(base).map(paragraphKey).filter((k) => k.length >= DUPLICATE_PARAGRAPH_CHARS));
  const kept: string[] = [];
  for (const p of paragraphsOf(trimmed)) {
    const key = paragraphKey(p);
    if (key.length >= DUPLICATE_PARAGRAPH_CHARS) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    kept.push(p);
  }
  const added = kept.join('\n\n');
  return { text: [base, added].filter(Boolean).join('\n\n'), added };
}

/** 两段文字合起来有多少字：`continue` 写法下「这一章写到多少字了」要连已有的一起算。 */
export function wordsOf(...parts: string[]): number {
  return parts.reduce((sum, p) => sum + countWords(p), 0);
}
