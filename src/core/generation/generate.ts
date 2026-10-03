/**
 * 生成：装配上下文 → 调模型 → 解析产物 → 交出一份 Draft。
 *
 * ## 无状态
 *
 * 这里没有类、没有字段、没有「当前有没有在生成」。并发控制是**调度**的
 * 责任，不是生成的责任——对话页由 `ChatController` 管（同一时刻只许一个），
 * agent 循环由它自己管。所以 `signal` 由调用方给，本模块只往下透传。
 *
 * ## 一个字都不写磁盘
 *
 * `generate` 产出的是 `Draft`：一份**尚未落盘**的产物。落盘在
 * `workspace/`，且只在用户点了采纳之后（AGENTS 第 19 条：产物落盘前必须
 * 过一遍人）。唯一的例外是失败记账（`recordFailure` / `clearFailures`），
 * 它写的是痕迹库不是内容（第 17 条）。
 *
 * ## 解析并进生成
 *
 * 从前的流程是「生成 → 前端拿到文本 → 后端再 parse 一次画卡片 → 采纳时
 * 第三次 parse」，中间那次纯属多余。现在 `Draft` 出厂就带 `artifact` 与
 * `summary`。**采纳时仍然重新解析**——用户可能在气泡里改过文本，
 * `draft.artifact` 只是生成那一刻的快照。
 *
 * ## 一件产物可能要调几次
 *
 * 小说配置、角色图谱、细纲批次要分几次调用才拼得出来（截断重来、两段式、拆半重试），
 * 第一次流式调用之后接上 `structured.ts` 的那条链，后面几次照样流进同一个气泡，
 * 最后气泡换成规范化结果（将要落盘的样子）。每一次降级记进 `Draft.notes`，
 * 落盘卡片上列出来（第 2 条）。
 */
import { BuildRequest, BuiltContext, buildContext } from '../context/builder';
import { StopSignal } from '../llm/provider';
import { describeUsage, recordUsage } from '../context/tokenizer';
import { mergeUsage } from '../llm/collect';
import { CancelledError, LlmProvider, StreamOptions, TokenUsage } from '../llm/provider';
import { buildProvider, resolveProvider } from '../llm/registry';
import { readConfig } from '../config';
import { ThinkingDepth } from '../model/thinking';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { countWords } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { NotYet, bannedTerms, dropMentioned, notYetOnStage } from '../model/manuscriptCheck';
import { pickSections } from '../model/markdown';
import { AHEAD_PLOTS } from '../context/layers/focus';
import {
  CAPABILITY_LABEL,
  CreationAction,
  CreationTarget,
  STAGE_LABEL,
  WriteMode,
  describeTarget,
  isFallbackChapterTitle,
  outputKindOf,
  plotOfTarget,
} from '../model/pipeline';
import { previousEnding } from '../context/replay';
import { describeModelIssue, providerLabel } from '../model/providers';
import { Artifact, ChapterRange, describeArtifact, isArtifactEmpty, parseArtifact } from '../features/artifact';
import { cleanOutput } from '../features/creation';
import {
  CallOutcome,
  ChainError,
  ChainIO,
  ChainResult,
  chainOf,
  chaptersOf,
  completeBlueprints,
  completeConfig,
  completeRoster,
  singleShotNotes,
} from './structured';
import { writingAim } from '../model/trimProse';
import { ManuscriptChainResult, WriteProgress, completeManuscript } from './continuation';
import { ReviewChainContext, completeReview } from './review';
import { completeRevision } from './revision';
import { ReviewReport, freezeGoals } from '../model/review';
import { basename } from 'node:path';

const log = scoped('创作');

/** 一次生成的产出。**尚未落盘**，采纳时才写。 */
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原样输出（正文层已过 `cleanOutput`）。 */
  raw: string;
  /** 解析出的结构化产物。讨论（唯一的 text 类能力）没有。 */
  artifact?: Artifact;
  /** 一句话形状描述，如「细纲 · 3/3 节」。有 artifact 才有。 */
  summary?: string;
  words: number;
  /** 推理模型的思考过程。**不是正文，采纳时不取。** */
  reasoning?: string;
  createdAt: string;
  /**
   * 这一步覆盖的章号区间：细纲批次（给了就是一批）与续写的那一段大纲。采纳时要它——
   * 细纲按批次解码、大纲按区间合并。
   */
  range?: ChapterRange;
  /** 这一路上的降级与说明（截断重来、拆半重试、漏字段……）。落盘卡片上列出来。 */
  notes?: string[];
  /** 这一次一共调了几次模型。 */
  calls?: number;
  /**
   * 正文的写法（model/pipeline.ts 的 `WriteMode`）。**采纳时按它落盘**：`continue` 追加、
   * 其余在已有正文时覆盖审阅。生成那一刻按磁盘定的，采纳时不再猜。
   */
  writeMode?: WriteMode;
  /** 正文写了多长：这一章写完后的总字数、目标、这一次新写的、续写了几轮、够不够八成。 */
  length?: DraftLength;
  /** 新稿开头与上一章结尾重合的那一段原文（context/replay.ts）。卡片标红、写入要点两下。 */
  replay?: string;
  /**
   * 删修饰真删了字时：删之前那一版（与 `raw` 对应，只含这一次新写的）。写入卡片点了「写入」之后，
   * 合并视图拿它与气泡里那份逐段对照，作者可以把删改退回原文。
   */
  untrimmed?: string;
  /**
   * 审稿报告（五期）。审稿那一轮**没有 `artifact`**：报告不落盘，随会话保存（D22），
   * 作者在报告卡上勾选之后再发起修稿。
   */
  review?: ReviewReport;
}

export interface DraftLength {
  words: number;
  target?: number;
  added: number;
  rounds: number;
  /** 到了目标的八成（没有目标时恒为 true：有字就算写够）。 */
  reached: boolean;
}

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  /** 推理模型的思考增量。正文之前可能先想很久，界面靠它给出反馈。 */
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
  /** 写正文的进度：第几轮、写到多少字、目标多少。流式期间约 300ms 一次，每一轮开始时一次。 */
  onProgress?(p: WriteProgress): void;
  /** 气泡退回到这一份（续写丢弃一轮时）。 */
  onReset?(full: string): void;
}

export interface GenerateOptions {
  signal: AbortSignal;
  /**
   * 用哪个模型。缺省用对话页选定的那个（`config.active`）。
   *
   * **正文层永远不许传别的**（AGENTS 第 12 条：中途换人会让文风断掉）。
   * 这个参数给 agent 的 `generate` 工具让非正文层走分档池。
   */
  provider?: LlmProvider;
  /**
   * 装配与输出的 token 预算。缺省用 `config` 里那一份（对话页选定模型的窗口）。
   *
   * **传了 `provider` 就必须一起传它**（AGENTS 第 13 条）：`config.contextWindow`
   * 跟着对话页选定的模型走，拿 200k 写作模型的窗口去给快速档的 32k 模型装配
   * 上下文会稳定超窗。分档池的 `primaryBudget` 正是这一份。
   */
  budget?: { contextWindow: number; maxOutputTokens: number };
  /**
   * 让模型想多深。缺省不带思考参数（服务商默认）。
   *
   * 对话页把作者在会话里选的那一档递进来；工程页的批量任务不递——第 12 条
   * 那条理由的同一面：那一档模型是作者按成本挑的，替他把七十六章的摘要
   * 都升级成深思考，账单上看不出是谁决定的。
   */
  thinking?: ThinkingDepth;
}

export interface GenerateResult {
  /** 失败或模型引用无效时缺席。 */
  draft?: Draft;
  /** 装配明细。装配之前就失败时缺席。 */
  built?: BuiltContext;
}

/** 只装配上下文，不调用模型——面板里的「预览上下文」。 */
export async function previewContext(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<BuiltContext> {
  const config = readConfig();
  let providerMaxInputTokens: number | undefined;
  // vscode-lm 有硬配额，预览时也要按真实上限算，否则预览与实际不符。
  if (config.active?.profile.kind === 'vscode-lm') {
    const provider = await resolveProvider();
    providerMaxInputTokens = await provider?.maxInputTokens();
  }
  return buildContext(project, { ...request, providerMaxInputTokens }, config);
}

/**
 * 把一次生成的输出解析成产物。**不写盘。**
 *
 * 讨论（唯一的 text 类能力）没有可采纳的东西，返回 undefined；
 * 解析出来是空的也返回 undefined——写一个空产物比不写更糟，作者会以为存下了。
 */
export function parseDraftArtifact(
  action: CreationAction,
  raw: string,
  target?: CreationTarget,
  range?: ChapterRange
): Artifact | undefined {
  if (outputKindOf(action) !== 'artifact') {
    return undefined;
  }
  // 架构层要看 target 才分得清是哪一件（四件同属一个阶段）；细纲与大纲还要看区间。
  const artifact = parseArtifact(action, raw, target, range);
  return isArtifactEmpty(artifact) ? undefined : artifact;
}

/**
 * 装配 + 调模型 + 解析。**一个字都不写磁盘。**
 *
 * 失败时往 `errorLog` 记一条挂在目标细纲上，成功时清掉（第 16 条）。
 * 取消不算失败——那是用户自己点的。
 */
export async function generate(
  project: NovelProject,
  requested: Omit<BuildRequest, 'providerMaxInputTokens'>,
  handlers: GenerateHandlers,
  options: GenerateOptions
): Promise<GenerateResult> {
  let request = requested;
  // 干活那个模型的窗口优先：换了 provider 却拿对话页那个模型的窗口切上下文，
  // 是第 13 条明确点名的错法。
  const config = options.budget ? { ...readConfig(), ...options.budget } : readConfig();
  let provider = options.provider;
  if (!provider) {
    if (!config.active) {
      const issue = describeModelIssue(config.providers, config.model);
      log.error(`模型引用无效：${issue}`, `当前引用 ${config.model || '（空）'}`);
      handlers.onError(issue);
      return {};
    }
    provider = await buildProvider(config.active);
    if (!provider) {
      log.error(`未配置「${providerLabel(config.active.profile)}」的 API Key`);
      handlers.onError(
        `未配置「${providerLabel(config.active.profile)}」的 API Key。可在设置页录入，或换一个已配置好的模型。`
      );
      return {};
    }
  }

  const startedAt = Date.now();
  const { stage, capability } = request.action;
  const what = `${STAGE_LABEL[stage]}·${CAPABILITY_LABEL[capability]}`;
  const where = await describe(project, request.target);
  log.info(
    `开始${what}：${where}`,
    `模型 ${provider.label}${request.targetWords ? `｜目标 ${request.targetWords} 字` : ''}` +
      `${request.attachments?.length ? `｜引用 ${request.attachments.length} 项` : ''}` +
      `${request.history?.length ? `｜历史 ${request.history.length} 轮` : ''}`
  );

  // 写正文：写法、目标字数、上一版与上一章结尾都按磁盘定好了再装配（三期计划 §1–§2）。
  const writing = stage === 'manuscript' && capability === 'generate' ? await planWriting(project, request) : undefined;
  if (writing && request.writeMode === 'revise' && writing.mode !== 'revise') {
    log.warn('修稿时这一章已经没有正文了', where);
    handlers.onError('这一章已经没有正文了，没法修稿。');
    return {};
  }
  // 审稿：这一章的正文与冻结的目标清单也在装配之前定好（契约里给模型的与链上校验用的是同一份）。
  const reviewing = stage === 'manuscript' && capability === 'review' ? await planReview(project, request) : undefined;
  if (stage === 'manuscript' && capability === 'review') {
    if (!reviewing) {
      log.warn('这一章还没有正文，没法审稿', where);
      handlers.onError('这一章还没有正文，没法审稿。');
      return {};
    }
    request = { ...request, reviewGoals: [...reviewing.goals] };
    log.info(`审稿：${where}`, `正文 ${countWords(reviewing.text)} 字｜目标 ${reviewing.goals.length} 项`);
  }
  // 开着删修饰时往多写一点，删完落在目标附近（修稿不删修饰，原稿多长就多长）。
  const aim = writing && writing.mode !== 'revise' ? writingAim(writing.target, config.trimModifiers) : writing?.target;
  if (writing) {
    request = {
      ...request,
      writeMode: writing.mode,
      targetWords: aim,
      revision: writing.mode === 'revise' ? writing.revision : request.revision ?? writing.revision,
      // 执行卡后面「本章不出场」那一行与写完查的是同一份（五期补遗 §1.2）。
      notYet: writing.notYet.map(({ name, no }) => ({ name, no })),
      // 【本章边界】里点名不许用的词，与写完数的同一份。
      ...(writing.banned.length > 0 ? { banned: writing.banned } : {}),
    };
    log.info(
      `写法：${WRITE_MODE_LABEL[writing.mode]}`,
      `${writing.target ? `目标 ${writing.target} 字` : '没有目标字数（不自动续写）'}` +
        `${writing.existing ? `｜已有 ${countWords(writing.existing)} 字` : ''}`
    );
  }

  const providerMaxInputTokens = await provider.maxInputTokens();
  const buildStart = Date.now();
  const built = await buildContext(project, { ...request, providerMaxInputTokens }, config);
  logAssembly(built, buildStart);

  let reasoning = '';
  // 服务商分多次回报用量（Anthropic 输入/输出分开给），按字段合并成一份。
  const usage: TokenUsage = {};
  const streamOptions: StreamOptions = {
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    timeoutMs: config.requestTimeoutMs,
    signal: options.signal,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  };

  let draft: Draft | undefined;
  let full = '';
  const streamOnce = async (
    messages: typeof built.messages,
    progress?: { round: number; base: number },
    opts: { quiet?: boolean; temperature?: number } = {}
  ): Promise<CallOutcome> => {
    let text = '';
    let stop: StopSignal | undefined;
    let firstDeltaAt = 0;
    let reportedAt = 0;
    const report = () => {
      if (progress && handlers.onProgress) {
        reportedAt = Date.now();
        handlers.onProgress({ round: progress.round, words: progress.base + countWords(text), target: writing?.target });
      }
    };
    report();
    const options = opts.temperature === undefined ? streamOptions : { ...streamOptions, temperature: opts.temperature };
    for await (const ev of provider.stream(messages, options)) {
      if (ev.type === 'text') {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          log.debug('首个分片已到达', `首字延迟 ${elapsed(startedAt, firstDeltaAt)}`);
        }
        text += ev.text;
        if (opts.quiet) {
          continue;
        }
        full += ev.text;
        handlers.onDelta(ev.text, full);
        // 数字随流一起涨，但不必每个分片都数一遍：几千个分片 × 几千字是平方级的活。
        if (Date.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
          report();
        }
      } else if (ev.type === 'reasoning') {
        reasoning += ev.text;
        handlers.onReasoning?.(ev.text, reasoning);
      } else if (ev.type === 'usage') {
        mergeUsage(usage, ev.usage);
      } else if (ev.type === 'stop') {
        stop = ev.reason;
      }
    }
    report();
    return { text, stop };
  };

  try {
    const first = await streamOnce(
      built.messages,
      writing ? { round: 0, base: countWords(writing.existing) } : undefined
    );
    const chain = chainOf(request);
    let result: ChainResult;
    let written: ManuscriptChainResult | undefined;
    let report: ReviewReport | undefined;
    if (chain) {
      const io: ChainIO = {
        messages: built.messages,
        build: async (patch) => (await buildContext(project, { ...request, ...patch, providerMaxInputTokens }, config)).messages,
        call: async (messages, label, opts) => {
          // 后面几次照样流进同一个气泡，前面一行说清这一次在补什么（第 11 条：不闷着干活）。
          // 正文续写只空一行：读起来得是同一章。
          const head = opts?.separator ?? `\n\n——${label}——\n\n`;
          full += head;
          handlers.onDelta(head, full);
          log.info(`${what}：${label}`);
          return streamOnce(messages, opts?.progress, { quiet: opts?.quiet, temperature: opts?.temperature });
        },
        reset: (text) => {
          full = text;
          handlers.onReset?.(full);
        },
      };
      if (chain === 'manuscript' && writing) {
        written = await completeManuscript(first, io, {
          mode: writing.mode,
          existing: writing.existing,
          target: writing.target,
          aim,
          prevEnding: writing.prevEnding,
          reasoned: !!reasoning,
          hook: writing.hook,
          notYet: writing.notYet,
          banned: writing.banned,
          trim: config.trimModifiers,
          onProgress: handlers.onProgress,
          signal: options.signal,
        });
        result = written;
      } else if (chain === 'revision' && writing) {
        result = await completeRevision(first, io, {
          source: writing.revision?.previousDraft ?? '',
          wordsPerChapter: (await project.readBookConfig()).wordsPerChapter,
          onProgress: handlers.onProgress,
          signal: options.signal,
        });
      } else if (chain === 'review' && reviewing) {
        const reviewed = await completeReview(first, io, reviewing);
        report = reviewed.report;
        result = reviewed;
      } else {
        result = await runChain(project, chain, request, first, io);
      }
    } else {
      // 清理只对正文做：JSON 产物里的 ``` 由 stripCodeFence 在解析时处理，
      // 在这里剥会把「去掉开场白」那几条正则用到 JSON 上，可能切坏结构。
      const raw = stage === 'manuscript' ? cleanOutput(first.text) : first.text.trim();
      result = { raw, notes: singleShotNotes(stage, raw, first.stop, request.range), calls: 1 };
    }

    const raw = result.raw;
    handlers.onDone(raw);
    const artifact = parseDraftArtifact(request.action, raw, request.target, request.range);
    draft = {
      id: makeDraftId(),
      action: request.action,
      target: request.target,
      raw,
      artifact,
      summary: artifact ? describeArtifact(artifact) : undefined,
      words: countWords(raw),
      reasoning: reasoning || undefined,
      createdAt: new Date().toISOString(),
      ...(request.range ? { range: request.range } : {}),
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
      calls: result.calls,
      ...(writing ? { writeMode: writing.mode } : {}),
      ...(report ? { review: report } : {}),
      ...(writing && written
        ? {
            length: {
              words: written.words,
              target: writing.target,
              added: written.added,
              rounds: written.rounds,
              reached: !written.short,
            },
            ...(written.replay ? { replay: written.replay } : {}),
            ...(written.untrimmed ? { untrimmed: written.untrimmed } : {}),
          }
        : {}),
    };
    if (result.notes.length > 0) {
      log.warn(`${what}：${result.notes.length} 处降级或说明`, result.notes.join('\n'));
    }
    // 有实测用量就记一笔：估算准不准，只有对着服务商的账单才看得出来。
    recordUsage('创作', built.usedTokens, usage);
    const usageNote = describeUsage(built.usedTokens, usage);
    log.info(
      `${what}完成`,
      `产出 ${full.length} 字，调用 ${result.calls} 次，用时 ${elapsed(startedAt)}` +
        `${reasoning ? `；另有思考 ${reasoning.length} 字` : ''}` +
        `${usageNote ? `；${usageNote}` : ''}`
    );
    await clearFailure(project, request.target);
  } catch (err) {
    if (err instanceof CancelledError || options.signal.aborted) {
      log.warn('生成被取消', `已产出内容，用时 ${elapsed(startedAt)}`);
      handlers.onCancelled();
    } else if (err instanceof ChainError) {
      // 链走不下去：已经收到的输出留在气泡里（作者能拿去手改），不出落盘卡片。
      handlers.onDone(full.trim());
      log.error(`${what}失败：${err.message}`, [`调用 ${err.calls} 次`, ...err.notes].join('\n'));
      handlers.onError(err.message);
      await noteFailure(project, request.target, `${what}失败：${err.message}`, `位置 ${where}；调用 ${err.calls} 次`);
    } else {
      log.error(`${what}失败：${describeError(err)}`, err);
      handlers.onError(describeError(err));
      await noteFailure(project, request.target, `${what}失败：${describeError(err)}`, `位置 ${where}`);
    }
  }

  return { draft, built };
}

// ---------------------------------------------------------------- 内部

/** 按产物种类接上对应的那条链（generation/structured.ts）。 */
async function runChain(
  project: NovelProject,
  chain: NonNullable<ReturnType<typeof chainOf>>,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  first: CallOutcome,
  io: ChainIO
): Promise<ChainResult> {
  switch (chain) {
    case 'config':
      return completeConfig(first, io, {
        existing: await project.readBookConfig(),
        // 只有一句话弹窗发起时，作者这句话才是「一句话」那一节本身；在对话里说的
        // 「把金手指改狠一点」是修改意见，写进「一句话」就错了。
        idea: request.setup ? request.ask.trim() || undefined : undefined,
        setup: request.setup,
      });
    case 'roster':
      return completeRoster(first, io);
    case 'blueprints':
      return completeBlueprints(first, io, chaptersOf(request.range!));
    case 'manuscript':
    case 'revision':
      // 正文那一条要的东西（写法、已有正文、上一章结尾）在 `planWriting` 里，走不到这里。
      throw new Error('正文的续写链缺了写法。');
    case 'review':
      throw new Error('审稿链缺了待审的正文。');
  }
}

// ---------------------------------------------------------------- 写正文

/** 流式期间多久报一次进度。 */
const PROGRESS_INTERVAL_MS = 300;

const WRITE_MODE_LABEL: Record<WriteMode, string> = {
  write: '新写一章',
  continue: '接着写（追加）',
  rewrite: '重写（覆盖前审阅）',
  revise: '按审稿意见修稿（覆盖前审阅）',
};

/**
 * 重写时交给 `revision` 层的那句修改意见。作者这一轮说的话已经在「补充要求」与执行卡里，
 * 这里不再抄一遍。
 */
const REWRITE_FEEDBACK = '照本章细纲与上面的补充要求重写这一章。上一版里与细纲不冲突、写得好的段落可以保留。';

export interface WritingPlan {
  mode: WriteMode;
  /** 目标字数。修稿时是原稿的字数：只给进度条用，不据此续写。 */
  target?: number;
  /** `continue` 写法下本章已有的正文；其余是空串。 */
  existing: string;
  prevEnding?: string;
  revision?: { previousDraft: string; feedback: string };
  /** 本章细纲的章末钩子：收尾过早要回退时按它找收尾那一段（五期补遗 §1.1）。 */
  hook?: string;
  /**
   * 后面几章才登场的人（带角色卡上的专属称呼）：写完查有没有提前写进来（§1.2）。与执行卡里
   * 「本章不出场」那一行同一个函数、同一个窗口算的（context/layers/dialog.ts 的 `promptFactsOf`）。
   */
  notYet: (NotYet & { aliases: string[] })[];
  /** 这本书写正文时不该用的词（文风指南的禁用词表、全局要求里禁止的词、古代题材的现代说法）：写完数一遍。 */
  banned: string[];
}

/**
 * 写法按磁盘定：这一章还没有正文 → `write`；明说了接着写 → `continue`；明说了修稿 → `revise`；
 * 其余 → `rewrite`。
 *
 * 纯函数单列出来：「对话里发写正文、这一章已经有正文」从前是追加，现在是覆盖审阅——
 * 这条改动的判据只在这里（见 model/pipeline.ts 的 `WriteMode`）。修稿要一章已有的正文，
 * 没有正文时它不成立，调用方据此报错（不会退成「新写一章」）。
 */
export function resolveWriteMode(body: string, requested?: WriteMode): WriteMode {
  if (!body.trim()) {
    return 'write';
  }
  return requested === 'continue' || requested === 'revise' ? requested : 'rewrite';
}

/**
 * 写正文之前要从磁盘知道的事。
 *
 * - **目标字数**：请求给了用请求的，否则细纲的 `targetWords`，再否则配置的每章字数（D6）。
 *   agent 工具与快速续写不传它，从此也有目标。
 * - **上一章结尾**：按磁盘现读（重演检测用），不取上下文里那一份——那一份可能被整章全文
 *   取代、或被作者取消勾选。
 *
 * 批量写章（features/pipelineBatch.ts）也走这一份：两条路的写法、目标与重演检测必须同源。
 */
export async function planWriting(project: NovelProject, request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<WritingPlan> {
  const relPath = plotOfTarget(request.target);
  const plot = relPath ? await project.resolvePlot(relPath) : undefined;
  const no = plot?.no ?? (relPath ? parsePlotFileName(basename(relPath))?.no : undefined) ?? request.targetNo;
  const book = await project.readBookConfig();
  const target = request.targetWords ?? plot?.targetWords ?? book.wordsPerChapter;
  const banned = bannedTerms({
    styleBanList: pickSections(await project.readStyleGuide(), ['禁用词表']).禁用词表,
    guidance: book.sections.全局要求,
    genre: `${book.genre} ${book.subGenre}`,
  });
  const chapter = no ? await project.getChapter(no) : undefined;
  const body = chapter ? await project.readChapterText(chapter) : '';
  const mode = resolveWriteMode(body, request.writeMode);
  const prev = no && no > 1 ? await project.getChapter(no - 1) : undefined;
  const prevText = prev ? await project.readChapterText(prev) : '';
  if (mode === 'revise') {
    // 修稿的「上一版」就是磁盘上此刻这一章：清单是按它定位过的（controller 在发起前重新定位过）。
    return {
      mode,
      target: countWords(body),
      existing: '',
      prevEnding: prevText.trim() ? previousEnding(prevText) : undefined,
      revision: { previousDraft: body, feedback: request.reviseBrief?.trim() ?? '' },
      notYet: [],
      banned,
    };
  }
  return {
    mode,
    target: target && target > 0 ? target : undefined,
    existing: mode === 'continue' ? body : '',
    prevEnding: prevText.trim() ? previousEnding(prevText) : undefined,
    revision: mode === 'rewrite' ? { previousDraft: body, feedback: REWRITE_FEEDBACK } : undefined,
    ...(plot?.sections.章末钩子.trim() ? { hook: plot.sections.章末钩子 } : {}),
    notYet: no ? await notYetOf(project, no, plot) : [],
    banned,
  };
}

/**
 * 第 `no` 章「本章不出场」的人，带角色卡上的专属称呼。窗口与装配器的 `plotAhead` 一样：后
 * {@link AHEAD_PLOTS} 章里排过细纲的。本章细纲自己提到了的人不算（`dropMentioned`）。
 */
async function notYetOf(project: NovelProject, no: number, plot: Plot | undefined): Promise<(NotYet & { aliases: string[] })[]> {
  const plots = await project.listPlots();
  const list = notYetOnStage({
    self: plot?.characters ?? [],
    previous: plots.filter((p) => p.no < no),
    ahead: plots.filter((p) => p.no > no && p.no <= no + AHEAD_PLOTS && isPlotFilled(p.sections)),
  });
  if (list.length === 0) {
    return [];
  }
  const cards = await project.listCharacters();
  const withAliases = list.map((who) => ({ ...who, aliases: cards.find((c) => c.name === who.name)?.aliases ?? [] }));
  return dropMentioned(withAliases, plot ? Object.values(plot.sections).join('\n') : '');
}

/**
 * 审稿之前要从磁盘知道的事：这一章的正文（去掉标题行）与指纹、冻结的目标清单。
 * 这一章还没有正文时 undefined——没有东西可审。
 */
export async function planReview(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<ReviewChainContext | undefined> {
  const relPath = plotOfTarget(request.target);
  const plot = relPath ? await project.resolvePlot(relPath) : undefined;
  const no = plot?.no ?? (relPath ? parsePlotFileName(basename(relPath))?.no : undefined) ?? request.targetNo;
  const chapter = no ? await project.getChapter(no) : undefined;
  const text = chapter ? await project.readChapterText(chapter) : '';
  if (!chapter || !no || !text.trim()) {
    return undefined;
  }
  return {
    text,
    goals: plot ? freezeGoals(plot.sections.关键事件, plot.sections.章末钩子) : [],
    chapterNo: no,
    chapterTitle: plot?.title || (isFallbackChapterTitle(no, chapter.title) ? undefined : chapter.title),
    chapterRelPath: chapter.relPath,
    chapterHash: chapter.contentHash,
  };
}

/**
 * Draft id。
 *
 * 与 `makeTurnId` 同一套理由：它是会话文件里的外键，同一毫秒内连开两份
 * （agent 一轮里生成两次）必须保证不撞。
 */
let draftCounter = 0;
export function makeDraftId(): string {
  draftCounter += 1;
  return `d${Date.now().toString(36)}-${draftCounter.toString(36)}`;
}

/** 目标的人话描述，日志与失败记录共用。 */
async function describe(project: NovelProject, target: CreationTarget): Promise<string> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await project.resolvePlot(relPath);
  return describeTarget(target, { no: plot?.no, title: plot?.title });
}

/** 失败挂在**细纲**上（工程页那一行）。大纲没有归属行，只进日志。 */
async function noteFailure(
  project: NovelProject,
  target: CreationTarget,
  message: string,
  detail: string
): Promise<void> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return;
  }
  await recordFailure(project, {
    scope: '创作',
    targetKind: 'plot',
    targetKey: relPath,
    severity: 'error',
    op: 'creation',
    message,
    detail,
  });
}

async function clearFailure(project: NovelProject, target: CreationTarget): Promise<void> {
  const relPath = plotOfTarget(target);
  if (relPath) {
    await clearFailures(project, 'plot', relPath, 'creation');
  }
}

/**
 * 把这次装配的结果写进日志。
 *
 * 只记条目名与 token 数，**绝不记 prompt 全文**——那是十万字级的东西，
 * 一次就能把整个日志缓冲挤空。降级/丢弃的条目单列一段，对应
 * 「不静默截断」那条承诺：界面上的明细折叠着，日志里得看得见。
 */
function logAssembly(built: BuiltContext, startedAtMs: number): void {
  const kept = built.items.filter((i) => i.status === 'included' || i.status === 'degraded');
  const lost = built.items.filter((i) => i.status === 'dropped' || i.status === 'degraded');
  const percent = built.budget > 0 ? Math.round((built.usedTokens / built.budget) * 100) : 0;

  log.info(
    `上下文已装配：${built.usedTokens}/${built.budget} token（${percent}%），${kept.length} 项`,
    `${built.messages.length} 条消息，用时 ${elapsed(startedAtMs)}` +
      `${built.budgetClampedByProvider ? '｜预算被服务商配额压低' : ''}`
  );
  if (lost.length > 0) {
    log.warn(
      `${lost.length} 项被降级或丢弃`,
      lost.map((i) => `${statusLabel(i.status)} ${i.label}${i.note ? `——${i.note}` : ''}`).join('\n')
    );
  }
}

function statusLabel(status: string): string {
  return status === 'degraded' ? '[降级]' : status === 'dropped' ? '[丢弃]' : `[${status}]`;
}
