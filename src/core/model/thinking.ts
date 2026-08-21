/**
 * 思考深度：**这一轮让模型想多久。**
 *
 * 与 `tiers.ts` / `agentPolicy.ts` 同一个位置的东西——类型、可选值、界面上的
 * 说法在数据层定义一次（纯数据 + 纯函数、零 import，所以前端可以直接打包
 * 这一份），映射成各家的请求字段则在两个 provider 里各写一次。
 *
 * ## 一个档位，两套字段
 *
 * 两家都从「给个 token 预算」走到了「给个档位」，但字段名与梯子不一样：
 *
 * | 档 | OpenAI Responses | Anthropic Messages |
 * |---|---|---|
 * | 关 | 不带 `reasoning` | 不带 `thinking` / `output_config` |
 * | 低 / 中 / 高 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` |
 * | 极限 | `reasoning.effort: xhigh` | `output_config.effort: max` |
 *
 * 最高那一档两家的叫法不同（一个 `xhigh`、一个 `max`），所以映射表分两张，
 * 界面上仍然只有一个「极限」——作者选的是「想到底」，不是某家的枚举值。
 *
 * ## 为什么「关」是不带字段而不是显式关掉
 *
 * 显式关（OpenAI 的 `effort: 'none'`、Anthropic 的 `thinking: {type:'disabled'}`）
 * 都是**部分模型才认**的：前者在老模型上 400，后者在 Claude Fable 5 / Mythos 5
 * 上直接被拒，Opus 5 在 xhigh/max 档也拒。而「不带字段」在所有模型上都合法，
 * 且恰好是这个功能出现之前的行为——所以它才是缺省档：升级不改任何人的请求。
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
