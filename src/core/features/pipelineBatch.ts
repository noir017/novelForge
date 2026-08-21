/**
 * 工程页的流水线批量动作：**一次给几十段写剧情 / 写正文**。
 *
 * 从前是三条（写剧情 / 拆场景 / 写正文）。场景那一层删掉之后剩两条，链上
 * 也少一个闸口——「剧情排好了就能直接写正文」（见 model/pipeline.ts 的文件头）。
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
 * ## 返回值是「这一次计划调用几次模型」
 *
 * 就是确认框里那个数字（用户取消、没有可做的、没有可用模型时是 0）。
 * **只在这里算一次**：agent 的 `run` 工具拿它记进预算，工程页那条路不看它。
 * 让调用方各算一遍，弹窗写着 7 次、账上记 1 次，正是第 4 条要防的事。
 */
import { runPool } from '../runtime/concurrency';
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { AgentMessage, CancelledError } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { describeError, elapsed, formatDuration, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled } from '../model/plotFile';
import { describeTaskModels } from '../model/tiers';
import { buildContext } from '../context/builder';
import { runTask } from '../runtime/progress';
import { cleanOutput } from './creation';
import { parsePlotStrict } from './artifact';
import { Capability } from '../model/pipeline';
import { Workspace } from '../workspace';
import { plotUpstreamHash } from '../workspace/handlers/plot';

const log = scoped('流水线');

/**
 * 给所有还没排剧情的段各写一份。
 *
 * 每段一次调用。段与段之间**有**先后关系（后一段接着前一段的局面），但装配器
 * 会把前后段的原文一起带上，所以仍然可以并发——并发改变的只是完成顺序，
 * 不改变每次调用看到的上下文。
 */
export async function generatePlots(project: NovelProject): Promise<number> {
  const pending = (await project.listPlots()).filter((p) => !isPlotFilled(p.sections));

  if (pending.length === 0) {
    getHost().toast('每一段都已经排过剧情了。');
    return 0;
  }
  const outline = await project.readOutline();
  if (!outline.trim()) {
    // 没有大纲就写剧情，等于让模型凭空编四十段——那不是作者要的。
    log.warn('全书大纲是空的，批量写剧情已中止');
    getHost().toast('全书大纲还是空的。先写一份大纲，剧情才有依据。', 'error');
    return 0;
  }

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 段还没排剧情，需要调用 ${pending.length} 次模型。现在写？`,
    ['开始生成'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'plotOutline')}\n` +
        (lanes > 1 ? `并发 ${lanes} 路。` : '串行逐段处理（并发数为 1）。') +
        '\n已经排过剧情的段不会被改动。',
    }
  );
  if (confirm !== '开始生成') {
    log.info('用户取消了批量写剧情');
    return 0;
  }

  const ws = new Workspace(project);
  const pool = await createModelPool({ task: 'plotOutline', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量写剧情中止');
    return 0;
  }
  await runBatch(project, {
    title: '批量写剧情',
    items: pending,
    lanes,
    op: 'plotOutline',
    what: '剧情',
    run: async (plot, signal) => {
      const messages = await buildContextFor(project, plot, config, 'generate');
      const raw = await pool.run(`剧情段 ${plot.no}`, (llm) =>
        collectText(
          llm.stream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      // 严格解析：批量路径上没有人逐份过目，全文兜底会把模型的一句
      // 「我不太确定这一段写什么」变成一份「已规划」的剧情，紧接着的
      // 批量写正文还会照着它写出一整段。
      const sections = parsePlotStrict(raw);
      if (!sections || !isPlotFilled(sections)) {
        throw new Error('模型返回的内容里解析不出剧情');
      }
      await ws.writePlot({
        no: plot.no,
        title: plot.title,
        arc: plot.arc,
        targetWords: plot.targetWords,
        // 上游是**这一段所属那一卷**（未分卷的段退回全书大纲），不是一律的
        // 大纲指纹：分卷之后拿大纲指纹去记，改一卷的走向就再也标不出脏。
        upstreamHash: await plotUpstreamHash(project, plot.relPath),
        // done / chapters 沿用磁盘那份：批量写剧情改的是四个小节，不该把作者
        // 标的完成状态或「这一段交付到哪几章」抹掉。
        done: plot.done,
        chapters: plot.chapters,
        sections,
      });
    },
  });
  return pending.length;
}

/**
 * 给所有「剧情排好了但还没写正文」的段各写一遍正文。
 *
 * 这是两个批量动作里贵得多的一个（一段几千字输出，一次几十段），所以确认框里
 * 除了调用次数还报出预计总字数——那个数字比「40 次调用」更能让人意识到
 * 这一下要花多少钱。
 *
 * **一段一次调用**。从前是「一段内部逐场串行」：一段拆成几场，每场调一次、
 * 依次追加。场景那一层删掉之后没有那个坐标了，于是回到最朴素的形态——
 * 一次写一段。写不够长是可能的（`targetWords` 那条判据会把它留在「待写正文」，
 * 见 model/pipeline.ts 的 `manuscriptRatio`），那时作者在创作页点「接着写」，
 * 而不是让批量路径自己反复追加：**批量路径只补空白**，一段追加到什么程度算够
 * 是要看着文字决定的事。
 */
export async function writeManuscripts(project: NovelProject): Promise<number> {
  const plots = await project.listPlots();
  const pending: Plot[] = [];
  let noPlot = 0;
  for (const plot of plots) {
    // 没排剧情就写正文，模型只能照着标题瞎编——那种正文作者一段都留不下。
    if (!isPlotFilled(plot.sections)) {
      noPlot++;
      continue;
    }
    const manuscript = await project.readManuscript(plot.relPath);
    // 只补空白：已经写过正文的段一律跳过，哪怕上游变了、哪怕还没写够。
    if (!manuscript || !manuscript.text.trim()) {
      pending.push(plot);
    }
  }

  if (pending.length === 0) {
    getHost().toast(
      noPlot > 0
        ? `没有可写的段。还有 ${noPlot} 段没排剧情——先写剧情再来写正文。`
        : '每一段都已经写过正文了。'
    );
    return 0;
  }

  // 预计字数：细纲上标了目标字数就用它，没标按一段 3000 字估。
  const wordsTotal = pending.reduce((sum, p) => sum + (p.targetWords ?? 3000), 0);

  const config = readConfig();
  const lanes = Math.min(config.concurrency, pending.length);
  const confirm = await getHost().confirm(
    `有 ${pending.length} 段的剧情已排好但还没写正文，需要调用 ${pending.length} 次模型。现在写？`,
    ['开始写作'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'manuscript')}\n` +
        `预计产出约 ${Math.round(wordsTotal / 1000)} 千字。\n` +
        (lanes > 1 ? `并发 ${lanes} 段。` : '串行逐段处理（并发数为 1）。') +
        '\n已经写过正文的段不会被改动。' +
        (noPlot > 0 ? `\n另有 ${noPlot} 段还没排剧情，这次跳过。` : ''),
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
          targetWords: plot.targetWords,
          // 批量路径上没有用户输入那一句话。用这一段的「目标」当锚点——
          // 装配器已经把整份细纲按 P0 force 带上了，这一句只说清写的是哪一段。
          ask: `写剧情段 ${plot.no}${plot.title ? `《${plot.title}》` : ''} 的正文。`,
        },
        config
      );
      const raw = await pool.run(`剧情段 ${plot.no}`, (llm) =>
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
      // 走网关的追加：它自己会记 `upstreamHash`（正文所依据的细纲指纹），
      // 少了那一步这一段会永远显示「正文与剧情对不上」。
      await ws.appendToManuscript(plot.relPath, text);
      await project.syncManifest();
    },
  });
  return pending.length;
}

// ---------------------------------------------------------------- 共用

/**
 * 装配某一段**剧情层**的上下文。
 *
 * 走**同一个装配器**而不是在这里手拼 prompt：分阶段配方、预算封顶、
 * 角色卡降级、前后段与附件的处理全都一致。批量与单次生成产出的东西
 * 因此是同一个质量，作者不会发现「工程页批量写的剧情比创作页的差一截」。
 */
async function buildContextFor(
  project: NovelProject,
  plot: Plot,
  config: ReturnType<typeof readConfig>,
  capability: Extract<Capability, 'generate'>
): Promise<AgentMessage[]> {
  const built = await buildContext(
    project,
    {
      action: { stage: 'plot', capability },
      target: { kind: 'plot', plotRelPath: plot.relPath },
      targetNo: plot.no,
      targetWords: plot.targetWords,
      // 批量路径上没有用户输入那一句话。用这一段的「目标」当锚点——它正是
      // 拆段那一步定下的「这一段要达成什么」，比拿标题当输入具体得多。
      ask: `排出剧情段 ${plot.no} 的剧情。${plot.sections.目标.trim() || plot.title}`,
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
  /** 产物名，进日志与 toast（「剧情」「正文」）。 */
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
