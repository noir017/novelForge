/**
 * 事件流的收集器。
 *
 * provider 吐的是 `StreamEvent`，而 13 个既有调用点要的只是一段文本。
 * 这里把「传一个流，拿一段文本」那个形状保住，同时让想听 reasoning /
 * usage / toolCall 的调用方各取所需——它们从前挂在 provider 的 options 上，
 * 那是「调用方想不想听决定 provider 发不发」，方向反了。
 */
import { ReasoningTrace, StreamEvent, TokenUsage, ToolCall } from './provider';

export interface CollectHandlers {
  onDelta?(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onUsage?(usage: TokenUsage): void;
  onToolCall?(call: ToolCall): void;
}

export interface CollectResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /**
   * 这一轮的思考凭据，按到达顺序。**多轮工具调用要把它原样交回去**
   * （见 provider.ts 的 `ReasoningTrace`）；单次生成用不着，忽略即可。
   */
  traces: ReasoningTrace[];
}

/**
 * 把一次请求回报的多份用量合成一份。
 *
 * 同一次请求会回调多次（Anthropic 在 `message_start` 给输入、
 * `message_delta` 给输出），所以**按字段合并、后到的覆盖同名字段、
 * 缺席的字段保留**——整份覆盖会让先到的输入用量被后一条抹掉。
 */
export function mergeUsage(target: TokenUsage, patch: TokenUsage): void {
  if (patch.inputTokens !== undefined) {
    target.inputTokens = patch.inputTokens;
  }
  if (patch.outputTokens !== undefined) {
    target.outputTokens = patch.outputTokens;
  }
}

/** 收全流，按字段合并 usage。 */
export async function collect(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<CollectResult> {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const usage: TokenUsage = {};
  const traces: ReasoningTrace[] = [];

  for await (const ev of stream) {
    switch (ev.type) {
      case 'text':
        text += ev.text;
        handlers?.onDelta?.(ev.text, text);
        break;
      case 'reasoning':
        reasoning += ev.text;
        handlers?.onReasoning?.(ev.text, reasoning);
        break;
      case 'toolCall':
        toolCalls.push(ev.call);
        handlers?.onToolCall?.(ev.call);
        break;
      case 'usage':
        mergeUsage(usage, ev.usage);
        handlers?.onUsage?.(ev.usage);
        break;
      case 'reasoningTrace':
        traces.push(ev.trace);
        break;
    }
  }

  return { text, reasoning, toolCalls, usage, traces };
}

/** 只要文本那一份。既有的 13 个调用点用这个。 */
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<string> {
  return (await collect(stream, handlers)).text;
}
