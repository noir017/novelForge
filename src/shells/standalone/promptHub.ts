import { InMessage, OutMessage } from '../../core/protocol';

type PromptRequest = Extract<OutMessage, { type: 'prompt' }>;
/** 前端的回答：`value`，确认框带下拉框时另有 `choice`。 */
export type PromptReply = Pick<Extract<InMessage, { type: 'promptResult' }>, 'value' | 'choice'>;

/**
 * 管理未决的网页弹窗：ask() 经广播函数发一条 prompt 消息，
 * 等前端回 promptResult 后 resolve。页面全部断开时统一按取消处理。
 */
export class PromptHub {
  private seq = 0;
  private pending = new Map<string, (reply: PromptReply) => void>();

  constructor(private readonly broadcast: (msg: OutMessage) => void) {}

  ask(req: Omit<PromptRequest, 'type' | 'requestId'>): Promise<PromptReply> {
    const requestId = `p${++this.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.broadcast({ type: 'prompt', requestId, ...req });
    });
  }

  resolve(requestId: string, reply: PromptReply): void {
    const done = this.pending.get(requestId);
    if (!done) {
      return;
    }
    this.pending.delete(requestId);
    done(reply);
  }

  /** WS 全部断开时，未决弹窗一律按取消处理。 */
  cancelAll(): void {
    for (const done of this.pending.values()) {
      done({});
    }
    this.pending.clear();
  }
}
