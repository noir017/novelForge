/**
 * 从已写正文补齐（拆书 A 的后一半）：作者已经写了 N 章（导入的原稿，或者老工程），把新链路上缺的那几样
 * **照正文整理出来**，之后批量写章接着往下写。
 *
 * ```
 * 一、细纲（第 1–N 章里没定稿的、定稿后正文改过的）  ← 第一次确认：只报细纲的次数
 * 二、配置 → 前提 → 角色卡 → 世界观（只补空白）     ← 第二次确认：细纲出来之后次数才算得准
 *     → 设定条目（还一条都没有时，从名录建）
 *     → 情节大纲（每次 20 章，照细纲）
 *     → 全文大纲（落后就增量更新）
 * ```
 *
 * 第一步就是定稿的第一步（`summarizeChapters`）：照正文写出 `summaries/NNN-<章名>.md`，带 `sourceHash`
 * 与 `cast`——这几章因此直接算定稿过，不必再另排一遍细纲。
 *
 * 借鉴 AI-Novel-Writer 的「小说拆解」（`import-workflow.ts` 的 global / blueprints 两步，
 * `import-novel.command.ts`）：上游推演设定只看首末两章各 3000 字、导入当前工程会覆盖原有配置与角色。
 * 这里设定看全书梗概加均匀抽样（context/layers/written.ts），而且**只补空白**——已经有的一件不动
 * （第 19 条的批量那一面）。
 *
 * ## 为什么是这个顺序
 *
 * 与新链路往下展开的顺序一致，每一件都吃前面几件：前提照着配置写，世界观照着前提与角色，大纲要架构
 * 几件。细纲排最前：建卡要从定稿过的细纲里认出场人物，大纲照细纲整理。设定条目排在建卡之后：名录里
 * 撞上角色卡的名字是人、不是设定，卡建好了才认得出来。
 *
 * 设定条目不走架构那一件「设定清单」：有正文的书那一件本来就算填过（`isLoreListFilled`），设定照名录
 * 来——定稿过的细纲第九节里出现过、还没有条目的名字，出现过的全部，
 * 与名录上「全部建条目」同一份 `createLoreEntries`。它是额外的一道：没建成不算补齐失败，挂黄 ❗、
 * 后面几样照常补。
 *
 * ## 两次确认（第 4 条）
 *
 * 建卡要调几次，取决于细纲里认出了谁、各出场几章——细纲没齐时算不出来。所以先只报细纲；细纲出来之后
 * 第二个框把其余几样的次数一次列全。细纲本来就齐的，只弹第二个。
 *
 * ## 不做的
 *
 * - 不排叙事线、不记叙事线事件：那是给后面的章的计划，导入的章是历史（⚑）。
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
  describeCalls,
  loreEntryCalls,
} from '../model/pipeline';
import { LlmTask } from '../model/tiers';
import { CallChoice } from '../model/callChoice';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError, singleShotNotes } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { buildBookFacts, nextWritableChapterNo } from '../views/pipeline';
import { UnfiledLore, buildLoreIndex } from '../views/lore';
import { normalizeLoreName } from '../model/loreFile';
import { confirmDespiteGap } from './chapterGap';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { CastCardsPlan, createCastCards, planCastCards } from './characterCard';
import { BUILD_MIN_CHAPTERS, createLoreEntries } from './lore';
import { settingKey, settingRaw } from './pipelineBatch';
import { poolIO } from './poolIO';
import { summarizeChapters, updateGlobalSummary } from './summarize';

const log = scoped('补齐');

/** 补建角色卡：定稿过的细纲里出场至少这么多章的人；一个都没有就降到 1。 */
export const DERIVE_CARD_MIN_APPEARANCES = 2;
/** 补建设定条目：名录里出现至少这么多章的（与「全部建条目」同一个门槛）。 */
export const DERIVE_LORE_MIN_CHAPTERS = BUILD_MIN_CHAPTERS;
/** 全文大纲一次并不完时最多再并几次。 */
export const GLOBAL_SUMMARY_ROUNDS = 5;
/** 小说配置没写每章字数、已写的章也量不出来时的缺省（与补齐架构一致）。 */
const DEFAULT_WORDS = 3000;

const EXACT_CALLS = (n: number): CallEstimate => ({ low: n, high: n, max: n });

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
  if (!(await confirmDespiteGap(chapters, '从已写正文补齐'))) {
    log.info('章号断了一截，作者没有继续从已写正文补齐');
    return 0;
  }
  const written = chapters.filter((c) => c.order <= through);

  let calls = 0;
  /** 先整理细纲那一问的选择：其余几样那一问打开时缺省跟着它（同一件事的两步）。 */
  let preset: CallChoice | undefined;
  project.invalidate();
  const stale = (await project.staleChapters()).filter((c) => c.order <= through && c.wordCount > 0);
  if (stale.length > 0) {
    const r = await summarizeFirst(project, stale, through);
    calls += r.calls;
    if (!r.ok) {
      return calls;
    }
    preset = r.choice;
    project.invalidate();
  }
  return calls + (await deriveRest(project, through, written, calls, preset));
}

// ---------------------------------------------------------------- 一、细纲

async function summarizeFirst(
  project: NovelProject,
  stale: Chapter[],
  through: number
): Promise<{ ok: boolean; calls: number; choice?: CallChoice }> {
  const lanes = Math.min(readConfig().concurrency, stale.length);
  const answer = await askCall({
    message: `从已写正文补齐第 1–${through} 章：先照正文给 ${stale.length} 章整理细纲（没定稿的、定稿后正文改过的），调用 ${stale.length} 次模型。现在开始？`,
    actions: ['先整理细纲'],
    detail: [
      lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。',
      '已经有细纲的章拿着它与正文对照着改，旧版先复制一份进 .novelforge/.trash/。',
      '细纲出来之后再算建卡、设定与情节大纲要调几次（建卡次数要看细纲里认出了谁），到时再问你一次。',
    ].join('\n'),
    tasks: ['plotSummary'],
    contextDetail: false,
  });
  if (answer?.action !== '先整理细纲') {
    log.info('作者没有开始从已写正文补齐（细纲那一步）');
    return { ok: false, calls: 0 };
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: lanes > 1 });
    if (!pool) {
      log.error('没有可用的模型，从已写正文补齐中止');
      return { ok: false, calls: 0 };
    }
    let ok = false;
    await runTask(
      '从已写正文补齐 · 细纲',
      async ({ signal, report }) => {
        const r = await summarizeChapters(project, stale, { pool, lanes, signal, report });
        if (signal.aborted) {
          log.warn(`从已写正文补齐被取消，细纲完成 ${r.ok}/${stale.length} 章`);
          return;
        }
        if (r.failed.length > 0) {
          getHost().toast(
            `第 ${r.failed.map((f) => f.no).join('、')} 章的细纲没整理成（可在日志页看原因）。建卡与大纲要照细纲来，已经停下；补上这几章再来一次。`,
            'error'
          );
          return;
        }
        ok = true;
      },
      { scope: '补齐' }
    );
    return { ok, calls: stale.length, choice: answer.choice };
  });
}

// ---------------------------------------------------------------- 二、其余几样

interface DerivePlan {
  /** 要补的架构几件，按链路顺序。 */
  settings: SettingDoc[];
  cards?: CastCardsPlan & { min: number };
  /** 要建的设定条目（还一条都没有时，名录里出现 ≥`min` 章的）。每条 1 次，解析不了的重来一次。 */
  lore?: { targets: UnfiledLore[]; min: number };
  /** 情节大纲每次整理的区间。 */
  outline: { from: number; to: number }[];
  globalSummary: boolean;
  setup?: { totalChapters: number; wordsPerChapter: number };
}

/** `before`：前面细纲那一步已经调了几次（完成提示报的是总数）；`preset`：那一步作者挑的模型与详细度。 */
async function deriveRest(
  project: NovelProject,
  through: number,
  written: Chapter[],
  before: number,
  preset?: CallChoice
): Promise<number> {
  const plan = await planRest(project, through, written);
  if (!plan) {
    return 0;
  }
  const estimate = estimateOf(plan);
  const labels = [
    ...plan.settings.map((doc) => (doc === 'characters' ? '角色卡' : SETTING_DOC_LABEL[doc])),
    ...(plan.lore ? ['设定条目'] : []),
    ...(plan.outline.length > 0 ? ['情节大纲'] : []),
    ...(plan.globalSummary ? ['全文大纲'] : []),
  ];
  if (labels.length === 0) {
    getHost().toast(`第 1–${through} 章的细纲、架构与情节大纲都已经有了。`);
    return 0;
  }
  const answer = await askCall({
    message: `从已写正文补齐第 1–${through} 章：${labels.join('、')}，${describeCalls(estimate)}。现在补？`,
    actions: ['开始补齐'],
    detail: describePlan(plan, through),
    tasks: tasksOf(plan),
    contextDetail: true,
    preset,
  });
  if (answer?.action !== '开始补齐') {
    log.info('作者没有开始从已写正文补齐');
    return 0;
  }

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const needSetting = plan.settings.some((d) => d !== 'characters');
    const settingPool = needSetting ? await createModelPool({ task: 'setting', concurrent: false }) : undefined;
    const lanes = plan.cards ? Math.min(config.concurrency, Math.max(1, plan.cards.plans.length)) : 1;
    const cardPool = plan.cards ? await createModelPool({ task: 'characterCard', concurrent: lanes > 1 }) : undefined;
    const loreLanes = plan.lore ? Math.min(config.concurrency, Math.max(1, plan.lore.targets.length)) : 1;
    // 建条目这一道是额外的：池建不出来不拦整件事，走到那一步时挂黄、接着往下补。
    const lorePool = plan.lore ? await createModelPool({ task: 'loreSynthesis', concurrent: loreLanes > 1 }) : undefined;
    const plotPool = plan.outline.length > 0 ? await createModelPool({ task: 'plotOutline', concurrent: false }) : undefined;
    const summaryPool = plan.globalSummary ? await createModelPool({ task: 'plotSummary', concurrent: false }) : undefined;
    if ((needSetting && !settingPool) || (plan.cards && !cardPool) || (plan.outline.length > 0 && !plotPool)) {
      log.error('没有可用的模型，从已写正文补齐中止');
      return 0;
    }

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

        // 架构几件：配置 → 前提 → 角色卡 → 世界观。
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
        const settingsDone = done.length === plan.settings.length;

        // 设定条目：建卡之后（名录才认得出哪些名字是人）。额外的一道，没建成挂黄、后面照常补。
        if (plan.lore && !halt && !signal.aborted && settingsDone) {
          report({ message: '设定条目', current: step, total: steps });
          const r = await deriveLore(project, plan.lore, { signal, pool: lorePool, lanes: loreLanes, report });
          calls += r.calls;
          if (r.created > 0) {
            done.push(`设定条目 ${r.created} 条`);
          }
          step++;
        }

        // 情节大纲：每次 20 章，照那几章定稿过的细纲。
        if (!halt && !signal.aborted && settingsDone) {
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
                  detail: '从已写正文补齐停在这一段。后面的段要接着它整理，没有继续。',
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

        // 全文大纲：落后就增量更新；它是额外的一道，没更新成不算补齐失败。
        if (!halt && !signal.aborted && plan.globalSummary && summaryPool) {
          report({ message: '全文大纲', current: step, total: steps });
          try {
            for (let round = 0; round < GLOBAL_SUMMARY_ROUNDS; round++) {
              const g = await updateGlobalSummary(project, summaryPool, signal);
              calls += g.calls;
              if (g.calls === 0 || (g.through ?? 0) >= through) {
                break;
              }
            }
            done.push('全文大纲');
          } catch (err) {
            calls += 1;
            if (!(err instanceof CancelledError || signal.aborted)) {
              log.warn(`全文大纲没更新成（${describeError(err)}），之后可在工程页点「重建」`);
            }
          }
        }

        report({ message: '收尾', current: steps, total: steps });
        log.info(`从已写正文补齐结束：${done.join('、') || '什么都没补上'}`, `调用 ${calls} 次，总耗时 ${elapsed(startedAt)}`);
        if (signal.aborted) {
          return;
        }
        const head = done.length > 0 ? `已从第 1–${through} 章补上：${before > 0 ? `${before} 章细纲、` : ''}${done.join('、')}` : '';
        if (halt) {
          getHost().toast(`${head ? `${head}。` : ''}${halt}，后面的已经停下。`, 'error');
          return;
        }
        getHost().toast(`${head}（调用 ${before + calls} 次）。接下来可以续写大纲、批量写第 ${through + 1} 章以后的章。`);
      },
      { scope: '补齐' }
    );
    return calls;
  });
}

/** 细纲齐了之后，其余几样各要做什么。零调用。总章数没写时问一句（取消就返回 undefined）。 */
async function planRest(project: NovelProject, through: number, written: Chapter[]): Promise<DerivePlan | undefined> {
  project.invalidate();
  const [facts, book, manifest, entries] = await Promise.all([
    buildBookFacts(project),
    project.readBookConfig(),
    project.readManifest(),
    project.listLore(),
  ]);
  // 设定清单不在这里：有正文的书那一件算填过，设定条目单独一步从名录建（见 `planLore`）。
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
      // 细纲里一个出场人物都认不出：建不了卡，后面几件照样补。
      log.warn('定稿过的细纲里认不出出场人物，角色卡这一步跳过', planned.skipped.map((s) => `${s.name}（${s.reason}）`).join('、'));
      settings.splice(settings.indexOf('characters'), 1);
    } else {
      cards = { ...planned, min };
    }
  }

  const covered = isOutlineFilled(await project.readOutline()) ? facts.outlineCoverage : 0;
  const outline: { from: number; to: number }[] = [];
  // 有内容却没有区间标题的大纲（`Infinity`）说不上覆盖到哪：不往里并。
  if (Number.isFinite(covered)) {
    for (let from = covered + 1; from <= through; from += OUTLINE_BATCH) {
      outline.push({ from, to: Math.min(through, from + OUTLINE_BATCH - 1) });
    }
  }

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
    lore: entries.length === 0 ? await planLore(project) : undefined,
    outline,
    globalSummary: (manifest.globalSummaryThrough ?? 0) < through,
    setup,
  };
}

/**
 * 要建哪几条设定条目：名录里「出现过 · 未建条目」的、出现 ≥{@link DERIVE_LORE_MIN_CHAPTERS} 章的；
 * 一个都没有就降到 1 章（与建卡同一个降法）。名录里一个名字都没有（老细纲没记过设定）就不建。零调用。
 */
async function planLore(project: NovelProject): Promise<DerivePlan['lore']> {
  const { unknown } = await buildLoreIndex(project);
  let min = DERIVE_LORE_MIN_CHAPTERS;
  let targets = unknown.filter((u) => u.chapters.length >= min);
  if (targets.length === 0) {
    min = 1;
    targets = unknown;
  }
  if (targets.length === 0) {
    log.info('定稿过的细纲里没记下设定（或者都已经有条目），设定条目这一步跳过');
    return undefined;
  }
  return { targets, min };
}

/** 确认框上那个数：每一样的次数加起来。 */
export function estimateOf(plan: Pick<DerivePlan, 'settings' | 'cards' | 'lore' | 'outline' | 'globalSummary'>): CallEstimate {
  const parts: CallEstimate[] = [];
  for (const doc of plan.settings) {
    parts.push(doc === 'config' ? CONFIG_CALLS : doc === 'characters' ? EXACT_CALLS(plan.cards?.calls ?? 0) : ONE_CALL);
  }
  if (plan.lore) {
    parts.push(loreEntryCalls(plan.lore.targets.length));
  }
  if (plan.outline.length > 0) {
    parts.push(EXACT_CALLS(plan.outline.length));
  }
  if (plan.globalSummary) {
    parts.push({ low: 1, high: 1, max: GLOBAL_SUMMARY_ROUNDS });
  }
  return parts.reduce(addCalls, { low: 0, high: 0, max: 0 });
}

/** 这一次要用到哪几项活（确认框「按分档」下面逐项列）。 */
function tasksOf(plan: DerivePlan): LlmTask[] {
  return [
    ...(plan.settings.some((d) => d !== 'characters') ? ['setting' as const] : []),
    ...(plan.cards ? ['characterCard' as const] : []),
    ...(plan.lore ? ['loreSynthesis' as const] : []),
    ...(plan.outline.length > 0 ? ['plotOutline' as const] : []),
    ...(plan.globalSummary ? ['plotSummary' as const] : []),
  ];
}

function describePlan(plan: DerivePlan, through: number): string {
  const lines: string[] = [];
  lines.push(
    '按 配置 → 前提 → 角色卡 → 世界观 → 设定条目 → 情节大纲 → 全文大纲 的顺序一件一件来，每件都照已写正文整理；已经有的不会被改动。一件失败就停，已经写好的留着（设定条目没建成不停）。'
  );
  if (plan.setup) {
    lines.push(`小说配置按 ${plan.setup.totalChapters} 章 × ${plan.setup.wordsPerChapter} 字展开（没写每章字数时取已写各章的平均）。`);
  }
  if (plan.cards) {
    const names = plan.cards.plans.map((p) => p.member.name);
    lines.push(
      `角色卡：给${names.slice(0, 12).join('、')}${names.length > 12 ? `等 ${names.length} 人` : ''}建卡（细纲里出场 ${plan.cards.min} 章以上、还没有卡；读他们出场的那几章正文，${plan.cards.calls} 次调用）。` +
        (plan.cards.skipped.length > 0 ? `跳过 ${plan.cards.skipped.map((s) => `「${s.name}」（${s.reason}）`).join('、')}。` : '')
    );
  }
  if (plan.lore) {
    const names = plan.lore.targets.map((u) => u.name);
    lines.push(
      `设定条目：给${names.slice(0, 12).join('、')}${names.length > 12 ? `等 ${names.length} 条` : ''}建条目（细纲里出现 ${plan.lore.min} 章以上、还没有条目；` +
        `只读定稿细纲里提到它们的那几行，${describeCalls(loreEntryCalls(names.length))}）。建卡之后认得出是人的不建，次数只会更少。`
    );
  }
  if (plan.outline.length > 0) {
    const first = plan.outline[0].from;
    lines.push(`情节大纲：照细纲整理${rangeLabel(first, through)}，每次 ${OUTLINE_BATCH} 章，${plan.outline.length} 次调用。`);
  }
  if (plan.globalSummary) {
    lines.push(`全文大纲：落后于第 ${through} 章，增量更新（一次并不完再来，最多 ${GLOBAL_SUMMARY_ROUNDS} 次）。`);
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

/**
 * 建设定条目那一步：与名录上「全部建条目」同一份 `createLoreEntries`。**不抛、不停**：没建成写日志、
 * 挂在「设定清单」那一行上（黄 ❗，第 16 条），后面几样照常补；全建成了收掉那条记录。
 *
 * 动手前按刚建好的角色卡再认一遍名录：确认框里列的名字有的是人（卡在这一次才建出来），那些不建——
 * 次数只会比报的少（第 4 条）。
 */
async function deriveLore(
  project: NovelProject,
  plan: NonNullable<DerivePlan['lore']>,
  opts: {
    signal: AbortSignal;
    pool?: ModelPool;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ calls: number; created: number }> {
  const key = settingKey(project, 'lore');
  const warn = (message: string, detail: string): void => {
    log.warn(message, detail);
    void recordFailure(project, {
      scope: '补齐',
      targetKind: 'setting',
      targetKey: key,
      severity: 'warn',
      op: 'deriveLore',
      message,
      detail,
    });
  };
  project.invalidate();
  const still = new Set((await buildLoreIndex(project)).unknown.map((u) => normalizeLoreName(u.name)));
  const targets = plan.targets.filter((u) => still.has(normalizeLoreName(u.name)));
  if (targets.length === 0) {
    return { calls: 0, created: 0 };
  }
  if (!opts.pool) {
    warn('设定条目没建：没有可用的模型', '从已写正文补齐的其余几样照常补齐。配好模型后可以在设定组「出现过 · 未建条目」里建。');
    return { calls: 0, created: 0 };
  }
  try {
    const r = await createLoreEntries(project, targets, {
      signal: opts.signal,
      pool: opts.pool,
      lanes: opts.lanes,
      report: (p) => opts.report({ message: `设定条目 · ${p.message}` }),
    });
    if (r.failed > 0 && !opts.signal.aborted) {
      warn(
        r.created > 0 ? `设定条目建了 ${r.created} 条，${r.failed} 条没建成` : `设定条目一条都没建成（${r.failed} 条失败）`,
        '原因见日志页。其余几样照常补齐；没建成的仍在设定组「出现过 · 未建条目」里，可以再建。'
      );
    } else if (r.failed === 0) {
      await clearFailures(project, 'setting', key, 'deriveLore');
    }
    return { calls: r.calls, created: r.created };
  } catch (err) {
    if (!(err instanceof CancelledError || opts.signal.aborted)) {
      warn(`设定条目没建成（${describeError(err)}）`, '从已写正文补齐的其余几样照常补齐。');
    }
    return { calls: 0, created: 0 };
  }
}
