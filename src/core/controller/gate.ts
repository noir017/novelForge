/**
 * 权限询问：**agent 动手之前那一句问在对话页里，不是一个盖住窗口的模态框。**
 *
 * ## 为什么不是模态框
 *
 * 作者要判断的恰恰是「这一步动的是哪个文件、写的是什么」，而那串上下文——
 * 前几条工具调用、模型刚说的那段话——就在被模态框盖住的气泡里。一个居中的
 * 「Agent 要写入…，允许吗」把他从要看的东西上拽走，还顺手锁住整个窗口：想
 * 先翻一眼那个文件再决定都做不到。所以这一句改成挂在气泡里的一张卡片，和
 * 随后的工具条排在一起，页面照常能滚、能翻、能点别的。
 *
 * ## 这一层只做「问」这件事
 *
 * 判定（哪一档要问、问什么、按钮上写什么）全在 [`agent/policy.ts`](../agent/README.md)，
 * 循环只管拿三个结论中的一个。这里把那一问变成一条协议消息，等前端回话：
 *
 * ```
 * loop.askGate ──onGate──▶ askGate ──gate──▶ 气泡里的卡片
 *                             ▲                    │
 *                             └─── gateResult ◀────┘
 * ```
 *
 * **两种问法共用这一条路**：
 *
 * | 谁在问 | 什么时候 | 按钮 |
 * |---|---|---|
 * | agent 的闸门（`policy.ts`） | 动手前，按策略查表 | 确认 / 跳过 |
 * | 产物落盘（第 19 条） | `generate` 一产出就问，**与策略无关** | 确认 / 不采纳 |
 *
 * 两种都只有两颗：**叫停整轮不在这张卡上**——那是输入框旁边那颗「停止」，
 * 与「这一个文件要不要动」是两件事，混进闸门只会被误当成「跳过」。
 *
 * 后一种从前是气泡末尾那颗「采纳写入」——它可以拖到第二天再点，于是
 * 「产物落盘前必须过一遍人」在界面上是一颗**可以永远不点的按钮**，而 agent
 * 早就接着往下做了。现在它和别的动手请求长一个样、在同一个位置、当场问。
 *
 * ## 三件必须做对的事
 *
 * 1. **两个视图同时收卡**——侧边栏与编辑器标签页挂同一个 controller，只在被
 *    点的那一边收，另一边会留一张点了没反应的卡（`agentGateDone` 广播）。
 * 2. **重连之后卡片还在**——前端无状态，刷新网页/webview 重建后靠
 *    `resendFullState` 把还没答的这几条重推一遍；不重推的话循环就永远停在
 *    一个没人看得见的等待上。
 * 3. **取消要能解开等待**——作者点「停止」时循环正卡在这里等回答，
 *    signal 一断就按「停止」结算，不留一个永远悬着的 Promise。
 */
import type { GateVerdict } from '../agent/policy';
import { PROCEED_ACTION, SKIP_ACTION } from '../agent/policy';
import type { OutMessage } from '../protocol';
import type { ChatController } from './index';

type GateMessage = Extract<OutMessage, { type: 'gate' }>;

/**
 * 一次询问能有的结论。**卡片上只有前两颗按钮**，`cancelled` 是没人回答
 * （这一轮被取消、换了会话）时替作者记下的那一笔——它对循环等于「停止」。
 */
export type GateSettlement = 'proceed' | 'skip' | 'cancelled';

/** 一次还没答的询问。`msg` 留着是为了重连时能原样再推一遍。 */
export interface PendingGate {
  readonly msg: GateMessage;
  /** 结算这一次询问。**只有第一次算数**（作者点了，同时这一轮又被取消）。 */
  settle(verdict: GateSettlement): void;
}

/**
 * 询问 id。与 `makeTurnId` 同一套理由：同一毫秒里连着问两次也不能撞，
 * 而这个 id 是前端那张卡片的身份。
 */
let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `g${Date.now().toString(36)}-${counter.toString(36)}`;
}

export interface GateAsk {
  /** 卡片挂在哪条气泡上。 */
  turnId: string;
  /** 这一问对应的工具调用。产物落盘那一问来自单步创作时没有。 */
  callId?: string;
  name: string;
  /** 已经带着主语的那句话（「Agent 要写入设定「北境」」）。前端照原样画。 */
  title: string;
  detail?: string;
  /** 模型这一次填的参数（已截断的 JSON 文本）。卡片里折叠着，点开才看。 */
  argsText?: string;
  /** 同意那颗按钮上的字。缺省是「确认」。 */
  proceed?: string;
  /** 拒绝那颗按钮上的字。缺省是「跳过」。 */
  skip?: string;
}

/**
 * 在对话页里问一句，等作者点。
 *
 * 关掉页面不算回答——那种情况下这条询问会随重连再推一遍。真正的「没人回答」
 * 只有取消一种，按**停止**处理（他被问「要不要动你的磁盘」而没有回答，不该
 * 替他答「继续」）。
 */
export function askGate(c: ChatController, ask: GateAsk, signal?: AbortSignal): Promise<GateVerdict> {
  const requestId = nextRequestId();
  const msg: GateMessage = {
    type: 'gate',
    requestId,
    turnId: ask.turnId,
    callId: ask.callId,
    name: ask.name,
    title: ask.title,
    detail: ask.detail,
    argsText: ask.argsText,
    // 按钮上的字都从后端来：与循环里判定用的是同一份常量，前端自己写一遍的
    // 话，改了文案就对不上了。
    proceed: ask.proceed ?? PROCEED_ACTION,
    skip: ask.skip ?? SKIP_ACTION,
  };

  return new Promise<GateVerdict>((resolve) => {
    const onAbort = () => c.gates.get(requestId)?.settle('cancelled');
    const settle = (verdict: GateSettlement) => {
      // 先从表里摘掉：这既是「只结算一次」的判据，也让重连不再推它。
      if (!c.gates.delete(requestId)) {
        return;
      }
      signal?.removeEventListener('abort', onAbort);
      c.post({ type: 'gateDone', requestId, verdict });
      resolve(verdict === 'cancelled' ? 'stop' : verdict);
    };

    c.gates.set(requestId, { msg, settle });
    c.post(msg);

    // 没有 signal 的（单步创作那条路：生成已经结束，锁也放了）只能靠作者点，
    // 或者被 `cancelGates` 收掉——换会话、开下一轮时那张卡就作废了。
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      settle('cancelled');
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 作者点了卡片上的某一颗按钮。
 *
 * **认不出的 requestId 静默丢弃**：重连之后前端可能还留着一张早就结束了的
 * 卡片（另一个视图上答过了），为它报错只会让作者莫名其妙。
 */
export function resolveGate(c: ChatController, requestId: string, verdict: 'proceed' | 'skip'): void {
  c.gates.get(requestId)?.settle(verdict);
}

/**
 * 把还没答的全收掉（按「取消」结算）。
 *
 * 单步创作那条路的落盘卡片没有 signal——生成早结束了、锁也放了。作者要是
 * 不理它、直接开了下一轮或换了会话，那张卡就不该再留着：它挂在上一条气泡
 * 上，点下去写的是一份作者早已翻篇的产物。
 */
export function cancelGates(c: ChatController): void {
  for (const gate of [...c.gates.values()]) {
    gate.settle('cancelled');
  }
}

/** 重连/重建时把还没答的那几张卡重新推一遍。前端无状态，全靠这一下。 */
export function resendGates(c: ChatController): void {
  for (const gate of c.gates.values()) {
    c.post(gate.msg);
  }
}
