/**
 * 审稿链（五期）：一次调用出一份报告，出岔子时整份重来，最后校验引文、核对目标。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`review-chapter.command.ts` 的重试
 * （RV:288-367）：
 *
 * ```
 * 第一次调用（对话页流式）
 *   → 被输出上限截断：丢弃，整份重来 1 次（截断的那一半不可信，不续接）
 *   → 解不出来（不是 JSON、没有 items 数组）：丢弃，按合同重建 1 次
 *   → 仍不行：报错，不出报告
 *   → 校验引文、冻结的目标逐项核对（model/review.ts）
 * ```
 *
 * 最多 3 次（{@link REVIEW_CALLS}）。上游最坏 4 次：它的「截断重来」与「合同重建」各自还带一次续接。
 *
 * 与 structured.ts 那几条链同一个 {@link ChainIO}：重来的那一次照样流进同一个气泡，前面一行
 * 说清这一次在补什么；最后气泡换成给人读的那一份报告（`renderReport`），不留一段 JSON。
 */
import { REVIEW_CALLS } from '../model/pipeline';
import { FrozenGoal, ReviewReport, parseReviewJson, renderReport, verifyReview } from '../model/review';
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
  let parsed = parseReviewJson(out.text);
  if (!parsed.ok) {
    t.note(`审稿输出不合格（${parsed.reason}），已丢弃并按合同重建一次`);
    out = await t.call(
      io,
      await io.build({ step: { kind: 'reviewRetry', why: 'invalid', reason: parsed.reason } }),
      '审稿不合格，按合同重建'
    );
    parsed = out.stop === 'maxTokens' ? { ok: false, reason: '被输出上限截断' } : parseReviewJson(out.text);
    if (!parsed.ok) {
      t.fail(
        `两次都没有产出合格的审稿报告（${parsed.reason}），没有出报告。` +
          '这种情况多半是审稿输出被输出上限截断：调大设置页的「最大输出 token」再试。'
      );
    }
  }
  const { report, notes } = verifyReview(parsed.value, ctx);
  t.note(...notes);
  return { raw: renderReport(report), notes: t.notes, calls: t.calls, report };
}
