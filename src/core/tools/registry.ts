/**
 * 工具注册表：**一组 `ToolDef` + 一份环境 = 一个能被调用的工具集**。
 *
 * 它是 {@link ToolInvoker} 的实现，也是这一层唯一的执行入口。四件事：
 *
 * 1. **注册时校验**（[schema.ts](schema.ts)）——描述写歪了当场抛，不留到线上；
 * 2. **`ToolDef[]` → `ToolSpec[]`**，透传给各家 API；
 * 3. **执行时兜住一切**——认不出的名字、工具抛的异常，都变成一条模型读得懂的
 *    结果。**`invoke` 绝不抛**：一个工具炸掉不该带走整轮对话；
 * 4. **记一条日志**——工具名与**参数的键名**，不记值（第 11 条：值里可能有
 *    整段正文）。
 *
 * ## 为什么执行也在这一层
 *
 * 从前「跑一个工具」那三十行住在 agent 的循环里：计时、兜异常、翻 draft store
 * 认新草稿、拼「没有叫 X 的工具」那句话。它们没有一件是**调度**——换一个调用
 * 方（另一个循环、将来的 MCP server）就得原样再抄一遍，而抄漏一条（比如没兜住
 * 异常）不会红，只会在某天让一整轮对话炸掉。
 *
 * 所以调用方那边只剩一行 `await tools.invoke(...)`。
 */
import { describeError, scoped } from '../runtime/logger';
import { validateToolDef } from './schema';
import type {
  ToolDef,
  ToolEnv,
  ToolIntent,
  ToolInvocation,
  ToolInvoker,
  ToolResult,
  ToolRun,
  ToolSpec,
} from './types';

const log = scoped('Tools');

export class ToolRegistry implements ToolInvoker {
  private readonly defs: ToolDef[];
  private readonly byName: Map<string, ToolDef>;

  /**
   * @param defs 顺序即模型看到的顺序。
   * @param env 工程那一面，绑定一次此后不变。
   */
  constructor(defs: ToolDef[], private readonly env: ToolEnv) {
    const seen = new Set<string>();
    for (const def of defs) {
      const issue = validateToolDef(def, seen);
      if (issue) {
        throw new Error(`工具「${def.name || '(无名)'}」定义有问题：${issue}`);
      }
      seen.add(def.name);
    }
    this.defs = [...defs];
    this.byName = new Map(this.defs.map((d) => [d.name, d]));
  }

  specs(): ToolSpec[] {
    // run / intent 是本地函数，透传给 API 会炸，所以逐字段挑而不是整个塞过去。
    return this.defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    }));
  }

  names(): string[] {
    return this.defs.map((d) => d.name);
  }

  /**
   * 这一步的意图。工具没实现 `intent` 时兜一个通用的：**花钱或写盘就归
   * `mutating`**（宁可多问，也不要有一条没人想过的路）。
   */
  intent(name: string, args: Record<string, unknown>): ToolIntent | undefined {
    const def = this.byName.get(name);
    if (!def) {
      return undefined;
    }
    if (def.intent) {
      return def.intent(args ?? {}, this.env.project);
    }
    return {
      gate: def.mutating || def.costly ? 'mutating' : 'auto',
      title: `执行 ${def.name}`,
      proceed: '执行',
    };
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    run: ToolRun
  ): Promise<ToolInvocation> {
    const startedAt = Date.now();
    // 第 11 条：**只记工具名与参数的键名**，不记值——值里可能有正文片段。
    log.debug(`调用工具 ${name}`, `参数键：${Object.keys(args ?? {}).join(', ') || '（无）'}`);

    const def = this.byName.get(name);
    if (!def) {
      // 名单从**实际注册的那一份**来。写死一串名字，加了工具之后这句话就在撒谎。
      const error = `没有叫 ${name} 的工具。可用的是：${this.names().join(' / ')}。`;
      return { ok: false, text: error, error, draftIds: [], elapsedMs: 0 };
    }

    let result: ToolResult;
    try {
      result = await def.run({ ...this.env, ...run }, args ?? {});
    } catch (err) {
      // 工具抛异常时变成 error 回给模型：它看到说明会换条路，而抛出去的话
      // 调用方只得到一句「处理消息时出错」，之前几步的成果全丢。
      result = { text: '', error: `工具执行失败：${describeError(err)}` };
      log.warn(`工具 ${name} 抛异常`, describeError(err));
    }

    return {
      ok: !result.error,
      text: result.error ?? result.text,
      error: result.error,
      display: result.display,
      draftIds: result.draftIds ?? [],
      elapsedMs: Date.now() - startedAt,
    };
  }
}
