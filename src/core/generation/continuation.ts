/**
 * 正文的自动续写：一章写不到目标字数、或者被输出上限截断时，接着再调几次把它写完。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts`
 * 的 `extendDraftIfNeeded` / `shouldAutoContinue`（GD:930-1186）与 `bounded-completion.ts`
 * 的 `appendVisibleTextContinuation`（拼接时去掉与已写末尾重叠的开头）。
 *
 * ## 一条链，单步与批量共用
 *
 * 与 `structured.ts` 那三条链同一个 {@link ChainIO}：对话页第一次调用是流式的，后面几轮
 * 照样流进同一个气泡；将来批量写正文（四期）换一个走分档池的 `ChainIO` 就能用。
 *
 * ## 比上游宽松：已写的不丢（D6）
 *
 * 上游在这几种情况下整份作废、不保存：恢复那一轮仍没进展、最后仍被截断、最后仍不到八成。
 * 这里一律**保留并说清**——卡片照样可以写入，说明里写着为什么停、差多少。作者看着
 * 一章写了 2100 / 3000 字的正文，比看着一句「结果未保存」有用得多，而且那 2100 字的钱
 * 已经花了。只有「一个字正文都没有」（思考把输出预算吃光）才报错。
 *
 * 另一处：续写某一轮调用失败（网络、限流）时，前面写好的也保留，不让一次抖动把整章带走。
 * 作者自己点了停止不算——那是他不要了。
 */
import { CancelledError, StopSignal } from '../llm/provider';
import { countWords } from '../model/fs';
import { MANUSCRIPT_DONE_RATIO, MAX_CONTINUE_ROUNDS, WriteMode } from '../model/pipeline';
import { continuationTail } from '../context/layers/render';
import { detectReplay } from '../context/replay';
import { cleanOutput } from '../features/creation';
import { describeError } from '../runtime/logger';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';

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

// ---------------------------------------------------------------- 续写链

/** 写正文时的进度：第几轮（0 = 第一次调用）、这一章写到多少字了、目标多少。 */
export interface WriteProgress {
  round: number;
  words: number;
  target?: number;
}

export interface ManuscriptChainContext {
  mode: WriteMode;
  /** 本章已有的正文（`continue` 写法才有）。「写到多少字了」连它一起算。 */
  existing: string;
  /** 目标字数。缺席时不自动续写（`shouldContinue`）。 */
  target?: number;
  /** 上一章的结尾（重演检测用）。第 1 章、上一章还没写正文时缺席。 */
  prevEnding?: string;
  /** 第一次调用有没有思考——截断且没几个字时，报错的说法不一样。 */
  reasoned: boolean;
  /** 每一轮开始时报一次进度。流式期间的进度由 `ChainIO.call` 的 `progress` 选项另报。 */
  onProgress?(p: WriteProgress): void;
  signal?: AbortSignal;
}

export interface ManuscriptChainResult extends ChainResult {
  /** 续写了几轮（不含第一次调用；丢弃的那一轮也算）。 */
  rounds: number;
  /** 这一章写完之后的总字数（`continue` 写法含已有的）。 */
  words: number;
  /** 这一次新写的字数。 */
  added: number;
  /** 不到目标的八成。 */
  short: boolean;
  /** 最后一轮仍被输出上限截断：结尾可能停在半句上。 */
  truncated: boolean;
  /** 新稿开头与上一章结尾重合的那一段原文（重演）。 */
  replay?: string;
}

/**
 * 写一章正文：第一次调用之后按需续写，最后查一遍重演。见文件头与三期计划 §3。
 *
 * `first` 是已经跑完的第一次调用（对话页流式跑的那一次）。返回的 `raw` 只含**这一次
 * 新写的**正文——`continue` 写法落盘是追加，已有的那部分不该再写一遍。
 */
export async function completeManuscript(
  first: CallOutcome,
  io: ChainIO,
  ctx: ManuscriptChainContext
): Promise<ManuscriptChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  const base = ctx.existing.trim();
  // 「接着写」的第一次调用也可能把已写的最后几句复述一遍：一样去重叠。
  let added = joinContinuation(base, cleanOutput(first.text)).added;
  let stop = first.stop;
  const total = () => wordsOf(base, added);

  if (stop === 'maxTokens' && countWords(added) < STARVED_CHARS) {
    t.fail(
      ctx.reasoned
        ? '模型把输出上限几乎全用在了思考上，正文还没写几个字就被截断了。调大设置页的「最大输出 token」，或降低思考深度再试。'
        : '正文还没写几个字就被输出上限截断了。调大设置页的「最大输出 token」再试。'
    );
  }

  let rounds = 0;
  let recoveryUsed = false;
  let recoveryPending = false;
  let lastGain = Number.POSITIVE_INFINITY;
  while (shouldContinue({ words: total(), target: ctx.target, stop, rounds })) {
    // 正常收尾、而上一轮只多了几句：模型认为这一章写完了，再催也是注水（上游 GD:1152）。
    if (stop !== 'maxTokens' && lastGain < MIN_ROUND_GAIN) {
      t.note(`续写第 ${rounds} 轮只多了 ${lastGain} 字，模型已经收尾，不再续写`);
      break;
    }
    rounds++;
    const written = [base, added].filter(Boolean).join('\n\n');
    const before = total();
    ctx.onProgress?.({ round: rounds, words: before, target: ctx.target });
    const messages = await io.build({
      step: {
        kind: 'continuation',
        tail: continuationTail(written),
        written: before,
        remaining: ctx.target ? Math.max(0, ctx.target - before) : undefined,
        recovery: recoveryPending,
      },
    });
    let out: CallOutcome;
    try {
      out = await t.call(io, messages, recoveryPending ? `续写第 ${rounds} 轮（恢复）` : `续写第 ${rounds} 轮`, {
        separator: '\n\n',
        progress: { round: rounds, base: before },
      });
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal?.aborted) {
        throw err;
      }
      // 一次网络抖动不该把前面写好的几千字带走（D6）。
      t.note(`续写第 ${rounds} 轮调用失败（${describeError(err)}），停在这里，已写的保留`);
      io.reset?.(added);
      break;
    }
    const joined = joinContinuation(written, cleanOutput(out.text));
    const gain = countWords(joined.added);

    // 被截断又几乎没写出新东西：这一轮丢掉，只给一次恢复机会（上游 GD:1130-1146）。
    if (out.stop === 'maxTokens' && gain < MIN_ROUND_GAIN) {
      io.reset?.(added);
      if (recoveryUsed) {
        t.note(`续写第 ${rounds} 轮（恢复）仍被截断、只多了 ${gain} 字，已丢弃，停在这里；已写的保留`);
        stop = out.stop;
        break;
      }
      recoveryUsed = true;
      recoveryPending = true;
      t.note(`续写第 ${rounds} 轮被截断、只多了 ${gain} 字，已丢弃，再给一次恢复机会`);
      stop = out.stop;
      lastGain = Number.POSITIVE_INFINITY;
      continue;
    }
    added = [added, joined.added].filter(Boolean).join('\n\n');
    stop = out.stop;
    recoveryPending = false;
    lastGain = gain;
    t.note(`续写第 ${rounds} 轮：多了 ${gain} 字，到 ${total()}${ctx.target ? ` / ${ctx.target}` : ''} 字`);
  }

  if (rounds >= MAX_CONTINUE_ROUNDS && shouldContinue({ words: total(), target: ctx.target, stop, rounds: 0 })) {
    t.note(`续写到了上限 ${MAX_CONTINUE_ROUNDS} 轮，没有再续`);
  }
  if (stop === 'other') {
    t.note('模型因为别的原因停下了（常见的是内容审查），没有再续写');
  }
  const truncated = stop === 'maxTokens';
  if (truncated) {
    t.note(
      ctx.target
        ? '最后一轮仍被输出上限截断，结尾可能停在半句上。写入后可以接着写或手改。'
        : '输出被输出上限截断，结尾可能停在半句上。细纲与配置里都没写目标字数，所以没有自动续写。'
    );
  }
  const words = total();
  const short = !!ctx.target && words < lowerBound(ctx.target);
  if (short) {
    t.note(`未写够：这一章写到 ${words} / ${ctx.target} 字，不到八成。已写的照样可以写入，之后主按钮会推「接着写」`);
  }

  let replay: string | undefined;
  if (ctx.mode !== 'continue' && ctx.prevEnding) {
    const v = detectReplay(ctx.prevEnding, added);
    if (v.hit) {
      replay = v.quote;
      t.note(`开头与上一章结尾大段重合（连续 ${v.run} 字），可能把上一章最后一场又演了一遍`);
    }
  }

  return {
    raw: added,
    notes: t.notes,
    calls: t.calls,
    rounds,
    words,
    added: countWords(added),
    short,
    truncated,
    replay,
  };
}
