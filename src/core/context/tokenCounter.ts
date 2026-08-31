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
 * 3. `HeuristicTokenCounter` —— 默认实现，零依赖、同步、永不失败。
 *    它是兜底：任何更准的实现加载失败都退回它。
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
   * 给定 token 预算，反推大致能放多少个字符。
   *
   * **只是截断搜索的初值**：`tokenizer.ts` 拿它开个头，再用 `count()` 二分出
   * 真正放得下的长度。所以这里不必精确，但**宁可少给**——初值偏大只是多几轮
   * 搜索，偏小同样只是多几轮，都不会切出超预算的文本。
   */
  charsFor(tokens: number): number;
}

// ---------------------------------------------------------------- 启发式实现

/**
 * 各字符类别的**每字符 token 数**。
 *
 * 数值不是拍脑袋来的，也不可能对所有服务商同时精确——各家分词器的词表不同，
 * 同一段中文在 DeepSeek 与 Claude 上能差出六成。取值原则见 {@link TOKEN_PROFILES}。
 */
export interface TokenWeights {
  /** 中日韩表意文字 / 假名 / 谚文 / 全角标点，每字符。 */
  cjk: number;
  /** 拉丁词**词内**每字母（一个词至少 1 token，前导空格并入该词）。 */
  latin: number;
  /** 连续数字每一位（各家分词器普遍把 ≤3 位数字并成一个 token）。 */
  digit: number;
  /** ASCII 标点与符号，每字符。 */
  punct: number;
  /** 其余单码元字符（西里尔、希腊、阿拉伯、注音……），每字符。 */
  other: number;
  /** 星平面字符（emoji 等代理对），每个。 */
  astral: number;
}

/**
 * 几套分词口径。**默认是 `generic`**，其余的要由宿主显式切过去
 * （`useTokenCounter('heuristic-gpt')` 之类），核心自己不按模型自动挑：
 * 工程页的批量任务可以并发跑在**不同模型**上，而计数器是模块级单例——
 * 让它跟着「当前模型」变，等于让同一份上下文在两次装配里得出不同的预算。
 *
 * 中文那一档是最要紧的，各家差得也最远：
 * - 词表里塞满中文词的那批（DeepSeek / Qwen / GLM / Kimi）约 0.6 token/字，
 *   DeepSeek 的文档直接给了这个数（英文约 0.3 token/字符）；
 * - GPT 的 cl100k / o200k 约 0.7～0.8；
 * - Claude 一档大致 1 token/字。
 *
 * 所以缺省取 1.0：对绝大多数服务商是**高估**（安全方向，预算不会被撑破），
 * 又不像原来的 1.5 那样把窗口白白浪费掉三分之一还多。
 */
export const TOKEN_PROFILES = {
  /** 缺省：偏保守，覆盖所有主流服务商。 */
  generic: { cjk: 1, latin: 0.25, digit: 0.34, punct: 0.5, other: 1, astral: 2 },
  /** OpenAI cl100k / o200k 一系。 */
  gpt: { cjk: 0.75, latin: 0.25, digit: 0.34, punct: 0.5, other: 0.9, astral: 2 },
  /** Anthropic Claude 一系：中文最贵，英文略贵于 GPT。 */
  claude: { cjk: 1, latin: 0.28, digit: 0.4, punct: 0.55, other: 1, astral: 2.5 },
  /** 中文词表友好的国产模型：DeepSeek / Qwen / GLM / Kimi。 */
  cjkNative: { cjk: 0.62, latin: 0.3, digit: 0.34, punct: 0.5, other: 1, astral: 2 },
} as const satisfies Record<string, TokenWeights>;

/**
 * 默认实现：按**字符段**（run）加权，而不是逐字符除系数。
 *
 * 不引入 tiktoken：一是体积大、需要 wasm，二是不同服务商分词器本就不同，
 * 精确到个位没有意义。但「量级正确」也得讲究方法——原来那版把每个字符
 * 独立折算，有两处系统性偏差：
 *
 * - **英文按 4 字符 ÷ 1 算，空格再单收 1/3**。实际 BPE 把前导空格并进词里，
 *   `" the"` 是一个 token；一段英文里空格占七分之一，等于凭空多算 15%。
 *   现在按词算：一个词至少 1 token，词内每 4 字母 1 token，词间的单个空格不计。
 * - **数字逐位折算**。各家都把 ≤3 位数字并成一个 token，`2026` 是 1～2 个，
 *   不是 4/3 个。现在按数字段算。
 *
 * 还有一处纯粹是漏判：**中文逗号「，」不在原来的 CJK 区间里**（它是全角形式
 * U+FF0C，不在 U+3000–303F），于是中文正文里一成多的标点全落进「其他」那档
 * 按 1/3 算。全角区间与扩展 B 以上的汉字现在都补上了。
 */
export class HeuristicTokenCounter implements TokenCounter {
  readonly id: string;
  readonly label: string;
  readonly accuracy = 'estimate' as const;
  private readonly weights: TokenWeights;

  constructor(weights: Partial<TokenWeights> = {}, id = 'heuristic', label = '字符加权粗估') {
    this.weights = { ...TOKEN_PROFILES.generic, ...weights };
    this.id = id;
    this.label = label;
  }

  count(text: string): number {
    if (!text) {
      return 0;
    }
    const w = this.weights;
    let total = 0;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const code = text.charCodeAt(i);

      // 代理对：一个星平面字符（emoji、扩展 B 以上的生僻字）。
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
        const pair = text.codePointAt(i)!;
        total += isCjk(pair) ? w.cjk : w.astral;
        i += 2;
        continue;
      }

      const cls = classOf(code);
      let j = i + 1;
      while (j < n && classOf(text.charCodeAt(j)) === cls) {
        j++;
      }
      const len = j - i;

      switch (cls) {
        case Cls.Cjk:
          total += len * w.cjk;
          break;
        case Cls.Latin:
          // 一个词至少一个 token（前导空格并入其中），长词按每 4 字母一个。
          total += Math.max(1, len * w.latin);
          break;
        case Cls.Digit:
          total += Math.max(1, len * w.digit);
          break;
        case Cls.Space:
          total += spaceRunTokens(text, i, j);
          break;
        case Cls.Punct:
          total += len * w.punct;
          break;
        default:
          total += len * w.other;
      }
      i = j;
    }

    return Math.ceil(total);
  }

  /**
   * 截断搜索的初值。按最贵的那一档（中文）反推——中文字符最占地方，
   * 用它算出的字符数最保守。
   */
  charsFor(tokens: number): number {
    return Math.floor(tokens / Math.max(this.weights.cjk, 0.05));
  }
}

/**
 * 空白段值多少 token。
 *
 * 词与词之间那**一个**空格不单独计费——它被并进后面那个词，而词已经按
 * 「至少 1 token」算过了。换行不一样：`"\n\n"` 通常是一个独立 token，
 * 缩进那种成串的空格也是。
 */
function spaceRunTokens(text: string, from: number, to: number): number {
  let newlines = 0;
  for (let k = from; k < to; k++) {
    if (text.charCodeAt(k) === 0x0a) {
      newlines++;
    }
  }
  if (newlines > 0) {
    return Math.max(1, newlines * 0.6);
  }
  const len = to - from;
  return len > 1 ? (len - 1) * 0.25 : 0;
}

const enum Cls {
  Cjk,
  Latin,
  Digit,
  Space,
  Punct,
  Other,
}

function classOf(code: number): Cls {
  // ASCII 快路：正文之外的 Markdown 骨架几乎全在这段里。
  if (code < 0x80) {
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      return Cls.Space;
    }
    if (code >= 0x30 && code <= 0x39) {
      return Cls.Digit;
    }
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      return Cls.Latin;
    }
    return Cls.Punct;
  }
  if (isCjk(code)) {
    return Cls.Cjk;
  }
  return Cls.Other;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0x31f0 && code <= 0x31ff) || // 片假名扩展
    (code >= 0x3100 && code <= 0x312f) || // 注音符号
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0x1100 && code <= 0x11ff) || // 谚文字母
    (code >= 0x3000 && code <= 0x303f) || // 中日韩标点（、。「」……）
    (code >= 0xfe10 && code <= 0xfe1f) || // 竖排标点
    (code >= 0xfe30 && code <= 0xfe4f) || // 兼容形式
    (code >= 0xff00 && code <= 0xffef) || // 全角形式（，！？：；（）——最常见的一档
    (code >= 0x20000 && code <= 0x3ffff) // 扩展 B 以上（代理对，走 codePointAt）
  );
}

// ---------------------------------------------------------------- 注册表

const counters = new Map<string, TokenCounter>();
const fallback = new HeuristicTokenCounter();
let active: TokenCounter = fallback;

registerTokenCounter(fallback);
registerTokenCounter(new HeuristicTokenCounter(TOKEN_PROFILES.gpt, 'heuristic-gpt', '字符加权粗估 · GPT 口径'));
registerTokenCounter(
  new HeuristicTokenCounter(TOKEN_PROFILES.claude, 'heuristic-claude', '字符加权粗估 · Claude 口径')
);
registerTokenCounter(
  new HeuristicTokenCounter(TOKEN_PROFILES.cjkNative, 'heuristic-cjk', '字符加权粗估 · 中文词表口径')
);

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
