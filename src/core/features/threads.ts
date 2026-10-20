/**
 * 叙事线（2026-10-20 重做，设计见 docs/design/plans/2026-10-20-narrative-threads.md）：从情节大纲排出叙事线
 * （{@link generateThreads}、{@link planThreadsFromOutline}），定稿时判这一章推进了哪几条（{@link recordThreadEvents}）。
 *
 * ## 排线
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`narrative-thread-candidate-generator.ts`
 * 的 `generatePlanCandidates`。七期从细纲排；重做之后**从情节大纲排**：线是在大纲这一层排的，细纲反过来
 * 照着线排（二期拆细纲带上叙事线）。输入是小说配置（规模、一句话）、故事前提、角色图谱（身份、关系、
 * 此人暗藏的秘密）、情节大纲（截到 `threadPlanOutlineChars`）与已有的线和伏笔（叫它别重复）。
 *
 * - **只新建线**（一条线一个文件 `threads/<线名>.md`，伏笔写在线下），同名的跳过，已有的一个字不动——没有东西
 *   会被吞，所以不走写入卡（第 19 条的批量路径）；作者不要哪条，删掉那个文件就是。
 * - 动手之前确认框写明 1 次调用与用哪一档（第 4 条）。走「剧情细纲」档（`plotOutline`）：排线和拆细纲是同一种活，
 *   在大纲与各章计划之间排跨章的东西。不带思考深度（第 26 条）。
 * - 不做修复重试：1 次就是 1 次。坏了挂红 ❗ 在叙事线目录上（第 16 条），作者再点一次。
 *
 * 不进主按钮（第 20 条只推一个下一步，设计稿 ⚑8）：入口是工程页（七期那一行，第 8 个提交换成「叙事线」组
 * 标题旁的按钮）与 agent 的 `extract threads`；批量拆细纲开跑时一条线都没有，先排一次（features/pipelineBatch.ts）。
 *
 * ## 定稿时判事件
 *
 * 移植自同一个文件的 `generateEventCandidates`。上游要作者在编辑器里一条线一条线点「AI 识别
 * 定稿事件」再逐条确认；这里是定稿的第三步，**自动做、直接写**——与 D15 角色状态同一个理由：
 * 批量「写完即定稿」时没人看，而事件只是在一条线的「进展」里**追加**一行带原文的记录，
 * 不吞任何东西；证据逐字校验（`verifyThreadEvents`）就是那道闸。一次调用判所有还没收的线
 * （上游一次一条）。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import { CancelledError, StreamOptions } from '../llm/provider';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { clipLine } from '../context/layers/render';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { LlmProvider } from '../llm/provider';
import { ONE_CALL, describeCalls } from '../model/pipeline';
import { isOutlineFilled } from '../model/outlineFile';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { hasContent } from '../model/markdown';
import { PREMISE_SECTION_KEYS } from '../model/settingFile';
import {
  Thread,
  ThreadEvent,
  ThreadEventType,
  asOf,
  fromThreadBook,
  lastEvent,
  threadStatus,
  threadsToJudge,
  toFileEvent,
  verifyThreadEvents,
} from '../model/threadsFile';
import {
  NewThread,
  SAME_THREAD,
  THREAD_PLAN_LIMIT,
  Thread as LineThread,
  appendEvents,
  foreshadowNames,
  threadFileName,
  threadKey,
  verifyThreadPlans,
} from '../model/threadFile';
import { Workspace } from '../workspace';
import { jsonList } from './parse';
import { THREAD_EVENT_SYSTEM, threadPlanSystem } from './threadsPrompt';

const log = scoped('叙事线');

/** 失败记录的 op：排线失败、定稿时判叙事线失败都记在它名下。 */
export const THREADS_OP = 'threads';

// ---------------------------------------------------------------- 排线

/** 已有的一条线在提示里的样子：名字、种类、区间、意图，叫模型别重复。 */
function existingLine(t: LineThread): string {
  const range = t.from !== undefined || t.to !== undefined ? ` · 计划第 ${t.from ?? '?'}–${t.to ?? '?'} 章` : '';
  return `- ${t.name}（${t.kind}${range}）${t.intent ? `意图：${clipLine(t.intent, 60)}` : ''}`;
}

/** {@link planThreadsFromOutline} 的结果。 */
export interface PlanThreadsOutcome {
  /** 实际调了几次模型。 */
  calls: number;
  /** 新建的线（一条一个文件）。 */
  added: NewThread[];
  /** 新建的线里一共带了几条伏笔。 */
  foreshadowing: number;
  /** 同名跳过几条。 */
  same: number;
  /** 不合格没收几条（线；见日志）。 */
  bad: number;
  /** 没排成的原因（失败已经挂在叙事线目录上）。 */
  error?: string;
  cancelled?: boolean;
}

/**
 * 从情节大纲排叙事线：工程页按钮、agent 的 `extract threads` 与批量拆细纲开跑前（一条线都没有时）共用。**不弹框、
 * 不开任务、不抛**（取消单列）：确认与进度条归调用方；失败挂在叙事线目录上（第 16 条）。只新建线，同名跳过（第 19 条）。
 * 情节大纲是空的返回 error，不调模型。
 */
export async function planThreadsFromOutline(
  project: NovelProject,
  pool: Pick<ModelPool, 'run' | 'primaryBudget'>,
  signal: AbortSignal,
  report: (p: { message: string; current?: number; total?: number }) => void = () => {}
): Promise<PlanThreadsOutcome> {
  const out: PlanThreadsOutcome = { calls: 0, added: [], foreshadowing: 0, same: 0, bad: 0 };
  const outline = (await project.readOutline()).trim();
  if (!isOutlineFilled(outline)) {
    return { ...out, error: '情节大纲还是空的' };
  }
  const book = await project.readThreads();
  const rel = project.relPath(project.threadsDir);
  const config = readConfig();
  const outlineChars = contextLimitsOf(config).threadPlanOutlineChars;

  report({ message: '读取设定与大纲', current: 0, total: 2 });
  const bookConfig = await project.readBookConfig();
  const premise = await project.readSettingDoc('premise');
  const cards = await project.listCharacters();

  const parts: string[] = [];
  if (bookConfig.totalChapters || bookConfig.wordsPerChapter) {
    parts.push(
      `【全书规模】${bookConfig.totalChapters ? `共 ${bookConfig.totalChapters} 章` : ''}${
        bookConfig.wordsPerChapter ? `，每章约 ${bookConfig.wordsPerChapter} 字` : ''
      }`
    );
  }
  if (hasContent(bookConfig.sections.一句话)) {
    parts.push(`【一句话】\n${bookConfig.sections.一句话.trim()}`);
  }
  const premiseText = PREMISE_SECTION_KEYS.filter((k) => hasContent(premise.sections[k]))
    .map((k) => `## ${k}\n${premise.sections[k].trim()}`)
    .join('\n\n');
  if (premiseText) {
    parts.push(`【故事前提】\n${premiseText}`);
  }
  // 角色图谱：身份与关系，加上此人暗藏的秘密——排伏笔最好的原料。
  // TODO(叙事线重做第 10 个提交)：角色卡「未收伏笔」改名「暗设」之后，这里换成读「暗设」那一节（规划时整份带）。
  // 在那之前原样把「未收伏笔」交给模型。
  const roster = cards
    .map((c) => {
      const lines = [`- ${c.name}${hasContent(c.sections.身份) ? `（${clipLine(c.sections.身份, 60)}）` : ''}`];
      if (hasContent(c.sections.人物关系)) {
        lines.push(`  人物关系：${clipLine(c.sections.人物关系, 120)}`);
      }
      if (hasContent(c.sections.未收伏笔)) {
        lines.push(`  未收伏笔（此人暗藏的秘密或将来要揭开的事）：${clipLine(c.sections.未收伏笔, 120)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  if (roster) {
    parts.push(`【角色图谱】\n${roster}`);
  }
  const chars = [...outline];
  if (chars.length > outlineChars) {
    log.warn('情节大纲太长，排叙事线时只带了前面一截', `${chars.length} 字 → ${outlineChars} 字`);
  }
  parts.push(`【情节大纲】\n${chars.length > outlineChars ? `${chars.slice(0, outlineChars).join('')}\n……（后面略）` : outline}`);
  const knownFore = foreshadowNames(book);
  if (book.threads.length > 0) {
    parts.push(`【已有的叙事线（不要重复）】\n${book.threads.map(existingLine).join('\n')}`);
  }
  if (knownFore.length > 0) {
    parts.push(`【已有的伏笔（不要重复）】\n${knownFore.join('、')}`);
  }
  parts.push('请按要求输出 JSON。');
  const hasMain = book.threads.some((t) => t.kind === '主线');

  report({ message: '排线', current: 1, total: 2 });
  const options: StreamOptions = {
    maxOutputTokens: pool.primaryBudget.maxOutputTokens,
    temperature: 0.4,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const startedAt = Date.now();
  let plans: NewThread[];
  let bad = 0;
  let sameInReply = 0;
  try {
    out.calls = 1;
    const raw = await pool.run('排叙事线', (llm) =>
      collectText(
        llm.stream(
          [
            { role: 'system', content: threadPlanSystem(bookConfig.totalChapters, hasMain) },
            { role: 'user', content: parts.join('\n\n') },
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
    const verified = verifyThreadPlans(list, { threads: book.threads, foreshadowing: knownFore }, bookConfig.totalChapters);
    const notes = [
      ...verified.dropped.map((d) => `线 ${d.name}：${d.why}`),
      ...verified.foreshadowDropped.map((d) => `伏笔 ${d.name}：${d.why}`),
    ];
    if (notes.length > 0) {
      log.warn(`有 ${notes.length} 条没收`, notes.join('\n'));
    }
    if (verified.plans.length === 0) {
      const why = verified.dropped.length > 0 ? `${verified.dropped.length} 条都不合格` : '一条都没有';
      throw new Error(`模型排出的线${why}`);
    }
    plans = verified.plans;
    sameInReply = verified.dropped.filter((d) => d.why === SAME_THREAD).length;
    bad = verified.dropped.length - sameInReply;
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
      detail: `${rel}/ 没有改动。可以再排一次。`,
    });
    return { ...out, error: reason };
  }

  // 写之前重读：这几十秒里作者可能在编辑器里加了线（同名的照样跳过）。一条线一个新文件，已有的一个字节不动。
  const now = await project.readThreads();
  const known = new Set(now.threads.map((t) => threadKey(t.name)));
  let mainTaken = now.threads.some((t) => t.kind === '主线');
  const ws = new Workspace(project);
  for (const plan of plans) {
    if (known.has(threadKey(plan.name)) || (plan.kind === '主线' && mainTaken)) {
      out.same++;
      continue;
    }
    if (await ws.createThread(plan)) {
      out.added.push(plan);
      out.foreshadowing += plan.foreshadowing.length;
      known.add(threadKey(plan.name));
      mainTaken ||= plan.kind === '主线';
    } else {
      out.same++;
    }
  }
  await clearFailures(project, 'threads', rel, THREADS_OP);
  report({ message: '完成', current: 2, total: 2 });
  out.same += sameInReply;
  out.bad = bad;
  log.info(
    `排出 ${out.added.length} 条叙事线、${out.foreshadowing} 条伏笔`,
    out.added.map((p) => `${p.name}（${p.kind}${p.from !== undefined ? ` · 第 ${p.from}–${p.to ?? '?'} 章` : ''}）`).join('\n')
  );
  return out;
}

/**
 * 工程页「从大纲排出叙事线」与 agent 的 `extract threads`：先问一句（调用次数），再排。返回实际调用次数（取消、没有
 * 情节大纲时是 0）。
 */
export async function generateThreads(project: NovelProject): Promise<number> {
  if (!isOutlineFilled(await project.readOutline())) {
    getHost().toast('情节大纲还是空的：先排出情节大纲，再从大纲排出叙事线。', 'error');
    return 0;
  }
  const { threads } = await project.readThreads();
  const rel = project.relPath(project.threadsDir);
  const hasMain = threads.some((t) => t.kind === '主线');
  const answer = await askCall({
    message: `要从情节大纲排出叙事线，${describeCalls(ONE_CALL)}。现在排？`,
    actions: ['开始排'],
    detail:
      `一次最多排 ${THREAD_PLAN_LIMIT} 条（主线 / 支线 / 感情线 / 人物线，主线全书一条），伏笔写在线下；一条线一个文件，放在 ${rel}/ 里，可以手改。` +
      (threads.length > 0
        ? `已有的 ${threads.length} 条不会改动，同名的跳过${hasMain ? '；主线已经有了，不再排主线' : ''}。`
        : ''),
    tasks: ['plotOutline'],
    contextDetail: true,
  });
  if (answer?.action !== '开始排') {
    log.info('用户取消了排叙事线');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
    if (!pool) {
      log.error('没有可用的模型，排叙事线中止');
      return 0;
    }

    let calls = 0;
    await runTask(
      '排叙事线',
      async ({ signal, report }) => {
        const r = await planThreadsFromOutline(project, pool, signal, report);
        calls = r.calls;
        if (r.cancelled) {
          return;
        }
        if (r.error) {
          getHost().toast(`叙事线没排成（${r.error}）。`, 'error');
          return;
        }
        getHost().toast(describePlanned(r, rel));
        if (r.added.length > 0) {
          await getHost().openFile(`${rel}/${threadFileName(r.added[0].name)}`);
        }
      },
      { scope: '叙事线' }
    );
    return calls;
  });
}

/** 「排出 3 条叙事线、5 条伏笔（同名跳过 1 条），已写进 .novelforge/threads/。」 */
export function describePlanned(r: PlanThreadsOutcome, rel: string): string {
  const notes = [r.same > 0 ? `同名跳过 ${r.same} 条` : '', r.bad > 0 ? `${r.bad} 条不合格没收（见日志）` : ''].filter(Boolean);
  return r.added.length > 0
    ? `排出 ${r.added.length} 条叙事线、${r.foreshadowing} 条伏笔${notes.length > 0 ? `（${notes.join('，')}）` : ''}，已写进 ${rel}/。`
    : `排出的线在 ${rel}/ 里都已经有了，没有改动。`;
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
 * 定稿第三步：判这一章推进了哪几条还没收的叙事线，证据逐字校验后追加进那条线的「进展」。
 *
 * `run` 决定怎么调模型（同 `updateCharacterStates`）：单章入口直接用对话页选定的那个，批量
 * 入口传「定稿」档（`plotSummary`）的池。调用失败或解析不出来时抛错——细纲已经更新好了，由调用方把失败
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
  const threads = fromThreadBook(await project.readThreads());
  const plot = await project.plotOfChapter(chapter);
  const config = readConfig();
  const { judged, skipped } = threadsToJudge(
    threads,
    {
      no: chapter.order,
      plotText: plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : chapter.title,
      names: plot?.characters ?? [],
    },
    contextLimitsOf(config).threadJudge
  );
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
    const byThread = new Map<string, { title: string; relPath: string; events: ThreadEvent[] }>();
    for (const { thread, event } of events) {
      const entry = byThread.get(thread.title) ?? { title: thread.title, relPath: thread.relPath ?? '', events: [] };
      entry.events.push(event);
      byThread.set(thread.title, entry);
    }
    // 写之前重读（同排线）：只在此刻的原文上追加。这几十秒里作者把哪条线删了，就记不上它。
    const ws = new Workspace(project);
    for (const entry of byThread.values()) {
      let gone = false;
      await ws.updateThread(entry.relPath, (raw) => {
        if (!raw.trim()) {
          gone = true;
          return undefined;
        }
        return appendEvents(raw, entry.events.map(toFileEvent)).text;
      });
      if (gone) {
        out.dropped.push({ thread: entry.title, why: '这条线的文件找不到了（改了名或删了）' });
        continue;
      }
      out.recorded.push(...entry.events.map((e) => ({ title: entry.title, type: e.type })));
    }
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
