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
 * ## 不动装配器
 *
 * `context/recipes.ts`、`context/prompts.ts`、`context/layers/`、
 * `context/builder.ts`、`features/artifact.ts` 一个字都不改。分阶段装配是
 * 这个项目既有质量的来源。
 */
import { BuildRequest, BuiltContext, buildContext } from '../context/builder';
import { describeUsage, recordUsage } from '../context/tokenizer';
import { mergeUsage } from '../llm/collect';
import { CancelledError, LlmProvider, StreamOptions, TokenUsage } from '../llm/provider';
import { buildProvider, resolveProvider } from '../llm/registry';
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { countWords } from '../model/fs';
import { NovelProject } from '../model/project';
import {
  CAPABILITY_LABEL,
  CreationAction,
  CreationTarget,
  STAGE_LABEL,
  describeTarget,
  outputKindOf,
  plotOfTarget,
} from '../model/pipeline';
import { describeModelIssue, providerLabel } from '../model/providers';
import { Artifact, describeArtifact, isArtifactEmpty, parseArtifact } from '../features/artifact';
import { cleanOutput } from '../features/creation';

const log = scoped('创作');

/** 一次生成的产出。**尚未落盘**，采纳时才写。 */
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原样输出（正文层已过 `cleanOutput`）。 */
  raw: string;
  /** 解析出的结构化产物。text 类能力（discuss / critique / …）没有。 */
  artifact?: Artifact;
  /** 一句话形状描述，如「剧情 · 4/4 节」。有 artifact 才有。 */
  summary?: string;
  words: number;
  /** 推理模型的思考过程。**不是正文，采纳时不取。** */
  reasoning?: string;
  createdAt: string;
}

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  /** 推理模型的思考增量。正文之前可能先想很久，界面靠它给出反馈。 */
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
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
 * text 类能力（讨论、挑刺、检查）没有可采纳的东西，返回 undefined；
 * 解析出来是空的也返回 undefined——写一个空产物比不写更糟，作者会以为存下了。
 */
export function parseDraftArtifact(
  action: CreationAction,
  target: CreationTarget,
  raw: string
): Artifact | undefined {
  if (outputKindOf(action) !== 'artifact') {
    return undefined;
  }
  // **target 也要**：大纲这一层的 `split` 在全书大纲上拆出分卷清单，在一卷上
  // 拆出一个剧情段。只看 action 分不开（卷不是独立阶段，见 model/pipeline.ts）。
  const artifact = parseArtifact(action, target, raw);
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
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  handlers: GenerateHandlers,
  options: GenerateOptions
): Promise<GenerateResult> {
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
  };

  let draft: Draft | undefined;
  try {
    let full = '';
    let firstDeltaAt = 0;
    for await (const ev of provider.stream(built.messages, streamOptions)) {
      if (ev.type === 'text') {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          log.debug('首个分片已到达', `首字延迟 ${elapsed(startedAt, firstDeltaAt)}`);
        }
        full += ev.text;
        handlers.onDelta(ev.text, full);
      } else if (ev.type === 'reasoning') {
        reasoning += ev.text;
        handlers.onReasoning?.(ev.text, reasoning);
      } else if (ev.type === 'usage') {
        mergeUsage(usage, ev.usage);
      }
    }
    // 清理只对正文做：JSON 产物里的 ``` 由 stripCodeFence 在解析时处理，
    // 在这里剥会把「去掉开场白」那几条正则用到 JSON 上，可能切坏结构。
    const raw = stage === 'manuscript' ? cleanOutput(full) : full.trim();
    handlers.onDone(raw);
    const artifact = parseDraftArtifact(request.action, request.target, raw);
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
    };
    // 有实测用量就记一笔：估算准不准，只有对着服务商的账单才看得出来。
    recordUsage('创作', built.usedTokens, usage);
    const usageNote = describeUsage(built.usedTokens, usage);
    log.info(
      `${what}完成`,
      `产出 ${full.length} 字，用时 ${elapsed(startedAt)}` +
        `${reasoning ? `；另有思考 ${reasoning.length} 字` : ''}` +
        `${usageNote ? `；${usageNote}` : ''}`
    );
    await clearFailure(project, request.target);
  } catch (err) {
    if (err instanceof CancelledError || options.signal.aborted) {
      log.warn('生成被取消', `已产出内容，用时 ${elapsed(startedAt)}`);
      handlers.onCancelled();
    } else {
      log.error(`${what}失败：${describeError(err)}`, err);
      handlers.onError(describeError(err));
      await noteFailure(project, request.target, `${what}失败：${describeError(err)}`, `位置 ${where}`);
    }
  }

  return { draft, built };
}

// ---------------------------------------------------------------- 内部

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
  const plot = await project.readPlot(relPath);
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
