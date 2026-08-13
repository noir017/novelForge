import { getHost } from '../host';
import { collectStream, CancelledError, ChatOptions, LlmProvider, TokenUsage } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { resolveProvider } from '../llm/registry';
import { runPool } from '../concurrency';
import { clearFailures, recordFailure } from '../errorLog';
import { pickSections } from '../model/markdown';
import { readConfig } from '../config';
import { describeError, elapsed, formatDuration, scoped } from '../logger';
import { runTask } from '../progress';
import { NovelProject, castFromText, emptySummarySections, parseCastEntry, renderCastEntry } from '../model/project';
import { describeTaskModels } from '../model/tiers';
import { Chapter, SUMMARY_SECTION_KEYS, SummaryCast, SummarySections } from '../model/types';
import { sanitizeAliases } from '../naming';
import { describeUsage, estimateTokens, recordUsage, takeHead } from '../context/tokenizer';
import { extractJsonObject, stripCodeFence } from './parse';

const log = scoped('摘要');

/**
 * 一章摘要的结构化形态：六个固定小节 + 机器可读的出场人物清单。
 *
 * 模型现在被要求直接输出这个形状的 JSON。小节仍然保留是因为它们最终要
 * 渲染成人类可读的 Markdown（作者会翻、会手改），`cast` 则是给程序用的——
 * 角色页的聚合、角色卡的章节关联都吃它。
 */
export interface SummaryData {
  sections: SummarySections;
  cast: SummaryCast[];
}

/** 总结单章。返回是否成功写入。 */
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
): Promise<boolean> {
  const llm = provider ?? (await resolveProvider());
  if (!llm) {
    log.warn(`第 ${chapter.order} 章跳过：没有可用的模型（未配置或未录入 API Key）`);
    return false;
  }
  const config = readConfig();
  const window = budget ?? { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens };
  const text = await project.readChapterText(chapter);
  if (!text.trim()) {
    log.warn(`第 ${chapter.order} 章《${chapter.title}》是空的，跳过`);
    getHost().toast(`第 ${chapter.order} 章是空的，跳过总结。`);
    return false;
  }

  // 单章正文通常远小于窗口；极长章节按输入预算截断。
  const inputBudget = Math.max(2000, window.contextWindow - window.maxOutputTokens - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(
      `第 ${chapter.order} 章正文超出输入预算，已截断`,
      `原文 ${text.length} 字 → ${body.length} 字（预算 ${inputBudget} token）`
    );
  }

  const usage: TokenUsage = {};
  const options: ChatOptions = {
    maxOutputTokens: Math.min(window.maxOutputTokens, 1500),
    temperature: 0.3, // 摘要要稳定、可复现，压低温度
    timeoutMs: config.requestTimeoutMs,
    signal,
    onUsage: (u) => {
      if (u.inputTokens !== undefined) {
        usage.inputTokens = u.inputTokens;
      }
      if (u.outputTokens !== undefined) {
        usage.outputTokens = u.outputTokens;
      }
    },
  };

  const startedAt = Date.now();
  log.debug(
    `第 ${chapter.order} 章《${chapter.title}》请求模型`,
    `模型 ${llm.label}｜正文 ${body.length} 字（约 ${estimateTokens(body)} token）`
  );

  // 把已有角色卡的名字告诉模型：cast 里的 name 要能跟角色卡对上，
  // 「林昭」和「昭公子」各写一份会让角色页凭空多出一个人。
  const known = await knownNamesHint(project);
  const userPrompt = `${known}请为下面这一章生成摘要。\n\n【第${chapter.order}章 ${chapter.title}】\n\n${body}`;
  // 校准统计比的是「整个请求的输入」，因此估算也要含系统提示词，
  // 否则这条样本会系统性地偏低，把 tokenCounter 的比值带歪。
  const estimated = estimateTokens(SUMMARY_SYSTEM) + estimateTokens(userPrompt);

  const raw = await collectStream(
    llm.chatStream(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      options
    )
  );

  const { sections, cast } = parseSummaryResponse(raw);
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    log.error(
      `第 ${chapter.order} 章摘要解析失败：模型返回既不是 JSON 也不符合小节格式`,
      `返回 ${raw.length} 字，开头：${raw.slice(0, 300)}`
    );
    // 也在这里记一条，而不是只靠 syncSummaries 的 onSettled：右键「总结本章」
    // 走的是单章路径，那条异常会一路抛到命令外层，根本到不了批量编排里。
    // 同一章 + 同一动作只留最新一条，两条路径都记也不会重复显示。
    await recordFailure(project, {
      scope: '摘要',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'error',
      op: 'summarize',
      message: '摘要解析失败，模型返回无法解析',
      detail:
        `模型返回 ${raw.length} 字，既不是 JSON 也不符合小节格式。` +
        '这一章的剧情不会进入上下文；换个模型或稍后重试。',
    });
    throw new Error(`第 ${chapter.order} 章摘要解析失败，模型返回内容无法解析。`);
  }
  const relPath = await project.writeSummary(chapter, sections, cast);
  // 这一章好了：把它挂着的旧感叹号收掉（上次可能是超时/解析失败）。
  await clearFailures(project, 'chapter', chapter.relPath, 'summarize');
  // 批量同步一次要跑几十章，是最烧 token 的动作之一；有实测用量就记一笔，
  // 供 tokenCounter 的校准统计使用。
  recordUsage('摘要', estimated, usage);
  const usageNote = describeUsage(estimated, usage);
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》摘要已写入`,
    `${relPath}｜耗时 ${elapsed(startedAt)}｜摘要 ${raw.length} 字｜` +
      `出场 ${cast.length} 人${cast.length > 0 ? `（${cast.map((c) => c.name).join('、')}）` : ''}` +
      `${usageNote ? `｜${usageNote}` : ''}`
  );
  return true;
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


/** 批量补齐所有缺失/过期的摘要，带进度，可取消。各章之间无先后，按配置并发。 */
export async function syncSummaries(project: NovelProject): Promise<void> {
  log.info('开始检查摘要新鲜度');
  const scanStart = Date.now();
  const stale = await project.staleChapters();
  const total = (await project.listChapters()).length;
  log.info(
    `检查完成：${total} 章中有 ${stale.length} 章缺失或过期`,
    `耗时 ${elapsed(scanStart)}${stale.length > 0 ? `｜待同步：${describeOrders(stale)}` : ''}`
  );

  if (stale.length === 0) {
    getHost().toast('所有章节摘要都是最新的。');
    return;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, stale.length);
  const confirm = await getHost().confirm(
    `有 ${stale.length} 章摘要缺失或已过期，需要调用 ${stale.length} 次模型。现在同步？`,
    ['开始同步'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'chapterSummary')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。'),
    }
  );
  if (confirm !== '开始同步') {
    log.info('用户取消了同步');
    return;
  }

  const pool = await createModelPool({ task: 'chapterSummary', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，同步中止');
    return;
  }
  log.info(`使用模型 ${pool.label}`, lanes > 1 ? `并发 ${lanes} 路，轮转负载均衡` : '串行');

  await runTask(
    '同步章节摘要',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const failed: { order: number; reason: string }[] = [];
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
        stale,
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
            } else {
              const err = result.reason;
              if (!(err instanceof CancelledError || err?.name === 'CancelledError')) {
                const reason = describeError(err);
                failed.push({ order: chapter.order, reason });
                log.error(`第 ${chapter.order} 章《${chapter.title}》失败：${reason}`, err);
                // toast 里只列得下章号，而它五秒就没了。挂到章节行上，
                // 用户第二天回来还能看出是哪几章没总结成。
                void recordFailure(project, {
                  scope: '摘要',
                  targetKind: 'chapter',
                  targetKey: chapter.relPath,
                  severity: 'error',
                  op: 'summarize',
                  message: `摘要生成失败：${reason}`,
                  detail: '这一章的剧情不会进入上下文。可右键「总结本章」单独重试。',
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

      if (signal.aborted) {
        log.warn(`同步被取消，已完成 ${done}/${stale.length} 章`);
      }
      report({ message: '收尾', current: done, total: stale.length });
      // 完成顺序是乱的，汇报前按章节号排回来——「第 7、3、12 章失败」没法读。
      failed.sort((a, b) => a.order - b.order);
      if (failed.length > 0) {
        log.warn(
          `同步结束：成功 ${okCount} 章，失败 ${failed.length} 章`,
          failed.map((f) => `第 ${f.order} 章：${f.reason}`).join('\n')
        );
        getHost().toast(
          `完成 ${okCount} 章，第 ${failed.map((f) => f.order).join('、')} 章失败，可在日志页看原因。`
        );
      } else if (okCount > 0) {
        log.info(`同步结束：${okCount} 章全部成功`, `总耗时 ${elapsed(startedAt)}`);
        getHost().toast(`已同步 ${okCount} 章摘要。`);
      }
    },
    { scope: '摘要' }
  );
}

/** `1、2、3…（共 76 章）`——待办列表太长时只列前几个。 */
function describeOrders(chapters: Chapter[]): string {
  const head = chapters.slice(0, 12).map((c) => c.order).join('、');
  return chapters.length > 12 ? `${head}…（共 ${chapters.length} 章）` : head;
}

/**
 * map-reduce 重建全书摘要。
 *
 * 单章摘要按 summaryBatchSize 分批 reduce 成阶段摘要，再把阶段摘要合并成
 * 一份全书摘要。这样即便有几百章，也不会一次性把所有摘要塞进窗口。
 */
export async function rebuildGlobalSummary(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    log.warn('还没有章节，无法重建全书摘要');
    getHost().toast('还没有章节。');
    return;
  }

  const stale = await project.staleChapters();
  if (stale.length > 0) {
    log.warn(`有 ${stale.length} 章摘要缺失或过期`, `待同步：${describeOrders(stale)}`);
    const pick = await getHost().confirm(
      `有 ${stale.length} 章摘要缺失或过期，直接重建会丢失这些章节的信息。`,
      ['先同步摘要', '仍然重建'],
      { modal: true }
    );
    if (!pick) {
      log.info('用户取消了重建');
      return;
    }
    log.info(`用户选择「${pick}」`);
    if (pick === '先同步摘要') {
      await syncSummaries(project);
    }
  }

  const config = readConfig();

  // 收集可用的单章摘要
  const units: { order: number; title: string; content: string }[] = [];
  const missing: number[] = [];
  for (const chapter of chapters) {
    const summary = await project.readSummary(chapter);
    if (summary?.content.trim()) {
      units.push({ order: chapter.order, title: chapter.title, content: summary.content });
    } else {
      missing.push(chapter.order);
    }
  }
  if (units.length === 0) {
    log.error('没有任何单章摘要，重建中止');
    getHost().toast('没有任何单章摘要，请先运行「同步所有过期摘要」。');
    return;
  }
  if (missing.length > 0) {
    // 「不静默截断」：少了哪几章必须说出来，否则全书摘要凭空缺一段。
    log.warn(
      `${missing.length} 章没有摘要，不会进入全书摘要`,
      `缺失章节：${missing.slice(0, 20).join('、')}${missing.length > 20 ? `…（共 ${missing.length} 章）` : ''}`
    );
  }

  const batches = chunk(units, Math.max(3, config.summaryBatchSize));
  const lanes = Math.min(config.concurrency, batches.length);
  // 两个池，两档：分批汇总是几十次「把 15 章摘要压成一段」的体力活，
  // 最终合并全书只做一次却要跨几十万字取舍主线。这正是分档最大的收益点。
  const stagePool = await createModelPool({ task: 'globalSummaryStage', concurrent: lanes > 1 });
  if (!stagePool) {
    log.error('没有可用的模型，重建中止');
    return;
  }
  // 只有一批时根本不合并，不必为此构造第二个池（也不必弹它的 Key 输入框）。
  const mergePool =
    batches.length > 1 ? await createModelPool({ task: 'globalSummaryMerge', concurrent: false }) : stagePool;
  if (!mergePool) {
    log.error('没有可用的模型，重建中止');
    return;
  }
  log.info(
    `准备重建：${units.length} 章摘要分 ${batches.length} 批`,
    `分批汇总 ${stagePool.label}｜最终合并 ${mergePool.label}｜每批 ${Math.max(3, config.summaryBatchSize)} 章｜` +
      (lanes > 1 ? `汇总阶段并发 ${lanes} 路` : '汇总阶段串行')
  );

  await runTask(
    '重建全书摘要',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const options: ChatOptions = {
        maxOutputTokens: Math.min(stagePool.primaryBudget.maxOutputTokens, 2000),
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
        `第 ${batch[0].order} - ${batch[batch.length - 1].order} 章`;

      const results = await runPool(
        batches,
        lanes,
        async (batch) => {
          const range = rangeOf(batch);
          const joined = batch.map((u) => `【第${u.order}章 ${u.title}】\n${u.content}`).join('\n\n');
          const each = Date.now();
          log.debug(`汇总 ${range}`, `${batch.length} 章摘要，约 ${estimateTokens(joined)} token`);
          const text = await stagePool.run(range, (llm) =>
            collectStream(
              llm.chatStream(
                [
                  { role: 'system', content: STAGE_SYSTEM },
                  { role: 'user', content: `以下是${range}的逐章摘要，请汇总成阶段摘要。\n\n${joined}` },
                ],
                options
              )
            )
          );
          log.info(`阶段摘要完成（${range}）`, `产出 ${text.trim().length} 字，用时 ${elapsed(each)}`);
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
        log.warn(`重建被取消，已汇总 ${mapped}/${batches.length} 批`);
        return;
      }

      // 「不静默截断」：某一批失败时全书摘要会凭空缺一段，必须说出来。
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
        log.error(`${lost.length} 批汇总失败，这几段不会进入全书摘要`, lost.join('\n'));
        getHost().toast(`${lost.length} 批汇总失败，全书摘要会缺这几段，详见日志页。`, 'error');
      }
      if (stageSummaries.length === 0) {
        log.error('所有批次都汇总失败，全书摘要未改动');
        return;
      }

      // ---- reduce：阶段摘要合并成全书摘要 ----
      let finalText: string;
      if (stageSummaries.length === 1) {
        finalText = stageSummaries[0].replace(/^## .*\n+/, '');
        log.debug('只有一批，直接用阶段摘要作为全书摘要');
      } else {
        report({ message: '合并为全书摘要', current: batches.length, total: steps });
        const combined = stageSummaries.join('\n\n');
        // 合并这一步用**精标档**的窗口：它和分批汇总很可能不是同一个模型。
        const mergeBudget = mergePool.primaryBudget;
        const inputBudget = Math.max(4000, mergeBudget.contextWindow - mergeBudget.maxOutputTokens - 2000);
        const clipped = takeHead(combined, inputBudget);
        if (clipped.length < combined.length) {
          log.warn(
            '阶段摘要总量超出输入预算，合并时已截断',
            `${combined.length} 字 → ${clipped.length} 字（预算 ${inputBudget} token）。` +
              '可把「全书摘要批大小」调大以减少批数。'
          );
        }
        const mergeStart = Date.now();
        log.debug(`合并 ${stageSummaries.length} 份阶段摘要`, `约 ${estimateTokens(clipped)} token`);
        finalText = await mergePool.run('合并全书摘要', (llm) =>
          collectStream(
            llm.chatStream(
              [
                { role: 'system', content: GLOBAL_SYSTEM },
                {
                  role: 'user',
                  content: `以下是各阶段摘要，请合并成一份全书滚动摘要。\n\n${clipped}`,
                },
              ],
              { ...options, maxOutputTokens: Math.min(mergeBudget.maxOutputTokens, 2000) }
            )
          )
        );
        log.info('阶段摘要已合并', `产出 ${finalText.trim().length} 字，用时 ${elapsed(mergeStart)}`);
      }

      const through = units[units.length - 1].order;
      const relPath = await project.writeGlobalSummary(finalText.trim(), through);
      report({ message: '完成', current: steps, total: steps });
      log.info(
        `全书摘要已重建，覆盖至第 ${through} 章`,
        `${relPath}｜${finalText.trim().length} 字（约 ${estimateTokens(finalText)} token）｜总耗时 ${elapsed(startedAt)}`
      );
      getHost().toast(`全书摘要已重建，覆盖至第 ${through} 章（约 ${estimateTokens(finalText)} token）。`);
      await getHost().openFile(project.relPath(project.globalSummaryPath));
    },
    { scope: '摘要' }
  );
}

// ---------------------------------------------------------------- 解析

/**
 * 从模型返回中解析出结构化摘要。
 *
 * 三层降级，一层都不能少——模型不听话是常态，而摘要解析失败意味着这一章的
 * 剧情永远进不了上下文：
 *
 * 1. **JSON**（现在提示词要求的形状）。字段缺失、类型不对、数组/字符串混用
 *    都逐字段兜住，不整体作废。
 * 2. **Markdown 小节**（0.2.x 之前的提示词形状）。模型忽略 JSON 要求、
 *    改回老格式时走这条；作者手改过的摘要文件重新解析时也走这条。
 * 3. **全文塞进梗概**。信息密度低，但比丢掉整章强。
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
  return { sections, cast: castFromText(sections.出场人物) };
}

/**
 * JSON 路径。返回 undefined 表示「这不是我们要的 JSON」，由调用方降级。
 *
 * 判据是**梗概或关键事件至少有一个非空**：模型有时会吐出一个语法合法但
 * 完全不相干的 JSON（比如把正文包成 `{"text": "..."}`），那种东西认下来
 * 会得到一份空摘要并且不再降级，比解析失败更糟。
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
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;

  const sections = emptySummarySections();
  for (const key of SUMMARY_SECTION_KEYS) {
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
  return { sections, cast };
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
    // 泛称在这里就挡住，不落进摘要 frontmatter：`姐姐`/`她`/`少女` 是好几个
    // 角色的共同称呼，而 cast 的别名是 identity.ts 判断「谁是谁」的依据。
    push({ name, aliases: sanitizeAliases(aliases, name) });
  }
  return out;
}

/**
 * JSON 里的小节值：字符串直接用，数组渲染成无序列表（关键事件常是数组）。
 *
 * 与 {@link stripCodeFence} / {@link extractJsonObject} 一样对外导出：模型
 * 输出的容错解析在这个项目里就这一套，摘要、细纲、场景卡吃的是同一批坏习惯
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

/** 从 Markdown 抽出六个固定小节。允许模型多写、少写，缺的留空。 */
function parseSummarySections(cleaned: string): SummarySections {
  const picked = pickSections<keyof SummarySections>(cleaned, SUMMARY_SECTION_KEYS);
  const sections = { ...emptySummarySections(), ...picked };

  // 模型偶尔不带 `##`，改用 `梗概：xxx` 的行内写法，这里兜底一次。
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    for (const key of SUMMARY_SECTION_KEYS) {
      const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, 'm');
      const m = re.exec(cleaned);
      if (m) {
        sections[key] = m[1].trim();
      }
    }
  }
  // 实在解析不出小节，就把全文塞进梗概，至少不丢信息。
  if (!Object.values(sections).some((v) => v.trim())) {
    sections.梗概 = cleaned.trim();
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

// ---------------------------------------------------------------- 提示词

const SUMMARY_SYSTEM = `你是小说编辑，负责为长篇小说建立可检索的章节档案。

请输出一个 JSON 对象，除 JSON 外不要输出任何文字、解释或前后缀。字段如下，一个都不要少：

{
  "梗概": "用 3-5 句话概括本章发生了什么，写清因果链。",
  "出场人物": [
    { "name": "角色的正式姓名", "aliases": ["本章中对他的**专属**称呼"] }
  ],
  "时间地点": "本章的时间点（与上一章的相对关系亦可）与主要场景。",
  "关键事件": ["推动主线的事件，一条一句话"],
  "新增伏笔": ["本章埋下但尚未回收的线索、疑问、承诺"],
  "状态变更": "本章之后，主要人物的处境/关系/实力/心态发生了什么变化。"
}

关于「出场人物」——这一节会被程序读取，用来自动关联角色档案，请特别当心：
- 只列**本章确实登场或有实质动作**的人物，被别人提到一句的不算。
- name 用正式姓名；同一人在本章里的其它叫法（绰号、职称、代称）放进 aliases。
- **同一个人在全书里必须始终用同一个 name**。「已有角色卡」列表里有就照抄；
  没有就用正文里最完整的正式姓名（有姓氏就带上姓氏），此后每一章都用它，
  不要这一章写「方源」下一章写「古月方源」——程序会当成两个人各建一张档案。
- **aliases 只收专属称呼**：姓名的其它写法、绰号、独一无二的职称。
  **不要**代词（他/她）、亲属称谓（姐姐/舅父）、泛称（少女/丫头/小姐/公子）、
  带修饰语的描述（「满身血迹的少女」），也**绝不要填另一个人的名字**——
  程序拿 aliases 判断「谁是谁」，混进一个就会把两个角色认成同一个人。
- 如果「已有角色卡」列表里已有这个人，name 必须与列表中**完全一致**，不要改写。
- 没有姓名的路人（「掌柜」「老船夫」之类）若在本章有实质戏份也可以收，用正文对他的固定称呼作 name。
- 本章确实无人出场就给空数组 []。

其余要求：
- "关键事件" 与 "新增伏笔" 是字符串数组，一条一个元素，不要在元素里写编号或「-」。
- 没有内容的数组字段给 []，没有内容的字符串字段给 ""，不要写「无」。
- 客观复述，不要评价，不要剧透后续，不要使用「本章讲述了」这类套话。
- 所有内容用简体中文。`;

const STAGE_SYSTEM = `你是小说编辑，正在把一批逐章摘要压缩成一份阶段摘要，供后续写作时快速回顾。

请按以下四个小节输出（Markdown 三级标题），不要增删：

### 主线进展
这一批章节里，主线故事推进到了哪一步。按时间顺序写成连贯段落。

### 已收伏笔
这批章节里回收/揭晓了哪些此前的线索。没有则写「无」。

### 未收伏笔
这批章节新埋下、且到本批结束仍未回收的线索。逐条列出。

### 人物关系变动
主要人物的关系、处境、目标发生了哪些变化。

要求：保留具体的人名、地名、关键物件名，不要泛化成「主角遇到了危机」这种无信息量的描述。`;

const GLOBAL_SYSTEM = `你是小说编辑，正在把若干阶段摘要合并成一份全书滚动摘要。这份摘要会在每次续写时注入模型，是作者的「长期记忆」，必须信息密度高且不自相矛盾。

请按以下四个小节输出（Markdown 二级标题），不要增删：

## 主线进展
从开篇到目前的完整主线，按时间顺序写。可分段，每段对应一个阶段。

## 已收伏笔
已经回收的重要线索，一句话一条。

## 未收伏笔
仍然悬而未决的线索、疑问、承诺——这一节最重要，逐条列全，标注大致埋设章节。

## 人物关系变动
主要人物当前的处境、目标与彼此关系。

要求：
- 合并重复信息，但绝不丢失具体的人名、地名、物件名与数字。
- 如果不同阶段的描述有冲突，以更靠后的为准。
- 总长度控制在 1500 字以内。`;
