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
import { buildProvider } from '../llm/registry';
import { readConfig } from '../config';
import { ThinkingDepth } from '../model/thinking';
import { appendDump, dumpContext } from '../runtime/debug';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { countWords } from '../model/fs';
import { NovelProject } from '../model/project';
import {
  CreationJob,
  CreationTarget,
  JOB_LABEL,
  describeTarget,
  plotOfTarget,
} from '../model/pipeline';
import { describeModelIssue, providerLabel } from '../model/providers';
import { Artifact, describeArtifact, isArtifactEmpty, parseArtifact } from '../features/artifact';
import { cleanOutput } from '../features/creation';

const log = scoped('创作');

/** 一次生成的产出。**尚未落盘**，采纳时才写。 */
export interface Draft {
  id: string;
  job: CreationJob;
  target: CreationTarget;
  /** 模型原样输出（正文已过 `cleanOutput`）。 */
  raw: string;
  /** 解析出的结构化产物。解析不出内容时缺席。 */
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
  /**
   * 让模型想多深。缺省不带思考参数（服务商默认）。
   *
   * 对话页把作者在会话里选的那一档递进来；工程页的批量任务不递——第 12 条
   * 那条理由的同一面：那一档模型是作者按成本挑的，替他把七十六章的摘要
   * 都升级成深思考，账单上看不出是谁决定的。
   */
  thinking?: ThinkingDepth;
  /**
   * 这一次算在哪个会话名下。**只给调试模式用**：开着时完整上下文落在
   * `.novelforge/sessions/<id>.debug/` 下（见 runtime/debug.ts）。
   *
   * 缺席不影响生成，只是那一次不留快照——工程页的批量任务没有会话，
   * 硬造一个落点只会在工程里留下没人认领的目录。
   */
  sessionId?: string;
}

export interface GenerateResult {
  /** 失败或模型引用无效时缺席。 */
  draft?: Draft;
  /** 装配明细。装配之前就失败时缺席。 */
  built?: BuiltContext;
}

/**
 * 把一次生成的输出解析成产物。**不写盘。**
 *
 * 解析出来是空的返回 undefined——写一个空产物比不写更糟，作者会以为存下了。
 */
export function parseDraftArtifact(job: CreationJob, raw: string): Artifact | undefined {
  const artifact = parseArtifact(job, raw);
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
  const what = JOB_LABEL[request.job];
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
  // 调试模式：这一次到底发出去了什么，原样落一份在会话旁边。**在发请求之前
  // 写**——请求可能卡死，那时最该看的就是这一份。关着时它整个是空转。
  const dumpAt = await dumpContext(project, {
    sessionId: options.sessionId,
    slug: `generate-${request.job}`,
    title: `${what}：${where}`,
    facts: [
      ['模型', provider.label],
      ['任务', `${request.job}（${what}）`],
      ['目标字数', request.targetWords],
      ['思考深度', options.thinking],
      ['预算', `${built.usedTokens}/${built.budget} token`],
      ['引用', request.attachments?.length],
      ['技能', request.skills?.map((s) => s.name).join('、')],
    ],
    sections: [{ heading: '装配明细', body: describeAssembly(built) }],
    messages: built.messages,
  });

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
    const raw = request.job === 'manuscript' ? cleanOutput(full) : full.trim();
    handlers.onDone(raw);
    // 实测用量先记下来：产出为空这一次的钱也照样花了（第 4 条），
    // 而且「入 2927 / 出 0」正是查这类空响应的第一条线索。
    recordUsage('创作', built.usedTokens, usage);
    const usageNote = describeUsage(built.usedTokens, usage);

    // 一个字正文都没有：**这不是一份产物，不许造 Draft**。
    //
    // 抓到过的现场：上游（新版 DeepSeek 之类的推理模型，经中转网关）吐完
    // 1893 字思考就把流断了，没有 message_stop、没有正文、实测输出 0 token。
    // 从前这里照样造出一份 `raw: ''` 的草稿，于是一路装成成功——工具回
    // 「已生成：分卷清单 · 0 字」，agent 转头跟作者说「正在等你点头」，
    // 而根本没有任何卡片弹出来（`onArtifact` 解析不出形状就不问）。
    // 空产物必须在这里就变成一次失败：调用方（`tools/novel/generate.ts`）
    // 见 `draft` 缺席才会把错误如实报给 agent。
    if (!raw) {
      const why = reasoning
        ? `模型只输出了思考（${reasoning.length} 字），一个字正文都没给`
        : '模型什么都没输出';
      log.error(
        `${what}没有产出内容`,
        `${why}；用时 ${elapsed(startedAt)}${usageNote ? `；${usageNote}` : ''}`
      );
      await appendDump(
        dumpAt,
        '这一次没有产出内容',
        `- ${why}\n- 用时：${elapsed(startedAt)}\n` +
          `- 实测用量：入 ${usage.inputTokens ?? '—'} / 出 ${usage.outputTokens ?? '—'}\n` +
          `${reasoning ? `\n### 思考\n\n${reasoning}\n` : ''}`
      );
      handlers.onError(
        `${what}没有产出内容：${why}。` +
          '多半是上游在思考与正文之间断了流。可以再试一次；' +
          '同一个模型反复如此，就把思考深度降一档或换一个模型。'
      );
      await noteFailure(project, request.target, `${what}没有产出内容：${why}`, `位置 ${where}`);
      return { built };
    }

    const artifact = parseDraftArtifact(request.job, raw);
    draft = {
      id: makeDraftId(),
      job: request.job,
      target: request.target,
      raw,
      artifact,
      summary: artifact ? describeArtifact(artifact) : undefined,
      words: countWords(raw),
      reasoning: reasoning || undefined,
      createdAt: new Date().toISOString(),
    };
    await appendDump(
      dumpAt,
      '模型的回答',
      `- 用时：${elapsed(startedAt)}\n` +
        `- 实测用量：入 ${usage.inputTokens ?? '—'} / 出 ${usage.outputTokens ?? '—'}\n` +
        `- 产物：${draft.summary ?? '（解析不出结构化产物）'}\n` +
        `${reasoning ? `\n### 思考\n\n${reasoning}\n` : ''}` +
        `\n### 正文（${draft.words} 字）\n\n${raw}`
    );
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
      await appendDump(dumpAt, '这一次被取消了', `用时 ${elapsed(startedAt)}`);
      handlers.onCancelled();
    } else {
      await appendDump(dumpAt, '这一次失败了', `${describeError(err)}\n\n用时 ${elapsed(startedAt)}`);
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

/**
 * 装配明细排成一张表，**给调试快照用**。
 *
 * 与 `logAssembly` 那条日志是两件事：日志只说数（十万字的正文进不了日志缓冲），
 * 这里说的是「每一条各占多少、留没留下、为什么」——排查「它为什么没看见那份
 * 细纲」时，答案通常就在某一行的 `[丢弃] 预算不足` 上。**仍然不含条目正文**：
 * 正文就在下面那几条消息里，抄两遍只会让文件翻倍。
 */
function describeAssembly(built: BuiltContext): string {
  const lines = built.items.map(
    (i) =>
      `| ${statusLabel(i.status)} | ${i.label} | ${i.tokens} | ${i.source ?? ''} | ${i.note ?? ''} |`
  );
  return [
    `共 ${built.items.length} 条，用掉 ${built.usedTokens}/${built.budget} token` +
      `${built.budgetClampedByProvider ? '（预算被服务商配额压低）' : ''}`,
    '',
    '| 状态 | 条目 | token | 来源 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...lines,
  ].join('\n');
}

function statusLabel(status: string): string {
  return status === 'degraded' ? '[降级]' : status === 'dropped' ? '[丢弃]' : `[${status}]`;
}
