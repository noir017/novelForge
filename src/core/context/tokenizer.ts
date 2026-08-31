/**
 * Token 预算工具：计数 + 按预算截取文本 + 数一次请求的输入。
 *
 * 计数本身已经拆到 [tokenCounter.ts](tokenCounter.ts)（可替换实现 + 注册表）。
 * 本文件只留三样东西：
 * - `estimateTokens` —— `countTokens` 的别名，全仓库几十处调用沿用这个名字；
 * - `takeHead` / `takeTail` —— 按预算截断，永远走**当前**计数器；
 * - `estimateMessagesTokens` / `estimateToolsTokens` —— 一次请求真正要花的输入。
 *
 * 截断函数刻意不接受计数器参数：预算判断与截断必须用同一套口径，
 * 否则「估算说放得下、截断按另一套系数切」会切出超预算的文本。
 */

import type { AgentMessage, ToolSpec } from '../llm/provider';
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
  TOKEN_PROFILES,
  useTokenCounter,
  usageStats,
} from './tokenCounter';
export type { TokenCounter, TokenUsage, TokenWeights, UsageStats } from './tokenCounter';

/**
 * 数一段文本的 token 数。
 *
 * 名字里的「estimate」是历史包袱：换上精确计数器后它返回的就是精确值。
 * 保留这个名字是因为调用点太多，且语义（「这段文本值多少预算」）没变。
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/** 目标 token 数对应的大致字符数（按当前计数器反推）。截断只拿它当搜索初值。 */
export function tokensToChars(tokens: number): number {
  return charsForTokens(tokens);
}

// ---------------------------------------------------------------- 按预算截断

/**
 * 放得下的最大字符数。**结果由 `count()` 本身担保，而不是靠系数反推**。
 *
 * 从前这里是一句 `text.slice(-charsForTokens(max))`：反推按最贵的中文系数算，
 * 于是一段英文只能拿到它实际能放的四分之一——预算明明够，内容却被切掉大半。
 * 现在拿反推值当初值，再二分收敛到真正的边界：对任何计数器（包括将来接上的
 * 精确实现）都恰好卡在预算上，且**永远不会超**。
 *
 * `slice(n)` 由调用方给：取头就是 `text.slice(0, n)`，取尾就是 `text.slice(-n)`。
 */
function fitToTokens(text: string, maxTokens: number, slice: (chars: number) => string): string {
  if (maxTokens <= 0 || !text) {
    return '';
  }
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  let lo = 0; // 一定放得下
  let hi = text.length; // 一定放不下（上面刚判过）
  let probe = clamp(charsForTokens(maxTokens), 1, hi - 1);
  while (hi - lo > 1) {
    const n = avoidSplitPair(probe, slice);
    if (n <= lo) {
      // 边界正好落在代理对中间，退回已知放得下的那个长度收工。
      break;
    }
    if (countTokens(slice(n)) <= maxTokens) {
      lo = n;
    } else {
      hi = n;
    }
    probe = Math.floor((lo + hi) / 2);
  }
  // `slice` 取尾那一支是 `text.slice(-n)`，而 `-0` 会把整段原样还回来——
  // 一个字都放不下时必须自己短路，否则这里正是超预算的来源。
  return lo > 0 ? slice(lo) : '';
}

/** 别把一个代理对从中间切开——切出来的孤代理是乱码，还会多算一个 token。 */
function avoidSplitPair(n: number, slice: (chars: number) => string): number {
  const s = slice(n);
  if (!s) {
    return n;
  }
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  const brokenHead = first >= 0xdc00 && first <= 0xdfff; // 低代理开头：前半个字被切走了
  const brokenTail = last >= 0xd800 && last <= 0xdbff; // 高代理结尾：后半个字被切走了
  return brokenHead || brokenTail ? Math.max(1, n - 1) : n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 从尾部截取不超过 maxTokens 的文本，并尽量从段落边界开始。 */
export function takeTail(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  let slice = fitToTokens(text, maxTokens, (n) => text.slice(-n));
  // 对齐到段落开头，避免从半句话开始。只会更短，不会撑破预算。
  const paragraphBreak = slice.indexOf('\n\n');
  if (paragraphBreak !== -1 && paragraphBreak < slice.length * 0.3) {
    slice = slice.slice(paragraphBreak + 2);
  }
  return slice.trimStart();
}

/** 截断标记本身也要花 token，所以它占的份额得从预算里先扣掉。 */
const CLIP_MARK = '\n……（此处因上下文预算截断）';

/**
 * 从头部截取不超过 maxTokens 的文本，尾部加省略标记。
 *
 * **标记算在预算之内**。从前是先按 maxTokens 切满、再把标记接上去，结果必然
 * 超出十几个 token——调用方只好自己减一个魔数（`dialog.ts` 里那句 `cap - 40`）
 * 来兜。预算小到连标记都放不下时返回空串：那点预算本来也装不下有用的内容，
 * 而「装不下」这件事由调用方记在 `note` 里，不靠这行标记来体现。
 */
export function takeHead(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  const markTokens = countTokens(CLIP_MARK);
  const body = fitToTokens(text, maxTokens - markTokens, (n) => text.slice(0, n)).trimEnd();
  return body ? `${body}${CLIP_MARK}` : '';
}

// ---------------------------------------------------------------- 一次请求的输入

/**
 * 每条消息的协议开销：role、分隔符、结束标记。各家都在 3～5 之间，取 4。
 *
 * 单看一条不值一提，一轮 agent 循环里几十条消息就是一两百 token；
 * 更要紧的是它让「我们算出来的输入」与服务商回报的实测能对得上。
 */
const MESSAGE_OVERHEAD = 4;
/** 一次工具调用的固定开销：id、类型标记、函数名外面那层包装。 */
const TOOL_CALL_OVERHEAD = 8;

/**
 * 一组消息作为**请求输入**值多少 token。
 *
 * 与逐条 `estimateTokens(m.content)` 相加的区别，正是从前那笔算漏的账：
 * - **工具调用的参数**（`toolCalls[].raw`）。assistant 那条消息的 `content`
 *   往往是空的，真正的负载全在参数里——`write` 一整章正文就是从这里过去的，
 *   按 content 数等于把几千 token 数成 0。
 * - **思考凭据**（`traces`）。它下一轮要原样交回给服务商，占的是同一个窗口。
 * - 每条消息的协议开销。
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD + countTokens(m.content ?? '');
    if (m.role === 'assistant') {
      for (const call of m.toolCalls ?? []) {
        total += TOOL_CALL_OVERHEAD + countTokens(call.name) + countTokens(call.raw || stringify(call.args));
      }
      for (const trace of m.traces ?? []) {
        total += countTokens(stringify(trace.payload));
      }
    } else if (m.role === 'tool') {
      total += TOOL_CALL_OVERHEAD + countTokens(m.name);
    }
  }
  return total;
}

/**
 * 工具声明值多少 token。**它每一回合都随请求发出去**，八个工具的 schema
 * 是实打实的一两千 token，从预算里漏掉它，agent 越到后面越容易撞窗口。
 */
export function estimateToolsTokens(tools: ToolSpec[] | undefined): number {
  if (!tools || tools.length === 0) {
    return 0;
  }
  let total = 0;
  for (const t of tools) {
    total += TOOL_CALL_OVERHEAD + countTokens(t.name) + countTokens(t.description) + countTokens(stringify(t.parameters));
  }
  return total;
}

/** 循环引用之类的怪东西不该把计数带崩——数不出来就当它不占地方。 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
