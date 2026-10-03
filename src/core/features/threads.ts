/**
 * 叙事线（七期）：从细纲排出跨章的伏笔与线索（{@link generateThreads}），定稿时判这一章推进了
 * 哪几条（{@link recordThreadEvents}）。
 *
 * ## 排线
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`narrative-thread-candidate-generator.ts`
 * 的 `generatePlanCandidates`。上游是叙事线编辑器里的一颗按钮，候选逐条点「确认计划」才入库；
 * 这里是工程页的一个动作，走第 19 条的批量路径：
 *
 * - **只往 `threads.md` 末尾追加新线**，同名的跳过，已有的一个字不动——没有东西会被吞，
 *   所以不走写入卡；作者不要哪条，在文件里删掉就是。
 * - 动手之前确认框写明 1 次调用与用哪一档（第 4 条）。走「剧情细纲」档（`plotOutline`）：
 *   排线和拆细纲是同一种活，在大纲与各章计划之间排跨章的东西。不带思考深度（第 26 条）。
 * - 不做修复重试：1 次就是 1 次。坏了挂红 ❗ 在「叙事线」那一行上（第 16 条），作者再点一次。
 *
 * 不进主按钮（第 20 条只推一个下一步）：叙事线是可选的，不拿它挡路。
 *
 * ## 定稿时判事件
 *
 * 移植自同一个文件的 `generateEventCandidates`。上游要作者在编辑器里一条线一条线点「AI 识别
 * 定稿事件」再逐条确认；这里是定稿的第三步，**自动做、直接写**——与 D15 角色状态同一个理由：
 * 批量「写完即定稿」时没人看，而事件只是在一条线的事件列表末尾**追加**一行带原文的记录，
 * 不吞任何东西；证据逐字校验（`verifyThreadEvents`）就是那道闸。一次调用判所有还没收的线
 * （上游一次一条）。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import { CancelledError, StreamOptions } from '../llm/provider';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { LlmProvider } from '../llm/provider';
import { isPlotFilled } from '../model/plotFile';
import { ONE_CALL, describeCalls } from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { hasContent } from '../model/markdown';
import { PREMISE_SECTION_KEYS } from '../model/settingFile';
import {
  SAME_THREAD,
  THREAD_PLAN_LIMIT,
  Thread,
  ThreadEvent,
  ThreadEventType,
  ThreadPlan,
  appendEvents,
  appendThreads,
  asOf,
  lastEvent,
  parseThreads,
  threadKey,
  threadStatus,
  threadsToJudge,
  verifyThreadEvents,
  verifyThreadPlans,
} from '../model/threadsFile';
import { Workspace } from '../workspace';
import { extractJson, stripCodeFence } from './parse';
import { THREAD_EVENT_SYSTEM, threadPlanSystem } from './threadsPrompt';

const log = scoped('叙事线');

/** 失败记录的 op：排线失败、定稿时判叙事线失败都记在它名下。 */
export const THREADS_OP = 'threads';

/** 细纲一览里关键事件截到多长：一览是让模型看清全书节奏的，不是让它重读每一章。 */
const PLOT_LINE_EVENTS = 120;
/** 情节大纲最多带多少字。 */
const OUTLINE_CHARS = 8000;

/**
 * 模型交回来的 JSON 里取那一组：`{"threads":[…]}` / `{"events":[…]}`，也认上游的
 * `{"candidates":[…]}` 与直接一个数组。解不出返回 undefined。
 */
export function jsonList(raw: string, key: string): unknown[] | undefined {
  const text = stripCodeFence(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const inner = extractJson(text);
    try {
      value = inner ? JSON.parse(inner) : undefined;
    } catch {
      value = undefined;
    }
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const list = o[key] ?? o.candidates;
    return Array.isArray(list) ? list : undefined;
  }
  return undefined;
}

function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}

/** 已有的一条线在提示里的样子：名字与区间，叫模型别重复。 */
function existingLine(t: Thread): string {
  const range = t.from !== undefined && t.to !== undefined ? `（第 ${t.from}–${t.to} 章）` : '';
  return `- ${t.title}${range}${t.kind ? ` · ${t.kind}` : ''}`;
}

/** {@link planThreads} 的结果。 */
export interface PlanThreadsOutcome {
  /** 实际调了几次模型。 */
  calls: number;
  /** 追加进 `threads.md` 的线。 */
  added: ThreadPlan[];
  /** 同名跳过几条。 */
  same: number;
  /** 不合格没收几条（见日志）。 */
  bad: number;
  /** 没排成的原因（失败已经挂在 `threads.md` 上）。 */
  error?: string;
  cancelled?: boolean;
}

/**
 * 从细纲排叙事线：工程页按钮与拆完细纲之后自动排（批量拆细纲、批量写章边写边拆）共用。**不弹框、不开任务、
 * 不抛**（取消单列）：确认与进度条归调用方；失败挂在 `threads.md` 上（第 16 条）。只追加新线，同名跳过（第 19 条）。
 */
export async function planThreads(
  project: NovelProject,
  pool: ModelPool,
  signal: AbortSignal,
  report: (p: { message: string; current?: number; total?: number }) => void = () => {}
): Promise<PlanThreadsOutcome> {
  const out: PlanThreadsOutcome = { calls: 0, added: [], same: 0, bad: 0 };
  const plots = (await project.listPlots()).filter((p) => isPlotFilled(p.sections)).sort((a, b) => a.no - b.no);
  if (plots.length === 0) {
    return { ...out, error: '还没有细纲' };
  }
  const existing = await project.readThreads();
  const rel = project.relPath(project.threadsPath);
  const config = readConfig();
  const first = plots[0].no;

  report({ message: '读取设定与细纲', current: 0, total: 2 });
  const book = await project.readBookConfig();
  const premise = await project.readSettingDoc('premise');
  const outline = await project.readOutline();

  const head: string[] = [];
  if (book.totalChapters || book.wordsPerChapter) {
    head.push(
      `【全书规模】${book.totalChapters ? `共 ${book.totalChapters} 章` : ''}${
        book.wordsPerChapter ? `，每章约 ${book.wordsPerChapter} 字` : ''
      }`
    );
  }
  if (hasContent(book.sections.一句话)) {
    head.push(`【一句话】\n${book.sections.一句话.trim()}`);
  }
  const premiseText = PREMISE_SECTION_KEYS.filter((k) => hasContent(premise.sections[k]))
    .map((k) => `## ${k}\n${premise.sections[k].trim()}`)
    .join('\n\n');
  if (premiseText) {
    head.push(`【故事前提】\n${premiseText}`);
  }
  if (outline.trim()) {
    const o = outline.trim();
    head.push(`【情节大纲】\n${[...o].length > OUTLINE_CHARS ? `${[...o].slice(0, OUTLINE_CHARS).join('')}\n……（后面略）` : o}`);
    if ([...o].length > OUTLINE_CHARS) {
      log.warn('情节大纲太长，排叙事线时只带了前面一截', `${[...o].length} 字 → ${OUTLINE_CHARS} 字`);
    }
  }
  const tail = [
    existing.length > 0 ? `【已有的叙事线（不要重复）】\n${existing.map(existingLine).join('\n')}` : '',
    '请按要求输出 JSON。',
  ].filter(Boolean);

  const plotLines = plots.map(
    (p) =>
      `第${p.no}章 ${p.title}｜目的：${clip(p.sections.本章目的, 80)}｜关键事件：${clip(
        p.sections.关键事件,
        PLOT_LINE_EVENTS
      )}｜章末钩子：${clip(p.sections.章末钩子, 60)}`
  );
  // 输入预算：放不下时从细纲一览的最后截（越往后越是还没写到的，判回收章时也最远）。
  const budget = Math.max(3000, pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000);
  const fixed = estimateTokens([...head, ...tail].join('\n\n'));
  let kept = plotLines.length;
  while (kept > 1 && fixed + estimateTokens(plotLines.slice(0, kept).join('\n')) > budget) {
    kept--;
  }
  if (kept < plotLines.length) {
    log.warn(
      '细纲一览超出输入预算，排叙事线时只带了前面几章',
      `第 ${first}–${plots[kept - 1].no} 章（共 ${plots.length} 章里的 ${kept} 章）`
    );
  }
  const user = [...head, `【各章细纲（一行一章）】\n${plotLines.slice(0, kept).join('\n')}`, ...tail].join('\n\n');

  report({ message: '排线', current: 1, total: 2 });
  const options: StreamOptions = {
    maxOutputTokens: pool.primaryBudget.maxOutputTokens,
    temperature: 0.4,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const startedAt = Date.now();
  let plans: ThreadPlan[];
  let dropped: { title: string; why: string }[] = [];
  try {
    out.calls = 1;
    const raw = await pool.run('排叙事线', (llm) =>
      collectText(
        llm.stream(
          [
            { role: 'system', content: threadPlanSystem(book.totalChapters) },
            { role: 'user', content: user },
          ],
          options
        )
      )
    );
    if (signal.aborted) {
      log.warn('排叙事线被取消，未写盘');
      return { ...out, cancelled: true };
    }
    log.info('模型已返回', `${raw.length} 字，用时 ${elapsed(startedAt)}`);
    const list = jsonList(raw, 'threads');
    if (!list) {
      throw new Error('模型返回的内容里解析不出 JSON');
    }
    const verified = verifyThreadPlans(list, existing, book.totalChapters);
    if (verified.dropped.length > 0) {
      log.warn(
        `有 ${verified.dropped.length} 条没收`,
        verified.dropped.map((d) => `${d.title}：${d.why}`).join('\n')
      );
    }
    if (verified.plans.length === 0) {
      const why = verified.dropped.length > 0 ? `${verified.dropped.length} 条都不合格` : '一条都没有';
      throw new Error(`模型排出的线${why}`);
    }
    plans = verified.plans;
    dropped = verified.dropped;
  } catch (err) {
    if (err instanceof CancelledError || signal.aborted) {
      log.warn('排叙事线被取消，未写盘');
      return { ...out, cancelled: true };
    }
    const reason = describeError(err);
    log.error(`排叙事线失败：${reason}`, err);
    await recordFailure(project, {
      scope: '叙事线',
      targetKind: 'threads',
      targetKey: rel,
      severity: 'error',
      op: THREADS_OP,
      message: `排叙事线失败：${reason}`,
      detail: `${rel} 没有改动。可以再排一次。`,
    });
    return { ...out, error: reason };
  }

  // 写之前重读：这几十秒里作者可能在编辑器里加了线（同名的照样跳过）。
  let added: ThreadPlan[] = [];
  await new Workspace(project).updateThreads((raw) => {
    const now = new Set(parseThreads(raw).map((t) => threadKey(t.title)));
    added = plans.filter((p) => !now.has(threadKey(p.title)));
    return added.length > 0 ? appendThreads(raw, added) : undefined;
  });
  await clearFailures(project, 'threads', rel, THREADS_OP);
  report({ message: '完成', current: 2, total: 2 });
  out.added = added;
  out.same = plans.length - added.length + dropped.filter((d) => d.why === SAME_THREAD).length;
  out.bad = dropped.filter((d) => d.why !== SAME_THREAD).length;
  log.info(`排出 ${added.length} 条叙事线`, added.map((p) => `${p.title}（第 ${p.from}–${p.to} 章）`).join('\n'));
  return out;
}

/**
 * 工程页「从细纲排出叙事线」：先问一句（调用次数），再排。返回实际调用次数（取消、没有细纲时是 0）。
 */
export async function generateThreads(project: NovelProject): Promise<number> {
  const plots = (await project.listPlots()).filter((p) => isPlotFilled(p.sections)).sort((a, b) => a.no - b.no);
  if (plots.length === 0) {
    getHost().toast('还没有细纲：先拆出细纲，再从细纲排出叙事线。', 'error');
    return 0;
  }
  const existing = await project.readThreads();
  const rel = project.relPath(project.threadsPath);
  const config = readConfig();
  const first = plots[0].no;
  const last = plots[plots.length - 1].no;
  const pick = await getHost().confirm(
    `要从第 ${first}–${last} 章的细纲排出叙事线，${describeCalls(ONE_CALL)}。现在排？`,
    ['开始排'],
    {
      modal: true,
      detail:
        `${describeTaskModels(config, 'plotOutline')}\n` +
        `一次最多排 ${THREAD_PLAN_LIMIT} 条，追加在 ${rel} 末尾，可以手改。` +
        (existing.length > 0 ? `已有的 ${existing.length} 条不会改动，同名的跳过。` : ''),
    }
  );
  if (pick !== '开始排') {
    log.info('用户取消了排叙事线');
    return 0;
  }
  const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，排叙事线中止');
    return 0;
  }

  let calls = 0;
  await runTask(
    '排叙事线',
    async ({ signal, report }) => {
      const r = await planThreads(project, pool, signal, report);
      calls = r.calls;
      if (r.cancelled) {
        return;
      }
      if (r.error) {
        getHost().toast(`叙事线没排成（${r.error}）。`, 'error');
        return;
      }
      const notes = [r.same > 0 ? `同名跳过 ${r.same} 条` : '', r.bad > 0 ? `${r.bad} 条不合格没收（见日志）` : ''].filter(Boolean);
      getHost().toast(
        r.added.length > 0
          ? `排出 ${r.added.length} 条叙事线${notes.length > 0 ? `（${notes.join('，')}）` : ''}，已追加到 ${rel}。`
          : `排出的线在 ${rel} 里都已经有了，没有改动。`
      );
      if (r.added.length > 0) {
        await getHost().openFile(rel);
      }
    },
    { scope: '叙事线' }
  );
  return calls;
}

// ---------------------------------------------------------------- 定稿时判事件

export interface ThreadEventOutcome {
  /** 调了几次模型：没有还没收的线时是 0。 */
  calls: number;
  /** 记下的事件：哪条线、什么类型。 */
  recorded: { title: string; type: ThreadEventType }[];
  /** 没记的：证据找不到、认不出线、类型不对。 */
  dropped: { thread: string; why: string }[];
  /** 还没收的线超过一次能判的条数，没送去判的那几条。 */
  skipped: string[];
}

/**
 * 送去判的一条线：名字、类型、状态、区间、意图、最近一次推进（都按写到这一章时算）。意图不截
 * （判得准要看全）。
 */
function judgeLine(full: Thread, no: number): string {
  const t = asOf(full, no);
  const range = t.from !== undefined && t.to !== undefined ? `计划第 ${t.from}–${t.to} 章` : '';
  const head = [t.kind, threadStatus(t), range].filter(Boolean).join(' · ');
  const last = lastEvent(t);
  return `- ${t.title}（${head}）${t.intent ? `意图：${t.intent}` : ''}${last ? `；最近：第 ${last.chapter} 章${last.type}` : ''}`;
}

/**
 * 定稿第三步：判这一章推进了哪几条还没收的叙事线，证据逐字校验后追加进 `threads.md`。
 *
 * `run` 决定怎么调模型（同 `updateCharacterStates`）：单章入口直接用对话页选定的那个，批量
 * 入口传「单章摘要」档的池。调用失败或解析不出来时抛错——摘要已经写好了，由调用方把失败
 * 挂在章节上。
 */
export async function recordThreadEvents(
  project: NovelProject,
  chapter: Chapter,
  opts: {
    run: <T>(what: string, fn: (llm: LlmProvider) => Promise<T>) => Promise<T>;
    budget: { contextWindow: number; maxOutputTokens: number };
    signal?: AbortSignal;
  }
): Promise<ThreadEventOutcome> {
  const out: ThreadEventOutcome = { calls: 0, recorded: [], dropped: [], skipped: [] };
  const threads = await project.readThreads();
  const plot = await project.getPlot(chapter.order);
  const { judged, skipped } = threadsToJudge(threads, {
    no: chapter.order,
    plotText: plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : chapter.title,
    names: plot?.characters ?? [],
  });
  out.skipped = skipped.map((t) => t.title);
  if (judged.length === 0) {
    log.info(`第 ${chapter.order} 章定稿：没有还没收的叙事线，不判`);
    return out;
  }
  if (skipped.length > 0) {
    log.warn(`还没收的叙事线超过 ${judged.length} 条，第 ${chapter.order} 章只判了前 ${judged.length} 条`, `没判：${out.skipped.join('、')}`);
  }

  const text = await project.readChapterText(chapter);
  const roster = judged.map((t) => judgeLine(t, chapter.order)).join('\n');
  const config = readConfig();
  const inputBudget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - 1500 - estimateTokens(roster));
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${chapter.order} 章正文超出输入预算，判叙事线时已截断`, `${text.length} 字 → ${body.length} 字`);
  }
  const user =
    `【第${chapter.order}章 ${chapter.title}】\n\n${body}\n\n` + `【还没收的叙事线】\n${roster}\n\n请按要求输出 JSON。`;
  const options: StreamOptions = {
    maxOutputTokens: opts.budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal: opts.signal,
  };

  out.calls = 1;
  const raw = await opts.run(`第 ${chapter.order} 章 · 叙事线`, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: THREAD_EVENT_SYSTEM },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const list = jsonList(raw, 'events');
  if (!list) {
    throw new Error('模型返回的叙事线事件解析不出来');
  }
  // 证据对的是整章正文（不是截过的那一截）：截掉的后半章里的原句同样是正文。
  const { events, dropped } = verifyThreadEvents(list, judged, chapter.order, text);
  out.dropped = dropped;

  if (events.length > 0) {
    const byThread = new Map<string, { title: string; events: ThreadEvent[] }>();
    for (const { thread, event } of events) {
      const entry = byThread.get(thread.title) ?? { title: thread.title, events: [] };
      entry.events.push(event);
      byThread.set(thread.title, entry);
    }
    // 写之前重读（同排线）：只在此刻的原文上追加。这几十秒里作者把哪条线改了名，就记不上它。
    await new Workspace(project).updateThreads((raw) => {
      let next = raw;
      for (const entry of byThread.values()) {
        const patched = appendEvents(next, entry.title, entry.events);
        if (patched === undefined) {
          out.dropped.push({ thread: entry.title, why: '这条线在文件里找不到了（改了名或删了）' });
          continue;
        }
        next = patched;
        out.recorded.push(...entry.events.map((e) => ({ title: entry.title, type: e.type })));
      }
      return next;
    });
  }

  log.info(
    `第 ${chapter.order} 章的叙事线已处理`,
    [
      out.recorded.length > 0 ? `记下 ${out.recorded.map((r) => `${r.title}·${r.type}`).join('、')}` : '本章没有推进哪条线',
      out.dropped.length > 0 ? `没记 ${out.dropped.map((d) => `${d.thread}（${d.why}）`).join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜')
  );
  return out;
}
