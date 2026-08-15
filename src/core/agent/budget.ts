/**
 * 预算闸门与无进展检测。**第 4 条（不偷偷烧 token）在 agent 上的落点。**
 *
 * ## 三条上限
 *
 * | 上限 | 缺省 | 挡的是什么 |
 * |---|---|---|
 * | `steps` | 20 | 一直查下去不收尾的循环 |
 * | `calls` | 10 | **花钱的**工具调用（generate）。这一条最贵 |
 * | `tokens` | 200k | 上下文涨起来之后每一步都在重烧 |
 *
 * ## 触顶不静默停
 *
 * `exceeded()` 只是**报出触了哪一条**，停不停由循环决定；循环收到之后给模型
 * 最后一次机会（`toolChoice: 'none'`）说明「做到哪了、还差什么」，再结束。
 * 直接掐断的话作者只看到一段没头没尾的输出，不知道该从哪接着做。
 *
 * ## 无进展检测：最常见的烧钱方式
 *
 * 模型卡在一个读不到的路径上反复重试——`read plots/012.md` 失败、想一想、
 * 再 `read plots/012.md`。每一次都是一整轮上下文的钱。
 *
 * 判据是**同工具 + 同参数**（`JSON.stringify` 后相等）：
 *
 * - 连续第 2 次 → `stalled: true`，循环给它一条 tool 结果说「你刚用同样的参数
 *   调过，结果一样，换个思路或者结束」。
 * - 连续第 3 次 → `stop: true`，循环直接停。
 *
 * 判「连续」而不是「出现过」：`read` 同一份文件两次、中间隔着别的动作是正常的
 * （先看细纲、再看场景、回头核对细纲）。真正该拦的是原地打转。
 */
import { scoped } from '../runtime/logger';

const log = scoped('Agent');

export interface BudgetLimits {
  /** 最多几个回合（一个回合 = 一次模型调用 + 若干工具）。 */
  steps: number;
  /** 最多几次**花钱的**工具调用（generate）。 */
  calls: number;
  /** 累计输入 + 输出 token 上限。 */
  tokens: number;
}

export const DEFAULT_LIMITS: BudgetLimits = { steps: 20, calls: 10, tokens: 200_000 };

/** 触顶的说明。`what` 给循环分支用，`message` 直接进气泡与日志。 */
export interface BudgetExceeded {
  what: 'steps' | 'calls' | 'tokens';
  message: string;
}

/** 一次工具调用的记账结果。 */
export interface ToolRecord {
  /** 连续第 2 次同工具同参数。循环据此提醒模型换个思路。 */
  stalled: boolean;
  /** 连续第 3 次。循环据此直接停——再走下去只是重复烧钱。 */
  stop: boolean;
  /** 重复了几次（含这一次）。 */
  repeats: number;
}

/** 连续几次同工具同参数算「提示」，几次算「停」。 */
export const STALL_WARN_AT = 2;
export const STALL_STOP_AT = 3;

export class Budget {
  readonly limits: BudgetLimits;
  steps = 0;
  calls = 0;
  tokens = 0;

  /** 上一次工具调用的指纹与它连续重复了几次。 */
  private lastKey = '';
  private repeats = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = {
      steps: positive(limits.steps, DEFAULT_LIMITS.steps),
      calls: positive(limits.calls, DEFAULT_LIMITS.calls),
      tokens: positive(limits.tokens, DEFAULT_LIMITS.tokens),
    };
  }

  /** 开始一个回合。 */
  step(): void {
    this.steps += 1;
  }

  /** 记一次模型用量。 */
  addTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) {
      this.tokens += Math.trunc(n);
    }
  }

  /**
   * 触顶了吗。**只报，不停**——停不停是循环的决定，而且它还要给模型最后一次
   * 总结的机会。
   */
  exceeded(): BudgetExceeded | undefined {
    if (this.steps >= this.limits.steps) {
      return {
        what: 'steps',
        message: `已经跑了 ${this.steps} 个回合（上限 ${this.limits.steps}），到此为止。`,
      };
    }
    if (this.calls >= this.limits.calls) {
      return {
        what: 'calls',
        message: `已经生成了 ${this.calls} 次（上限 ${this.limits.calls}），到此为止。`,
      };
    }
    if (this.tokens >= this.limits.tokens) {
      return {
        what: 'tokens',
        message: `已经用掉约 ${formatTokens(this.tokens)} token（上限 ${formatTokens(
          this.limits.tokens
        )}），到此为止。`,
      };
    }
    return undefined;
  }

  /**
   * 记一次工具调用，同时做无进展检测。
   *
   * **日志里只记工具名与参数的键名，不记值**（AGENTS 第 11 条）：值里可能有
   * 正文片段（`generate` 的 `ask`）、可能有整段检索词。指纹本身算的是**值**，
   * 但它只活在内存里，不进日志。
   */
  recordTool(name: string, args: Record<string, unknown>): ToolRecord {
    const key = `${name}:${stableKey(args)}`;
    if (key === this.lastKey) {
      this.repeats += 1;
    } else {
      this.lastKey = key;
      this.repeats = 1;
    }

    const repeats = this.repeats;
    if (repeats >= STALL_WARN_AT) {
      log.warn(
        `agent 连续第 ${repeats} 次用同样的参数调 ${name}`,
        `参数键：${Object.keys(args).join(', ') || '（无）'}` +
          `｜${repeats >= STALL_STOP_AT ? '已停止本次循环' : '已提示它换个思路'}`
      );
    }
    return { stalled: repeats >= STALL_WARN_AT, stop: repeats >= STALL_STOP_AT, repeats };
  }

  /** 给模型看的那句提示。收到之后它该换路或者收尾。 */
  stallHint(name: string): string {
    return (
      `你刚才已经用同样的参数调过 ${name}，结果和上次一模一样。` +
      `换一组参数、换个工具，或者直接给出结论——重复调用不会有新信息。`
    );
  }

  /** 用户可见的用量说明。每次 `generate` 之后在气泡里显示（第 4 条）。 */
  describe(): string {
    return `已用 ${this.calls}/${this.limits.calls} 次生成，约 ${formatTokens(this.tokens)} token`;
  }
}

/**
 * 参数 → 稳定指纹。**键排序后再序列化**：`{path:'a',limit:1}` 与
 * `{limit:1,path:'a'}` 是同一次调用，模型两次填的键序未必一样。
 */
function stableKey(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  try {
    return JSON.stringify(entries);
  } catch {
    // 循环引用之类：拿键名当指纹，宁可少判一次重复，也不要在记账里抛。
    return entries.map(([k]) => k).join(',');
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function formatTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
}
