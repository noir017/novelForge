/**
 * 重写情节大纲（工程页「情节大纲」右键「重写…」）：**按 {@link OUTLINE_BATCH} 章一段一段重写**，
 * 不是一次把全书塞给模型——一次写一百章，后半段会稀得像目录（D20）。
 *
 * ```
 * 第 1–N 章已经写成   → 每段照那几章的摘要整理（与拆书补齐同一份契约，`derive`）
 * 第 N+1 章以后       → 每段照架构重新规划（平常的续写契约）
 * ```
 *
 * 作者写的那句要求每一段都带。每一段看得见前面几段**刚写好的新版**（`BuildRequest.outlineDraft`），
 * 区间之外还没轮到的节仍是旧版。全部写完拼成一整份，**一次**审阅、一次写入（第 3 条）；
 * 中途失败时已经重写的几段照样拿去审阅，没轮到的节保留旧版——花过的钱不白扔，写不写由作者定。
 * 取消就什么都不写。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { mergeOutline, outlineCoverage, parseOutlineRanges } from '../model/outlineFile';
import { OUTLINE_BATCH } from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { describeError, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError, singleShotNotes } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { nextWritableChapterNo } from '../views/pipeline';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { poolIO } from './pipelineBatch';

const log = scoped('重写大纲');

export interface OutlineRewriteBatch {
  from: number;
  to: number;
  /** 这一段已经写成：照摘要整理，不重新规划。 */
  derive: boolean;
}

export interface OutlineRewritePlan {
  /** 大纲现在覆盖到第几章：重写的就是第 1 章到这里。 */
  end: number;
  /** 从第 1 章起连续有正文写到第几章（0 = 一章都没写）。 */
  through: number;
  batches: OutlineRewriteBatch[];
}

/**
 * 分段：已写的那一截与没写的那一截各自按 {@link OUTLINE_BATCH} 章切，段不跨这条线——
 * 一段里不会一半照正文整理、一半重新规划。纯函数。
 */
export function planOutlineRewrite(end: number, through: number): OutlineRewritePlan {
  const batches: OutlineRewriteBatch[] = [];
  const cut = Math.min(Math.max(through, 0), end);
  for (let from = 1; from <= cut; from += OUTLINE_BATCH) {
    batches.push({ from, to: Math.min(cut, from + OUTLINE_BATCH - 1), derive: true });
  }
  for (let from = cut + 1; from <= end; from += OUTLINE_BATCH) {
    batches.push({ from, to: Math.min(end, from + OUTLINE_BATCH - 1), derive: false });
  }
  return { end, through: cut, batches };
}

/**
 * 磁盘上的大纲能不能分段重写：要有区间标题、能说出覆盖到第几章。没写过的大纲（那是「生成」，
 * 主按钮管）与散文式大纲（说不上哪一段是哪几章）返回 undefined，调用方退回整篇一次重写。
 */
export async function outlineRewritePlan(project: NovelProject): Promise<OutlineRewritePlan | undefined> {
  const end = outlineCoverage(await project.readOutline());
  if (!(end > 0) || !Number.isFinite(end)) {
    return undefined;
  }
  return planOutlineRewrite(end, nextWritableChapterNo(await project.listChapters()) - 1);
}

/** 问要求那一框里的说明：分几段、各怎么写、调几次（第 4 条：动手之前写明次数）。 */
export function describeOutlineRewrite(plan: OutlineRewritePlan): string {
  const parts: string[] = [];
  const derived = plan.batches.filter((b) => b.derive);
  const planned = plan.batches.filter((b) => !b.derive);
  if (derived.length > 0) {
    parts.push(`${span(1, plan.through)}已经写成，照各章摘要整理`);
  }
  if (planned.length > 0) {
    parts.push(`${span(planned[0].from, plan.end)}照架构重新规划`);
  }
  return (
    `按 ${OUTLINE_BATCH} 章一段重写${span(1, plan.end)}，调用 ${plan.batches.length} 次模型：${parts.join('，')}。` +
    '这句要求每一段都带；留空就照上游重来一遍。全部写完后先让你对比再写入。'
  );
}

/** 跑一遍。返回实际调了几次模型。 */
export async function rewriteOutline(project: NovelProject, plan: OutlineRewritePlan, ask: string): Promise<number> {
  const config = readConfig();
  const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，重写情节大纲中止');
    return 0;
  }
  log.info(`重写情节大纲${span(1, plan.end)}，${plan.batches.length} 段`, describeTaskModels(config, 'plotOutline'));
  let calls = 0;
  await runTask(
    '重写情节大纲',
    async ({ signal, report }) => {
      let draft = await project.readOutline();
      let done = 0;
      let halt: string | undefined;
      for (const batch of plan.batches) {
        const range = { from: batch.from, to: batch.to };
        const label = `情节大纲（${span(batch.from, batch.to)}）`;
        report({ message: span(batch.from, batch.to), current: done, total: plan.batches.length });
        const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
          action: { stage: 'outline', capability: 'generate' },
          target: { kind: 'outline' },
          range,
          ask,
          outlineDraft: draft,
          ...(batch.derive ? { derive: { through: plan.through } } : {}),
        };
        const io = poolIO(project, pool, config, signal, request);
        try {
          const first = await io.chain.call(await io.chain.build({}), label);
          const notes = singleShotNotes('outline', first.text, first.stop, range);
          if (notes.length > 0) {
            log.warn(`${label}：${notes.length} 条说明`, notes.join('\n'));
          }
          const artifact = parseArtifact(request.action, first.text, request.target, range);
          if (artifact.kind !== 'outlineDoc' || isArtifactEmpty(artifact)) {
            throw new Error('模型返回的大纲是空的');
          }
          const reached = parseOutlineRanges(artifact.text).reduce((max, r) => Math.max(max, r.to), 0);
          if (reached < batch.to) {
            throw new Error(`这一段只写到第 ${reached} 章（要到第 ${batch.to} 章）`);
          }
          draft = mergeOutline(draft, artifact.text, range);
          calls += io.calls();
          done++;
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`重写情节大纲被取消，${done}/${plan.batches.length} 段已写好，没有写入`);
            return;
          }
          halt = `${label}没写成（${describeError(err)}）`;
          log.error(`重写情节大纲：${halt}`, err instanceof ChainError ? err.notes.join('\n') : err);
          break;
        }
      }
      report({ message: '对比', current: done, total: plan.batches.length });
      if (done === 0) {
        getHost().toast(`${halt}，大纲没有改动。`, 'error');
        return;
      }
      const rewritten = span(1, plan.batches[done - 1].to);
      const r = await acceptArtifact(project, { kind: 'outline' }, { kind: 'outlineDoc', text: draft });
      if (r.skipped) {
        getHost().toast(`重写的大纲没有写入（调用 ${calls} 次）。`);
        return;
      }
      if (halt) {
        getHost().toast(`已重写${rewritten}的大纲，后面的保留旧版。${halt}。`, 'error');
        return;
      }
      getHost().toast(`情节大纲${span(1, plan.end)}已重写（调用 ${calls} 次）。`);
    },
    { scope: '重写大纲' }
  );
  return calls;
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}
