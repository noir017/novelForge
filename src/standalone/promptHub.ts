import { OutMessage } from '../core/protocol';

type PromptRequest = Extract<OutMessage, { type: 'prompt' }>;

/**
 * 管理未决的网页弹窗：ask() 经广播函数发一条 prompt 消息，
 * 等前端回 promptResult 后 resolve。页面全部断开时统一按取消处理。
 */
export class PromptHub {
  private seq = 0;
  private pending = new Map<string, (value: string | undefined) => void>();

  constructor(private readonly broadcast: (msg: OutMessage) => void) {}

  ask(req: Omit<PromptRequest, 'type' | 'requestId'>): Promise<string | undefined> {
    const requestId = `p${++this.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.broadcast({ type: 'prompt', requestId, ...req });
    });
  }

  resolve(requestId: string, value: string | undefined): void {
    const done = this.pending.get(requestId);
    if (!done) {
      return;
    }
    this.pending.delete(requestId);
    done(value);
  }

  /** WS 全部断开时，未决弹窗一律按取消处理。 */
  cancelAll(): void {
    for (const done of this.pending.values()) {
      done(undefined);
    }
    this.pending.clear();
  }
}
