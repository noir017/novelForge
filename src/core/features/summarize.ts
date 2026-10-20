import { getHost } from '../host';
import { basename } from 'node:path';
import { collectText, mergeUsage } from '../llm/collect';
import { CancelledError, LlmProvider, StreamOptions, TokenUsage } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { resolveProvider } from '../llm/registry';
import { runPool } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { pickSections } from '../model/markdown';
import { readConfig } from '../config';
import { describeError, elapsed, formatDuration, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { castFromText, parseCastEntry, renderCastEntry } from '../model/castParse';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, Plot, PlotSectionKey, PlotSections, emptyPlotSections, parsePlotFileName } from '../model/plotFile';
import { describeTaskModels } from '../model/tiers';
import { CallEstimate, FINALIZE_CALLS, describeCalls } from '../model/pipeline';
import { Chapter, SummaryCast } from '../model/types';
import { ContinuityFact, attachEvidence, parseContinuityFacts, renderContinuityFacts } from '../model/continuity';
import { sanitizeAliases } from '../model/naming';
import { LoreLine, PLOT_LORE_KEY, loreLinesFromJson, parseLoreLines, renderLoreLines } from '../model/loreFile';
import { checkLore, loreHint } from './loreRecord';
import { STATE_OP } from './characterState';
import { updateStateAndThreads } from './finalizeSteps';
import { describeUsage, estimateTokens, recordUsage, takeHead } from '../context/tokenizer';
import { extractJsonObject, stripCodeFence, stripTrailingCommas } from './parse';
import { GLOBAL_SYSTEM, REFINE_SYSTEM, STAGE_SYSTEM, SUMMARY_SYSTEM } from './summarizePrompt';
import { Workspace } from '../workspace';

const log = scoped('定稿');
const globalLog = scoped('全书摘要');

/**
 * 定稿时模型交回来的结构化形态：八个小节 + 机器可读的出场人物清单 + 第九节「设定」（设定名录）。
 *
 * 模型被要求直接输出这个形状的 JSON。小节最终要渲染成人类可读的 Markdown（作者会翻、
 * 会手改），`cast` 则是给程序用的——出场统计、角色卡的关联都吃它。`lore` 是模型给的原样，
 * 写盘之前还要过一遍校验（features/loreRecord.ts 的 `checkLore`）。
 */
export interface SummaryData {
  sections: PlotSections;
  cast: SummaryCast[];
  lore: LoreLine[];
}

/**
 * 定稿第一步写好的那份细纲：落盘的八节与出场人物，外加连续性事实挂证据的结果——
 * 定稿（features/finalize.ts）要拿出场人物去更新角色状态，丢了几条事实要说出来。
 */
export interface SummaryOutcome extends SummaryData {
  relPath: string;
  /** 旧版细纲在回收站里的位置。原来没有细纲（拆书导入、作者手写的正文）时没有。 */
  trashed?: string;
  /** 挂上了证据、写进细纲的连续性事实。 */
  facts: ContinuityFact[];
  /** 正文里找不到依据、丢掉的事实（D18，第 2 条：说出来）。 */
  dropped: string[];
}

/**
 * 照正文反向更新一章的细纲（定稿的第一步，1 次调用）。返回写好的那一份；没有模型、正文是空的时
 * 返回 undefined（已经说过原因）。
 *
 * 读的是 `chapters/`：细纲定稿后描述的是写出来的那一章。**手上有细纲就拿它与正文对照着改**
 * （`REFINE_SYSTEM`：以正文为准，一致的保留原措辞，写偏的改、没写到的删）——这是修改，不是重写；
 * 细纲是空的（拆书导入、作者手写的正文）就照正文从头整理（`SUMMARY_SYSTEM`）。老工程里那些从没
 * 经过本工具的章因此也能直接定稿，不需要任何迁移。
 *
 * 连续性事实（D18）的证据在这里挂：模型只给事实陈述，证据句用 bigram 在**整章**正文里找
 * （model/continuity.ts），不调模型。找不到依据的事实丢掉并记日志。落盘前旧版细纲复制一份进
 * `.trash/`（`Workspace.finalizePlot`）。
 */
export async function summarizeChapter(
  project: NovelProject,
  chapter: Chapter,
  provider?: LlmProvider,
  signal?: AbortSignal,
  /**
   * 这次调用实际用的模型的窗口。批量入口从 `pool.primaryBudget` 传进来——
   * 分档后干活的模型未必是对话页选的那个，拿它的窗口切正文会超窗。
   * 单章入口（命令面板）不传，退回全局配置。
   */
  budget?: { contextWindow: number; maxOutputTokens: number }
): Promise<SummaryOutcome | undefined> {
  const llm = provider ?? (await resolveProvider());
  if (!llm) {
    log.warn(`第 ${chapter.order} 章跳过：没有可用的模型（未配置或未录入 API Key）`);
    return undefined;
  }
  const config = readConfig();
  const window = budget ?? { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens };
  const text = await project.readChapterText(chapter);
  if (!text.trim()) {
    log.warn(`第 ${chapter.order} 章《${chapter.title}》还没有正文，跳过`);
    getHost().toast(`第 ${chapter.order} 章还没有正文，没有可定稿的东西。`);
    return undefined;
  }

  // 单章正文通常远小于窗口；极长的章按输入预算截断。
  const inputBudget = Math.max(2000, window.contextWindow - window.maxOutputTokens - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(
      `第 ${chapter.order} 章正文超出输入预算，已截断`,
      `原文 ${text.length} 字 → ${body.length} 字（预算 ${inputBudget} token）`
    );
  }

  const usage: TokenUsage = {};
  const options: StreamOptions = {
    maxOutputTokens: window.maxOutputTokens,
    temperature: 0.3, // 定稿要稳定、可复现，压低温度
    timeoutMs: config.requestTimeoutMs,
    signal,
  };

  // 手上那份细纲（计划，或上一次定稿的档案）：正文镜像的那一份。一节都没填就当没有：照正文从头整理。
  const plan = await project.plotOfChapter(chapter);
  const planText = plan ? renderPlanForPrompt(plan) : '';
  const system = planText ? REFINE_SYSTEM : SUMMARY_SYSTEM;

  const startedAt = Date.now();
  log.debug(
    `第 ${chapter.order} 章《${chapter.title}》请求模型`,
    `模型 ${llm.label}｜正文 ${body.length} 字（约 ${estimateTokens(body)} token）｜` +
      (planText ? `带当前细纲 ${planText.length} 字` : '没有细纲，照正文整理')
  );

  // 把已有角色卡的名字告诉模型：cast 里的 name 要能跟角色卡对上，
  // 「林昭」和「昭公子」各写一份会让角色页凭空多出一个人。设定同理：分类表与这一章提到的已有设定。
  const known = await knownNamesHint(project);
  const loreKnown = await loreHint(project, text, plan);
  const head = `第${chapter.order}章 ${chapter.title}`;
  const userPrompt = planText
    ? `${known}${loreKnown}请照下面这一章的正文，把它的当前细纲改成正文实际写成的样子。\n\n【${head} · 当前细纲】\n\n${planText}\n\n【${head} · 正文】\n\n${body}`
    : `${known}${loreKnown}请为下面这一章整理细纲。\n\n【${head}】\n\n${body}`;
  // 校准统计比的是「整个请求的输入」，因此估算也要含系统提示词，
  // 否则这条样本会系统性地偏低，把 tokenCounter 的比值带歪。
  const estimated = estimateTokens(system) + estimateTokens(userPrompt);

  const raw = await collectText(
    llm.stream(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      options
    ),
    { onUsage: (u) => mergeUsage(usage, u) }
  );

  const { sections, cast, lore: rawLore } = parseSummaryResponse(raw);
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    log.error(
      `第 ${chapter.order} 章定稿解析失败：模型返回既不是 JSON 也不符合小节格式`,
      `返回 ${raw.length} 字，开头：${raw.slice(0, 300)}`
    );
    // 也在这里记一条，而不是只靠 syncSummaries 的 onSettled：主按钮「定稿」
    // 走的是单章路径，那条异常会一路抛到命令外层，根本到不了批量编排里。
    // 同一章 + 同一动作只留最新一条，两条路径都记也不会重复显示。
    await recordFailure(project, {
      scope: '定稿',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'error',
      op: 'summarize',
      message: '定稿失败：模型返回无法解析',
      detail:
        `模型返回 ${raw.length} 字，既不是 JSON 也不符合小节格式。细纲没有改动；` +
        '这一章的连续性事实与出场人物不会进入上下文。换个模型或稍后重试。',
    });
    throw new Error(`第 ${chapter.order} 章定稿失败，模型返回内容无法解析。`);
  }
  // 连续性事实挂证据：在整章正文里找（截给模型的那一份可能只有前半章）。人名给出场人物的
  // 名字与别名——事实里提到谁，就先在提到他的句子里找。
  const statements = parseContinuityFacts(sections.连续性事实).map((f) => f.statement);
  const { facts, dropped } = attachEvidence(
    statements,
    text,
    cast.flatMap((c) => [c.name, ...c.aliases])
  );
  sections.连续性事实 = renderContinuityFacts(facts);
  if (dropped.length > 0) {
    log.warn(
      `第 ${chapter.order} 章有 ${dropped.length} 条连续性事实在正文里找不到依据，已丢弃`,
      dropped.map((d) => `- ${d}`).join('\n')
    );
  }
  // 第九节「设定」：名字要逐字出现在正文里、说明要找得到依据、人名不算（不调模型）。
  const lore = await checkLore(project, chapter, rawLore, text, cast.flatMap((c) => [c.name, ...c.aliases]));
  const { rel: relPath, trashed } = await new Workspace(project).finalizePlot(chapter, sections, cast, lore);
  // 这一章好了：把它挂着的旧感叹号收掉（上次可能是超时/解析失败）。
  await clearFailures(project, 'chapter', chapter.relPath, 'summarize');
  // 批量同步一次要跑几十章，是最烧 token 的动作之一；有实测用量就记一笔，
  // 供 tokenCounter 的校准统计使用。
  recordUsage('定稿', estimated, usage);
  const usageNote = describeUsage(estimated, usage);
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》细纲已照正文更新`,
    `${relPath}｜耗时 ${elapsed(startedAt)}｜返回 ${raw.length} 字｜` +
      `出场 ${cast.length} 人${cast.length > 0 ? `（${cast.map((c) => c.name).join('、')}）` : ''}` +
      `｜连续性事实 ${facts.length} 条｜设定 ${lore.length} 条` +
      `${trashed ? `｜旧版已放进回收站：${trashed}` : '｜原来没有细纲，新建了一份'}` +
      `${usageNote ? `｜${usageNote}` : ''}`
  );
  return { relPath, trashed, sections, cast, lore, facts, dropped };
}

/**
 * 当前细纲 → 发给模型的那一段（`## 小节` 一节一段）。一节都没填（只起了个头的空壳）给空串——
 * 那时照正文从头整理。连续性事实不给：那是上一次定稿从正文里摘的，证据要回原文逐字校验，
 * 这一次照样从正文重新摘，把旧的给它只会让它照抄已经对不上的句子。第九节「设定」给：那是计划用到的，
 * 要改成实际出现的。
 */
function renderPlanForPrompt(plan: Plot): string {
  const sections = PLOT_SECTION_KEYS.filter((key) => key !== '连续性事实' && plan.sections[key].trim()).map(
    (key) => `## ${key}\n${plan.sections[key].trim()}`
  );
  if (sections.length === 0) {
    return '';
  }
  if (plan.lore?.length) {
    sections.push(`## ${PLOT_LORE_KEY}\n${renderLoreLines(plan.lore)}`);
  }
  return sections.join('\n\n');
}

/**
 * 「已有角色卡」提示段。没有角色卡时返回空串（不要为此多占几十 token）。
 *
 * 只给名字与别名，不给卡的内容——这里要的是**统一命名**，不是让模型
 * 照着角色卡复述剧情。角色卡本身在「更新角色卡」那条流程里才完整注入。
 */
async function knownNamesHint(project: NovelProject): Promise<string> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    return '';
  }
  const list = cards
    .map((c) => {
      const aliases = sanitizeAliases(c.aliases, c.name);
      return aliases.length > 0 ? `${c.name}（又称 ${aliases.join('、')}）` : c.name;
    })
    .join('、');
  return `已有角色卡：${list}。出场人物中若出现这些人，name 请与此处完全一致。\n\n`;
}


/**
 * 工程页黄条上的「立即同步」：把所有没定稿、或定稿之后正文又改过的章逐章定稿，带进度，可取消。三步与单章定稿
 * 同一套（finalize.ts）：
 *
 * 1. 照正文更新细纲：各章之间无先后，按配置并发（`summarizeChapters`）；
 * 2. 角色状态、叙事线（finalizeSteps.ts）：**按章号串行**——角色卡的「当前状态」要一章一章往后推，
 *    叙事线事件按章追加，并发会两章抢写同一张卡、同一份 `threads.md`。第一步没成的章不走这两步。
 *
 * 从前只做第一步，章被标成已定稿、角色状态与叙事线却停在原地，而同步过的章不再「待定稿」，黄条也不会
 * 再提醒，只能逐章重新定稿去补。中途取消时，细纲已经更新、这两步还没走到的章挂黄 ❗（第 16 条：部分完成）。
 *
 * 返回**实际调用了几次模型**（取消或无事可做时是 0）——MCP 的 `summary` 工具拿它记账。
 */
export async function syncSummaries(project: NovelProject): Promise<number> {
  log.info('开始检查哪些章还没定稿');
  const scanStart = Date.now();
  const stale = await project.staleChapters();
  const total = (await project.listChapters()).length;
  log.info(
    `检查完成：${total} 章中有 ${stale.length} 章没定稿或定稿后正文改过`,
    `耗时 ${elapsed(scanStart)}${stale.length > 0 ? `｜待定稿：${describeNos(stale)}` : ''}`
  );

  if (stale.length === 0) {
    getHost().toast('所有写了正文的章都已定稿，细纲与正文对得上。');
    return 0;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, stale.length);
  const each = FINALIZE_CALLS;
  const calls: CallEstimate = { low: stale.length * each.low, high: stale.length * each.high, max: stale.length * each.max };
  const confirm = await getHost().confirm(
    `有 ${stale.length} 章写了正文还没定稿（或定稿后正文又改过），逐章定稿：照正文更新细纲、更新出场角色的当前状态、记下推进了哪几条叙事线。${describeCalls(calls)}。现在同步？`,
    ['开始同步'],
    {
      modal: true,
      detail:
        `每章 ${each.low}–${each.high} 次（${each.why}）。\n` +
        `${describeTaskModels(config, 'plotSummary')}\n${describeTaskModels(config, 'characterCard')}\n` +
        (lanes > 1 ? `照正文更新细纲并发 ${lanes} 路；` : '照正文更新细纲逐章串行（并发数为 1）；') +
        '角色状态与叙事线按章号逐章串行（要一章一章往后推）。\n每章的旧版细纲先复制一份进 .novelforge/.trash/。',
    }
  );
  if (confirm !== '开始同步') {
    log.info('用户取消了同步');
    return 0;
  }

  const pool = await createModelPool({ task: 'plotSummary', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，同步中止');
    return 0;
  }
  // 角色状态走「角色卡」档（与批量写章「写完即定稿」同一个分法），没配就沿用定稿那一档。
  const statePool = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? pool;
  log.info(`使用模型 ${pool.label}`, lanes > 1 ? `并发 ${lanes} 路，轮转负载均衡` : '串行');

  let used = 0;
  await runTask(
    '同步章节细纲',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const { ok: okCount, failed, updated } = await summarizeChapters(project, stale, { pool, lanes, signal, report });
      used += okCount + failed.length;
      if (signal.aborted) {
        log.warn(`同步被取消，已更新 ${okCount} 章细纲，角色状态与叙事线一章都没走`);
        await markHalfDone(project, updated);
        return;
      }

      // 第二步：按章号串行（updated 已按章号排好）。
      const partial: number[] = [];
      for (let i = 0; i < updated.length; i++) {
        const { chapter, summary } = updated[i];
        report({ message: `角色状态与叙事线 · 第 ${chapter.order} 章《${chapter.title}》`, current: i, total: updated.length });
        try {
          const rest = await updateStateAndThreads(project, chapter, summary.cast, {
            state: statePool,
            threads: pool,
            signal,
          });
          used += rest.calls;
          if (rest.stateError || rest.threadsError) {
            partial.push(chapter.order);
          }
        } catch (err) {
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`同步被取消，停在第 ${chapter.order} 章的角色状态与叙事线`);
            await markHalfDone(project, updated.slice(i));
            return;
          }
          throw err;
        }
      }

      report({ message: '收尾', current: updated.length, total: updated.length });
      const notes = [
        failed.length > 0 ? `第 ${failed.map((f) => f.no).join('、')} 章细纲没更新成` : '',
        partial.length > 0 ? `第 ${partial.join('、')} 章的角色状态或叙事线没更新成（挂了黄 ❗）` : '',
      ].filter(Boolean);
      if (notes.length > 0) {
        log.warn(
          `同步结束：定稿 ${okCount} 章，${notes.join('；')}`,
          failed.map((f) => `第 ${f.no} 章：${f.reason}`).join('\n')
        );
        getHost().toast(`定稿 ${okCount} 章；${notes.join('；')}，可在日志页看原因。`);
      } else if (okCount > 0) {
        log.info(`同步结束：${okCount} 章全部定稿`, `总耗时 ${elapsed(startedAt)}`);
        getHost().toast(`已定稿 ${okCount} 章：细纲照正文更新，角色状态与叙事线跟到了这几章。`);
      }
    },
    { scope: '定稿' }
  );
  return used;
}

/**
 * 同步中途停下：细纲已经照正文更新（这几章不再「待定稿」，黄条不会再提醒），角色状态与叙事线还没走到。
 * 挂黄 ❗ 在章节上，说清要重新定稿这一章才补得上（单章定稿成功时 `clearFailures` 会把它清掉）。
 */
async function markHalfDone(project: NovelProject, left: readonly { chapter: Chapter }[]): Promise<void> {
  for (const { chapter } of left) {
    await recordFailure(project, {
      scope: '定稿',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: STATE_OP,
      message: '同步中途停了：细纲已照正文更新，角色状态与叙事线还没跟上',
      detail: '右键这一章「定稿」重新定稿一次，角色状态与叙事线就补上了。',
    });
  }
}

/**
 * 并发照正文更新这几章的细纲：`syncSummaries` 与「从已写正文补齐」（features/derive.ts）共用。
 * **不弹框、不开任务**，确认与进度条归调用方。失败的挂在那一章上（第 16 条），按章号排好交回去；
 * 取消的不算失败。更新成了的连同第一步的结果（出场人物）也按章号交回去，同步拿它接着走角色状态与叙事线。
 */
export async function summarizeChapters(
  project: NovelProject,
  stale: readonly Chapter[],
  opts: {
    pool: ModelPool;
    lanes: number;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{
  ok: number;
  failed: { no: number; reason: string }[];
  updated: { chapter: Chapter; summary: SummaryOutcome }[];
}> {
  const { pool, lanes, signal, report } = opts;
  const startedAt = Date.now();
  const failed: { no: number; reason: string }[] = [];
  const updated: { chapter: Chapter; summary: SummaryOutcome }[] = [];
  // 并发下「正在跑哪几章」是变动的，用一个集合维护，报进度时现拼。
  const running = new Set<number>();
  let done = 0;
  let okCount = 0;
  report({ message: '准备中…', current: 0, total: stale.length });

  const describeRunning = (): string =>
    lanes > 1
      ? `已完成 ${done}/${stale.length} · ${running.size} 路进行中（第 ${[...running]
          .sort((a, b) => a - b)
          .join('、')} 章）`
      : '';

  await runPool(
    [...stale],
    lanes,
    (chapter) =>
      pool.run(`第 ${chapter.order} 章`, (llm) =>
        summarizeChapter(project, chapter, llm, signal, pool.primaryBudget)
      ),
    {
      signal,
      onStart: (chapter) => {
        running.add(chapter.order);
        report({
          message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
          current: done,
          total: stale.length,
        });
      },
      onSettled: (result, chapter, _index, finished) => {
        running.delete(chapter.order);
        done = finished;
        if (result.status === 'fulfilled') {
          okCount++;
          // 空章、没有可用的模型时第一步交回 undefined（已经说过原因），没有可接着走的。
          if (result.value) {
            updated.push({ chapter, summary: result.value });
          }
        } else {
          const err = result.reason;
          if (!(err instanceof CancelledError || err?.name === 'CancelledError')) {
            const reason = describeError(err);
            failed.push({ no: chapter.order, reason });
            log.error(`第 ${chapter.order} 章《${chapter.title}》失败：${reason}`, err);
            // toast 里只列得下章号，而它五秒就没了。挂到那一行上，
            // 用户第二天回来还能看出是哪几章没更新成。
            void recordFailure(project, {
              scope: '定稿',
              targetKind: 'chapter',
              targetKey: chapter.relPath,
              severity: 'error',
              op: 'summarize',
              message: `细纲没能照正文更新：${reason}`,
              detail: '这一章的连续性事实与出场人物不会进入上下文。可右键「定稿」单独重试。',
            });
          }
        }
        // 每章一条 info：一次跑几十章，中途出问题时要看得出停在哪。
        const perItem = (Date.now() - startedAt) / done;
        log.info(
          `进度 ${done}/${stale.length}`,
          `刚完成第 ${chapter.order} 章；平均 ${formatDuration(perItem)}/章，` +
            `预计剩余 ${formatDuration(perItem * (stale.length - done))}`
        );
        report({
          message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
          current: done,
          total: stale.length,
        });
      },
    }
  );
  // 完成顺序是乱的，汇报前按章号排回来——「第 7、3、12 章失败」没法读。
  failed.sort((a, b) => a.no - b.no);
  updated.sort((a, b) => a.chapter.order - b.chapter.order);
  return { ok: okCount, failed, updated };
}

/**
 * 「细纲路径或章节路径」→ 那一章的成品。
 *
 * 定稿读的是**正文**，而作者点过来的路径可能是任意一侧：工程页那一行同时
 * 代表细纲与正文。先按路径直接找，找不到再按文件名里的章号找（细纲号 = 章号）——
 * 后者覆盖「传的是细纲、正文另有其名」这种正常情况。还没有正文时返回
 * undefined，调用方据此说「这一章还没有正文」。
 *
 * 放在这里而不是各调用方各写一份：工程页、命令面板与 MCP 的 `summary` 工具
 * 都要问同一个问题，答案分叉了就会出现「工程页定稿得了、agent 说找不到」。
 */
export async function chapterForSummary(
  project: NovelProject,
  relPath: string
): Promise<Chapter | undefined> {
  const chapters = await project.listChapters();
  const direct = chapters.find((ch) => ch.relPath === relPath);
  if (direct) {
    return direct;
  }
  // 细纲镜像正文的路径：镜像对得上的那一章最准（同号的正文有两份也认得出），对不上再按号认。
  const mirrored = chapters.find((ch) => project.plotPathForChapter(ch.relPath) === relPath);
  if (mirrored) {
    return mirrored;
  }
  const no = parsePlotFileName(basename(relPath))?.no;
  return no === undefined ? undefined : chapters.find((ch) => ch.order === no);
}

/** `1、2、3…（共 76 章）`——待办列表太长时只列前几个。 */
function describeNos(chapters: Chapter[]): string {
  const head = chapters.slice(0, 12).map((c) => c.order).join('、');
  return chapters.length > 12 ? `${head}…（共 ${chapters.length} 章）` : head;
}

/** {@link updateGlobalSummary} 的结果。 */
export interface GlobalSummaryUpdate {
  calls: number;
  /** 更新之后覆盖到第几章。 */
  through?: number;
  /** 没更新的原因（零调用）。 */
  skipped?: string;
}

/**
 * 增量更新全书滚动摘要：旧摘要 + 它覆盖到的那一章之后、定稿过的各章的细纲，**1 次调用**出新的一版。
 * 批量写章「写完即定稿」每落后 `GLOBAL_SUMMARY_EVERY` 章调一次（百章实验里全书摘要从没生成过——
 * 它只有作者手动点「重建」这一个入口）。还没有旧摘要时就从第 1 章起汇总；新章太多、一次放不下时
 * 只并入放得下的前面那几章，`through` 停在那里，下一次接着并。不弹框、不开任务；调用失败抛错。
 */
export async function updateGlobalSummary(
  project: NovelProject,
  runner: {
    run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
    readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
  },
  signal?: AbortSignal
): Promise<GlobalSummaryUpdate> {
  const manifest = await project.readManifest();
  const old = (await project.readGlobalSummary()).trim();
  const fresh = old && !/尚未生成/.test(old);
  const since = fresh ? manifest.globalSummaryThrough ?? 0 : 0;
  const units: { no: number; title: string; content: string }[] = [];
  for (const chapter of (await project.listChapters()).sort((a, b) => a.order - b.order)) {
    if (chapter.order <= since || chapter.wordCount <= 0) {
      continue;
    }
    const plot = await project.finalizedPlotOf(chapter);
    const content = plot ? plotDigest(plot) : '';
    // 一章没定稿就停在它前面：全书摘要是按时间顺序的主线，跳过一章就缺一块。
    if (!content) {
      break;
    }
    units.push({ no: chapter.order, title: chapter.title, content });
  }
  if (units.length === 0) {
    return { calls: 0, skipped: `第 ${since} 章之后还没有定稿过的章` };
  }

  const budget = runner.primaryBudget;
  const inputBudget = Math.max(4000, budget.contextWindow - budget.maxOutputTokens - 2000) - estimateTokens(old);
  const blocks: string[] = [];
  let used = 0;
  let through = since;
  for (const u of units) {
    const block = `【第${u.no}章 ${u.title}】\n${u.content}`;
    const cost = estimateTokens(block);
    if (blocks.length > 0 && used + cost > inputBudget) {
      globalLog.warn('新定稿的章太多，这一次只并入前面几章', `并到第 ${through} 章，后面的下一次再并`);
      break;
    }
    blocks.push(block);
    used += cost;
    through = u.no;
  }
  const span = units[0].no === through ? `第 ${through} 章` : `第 ${units[0].no}–${through} 章`;
  const user = fresh
    ? `以下是目前的全书滚动摘要（截至第 ${since} 章），以及之后${span}定稿过的逐章细纲。请在旧摘要上并入这几章，输出一份新的全书滚动摘要。\n\n# 目前的全书滚动摘要\n\n${old}\n\n# 新定稿的逐章细纲\n\n${blocks.join('\n\n')}`
    : `以下是${span}定稿过的逐章细纲，请汇总成一份全书滚动摘要。\n\n${blocks.join('\n\n')}`;
  const config = readConfig();
  const startedAt = Date.now();
  const text = await runner.run('更新全书摘要', (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: GLOBAL_SYSTEM },
          { role: 'user', content: user },
        ],
        { maxOutputTokens: budget.maxOutputTokens, temperature: 0.3, timeoutMs: config.requestTimeoutMs, signal }
      )
    )
  );
  if (!text.trim()) {
    throw new Error('模型返回的全书摘要是空的');
  }
  await new Workspace(project).writeGlobalSummary(text.trim(), through);
  globalLog.info(`全书摘要已更新到第 ${through} 章`, `并入${span}｜${text.trim().length} 字｜用时 ${elapsed(startedAt)}`);
  return { calls: 1, through };
}

/**
 * 一份定稿过的细纲交给全书摘要的那一段：有内容的小节一节一段。没内容是空串。
 * 连续性事实带着证据原句，与全书主线无关，不给。
 */
function plotDigest(plot: Plot): string {
  return PLOT_SECTION_KEYS.filter((key) => key !== '连续性事实' && plot.sections[key].trim())
    .map((key) => `### ${key}\n${plot.sections[key].trim()}`)
    .join('\n\n');
}

/**
 * map-reduce 重建全书摘要。
 *
 * 定稿过的各章细纲按 summaryBatchSize 分批 reduce 成阶段摘要，再把阶段摘要合并成
 * 一份全书摘要。这样即便有几百章，也不会一次性把所有细纲塞进窗口。
 */
export async function rebuildGlobalSummary(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    globalLog.warn('还没有章节，无法重建全书摘要');
    getHost().toast('还没有章节。');
    return;
  }

  const stale = await project.staleChapters();
  if (stale.length > 0) {
    globalLog.warn(`有 ${stale.length} 章没定稿或定稿后正文改过`, `待同步：${describeNos(stale)}`);
    const pick = await getHost().confirm(
      `有 ${stale.length} 章的细纲还没照正文更新（没定稿，或定稿后正文又改过），直接重建会缺这些章的信息。`,
      ['先同步细纲', '仍然重建'],
      { modal: true }
    );
    if (!pick) {
      globalLog.info('用户取消了重建');
      return;
    }
    globalLog.info(`用户选择「${pick}」`);
    if (pick === '先同步细纲') {
      await syncSummaries(project);
    }
  }

  const config = readConfig();

  // 收集定稿过的细纲。定稿之后正文又改过的照样收（上面已经问过要不要先同步），
  // 从没定稿过的只是计划，不进全书摘要。
  const units: { no: number; title: string; content: string }[] = [];
  const missing: number[] = [];
  for (const chapter of chapters) {
    const plot = await project.plotOfChapter(chapter);
    const content = plot?.sourceHash ? plotDigest(plot) : '';
    if (content) {
      units.push({ no: chapter.order, title: chapter.title, content });
    } else {
      missing.push(chapter.order);
    }
  }
  if (units.length === 0) {
    globalLog.error('没有任何定稿过的章，重建中止');
    getHost().toast('还没有任何一章定稿过，请先定稿，或运行「同步过期细纲」。');
    return;
  }
  if (missing.length > 0) {
    // 「不静默截断」：少了哪几章必须说出来，否则全书摘要凭空缺一块。
    globalLog.warn(
      `${missing.length} 章没定稿过，不会进入全书摘要`,
      `缺失章：${missing.slice(0, 20).join('、')}${missing.length > 20 ? `…（共 ${missing.length} 章）` : ''}`
    );
  }

  const batches = chunk(units, Math.max(3, config.summaryBatchSize));
  const lanes = Math.min(config.concurrency, batches.length);
  // 两个池，两档：分批汇总是几十次「把 15 章细纲压成一段」的体力活，
  // 最终合并全书只做一次却要跨几十万字取舍主线。这正是分档最大的收益点。
  const stagePool = await createModelPool({ task: 'globalSummaryStage', concurrent: lanes > 1 });
  if (!stagePool) {
    globalLog.error('没有可用的模型，重建中止');
    return;
  }
  // 只有一批时根本不合并，不必为此构造第二个池（也不必弹它的 Key 输入框）。
  const mergePool =
    batches.length > 1 ? await createModelPool({ task: 'globalSummaryMerge', concurrent: false }) : stagePool;
  if (!mergePool) {
    globalLog.error('没有可用的模型，重建中止');
    return;
  }
  globalLog.info(
    `准备重建：${units.length} 章细纲分 ${batches.length} 批`,
    `分批汇总 ${stagePool.label}｜最终合并 ${mergePool.label}｜每批 ${Math.max(3, config.summaryBatchSize)} 章｜` +
      (lanes > 1 ? `汇总阶段并发 ${lanes} 路` : '汇总阶段串行')
  );

  await runTask(
    '重建全书摘要',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const options: StreamOptions = {
        maxOutputTokens: stagePool.primaryBudget.maxOutputTokens,
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };

      // 合并那一步也算一格进度，否则最后一批跑完进度条会停在 100% 干等。
      const steps = batches.length + (batches.length > 1 ? 1 : 0);

      // ---- map：每批 reduce 成阶段摘要 ----
      // 各批彼此独立（只有最后的合并才要全部到齐），因此按配置并发。
      // runPool 的结果按 index 对齐，阶段小节的先后不会因完成顺序而乱。
      let mapped = 0;
      const rangeOf = (batch: typeof batches[number]): string =>
        `第 ${batch[0].no} - ${batch[batch.length - 1].no} 章`;

      const results = await runPool(
        batches,
        lanes,
        async (batch) => {
          const range = rangeOf(batch);
          const joined = batch.map((u) => `【第${u.no}章 ${u.title}】\n${u.content}`).join('\n\n');
          const each = Date.now();
          globalLog.debug(`汇总 ${range}`, `${batch.length} 章细纲，约 ${estimateTokens(joined)} token`);
          const text = await stagePool.run(range, (llm) =>
            collectText(
              llm.stream(
                [
                  { role: 'system', content: STAGE_SYSTEM },
                  { role: 'user', content: `以下是${range}定稿过的逐章细纲，请汇总成阶段摘要。\n\n${joined}` },
                ],
                options
              )
            )
          );
          globalLog.info(`阶段摘要完成（${range}）`, `产出 ${text.trim().length} 字，用时 ${elapsed(each)}`);
          return `## ${range}\n\n${text.trim()}`;
        },
        {
          signal,
          onStart: (batch) => report({ message: `汇总 ${rangeOf(batch)}`, current: mapped, total: steps }),
          onSettled: (_result, _batch, _index, finished) => {
            mapped = finished;
            report({ current: mapped, total: steps });
          },
        }
      );

      if (signal.aborted) {
        globalLog.warn(`重建被取消，已汇总 ${mapped}/${batches.length} 批`);
        return;
      }

      // 「不静默截断」：某一批失败时全书摘要会凭空缺一块，必须说出来。
      const stageSummaries: string[] = [];
      const lost: string[] = [];
      for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled') {
          stageSummaries.push(r.value);
        } else {
          lost.push(`${rangeOf(batches[i])}：${describeError(r.reason)}`);
        }
      }
      if (lost.length > 0) {
        globalLog.error(`${lost.length} 批汇总失败，这几章不会进入全书摘要`, lost.join('\n'));
        getHost().toast(`${lost.length} 批汇总失败，全书摘要会缺这几章，详见日志页。`, 'error');
      }
      if (stageSummaries.length === 0) {
        globalLog.error('所有批次都汇总失败，全书摘要未改动');
        return;
      }

      // ---- reduce：阶段摘要合并成全书摘要 ----
      let finalText: string;
      if (stageSummaries.length === 1) {
        finalText = stageSummaries[0].replace(/^## .*\n+/, '');
        globalLog.debug('只有一批，直接用阶段摘要作为全书摘要');
      } else {
        report({ message: '合并为全书摘要', current: batches.length, total: steps });
        const combined = stageSummaries.join('\n\n');
        // 合并这一步用**精标档**的窗口：它和分批汇总很可能不是同一个模型。
        const mergeBudget = mergePool.primaryBudget;
        const inputBudget = Math.max(4000, mergeBudget.contextWindow - mergeBudget.maxOutputTokens - 2000);
        const clipped = takeHead(combined, inputBudget);
        if (clipped.length < combined.length) {
          globalLog.warn(
            '阶段摘要总量超出输入预算，合并时已截断',
            `${combined.length} 字 → ${clipped.length} 字（预算 ${inputBudget} token）。` +
              '可把「全书摘要批大小」调大以减少批数。'
          );
        }
        const mergeStart = Date.now();
        globalLog.debug(`合并 ${stageSummaries.length} 份阶段摘要`, `约 ${estimateTokens(clipped)} token`);
        finalText = await mergePool.run('合并全书摘要', (llm) =>
          collectText(
            llm.stream(
              [
                { role: 'system', content: GLOBAL_SYSTEM },
                {
                  role: 'user',
                  content: `以下是各阶段摘要，请合并成一份全书滚动摘要。\n\n${clipped}`,
                },
              ],
              { ...options, maxOutputTokens: mergeBudget.maxOutputTokens }
            )
          )
        );
        globalLog.info('阶段摘要已合并', `产出 ${finalText.trim().length} 字，用时 ${elapsed(mergeStart)}`);
      }

      const through = units[units.length - 1].no;
      const relPath = await new Workspace(project).writeGlobalSummary(finalText.trim(), through);
      report({ message: '完成', current: steps, total: steps });
      globalLog.info(
        `全书摘要已重建，覆盖至第 ${through} 章`,
        `${relPath}｜${finalText.trim().length} 字（约 ${estimateTokens(finalText)} token）｜总耗时 ${elapsed(startedAt)}`
      );
      getHost().toast(`全书摘要已重建，覆盖至第 ${through} 章（约 ${estimateTokens(finalText)} token）。`);
      await getHost().openFile(project.relPath(project.globalSummaryPath));
    },
    { scope: '全书摘要' }
  );
}

// ---------------------------------------------------------------- 解析

/**
 * 从模型返回中解析出定稿后的八节。
 *
 * 两层，解析不出来就什么都不收：
 *
 * 1. **JSON**（提示词要求的形状）。字段缺失、类型不对、数组/字符串混用
 *    都逐字段兜住，不整体作废；多出来的尾逗号自己去掉再解析一次。
 * 2. **Markdown 小节**。模型忽略 JSON 要求、照着细纲的样子写回来时走这条。
 *
 * 从前还有第三层「全文塞进梗概」。那时写坏的是一份单独的摘要；现在定稿写回的就是这一章的
 * 细纲，全文塞进梗概等于拿一段没解析开的 JSON 换掉作者的计划，还记上 `sourceHash` 让这一章
 * 看起来已经定稿。所以两层都不中就返回空的八节，由 {@link summarizeChapter} 报失败、细纲不动。
 *
 * `cast` 只在 JSON 路径上有结构化来源；其余路径从「出场人物」小节的文本反解。
 */
export function parseSummaryResponse(raw: string): SummaryData {
  const cleaned = stripCodeFence(raw);

  const fromJson = parseSummaryJson(cleaned);
  if (fromJson) {
    return fromJson;
  }

  const sections = parseSummarySections(cleaned);
  return {
    sections,
    cast: castFromText(sections.出场人物),
    lore: parseLoreLines(pickSections(cleaned, [PLOT_LORE_KEY])[PLOT_LORE_KEY]),
  };
}

/**
 * JSON 路径。返回 undefined 表示「这不是我们要的 JSON」，由调用方降级。
 *
 * 判据是**梗概或关键事件至少有一个非空**：模型有时会吐出一个语法合法但
 * 完全不相干的 JSON（比如把正文包成 `{"text": "..."}`），那种东西认下来
 * 会得到一份空细纲并且不再降级，比解析失败更糟。
 */
function parseSummaryJson(text: string): SummaryData | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    try {
      data = JSON.parse(stripTrailingCommas(jsonText));
    } catch {
      return undefined;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;

  const sections = emptyPlotSections();
  for (const key of PLOT_SECTION_KEYS) {
    sections[key] = toSectionText(obj[key]);
  }
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    return undefined;
  }

  const cast = parseCastField(obj.出场人物 ?? obj.cast);
  // 「出场人物」小节是给人看的，从结构化 cast 渲染回来，保证两者一致。
  // 模型如果把这一节写成了别的文本，以 cast 为准——它才是后续功能吃的那份。
  if (cast.length > 0) {
    sections.出场人物 = cast.map(renderCastEntry).join('、');
  }
  return { sections, cast, lore: loreLinesFromJson(obj[PLOT_LORE_KEY] ?? obj.settings) };
}

/**
 * `出场人物` 字段 → 结构化清单。模型的写法五花八门，都收：
 * - `["林昭", "沈氏"]`
 * - `[{ "name": "林昭", "aliases": ["阿昭"] }]`
 * - `"林昭、沈氏"`
 */
function parseCastField(v: unknown): SummaryCast[] {
  const out: SummaryCast[] = [];
  const seen = new Set<string>();
  const push = (entry: SummaryCast | undefined) => {
    if (!entry?.name || seen.has(entry.name)) {
      return;
    }
    seen.add(entry.name);
    out.push(entry);
  };

  if (typeof v === 'string') {
    return castFromText(v);
  }
  if (!Array.isArray(v)) {
    return out;
  }
  for (const item of v) {
    if (typeof item === 'string') {
      push(parseCastEntry(item));
      continue;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      continue;
    }
    const aliases = Array.isArray(obj.aliases)
      ? obj.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
      : typeof obj.aliases === 'string'
        ? obj.aliases.split(/[、,，/]/).map((a) => a.trim()).filter(Boolean)
        : [];
    // 泛称在这里就挡住，不落进细纲 frontmatter：`姐姐`/`她`/`少女` 是好几个
    // 角色的共同称呼，而 cast 的别名是 model/identity.ts 判断「谁是谁」的依据。
    push({ name, aliases: sanitizeAliases(aliases, name) });
  }
  return out;
}

/**
 * JSON 里的小节值：字符串直接用，数组渲染成无序列表（关键事件常是数组）。
 *
 * 剥围栏与抠 JSON 对象在 [parse.ts](parse.ts)（`stripCodeFence` / `extractJsonObject`）：
 * 模型输出的容错解析在这个项目里就这一套，定稿、细纲、角色卡吃的是同一批坏习惯
 * （该给字符串给了数组、该给数组给了顿号分隔的一行）。各写一份必然慢慢跑偏。
 */
export function toSectionText(v: unknown): string {
  if (typeof v === 'string') {
    return v.trim();
  }
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        // `[{ "事件": "..." }]` 这种也别丢，取第一个字符串值。
        if (typeof item === 'object' && item !== null) {
          const first = Object.values(item as Record<string, unknown>).find((x) => typeof x === 'string');
          return typeof first === 'string' ? first.trim() : '';
        }
        return '';
      })
      .filter(Boolean)
      .map((line) => (/^[-*·]/.test(line) ? line : `- ${line}`))
      .join('\n');
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

/** 从 Markdown 抽出八个固定小节（PLOT_SECTION_KEYS）。允许模型多写、少写，缺的留空。 */
function parseSummarySections(cleaned: string): PlotSections {
  const picked = pickSections<PlotSectionKey>(cleaned, PLOT_SECTION_KEYS);
  const sections = { ...emptyPlotSections(), ...picked };

  // 模型偶尔不带 `##`，改用 `梗概：xxx` 的行内写法，这里兜底一次。
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    for (const key of PLOT_SECTION_KEYS) {
      const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, 'm');
      const m = re.exec(cleaned);
      if (m) {
        sections[key] = m[1].trim();
      }
    }
  }
  return sections;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
