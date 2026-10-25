/**
 * 写前冲突检查的取数与调用（百章实验复盘）：本章细纲、前面定稿的连续性事实，调一次模型，校验交回来的
 * 冲突。判断规则、提示词与校验在 model/plotCheck.ts（纯函数）。
 *
 * 只在批量写章里跑（features/pipelineBatch.ts，预检之后、写之前）：批量没有人看着，细纲与既成事实
 * 对不上还往下写，就是百章实验里死了的人再死一次。对话页写一章时作者就在场。
 *
 * 零调用的情形：细纲是空的、细纲上记了 `factCheckOk: true`、前面没有定稿过的章、选不出相关的事实。
 *
 * 2026-10-25 起改成转写：比对的模型按格式写，转写模型（「转写」那一档，features/poolIO.ts 的 `poolTranscriber`）照抄成
 * `{"conflicts":[…]}`；只写了「无矛盾」的不转。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { isPlotFilled } from '../model/plotFile';
import {
  PLOT_CHECK_JSON_CONTRACT,
  PLOT_CHECK_SYSTEM,
  PlotConflict,
  looksLikePlotCheck,
  plotCheckUser,
  saysNoConflict,
  selectCheckFacts,
  verifyConflicts,
} from '../model/plotCheck';
import { ModelRunner } from './finalize';
import { jsonList } from './parse';
import { poolTranscriber } from './poolIO';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';

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

/** 冲突检查那一步的转写：合同、原来的解码（`conflicts` 数组），章号按对应关系填。 */
const PLOT_CHECK_TRANSCRIBE: TranscribeSpec<unknown[]> = {
  label: '写前冲突检查',
  contract: PLOT_CHECK_JSON_CONTRACT,
  decode: (json) => {
    const list = jsonList(json, 'conflicts');
    return list ? { ok: true, value: list } : { ok: false, message: '缺少 conflicts 数组' };
  },
  mapped: ['chapter'],
  looksLike: looksLikePlotCheck,
};

/**
 * 比对第 `no` 章的细纲与前面定稿的事实。写的那一次按格式写，转写模型照抄成 JSON；转写不合格重转 1 次（2026-10-25 起，
 * 替掉了从前「不是合格的 JSON 就带提醒重来 1 次」——JSON 的毛病现在归转写）。没按格式写、转写还不行就抛错——
 * 调用方把它当成「这一步没做成」记一句、照写（检查是额外的一道，不该因为它写不了章）。
 *
 * `transcribe` 缺省走「转写」那一档（没有可用模型时报错，同样当成没做成）。
 */
export async function checkPlotAgainstFacts(
  project: NovelProject,
  no: number,
  runner: ModelRunner,
  signal?: AbortSignal,
  transcribe: TranscribeCall = poolTranscriber(signal ?? new AbortController().signal)
): Promise<PlotCheckOutcome> {
  const plot = await project.getPlot(no);
  if (!plot || !isPlotFilled(plot.sections)) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '这一章还没有细纲' };
  }
  if (plot.factCheckOk) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '细纲上记了 factCheckOk，放行' };
  }
  const finalized = await project.finalizedFacts(no);
  const config = readConfig();
  const limits = contextLimitsOf(config);
  const facts = selectCheckFacts(
    finalized.map((f) => ({ no: f.no, title: f.title, statements: f.facts.map((x) => x.statement) })),
    plot.characters,
    { recent: limits.factsChapters, chars: limits.factsChars }
  );
  if (facts.length === 0) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '前面没有同步过、留下连续性事实的章' };
  }

  const text = [plot.sections.梗概, plot.sections.关键事件, plot.sections.看点].filter((s) => s.trim()).join('\n\n');
  const user = plotCheckUser({ no, title: plot.title, text }, facts);
  const options: StreamOptions = {
    maxOutputTokens: runner.primaryBudget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const messages = [
    { role: 'system' as const, content: PLOT_CHECK_SYSTEM },
    { role: 'user' as const, content: user },
  ];
  const raw = await runner.run(`第 ${no} 章 · 写前冲突检查`, (llm) => collectText(llm.stream(messages, options)));
  if (saysNoConflict(raw)) {
    return { calls: 1, conflicts: [], dropped: 0 };
  }
  const r = await transcribeJson(raw, PLOT_CHECK_TRANSCRIBE, (m, label) => transcribe(m, `第 ${no} 章 · ${label}`));
  const calls = 1 + r.calls;
  if (r.notes.length > 0) {
    log.info(`第 ${no} 章写前冲突检查：${r.notes.join('；')}`);
  }
  if (!r.ok) {
    const why = r.failed ? r.message : r.calls > 0 ? `转写没成：${r.message}` : r.message;
    throw Object.assign(new Error(`写前冲突检查的输出整理不出来（${why}）`), { calls });
  }
  const { conflicts, dropped } = verifyConflicts(r.value, text, facts);
  if (dropped > 0) {
    log.info(`第 ${no} 章写前冲突检查：${dropped} 处原文对不上，已丢弃`);
  }
  return { calls, conflicts, dropped };
}
