/**
 * 思考深度：**这一轮让模型想多久。**
 *
 * 与 `tiers.ts` / `agentPolicy.ts` 同一个位置的东西——类型、可选值、界面上的
 * 说法在数据层定义一次（纯数据 + 纯函数、零 import，所以前端可以直接打包
 * 这一份），映射成各家的请求字段则在三个 provider 里各写一次。
 *
 * ## 一个档位，三套字段
 *
 * 三条协议都从「给个 token 预算」走到了「给个档位」，但字段名与梯子不一样：
 *
 * | 档 | OpenAI Responses | Anthropic Messages | 通用 chat/completions |
 * |---|---|---|---|
 * | 关 | 不带 `reasoning` | 不带 `thinking` / `output_config` | 不带任何思考字段 |
 * | 低 / 中 / 高 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` | 按风格，见 `ChatThinkingStyle` |
 * | 极限 | `reasoning.effort: xhigh` | `output_config.effort: max` | `max`，被拒则降档 |
 *
 * 最高那一档三家的叫法不同（`xhigh` / `max` / `max`），所以映射表分三张，
 * 界面上仍然只有一个「极限」——作者选的是「想到底」，不是某家的枚举值。
 *
 * 通用 `/chat/completions` 那一列尤其散：同一个「想深一点」在四家是四个不同
 * 的字段名（见 `ChatThinkingStyle`），所以那条路上「哪一套」是**问出来或猜
 * 出来的**，不像另两条那样固定。
 *
 * ## 为什么「关」是不带字段而不是显式关掉
 *
 * 显式关（OpenAI 的 `effort: 'none'`、Anthropic 的 `thinking: {type:'disabled'}`）
 * 都是**部分模型才认**的：前者在老模型上 400，后者在 Claude Fable 5 / Mythos 5
 * 上直接被拒，Opus 5 在 xhigh/max 档也拒。而「不带字段」在所有模型上都合法，
 * 且恰好是这个功能出现之前的行为——所以它才是缺省档：升级不改任何人的请求。
 *
 * **代价**：缺省就开思考的模型（智谱 GLM、DeepSeek、Ollama 上的推理模型）在
 * 「不思考」这一档仍然会思考——那一档的准确含义是「跟随服务商默认」，
 * `THINKING_HINT.off` 那句话就是这么写的。真要关掉得靠各家的显式开关，而它们
 * 一样是部分模型才认（GLM 的 `disabled` 有报告说被忽略，Ollama 的
 * `reasoning_effort: false` 因为字段类型是 string 直接报错），所以不发。
 */

export type ThinkingDepth = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_DEPTHS: ThinkingDepth[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * 缺省不思考。
 *
 * 第 4 条（不偷偷烧 token）：思考的 token 按输出计费，一句「帮我看看这段」
 * 可能因此贵好几倍。作者主动选了才开。
 */
export const DEFAULT_THINKING_DEPTH: ThinkingDepth = 'off';

/** 下拉框与日志共用这一份说法，前端不另写。 */
export const THINKING_LABEL: Record<ThinkingDepth, string> = {
  off: '不思考',
  low: '浅思考',
  medium: '中思考',
  high: '深思考',
  max: '极限思考',
};

export const THINKING_HINT: Record<ThinkingDepth, string> = {
  off: '不带思考参数，跟随服务商默认',
  low: '想一下就答，最省钱',
  medium: '折中，日常讨论够用',
  high: '想透了再答，慢且贵',
  max: '想到底（OpenAI 走 xhigh，Claude 走 max）',
};

export function isThinkingDepth(value: unknown): value is ThinkingDepth {
  return typeof value === 'string' && (THINKING_DEPTHS as string[]).includes(value);
}

/** 容错读取：认不出一律回落「不思考」，绝不抛。 */
export function normalizeThinkingDepth(value: unknown): ThinkingDepth {
  return isThinkingDepth(value) ? value : DEFAULT_THINKING_DEPTH;
}

/** OpenAI Responses 的 `reasoning.effort`。`undefined` = 不带 `reasoning` 字段。 */
export function responsesEffort(depth: ThinkingDepth): string | undefined {
  switch (depth) {
    case 'off':
      return undefined;
    case 'max':
      return 'xhigh';
    default:
      return depth;
  }
}

/** Anthropic 的 `output_config.effort`。`undefined` = 不带思考字段。 */
export function anthropicEffort(depth: ThinkingDepth): string | undefined {
  return depth === 'off' ? undefined : depth;
}

/**
 * 通用 `/chat/completions` 上「想多深」的四种写法。
 *
 * 这条协议没有标准。同一件事各家起了四个名字，而作者的设置页里只有一个接口
 * 地址——指望他知道自己那个网关转发给谁、认哪一套是不合理的。所以缺省
 * `auto`：按下面的顺序逐个试，被 400 就换下一种，结论按「接口地址 + 模型」
 * 记在内存里，每个模型一生只吃一次 400。
 *
 * | 风格 | 落成的字段 | 认它的服务商 |
 * |---|---|---|
 * | `effort` | `reasoning_effort` | OpenAI / Kimi / Ollama / DeepSeek |
 * | `thinking` | `thinking: {type:'enabled'}` + `reasoning_effort` | 智谱 GLM / DeepSeek |
 * | `enable` | `enable_thinking` + `thinking_budget` | 通义 Qwen / vLLM 自建 |
 * | `reasoning` | `reasoning: {effort}` | OpenRouter |
 * | `none` | 什么都不带 | 作者明确不要，或试完都不认 |
 *
 * **留一个手动档的理由**：自动协商靠 400 的错误文本认字段，而中转网关的报错
 * 措辞什么样都有可能。猜错时作者需要一个能把结论钉死的地方，否则每次进程
 * 重启都要重新猜一遍。
 */
export type ChatThinkingStyle = 'auto' | 'effort' | 'thinking' | 'enable' | 'reasoning' | 'none';

export const CHAT_THINKING_STYLES: ChatThinkingStyle[] = [
  'auto',
  'effort',
  'thinking',
  'enable',
  'reasoning',
  'none',
];

export const DEFAULT_CHAT_THINKING_STYLE: ChatThinkingStyle = 'auto';

/** 设置页的下拉框用这一份说法，前端不另写。 */
export const CHAT_THINKING_STYLE_LABEL: Record<ChatThinkingStyle, string> = {
  auto: '自动协商',
  effort: 'reasoning_effort（OpenAI / Kimi / Ollama）',
  thinking: 'thinking 对象（智谱 / DeepSeek）',
  enable: 'enable_thinking（通义 / vLLM）',
  reasoning: 'reasoning 对象（OpenRouter）',
  none: '不发思考字段',
};

/** `auto` 档逐个试的顺序：从最通用的排到最窄的。 */
export const CHAT_STYLE_LADDER: Exclude<ChatThinkingStyle, 'auto'>[] = [
  'effort',
  'thinking',
  'enable',
  'reasoning',
  'none',
];

/** 容错读取：认不出一律回落 `auto`，绝不抛。 */
export function normalizeChatThinkingStyle(value: unknown): ChatThinkingStyle {
  return typeof value === 'string' && (CHAT_THINKING_STYLES as string[]).includes(value)
    ? (value as ChatThinkingStyle)
    : DEFAULT_CHAT_THINKING_STYLE;
}

/**
 * 通用 `/chat/completions` 的 effort 值。`undefined` = 不带思考字段。
 *
 * 极限档发 `max`（而不是 Responses 那边的 `xhigh`）：DeepSeek 与 Kimi 都收
 * `low/high/max`，`xhigh` 在它们那儿是兼容值或干脆不认。被拒了靠
 * `downgradeDepth` 降一档兜。
 */
export function chatEffort(depth: ThinkingDepth): string | undefined {
  return depth === 'off' ? undefined : depth;
}

/**
 * 老模型（Claude 4.5 及更早）那条路的 `thinking.budget_tokens`。
 *
 * 两条硬约束来自 API：**最少 1024**，且**必须小于 `max_tokens`**（思考
 * token 算在输出上限里）。所以预算按输出上限收紧，收到 1024 以下就等于
 * 这个模型的输出上限根本装不下思考——返回 `undefined`，调用方退回不思考，
 * 而不是发一个必然 400 的请求。
 */
export function thinkingBudget(depth: ThinkingDepth, maxOutputTokens: number): number | undefined {
  const wanted = BUDGET[depth];
  if (!wanted) {
    return undefined;
  }
  // 留 1024 给正文：预算等于上限的话，模型想完就没有额度说话了。
  const room = Math.floor(maxOutputTokens) - 1024;
  const budget = Math.min(wanted, room);
  return budget >= 1024 ? budget : undefined;
}

/** 各档想要的思考预算。与 Claude Code 的三档（think / think hard / ultrathink）同源。 */
const BUDGET: Record<ThinkingDepth, number> = {
  off: 0,
  low: 4096,
  medium: 10240,
  high: 24576,
  max: 31999,
};

/**
 * 思考开着时，这个输出上限够不够。
 *
 * 思考的 token **算在输出上限里**（两家都是），所以 4096 的上限配上深思考，
 * 模型可能想完就没有额度说话了，作者看到的是一段被截断的回答或者干脆空白，
 * 而界面上没有任何东西指向「输出上限太小」这个原因。
 *
 * 这里只判断、不悄悄改：把作者配的上限乘个系数等于替他决定花多少钱。
 * 调用方据此 warn 一次（每个模型一次），话说清楚就够了。
 */
export function outputRoomTooSmall(depth: ThinkingDepth, maxOutputTokens: number): boolean {
  return depth !== 'off' && maxOutputTokens < 8192;
}

/**
 * 降一档。服务商拒了某个 effort 值（新梯子上的档位老模型不认）时退一步再试，
 * 而不是把这一轮直接判死。`off` 已经在最底下，返回它自己表示没得再降。
 */
export function downgradeDepth(depth: ThinkingDepth): ThinkingDepth {
  const i = THINKING_DEPTHS.indexOf(depth);
  return i <= 0 ? 'off' : THINKING_DEPTHS[i - 1];
}
