/**
 * 策略与确认闸门：**哪些动作自动、哪些要问、问的时候说什么。**
 *
 * ## 这一层不是保护，是礼貌
 *
 * 真正的保护在下面两层，而且**与策略无关**：
 *
 * - `workspace/guard.ts` 的八条守卫（越界、回收站、保护目录、大小、同名、
 *   乐观锁）——任何模式下都在；
 * - **覆盖已有内容一律审阅**（`reviewOverwrite`，插件开 diff、独立版弹确认框）
 *   与**批量动作自带的确认框**（写明「预计调用 N 次」）——任何模式下都弹。
 *
 * 这里管的只是「动手之前要不要先问一句」。所以最放手的模式也**不会**让
 * agent 静默覆盖作者写过的东西：那是产品承诺（第 3 / 19 条），不是偏好设置。
 *
 * ## 一张表，不认识任何一个工具
 *
 * 从前这里是 `switch (tool.name)`：generate 怎么问、write 怎么问、edit 怎么问，
 * 连「第 12 章的细纲」这个名字都是在这儿拼的。于是**加一个工具就要回来改一次**，
 * 而忘了改不会红——只会在某一天静默地少问一句。
 *
 * 现在工具自报 {@link ToolIntent}（性质 + 说辞），这里只剩一张五行的表：
 *
 * | gate | 谨慎 | 默认 | 放手 | 谁是这一档 |
 * |---|---|---|---|---|
 * | `auto` | 自动 | 自动 | 自动 | list / read / search |
 * | `costly` | **确认** | 自动 | 自动 | generate |
 * | `mutating` | 确认 | 确认 | 自动 | write 新建/追加、run |
 * | `reviewed` | 自动 | 自动 | 自动 | write 覆盖（下游带 diff 请人过目） |
 * | `always` | 确认 | 确认 | **确认** | edit（下游不过目，这一句就是它的 diff） |
 *
 * 后两行**三种模式完全一样，且不可配置**（第 25(a) 条）：
 *
 * - **`reviewed`**——在覆盖审阅之前再弹一个「确定吗」是纯噪声：diff 本身就同时
 *   回答了「要不要动」与「改了什么」，而后者是前者的依据。
 * - **`always`**——`ws.edit` 走的是「拿这份内容和自己 diff」那条路，覆盖审阅在
 *   这里落成确认框。放手模式也不放开，否则「覆盖已有内容一律过一遍人」就有了
 *   一个例外。
 *
 * 哪个工具归哪一档由**工具自己**声明——只有它知道自己随后会不会走审阅。
 *
 * ## 两颗按钮：确认 / 跳过
 *
 * 「跳过」只否掉这一步，agent 接着跑别的。**叫停整轮不放在这张卡上**——那是
 * 输入框旁边那颗「停止」，一个与「要不要动这个文件」无关的动作；混在闸门里
 * 的第三颗按钮只会让作者以为自己在跟 agent 说话，还常被误当成「跳过」。
 *
 * 关掉对话框（Esc / 点外面）仍按**停止**处理：他被问「要不要动你的磁盘」而
 * 没有回答，那就不该替他答「继续」。停止不丢任何东西——已经写下的还在，模型
 * 还会得到最后一轮说明做到哪了。
 */
import type { AgentPolicy } from '../model/agentPolicy';
import type { GateKind, ToolIntent } from '../tools/types';

// 类型、可选值与界面说法在数据层定义一次（`config.ts` 与 `protocol/` 要用，
// 它们不该依赖 agent 层）；这里只做判定。
export {
  AGENT_POLICIES,
  AGENT_POLICY_HINT,
  AGENT_POLICY_LABEL,
  DEFAULT_AGENT_POLICY,
  isAgentPolicy,
} from '../model/agentPolicy';
export type { AgentPolicy };

/**
 * 一次询问的结论。作者只点得到前两个：**停止**是没人回答（取消 / Esc）时替
 * 他记下的那一笔，不是卡片上的一颗按钮。
 */
export type GateVerdict = 'proceed' | 'skip' | 'stop';

export interface Gate {
  /** 要不要在执行前问一句。 */
  confirm: boolean;
  /**
   * 问什么。**说清会发生什么，不是「确定吗」**——「Agent 想调用 write，允许吗」
   * 这种问法，作者答不上来，因为他不知道 write 会写到哪。
   */
  message?: string;
  detail?: string;
  /** 同意那颗按钮上的字。一律是 {@link PROCEED_ACTION}。 */
  proceed?: string;
}

const NO_GATE: Gate = { confirm: false };

/**
 * 两颗按钮上的字。三处（构造、判定、文案）共用一份。
 *
 * **同意那颗不写动词**：「Agent 要写入「第 12 章」」这句话就在按钮上方，
 * 按钮再说一遍「写入」是重复；而每个工具各报一个动词（写入 / 替换 / 执行 /
 * 生成）的话，同一颗按钮每次换一个字，作者反而要先读按钮才敢点。
 */
export const PROCEED_ACTION = '确认';
export const SKIP_ACTION = '跳过';

/**
 * 判定表。**这是这个文件的全部判断**，其余都是拼字符串。
 */
const CONFIRM_AT: Record<GateKind, ReadonlySet<AgentPolicy>> = {
  auto: new Set(),
  costly: new Set<AgentPolicy>(['careful']),
  mutating: new Set<AgentPolicy>(['careful', 'default']),
  reviewed: new Set(),
  always: new Set<AgentPolicy>(['careful', 'default', 'bold']),
};

/**
 * 这一步要不要先问一句。
 *
 * **零 I/O**：只看策略与工具自报的意图。意图本身也是纯函数算出来的，所以确认框
 * 上的名字与随后 diff 上的名字**逐字一致**——作者不该在两个框里看到同一份东西的
 * 两个名字。
 *
 * `intent` 缺席（工具名认不出来）时按 `mutating` 判：宁可多问，也不要有一条
 * 没人想过的路。真正认不出的名字压根走不到这里——注册表会直接回一句
 * 「没有叫 X 的工具」。
 */
export function gateFor(policy: AgentPolicy, intent?: ToolIntent): Gate {
  const kind: GateKind = intent?.gate ?? 'mutating';
  if (!CONFIRM_AT[kind]?.has(policy)) {
    return NO_GATE;
  }
  return {
    confirm: true,
    // 主语在这里加：工具不知道是谁在调它（agent？将来某个远端？），
    // 而作者要知道现在是谁要动他的磁盘。
    message: `Agent 要${intent?.title ?? '执行一个动作'}`,
    detail: intent?.detail,
    proceed: PROCEED_ACTION,
  };
}

/**
 * 作者拒绝之后回给模型的那句话。
 *
 * **必须有信息量**：只回一句「被拒绝」，它多半会把同一个动作再发一遍——
 * 每一次都是一整轮上下文的钱（第 4 条）。
 */
export function declinedText(verdict: 'skip' | 'stop', gate: Gate): string {
  const what = gate.message ?? '这一步';
  return verdict === 'skip'
    ? `作者跳过了这一步（${what}），它没有执行，磁盘上什么都没变。` +
        '**不要重试同一个动作**——换个做法，或者问问他想怎么做。'
    : `作者选择停止（${what}）。不要再发起新的动作，把已经做到哪、还差什么说清楚就行。`;
}
