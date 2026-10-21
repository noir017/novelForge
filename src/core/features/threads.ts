/**
 * 叙事线（2026-10-20 重做，设计见 docs/design/plans/2026-10-20-narrative-threads.md）：从情节大纲排出叙事线
 * （{@link generateThreads}、{@link planThreadsFromOutline}），定稿时认这一章在叙事线上发生了什么（{@link recordThreads}）。
 *
 * ## 排线
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`narrative-thread-candidate-generator.ts`
 * 的 `generatePlanCandidates`。七期从细纲排；重做之后**从情节大纲排**：线是在大纲这一层排的，细纲反过来
 * 照着线排（二期拆细纲带上叙事线）。输入是小说配置（规模、一句话）、故事前提、角色图谱（身份、关系、
 * 暗设——读者还不知道的事）、情节大纲（截到 `threadPlanOutlineChars`）与已有的线和伏笔（叫它别重复）。
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
 * ## 定稿时认事件、更新当前进度、归并
 *
 * 认事件移植自同一个文件的 `generateEventCandidates`。上游要作者在编辑器里一条线一条线点「AI 识别定稿事件」再逐条
 * 确认；这里是定稿的第三步，**自动做、直接写**——与 D15 角色状态同一个理由：批量「写完即定稿」时没人看，而事件只是在
 * 一条线的「进展」里**追加**一行带原文的记录，不吞任何东西；证据逐字校验（`verifyFinds`）就是那道闸。线是空的也认：
 * 正文里长出来的线只能在这里认出来（设计稿 ⚑6：定稿每章最少 2 次）。当前进度由机器维护、指纹守着（作者改过就不写），
 * 照角色卡「当前状态」的做法。详见 {@link recordThreads}。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import { CancelledError, StreamOptions } from '../llm/provider';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { cardHidden, clipLine } from '../context/layers/render';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { CHARACTER_DETAIL_LIMITS, Chapter } from '../model/types';
import { LlmProvider } from '../llm/provider';
import { ONE_CALL, describeCalls } from '../model/pipeline';
import { isOutlineFilled } from '../model/outlineFile';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { hasContent } from '../model/markdown';
import { PREMISE_SECTION_KEYS } from '../model/settingFile';
import {
  FoundEvent,
  FoundForeshadow,
  Foreshadowing,
  JudgedForeshadow,
  NewThread,
  SAME_THREAD,
  THREAD_PLAN_LIMIT,
  Thread as LineThread,
  ThreadEvent,
  ThreadFinds,
  ThreadKind,
  ThreadMerge,
  UNFILED_NAME,
  UNFILED_TEMPLATE,
  actualEvents,
  appendEvents,
  appendForeshadowing,
  applyMerges,
  completeFinds,
  foreshadowNames,
  foreshadowToJudge,
  isForeshadowEvent,
  parseThreadFile,
  patchProgress,
  plannedFor,
  progressOwnedByMachine,
  pruneChapterEvents,
  threadFileName,
  threadKey,
  threadStatus,
  threadsToJudge,
  verifyFinds,
  verifyMerges,
  verifyProgress,
  verifyThreadPlans,
} from '../model/threadFile';
import { Workspace } from '../workspace';
import { extractJsonObject, jsonList, stripCodeFence, stripTrailingCommas } from './parse';
import { THREAD_FIND_SYSTEM, THREAD_MERGE_SYSTEM, THREAD_PROGRESS_SYSTEM, threadPlanSystem } from './threadsPrompt';

const log = scoped('叙事线');

/** 失败记录的 op：排线失败（挂在叙事线目录上）、定稿时认叙事线没成或只成了一半（挂在章节上）都记在它名下。 */
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
  // 角色图谱：身份与关系，加上各人的「暗设」（读者还不知道的事）——排伏笔最好的原料：伏笔管什么时候、怎么揭开，
  // 暗设管真相是什么。排线是规划，暗设整份带（与装配器在架构 / 大纲 / 细纲时同一个口径，上限就是那一节的 120 字）。
  const roster = cards
    .map((c) => {
      const lines = [`- ${c.name}${hasContent(c.sections.身份) ? `（${clipLine(c.sections.身份, 60)}）` : ''}`];
      if (hasContent(c.sections.人物关系)) {
        lines.push(`  人物关系：${clipLine(c.sections.人物关系, 120)}`);
      }
      const hidden = cardHidden(c);
      if (hidden) {
        lines.push(`  暗设（读者还不知道）：${clipLine(hidden, CHARACTER_DETAIL_LIMITS.暗设)}`);
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

// ---------------------------------------------------------------- 定稿第三步：认事件、当前进度、归并

/** 失败记录的 op：定稿给一条线记了新进展，「当前进度」作者改过、没覆盖（挂在那条线的文件上）。 */
export const PROGRESS_OP = 'threadProgress';

/** {@link recordThreads} 的结果。 */
export interface ThreadsOutcome {
  /** 调了几次模型：认事件 1 次，当前进度、归并各 0–1 次。 */
  calls: number;
  /** 记下的实际事件：落在哪条线上（缺席是「未归属的伏笔」）。 */
  recorded: FoundEvent[];
  /** 从正文里认出、新建了文件的线。 */
  newThreads: { name: string; kind: ThreadKind }[];
  /** 新登记的伏笔：挂在哪条线上（缺席是「未归属的伏笔」）。 */
  newForeshadowing: { name: string; line?: string }[];
  /** 新认出的、其实是已有的那一条（并进去了，不另建）。 */
  merged: ThreadMerge[];
  /** 当前进度换成了这一章的那几条线。 */
  progressed: string[];
  /** 当前进度作者改过、没有覆盖的那几条线（挂了黄 ❗）。 */
  guarded: string[];
  /** 没记的：证据找不到、认不出是哪一条…… */
  dropped: { what: string; why: string }[];
  /** 重新定稿时清掉的、证据已经不在正文里的旧事件（设计稿 ⚑7）。 */
  pruned: number;
  /** 线与伏笔太多、这一次没送去认的。 */
  skipped: string[];
  /** 当前进度那一次没成（认出来的照样记下了）。 */
  progressError?: string;
  /** 归并那一次没成（新认出的照新的建了）。 */
  mergeError?: string;
}

interface StepOpts {
  run: <T>(what: string, fn: (llm: LlmProvider) => Promise<T>) => Promise<T>;
  budget: { contextWindow: number; maxOutputTokens: number };
  signal?: AbortSignal;
}

/** 调一次模型、取回 JSON 对象。解析不出来抛错（`what` 写进错误里）。 */
async function askJson(opts: StepOpts, label: string, system: string, user: string, temperature: number, what: string): Promise<Record<string, unknown>> {
  const config = readConfig();
  const options: StreamOptions = {
    maxOutputTokens: opts.budget.maxOutputTokens,
    temperature,
    timeoutMs: config.requestTimeoutMs,
    signal: opts.signal,
  };
  const raw = await opts.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const json = extractJsonObject(stripCodeFence(raw));
  try {
    const value: unknown = json ? JSON.parse(stripTrailingCommas(json)) : undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 落到下面那一句。
  }
  throw new Error(`模型返回的${what}解析不出来`);
}

/** 送去认的一条线：名字、种类、状态、区间、意图、现在走到哪、最近一次实际事件（都按写到这一章时算）。 */
function judgeLine(t: LineThread): string {
  const range = t.from !== undefined || t.to !== undefined ? `计划第 ${t.from ?? '?'}–${t.to ?? '?'} 章` : '';
  const head = [t.kind, threadStatus(t), range].filter(Boolean).join(' · ');
  const last = actualEvents(t).slice(-1)[0];
  return [
    `- ${t.name}（${head}）`,
    t.intent ? `意图：${clipLine(t.intent, 80)}` : '',
    t.progress ? `；现在：${clipLine(t.progress, 80)}` : '',
    last ? `；最近：第 ${last.chapter} 章${last.type}${last.foreshadowing ? `〈${last.foreshadowing}〉` : ''}：${clipLine(last.what, 40)}` : '',
  ].join('');
}

/** 送去认的一条伏笔。 */
function judgeForeshadow(f: JudgedForeshadow): string {
  const when = f.resolve !== undefined ? ` · 计划第 ${f.resolve} 章前收` : '';
  return `- ${f.name}（挂在「${f.line ?? UNFILED_NAME}」· ${f.status}${when}）${f.what ? `是什么：${clipLine(f.what, 60)}` : ''}`;
}

/**
 * 定稿第三步（设计稿「三」）：叙事线 1–3 次。
 *
 * ```
 * a. 认事件（1 次，线是空的也跑）：正文 + 没收束的线 + 没收的伏笔 + 本章计划 → 实际事件、新线、新伏笔、关系变动
 *    （verifyFinds：证据逐字校验）
 * c. 归并（0–1 次）：a 报了新线 / 新伏笔、又有已有的可比 → 是不是已有的那一条换了个说法
 * 写盘：清掉这一章证据已经不在正文里的旧事件 → 新线建文件、新伏笔与事件追加（只追加，第 19 条）
 * b. 当前进度（0–1 次）：本章有实际事件的那几条线（作者改过的不送、挂黄 ❗）→ 各自的当前进度（指纹守着）
 * ```
 *
 * 归并排在当前进度之前（⚑，设计稿把它列在 b 后面）：先定下事件落在哪条线上，当前进度才写得到对的那几条线。
 *
 * 本章计划只读各条线里这一章的计划事件（二期：拆细纲时随细纲写进线里）。一期还把细纲的「新增伏笔」当作本章计划要埋的
 * 伏笔一起交给模型，二期细纲删了那一节，这一处跟着删——老细纲里留着的那一节当认不出的小节，不读。
 *
 * `run` 决定怎么调模型（同 `updateCharacterStates`）：单章入口直接用对话页选定的那个，批量入口传「定稿」档
 * （`plotSummary`）的池。a 调用失败或解析不出来时抛错——细纲已经更新好了，由调用方把失败挂在章节上；b、c 失败只记在
 * 结果里（a 记下的照样算数），取消照样抛出去。
 */
export async function recordThreads(project: NovelProject, chapter: Chapter, opts: StepOpts): Promise<ThreadsOutcome> {
  const out: ThreadsOutcome = {
    calls: 0,
    recorded: [],
    newThreads: [],
    newForeshadowing: [],
    merged: [],
    progressed: [],
    guarded: [],
    dropped: [],
    pruned: 0,
    skipped: [],
  };
  const no = chapter.order;
  const book = await project.readThreads();
  const plot = await project.plotOfChapter(chapter);
  const limits = contextLimitsOf(readConfig());
  const plotText = plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : chapter.title;
  const lines = threadsToJudge(book, no, plotText, limits.threadJudge);
  const fores = foreshadowToJudge(book, no, limits.foreshadowJudge);
  out.skipped = [...lines.skipped.map((t) => t.name), ...fores.skipped.map((f) => `〈${f.name}〉`)];
  if (out.skipped.length > 0) {
    log.warn(`第 ${no} 章定稿：还没收的线与伏笔超过一次能认的条数，有 ${out.skipped.length} 条没送去`, out.skipped.join('、'));
  }

  // 本章计划：各条线里这一章的计划事件（拆细纲时随细纲写进线里）。
  const plan = plannedFor(book, no).map(
    (p) => `- ${p.line ?? UNFILED_NAME}：${p.event.type}${p.event.foreshadowing ? `〈${p.event.foreshadowing}〉` : ''}——${p.event.what}`
  );
  const rest = [
    plan.length > 0 ? `【本章计划（这一章本来要干什么，只帮你认；正文没写到的不要列）】\n${plan.join('\n')}` : '',
    `【还没收束的叙事线】\n${lines.judged.map(judgeLine).join('\n') || '（还没有）'}`,
    `【还没收的伏笔】\n${fores.judged.map(judgeForeshadow).join('\n') || '（还没有）'}`,
    '请按要求输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');
  const text = await project.readChapterText(chapter);
  const inputBudget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - 1500 - estimateTokens(rest));
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${no} 章正文超出输入预算，认叙事线时已截断`, `${text.length} 字 → ${body.length} 字`);
  }

  // a. 认事件。
  out.calls = 1;
  const found = await askJson(
    opts,
    `第 ${no} 章 · 叙事线`,
    THREAD_FIND_SYSTEM,
    `【第${no}章 ${chapter.title}】\n\n${body}\n\n${rest}`,
    0.2,
    '叙事线事件'
  );
  // 证据对的是整章正文（不是截过的那一截）：截掉的后半章里的原句同样是正文。
  let finds = verifyFinds(found, { chapter: no, text, judged: lines.judged, book });
  out.dropped = [...finds.dropped];

  // c. 归并：新认出的线 / 伏笔，是不是已有的那一条换了个说法。
  const knownFore = foreshadowNames(book);
  if ((finds.newThreads.length > 0 && book.threads.length > 0) || (finds.newForeshadowing.length > 0 && knownFore.length > 0)) {
    out.calls += 1;
    try {
      const user = [
        finds.newThreads.length > 0 ? `【新认出的叙事线】\n${finds.newThreads.map((t) => `- ${t.name}（${t.kind}）${t.intent}`).join('\n')}` : '',
        finds.newThreads.length > 0 ? `【已有的叙事线】\n${book.threads.map((t) => `- ${t.name}（${t.kind}）${clipLine(t.intent, 60)}`).join('\n')}` : '',
        finds.newForeshadowing.length > 0 ? `【新认出的伏笔】\n${finds.newForeshadowing.map((f) => `- ${f.name}：${f.what}`).join('\n')}` : '',
        finds.newForeshadowing.length > 0 ? `【已有的伏笔】\n${knownFore.join('、')}` : '',
        '请按要求输出 JSON。',
      ]
        .filter(Boolean)
        .join('\n\n');
      const merged = await askJson(opts, `第 ${no} 章 · 叙事线归并`, THREAD_MERGE_SYSTEM, user, 0.1, '归并结果');
      out.merged = verifyMerges(Array.isArray(merged.merges) ? merged.merges : [], finds, book);
      finds = applyMerges(finds, out.merged, book);
    } catch (err) {
      if (err instanceof CancelledError || opts.signal?.aborted) {
        throw err;
      }
      out.mergeError = describeError(err);
      log.warn(`第 ${no} 章的叙事线归并没成：${out.mergeError}（新认出的照新的建）`, err);
    }
  }
  finds = completeFinds(finds, no);

  await writeFinds(project, finds, no, text, out);
  await updateProgress(project, chapter, out, opts);

  log.info(
    `第 ${no} 章的叙事线已处理`,
    [
      describeThreads(out),
      out.dropped.length > 0 ? `没记 ${out.dropped.map((d) => `${d.what}（${d.why}）`).join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜')
  );
  return out;
}

/** 落在哪条线上的键（缺席是「未归属的伏笔」，键是空串）。 */
const lineKey = (line: string | undefined): string => (line ? threadKey(line) : '');

/**
 * 写盘：清掉这一章证据已经不在正文里的机器事件（⚑7）→ 新线一条一个新文件 → 已有的线与「未归属的伏笔」追加新伏笔与
 * 事件。都在写之前那一刻重读（`updateThread`）：这几十秒里作者删了哪条线，就记不上它、说出来。
 */
async function writeFinds(project: NovelProject, finds: ThreadFinds, no: number, text: string, out: ThreadsOutcome): Promise<void> {
  const ws = new Workspace(project);
  const events = new Map<string, FoundEvent[]>();
  for (const e of finds.events) {
    events.set(lineKey(e.line), [...(events.get(lineKey(e.line)) ?? []), e]);
  }
  const fores = new Map<string, FoundForeshadow[]>();
  for (const f of finds.newForeshadowing) {
    fores.set(lineKey(f.line), [...(fores.get(lineKey(f.line)) ?? []), f]);
  }
  const done = new Set<string>();
  const asForeshadowing = (list: FoundForeshadow[]): Foreshadowing[] => list.map((f) => ({ name: f.name, what: f.what }));

  for (const t of finds.newThreads) {
    const key = lineKey(t.name);
    done.add(key);
    const mine = events.get(key) ?? [];
    const myFores = fores.get(key) ?? [];
    const rel = await ws.createThread({
      name: t.name,
      kind: t.kind,
      origin: '正文',
      intent: t.intent,
      foreshadowing: asForeshadowing(myFores),
      events: mine.map((e) => e.event),
    });
    if (!rel) {
      out.dropped.push({ what: `新线 ${t.name}`, why: '同名的文件已经有了' });
      continue;
    }
    out.newThreads.push({ name: t.name, kind: t.kind });
    out.newForeshadowing.push(...myFores.map((f) => ({ name: f.name, line: t.name })));
    out.recorded.push(...mine);
  }

  const now = await project.readThreads();
  const files: { rel: string; line?: string }[] = [
    ...now.threads.map((t) => ({ rel: t.relPath, line: t.name })),
    { rel: now.unfiled.relPath },
  ];
  for (const f of files) {
    const key = lineKey(f.line);
    if (done.has(key)) {
      continue;
    }
    done.add(key);
    const mine = events.get(key) ?? [];
    const myFores = fores.get(key) ?? [];
    let added: ThreadEvent[] = [];
    let addedFore: Foreshadowing[] = [];
    let removed = 0;
    await ws.updateThread(f.rel, (raw) => {
      const exists = !!raw.trim();
      if (!exists && (f.line || (mine.length === 0 && myFores.length === 0))) {
        // 线的文件这几十秒里没了；「未归属的伏笔」没有、也没有要写的，就不建。
        return undefined;
      }
      const pruned = pruneChapterEvents(exists ? raw : UNFILED_TEMPLATE, no, text);
      removed = pruned.removed.length;
      const withFore = appendForeshadowing(pruned.text, asForeshadowing(myFores));
      addedFore = withFore.added;
      const withEvents = appendEvents(withFore.text, mine.map((e) => e.event));
      added = withEvents.added;
      return withEvents.text;
    });
    out.pruned += removed;
    out.newForeshadowing.push(...addedFore.map((x) => ({ name: x.name, ...(f.line ? { line: f.line } : {}) })));
    out.recorded.push(...mine.filter((e) => added.includes(e.event)));
  }
  // 落在一条已经找不到的线上的（这几十秒里作者删了、改了名）：记不上，说出来。
  for (const [key, mine] of events) {
    if (!done.has(key)) {
      out.dropped.push(...mine.map((e) => ({ what: e.line ?? UNFILED_NAME, why: '这条线的文件找不到了（改了名或删了）' })));
    }
  }
  if (out.pruned > 0) {
    log.info(`第 ${no} 章重新定稿：清掉 ${out.pruned} 条证据已经不在正文里的旧事件（旧版存进了历史版本）`);
  }
}

/**
 * b. 当前进度：本章有实际事件的那几条线，一次写完。照角色卡「当前状态」的做法（第 19 条的例外）：空的或指纹对得上才写，
 * 作者改过的不送去、挂黄 ❗ 在那条线上；已经写到更晚那一章的不回退（重新定稿早前的章时）。写之前那一刻再认一遍归属。
 */
async function updateProgress(project: NovelProject, chapter: Chapter, out: ThreadsOutcome, opts: StepOpts): Promise<void> {
  const no = chapter.order;
  const touched = new Set(out.recorded.filter((e) => e.line).map((e) => lineKey(e.line)));
  if (touched.size === 0) {
    return;
  }
  const book = await project.readThreads();
  const ws = new Workspace(project);
  const send: LineThread[] = [];
  for (const t of book.threads) {
    if (!touched.has(lineKey(t.name)) || (t.progressThrough !== undefined && t.progressThrough > no)) {
      continue;
    }
    if (!progressOwnedByMachine(t)) {
      out.guarded.push(t.name);
      await recordFailure(project, {
        scope: '叙事线',
        targetKind: 'threads',
        targetKey: t.relPath,
        severity: 'warn',
        op: PROGRESS_OP,
        message: `第 ${no} 章定稿给这条线记了新进展，「当前进度」你改过，没有覆盖`,
        detail: '这一节你改过，就归你写了，机器不再覆盖。想让定稿接着维护，把这一节清空，下次定稿就会写。',
      });
      continue;
    }
    send.push(t);
  }
  if (send.length === 0) {
    return;
  }
  const mine = (t: LineThread): string =>
    out.recorded
      .filter((e) => lineKey(e.line) === lineKey(t.name))
      .map((e) => `${e.event.type}${e.event.foreshadowing ? `〈${e.event.foreshadowing}〉` : ''}：${e.event.what}`)
      .join('；');
  const user =
    `【第${no}章 ${chapter.title}】\n\n` +
    send
      .map((t) => `- ${t.name}（${t.kind}）意图：${t.intent || '（没写）'}\n  原来的当前进度：${t.progress || '（空）'}\n  这一章：${mine(t)}`)
      .join('\n') +
    '\n\n请按要求输出 JSON。';
  out.calls += 1;
  try {
    const answer = await askJson(opts, `第 ${no} 章 · 叙事线当前进度`, THREAD_PROGRESS_SYSTEM, user, 0.3, '当前进度');
    const items = verifyProgress(Array.isArray(answer.progress) ? answer.progress : [], send.map((t) => t.name));
    for (const item of items) {
      const t = send.find((x) => x.name === item.line)!;
      let mineNow = true;
      await ws.updateThread(t.relPath, (raw) => {
        // 这几十秒里作者改了这一节：照样不覆盖。
        if (!raw.trim() || !progressOwnedByMachine(parseThreadFile(raw, t.relPath))) {
          mineNow = false;
          return undefined;
        }
        return patchProgress(raw, item.text, no);
      });
      if (mineNow) {
        await clearFailures(project, 'threads', t.relPath, PROGRESS_OP);
        out.progressed.push(t.name);
      } else {
        out.guarded.push(t.name);
      }
    }
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    out.progressError = describeError(err);
    log.warn(`第 ${no} 章的叙事线当前进度没更新成：${out.progressError}`, err);
  }
}

/**
 * 完成提示里叙事线那一句（设计稿：一定说叙事线）：「叙事线：林昭与沈青推进、关系；埋〈玉佩的来历〉；新认出 1 条线〈沈家旧案〉
 * （支线）」；什么都没认出就说「叙事线没有新进展」。当前进度、没记的、清掉的旧记录、没成的那一步跟在后面（第 2 条）。
 */
export function describeThreads(o: ThreadsOutcome): string {
  const fresh = new Set(o.newThreads.map((t) => lineKey(t.name)));
  const byLine = new Map<string, { line: string; types: string[] }>();
  const fores: string[] = [];
  for (const e of o.recorded) {
    if (isForeshadowEvent(e.event.type)) {
      const s = `${e.event.type}〈${e.event.foreshadowing}〉`;
      if (!fores.includes(s)) {
        fores.push(s);
      }
    } else if (e.line && !fresh.has(lineKey(e.line))) {
      const entry = byLine.get(lineKey(e.line)) ?? { line: e.line, types: [] };
      if (!entry.types.includes(e.event.type)) {
        entry.types.push(e.event.type);
      }
      byLine.set(lineKey(e.line), entry);
    }
  }
  const news = [
    ...[...byLine.values()].map((x) => `${x.line}${x.types.join('、')}`),
    ...fores,
    o.newThreads.length > 0 ? `新认出 ${o.newThreads.length} 条线${o.newThreads.map((t) => `〈${t.name}〉（${t.kind}）`).join('')}` : '',
    ...o.merged.map((m) => `〈${m.from}〉并进了〈${m.into}〉`),
  ].filter(Boolean);
  const extra = [
    o.progressed.length > 0 ? `${o.progressed.join('、')}的当前进度更新到这一章` : '',
    o.guarded.length > 0 ? `${o.guarded.join('、')}的当前进度你改过，没有覆盖（线上挂了黄 ❗）` : '',
    o.dropped.length > 0 ? `另有 ${o.dropped.length} 条叙事线的记录没有收（证据在正文里找不到，或认不出是哪一条）` : '',
    o.pruned > 0 ? `清掉 ${o.pruned} 条证据已经不在正文里的旧记录` : '',
    o.progressError ? `叙事线的当前进度没更新成（${o.progressError}）` : '',
    o.mergeError ? `叙事线的归并没判成（${o.mergeError}），新认出的照新的建了` : '',
  ].filter(Boolean);
  return [news.length > 0 ? `叙事线：${news.join('；')}` : '叙事线没有新进展', ...extra].join('；');
}
