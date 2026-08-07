import { getHost } from '../host';
import { collectStream, CancelledError, ChatOptions, LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { pickSections } from '../model/markdown';
import { readConfig } from '../config';
import { describeError, elapsed, formatDuration, scoped } from '../logger';
import { runTask } from '../progress';
import { NovelProject, emptySummarySections } from '../model/project';
import { Chapter, SUMMARY_SECTION_KEYS, SummarySections } from '../model/types';
import { estimateTokens, takeHead } from '../context/tokenizer';

const log = scoped('摘要');

/** 总结单章。返回是否成功写入。 */
export async function summarizeChapter(
  project: NovelProject,
  chapter: Chapter,
  provider?: LlmProvider,
  signal?: AbortSignal
): Promise<boolean> {
  const llm = provider ?? (await resolveProvider());
  if (!llm) {
    log.warn(`第 ${chapter.order} 章跳过：没有可用的模型（未配置或未录入 API Key）`);
    return false;
  }
  const config = readConfig();
  const text = await project.readChapterText(chapter);
  if (!text.trim()) {
    log.warn(`第 ${chapter.order} 章《${chapter.title}》是空的，跳过`);
    getHost().toast(`第 ${chapter.order} 章是空的，跳过总结。`);
    return false;
  }

  // 单章正文通常远小于窗口；极长章节按输入预算截断。
  const inputBudget = Math.max(2000, config.contextWindow - config.maxOutputTokens - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(
      `第 ${chapter.order} 章正文超出输入预算，已截断`,
      `原文 ${text.length} 字 → ${body.length} 字（预算 ${inputBudget} token）`
    );
  }

  const options: ChatOptions = {
    maxOutputTokens: Math.min(config.maxOutputTokens, 1500),
    temperature: 0.3, // 摘要要稳定、可复现，压低温度
    timeoutMs: config.requestTimeoutMs,
    signal,
  };

  const startedAt = Date.now();
  log.debug(
    `第 ${chapter.order} 章《${chapter.title}》请求模型`,
    `模型 ${llm.label}｜正文 ${body.length} 字（约 ${estimateTokens(body)} token）`
  );

  const raw = await collectStream(
    llm.chatStream(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: `请为下面这一章生成摘要。\n\n【第${chapter.order}章 ${chapter.title}】\n\n${body}`,
        },
      ],
      options
    )
  );

  const sections = parseSummaryResponse(raw);
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    log.error(
      `第 ${chapter.order} 章摘要解析失败：模型返回不符合小节格式`,
      `返回 ${raw.length} 字，开头：${raw.slice(0, 300)}`
    );
    throw new Error(`第 ${chapter.order} 章摘要解析失败，模型返回内容不符合小节格式。`);
  }
  const relPath = await project.writeSummary(chapter, sections);
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》摘要已写入`,
    `${relPath}｜耗时 ${elapsed(startedAt)}｜摘要 ${raw.length} 字`
  );
  return true;
}

/** 批量补齐所有缺失/过期的摘要，带进度，可取消。 */
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

  const confirm = await getHost().confirm(
    `有 ${stale.length} 章摘要缺失或已过期，需要调用 ${stale.length} 次模型。现在同步？`,
    ['开始同步'],
    { modal: true }
  );
  if (confirm !== '开始同步') {
    log.info('用户取消了同步');
    return;
  }

  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，同步中止');
    return;
  }
  log.info(`使用模型 ${provider.label}`);

  await runTask(
    '同步章节摘要',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let done = 0;
      const failed: { order: number; reason: string }[] = [];
      report({ message: '准备中…', current: 0, total: stale.length });

      for (const chapter of stale) {
        if (signal.aborted) {
          log.warn(`同步被取消，已完成 ${done}/${stale.length} 章`);
          break;
        }
        report({
          message: `第 ${chapter.order} 章《${chapter.title}》`,
          current: done,
          total: stale.length,
        });
        const each = Date.now();
        try {
          await summarizeChapter(project, chapter, provider, signal);
        } catch (err) {
          if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
            log.warn(`同步被取消，已完成 ${done}/${stale.length} 章`);
            break;
          }
          const reason = describeError(err);
          failed.push({ order: chapter.order, reason });
          log.error(`第 ${chapter.order} 章《${chapter.title}》失败：${reason}`, err);
        }
        done++;
        // 每章一条 info：一次跑几十章，中途出问题时要看得出停在哪。
        log.info(
          `进度 ${done}/${stale.length}`,
          `刚完成第 ${chapter.order} 章，用时 ${elapsed(each)}；` +
            `平均 ${formatDuration((Date.now() - startedAt) / done)}/章，` +
            `预计剩余 ${formatDuration(((Date.now() - startedAt) / done) * (stale.length - done))}`
        );
      }

      report({ message: '收尾', current: done, total: stale.length });
      const okCount = done - failed.length;
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

  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，重建中止');
    return;
  }
  const config = readConfig();

  // 收集可用的单章摘要
  const units: { order: number; title: string; content: string }[] = [];
  const missing: number[] = [];
  for (const chapter of chapters) {
    const summary = await project.readSummary(chapter.order);
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
  log.info(
    `准备重建：${units.length} 章摘要分 ${batches.length} 批`,
    `模型 ${provider.label}｜每批 ${Math.max(3, config.summaryBatchSize)} 章`
  );

  await runTask(
    '重建全书摘要',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const options: ChatOptions = {
        maxOutputTokens: Math.min(config.maxOutputTokens, 2000),
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };

      // 合并那一步也算一格进度，否则最后一批跑完进度条会停在 100% 干等。
      const steps = batches.length + (batches.length > 1 ? 1 : 0);

      // ---- map：每批 reduce 成阶段摘要 ----
      const stageSummaries: string[] = [];
      for (let i = 0; i < batches.length; i++) {
        if (signal.aborted) {
          log.warn(`重建被取消，已汇总 ${i}/${batches.length} 批`);
          return;
        }
        const batch = batches[i];
        const range = `第 ${batch[0].order} - ${batch[batch.length - 1].order} 章`;
        report({ message: `汇总 ${range}`, current: i, total: steps });

        const joined = batch
          .map((u) => `【第${u.order}章 ${u.title}】\n${u.content}`)
          .join('\n\n');
        const each = Date.now();
        log.debug(`汇总 ${range}`, `${batch.length} 章摘要，约 ${estimateTokens(joined)} token`);
        const text = await collectStream(
          provider.chatStream(
            [
              { role: 'system', content: STAGE_SYSTEM },
              { role: 'user', content: `以下是${range}的逐章摘要，请汇总成阶段摘要。\n\n${joined}` },
            ],
            options
          )
        );
        stageSummaries.push(`## ${range}\n\n${text.trim()}`);
        log.info(
          `阶段摘要 ${i + 1}/${batches.length} 完成（${range}）`,
          `产出 ${text.trim().length} 字，用时 ${elapsed(each)}`
        );
      }

      if (signal.aborted) {
        log.warn('重建被取消（合并前）');
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
        const inputBudget = Math.max(4000, config.contextWindow - config.maxOutputTokens - 2000);
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
        finalText = await collectStream(
          provider.chatStream(
            [
              { role: 'system', content: GLOBAL_SYSTEM },
              {
                role: 'user',
                content: `以下是各阶段摘要，请合并成一份全书滚动摘要。\n\n${clipped}`,
              },
            ],
            options
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

/** 从模型返回中抽出六个固定小节。允许模型多写、少写，缺的留空。 */
export function parseSummaryResponse(raw: string): SummarySections {
  const cleaned = stripCodeFence(raw);
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

export function stripCodeFence(text: string): string {
  const m = /^\s*```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text.trim());
  return (m ? m[1] : text).trim();
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

请严格按下面六个小节输出，每个小节都用 Markdown 二级标题，顺序不变，不要增删小节，不要写任何额外说明：

## 梗概
用 3-5 句话概括本章发生了什么，写清因果链。

## 出场人物
逐个列出本章出现的人物姓名（含别名），用「、」分隔。只列名字，不加描述。

## 时间地点
本章的时间点（与上一章的相对关系亦可）与主要场景。

## 关键事件
用无序列表列出推动主线的事件，每条一句话。不要列无关紧要的日常细节。

## 新增伏笔
本章埋下但尚未回收的线索、疑问、承诺。没有则写「无」。

## 状态变更
本章之后，主要人物的处境/关系/实力/心态发生了什么变化。没有则写「无」。

要求：客观复述，不要评价，不要剧透后续，不要使用「本章讲述了」这类套话。`;

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
