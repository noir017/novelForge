/**
 * 事件流的收集器。
 *
 * provider 吐的是 `StreamEvent`，而 13 个既有调用点要的只是一段文本。
 * 这里把「传一个流，拿一段文本」那个形状保住，同时让想听 reasoning /
 * usage 的调用方各取所需——provider 总是全量发事件，听不听由调用方决定，
 * 而不是让「调用方想不想听」反过来决定 provider 发不发。
 */
import { StopSignal, StreamEvent, TokenUsage } from './provider';

export interface CollectHandlers {
  onDelta?(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onUsage?(usage: TokenUsage): void;
}

export interface CollectResult {
  text: string;
  reasoning: string;
  usage: TokenUsage;
  /** 上游报的收尾原因。`undefined` = 它没说（有些兼容实现压根不发这一条）。 */
  stopReason?: StopSignal;
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
  const usage: TokenUsage = {};
  let stopReason: StopSignal | undefined;

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
      case 'usage':
        mergeUsage(usage, ev.usage);
        handlers?.onUsage?.(ev.usage);
        break;
      case 'stop':
        stopReason = ev.reason;
        break;
    }
  }

  return { text, reasoning, usage, stopReason };
}

/** 只要文本那一份。既有的 13 个调用点用这个。 */
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<string> {
  return (await collect(stream, handlers)).text;
}
