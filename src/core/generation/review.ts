/**
 * 审稿链（五期）：一次调用出一份报告，出岔子时整份重来，最后校验引文、核对目标。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`review-chapter.command.ts` 的重试
 * （RV:288-367）。2026-10-25 起改成转写：审稿模型按小标题写自然语言（引文用「」括出来），转写模型照抄成 JSON
 * （context/prompts.ts 的 `reviewJsonContract`，走法在 features/transcribe.ts）：
 *
 * ```
 * 第一次调用（对话页流式）
 *   → 被输出上限截断：丢弃，整份重来 1 次（截断的那一半不可信，不续接）
 *   → 转写成 JSON（不合格重转 1 次；模型自己给了 JSON 就不转）
 *   → 没按格式写、或转写没成：丢弃，按格式重写 1 次，照样转写
 *   → 仍不行：报错，不出报告（对话页的原文留在气泡里）
 *   → 校验引文、冻结的目标逐项核对（model/review.ts）
 * ```
 *
 * 最多 7 次（{@link REVIEW_CALLS}：审 3 次、转写 4 次）。转写调用本身失败（池里同档换完了人）不重写——换一份原文也转不了。
 *
 * 与 structured.ts 那几条链同一个 {@link ChainIO}：重来的那一次照样流进同一个气泡，前面一行
 * 说清这一次在补什么；转写只加一行；最后气泡换成给人读的那一份报告（`renderReport`），不留一段 JSON。
 */
import { reviewJsonContract } from '../context/prompts';
import { TranscribeResult, TranscribeSpec } from '../features/transcribe';
import { REVIEW_CALLS } from '../model/pipeline';
import { FrozenGoal, RawReview, ReviewReport, parseReviewJson, renderReport, verifyReview } from '../model/review';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';

export { REVIEW_CALLS };

export interface ReviewChainContext {
  /** 待审的那一章正文（去掉标题行）。引文在它里面找。 */
  text: string;
  goals: readonly FrozenGoal[];
  chapterNo: number;
  chapterTitle?: string;
  chapterRelPath: string;
  chapterHash: string;
}

export interface ReviewChainResult extends ChainResult {
  report: ReviewReport;
}

/** 审稿报告的样子：「总评」「目标核对」「### 问题」至少有一个。连这都没有的（「这一章写得挺好」）不花转写那一次，按不合格重写。 */
export function looksLikeReview(source: string): boolean {
  return /总评|目标核对|#\s*问题/u.test(source);
}

/** 审稿那一步的转写：合同、原来的解码，按对应关系填的键（维度、严重程度、目标编号、结论）不比原文。 */
const REVIEW_TRANSCRIBE: TranscribeSpec<RawReview> = {
  label: '审稿',
  contract: reviewJsonContract(),
  decode: (json) => {
    const p = parseReviewJson(json);
    return p.ok ? { ok: true, value: p.value } : { ok: false, message: p.reason };
  },
  mapped: ['category', 'severity', 'id', 'status'],
  looksLike: looksLikeReview,
};

export async function completeReview(first: CallOutcome, io: ChainIO, ctx: ReviewChainContext): Promise<ReviewChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('审稿输出被输出上限截断，截断的那一半不可信，已丢弃并整份重来一次');
    out = await t.call(io, await io.build({ step: { kind: 'reviewRetry', why: 'truncated' } }), '审稿被截断，整份重来');
    if (out.stop === 'maxTokens') {
      t.fail('审稿重来一次仍被输出上限截断，没有出报告。调大设置页的「最大输出 token」，或降低思考深度再试。');
    }
  }
  let parsed: TranscribeResult<RawReview> = await t.transcribeJson(io, out.text, REVIEW_TRANSCRIBE);
  if (!parsed.ok) {
    if (parsed.failed) {
      failTranscribe(t, parsed.message);
    }
    // 转写过还不合格：毛病多半在转写，但原文也可能写得乱；照原来解析失败的走法重写一次。告诉审稿模型的只是「整理不出来」——
    // 「这几处不是原文里的字」是说给转写模型的，审稿模型看了不知道改什么。
    t.note(
      parsed.calls > 0
        ? `审稿转写没成（${parsed.message}），已丢弃并重写一次`
        : `审稿输出不合格（${parsed.message}），已丢弃并按格式重写一次`
    );
    const reason = parsed.calls > 0 ? '整理不出一份报告' : parsed.message;
    out = await t.call(io, await io.build({ step: { kind: 'reviewRetry', why: 'invalid', reason } }), '审稿不合格，按格式重写');
    parsed =
      out.stop === 'maxTokens'
        ? { ok: false, message: '被输出上限截断', failed: false, calls: 0, notes: [] }
        : await t.transcribeJson(io, out.text, REVIEW_TRANSCRIBE);
    if (!parsed.ok) {
      if (parsed.failed) {
        failTranscribe(t, parsed.message);
      }
      const hint = /截断/.test(parsed.message) ? '这种情况多半是审稿输出被输出上限截断：调大设置页的「最大输出 token」再试。' : '';
      t.fail(`两次都没有产出合格的审稿报告（${parsed.message}），没有出报告。${hint}`);
    }
  }
  const { report, notes } = verifyReview(parsed.value, ctx);
  t.note(...notes);
  return { raw: renderReport(report), notes: t.notes, calls: t.calls, report };
}

/** 转写调用本身失败：不重写——换一份原文也转不了。对话页写好的原文留在气泡里（generation/generate.ts）。 */
function failTranscribe(t: Tally, message: string): never {
  t.fail(`审稿写好了，但${message}，没有出报告。稍后再审一次，或检查设置里「转写」那一档的模型。`);
}
