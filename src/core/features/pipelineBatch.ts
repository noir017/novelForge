/**
 * 工程页的流水线批量动作：**一次给几十章生成细纲 / 拆场景**。
 *
 * 与创作页的单次生成（features/creation.ts）是两条路，理由是它们的失败模型
 * 完全不同：创作页一次一份，出错就重来；这里一次几十份，**必须允许部分失败
 * 并跑完剩下的**——第 12 章拆不出场景不该让另外 63 章白等。
 *
 * 结构与 `syncSummaries` 逐字对齐（同一套 runTask + runPool + recordFailure +
 * 分档确认框），因为作者对这类批量动作已经有了预期：先说清要调几次模型、
 * 用哪一档，跑起来能看进度、能取消，失败的挂在那一行上第二天还看得见。
 *
 * ## 只补不改
 *
 * 两个批量动作都**跳过已经有产物的章节**，不问、不覆盖。批量路径上没有
 * 「逐个审阅」的余地——一次弹 63 个 diff 没有人看得完——所以唯一安全的
 * 做法是只处理空白的那些。要重做某一章，去创作页单独重做。
 */
import { runPool } from '../runtime/concurrency';
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { collectStream, CancelledError, ChatMessage } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { describeError, elapsed, formatDuration, scoped } from '../runtime/logger';
import { hash, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { isPlanFilled } from '../model/planFile';
import { emptySceneSections } from '../model/sceneFile';
import { describeTaskModels } from '../model/tiers';
import { buildContext } from '../context/builder';
import { Chapter } from '../model/types';
import { runTask } from '../runtime/progress';
import { planContentHash } from '../views/pipeline';
import { parsePlanStrict, parseSceneList } from './artifact';

const log = scoped('流水线');

/**
 * 给所有还没有细纲的章节各生成一份。
 *
 * 每章一次调用，各章之间没有先后依赖——第 12 章的细纲不看第 11 章的细纲，
 * 它们共同的上游是全书大纲。所以可以并发。
 */
export async function generatePlans(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  const pending: Chapter[] = [];
  for (const chapter of chapters) {
    const plan = await project.readPlan(chapter.relPath);
    // 只补不改：已经填过的一律跳过，哪怕上游变了。批量路径上没有审阅的余地。
    if (!plan || !isPlanFilled(plan.sections)) {
      pending.push(chapter);
    }
  }

  if (pending.length === 0) {
    getHost().toast('每一章都已经有细纲了。');
    return;
  }
  const outline = await project.readOutline();
  if (!outline.trim()) {
    // 没有大纲就生成细纲，等于让模型凭空编四十章剧情——那不是作者要的。
    log.warn('全书大纲是空的，批量生成细纲已中止');
    getHost().toast('全书大纲还是空的。先写一份大纲，细纲才有依据。', 'error');
    return;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章还没有细纲，需要调用 ${pending.length} 次模型。现在生成？`,
    ['开始生成'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'chapterPlan')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。') +
        '\n已经写过细纲的章节不会被改动。',
    }
  );
  if (confirm !== '开始生成') {
    log.info('用户取消了批量生成细纲');
    return;
  }

  const pool = await createModelPool({ task: 'chapterPlan', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量生成细纲中止');
    return;
  }
  const outlineHash = hash(outline);

  await runBatch(project, {
    title: '批量生成细纲',
    items: pending,
    lanes,
    op: 'chapterPlan',
    what: '细纲',
    run: async (chapter, signal) => {
      const messages = await buildContextFor(project, chapter, config, 'generate');
      const raw = await pool.run(`第 ${chapter.order} 章`, (llm) =>
        collectStream(
          llm.chatStream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      const sections = parsePlanStrict(raw);
      // 严格解析：批量路径上没有人逐份过目，全文兜底会把模型的一句
      // 「我不太确定这一章写什么」变成一份「已规划」的细纲，紧接着的
      // 批量拆场景还会照着它往下拆。
      if (!sections || !isPlanFilled(sections)) {
        throw new Error('模型返回的内容里解析不出细纲');
      }
      const existing = await project.readPlan(chapter.relPath);
      await project.writePlan(chapter.relPath, {
        chapterRelPath: chapter.relPath,
        order: chapter.order,
        title: chapter.title,
        arc: existing?.arc ?? '',
        targetWords: existing?.targetWords,
        upstreamHash: outlineHash,
        done: false,
        sections,
      });
    },
  });
}

/**
 * 给所有「细纲写好了但还没拆场景」的章节各拆一次。
 *
 * 判据是**细纲已填**：没有细纲就拆场景，模型只能照着章节标题瞎编，
 * 拆出来的东西作者一场都留不下。
 */
export async function breakdownScenes(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  const pending: Chapter[] = [];
  let noPlan = 0;
  for (const chapter of chapters) {
    const plan = await project.readPlan(chapter.relPath);
    if (!plan || !isPlanFilled(plan.sections)) {
      noPlan++;
      continue;
    }
    if ((await project.listScenes(chapter.relPath)).length === 0) {
      pending.push(chapter);
    }
  }

  if (pending.length === 0) {
    getHost().toast(
      noPlan > 0
        ? `没有可拆的章节。还有 ${noPlan} 章没写细纲——先生成细纲再来拆场景。`
        : '每一章都已经拆过场景了。'
    );
    return;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章的细纲已写好但还没拆场景，需要调用 ${pending.length} 次模型。现在拆？`,
    ['开始拆分'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'sceneBreakdown')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。') +
        '\n已经拆过场景的章节不会被改动。' +
        (noPlan > 0 ? `\n另有 ${noPlan} 章还没写细纲，这次跳过。` : ''),
    }
  );
  if (confirm !== '开始拆分') {
    log.info('用户取消了批量拆分场景');
    return;
  }

  const pool = await createModelPool({ task: 'sceneBreakdown', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量拆分场景中止');
    return;
  }

  await runBatch(project, {
    title: '批量拆分场景',
    items: pending,
    lanes,
    op: 'sceneBreakdown',
    what: '场景',
    run: async (chapter, signal) => {
      const messages = await buildContextFor(project, chapter, config, 'split');
      const raw = await pool.run(`第 ${chapter.order} 章`, (llm) =>
        collectStream(
          llm.chatStream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      const scenes = parseSceneList(raw);
      if (scenes.length === 0) {
        throw new Error('模型返回的内容里解析不出场景清单');
      }
      const plan = await project.readPlan(chapter.relPath);
      const upstreamHash = plan ? planContentHash(plan) : '';
      let no = 0;
      for (const item of scenes) {
        no++;
        await project.writeScene(chapter.relPath, {
          chapterRelPath: chapter.relPath,
          no,
          title: sanitizeFileName(item.title) || `场景${no}`,
          place: item.place,
          time: item.time,
          characters: item.characters,
          targetWords: item.targetWords,
          upstreamHash,
          // 刚拆出来的是壳，还没有素材。
          status: 'draft',
          sections: {
            ...emptySceneSections(),
            目的: item.goal,
          },
        });
      }
    },
  });
}

// ---------------------------------------------------------------- 共用

/**
 * 装配某一章**细纲层**的上下文。
 *
 * 走**同一个装配器**而不是在这里手拼 prompt：分阶段配方、预算封顶、
 * 角色卡降级、附件与历史的处理全都一致。批量与单次生成产出的东西
 * 因此是同一个质量，作者不会发现「工程页批量生成的细纲比创作页的差一截」。
 */
async function buildContextFor(
  project: NovelProject,
  chapter: Chapter,
  config: ReturnType<typeof readConfig>,
  capability: 'generate' | 'split'
): Promise<ChatMessage[]> {
  const built = await buildContext(
    project,
    {
      action: { stage: 'plan', capability },
      target: { kind: 'plan', chapterRelPath: chapter.relPath },
      targetOrder: chapter.order,
      // 批量路径上没有用户输入那一句话，用章节标题当锚点。
      ask:
        capability === 'split'
          ? `把第 ${chapter.order} 章《${chapter.title}》的细纲拆成场景。`
          : `为第 ${chapter.order} 章《${chapter.title}》写细纲。`,
    },
    config
  );
  return built.messages;
}

interface BatchSpec {
  title: string;
  items: Chapter[];
  lanes: number;
  /** 失败记录的 op，与清除时用的一致。 */
  op: string;
  /** 产物名，进日志与 toast（「细纲」「场景」）。 */
  what: string;
  run(chapter: Chapter, signal: AbortSignal): Promise<void>;
}

/**
 * 批量执行的外壳：进度、取消、逐项失败记录、收尾汇报。
 *
 * 抽出来是因为两个批量动作的这一段一字不差，而它们要保证的东西恰恰在这里：
 * **失败一项不影响其余**、失败挂在那一章上、取消时说清跑到哪了。
 */
async function runBatch(project: NovelProject, spec: BatchSpec): Promise<void> {
  const { items, lanes } = spec;
  await runTask(
    spec.title,
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const failed: { order: number; reason: string }[] = [];
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

      await runPool(items, lanes, (chapter) => spec.run(chapter, signal), {
        signal,
        onStart: (chapter) => {
          running.add(chapter.order);
          report({
            message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
            current: done,
            total: items.length,
          });
        },
        onSettled: (result, chapter, _index, finished) => {
          running.delete(chapter.order);
          done = finished;
          if (result.status === 'fulfilled') {
            okCount++;
            void clearFailures(project, 'chapter', chapter.relPath, spec.op);
          } else {
            const err = result.reason;
            if (!(err instanceof CancelledError || err?.name === 'CancelledError')) {
              const reason = describeError(err);
              failed.push({ order: chapter.order, reason });
              log.error(`第 ${chapter.order} 章《${chapter.title}》失败：${reason}`, err);
              // toast 五秒就没了，而一次跑几十章、失败三章是常态。
              // 挂到章节行上，第二天回来还看得出是哪几章没成。
              void recordFailure(project, {
                scope: '流水线',
                targetKind: 'chapter',
                targetKey: chapter.relPath,
                severity: 'error',
                op: spec.op,
                message: `${spec.what}生成失败：${reason}`,
                detail: `这一章的${spec.what}一字未写。可在创作页单独重试。`,
              });
            }
          }
          const perItem = (Date.now() - startedAt) / done;
          log.info(
            `进度 ${done}/${items.length}`,
            `刚完成第 ${chapter.order} 章；平均 ${formatDuration(perItem)}/章，` +
              `预计剩余 ${formatDuration(perItem * (items.length - done))}`
          );
          report({
            message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
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
      failed.sort((a, b) => a.order - b.order);
      if (failed.length > 0) {
        log.warn(
          `${spec.title}结束：成功 ${okCount} 章，失败 ${failed.length} 章`,
          failed.map((f) => `第 ${f.order} 章：${f.reason}`).join('\n')
        );
        getHost().toast(
          `完成 ${okCount} 章，第 ${failed.map((f) => f.order).join('、')} 章失败，可在日志页看原因。`
        );
      } else if (okCount > 0) {
        log.info(`${spec.title}结束：${okCount} 章全部成功`, `总耗时 ${elapsed(startedAt)}`);
        getHost().toast(`已为 ${okCount} 章生成${spec.what}。`);
      }
    },
    { scope: '流水线' }
  );
}
