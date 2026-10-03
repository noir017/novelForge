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
 *
 * ## 收尾过早时先回退（五期补遗 §1.1 ⚑，上游没有）
 *
 * 三期真实模型首跑：三章的第一次调用都正常收尾、只写到目标的 55–77%。第一次调用已经按执行卡
 * 收在章末钩子上了，不到八成的续写只能接在钩子**后面**——第 3 章在钩子之后又写了 869 字，
 * 最后把第 4 章才登场的人写了出来。被截断时结尾停在半句上，往后接没问题；正常收尾时结尾就是
 * 钩子，往后接必然越过它。
 *
 * 所以正常收尾（`end`）又不够八成时，续写先把收尾那一场切掉（model/manuscriptCheck.ts 的
 * `rewindPoint`：与钩子最像的那几段起，找不到切最后约四分之一、最多 600 字，至少留一半），从切点接着写、
 * 写足之后重新落到钩子上。一次写一千字上下的模型一章要这样走两三轮，所以可以回退几次，但**每次只在
 * 上一轮新写的那一段里切**（前几轮已经接受的正文不再动）；回退那一轮净多的不到 300 字、或者上一轮那一段
 * 短得没法切，就停——不往钩子后面接。网关不报收尾原因（`stop` 缺席）时分不清是收尾还是截断，照旧往后接。
 *
 * ## 停在半句上算截断
 *
 * 只信模型报的收尾原因不够：百章实验第 3 章停在「他已经到了极限，全身」，字数过了八成，照样定稿了。
 * 每一次调用之后看一眼结尾那个字（model/manuscriptCheck.ts 的 `endsMidSentence`）：不是句末标点就按
 * `maxTokens` 处理——往后接、不回退。写完仍停在半句上时 `truncated` 为真，批量写章据此停下。
 *
 * ## 写完查三样（§1.2、§1.3、§1.5）
 *
 * 比喻词超没超上限、有没有拉丁字母缩写、后面几章才登场的人有没有提前写进来——只记说明，
 * 不改正文。最后一样批量写章据此停下（features/pipelineBatch.ts）。
 */
import { CancelledError, StopSignal } from '../llm/provider';
import { countWords } from '../model/fs';
import { MANUSCRIPT_DONE_RATIO, MAX_CONTINUE_ROUNDS, WriteMode } from '../model/pipeline';
import {
  EarlyEntrance,
  NotYet,
  SIMILE_LIMIT,
  SIMILE_WORDS,
  countBanned,
  countSimiles,
  describeBanned,
  describeSimiles,
  endsMidSentence,
  findEarlyEntrances,
  latinAcronyms,
  rewindPoint,
} from '../model/manuscriptCheck';
import { continuationTail } from '../context/layers/render';
import { detectReplay } from '../context/replay';
import { cleanOutput } from '../features/creation';
import { describeError } from '../runtime/logger';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';
import { trimModifiers } from './trim';

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
  /** 本章细纲的章末钩子：收尾过早要回退时，按它找收尾那一段。 */
  hook?: string;
  /** 后面几章才登场的人（名字与别名）：写完查一遍有没有提前写进来。 */
  notYet?: readonly (NotYet & { aliases?: readonly string[] })[];
  /** 这本书写正文时不该用的词：续写那一轮告诉它已经用了哪几个，写完数一遍。 */
  banned?: readonly string[];
  /** 写完之后跑一轮删修饰（`trim.ts`）。设置里的「写完正文删修饰」。 */
  trim?: boolean;
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
  /** 结尾停在半句上：最后一轮仍被输出上限截断，或者结尾那个字不是句末标点（{@link endsMidSentence}）。 */
  truncated: boolean;
  /** 新稿开头与上一章结尾重合的那一段原文（重演）。 */
  replay?: string;
  /** 后面几章才登场、却写进了这一次新写的正文里的人。 */
  early?: EarlyEntrance[];
  /** 删修饰真删了字时：删之前那一版（只含这一次新写的，与 `raw` 对应）。 */
  untrimmed?: string;
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
  // 模型说正常收尾（或网关不报原因）、结尾却停在半句上：照截断处理——往后接，不回退。
  const settle = (s: StopSignal | undefined, text: string, round: string): StopSignal | undefined => {
    if (s === 'maxTokens' || s === 'other' || !endsMidSentence(text)) {
      return s;
    }
    t.note(`${round}的结尾停在半句上（${s === 'end' ? '模型报的是正常收尾' : '网关没报收尾原因'}），按截断接着写`);
    return 'maxTokens';
  };
  stop = settle(stop, added, '第一次调用');

  let rounds = 0;
  let recoveryUsed = false;
  let recoveryPending = false;
  let rewinds = 0;
  /** 最近一次回退之前这一章写到多少字：回退那一轮写完之后对着它算净多了几个字。 */
  let beforeCut = 0;
  /**
   * 上一轮新写的那一段（第一次调用之后就是 `added` 全部）。**回退只在它里面切**：前几轮已经接受的
   * 正文不再动，认不出钩子时最多也只白扔上一轮的四分之一。
   */
  let fresh = added;
  /**
   * 回退时切掉、还没有被新写的结尾替上的那一截。回退之后那一轮没写成（调用失败、截断丢弃）
   * 就把它放回去——宁可留着那个短一点但落在钩子上的结尾，也不留一章没有结尾的正文。
   */
  let pendingCut: string | undefined;
  const restoreCut = () => {
    if (pendingCut) {
      added = [added, pendingCut].filter(Boolean).join('\n\n');
      pendingCut = undefined;
      // 放回去的是一个正常收尾的结尾，不是停在半句上的那一截。
      stop = 'end';
      io.reset?.(added);
      t.note('回退之后那一轮没写成，原来的结尾放回去了');
    }
  };
  const usedBanned = (text: string) => (ctx.banned?.length ? countBanned(text, ctx.banned) : []);
  let lastGain = Number.POSITIVE_INFINITY;
  while (shouldContinue({ words: total(), target: ctx.target, stop, rounds })) {
    // 正常收尾、而上一轮只多了几句：模型认为这一章写完了，再催也是注水（上游 GD:1152）。
    if (stop !== 'maxTokens' && lastGain < MIN_ROUND_GAIN) {
      t.note(`续写第 ${rounds} 轮只多了 ${lastGain} 字，模型已经收尾，不再续写`);
      break;
    }
    // 正常收尾又不够八成：结尾已经落在章末钩子上了，往后接就越过它（见文件头）。先回退到收尾那一场
    // 之前再写；写完又是这样就再回退一次——一次写一千字上下的模型，一章要这样走两三轮。回退那一轮
    // 净多的不到 300 字、或者上一轮那一段短得没法切，就停在这里，不往钩子后面接。
    let rewinding = false;
    if (stop === 'end') {
      if (rewinds > 0 && total() - beforeCut < MIN_ROUND_GAIN) {
        t.note(`回退重写那一轮只比回退之前多了 ${total() - beforeCut} 字，模型又按钩子收了尾，没有再往章末钩子后面续写`);
        break;
      }
      const point = rewindPoint(fresh, ctx.hook ?? '');
      if (!point && rewinds > 0) {
        t.note(`回退重写之后模型又收了尾（到 ${total()} 字），上一轮那一段太短、认不出收尾在哪，没有再往章末钩子后面续写`);
        break;
      }
      if (point) {
        beforeCut = total();
        const head = added.slice(0, added.length - fresh.length).trim();
        added = [head, point.keep].filter(Boolean).join('\n\n');
        fresh = point.keep;
        pendingCut = point.cut;
        rewinds++;
        rewinding = true;
        io.reset?.(added);
        t.note(
          `写到 ${beforeCut}${ctx.target ? ` / ${ctx.target}` : ''} 字就${point.byHook ? '按章末钩子' : ''}收了尾：` +
            `拿掉结尾 ${point.paragraphs} 段（约 ${countWords(point.cut)} 字），从它前面接着写，写足之后重新收在钩子上`
        );
      }
    }
    rounds++;
    const written = [base, added].filter(Boolean).join('\n\n');
    const before = total();
    // 上一轮停在半句上：新写的是那半句的后半截，直接接上，不空行。
    const glue = endsMidSentence(written) ? '' : '\n\n';
    ctx.onProgress?.({ round: rounds, words: before, target: ctx.target });
    const messages = await io.build({
      step: {
        kind: 'continuation',
        tail: continuationTail(written),
        written: before,
        remaining: ctx.target ? Math.max(0, ctx.target - before) : undefined,
        recovery: recoveryPending,
        ...(rewinding ? { rewound: true } : {}),
        similes: countSimiles(written),
        ...(usedBanned(written).length > 0 ? { banned: usedBanned(written) } : {}),
      },
    });
    let out: CallOutcome;
    try {
      out = await t.call(
        io,
        messages,
        recoveryPending ? `续写第 ${rounds} 轮（恢复）` : rewinding ? `续写第 ${rounds} 轮（回退重写结尾）` : `续写第 ${rounds} 轮`,
        {
          separator: glue,
          progress: { round: rounds, base: before },
        }
      );
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal?.aborted) {
        throw err;
      }
      // 一次网络抖动不该把前面写好的几千字带走（D6）。
      t.note(`续写第 ${rounds} 轮调用失败（${describeError(err)}），停在这里，已写的保留`);
      io.reset?.(added);
      restoreCut();
      break;
    }
    const joined = joinContinuation(written, cleanOutput(out.text));
    const gain = countWords(joined.added);
    const outStop = settle(out.stop, `${written}${glue}${joined.added}`, `续写第 ${rounds} 轮`);

    // 被截断又几乎没写出新东西：这一轮丢掉，只给一次恢复机会（上游 GD:1130-1146）。
    if (outStop === 'maxTokens' && gain < MIN_ROUND_GAIN) {
      io.reset?.(added);
      if (recoveryUsed) {
        t.note(`续写第 ${rounds} 轮（恢复）仍被截断、只多了 ${gain} 字，已丢弃，停在这里；已写的保留`);
        stop = outStop;
        restoreCut();
        break;
      }
      recoveryUsed = true;
      recoveryPending = true;
      t.note(`续写第 ${rounds} 轮被截断、只多了 ${gain} 字，已丢弃，再给一次恢复机会`);
      stop = outStop;
      lastGain = Number.POSITIVE_INFINITY;
      continue;
    }
    added = added ? `${added}${glue}${joined.added}` : joined.added;
    fresh = joined.added;
    pendingCut = undefined;
    stop = outStop;
    recoveryPending = false;
    lastGain = gain;
    t.note(`续写第 ${rounds} 轮：多了 ${gain} 字，到 ${total()}${ctx.target ? ` / ${ctx.target}` : ''} 字`);
  }
  // 到了轮数上限、回退之后那一轮还没写成：同样放回去。
  restoreCut();

  if (rounds >= MAX_CONTINUE_ROUNDS && shouldContinue({ words: total(), target: ctx.target, stop, rounds: 0 })) {
    t.note(`续写到了上限 ${MAX_CONTINUE_ROUNDS} 轮，没有再续`);
  }
  if (stop === 'other') {
    t.note('模型因为别的原因停下了（常见的是内容审查），没有再续写');
  }
  let untrimmed: string | undefined;
  if (ctx.trim) {
    // 删之前够八成的，删完也得够：不然主按钮转去推「接着写」，这一轮等于白删。
    const floor = ctx.target && total() >= lowerBound(ctx.target) ? lowerBound(ctx.target) - wordsOf(base) : undefined;
    const trimmed = await trimModifiers(io, t, added, { floor, signal: ctx.signal });
    added = trimmed.text;
    untrimmed = trimmed.untrimmed;
  }
  const chapterText = [base, added].filter(Boolean).join('\n\n');
  const midSentence = endsMidSentence(chapterText);
  const truncated = stop === 'maxTokens' || midSentence;
  if (truncated) {
    t.note(
      midSentence
        ? `结尾停在半句上：「${chapterText.trim().slice(-20)}」。${ctx.target ? '续写没能把它接完，' : '细纲与配置里都没写目标字数，所以没有自动续写，'}写入后可以接着写或手改。`
        : ctx.target
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

  // 写完查三样（五期补遗 §1.2、§1.3、§1.5）：只记说明，不改正文。
  const similes = countSimiles(chapterText);
  if (similes > SIMILE_LIMIT) {
    t.note(`比喻词${SIMILE_WORDS.map((w) => `「${w}」`).join('')}全章合计 ${similes} 次（${describeSimiles(chapterText)}），超过 ${SIMILE_LIMIT} 次的上限`);
  }
  const banned = usedBanned(chapterText);
  if (banned.length > 0) {
    t.note(`正文用到了这本书不该用的词：${describeBanned(banned)}。换成这个故事里的人会说的话`);
  }
  const acronyms = latinAcronyms(added);
  if (acronyms.length > 0) {
    t.note(`正文里有英文缩写：${acronyms.join('、')}。故事的年代用不上这种说法的话，改成那个年代的人会说的话`);
  }
  const early = ctx.notYet?.length ? findEarlyEntrances(added, ctx.notYet) : [];
  for (const e of early) {
    t.note(`${e.name}按细纲第 ${e.no} 章才登场，本章已经写到了：「${e.quote}」`);
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
    ...(early.length > 0 ? { early } : {}),
    ...(untrimmed ? { untrimmed } : {}),
  };
}
