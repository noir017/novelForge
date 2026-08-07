/**
 * Token 计数的**可替换实现**。
 *
 * 改造前这里只有一个写死的 `estimateTokens`：中文 ×1.5、拉丁 ÷4。它够用，
 * 但每一处预算计算都直接调那个函数，想换一套更准的算法（tiktoken、服务商的
 * count_tokens 接口、按模型分词器区分）就得改遍全仓库。
 *
 * 现在拆成三层：
 *
 * 1. `TokenCounter` —— 接口。一个计数器要能「数一段文本」与「反推字符数」
 *    （截断需要后者），可选 `prepare()` 供需要加载 wasm / 词表的实现用。
 * 2. 注册表 —— `registerTokenCounter` / `useTokenCounter`。宿主启动时可以
 *    注册更准的实现并切过去，core 里其余代码只认 `countTokens`。
 * 3. `HeuristicTokenCounter` —— 默认实现，就是原来那套系数，零依赖、同步、
 *    永不失败。它是兜底：任何更准的实现加载失败都退回它。
 *
 * 另有一条**校准回路**：服务商返回真实用量时调 `recordUsage`，这里记下
 * 「估算 / 实际」的比值。目前只用于日志与统计展示，**不自动修正估算值**——
 * 估算必须是纯函数，否则同一份上下文两次装配会得出不同的预算判断，
 * 「不静默截断」的明细也就不可复现了。将来要做自适应计数器，`usageStats()`
 * 就是它的输入。
 */

/** 一次真实请求的 token 用量，由服务商返回。字段缺席表示该服务商没给。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface TokenCounter {
  /** 稳定标识，注册表的键。 */
  readonly id: string;
  /** 展示名，出现在日志与设置页。 */
  readonly label: string;
  /**
   * 精度自述。`estimate` 表示只保证量级正确（预算里另留安全余量），
   * `exact` 表示与服务商的分词结果一致。
   */
  readonly accuracy: 'estimate' | 'exact';
  /**
   * 需要异步初始化时实现它（加载 wasm、拉取词表）。注册表在切换时调用一次，
   * 失败则保留当前计数器——**计数器坏掉不能让写作流程停下**。
   */
  prepare?(): Promise<void>;
  /** 数一段文本的 token 数。必须同步：装配器的预算判断是逐条同步做的。 */
  count(text: string): number;
  /**
   * 给定 token 预算，反推大致能放多少个字符。截断用。
   * 宁可少给（截短一点），不能多给（超预算）。
   */
  charsFor(tokens: number): number;
}

/**
 * 默认实现：按字符类别加权。
 *
 * 不引入 tiktoken：一是体积大、需要 wasm，二是不同服务商分词器本就不同，
 * 精确到个位没有意义。这里只要保证「不低估」，预算里再留安全余量即可。
 *
 * 经验系数：
 * - 中日韩字符：约 1 字 ≈ 1.5 token（GPT 系分词器对中文并不友好）
 * - 拉丁字母：约 4 字符 ≈ 1 token
 * - 其余字符（标点、空白、数字）：约 3 字符 ≈ 1 token
 */
export class HeuristicTokenCounter implements TokenCounter {
  readonly id = 'heuristic';
  readonly label = '字符加权粗估';
  readonly accuracy = 'estimate' as const;

  constructor(
    private readonly weights: { cjk: number; latin: number; other: number } = {
      cjk: 1.5,
      latin: 1 / 4,
      other: 1 / 3,
    }
  ) {}

  count(text: string): number {
    if (!text) {
      return 0;
    }
    let cjk = 0;
    let latin = 0;
    let other = 0;

    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (isCjk(code)) {
        cjk++;
      } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        latin++;
      } else {
        other++;
      }
    }

    return Math.ceil(cjk * this.weights.cjk + latin * this.weights.latin + other * this.weights.other);
  }

  /** 按中文为主反推——中文最「贵」，用它算出的字符数最保守。 */
  charsFor(tokens: number): number {
    return Math.floor(tokens / this.weights.cjk);
  }
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0x3000 && code <= 0x303f) // 中日韩标点
  );
}

// ---------------------------------------------------------------- 注册表

const counters = new Map<string, TokenCounter>();
const fallback = new HeuristicTokenCounter();
let active: TokenCounter = fallback;

registerTokenCounter(fallback);

export function registerTokenCounter(counter: TokenCounter): void {
  counters.set(counter.id, counter);
}

export function listTokenCounters(): TokenCounter[] {
  return [...counters.values()];
}

export function activeTokenCounter(): TokenCounter {
  return active;
}

/**
 * 切换当前计数器。未注册的 id 或 `prepare()` 抛错都当作切换失败：
 * 保持原计数器并返回 false，绝不让写作流程因为「数不了 token」停下。
 */
export async function useTokenCounter(id: string): Promise<boolean> {
  const next = counters.get(id);
  if (!next) {
    return false;
  }
  try {
    await next.prepare?.();
  } catch {
    return false;
  }
  active = next;
  return true;
}

/** 测试与宿主重启用：退回默认实现。 */
export function resetTokenCounter(): void {
  active = fallback;
}

/** 数一段文本的 token 数（走当前计数器）。 */
export function countTokens(text: string): number {
  return active.count(text);
}

/** 目标 token 数对应的大致字符数（走当前计数器）。 */
export function charsForTokens(tokens: number): number {
  return Math.max(0, active.charsFor(tokens));
}

// ---------------------------------------------------------------- 校准统计

export interface UsageSample {
  /** 来源，如「续写」「摘要」。 */
  scope: string;
  /** 发出请求前我们估的输入 token。 */
  estimated: number;
  /** 服务商返回的真实输入 token。 */
  actual: number;
}

export interface UsageStats {
  samples: number;
  /** 累计估算值 / 累计真实值。>1 表示我们高估（安全方向）。 */
  ratio: number;
  estimatedTotal: number;
  actualTotal: number;
  /** 服务商真实计费的输出 token 累计。 */
  outputTotal: number;
}

const MAX_SAMPLES = 200;
const samples: UsageSample[] = [];
let outputTotal = 0;

/**
 * 记一次真实用量。
 *
 * 只在服务商确实返回了 usage 时调用（OpenAI 需要 `stream_options.include_usage`，
 * Anthropic 在 message_start / message_delta 里给）。没有 usage 的服务商
 * 什么都不记——宁可样本少，也不能拿估算值冒充实测把比值污染掉。
 */
export function recordUsage(scope: string, estimated: number, usage: TokenUsage): void {
  if (usage.outputTokens !== undefined) {
    outputTotal += usage.outputTokens;
  }
  if (usage.inputTokens === undefined || usage.inputTokens <= 0 || estimated <= 0) {
    return;
  }
  samples.push({ scope, estimated, actual: usage.inputTokens });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
}

export function usageStats(): UsageStats {
  const estimatedTotal = samples.reduce((sum, s) => sum + s.estimated, 0);
  const actualTotal = samples.reduce((sum, s) => sum + s.actual, 0);
  return {
    samples: samples.length,
    ratio: actualTotal > 0 ? estimatedTotal / actualTotal : 1,
    estimatedTotal,
    actualTotal,
    outputTotal,
  };
}

export function resetUsageStats(): void {
  samples.length = 0;
  outputTotal = 0;
}

/**
 * 一句话描述本次估算与实测的偏差，供日志用。没有实测数据时返回 undefined。
 * 用途是让作者在日志页能看出「插件报的 token 数靠不靠谱」。
 */
export function describeUsage(estimated: number, usage: TokenUsage): string | undefined {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    const delta = estimated > 0 ? Math.round(((estimated - usage.inputTokens) / usage.inputTokens) * 100) : 0;
    parts.push(
      `输入实测 ${usage.inputTokens} token（估算 ${estimated}，偏差 ${delta > 0 ? '+' : ''}${delta}%）`
    );
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`输出 ${usage.outputTokens} token`);
  }
  return parts.length > 0 ? parts.join('；') : undefined;
}
