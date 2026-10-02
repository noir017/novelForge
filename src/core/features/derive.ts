/**
 * 从已写正文补齐（拆书 A 的后一半）：作者已经写了 N 章（导入的原稿，或者老工程），把新链路上缺的那几样
 * **照正文整理出来**，之后批量写章接着往下写。
 *
 * ```
 * 一、摘要（第 1–N 章里缺的、过期的）           ← 第一次确认：只报摘要的次数
 * 二、配置 → 前提 → 角色卡 → 世界观（只补空白）   ← 第二次确认：摘要出来之后次数才算得准
 *     → 情节大纲（每次 20 章，照摘要）
 *     → 细纲（每批 5 章，照正文头尾）
 *     → 全书摘要（落后就增量更新）
 * ```
 *
 * 借鉴 AI-Novel-Writer 的「小说拆解」（`import-workflow.ts` 的 global / blueprints 两步，
 * `import-novel.command.ts`）：上游推演设定只看首末两章各 3000 字、蓝图跨批不衔接、导入当前工程会覆盖
 * 原有配置与角色。这里设定看全书梗概加均匀抽样（context/layers/written.ts），细纲批次之间照常有前序细纲
 * 一览，而且**只补空白**——已经有的一件不动（第 19 条的批量那一面）。
 *
 * ## 为什么是这个顺序
 *
 * 与新链路往下展开的顺序一致，每一件都吃前面几件：前提照着配置写，世界观照着前提与角色，大纲要架构
 * 四件，细纲落盘要记大纲那一节的指纹（`upstreamHash`，第 18 条）——**先落细纲再补大纲，细纲会全挂
 * 「上游已改」**。摘要排最前：建卡要从摘要里认出场人物，大纲照摘要整理。
 *
 * ## 两次确认（第 4 条）
 *
 * 建卡要调几次，取决于摘要里认出了谁、各出场几章——摘要没齐时算不出来。所以先只报摘要；摘要出来之后
 * 第二个框把其余几样的次数一次列全。摘要本来就齐的，只弹第二个。
 *
 * ## 不做的
 *
 * - 不排叙事线、不记叙事线事件：那是给后面的章的计划，导入的章是历史（⚑）。
 * - 不记 `writtenFrom`：正文不是照这份细纲写的（第 18a 条：手写的产物永不标脏）。
 * - 不带写作技能（context/layers/skill.ts）：这一次是照实整理，不是规划。
 *
 * 一件失败就停，已经写好的留着；失败挂在那一行上（第 16 条）。返回实际调了几次模型。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { isOutlineFilled, outlineCoverage } from '../model/outlineFile';
import { defaultTotalChapters, roundedAverageWords } from '../model/importText';
import {
  CONFIG_CALLS,
  CallEstimate,
  ONE_CALL,
  OUTLINE_BATCH,
  SETTING_DOC_LABEL,
  SettingDoc,
  addCalls,
  blueprintCalls,
  describeCalls,
  isFallbackChapterTitle,
  planPlotBatches,
} from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError, singleShotNotes } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { buildBookFacts, nextWritableChapterNo } from '../views/pipeline';
import { Workspace } from '../workspace';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { CastCardsPlan, createCastCards, planCastCards } from './characterCard';
import { poolIO, runPlotBatch, settingKey, settingRaw } from './pipelineBatch';
import { summarizeChapters, updateGlobalSummary } from './summarize';

const log = scoped('补齐');

/** 补建角色卡：摘要里出场至少这么多章的人；一个都没有就降到 1。 */
export const DERIVE_CARD_MIN_APPEARANCES = 2;
/** 全书摘要一次并不完时最多再并几次。 */
export const GLOBAL_SUMMARY_ROUNDS = 5;
/** 小说配置没写每章字数、已写的章也量不出来时的缺省（与补齐设定一致）。 */
const DEFAULT_WORDS = 3000;

const SUMMARY_CALLS = (n: number): CallEstimate => ({ low: n, high: n, max: n });

export async function deriveFromText(project: NovelProject): Promise<number> {
  const chapters = (await project.listChapters()).filter((c) => c.wordCount > 0);
  const through = nextWritableChapterNo(chapters) - 1;
  if (through < 1) {
    getHost().toast(
      chapters.length > 0 ? '第 1 章还没有正文：从已写正文补齐要从第 1 章起连续有正文。' : '还没有正文，没有可以整理的东西。',
      'error'
    );
    return 0;
  }
  const written = chapters.filter((c) => c.order <= through);
  if (written.length < chapters.length) {
    log.info(`第 ${through} 章之后有正文但不连续，这一次只整理第 1–${through} 章`);
  }

  let calls = 0;
  project.invalidate();
  const stale = (await project.staleChapters()).filter((c) => c.order <= through && c.wordCount > 0);
  if (stale.length > 0) {
    const r = await summarizeFirst(project, stale, through);
    calls += r.calls;
    if (!r.ok) {
      return calls;
    }
    project.invalidate();
  }
  return calls + (await deriveRest(project, through, written, calls));
}

// ---------------------------------------------------------------- 一、摘要

async function summarizeFirst(
  project: NovelProject,
  stale: Chapter[],
  through: number
): Promise<{ ok: boolean; calls: number }> {
  const config = readConfig();
  const lanes = Math.min(config.concurrency, stale.length);
  const pick = await getHost().confirm(
    `从已写正文补齐第 1–${through} 章：先给 ${stale.length} 章同步摘要（缺失或已过期），调用 ${stale.length} 次模型。现在开始？`,
    ['先同步摘要'],
    {
      modal: true,
      detail: [
        describeTaskModels(config, 'plotSummary'),
        lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。',
        '摘要出来之后再算建卡、设定、情节大纲与细纲要调几次（建卡次数要看摘要里认出了谁），到时再问你一次。',
      ].join('\n'),
    }
  );
  if (pick !== '先同步摘要') {
    log.info('作者没有开始从已写正文补齐（摘要那一步）');
    return { ok: false, calls: 0 };
  }
  const pool = await createModelPool({ task: 'plotSummary', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，从已写正文补齐中止');
    return { ok: false, calls: 0 };
  }
  let ok = false;
  await runTask(
    '从已写正文补齐 · 摘要',
    async ({ signal, report }) => {
      const r = await summarizeChapters(project, stale, { pool, lanes, signal, report });
      if (signal.aborted) {
        log.warn(`从已写正文补齐被取消，摘要完成 ${r.ok}/${stale.length} 章`);
        return;
      }
      if (r.failed.length > 0) {
        getHost().toast(
          `第 ${r.failed.map((f) => f.no).join('、')} 章的摘要没生成（可在日志页看原因）。建卡与大纲要照摘要来，已经停下；补上这几章再来一次。`,
          'error'
        );
        return;
      }
      ok = true;
    },
    { scope: '补齐' }
  );
  return { ok, calls: stale.length };
}

// ---------------------------------------------------------------- 二、其余几样

interface DerivePlan {
  /** 要补的架构几件，按链路顺序。 */
  settings: SettingDoc[];
  cards?: CastCardsPlan & { min: number };
  /** 情节大纲每次整理的区间。 */
  outline: { from: number; to: number }[];
  plots: ReturnType<typeof planPlotBatches>;
  globalSummary: boolean;
  setup?: { totalChapters: number; wordsPerChapter: number };
}

/** `before`：前面摘要那一步已经调了几次（完成提示报的是总数）。 */
async function deriveRest(project: NovelProject, through: number, written: Chapter[], before: number): Promise<number> {
  const plan = await planRest(project, through, written);
  if (!plan) {
    return 0;
  }
  const estimate = estimateOf(plan);
  const labels = [
    ...plan.settings.map((doc) => (doc === 'characters' ? '角色卡' : SETTING_DOC_LABEL[doc])),
    ...(plan.outline.length > 0 ? ['情节大纲'] : []),
    ...(plan.plots.chapters.length > 0 ? ['细纲'] : []),
    ...(plan.globalSummary ? ['全书摘要'] : []),
  ];
  if (labels.length === 0) {
    getHost().toast(`第 1–${through} 章的摘要、架构、情节大纲与细纲都已经有了。`);
    return 0;
  }
  const config = readConfig();
  const pick = await getHost().confirm(
    `从已写正文补齐第 1–${through} 章：${labels.join('、')}，${describeCalls(estimate)}。现在补？`,
    ['开始补齐'],
    { modal: true, detail: describePlan(plan, through, config) }
  );
  if (pick !== '开始补齐') {
    log.info('作者没有开始从已写正文补齐');
    return 0;
  }

  const needSetting = plan.settings.some((d) => d !== 'characters');
  const settingPool = needSetting ? await createModelPool({ task: 'setting', concurrent: false }) : undefined;
  const lanes = plan.cards ? Math.min(config.concurrency, Math.max(1, plan.cards.plans.length)) : 1;
  const cardPool = plan.cards ? await createModelPool({ task: 'characterCard', concurrent: lanes > 1 }) : undefined;
  const plotPool = plan.outline.length > 0 || plan.plots.chapters.length > 0 ? await createModelPool({ task: 'plotOutline', concurrent: false }) : undefined;
  const summaryPool = plan.globalSummary ? await createModelPool({ task: 'plotSummary', concurrent: false }) : undefined;
  if ((needSetting && !settingPool) || (plan.cards && !cardPool) || ((plan.outline.length > 0 || plan.plots.chapters.length > 0) && !plotPool)) {
    log.error('没有可用的模型，从已写正文补齐中止');
    return 0;
  }

  const ws = new Workspace(project);
  let calls = 0;
  await runTask(
    '从已写正文补齐',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const steps = labels.length;
      let step = 0;
      const done: string[] = [];
      /** 停在哪、为什么。没有就是全补完了。 */
      let halt: string | undefined;
      const stop = (what: string, err: unknown): 'cancelled' | 'failed' => {
        if (err instanceof CancelledError || signal.aborted) {
          log.warn(`从已写正文补齐被取消，停在${what}`);
          return 'cancelled';
        }
        halt = `${what}没补上（${describeError(err)}）`;
        log.error(`从已写正文补齐：${halt}`, err instanceof ChainError ? err.notes.join('\n') : err);
        return 'failed';
      };

      // 架构四件：配置 → 前提 → 角色卡 → 世界观。
      for (const doc of plan.settings) {
        const label = doc === 'characters' ? '角色卡' : SETTING_DOC_LABEL[doc];
        report({ message: label, current: step, total: steps });
        if (doc === 'characters') {
          const r = await deriveCards(project, plan.cards!, { signal, pool: cardPool!, config, lanes, report });
          calls += r.calls;
          if (r.outcome !== 'ok') {
            if (r.outcome === 'failed') {
              halt = r.why;
            }
            break;
          }
          done.push(`角色卡 ${r.created} 张`);
          step++;
          continue;
        }
        const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
          action: { stage: 'setting', capability: 'generate' },
          target: { kind: 'setting', doc },
          ask: '',
          derive: { through },
          ...(doc === 'config' && plan.setup ? { setup: plan.setup } : {}),
        };
        const io = poolIO(project, settingPool!, config, signal, request);
        try {
          const raw = await settingRaw(project, doc, request, io, '', plan.setup ?? { totalChapters: 0, wordsPerChapter: 0 });
          const artifact = parseArtifact(request.action, raw, request.target);
          if (isArtifactEmpty(artifact)) {
            throw new Error('模型返回的内容里解析不出这一件');
          }
          const r = await acceptArtifact(project, request.target, artifact, { onlyBlank: true });
          log.info(`${label}已从正文整理`, r.message);
          void clearFailures(project, 'setting', settingKey(project, doc), 'setting');
          calls += io.calls();
          done.push(label);
          step++;
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (stop(label, err) === 'failed') {
            void recordFailure(project, {
              scope: '补齐',
              targetKind: 'setting',
              targetKey: settingKey(project, doc),
              severity: 'error',
              op: 'setting',
              message: `从已写正文整理${label}失败：${describeError(err)}`,
              detail: '从已写正文补齐停在这一件。后面几件依赖它，没有继续。',
            });
          }
          break;
        }
        project.invalidate();
      }

      // 情节大纲：每次 20 章，照那几章的摘要。
      if (!halt && !signal.aborted && done.length === plan.settings.length) {
        for (const range of plan.outline) {
          const span = rangeLabel(range.from, range.to);
          report({ message: `情节大纲 · ${span}`, current: step, total: steps });
          const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
            action: { stage: 'outline', capability: 'generate' },
            target: { kind: 'outline' },
            range,
            ask: '',
            derive: { through },
          };
          const io = poolIO(project, plotPool!, config, signal, request);
          try {
            const first = await io.chain.call(await io.chain.build({}), `情节大纲（${span}）`);
            const notes = singleShotNotes('outline', first.text, first.stop, range);
            if (notes.length > 0) {
              log.warn(`情节大纲${span}：${notes.length} 条说明`, notes.join('\n'));
            }
            const artifact = parseArtifact(request.action, first.text, request.target, range);
            if (isArtifactEmpty(artifact)) {
              throw new Error('模型返回的大纲是空的');
            }
            await acceptArtifact(project, request.target, artifact);
            calls += io.calls();
            project.invalidate();
            const covered = outlineCoverage(await project.readOutline());
            if (!(covered >= range.to)) {
              throw new Error(`整理出来的大纲只覆盖到第 ${Number.isFinite(covered) ? covered : 0} 章（这一次要到第 ${range.to} 章）`);
            }
            void clearFailures(project, 'setting', project.relPath(project.outlinePath), 'outline');
          } catch (err) {
            calls += err instanceof ChainError ? err.calls : io.calls();
            if (stop(`情节大纲（${span}）`, err) === 'failed') {
              void recordFailure(project, {
                scope: '补齐',
                targetKind: 'setting',
                targetKey: project.relPath(project.outlinePath),
                severity: 'error',
                op: 'outline',
                message: `从已写正文整理情节大纲（${span}）失败：${describeError(err)}`,
                detail: '细纲要记大纲那一节的指纹，大纲没覆盖到的章不排细纲，补齐停在这里。',
              });
            }
            break;
          }
        }
        if (!halt && !signal.aborted && plan.outline.length > 0) {
          done.push('情节大纲');
          step++;
        }
      }

      // 细纲：每批 5 章，照正文的头尾；标题用章节自己的，目标字数记实际字数。
      if (!halt && !signal.aborted && plan.plots.chapters.length > 0) {
        const targetWords = new Map(written.map((c) => [c.order, c.wordCount]));
        const titles = new Map(written.filter((c) => !isFallbackChapterTitle(c.order, c.title)).map((c) => [c.order, c.title]));
        let made = 0;
        for (let i = 0; i < plan.plots.batches.length; i++) {
          const batch = plan.plots.batches[i];
          report({
            message: `细纲 · ${rangeLabel(batch[0], batch[batch.length - 1])}（第 ${i + 1}/${plan.plots.batches.length} 批）`,
            current: step,
            total: steps,
          });
          const r = await runPlotBatch(project, ws, plotPool!, config, signal, batch, { through, targetWords, titles });
          calls += r.calls;
          if (!r.ok) {
            if (!r.cancelled) {
              halt = `${rangeLabel(batch[0], batch[batch.length - 1])}的细纲没整理成（${r.reason}）`;
            }
            break;
          }
          made += batch.length;
        }
        if (made > 0) {
          done.push(`细纲 ${made} 章`);
        }
        if (!halt && !signal.aborted) {
          step++;
        }
      }

      // 全书摘要：落后就增量更新；它是额外的一道，没更新成不算补齐失败。
      if (!halt && !signal.aborted && plan.globalSummary && summaryPool) {
        report({ message: '全书摘要', current: step, total: steps });
        try {
          for (let round = 0; round < GLOBAL_SUMMARY_ROUNDS; round++) {
            const g = await updateGlobalSummary(project, summaryPool, signal);
            calls += g.calls;
            if (g.calls === 0 || (g.through ?? 0) >= through) {
              break;
            }
          }
          done.push('全书摘要');
        } catch (err) {
          calls += 1;
          if (!(err instanceof CancelledError || signal.aborted)) {
            log.warn(`全书摘要没更新成（${describeError(err)}），之后可在工程页点「重建」`);
          }
        }
      }

      report({ message: '收尾', current: steps, total: steps });
      log.info(`从已写正文补齐结束：${done.join('、') || '什么都没补上'}`, `调用 ${calls} 次，总耗时 ${elapsed(startedAt)}`);
      if (signal.aborted) {
        return;
      }
      const head = done.length > 0 ? `已从第 1–${through} 章补上：${before > 0 ? `${before} 章摘要、` : ''}${done.join('、')}` : '';
      if (halt) {
        getHost().toast(`${head ? `${head}。` : ''}${halt}，后面的已经停下。`, 'error');
        return;
      }
      getHost().toast(`${head}（调用 ${before + calls} 次）。接下来可以续写大纲、批量写第 ${through + 1} 章以后的章。`);
    },
    { scope: '补齐' }
  );
  return calls;
}

/** 摘要齐了之后，其余几样各要做什么。零调用。总章数没写时问一句（取消就返回 undefined）。 */
async function planRest(project: NovelProject, through: number, written: Chapter[]): Promise<DerivePlan | undefined> {
  project.invalidate();
  const [facts, book, manifest] = await Promise.all([buildBookFacts(project), project.readBookConfig(), project.readManifest()]);
  const settings: SettingDoc[] = (['config', 'premise', 'characters', 'world'] as SettingDoc[]).filter((doc) => !facts.settings[doc]);

  let cards: DerivePlan['cards'];
  if (settings.includes('characters')) {
    let min = DERIVE_CARD_MIN_APPEARANCES;
    let planned = await planCastCards(project, { minAppearances: min });
    if (planned.plans.length === 0) {
      min = 1;
      planned = await planCastCards(project, { minAppearances: min });
    }
    if (planned.plans.length === 0) {
      // 摘要里一个出场人物都认不出：建不了卡，后面几件照样补。
      log.warn('摘要里认不出出场人物，角色卡这一步跳过', planned.skipped.map((s) => `${s.name}（${s.reason}）`).join('、'));
      settings.splice(settings.indexOf('characters'), 1);
    } else {
      cards = { ...planned, min };
    }
  }

  const covered = isOutlineFilled(await project.readOutline()) ? facts.outlineCoverage : 0;
  const outline: { from: number; to: number }[] = [];
  // 有内容却没有区间标题的大纲（`Infinity`）说不上覆盖到哪：不往里并，照它排细纲。
  if (Number.isFinite(covered)) {
    for (let from = covered + 1; from <= through; from += OUTLINE_BATCH) {
      outline.push({ from, to: Math.min(through, from + OUTLINE_BATCH - 1) });
    }
  }
  const plots = planPlotBatches({ from: 1, to: through, filledNos: facts.plotFilledNos });

  let setup: DerivePlan['setup'];
  if (settings.includes('config')) {
    const words = book.wordsPerChapter ?? roundedAverageWords(written.map((c) => c.wordCount)) ?? DEFAULT_WORDS;
    let total = book.totalChapters;
    if (!total) {
      const answer = await getHost().input({
        title: '全书计划写多少章？',
        prompt: `已经写了 ${through} 章。小说配置要按全书的规模排节奏，之后可以在 config.md 里改。`,
        value: String(defaultTotalChapters(through)),
        validate: (v) => {
          const n = Number(v.trim());
          return Number.isInteger(n) && n >= through ? undefined : `填一个不小于 ${through} 的整数`;
        },
      });
      if (answer === undefined) {
        log.info('作者没有给总章数，从已写正文补齐没有开始');
        return undefined;
      }
      total = Number(answer.trim());
    }
    setup = { totalChapters: total, wordsPerChapter: words };
  }

  return {
    settings,
    cards,
    outline,
    plots,
    globalSummary: (manifest.globalSummaryThrough ?? 0) < through,
    setup,
  };
}

/** 确认框上那个数：每一样的次数加起来。 */
export function estimateOf(plan: Pick<DerivePlan, 'settings' | 'cards' | 'outline' | 'plots' | 'globalSummary'>): CallEstimate {
  const parts: CallEstimate[] = [];
  for (const doc of plan.settings) {
    parts.push(doc === 'config' ? CONFIG_CALLS : doc === 'characters' ? SUMMARY_CALLS(plan.cards?.calls ?? 0) : ONE_CALL);
  }
  if (plan.outline.length > 0) {
    parts.push(SUMMARY_CALLS(plan.outline.length));
  }
  if (plan.plots.chapters.length > 0) {
    // 不用 `plan.plots.calls`：那里算了拆完排一次叙事线的 1 次，这里不排线。
    parts.push(plan.plots.batches.map((b) => blueprintCalls(b.length)).reduce(addCalls));
  }
  if (plan.globalSummary) {
    parts.push({ low: 1, high: 1, max: GLOBAL_SUMMARY_ROUNDS });
  }
  return parts.reduce(addCalls, { low: 0, high: 0, max: 0 });
}

function describePlan(plan: DerivePlan, through: number, config: ReturnType<typeof readConfig>): string {
  const lines: string[] = [];
  if (plan.settings.some((d) => d !== 'characters')) {
    lines.push(describeTaskModels(config, 'setting'));
  }
  if (plan.cards) {
    lines.push(describeTaskModels(config, 'characterCard'));
  }
  if (plan.outline.length > 0 || plan.plots.chapters.length > 0) {
    lines.push(describeTaskModels(config, 'plotOutline'));
  }
  if (plan.globalSummary) {
    lines.push(describeTaskModels(config, 'plotSummary'));
  }
  lines.push(
    '按 配置 → 前提 → 角色卡 → 世界观 → 情节大纲 → 细纲 → 全书摘要 的顺序一件一件来，每件都照已写正文整理；已经有的不会被改动。一件失败就停，已经写好的留着。'
  );
  if (plan.setup) {
    lines.push(`小说配置按 ${plan.setup.totalChapters} 章 × ${plan.setup.wordsPerChapter} 字展开（没写每章字数时取已写各章的平均）。`);
  }
  if (plan.cards) {
    const names = plan.cards.plans.map((p) => p.member.name);
    lines.push(
      `角色卡：给${names.slice(0, 12).join('、')}${names.length > 12 ? `等 ${names.length} 人` : ''}建卡（摘要里出场 ${plan.cards.min} 章以上、还没有卡；读他们出场的那几章正文，${plan.cards.calls} 次调用）。` +
        (plan.cards.skipped.length > 0 ? `跳过 ${plan.cards.skipped.map((s) => `「${s.name}」（${s.reason}）`).join('、')}。` : '')
    );
  }
  if (plan.outline.length > 0) {
    const first = plan.outline[0].from;
    lines.push(`情节大纲：照摘要整理${rangeLabel(first, through)}，每次 ${OUTLINE_BATCH} 章，${plan.outline.length} 次调用。`);
  }
  if (plan.plots.chapters.length > 0) {
    lines.push(
      `细纲：${plan.plots.chapters.length} 章还没有细纲，每批 5 章、照正文的开头与结尾整理；标题用章节自己的，目标字数记那一章的实际字数。` +
        (plan.plots.skipped.length > 0 ? `已经有细纲的 ${plan.plots.skipped.length} 章跳过。` : '') +
        '输出被截断或格式不对时会自动拆小重试，所以给的是上限。'
    );
  }
  if (plan.globalSummary) {
    lines.push(`全书摘要：落后于第 ${through} 章，增量更新（一次并不完再来，最多 ${GLOBAL_SUMMARY_ROUNDS} 次）。`);
  }
  lines.push('叙事线不排：那是给后面的章的计划。以后照常拆细纲时会接着排。');
  return lines.join('\n');
}

/** 建卡那一步：与「给全部出场人物建卡」同一份 `createCastCards`。一张都没建成才算失败。 */
async function deriveCards(
  project: NovelProject,
  plan: CastCardsPlan,
  opts: {
    signal: AbortSignal;
    pool: ModelPool;
    config: ReturnType<typeof readConfig>;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ outcome: 'ok'; calls: number; created: number } | { outcome: 'cancelled' | 'failed'; calls: number; why?: string }> {
  try {
    const r = await createCastCards(project, plan.plans, {
      signal: opts.signal,
      pool: opts.pool,
      config: opts.config,
      lanes: opts.lanes,
      report: (p) => opts.report({ message: `角色卡 · ${p.message}` }),
    });
    project.invalidate();
    if (opts.signal.aborted) {
      return { outcome: 'cancelled', calls: plan.calls };
    }
    if (r.created === 0) {
      return { outcome: 'failed', calls: plan.calls, why: `角色卡一张都没建成（${r.failed} 张失败，空卡已留下）` };
    }
    if (r.failed > 0) {
      log.warn(`角色卡建了 ${r.created} 张，${r.failed} 张失败（空卡已留下，挂在那张卡上）`);
    }
    return { outcome: 'ok', calls: plan.calls, created: r.created };
  } catch (err) {
    if (err instanceof CancelledError || opts.signal.aborted) {
      return { outcome: 'cancelled', calls: plan.calls };
    }
    return { outcome: 'failed', calls: plan.calls, why: `角色卡没建成（${describeError(err)}）` };
  }
}

function rangeLabel(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}
