/**
 * 修稿链（五期）：按勾选的审稿意见把整章改一遍，被截断就接着写，最后查一遍长度。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 *
 * - 续写：`refine-from-review.command.ts` 的 `{ mode: 'append-visible-text', maxContinuations: 3 }`
 *   与 `bounded-completion.ts` 的续接（只看 `finishReason === 'length'`，拼接时去掉与已写末尾的
 *   重叠）。拼接用的是三期那一份 `joinContinuation`，同一套去重叠、去整段重复。
 * - 完整性校验：`refinement-completeness.ts` 全文（{@link revisionShortfall}）。
 *
 * ## 与写章相反：报错就不出卡片（五期计划 §5 ⚑）
 *
 * 写章时那一版是新东西，半截也比没有强，所以「已写的不丢」（D6）。修稿是拿它**覆盖**一章
 * 已经写好的正文：截断三轮仍没写完、或者明显短于原稿，都说明这一份修订稿不完整，覆盖上去
 * 就是把作者的后半章弄丢了。已经收到的文字留在气泡里，作者可以自己取用。
 */
import { CancelledError } from '../llm/provider';
import { countWords } from '../model/fs';
import { REVISE_CONTINUE_ROUNDS } from '../model/pipeline';
import { continuationTail } from '../context/layers/render';
import { cleanOutput } from '../features/creation';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';
import { WriteProgress, joinContinuation } from './continuation';

/** 修订稿至少要有原稿（或每章字数）的这个比例（上游 `MIN_REFINEMENT_COMPLETION_RATIO`）。 */
export const MIN_REVISION_RATIO = 0.6;
/** 下限不低于这么多字（上游 `MIN_REFINEMENT_UNITS`）；原稿本身更短时以原稿为准。 */
export const MIN_REVISION_UNITS = 200;

const CJK = /[㐀-䶿一-鿿豈-﫿]/gu;
const EN_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/gu;

/**
 * 看得见的正文有多少「字」：汉字一个算一个、英文一个词算一个、其余非空白非标点的字符一个算一个。
 * 逐字移植自上游 `countVisibleProseUnits`——不拿 `countWords` 是因为那一份数的是给作者看的字数，
 * 这里只用来判「是不是明显短了」，两者口径一致与否无所谓，与上游一致才要紧。
 */
export function countProseUnits(text: string): number {
  const words = text.match(EN_WORD)?.length ?? 0;
  const rest = text.replace(EN_WORD, '');
  const cjk = rest.match(CJK)?.length ?? 0;
  const other = rest.replace(CJK, '').replace(SPACE_OR_PUNCT, '').length;
  return cjk + words + other;
}

/**
 * 修订稿是不是明显短于原稿。移植自 `assertMateriallyCompleteRevision`：
 * 下限 = min(原稿, max(200, ⌊0.6 × min(原稿, 每章字数)⌋))。只有下限，没有上限。
 * 返回报错的那一句；够长时 undefined。
 */
export function revisionShortfall(source: string, revision: string, wordsPerChapter?: number): string | undefined {
  const src = countProseUnits(source);
  const rev = countProseUnits(revision);
  const bounded = wordsPerChapter && wordsPerChapter > 0 ? Math.min(src, wordsPerChapter) : src;
  const minimum = Math.min(src, Math.max(MIN_REVISION_UNITS, Math.floor(bounded * MIN_REVISION_RATIO)));
  if (rev >= minimum) {
    return undefined;
  }
  return `修订稿明显短于原稿（${rev} / ${src} 字，至少要 ${minimum} 字），可能不完整，没有出卡片。请重试，或少勾几条缩小这一次的修稿范围。`;
}

export interface RevisionChainContext {
  /** 待修的原稿（整章正文，去掉标题行）。 */
  source: string;
  /** 小说配置的每章字数：完整性校验的下限按它封顶（上游传的也是它）。 */
  wordsPerChapter?: number;
  onProgress?(p: WriteProgress): void;
  signal?: AbortSignal;
}

export interface RevisionChainResult extends ChainResult {
  /** 续写了几轮（不含第一次调用）。 */
  rounds: number;
  /** 修订稿多少字。 */
  words: number;
}

export async function completeRevision(first: CallOutcome, io: ChainIO, ctx: RevisionChainContext): Promise<RevisionChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  const sourceWords = countWords(ctx.source);
  let text = cleanOutput(first.text);
  let stop = first.stop;
  let rounds = 0;
  while (stop === 'maxTokens' && rounds < REVISE_CONTINUE_ROUNDS) {
    rounds++;
    const before = countWords(text);
    ctx.onProgress?.({ round: rounds, words: before, target: sourceWords });
    const messages = await io.build({
      step: { kind: 'continuation', tail: continuationTail(text), written: before, recovery: false },
    });
    let out: CallOutcome;
    try {
      out = await t.call(io, messages, `修稿续写第 ${rounds} 轮`, { separator: '\n\n', progress: { round: rounds, base: before } });
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal?.aborted) {
        throw err;
      }
      t.fail(`修稿续写第 ${rounds} 轮调用失败（${err instanceof Error ? err.message : String(err)}），修订稿不完整，没有出卡片。`);
    }
    const joined = joinContinuation(text, cleanOutput(out.text));
    stop = out.stop;
    if (countWords(joined.added) === 0) {
      t.note(`修稿续写第 ${rounds} 轮没有写出新的正文`);
      break;
    }
    text = joined.text;
    t.note(`修稿被输出上限截断，续写第 ${rounds} 轮：到 ${countWords(text)} 字`);
  }
  if (stop === 'maxTokens') {
    t.fail(
      `修稿被输出上限截断，续写 ${rounds} 轮仍没写完，没有出卡片——半截的修订稿覆盖上去比不改更糟。` +
        '已经收到的在气泡里；调大设置页的「最大输出 token」再试。'
    );
  }
  if (stop === 'other') {
    t.fail('模型因为别的原因停下了（常见的是内容审查），修订稿可能不完整，没有出卡片。');
  }
  const short = revisionShortfall(ctx.source, text, ctx.wordsPerChapter);
  if (short) {
    t.fail(short);
  }
  const words = countWords(text);
  t.note(`修订稿 ${words} 字（原稿 ${sourceWords} 字）`);
  return { raw: text, notes: t.notes, calls: t.calls, rounds, words };
}
