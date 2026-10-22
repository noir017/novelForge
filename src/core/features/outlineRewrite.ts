/**
 * 重写情节大纲（工程页「情节大纲」右键「重写…」）：**按 {@link OUTLINE_BATCH} 章一段一段重写**，
 * 不是一次把全书塞给模型——一次写一百章，后半段会稀得像目录（D20）。
 *
 * **只重写还没写正文的章**：情节大纲是各章细纲「梗概」的汇总，写过的章那一条由定稿照正文写（就是实际写成的样子），
 * 不再让模型照正文另整理一份（docs/design/plans/2026-10-22-outline-from-plots.md）。从前已写的那一截照定稿过的细纲
 * 整理（`derive`），删了。
 *
 * 作者写的那句要求每一段都带。每一段看得见前面几段**刚写好的新版**（`BuildRequest.outlineDraft`），
 * 区间之外还没轮到的条目仍是旧版。全部写完拼成一整份，**一次**审阅、一次写入（第 3 条；写入时按章号拆回各章细纲）；
 * 中途失败时已经重写的几段照样拿去审阅，没轮到的条目保留旧版——花过的钱不白扔，写不写由作者定。
 * 取消就什么都不写。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { mergeOutline, outlineCoverage } from '../model/outlineFile';
import { OUTLINE_BATCH } from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { describeError, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError, singleShotNotes } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { nextWritableChapterNo } from '../views/pipeline';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { poolIO } from './poolIO';

const log = scoped('重写大纲');

export interface OutlineRewriteBatch {
  from: number;
  to: number;
}

export interface OutlineRewritePlan {
  /** 大纲现在覆盖到第几章：重写到这里。 */
  end: number;
  /** 从第 1 章起连续有正文写到第几章（0 = 一章都没写）：这一截不重写。 */
  through: number;
  /** 空的 = 大纲排到的章都写过了，没有可重写的。 */
  batches: OutlineRewriteBatch[];
}

/** 分段：还没写正文的那一截（第 through+1 章到第 end 章）按 {@link OUTLINE_BATCH} 章切。纯函数。 */
export function planOutlineRewrite(end: number, through: number): OutlineRewritePlan {
  const batches: OutlineRewriteBatch[] = [];
  const cut = Math.min(Math.max(through, 0), end);
  for (let from = cut + 1; from <= end; from += OUTLINE_BATCH) {
    batches.push({ from, to: Math.min(end, from + OUTLINE_BATCH - 1) });
  }
  return { end, through: cut, batches };
}

/**
 * 大纲能不能分段重写：要有条目、能说出覆盖到第几章。还没有大纲（那是「生成」，主按钮管）返回 undefined，
 * 调用方退回整篇一次生成。排到的章都写过了，`batches` 是空的（调用方说一声，不调模型）。
 */
export async function outlineRewritePlan(project: NovelProject): Promise<OutlineRewritePlan | undefined> {
  const end = outlineCoverage(await project.readOutline());
  if (!(end > 0)) {
    return undefined;
  }
  return planOutlineRewrite(end, nextWritableChapterNo(await project.listChapters()) - 1);
}

/** 问要求那一框里的说明：分几段、调几次（第 4 条：动手之前写明次数）。 */
export function describeOutlineRewrite(plan: OutlineRewritePlan): string {
  const from = plan.batches[0]?.from ?? plan.through + 1;
  const kept = plan.through > 0 ? `${span(1, plan.through)}已经写了正文，那几条由定稿照正文写，不动。` : '';
  return (
    `按 ${OUTLINE_BATCH} 章一段重写${span(from, plan.end)}，调用 ${plan.batches.length} 次模型。${kept}` +
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
  log.info(`重写情节大纲${span(plan.batches[0]?.from ?? 1, plan.end)}，${plan.batches.length} 段`, describeTaskModels(config, 'plotOutline'));
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
          outlineRewriteFrom: plan.batches[0].from,
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
          const reached = outlineCoverage(artifact.text);
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
      const rewritten = span(plan.batches[0].from, plan.batches[done - 1].to);
      const r = await acceptArtifact(project, { kind: 'outline' }, { kind: 'outlineDoc', text: draft });
      if (r.skipped) {
        getHost().toast(`重写的大纲没有写入（调用 ${calls} 次）。`);
        return;
      }
      if (halt) {
        getHost().toast(`已重写${rewritten}的大纲，后面的保留旧版。${halt}。`, 'error');
        return;
      }
      getHost().toast(`情节大纲${span(plan.batches[0].from, plan.end)}已重写（调用 ${calls} 次）。`);
    },
    { scope: '重写大纲' }
  );
  return calls;
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}
