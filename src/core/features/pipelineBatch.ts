/**
 * 工程页的流水线批量动作：**补齐故事架构、一次拆几十章细纲、一次写几十章正文**。
 *
 * - 补齐设定与批量拆细纲（二期）走 generation/structured.ts 的生成链，与对话页同一份：
 *   细纲每批 5 章，截断拆半、语法修复、漏章 fail-closed 一样不少。它们**严格串行**——
 *   前提要照着配置写，后一批细纲要接着前一批往下排——一件（一批）失败就停，已经写好
 *   的留着。
 * - 写正文改成严格串行（写一章 → 定稿 → 下一章，后一章要读前一章的结尾与角色状态）
 *   是四期的事，现在仍按原样并发。
 *
 * 与创作页的单次生成（features/creation.ts）是两条路，理由是它们的失败模型
 * 完全不同：创作页一次一份，出错就重来；这里一次几十份，**必须允许部分失败
 * 并跑完剩下的**——第 12 段写不出正文不该让另外 63 段白等。
 *
 * 结构与 `syncSummaries` 逐字对齐（同一套 runTask + runPool + recordFailure +
 * 分档确认框），因为作者对这类批量动作已经有了预期：先说清要调几次模型、
 * 用哪一档，跑起来能看进度、能取消，失败的挂在那一行上第二天还看得见。
 *
 * ## 只补不改
 *
 * 两个批量动作都**跳过已经有产物的段**，不问、不覆盖。批量路径上没有
 * 「逐个审阅」的余地——一次弹 63 个 diff 没有人看得完——所以唯一安全的
 * 做法是只处理空白的那些。要重做某一段，去创作页单独重做。
 *
 * ## 返回值是「这一次调了几次模型」
 *
 * 写正文返回确认框里那个数字（一章一次，计划即实际）。补齐设定与拆细纲有自动修复，
 * 实际次数在跑完之前说不准，返回**实际调用的次数**——确认框里报的是区间与上限
 * （同一个纯函数算的，见 model/pipeline.ts 的 `planPlotBatches` / `CallEstimate`）。
 * 用户取消、没有可做的、没有可用模型时是 0。**只在这里算**：agent 的 `run` 工具拿它
 * 记进预算，工程页那条路不看它。让调用方各算一遍，弹窗写着 7 次、账上记 1 次，
 * 正是第 4 条要防的事。
 */
import { runPool } from '../runtime/concurrency';
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { collect, collectText } from '../llm/collect';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, formatDuration, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled } from '../model/plotFile';
import { isOutlineFilled } from '../model/outlineFile';
import { buildBookFacts, chapterTargetOf, plotContentHash } from '../views/pipeline';
import { describeTaskModels } from '../model/tiers';
import { BuildRequest, buildContext } from '../context/builder';
import { runTask } from '../runtime/progress';
import { cleanOutput } from './creation';
import { isArtifactEmpty, parseArtifact } from './artifact';
import {
  CONFIG_CALLS,
  CallEstimate,
  ONE_CALL,
  PLOT_BATCH,
  SETTING_DOCS,
  SETTING_DOC_LABEL,
  SettingDoc,
  addCalls,
  describeCalls,
  planPlotBatches,
  rosterCalls,
} from '../model/pipeline';
import { Workspace } from '../workspace';
import { acceptArtifact, acceptPlotBatch } from '../generation/accept';
import { CallOutcome, ChainError, ChainIO, completeBlueprints, completeConfig, completeRoster } from '../generation/structured';

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
          '每批写完就落盘，后一批接着前一批往下排；一批失败就停，已经写好的留着。\n' +
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
        const range = { from: batch[0], to: batch[batch.length - 1] };
        const span = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
        const target = { kind: 'plot' as const, plotRelPath: (await project.getPlot(range.from))?.relPath ?? project.plotPathForNo(range.from, '') };
        report({ message: `${span}（第 ${i + 1}/${plan.batches.length} 批）`, current: done, total: plan.chapters.length });
        const io = poolIO(project, pool, config, signal, {
          action: { stage: 'plot', capability: 'generate' },
          target,
          targetNo: range.from,
          range,
          ask: '',
        });
        try {
          const result = await completeBlueprints(undefined, io.chain, batch);
          calls += result.calls;
          if (result.notes.length > 0) {
            log.warn(`${span}：${result.notes.length} 处降级`, result.notes.join('\n'));
          }
          const r = await acceptPlotBatch(project, ws, result.items, range, { onlyBlank: true });
          log.info(`${span}的细纲已落盘`, r.message);
          void clearFailures(project, 'plot', target.plotRelPath, 'plotOutline');
          done += batch.length;
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`批量拆细纲被取消，已完成 ${done}/${plan.chapters.length} 章`);
            return;
          }
          const reason = describeError(err);
          log.error(`${span}的细纲失败：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
          void recordFailure(project, {
            scope: '流水线',
            targetKind: 'plot',
            targetKey: target.plotRelPath,
            severity: 'error',
            op: 'plotOutline',
            message: `细纲生成失败：${reason}`,
            detail: `${span}这一批没有写入。后面的批次依赖它，已经停下。`,
          });
          getHost().toast(
            `${span}的细纲没拆成（${reason}）。${done > 0 ? `前面 ${done} 章已经写好。` : ''}后面的批次已停下。`,
            'error'
          );
          return;
        }
      }
      report({ message: '收尾', current: done, total: plan.chapters.length });
      log.info(`批量拆细纲结束：${done} 章`, `调用 ${calls} 次，总耗时 ${elapsed(startedAt)}`);
      getHost().toast(`已为${where}写好 ${done} 章细纲${plan.skipped.length > 0 ? `（跳过已有的 ${plan.skipped.length} 章）` : ''}。`);
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
function settingKey(project: NovelProject, doc: SettingDoc): string {
  return project.relPath(project.settingPath(doc));
}

/** 补齐设定的一件：第一次调用，配置与角色图谱再接上各自的链。 */
async function settingRaw(
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
function poolIO(
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

/**
 * 给所有「细纲排好了但还没写正文」的章各写一遍正文。
 *
 * 这是两个批量动作里贵得多的一个（一章几千字输出，一次几十章），所以确认框里
 * 除了调用次数还报出预计总字数——那个数字比「40 次调用」更能让人意识到
 * 这一下要花多少钱。
 *
 * **一章一次调用，不自动续写**。对话页的「写第 N 章」会续写到目标字数的八成
 * （generation/continuation.ts），这条批量路径还没接上：它四期要整个重写成严格串行
 * （写一章 → 落盘 → 定稿 → 下一章，D10），续写链与重演检测那时一并接。写不够长的章
 * 留在「待写正文」（`manuscriptRatio`），作者在创作页点「接着写」。**批量路径只补空白**。
 */
export async function writeManuscripts(project: NovelProject): Promise<number> {
  const [plots, chapters, book] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    project.readBookConfig(),
  ]);
  const pending: Plot[] = [];
  let noPlot = 0;
  for (const plot of plots) {
    // 没排细纲就写正文，模型只能照着标题瞎编——那种正文作者一章都留不下。
    if (!isPlotFilled(plot.sections)) {
      noPlot++;
      continue;
    }
    // 只补空白：已经写过正文的章一律跳过，哪怕上游变了、哪怕还没写够。
    const chapter = chapters.find((c) => c.order === plot.no);
    if (!chapter || chapter.wordCount === 0) {
      pending.push(plot);
    }
  }

  if (pending.length === 0) {
    getHost().toast(
      noPlot > 0
        ? `没有可写的章。还有 ${noPlot} 章没排细纲——先写细纲再来写正文。`
        : '每一章都已经写过正文了。'
    );
    return 0;
  }

  // 预计字数：细纲上标了目标字数就用它，否则用配置的每章字数，都没有按 3000 估。
  const wordsTotal = pending.reduce((sum, p) => sum + (p.targetWords ?? book.wordsPerChapter ?? 3000), 0);

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章的细纲已排好但还没写正文，需要调用 ${pending.length} 次模型（一章 1 次）。现在写？`,
    ['开始写作'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'manuscript')}\n` +
        `预计产出约 ${Math.round(wordsTotal / 1000)} 千字。\n` +
        (lanes > 1 ? `并发 ${lanes} 章。` : '串行逐章处理（并发数为 1）。') +
        '\n批量写正文不自动续写：写不够目标字数的章，之后在创作页点「接着写」。' +
        '\n已经写过正文的章不会被改动。' +
        (noPlot > 0 ? `\n另有 ${noPlot} 章还没排细纲，这次跳过。` : ''),
    }
  );
  if (confirm !== '开始写作') {
    log.info('用户取消了批量写正文');
    return 0;
  }

  const ws = new Workspace(project);
  const pool = await createModelPool({ task: 'manuscript', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量写正文中止');
    return 0;
  }

  await runBatch(project, {
    title: '批量写正文',
    items: pending,
    lanes,
    op: 'manuscript',
    what: '正文',
    run: async (plot, signal) => {
      const built = await buildContext(
        project,
        {
          action: { stage: 'manuscript', capability: 'generate' },
          target: { kind: 'manuscript', plotRelPath: plot.relPath },
          targetNo: plot.no,
          targetWords: plot.targetWords ?? book.wordsPerChapter,
          // 批量路径上没有用户输入那一句话。装配器已经把整份细纲按 P0 force
          // 带上了，这一句只说清写的是哪一章。
          ask: `写第 ${plot.no} 章${plot.title ? `《${plot.title}》` : ''}的正文。`,
        },
        config
      );
      const raw = await pool.run(`第 ${plot.no} 章`, (llm) =>
        collectText(
          llm.stream(built.messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      const text = cleanOutput(raw);
      if (!text.trim()) {
        throw new Error('模型返回的正文是空的');
      }
      // 同号章节不在就新建，在（空文件）就追加；然后在细纲上记 `writtenFrom`，
      // 少了那一步这一章会永远显示「正文与细纲对不上」或永远不显示。
      const dest = await chapterTargetOf(project, plot.relPath);
      if (dest.exists) {
        await ws.write(dest.rel, { text }, { mode: 'append' });
      } else {
        await ws.createChapter(dest.no, dest.title, text);
      }
      await ws.recordWrittenFrom(plot.relPath, plotContentHash(plot));
      await project.syncManifest();
    },
  });
  return pending.length;
}

// ---------------------------------------------------------------- 共用

interface BatchSpec {
  title: string;
  items: Plot[];
  lanes: number;
  /** 失败记录的 op，与清除时用的一致。 */
  op: string;
  /** 产物名，进日志与 toast（「细纲」「正文」）。 */
  what: string;
  run(plot: Plot, signal: AbortSignal): Promise<void>;
}

/**
 * 批量执行的外壳：进度、取消、逐项失败记录、收尾汇报。
 *
 * 抽出来是因为两个批量动作的这一段一字不差，而它们要保证的东西恰恰在这里：
 * **失败一项不影响其余**、失败挂在那一段上、取消时说清跑到哪了。
 */
async function runBatch(project: NovelProject, spec: BatchSpec): Promise<void> {
  const { items, lanes } = spec;
  await runTask(
    spec.title,
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const failed: { no: number; reason: string }[] = [];
      const running = new Set<number>();
      let done = 0;
      let okCount = 0;
      report({ message: '准备中…', current: 0, total: items.length });

      const describeRunning = (): string =>
        lanes > 1
          ? `已完成 ${done}/${items.length} · ${running.size} 路进行中（第 ${[...running]
              .sort((a, b) => a - b)
              .join('、')} 章）`
          : '';

      await runPool(items, lanes, (plot) => spec.run(plot, signal), {
        signal,
        onStart: (plot) => {
          running.add(plot.no);
          report({
            message: lanes > 1 ? describeRunning() : `第 ${plot.no} 章《${plot.title}》`,
            current: done,
            total: items.length,
          });
        },
        onSettled: (result, plot, _index, finished) => {
          running.delete(plot.no);
          done = finished;
          if (result.status === 'fulfilled') {
            okCount++;
            void clearFailures(project, 'plot', plot.relPath, spec.op);
          } else {
            const err = result.reason;
            if (!(err instanceof CancelledError || err?.name === 'CancelledError')) {
              const reason = describeError(err);
              failed.push({ no: plot.no, reason });
              log.error(`第 ${plot.no} 章《${plot.title}》失败：${reason}`, err);
              // toast 五秒就没了，而一次跑几十章、失败三章是常态。
              // 挂到那一行上，第二天回来还看得出是哪几章没成。
              void recordFailure(project, {
                scope: '流水线',
                targetKind: 'plot',
                targetKey: plot.relPath,
                severity: 'error',
                op: spec.op,
                message: `${spec.what}生成失败：${reason}`,
                detail: `这一章的${spec.what}未完成。可在创作页单独重试。`,
              });
            }
          }
          const perItem = (Date.now() - startedAt) / done;
          log.info(
            `进度 ${done}/${items.length}`,
            `刚完成第 ${plot.no} 章；平均 ${formatDuration(perItem)}/章，` +
              `预计剩余 ${formatDuration(perItem * (items.length - done))}`
          );
          report({
            message: lanes > 1 ? describeRunning() : `第 ${plot.no} 章《${plot.title}》`,
            current: done,
            total: items.length,
          });
        },
      });

      if (signal.aborted) {
        log.warn(`${spec.title}被取消，已完成 ${done}/${items.length} 章`);
      }
      report({ message: '收尾', current: done, total: items.length });
      // 完成顺序是乱的，汇报前排回来——「第 7、3、12 章失败」没法读。
      failed.sort((a, b) => a.no - b.no);
      if (failed.length > 0) {
        log.warn(
          `${spec.title}结束：成功 ${okCount} 章，失败 ${failed.length} 章`,
          failed.map((f) => `第 ${f.no} 章：${f.reason}`).join('\n')
        );
        getHost().toast(
          `完成 ${okCount} 章，第 ${failed.map((f) => f.no).join('、')} 章失败，可在日志页看原因。`
        );
      } else if (okCount > 0) {
        log.info(`${spec.title}结束：${okCount} 章全部成功`, `总耗时 ${elapsed(startedAt)}`);
        getHost().toast(`已为 ${okCount} 章生成${spec.what}。`);
      }
    },
    { scope: '流水线' }
  );
}
