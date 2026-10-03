/**
 * 工程页的流水线批量动作：**补齐故事架构、一次拆几十章细纲、一章一章写正文**。
 *
 * 三个动作都**严格串行**、**一件失败就停**，已经写好的留着：
 *
 * - 补齐设定：前提要照着配置写，世界观要照着前提与角色写。
 * - 批量拆细纲：后一批要接着前一批往下排（前序细纲一览）。
 * - 批量写章（四期，D10）：后一章接着前一章的结尾写，写完即定稿时还要读前一章更新过的
 *   角色状态与证据原文。
 *
 * 补齐设定与拆细纲走 generation/structured.ts 的生成链，写章走 generation/continuation.ts
 * 的续写链——与对话页同一份，截断拆半、语法修复、自动续写、重演检测一样不少。
 *
 * 结构与 `syncSummaries` 对齐（runTask + recordFailure + 分档确认框），因为作者对这类批量
 * 动作已经有了预期：先说清要调几次模型、用哪一档，跑起来能看进度、能取消，失败的挂在那一行上
 * 第二天还看得见。
 *
 * ## 只补不改
 *
 * 三个批量动作都**跳过已经有产物的章**，不问、不覆盖。批量路径上没有「逐个审阅」的余地——
 * 一次弹几十个 diff 没有人看得完——所以唯一安全的做法是只处理空白的那些。要重做某一章，去
 * 创作页单独重做。
 *
 * ## 返回值是「这一次实际调了几次模型」
 *
 * 自动修复与自动续写让实际次数在跑完之前说不准：确认框里报的是区间与上限（同一个纯函数算的，
 * 见 model/pipeline.ts 的 `planPlotBatches` / `planWriteBatch` / `CallEstimate`），返回的是实际数。
 * 用户取消、没有可做的、没有可用模型时是 0。**只在这里算**：agent 的 `run` 工具拿它记进预算。
 * 让调用方各算一遍，弹窗写着 7 次、账上记 1 次，正是第 4 条要防的事。
 */
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { collect } from '../llm/collect';
import { AgentMessage, CancelledError, LlmProvider, StopSignal } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled } from '../model/plotFile';
import { isOutlineFilled } from '../model/outlineFile';
import { buildBookFacts, chapterTargetOf, plotContentHash } from '../views/pipeline';
import { describeTaskModels } from '../model/tiers';
import { BuildRequest, buildContext } from '../context/builder';
import { runTask } from '../runtime/progress';
import { countWords } from '../model/fs';
import { describeFinalize, finalizeChapter } from './finalize';
import { createCastCards, planCastCards } from './characterCard';
import { checkPlotAgainstFacts } from './plotCheck';
import { planThreads } from './threads';
import { updateGlobalSummary } from './summarize';
import { PLOT_CHECK_SUGGESTION, describeConflict } from '../model/plotCheck';
import { PREFLIGHT_SUGGESTION, PreflightRisk, describeExempted, describeRisks, preflightChapter, riskKey } from './preflight';
import { isArtifactEmpty, parseArtifact } from './artifact';
import {
  CONFIG_CALLS,
  CallEstimate,
  GLOBAL_SUMMARY_EVERY,
  ONE_CALL,
  PLOT_BATCH,
  SETTING_DOCS,
  SETTING_DOC_LABEL,
  SettingDoc,
  WRITE_BATCH_DEFAULT,
  WriteBatchMode,
  addCalls,
  commandOf,
  describeCalls,
  planPlotBatches,
  planWriteBatch,
  rosterCalls,
} from '../model/pipeline';
import { Workspace } from '../workspace';
import { acceptArtifact, acceptPlotBatch } from '../generation/accept';
import { CallOutcome, ChainError, ChainIO, completeBlueprints, completeConfig, completeRoster } from '../generation/structured';
import { ManuscriptChainResult, WriteProgress, completeManuscript } from '../generation/continuation';
import { planReview, planWriting } from '../generation/generate';
import { completeReview } from '../generation/review';
import { ReviewReport, describeReport, renderReport } from '../model/review';
import { ChatSession, SessionStore, makeTurnId, nowIso } from '../model/session';

const log = scoped('流水线');

/** 没有写总章数、每章字数时，补齐设定按这个规模展开配置（与一句话弹窗的默认值一致）。 */
const DEFAULT_SETUP = { totalChapters: 100, wordsPerChapter: 3000 };

/**
 * 批量拆细纲：`range` 里还没有细纲的章，按 {@link PLOT_BATCH} 章一批、**严格串行**地拆。
 *
 * - 缺省区间是「下一可写章起 5 章」，不越过大纲的覆盖与总章数。
 * - 已经排过的章一律跳过（第 19 条批量那一面：不问、不覆盖），跳过的章把区间断开。
 * - 每批写完就落盘，后一批的装配读得到它（前序细纲一览）；一批失败就停——后一批要
 *   接着它往下排，接不上的细纲比没有更糟。失败挂在那一批第一章的细纲上（第 16 条）。
 * - 新角色照样建卡（D19）。
 *
 * `confirmed`：工程页弹窗已经把切分与调用次数写给作者看过了（同一个 `planPlotBatches`），
 * 不再弹第二个确认框。agent 的 `run` 那条路不带它，照旧先问。
 */
export async function generatePlots(
  project: NovelProject,
  opts: { range?: { from: number; to: number }; confirmed?: boolean } = {}
): Promise<number> {
  const outline = await project.readOutline();
  if (!isOutlineFilled(outline)) {
    // 没有大纲就写细纲，等于让模型凭空编四十章——那不是作者要的。
    log.warn('情节大纲是空的，批量拆细纲已中止');
    getHost().toast('情节大纲还是空的。先写一份大纲，细纲才有依据。', 'error');
    return 0;
  }
  const facts = await buildBookFacts(project);
  const cap = Math.min(facts.outlineCoverage, facts.totalChapters ?? Infinity);
  const from = Math.max(1, opts.range?.from ?? facts.nextChapterNo);
  const to = Math.min(opts.range?.to ?? from + PLOT_BATCH - 1, cap);
  if (to < from) {
    getHost().toast(
      Number.isFinite(facts.outlineCoverage) && from > facts.outlineCoverage
        ? `情节大纲只覆盖到第 ${facts.outlineCoverage} 章。先续写大纲，再拆第 ${from} 章以后的细纲。`
        : `第 ${from} 章已经超出总章数。`,
      'error'
    );
    return 0;
  }
  const plan = planPlotBatches({ from, to, filledNos: facts.plotFilledNos });
  const where = plan.from === plan.to ? `第 ${plan.from} 章` : `第 ${plan.from}–${plan.to} 章`;
  if (plan.batches.length === 0) {
    getHost().toast(`${where}都已经排过细纲了。`);
    return 0;
  }

  const config = readConfig();
  if (!opts.confirmed) {
    const pick = await getHost().confirm(
      `${where}：要拆 ${plan.chapters.length} 章细纲，分 ${plan.batches.length} 批，${describeCalls(plan.calls)}。现在拆？`,
      ['开始拆细纲'],
      {
        modal: true,
        detail:
          `${describeTaskModels(config, 'plotOutline')}\n` +
          (plan.skipped.length > 0 ? `已经排过的第 ${plan.skipped.join('、')} 章跳过，不会被改动。\n` : '') +
          '每批写完就落盘，后一批接着前一批往下排；一批失败就停，已经写好的留着。拆完再从细纲排一次叙事线（只追加新线）。\n' +
          '输出被截断或格式不对时会自动拆小重试，所以给的是上限。',
      }
    );
    if (pick !== '开始拆细纲') {
      log.info('用户取消了批量拆细纲');
      return 0;
    }
  }

  const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，批量拆细纲中止');
    return 0;
  }
  const ws = new Workspace(project);
  let calls = 0;
  await runTask(
    '批量拆细纲',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let done = 0;
      for (let i = 0; i < plan.batches.length; i++) {
        const batch = plan.batches[i];
        const span = rangeLabel(batch[0], batch[batch.length - 1]);
        report({ message: `${span}（第 ${i + 1}/${plan.batches.length} 批）`, current: done, total: plan.chapters.length });
        const r = await runPlotBatch(project, ws, pool, config, signal, batch);
        calls += r.calls;
        if (r.ok) {
          done += batch.length;
        } else {
          if (r.cancelled) {
            log.warn(`批量拆细纲被取消，已完成 ${done}/${plan.chapters.length} 章`);
            return;
          }
          const reason = r.reason;
          getHost().toast(
            `${span}的细纲没拆成（${reason}）。${done > 0 ? `前面 ${done} 章已经写好。` : ''}后面的批次已停下。`,
            'error'
          );
          return;
        }
      }
      // 拆完接着从细纲排一次叙事线：伏笔有人记着，定稿时才判得出推进了哪几条（百章实验里叙事线一直是空的）。
      report({ message: '排叙事线', current: done, total: plan.chapters.length });
      const th = await planThreads(project, pool, signal);
      calls += th.calls;
      if (th.cancelled) {
        return;
      }
      report({ message: '收尾', current: done, total: plan.chapters.length });
      log.info(`批量拆细纲结束：${done} 章`, `调用 ${calls} 次，总耗时 ${elapsed(startedAt)}`);
      const threads = th.error ? `；叙事线没排成（${th.error}）` : th.added.length > 0 ? `；新排出 ${th.added.length} 条叙事线` : '';
      getHost().toast(`已为${where}写好 ${done} 章细纲${plan.skipped.length > 0 ? `（跳过已有的 ${plan.skipped.length} 章）` : ''}${threads}。`);
    },
    { scope: '流水线' }
  );
  return calls;
}

/**
 * 补齐故事架构：配置 → 前提 → 角色图谱 → 世界观，**只补空白、严格串行**（D21）。
 *
 * - 小说配置只在「一句话」那一节写了东西时才能补——没有脑洞可展开，这一步就是凭空编；
 *   规模缺省按一句话弹窗的默认值（100 章 × 3000 字），确认框里写明。
 * - 角色图谱只在一张卡都没有时生成（有卡就算填过，见 `settingFilled`）。
 * - 一件失败就停：后面几件都吃它的产出。
 *
 * 走分档池的 `setting` 档，不带思考深度（第 26 条：工程页的批量任务一律不带）。
 */
export async function completeSettings(project: NovelProject): Promise<number> {
  const facts = await buildBookFacts(project);
  const missing = SETTING_DOCS.filter((doc) => !facts.settings[doc]);
  if (missing.length === 0) {
    getHost().toast('故事架构四件都已经有了。');
    return 0;
  }
  const book = await project.readBookConfig();
  const idea = book.sections.一句话.trim();
  if (missing.includes('config') && !idea) {
    getHost().toast('小说配置还没写，也没有「一句话」可以展开。先点「生成小说配置」写下你的脑洞。', 'error');
    return 0;
  }
  const setup = {
    totalChapters: book.totalChapters ?? DEFAULT_SETUP.totalChapters,
    wordsPerChapter: book.wordsPerChapter ?? DEFAULT_SETUP.wordsPerChapter,
  };
  const estimate = missing
    .map((doc): CallEstimate => (doc === 'config' ? CONFIG_CALLS : doc === 'characters' ? rosterCalls() : ONE_CALL))
    .reduce(addCalls);
  const labels = missing.map((doc) => SETTING_DOC_LABEL[doc]);

  const config = readConfig();
  const pick = await getHost().confirm(
    `要补齐${labels.join('、')}，${describeCalls(estimate)}。现在补？`,
    ['开始补齐'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'setting')}\n` +
        '按 配置 → 前提 → 角色图谱 → 世界观 的顺序一件一件来，每件都吃前面几件的产出；已经有的不会被改动。一件失败就停。' +
        (missing.includes('config') && (!book.totalChapters || !book.wordsPerChapter)
          ? `\n小说配置里没写总章数或每章字数，按 ${setup.totalChapters} 章 × ${setup.wordsPerChapter} 字展开。`
          : ''),
    }
  );
  if (pick !== '开始补齐') {
    log.info('用户取消了补齐设定');
    return 0;
  }
  const pool = await createModelPool({ task: 'setting', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，补齐设定中止');
    return 0;
  }

  let calls = 0;
  await runTask(
    '补齐设定',
    async ({ signal, report }) => {
      for (let i = 0; i < missing.length; i++) {
        const doc = missing[i];
        const label = SETTING_DOC_LABEL[doc];
        report({ message: label, current: i, total: missing.length });
        const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
          action: { stage: 'setting', capability: 'generate' },
          target: { kind: 'setting', doc },
          ask: doc === 'config' ? idea : '',
          ...(doc === 'config' ? { setup } : {}),
        };
        const io = poolIO(project, pool, config, signal, request);
        try {
          const raw = await settingRaw(project, doc, request, io, idea, setup);
          const artifact = parseArtifact(request.action, raw, request.target);
          if (isArtifactEmpty(artifact)) {
            throw new Error('模型返回的内容里解析不出这一件');
          }
          const r = await acceptArtifact(project, request.target, artifact, { onlyBlank: true });
          log.info(`${label}已补上`, r.message);
          void clearFailures(project, 'setting', settingKey(project, doc), 'setting');
          calls += io.calls();
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`补齐设定被取消，停在${label}`);
            return;
          }
          const reason = describeError(err);
          log.error(`补齐设定：${label}失败：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
          // 挂在「故事架构」那一行上（第 16 条）：toast 五秒就没了。
          void recordFailure(project, {
            scope: '流水线',
            targetKind: 'setting',
            targetKey: settingKey(project, doc),
            severity: 'error',
            op: 'setting',
            message: `${label}生成失败：${reason}`,
            detail: '补齐设定停在这一件。后面几件依赖它，没有继续。',
          });
          getHost().toast(`${label}没补上（${reason}）。后面几件依赖它，已经停下。`, 'error');
          return;
        }
      }
      report({ message: '收尾', current: missing.length, total: missing.length });
      getHost().toast(`已补齐${labels.join('、')}。`);
    },
    { scope: '流水线' }
  );
  return calls;
}

/** 故事架构那一行的失败记在哪：它的文件（角色图谱是角色目录）。与工程页那一行的 `relPath` 一致。 */
export function settingKey(project: NovelProject, doc: SettingDoc): string {
  return project.relPath(project.settingPath(doc));
}

/** 补齐设定的一件：第一次调用，配置与角色图谱再接上各自的链。从已写正文补齐（features/derive.ts）也走它。 */
export async function settingRaw(
  project: NovelProject,
  doc: SettingDoc,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  io: ReturnType<typeof poolIO>,
  idea: string,
  setup: { totalChapters: number; wordsPerChapter: number }
): Promise<string> {
  const messages = await io.chain.build({});
  const first = await io.chain.call(messages, SETTING_DOC_LABEL[doc]);
  const chain = { ...io.chain, messages };
  if (doc === 'config') {
    return (await completeConfig(first, chain, { existing: await project.readBookConfig(), idea, setup })).raw;
  }
  if (doc === 'characters') {
    return (await completeRoster(first, chain)).raw;
  }
  void request;
  return first.text.trim();
}

/**
 * 批量那条路的 {@link ChainIO}：每次调用走分档池（失败换同档其余，第 12 条），
 * 装配用干活那个模型的窗口（第 13 条：`pool.primaryBudget`），不带思考深度（第 26 条）。
 */
/** {@link runPlotBatch} 从已写正文整理时要的东西：写到第几章、每章的实际字数与标题（按章号）。 */
export interface PlotBatchDerive {
  through: number;
  targetWords: ReadonlyMap<number, number>;
  titles: ReadonlyMap<number, string>;
}

/**
 * 拆一批细纲：生成链（截断拆半、语法修复、漏章 fail-closed）→ 只补空白地落盘。批量拆细纲与批量写章
 * 「边写边拆」共用。**不抛**：失败挂在这一批第一章的细纲上（第 16 条），由调用方决定停不停；取消单列。
 *
 * `derive`：从已写正文整理（拆书 A，features/derive.ts）。装配带上这几章的正文，契约换成「照正文提取」；
 * 标题用章节自己的（作者起的名字，模型改了不算），目标字数记那一章的实际字数，不建新卡。
 */
export async function runPlotBatch(
  project: NovelProject,
  ws: Workspace,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  batch: readonly number[],
  derive?: PlotBatchDerive
): Promise<{ ok: true; calls: number } | { ok: false; calls: number; cancelled: boolean; reason: string }> {
  const range = { from: batch[0], to: batch[batch.length - 1] };
  const span = rangeLabel(range.from, range.to);
  const target = { kind: 'plot' as const, plotRelPath: (await project.getPlot(range.from))?.relPath ?? project.plotPathForNo(range.from, '') };
  const io = poolIO(project, pool, config, signal, {
    action: { stage: 'plot', capability: 'generate' },
    target,
    targetNo: range.from,
    range,
    ask: '',
    ...(derive ? { derive: { through: derive.through } } : {}),
  });
  try {
    const result = await completeBlueprints(undefined, io.chain, [...batch]);
    if (result.notes.length > 0) {
      log.warn(`${span}：${result.notes.length} 处降级`, result.notes.join('\n'));
    }
    const items = derive
      ? result.items.map((item) => ({ ...item, title: derive.titles.get(item.no) || item.title, newCharacters: [] }))
      : result.items;
    const r = await acceptPlotBatch(project, ws, items, range, {
      onlyBlank: true,
      ...(derive ? { targetWords: derive.targetWords, newCards: false } : {}),
    });
    log.info(`${span}的细纲已落盘`, r.message);
    void clearFailures(project, 'plot', target.plotRelPath, 'plotOutline');
    return { ok: true, calls: result.calls };
  } catch (err) {
    const calls = err instanceof ChainError ? err.calls : io.calls();
    if (err instanceof CancelledError || signal.aborted) {
      return { ok: false, calls, cancelled: true, reason: '已取消' };
    }
    const reason = describeError(err);
    log.error(`${span}的细纲失败：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
    await recordFailure(project, {
      scope: '流水线',
      targetKind: 'plot',
      targetKey: target.plotRelPath,
      severity: 'error',
      op: 'plotOutline',
      message: `细纲生成失败：${reason}`,
      detail: `${span}这一批没有写入。后面的批次依赖它，已经停下。`,
    });
    return { ok: false, calls, cancelled: false, reason };
  }
}

export function poolIO(
  project: NovelProject,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  base: Omit<BuildRequest, 'providerMaxInputTokens'>
): { chain: ChainIO; calls: () => number } {
  let count = 0;
  const budgeted = { ...config, ...pool.primaryBudget };
  const chain: ChainIO = {
    messages: [],
    build: async (patch) => (await buildContext(project, { ...base, ...patch }, budgeted)).messages,
    call: async (messages, label): Promise<CallOutcome> => {
      count++;
      const r = await pool.run(label, (llm) =>
        collect(
          llm.stream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      return { text: r.text, stop: r.stopReason };
    },
  };
  return { chain, calls: () => count };
}

/** 两种模式在确认框与完成提示里的说法。 */
const MODE_LABEL: Record<WriteBatchMode, string> = {
  draft: '只写正文',
  finalize: '写完即定稿',
};

/**
 * 批量写章（D10）：区间里还没有正文的章，**严格串行**地一章一章写。
 *
 * ```
 * for 每一章：
 *   写（续写链，与对话页同一个 completeManuscript；一章之内续写那几轮钉住同一个模型）
 *   → 新建 chapters/NNN-标题.md、记 writtenFrom
 *   → 写完即审稿：审一遍，报告进「批量审稿」那个会话（五期补遗 §4）
 *   → 写完即定稿：定稿（摘要 + 角色状态，features/finalize.ts）
 *   → 作者点过「写完这一章就停」：停
 * ```
 *
 * - **为什么串行**：后一章要接前一章的结尾写（上一章结尾、重演检测），写完即定稿时还要读前一章
 *   更新过的角色状态与证据原文。并发写出来的几章彼此接不上。所以不看并发设置。
 * - **只补空白**（第 19 条）：已有正文的章跳过；区间里第一章没有细纲的就在它前面收住
 *   （`planWriteBatch`，前端弹窗与这里的确认框同源）。
 * - **失败即停**：写不出来（调用失败、思考吃光、空正文）或定稿的摘要失败——停，红 ❗ 挂在
 *   那一章上，已经写好的留着。
 * - **写出来但不能往下接的也停**：重演命中（开头把上一章最后一场又演了一遍）、后面几章才登场的人
 *   提前写了进来（五期补遗 §1.2：下一章要从他「第一次露面」写起）、最后仍不到目标的八成。这几种照样
 *   落盘（新章，没有东西可吞；钱已经花了，D6），不定稿，黄 ❗ 挂在那一章上写明原因。对话页那边有卡片
 *   让作者当场判断；批量没有人看，接着往下写等于让后面几章踩在一个有问题的结尾上。上游前后两种直接
 *   作废整章（GD:1130-1186）。
 * - **停止**（中断）：正在写的那一章不落盘。**写完这一章就停**：这一章照常写完、落盘、（定稿），然后收。
 * - 模型走 `manuscript` 档（第 12 条：失败换同档其余），不带思考深度（第 26 条）；定稿两步各走
 *   `plotSummary` / `characterCard` 档。
 * - **写完即审稿**（五期补遗 §4 ⚑）：顺序是写 → 审 → 定稿——审稿对照的是「截至上一章」的角色状态与
 *   连续性事实，先定稿的话本章刚写下的事会被当成前文拿来对照它自己。报告一章一轮放进新会话
 *   「批量审稿 · 第 a–b 章」，每审完一章落盘一次；作者打开它在报告卡上逐章勾选、修稿（走对话页那条路）。
 *   **审出问题不停**（要人勾了才修，批量停下也没人勾），**审稿失败也不停**（后面几章不靠这份报告往下写），
 *   都在完成提示里说清。走 `review` 档。写进去但要停下的那一章（重演、提前登场、没写够）照样审完再停。
 *
 * `confirmed`：工程页弹窗已经把切分与调用次数写给作者看过了，不再弹第二个确认框。agent 的
 * `run` 那条路不带它，照旧先问。返回实际调了几次模型（取消、无事可做、没有模型时是 0）。
 */
/** 批量写章开跑前补建角色卡：摘要里至少出场这么多章的人。 */
export const CAST_CARD_MIN_APPEARANCES = 2;

export async function writeManuscripts(
  project: NovelProject,
  opts: { range?: { from: number; to: number }; mode?: WriteBatchMode; review?: boolean; confirmed?: boolean } = {}
): Promise<number> {
  const [facts, chapters, manifest] = await Promise.all([buildBookFacts(project), project.listChapters(), project.readManifest()]);
  const mode = opts.mode ?? 'draft';
  const reviewing = opts.review === true;
  const from = Math.max(1, opts.range?.from ?? facts.nextChapterNo);
  const to = Math.max(from, opts.range?.to ?? from + WRITE_BATCH_DEFAULT - 1);
  const plan = planWriteBatch({
    from,
    to,
    mode,
    review: reviewing,
    writtenNos: chapters.filter((c) => c.wordCount > 0).map((c) => c.order),
    plotFilledNos: facts.plotFilledNos,
    outlineCoverage: Math.min(facts.outlineCoverage, facts.totalChapters ?? Infinity),
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
  });
  const where = rangeLabel(plan.from, plan.to);
  if (plan.chapters.length === 0) {
    getHost().toast(
      plan.stopAt !== undefined
        ? `第 ${plan.stopAt} 章还没有细纲，情节大纲也没覆盖到它。先续写大纲，再写正文。`
        : `${where}都已经写过正文了。`,
      plan.stopAt !== undefined ? 'error' : 'info'
    );
    return 0;
  }
  const writing = rangeLabel(plan.chapters[0], plan.chapters[plan.chapters.length - 1]);

  // 一致性预检（五期，零调用）：开跑之前把要写的几章一起查一遍，有就先问一句。作者说「仅本次
  // 忽略」的那几处记下来，跑的中途不再为它们停；中途新冒出来的（前面刚定稿的一章把某人写死了）
  // 在那一章前面停下——批量没有人看着，接着写就是明知有矛盾还往下写。
  const ignored = new Set<string>();
  const found: [number, PreflightRisk[]][] = [];
  for (const no of plan.chapters) {
    const { risks, exempted } = await preflightChapter(project, no);
    if (risks.length > 0) {
      found.push([no, risks]);
    }
    if (exempted.length > 0) {
      log.info(`第 ${no} 章：${exempted.map(describeExempted).join('；')}`);
    }
  }
  if (found.length > 0) {
    const lines = found.flatMap(([no, risks]) => describeRisks(no, risks, true));
    log.warn(`批量写章之前的一致性预检：${lines.length} 处`, lines.join('\n'));
    const pick = await getHost().confirm(
      `一致性预检：${writing}里有 ${lines.length} 处要留意（这一步没有调用模型）。仍要写？`,
      ['仅本次忽略，照写'],
      {
        modal: true,
        detail: [
          ...lines,
          PREFLIGHT_SUGGESTION,
          '要永久放行某一处：在对话页写那一章时选「记为刻意安排」，或在那一章细纲的 frontmatter 里加一行 preflightOk。',
        ].join('\n'),
      }
    );
    if (pick !== '仅本次忽略，照写') {
      log.info('一致性预检有问题，作者没有开始批量写章');
      return 0;
    }
    for (const [no, risks] of found) {
      risks.forEach((r) => ignored.add(riskKey(no, r)));
    }
  }

  // 开写之前补建角色卡：已经在摘要里出场两章以上、还没有卡的人。没有卡就没有「当前状态」可维护，
  // 定稿时不更新、预检也只能靠定稿事实认人（百章实验里 13 张卡有 8 张是写完才建的）。
  const castCards = await planCastCards(project, { minAppearances: CAST_CARD_MIN_APPEARANCES });
  const cardCalls: CallEstimate = { low: castCards.calls, high: castCards.calls, max: castCards.calls };
  const totalCalls = castCards.calls > 0 ? addCalls(plan.calls, cardCalls) : plan.calls;
  const config = readConfig();
  // 前端弹窗算不出补卡那几次（要读摘要），所以有卡要补时照样再问一次（第 4 条）。
  if (!opts.confirmed || castCards.calls > 0) {
    const pick = await getHost().confirm(
      `${writing}：要写 ${plan.chapters.length} 章正文（${MODE_LABEL[mode]}${reviewing ? '、写完即审稿' : ''}），${describeCalls(totalCalls)}。现在写？`,
      ['开始写章'],
      {
        modal: true,
        detail: [
          describeTaskModels(config, 'manuscript'),
          reviewing ? describeTaskModels(config, 'review') : '',
          describeTaskModels(config, 'plotSummary'),
          plan.plotBatches.length > 0 ? describeTaskModels(config, 'plotOutline') : '',
          castCards.plans.length > 0
            ? `开写之前先给${castCards.plans.map((p) => p.member.name).join('、')}建角色卡（摘要里已经出场 ${CAST_CARD_MIN_APPEARANCES} 章以上、还没有卡；${castCards.calls} 次调用，算在上面的数里）。`
            : '',
          '一章一章串行写：后一章接着前一章的结尾写。没写够时自动续写（算在上限里）。',
          plan.plotBatches.length > 0
            ? `${plan.plotBatches.map((b) => rangeLabel(b[0], b[b.length - 1])).join('、')}还没有细纲：写到时先按情节大纲拆这一批，拆的时候看得见前面已经定稿的事实。`
            : '',
          '每章写之前先比对一次细纲与前面定稿的连续性事实（前面没定稿过的章就不调）；对不上就停在那一章前面。',
          reviewing ? '每写完一章先审一遍，报告放进一个新会话「批量审稿」，在对话页逐章勾选修稿；审出问题不会停。' : '',
          mode === 'finalize' ? '每写完一章就定稿（摘要 + 出场角色的当前状态），再写下一章。' : '只写正文，不定稿；之后在主按钮上逐章定稿。',
          plan.globalSummaryAt.length > 0
            ? `第 ${plan.globalSummaryAt.join('、')} 章定稿之后各更新一次全书滚动摘要（落后 ${GLOBAL_SUMMARY_EVERY} 章就更新，每次 1 次调用）。`
            : '',
          plan.skipped.length > 0 ? `已经写过正文的第 ${plan.skipped.join('、')} 章跳过，不会被改动。` : '',
          plan.stopAt !== undefined ? `第 ${plan.stopAt} 章还没有细纲、情节大纲也没覆盖到它，写到它前面为止。` : '',
          '一章写不出来就停；写出来但开头重演了上一章、把后面几章的人提前写了进来、没写够八成或结尾停在半句上，也写进去然后停下，等你看过再继续。',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    );
    if (pick !== '开始写章') {
      log.info('用户取消了批量写章');
      return 0;
    }
  }

  const pool = await createModelPool({ task: 'manuscript', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，批量写章中止');
    return 0;
  }
  let summaryPool: ModelPool | undefined;
  let statePool: ModelPool | undefined;
  if (mode === 'finalize') {
    summaryPool = await createModelPool({ task: 'plotSummary', concurrent: false });
    statePool = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? summaryPool;
    if (!summaryPool) {
      log.error('没有可用的模型定稿，批量写章中止');
      return 0;
    }
  }
  const cardPool = castCards.plans.length > 0 ? (statePool ?? (await createModelPool({ task: 'characterCard', concurrent: false }))) : undefined;
  // 写前冲突检查与摘要同档：读两份短文字、按合同摘出东西。
  const checkPool = summaryPool ?? (await createModelPool({ task: 'plotSummary', concurrent: false }));
  const plotPool = plan.plotBatches.length > 0 ? await createModelPool({ task: 'plotOutline', concurrent: false }) : undefined;
  if (plan.plotBatches.length > 0 && !plotPool) {
    log.error('没有可用的模型拆细纲，批量写章中止');
    return 0;
  }
  const ws = new Workspace(project);
  const reviewPool = reviewing ? await createModelPool({ task: 'review', concurrent: false }) : undefined;
  if (reviewing && !reviewPool) {
    log.error('没有可用的模型审稿，批量写章中止');
    return 0;
  }
  // 报告放进的那个会话：审完第一章才落盘（一章都没审成就不在历史里占位）。
  const reviews = reviewing ? reviewSession(project, plan.chapters) : undefined;

  let calls = 0;
  await runTask(
    '批量写章',
    async ({ signal, report, stopRequested, finish }) => {
      const startedAt = Date.now();
      const total = plan.chapters.length;
      const written: number[] = [];
      let finalized = 0;
      /** 停在哪、为什么。没有就是全部写完了。 */
      let halt: { no: number; why: string; level: 'info' | 'error' } | undefined;
      let last: Plot | undefined;

      if (cardPool && castCards.plans.length > 0) {
        const names = castCards.plans.map((p) => p.member.name).join('、');
        report({ message: `补建角色卡：${names}`, current: 0, total });
        try {
          const made = await createCastCards(project, castCards.plans, {
            signal,
            pool: cardPool,
            config,
            report: (p) => report({ message: `补建角色卡 · ${p.message}` }),
          });
          calls += castCards.calls;
          log.info(`开写之前补建了 ${made.created} 张角色卡`, `${names}${made.failed > 0 ? `｜失败 ${made.failed} 张（空卡已留下）` : ''}`);
        } catch (err) {
          calls += castCards.calls;
          if (err instanceof CancelledError || signal.aborted) {
            log.warn('批量写章被取消，停在补建角色卡');
            return;
          }
          // 卡没建成不挡写章：预检照样能靠定稿事实认人。
          log.warn(`补建角色卡失败：${describeError(err)}，接着写章`);
        }
        project.invalidate();
      }

      for (let i = 0; i < total && !halt; i++) {
        const no = plan.chapters[i];
        // 这一路要跑好几分钟：作者可能在这期间自己写了这一章、或删了它的细纲。
        project.invalidate();
        let plot = await project.getPlot(no);
        const existing = await project.getChapter(no);
        if (existing && existing.wordCount > 0) {
          log.info(`第 ${no} 章在批量写章期间已经有了正文，跳过`);
          continue;
        }
        // 边写边拆：写到一批没细纲的章的第一章时先拆这一批——前面的章刚写完、定稿，细纲看得见。
        const plotBatch = plan.plotBatches.find((b) => b[0] === no);
        if (plotBatch && plotPool && (!plot || !isPlotFilled(plot.sections))) {
          const span = rangeLabel(plotBatch[0], plotBatch[plotBatch.length - 1]);
          report({ message: `${span} · 拆细纲`, current: i, total });
          const r = await runPlotBatch(project, ws, plotPool, config, signal, plotBatch);
          calls += r.calls;
          if (!r.ok) {
            if (r.cancelled) {
              log.warn(`批量写章被取消，停在拆${span}的细纲`);
              return;
            }
            halt = { no, why: `的细纲没拆成（${r.reason}）`, level: 'error' };
            break;
          }
          // 新排出来的细纲里埋了什么线：接着排一次（只追加新线；没排成不挡写章，失败挂在 threads.md 上）。
          const th = await planThreads(project, plotPool, signal);
          calls += th.calls;
          if (th.cancelled) {
            log.warn(`批量写章被取消，停在排叙事线`);
            return;
          }
          project.invalidate();
          plot = await project.getPlot(no);
        }
        if (!plot || !isPlotFilled(plot.sections)) {
          halt = { no, why: '还没有细纲', level: 'error' };
          break;
        }
        const fresh = (await preflightChapter(project, no)).risks.filter((r) => !ignored.has(riskKey(no, r)));
        if (fresh.length > 0) {
          const lines = describeRisks(no, fresh);
          log.warn(`第 ${no} 章的一致性预检没过，批量停在它前面`, lines.join('\n'));
          await recordFailure(project, {
            scope: '流水线',
            targetKind: 'plot',
            targetKey: plot.relPath,
            severity: 'warn',
            op: 'preflight',
            message: `一致性预检：${lines.join('；')}`,
            detail: `批量写章停在这一章前面，没有写。${PREFLIGHT_SUGGESTION}`,
          });
          halt = { no, why: `的一致性预检发现 ${fresh.length} 处问题（${fresh.map((r) => r.name).join('、')}已经死了，细纲仍排着）`, level: 'info' };
          break;
        }
        void clearFailures(project, 'plot', plot.relPath, 'preflight');
        // 写前冲突检查：细纲是计划，定稿事实是历史。对不上就停在这一章前面（批量没有人看着）。
        if (checkPool) {
          report({ message: `第 ${no} 章 · 比对细纲与既成事实`, current: i, total });
          try {
            const check = await checkPlotAgainstFacts(project, no, checkPool, signal);
            calls += check.calls;
            if (check.conflicts.length > 0) {
              const lines = check.conflicts.map(describeConflict);
              log.warn(`第 ${no} 章的细纲与前面定稿的事实对不上，批量停在它前面`, lines.join('\n'));
              await recordFailure(project, {
                scope: '流水线',
                targetKind: 'plot',
                targetKey: plot.relPath,
                severity: 'warn',
                op: 'plotCheck',
                message: `写前冲突检查：${lines.join('；')}`,
                detail: `批量写章停在这一章前面，没有写。${PLOT_CHECK_SUGGESTION}`,
              });
              halt = { no, why: `的细纲与前面定稿的事实有 ${check.conflicts.length} 处对不上（${clip(lines[0], 60)}）`, level: 'info' };
              break;
            }
            void clearFailures(project, 'plot', plot.relPath, 'plotCheck');
          } catch (err) {
            calls += (err as { calls?: number }).calls ?? 1;
            if (err instanceof CancelledError || signal.aborted) {
              log.warn(`批量写章被取消，停在第 ${no} 章的写前冲突检查`);
              return;
            }
            // 检查是额外的一道：它没做成不该挡写章。
            log.warn(`第 ${no} 章的写前冲突检查没做成（${describeError(err)}），照写`);
          }
        }
        const name = `第 ${no} 章${plot.title ? `《${plot.title}》` : ''}`;
        report({ message: `${name} · 写正文`, current: i, total });
        let chapterCalls = 0;
        try {
          const out = await writeOne(project, plot, pool, config, signal, {
            onCall: () => {
              chapterCalls++;
            },
            onProgress: (p) =>
              report({
                message: `${name} · ${p.round > 0 ? `续写第 ${p.round} 轮 · ` : ''}已写 ${p.words}${p.target ? ` / ${p.target}` : ''} 字`,
              }),
          });
          calls += chapterCalls;
          written.push(no);
          last = plot;
          if (out.notes.length > 0) {
            log.info(`${name}：${out.notes.length} 条说明`, out.notes.join('\n'));
          }
          // 写完即审稿（五期补遗 §4）：写 → 审 → 定稿。要停下的那一章也照样审完再停——作者回来要看它。
          if (reviews && reviewPool) {
            report({ message: `${name} · 审稿`, current: i, total });
            project.invalidate();
            const r = await reviewOne(project, plot, reviewPool, config, signal);
            calls += r.calls;
            if (r.cancelled) {
              log.warn(`批量写章被取消，${name}写好了、没审完`);
              return;
            }
            await reviews.add(plot, r);
          }
          const problem = out.replay
            ? `开头与上一章结尾大段重合（「${clip(out.replay, 40)}」），可能把上一章最后一场又演了一遍`
            : out.early?.length
              ? `${out.early.map((e) => `第 ${e.no} 章才登场的${e.name}`).join('、')}提前写进了这一章（「${clip(out.early[0].quote, 40)}」）`
              : out.short
                ? `只写到 ${out.words} / ${out.target} 字，不到目标的八成`
                : out.truncated
                  ? '结尾停在半句上（被截断，续写没能接完）'
                  : undefined;
          if (problem) {
            void recordFailure(project, {
              scope: '流水线',
              targetKind: 'plot',
              targetKey: plot.relPath,
              severity: 'warn',
              op: 'manuscript',
              message: `批量写章：这一章写进去了，但${problem}`,
              detail: '批量在这一章停下，没有定稿，也没有往下写。看过这一章（接着写、重写或手改）再继续。',
            });
            halt = { no, why: problem, level: 'info' };
            break;
          }
          void clearFailures(project, 'plot', plot.relPath, 'manuscript');
        } catch (err) {
          calls += err instanceof ChainError ? Math.max(err.calls, chapterCalls) : chapterCalls;
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`批量写章被取消，停在${name}（这一章没有写入）`);
            return;
          }
          const reason = describeError(err);
          log.error(`${name}的正文没写成：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
          void recordFailure(project, {
            scope: '流水线',
            targetKind: 'plot',
            targetKey: plot.relPath,
            severity: 'error',
            op: 'manuscript',
            message: `正文生成失败：${reason}`,
            detail: '批量写章停在这一章。后面的章要接着它写，已经停下。',
          });
          halt = { no, why: `没写成（${reason}）`, level: 'error' };
          break;
        }

        if (mode === 'finalize') {
          report({ message: `${name} · 定稿`, current: i, total });
          project.invalidate();
          const chapter = await project.getChapter(no);
          try {
            // 叙事线那一步与摘要同档：读一章、按合同摘出东西，是同一种活。
            const outcome = chapter
              ? await finalizeChapter(project, chapter, { signal, summary: summaryPool, state: statePool, threads: summaryPool })
              : undefined;
            if (!outcome) {
              halt = { no, why: '写好了，但没能定稿', level: 'error' };
              break;
            }
            calls += outcome.calls;
            finalized++;
            log.info(`${name}已定稿`, describeFinalize(no, outcome));
            if (summaryPool && plan.globalSummaryAt.includes(no)) {
              report({ message: `${name} · 更新全书摘要`, current: i, total });
              try {
                const g = await updateGlobalSummary(project, summaryPool, signal);
                calls += g.calls;
              } catch (err) {
                calls += 1;
                if (err instanceof CancelledError || signal.aborted) {
                  log.warn(`批量写章被取消，${name}定稿了、全书摘要没更新`);
                  return;
                }
                // 全书摘要是额外的一道：没更新成不挡写章，下一次落后得更多时再更新。
                log.warn(`全书摘要没更新成（${describeError(err)}），接着写`);
              }
            }
          } catch (err) {
            // 请求发出去了钱就花了：摘要那一次算上。
            calls += 1;
            if (err instanceof CancelledError || signal.aborted) {
              log.warn(`批量写章被取消，${name}写好了、没定稿`);
              return;
            }
            halt = { no, why: `写好了，但定稿失败（${describeError(err)}）`, level: 'error' };
            break;
          }
        }

        report({ current: i + 1, total });
        if (stopRequested() && i < total - 1) {
          halt = { no, why: '按你的要求写完这一章就停', level: 'info' };
          break;
        }
      }

      // 停下之后还没写的：停在的那一章之后的（那一章本身在前面那句里已经说过了）。
      const rest = halt ? plan.chapters.filter((n) => n > halt!.no) : [];
      const done = written.length > 0 ? `${rangeLabel(written[0], written[written.length - 1])}已写好${mode === 'finalize' ? `，定稿 ${finalized} 章` : ''}` : '';
      log.info(`批量写章结束：写了 ${written.length} 章`, `调用 ${calls} 次，总耗时 ${elapsed(startedAt)}`);
      const reviewed = reviews?.summary();
      const open = reviews?.sessionId
        ? { sessionId: reviews.sessionId, label: '打开审稿报告' }
        : last
          ? { plotRelPath: last.relPath, label: `打开第 ${last.no} 章` }
          : undefined;
      if (!halt) {
        finish({ message: `${done}（调用 ${calls} 次）。${reviewed ?? ''}`, open });
        return;
      }
      const tail = rest.length > 0 ? `后面的${rangeLabel(rest[0], rest[rest.length - 1])}没写。` : '';
      const head =
        halt.why === '按你的要求写完这一章就停'
          ? `写完第 ${halt.no} 章停下了`
          : written.includes(halt.no)
            ? `第 ${halt.no} 章写进去了，但${halt.why}，没有往下写`
            : `第 ${halt.no} 章${halt.why}，批量停在这里`;
      finish({
        message: [done ? `${done}。` : '', `${head}。`, tail, reviewed ?? ''].join(''),
        level: halt.level,
        // 停在一章有问题的正文上：先看那一章（审稿报告在历史页的那个会话里，提示里说了）。
        open: written.includes(halt.no) && halt.why !== '按你的要求写完这一章就停' ? { plotRelPath: last!.relPath, label: `打开第 ${halt.no} 章` } : open,
      });
    },
    { scope: '流水线', pausable: true }
  );
  return calls;
}

/**
 * 写一章：装配 → 第一次调用 → 续写链 → 落盘、记 `writtenFrom`。
 *
 * 模型：第一次调用走池（失败换同档其余，第 12 条）；**之后续写那几轮钉住第一次成功的那个**——
 * 一章写到一半换人，文风会断在段落中间（三期约束：续写每一轮都用第一次那个模型）。
 */
async function writeOne(
  project: NovelProject,
  plot: Plot,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  hooks: { onCall(): void; onProgress(p: WriteProgress): void }
): Promise<ManuscriptChainResult & { target?: number }> {
  const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    action: { stage: 'manuscript', capability: 'generate' },
    target: { kind: 'manuscript', plotRelPath: plot.relPath },
    targetNo: plot.no,
    // 批量路径上没有作者那一句话。整份细纲与执行卡已经由装配器带上了，这一句只说清写的是哪一章。
    ask: `写第 ${plot.no} 章${plot.title ? `《${plot.title}》` : ''}的正文。`,
  };
  const writing = await planWriting(project, request);
  const built: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    ...request,
    writeMode: writing.mode,
    targetWords: writing.target,
    notYet: writing.notYet.map(({ name, no }) => ({ name, no })),
    banned: writing.banned,
  };
  const budgeted = { ...config, ...pool.primaryBudget };
  let pinned: LlmProvider | undefined;
  const stream = async (
    llm: LlmProvider,
    messages: AgentMessage[],
    progress?: { round: number; base: number },
    temperature = config.temperature
  ): Promise<CallOutcome> => {
    let text = '';
    let stop: StopSignal | undefined;
    let reportedAt = 0;
    for await (const ev of llm.stream(messages, {
      maxOutputTokens: pool.primaryBudget.maxOutputTokens,
      temperature,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })) {
      if (ev.type === 'text') {
        text += ev.text;
        if (progress && Date.now() - reportedAt >= 1000) {
          reportedAt = Date.now();
          hooks.onProgress({ round: progress?.round ?? 0, words: (progress?.base ?? 0) + countWords(text), target: writing.target });
        }
      } else if (ev.type === 'stop') {
        stop = ev.reason;
      }
    }
    return { text, stop };
  };
  const io: ChainIO = {
    messages: [],
    build: async (patch) => (await buildContext(project, { ...built, ...patch }, budgeted)).messages,
    call: async (messages, label, opts) => {
      hooks.onCall();
      if (pinned) {
        return stream(pinned, messages, opts?.progress, opts?.temperature);
      }
      return pool.run(label, async (llm) => {
        const out = await stream(llm, messages, opts?.progress, opts?.temperature);
        pinned = llm;
        return out;
      });
    },
  };
  io.messages = await io.build({});
  const first = await io.call(io.messages, `第 ${plot.no} 章`, { progress: { round: 0, base: 0 } });
  const result = await completeManuscript(first, io, {
    mode: writing.mode,
    existing: writing.existing,
    target: writing.target,
    prevEnding: writing.prevEnding,
    reasoned: false,
    hook: writing.hook,
    notYet: writing.notYet,
    banned: writing.banned,
    trim: config.trimModifiers,
    onProgress: hooks.onProgress,
    signal,
  });
  if (!result.raw.trim()) {
    throw new Error('模型返回的正文是空的');
  }
  // 同号章节不在就新建，在（空文件）就填进去；然后在细纲上记 `writtenFrom`，
  // 少了那一步这一章会永远显示「正文与细纲对不上」或永远不显示。
  const ws = new Workspace(project);
  const dest = await chapterTargetOf(project, plot.relPath);
  if (dest.exists) {
    await ws.write(dest.rel, { text: result.raw }, { mode: 'append' });
  } else {
    await ws.createChapter(dest.no, dest.title, result.raw);
  }
  await ws.recordWrittenFrom(plot.relPath, plotContentHash(plot));
  await project.syncManifest();
  return { ...result, target: writing.target };
}

/** 「第 3 章」或「第 3–7 章」。 */
function rangeLabel(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

// ---------------------------------------------------------------- 写完即审稿（五期补遗 §4）

/** 审一章的结果：报告，或者审不成的原因；取消单列（整个批量就此收）。 */
type ReviewOutcome =
  | { report: ReviewReport; notes: string[]; calls: number; cancelled?: false }
  | { error: string; notes: string[]; calls: number; cancelled?: false }
  | { cancelled: true; calls: number };

/**
 * 审一章：与对话页同一条审稿链（generation/review.ts 的 `completeReview`：截断重来、不合格重建、
 * 引文校验、目标核对），只是每次调用走 `review` 档的池、不流式。**不抛**（取消除外，也收成一个结果）：
 * 审稿失败不该被当成写章失败把批量停下。
 */
async function reviewOne(
  project: NovelProject,
  plot: Plot,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal
): Promise<ReviewOutcome> {
  const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    action: { stage: 'manuscript', capability: 'review' },
    target: { kind: 'manuscript', plotRelPath: plot.relPath },
    targetNo: plot.no,
    ask: '',
  };
  const ctx = await planReview(project, request);
  if (!ctx) {
    return { error: '这一章没有正文，没法审', notes: [], calls: 0 };
  }
  const io = poolIO(project, pool, config, signal, { ...request, reviewGoals: [...ctx.goals] });
  try {
    const messages = await io.chain.build({});
    const first = await io.chain.call(messages, `审第 ${plot.no} 章`);
    const r = await completeReview(first, { ...io.chain, messages }, ctx);
    log.info(`第 ${plot.no} 章审完：${describeReport(r.report)}`, r.notes.join('\n'));
    return { report: r.report, notes: r.notes, calls: r.calls };
  } catch (err) {
    const calls = err instanceof ChainError ? Math.max(err.calls, io.calls()) : io.calls();
    if (err instanceof CancelledError || signal.aborted) {
      return { cancelled: true, calls };
    }
    log.warn(`第 ${plot.no} 章审稿失败：${describeError(err)}`, err instanceof ChainError ? err.notes.join('\n') : err);
    return { error: describeError(err), notes: err instanceof ChainError ? err.notes : [], calls };
  }
}

/**
 * 「批量审稿 · 第 a–b 章」那个会话：一章一轮（用户轮 `/审稿`，助手轮是报告卡；审不成的那一轮记报错），
 * 每加一轮落盘一次。作者在对话页打开它，报告卡上勾选、修稿与对话页里审出来的那一份一模一样。
 */
function reviewSession(project: NovelProject, nos: readonly number[]) {
  const store = new SessionStore(project);
  let session: ChatSession | undefined;
  const lines: string[] = [];
  const command = commandOf('manuscript', 'review')?.label ?? '审稿';
  return {
    get sessionId(): string | undefined {
      return session?.id;
    },
    async add(plot: Plot, r: Exclude<ReviewOutcome, { cancelled: true }>): Promise<void> {
      if (!session) {
        session = store.create({ target: { kind: 'manuscript', plotRelPath: plot.relPath }, stage: 'manuscript', targetNo: plot.no });
        session.title = `批量审稿 · ${rangeLabel(nos[0], nos[nos.length - 1])}`;
      }
      session.target = { kind: 'manuscript', plotRelPath: plot.relPath };
      session.targetNo = plot.no;
      session.turns.push({ id: makeTurnId(), role: 'user', content: '', at: nowIso(), command });
      if ('report' in r) {
        session.turns.push({
          id: makeTurnId(),
          role: 'assistant',
          content: renderReport(r.report),
          at: nowIso(),
          review: { report: r.report, ...(r.notes.length > 0 ? { notes: r.notes } : {}), calls: r.calls },
        });
        const errors = r.report.issues.filter((x) => x.severity === 'error').length;
        const warnings = r.report.issues.length - errors;
        lines.push(`第 ${plot.no} 章${r.report.issues.length > 0 ? ` ${errors} 严重 · ${warnings} 建议` : '没有找到问题'}`);
      } else {
        session.turns.push({ id: makeTurnId(), role: 'assistant', content: '', at: nowIso(), error: `审稿失败：${r.error}` });
        lines.push(`第 ${plot.no} 章审稿失败`);
      }
      session.updatedAt = nowIso();
      await store.write(session);
    },
    /** 完成提示里的那一句：「审稿：第 1 章 1 严重 · 2 建议；第 2 章没有找到问题。报告在……」。 */
    summary(): string | undefined {
      return session && lines.length > 0 ? `审稿：${lines.join('；')}。报告在会话「${session.title}」里。` : undefined;
    },
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
