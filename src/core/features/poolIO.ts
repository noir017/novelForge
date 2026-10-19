/**
 * 工程页任务那条路的 {@link ChainIO}。从 `pipelineBatch.ts` 挪出来单放：批量拆细纲要调
 * `lore.ts` 的批量展开，批量展开又要用它，放在任何一边都会互相 import。
 */
import { readConfig } from '../config';
import { collect } from '../llm/collect';
import { ModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { BuildRequest, buildContext } from '../context/builder';
import { CallOutcome, ChainIO } from '../generation/structured';

/**
 * 批量那条路的 {@link ChainIO}：每次调用走分档池（失败换同档其余，第 12 条），
 * 装配用干活那个模型的窗口（第 13 条：`pool.primaryBudget`），不带思考深度（第 26 条）。
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
  };
  return { chain, calls: () => count };
}
