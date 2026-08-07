/**
 * Token 预算工具：计数 + 按预算截取文本。
 *
 * 计数本身已经拆到 [tokenCounter.ts](tokenCounter.ts)（可替换实现 + 注册表）。
 * 本文件只留两样东西：
 * - `estimateTokens` —— `countTokens` 的别名，全仓库几十处调用沿用这个名字；
 * - `takeHead` / `takeTail` —— 按预算截断，永远走**当前**计数器。
 *
 * 截断函数刻意不接受计数器参数：预算判断与截断必须用同一套口径，
 * 否则「估算说放得下、截断按另一套系数切」会切出超预算的文本。
 */

import { charsForTokens, countTokens } from './tokenCounter';

export {
  activeTokenCounter,
  charsForTokens,
  countTokens,
  describeUsage,
  HeuristicTokenCounter,
  listTokenCounters,
  recordUsage,
  registerTokenCounter,
  resetTokenCounter,
  resetUsageStats,
  useTokenCounter,
  usageStats,
} from './tokenCounter';
export type { TokenCounter, TokenUsage, UsageStats } from './tokenCounter';

/**
 * 数一段文本的 token 数。
 *
 * 名字里的「estimate」是历史包袱：换上精确计数器后它返回的就是精确值。
 * 保留这个名字是因为调用点太多，且语义（「这段文本值多少预算」）没变。
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/** 目标 token 数对应的大致字符数（按当前计数器反推），用于截断文本。 */
export function tokensToChars(tokens: number): number {
  return charsForTokens(tokens);
}

/** 从尾部截取不超过 maxTokens 的文本，并尽量从段落边界开始。 */
export function takeTail(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  const chars = charsForTokens(maxTokens);
  let slice = text.slice(-chars);
  // 对齐到段落开头，避免从半句话开始。
  const paragraphBreak = slice.indexOf('\n\n');
  if (paragraphBreak !== -1 && paragraphBreak < slice.length * 0.3) {
    slice = slice.slice(paragraphBreak + 2);
  }
  return slice.trimStart();
}

/** 从头部截取不超过 maxTokens 的文本，尾部加省略标记。 */
export function takeHead(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  const chars = charsForTokens(maxTokens);
  return `${text.slice(0, chars).trimEnd()}\n……（此处因上下文预算截断）`;
}
