/**
 * 删修饰：写完正文之后的一轮「只许删」修稿（续写链最后一步，对话页与批量写章同一条）。
 *
 * - 用写这一章的同一个模型，不经装配器，只给删减规矩与编好号的正文（`context/prompts.ts` 的
 *   `trimMessages`）。
 * - 逐段验收（`model/trimProse.ts`）：加了字、动了对白、删得太狠、改了段尾的段退回原文，其余照用。
 * - 删完不到八成就从删得最多的段开始退回，主按钮不会因为这一轮转去推「接着写」。
 * - **失败不连累正文**：调用失败、被截断、一段都没交回来，都保留删之前那一版，记一条说明。
 * - 不流进气泡：模型交回来的是带编号的一段段文字，作者看着它只会以为正文写坏了。气泡里先加
 *   一行「——删修饰——」说明在干什么，完了退回成删后的正文。
 */
import { CancelledError } from '../llm/provider';
import { countWords } from '../model/fs';
import { TRIM_MIN_CHARS, applyTrim, numberParagraphs, parseNumbered, trimParagraphs } from '../model/trimProse';
import { trimMessages } from '../context/prompts';
import { describeError } from '../runtime/logger';
import { ChainIO, Tally } from './structured';

/** 删修饰用的温度：删减不需要发挥。 */
const TRIM_TEMPERATURE = 0.3;

export interface TrimResult {
  /** 删完的正文；没删成时就是传进来的那份。 */
  text: string;
  /** 真删了字时才有：删之前那一版（落盘前的合并视图拿它与删后那版逐段对照）。 */
  untrimmed?: string;
}

/**
 * 删 `text` 里的修饰。`floor` 是删完之后 `text` 至少要剩多少字（调用方按目标字数的八成减去本章
 * 已有的算好）；缺席就不保底。
 */
export async function trimModifiers(
  io: ChainIO,
  t: Tally,
  text: string,
  opts: { floor?: number; signal?: AbortSignal } = {}
): Promise<TrimResult> {
  const source = text.trim();
  if (countWords(source) < TRIM_MIN_CHARS) {
    return { text };
  }
  const paragraphs = trimParagraphs(source);
  let output: string;
  try {
    const out = await t.call(io, trimMessages(numberParagraphs(paragraphs)), '删修饰', {
      quiet: true,
      temperature: TRIM_TEMPERATURE,
    });
    if (out.stop === 'maxTokens') {
      io.reset?.(text);
      t.note('删修饰被输出上限截断，没有采用，正文保持删之前的样子');
      return { text };
    }
    output = out.text;
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    io.reset?.(text);
    t.note(`删修饰调用失败（${describeError(err)}），正文保持删之前的样子`);
    return { text };
  }

  const trimmed = applyTrim(paragraphs, parseNumbered(output, paragraphs.length), {
    floor: opts.floor,
    countWords,
  });
  const before = countWords(source);
  const after = countWords(trimmed.text);
  const rejected = [...trimmed.rejected].map(([why, n]) => `${why} ${n} 段`).join('、');
  if (trimmed.changed === 0) {
    io.reset?.(text);
    t.note(
      trimmed.restored > 0
        ? '删修饰删完不到目标的八成，删改全部退回，正文保持原样'
        : `删修饰没有删掉什么${rejected ? `（退回原文：${rejected}）` : ''}，正文保持原样`
    );
    return { text };
  }
  io.reset?.(trimmed.text);
  t.note(
    `删修饰：${paragraphs.length} 段里删了 ${trimmed.changed} 段，${before} → ${after} 字（删掉 ${Math.round((100 * (before - after)) / before)}%）` +
      `${rejected ? `；退回原文：${rejected}` : ''}` +
      `${trimmed.restored > 0 ? `；删完不到目标的八成，又退回删得最多的 ${trimmed.restored} 段` : ''}`
  );
  return { text: trimmed.text, untrimmed: source };
}
