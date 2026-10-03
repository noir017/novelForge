/**
 * 写前冲突检查的取数与调用（百章实验复盘）：本章细纲、前面定稿的连续性事实，调一次模型，校验交回来的
 * 冲突。判断规则、提示词与校验在 model/plotCheck.ts（纯函数）。
 *
 * 只在批量写章里跑（features/pipelineBatch.ts，预检之后、写之前）：批量没有人看着，细纲与既成事实
 * 对不上还往下写，就是百章实验里死了的人再死一次。对话页写一章时作者就在场。
 *
 * 零调用的情形：细纲是空的、细纲上记了 `factCheckOk: true`、前面没有定稿过的章、选不出相关的事实。
 */
import { readConfig } from '../config';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { isPlotFilled } from '../model/plotFile';
import { PLOT_CHECK_SYSTEM, PlotConflict, plotCheckUser, selectCheckFacts, verifyConflicts } from '../model/plotCheck';
import { ModelRunner } from './finalize';
import { jsonList } from './threads';

const log = scoped('流水线');

export interface PlotCheckOutcome {
  /** 实际调了几次模型。 */
  calls: number;
  conflicts: PlotConflict[];
  /** 模型报了、但两句原文对不上而丢掉的几处。 */
  dropped: number;
  /** 没查的原因（零调用）。 */
  skipped?: string;
}

/**
 * 比对第 `no` 章的细纲与前面定稿的事实。解析不出合格的 JSON 时按合同重来 1 次；还不行就抛错——
 * 调用方把它当成「这一步没做成」记一句、照写（检查是额外的一道，不该因为它写不了章）。
 */
export async function checkPlotAgainstFacts(
  project: NovelProject,
  no: number,
  runner: ModelRunner,
  signal?: AbortSignal
): Promise<PlotCheckOutcome> {
  const plot = await project.getPlot(no);
  if (!plot || !isPlotFilled(plot.sections)) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '这一章还没有细纲' };
  }
  if (plot.factCheckOk) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '细纲上记了 factCheckOk，放行' };
  }
  const finalized = await project.finalizedFacts(no);
  const facts = selectCheckFacts(
    finalized.map((f) => ({ no: f.no, title: f.title, statements: f.facts.map((x) => x.statement) })),
    plot.characters
  );
  if (facts.length === 0) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '前面没有定稿过、留下连续性事实的章' };
  }

  const text = [plot.sections.本章目的, plot.sections.关键事件, plot.sections.章末钩子].filter((s) => s.trim()).join('\n\n');
  const user = plotCheckUser({ no, title: plot.title, text }, facts);
  const config = readConfig();
  const options: StreamOptions = {
    maxOutputTokens: runner.primaryBudget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const messages = [
      { role: 'system' as const, content: PLOT_CHECK_SYSTEM },
      { role: 'user' as const, content: attempt === 0 ? user : `${user}\n\n上一次的输出不是合格的 JSON。只输出 {"conflicts":[…]}，不要别的文字。` },
    ];
    const raw = await runner.run(`第 ${no} 章 · 写前冲突检查`, (llm) => collectText(llm.stream(messages, options)));
    const list = jsonList(raw, 'conflicts');
    if (!list) {
      continue;
    }
    const { conflicts, dropped } = verifyConflicts(list, text, facts);
    if (dropped > 0) {
      log.info(`第 ${no} 章写前冲突检查：${dropped} 处原文对不上，已丢弃`);
    }
    return { calls, conflicts, dropped };
  }
  throw Object.assign(new Error('写前冲突检查的输出解析不出来'), { calls });
}
