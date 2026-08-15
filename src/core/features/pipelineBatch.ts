/**
 * 工程页的流水线批量动作：**一次给几十章写剧情 / 拆场景 / 写正文**。
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
 * 三个批量动作都**跳过已经有产物的章**，不问、不覆盖。批量路径上没有
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
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled } from '../model/plotFile';
import { emptySceneSections, isSceneReady } from '../model/sceneFile';
import { describeTaskModels } from '../model/tiers';
import { buildContext } from '../context/builder';
import { runTask } from '../runtime/progress';
import { plotContentHash } from '../views/pipeline';
import { cleanOutput } from './creation';
import { parsePlotStrict, parseSceneList } from './artifact';
import { Capability } from '../model/pipeline';

const log = scoped('流水线');

/**
 * 给所有还没排剧情的章各写一份。
 *
 * 每章一次调用。章与章之间**有**先后关系（后一章接着前一章的局面），但装配器
 * 会把前后章的原文一起带上，所以仍然可以并发——并发改变的只是完成顺序，
 * 不改变每次调用看到的上下文。
 */
export async function generatePlots(project: NovelProject): Promise<void> {
  const pending = (await project.listPlots()).filter((p) => !isPlotFilled(p.sections));

  if (pending.length === 0) {
    getHost().toast('每一章都已经排过剧情了。');
    return;
  }
  const outline = await project.readOutline();
  if (!outline.trim()) {
    // 没有大纲就写剧情，等于让模型凭空编四十章——那不是作者要的。
    log.warn('全书大纲是空的，批量写剧情已中止');
    getHost().toast('全书大纲还是空的。先写一份大纲，剧情才有依据。', 'error');
    return;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章还没排剧情，需要调用 ${pending.length} 次模型。现在写？`,
    ['开始生成'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'plotOutline')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路。` : '串行逐章处理（并发数为 1）。') +
        '\n已经排过剧情的章不会被改动。',
    }
  );
  if (confirm !== '开始生成') {
    log.info('用户取消了批量写剧情');
    return;
  }

  const pool = await createModelPool({ task: 'plotOutline', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量写剧情中止');
    return;
  }
  const outlineHash = hash(outline);

  await runBatch(project, {
    title: '批量写剧情',
    items: pending,
    lanes,
    op: 'plotOutline',
    what: '剧情',
    run: async (plot, signal) => {
      const messages = await buildContextFor(project, plot, config, 'generate');
      const raw = await pool.run(`第 ${plot.no} 章`, (llm) =>
        collectStream(
          llm.chatStream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      // 严格解析：批量路径上没有人逐份过目，全文兜底会把模型的一句
      // 「我不太确定这一章写什么」变成一份「已规划」的剧情，紧接着的
      // 批量拆场景还会照着它往下拆。
      const sections = parsePlotStrict(raw);
      if (!sections || !isPlotFilled(sections)) {
        throw new Error('模型返回的内容里解析不出剧情');
      }
      await project.writePlot({
        no: plot.no,
        title: plot.title,
        arc: plot.arc,
        targetWords: plot.targetWords,
        upstreamHash: outlineHash,
        done: false,
        sections,
      });
    },
  });
}

/**
 * 给所有「剧情排好了但还没拆场景」的章各拆一次。
 *
 * 判据是**剧情已排**：没有剧情就拆场景，模型只能照着标题瞎编，
 * 拆出来的东西作者一场都留不下。
 */
export async function breakdownScenes(project: NovelProject): Promise<void> {
  const plots = await project.listPlots();
  const pending: Plot[] = [];
  let noPlot = 0;
  for (const plot of plots) {
    if (!isPlotFilled(plot.sections)) {
      noPlot++;
      continue;
    }
    if ((await project.listScenes(plot.relPath)).length === 0) {
      pending.push(plot);
    }
  }

  if (pending.length === 0) {
    getHost().toast(
      noPlot > 0
        ? `没有可拆的章。还有 ${noPlot} 章没排剧情——先写剧情再来拆场景。`
        : '每一章都已经拆过场景了。'
    );
    return;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章的剧情已排好但还没拆场景，需要调用 ${pending.length} 次模型。现在拆？`,
    ['开始拆分'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'sceneBreakdown')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路，各章之间没有先后依赖。` : '串行逐章处理（并发数为 1）。') +
        '\n已经拆过场景的章不会被改动。' +
        (noPlot > 0 ? `\n另有 ${noPlot} 章还没排剧情，这次跳过。` : ''),
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
    run: async (plot, signal) => {
      const messages = await buildContextFor(project, plot, config, 'split');
      const raw = await pool.run(`第 ${plot.no} 章`, (llm) =>
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
      const upstreamHash = plotContentHash(plot);
      let no = 0;
      for (const item of scenes) {
        no++;
        await project.writeScene(plot.relPath, {
          plotRelPath: plot.relPath,
          no,
          // 标题原样交给 writeScene（它自己负责清洗成文件名）。在这里先洗
          // 一遍的话，模型没给标题时会得到「未命名」——那是个假标题，
          // 而 `场景N` 才是这一层真正的回落说法。
          title: item.title.trim() || `场景${no}`,
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

/**
 * 给所有「场景都备好素材了但还没写正文」的章各写一遍正文。
 *
 * 这是三个批量动作里最贵的一个（一章几千字输出，一次几十章），所以确认框里
 * 除了调用次数还报出预计总字数——那个数字比「40 次调用」更能让人意识到
 * 这一下要花多少钱。
 *
 * **一章内部逐场串行**：第 2 场的正文要接着第 1 场的结尾写，并发跑会得到
 * 几章互相接不上的文字。章与章之间才并发。
 */
export async function writeManuscripts(project: NovelProject): Promise<void> {
  const plots = await project.listPlots();
  const pending: Plot[] = [];
  let notReady = 0;
  for (const plot of plots) {
    const scenes = await project.listScenes(plot.relPath);
    if (scenes.length === 0 || scenes.some((s) => s.status === 'draft' && !isSceneReady(s.sections))) {
      notReady++;
      continue;
    }
    const manuscript = await project.readManuscript(plot.relPath);
    // 只补空白：已经写过正文的章一律跳过，哪怕上游变了。
    if (!manuscript || !manuscript.text.trim()) {
      pending.push(plot);
    }
  }

  if (pending.length === 0) {
    getHost().toast(
      notReady > 0
        ? `没有可写的章。还有 ${notReady} 章的场景没备好素材——先把场景设计完。`
        : '每一章都已经写过正文了。'
    );
    return;
  }

  // 预计字数：场景卡上标了目标字数就用它，没标按一场 1000 字估。
  let scenesTotal = 0;
  let wordsTotal = 0;
  for (const plot of pending) {
    for (const scene of await project.listScenes(plot.relPath)) {
      scenesTotal++;
      wordsTotal += scene.targetWords ?? 1000;
    }
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 章的场景已备好但还没写正文，需要调用 ${scenesTotal} 次模型。现在写？`,
    ['开始写作'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'manuscript')}\n` +
        `共 ${scenesTotal} 场，预计产出约 ${Math.round(wordsTotal / 1000)} 千字。\n` +
        (lanes > 1
          ? `并发 ${lanes} 章，每章内部逐场串行（后一场要接着前一场写）。`
          : '串行逐章处理（并发数为 1）。') +
        '\n已经写过正文的章不会被改动。' +
        (notReady > 0 ? `\n另有 ${notReady} 章的场景还没备好素材，这次跳过。` : ''),
    }
  );
  if (confirm !== '开始写作') {
    log.info('用户取消了批量写正文');
    return;
  }

  const pool = await createModelPool({ task: 'manuscript', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量写正文中止');
    return;
  }

  await runBatch(project, {
    title: '批量写正文',
    items: pending,
    lanes,
    op: 'manuscript',
    what: '正文',
    run: async (plot, signal) => {
      const scenes = await project.listScenes(plot.relPath);
      for (const scene of scenes) {
        const built = await buildContext(
          project,
          {
            action: { stage: 'manuscript', capability: 'generate' },
            target: { kind: 'manuscript', plotRelPath: plot.relPath, sceneNo: scene.no },
            targetNo: plot.no,
            targetWords: scene.targetWords,
            ask: `写第 ${plot.no} 章的场景 ${scene.no}${scene.title ? `《${scene.title}》` : ''}。`,
          },
          config
        );
        const raw = await pool.run(`第 ${plot.no} 章 · 场景 ${scene.no}`, (llm) =>
          collectStream(
            llm.chatStream(built.messages, {
              maxOutputTokens: pool.primaryBudget.maxOutputTokens,
              temperature: config.temperature,
              timeoutMs: config.requestTimeoutMs,
              signal,
            })
          )
        );
        const text = cleanOutput(raw);
        if (!text.trim()) {
          throw new Error(`场景 ${scene.no} 的正文是空的`);
        }
        // 一场一写盘：中途取消时前面几场留得住（与摘要同步「停在第 30 章
        // 就有 30 章摘要」同一条取舍）。
        await project.appendToManuscript(plot.relPath, text);
        if (scene.status !== 'written') {
          await project.writeScene(plot.relPath, { ...scene, status: 'written' });
        }
      }
      const beatsHash = await project.beatsHashFor(plot.relPath);
      if (beatsHash) {
        await project.markBeatsWritten(plot.relPath, beatsHash);
      }
      await project.syncManifest();
    },
  });
}

// ---------------------------------------------------------------- 共用

/**
 * 装配某一章**剧情层**的上下文。
 *
 * 走**同一个装配器**而不是在这里手拼 prompt：分阶段配方、预算封顶、
 * 角色卡降级、前后章与附件的处理全都一致。批量与单次生成产出的东西
 * 因此是同一个质量，作者不会发现「工程页批量写的剧情比创作页的差一截」。
 */
async function buildContextFor(
  project: NovelProject,
  plot: Plot,
  config: ReturnType<typeof readConfig>,
  capability: Extract<Capability, 'generate' | 'split'>
): Promise<ChatMessage[]> {
  const built = await buildContext(
    project,
    {
      action: { stage: 'plot', capability },
      target: { kind: 'plot', plotRelPath: plot.relPath },
      targetNo: plot.no,
      targetWords: plot.targetWords,
      // 批量路径上没有用户输入那一句话。用这一章的「目标」当锚点——它正是
      // 拆章那一步定下的「这一章要达成什么」，比拿标题当输入具体得多。
      ask:
        capability === 'split'
          ? `把第 ${plot.no} 章的剧情拆成场景。`
          : `排出第 ${plot.no} 章的剧情。${plot.sections.目标.trim() || plot.title}`,
    },
    config
  );
  return built.messages;
}

interface BatchSpec {
  title: string;
  items: Plot[];
  lanes: number;
  /** 失败记录的 op，与清除时用的一致。 */
  op: string;
  /** 产物名，进日志与 toast（「剧情」「场景」「正文」）。 */
  what: string;
  run(plot: Plot, signal: AbortSignal): Promise<void>;
}

/**
 * 批量执行的外壳：进度、取消、逐项失败记录、收尾汇报。
 *
 * 抽出来是因为三个批量动作的这一章一字不差，而它们要保证的东西恰恰在这里：
 * **失败一项不影响其余**、失败挂在那一章上、取消时说清跑到哪了。
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
