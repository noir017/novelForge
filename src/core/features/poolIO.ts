/**
 * 工程页任务那条路的 {@link ChainIO}。从 `pipelineBatch.ts` 挪出来单放：批量拆细纲要调
 * `lore.ts` 的批量展开，批量展开又要用它，放在任何一边都会互相 import。
 */
import { readConfig } from '../config';
import { CollectResult, collect } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import type { ChatMessage, LlmProvider } from '../llm/provider';
import { NovelProject } from '../model/project';
import { BuildRequest, buildContext } from '../context/builder';
import { CallOutcome, ChainIO } from '../generation/structured';
import { TRANSCRIBE_TEMPERATURE } from '../model/transcribe';
import { TranscribeCall } from './transcribe';
import { scoped } from '../runtime/logger';

const log = scoped('模型池');

/**
 * 批量那条路的 {@link ChainIO}：每次调用走分档池（失败换同档其余，第 12 条），
 * 装配用干活那个模型的窗口（第 13 条：`pool.primaryBudget`），不带思考深度（第 26 条）。
 * 转写（细纲试点）走「转写」那一档自己的池（{@link lazyTranscriber}）。
 */
export function poolIO(
  project: NovelProject,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  base: Omit<BuildRequest, 'providerMaxInputTokens'>
): { chain: ChainIO; calls: () => number } {
  let count = 0;
  const budgeted = { ...config, ...pool.primaryBudget };
  const transcriber = lazyTranscriber();
  const chain: ChainIO = {
    messages: [],
    build: async (patch) => (await buildContext(project, { ...base, ...patch }, budgeted)).messages,
    call: async (messages, label): Promise<CallOutcome> => {
      count++;
      const r = await pool.run(label, (llm) =>
        collect(
          llm.stream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      return { text: r.text, stop: r.stopReason };
    },
    transcribe: async (messages, label): Promise<CallOutcome> => {
      count++;
      const own = await transcriber();
      if (!own) {
        log.warn(`${label}：转写那一档没有可用的模型，改用干活那个模型转写`);
      }
      const r = await transcribeWith(own ?? pool, messages, label, config.requestTimeoutMs, signal);
      return { text: r.text, stop: r.stopReason };
    },
  };
  return { chain, calls: () => count };
}

/**
 * 「转写」那一档的池（2026-10-25 细纲试点；model/tiers.ts：不跟确认框上为这一次挑的模型，那一档没配就沿用默认模型），
 * 第一次用到时才建——只有细纲要转写。建不出来（一个可用的模型都没有）是 undefined，调用方退回干活那个模型并说一声。
 */
export function lazyTranscriber(): () => Promise<ModelPool | undefined> {
  let pool: Promise<ModelPool | undefined> | undefined;
  return () => (pool ??= createModelPool({ task: 'transcribe', concurrent: false }));
}

/**
 * 工程页任务（定稿、叙事线、角色卡、设定……）的转写调用（features/transcribe.ts 的 `TranscribeCall`）：走「转写」那一档，
 * 第一次用到时才建池。那一档一个可用的模型都没有时用 `fallback`（干活那个池）并说一声；连它也没有就报错——
 * `transcribeJson` 把它当成转写调用失败，写好的原文照这一步原来解析失败的走法处理。
 * `fallback` 只要能 `run`、有窗口就行（{@link TranscribeFallback}）：单章同步缺省用对话页那一个模型（features/finalize.ts 的
 * `singleModel`），不是池。
 */
export function poolTranscriber(signal: AbortSignal, fallback?: TranscribeFallback): TranscribeCall {
  const own = lazyTranscriber();
  const timeoutMs = readConfig().requestTimeoutMs;
  return async (messages, label) => {
    const pool = await own();
    if (!pool && !fallback) {
      throw new Error('转写那一档没有可用的模型');
    }
    if (!pool) {
      log.warn(`${label}：转写那一档没有可用的模型，改用干活那个模型转写`);
    }
    const r = await transcribeWith(pool ?? fallback!, messages, label, timeoutMs, signal);
    return { text: r.text, stop: r.stopReason };
  };
}

/** 转写退回时用的那一个：能 `run`、有窗口就行。池、单个模型（features/finalizeSteps.ts 的 `ModelRunner`）都是。 */
export interface TranscribeFallback {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
}

/** 转写一次：照抄，温度 0、不带思考，输出上限用转写模型自己的。失败照池的规矩换同档其余。 */
export function transcribeWith(
  pool: TranscribeFallback,
  messages: ChatMessage[],
  label: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CollectResult> {
  return pool.run(label, (llm) =>
    collect(
      llm.stream(messages, {
        maxOutputTokens: pool.primaryBudget.maxOutputTokens,
        temperature: TRANSCRIBE_TEMPERATURE,
        timeoutMs,
        signal,
      })
    )
  );
}
