/**
 * Draft store：还没落盘的产物存哪里。
 *
 * ## 为什么要有它
 *
 * `generate` 产出的 `Draft` 一个字都没写盘。它至少要活到作者在那张落盘卡片
 * 上点头的那一刻（`controller/gate.ts`），而 agent 手里的 draftId 还可能被
 * 它稍后用 `write draftId=…` 拿去写。所以：内存为主（`Map`），**随会话 JSON
 * 一起落盘**（`.novelforge/sessions/<id>.json`）——翻回一个旧会话接着让 agent
 * 干活时，那几份草稿还得在。
 *
 * ## 不进 SQLite
 *
 * 第 17 条：库只放可丢弃的痕迹，内容的唯一真相是 Markdown。draft 是未落盘的
 * 内容，但它跟着会话走，而会话本来就是 JSON。
 *
 * ## 容错读取不在这里
 *
 * 会话文件的容错归一化全在 `model/session.ts` 的 `normalize()`——`drafts`
 * 只是它的又一个字段，没道理单开一套。认不出的草稿在那里就被丢掉了，
 * 装进本store 的一律是已经归一过的。
 */
import type { SessionDraft } from '../model/session';
import type { Draft } from './generate';

export type { Draft };

/**
 * 一个会话最多留几份草稿。
 *
 * `draft.raw` 与 `ChatTurn.content` 是同一段文字，全留着等于把会话文件
 * 写两遍——一场几十轮的正文对话就是几十万字。留最近的若干份足够：
 * 更早那些轮次写不写盘，早就当场问过了。
 */
export const MAX_DRAFTS_PER_SESSION = 20;

/**
 * 内存里的草稿表。**一个 controller 一份**（会话之间不共享）。
 *
 * 按会话分桶而不是一张大表：会话关掉时要能整桶扔掉，而按 draftId 逐个删
 * 需要先知道有哪些——那份名单只有会话自己有。
 */
export class DraftStore {
  private readonly bySessionId = new Map<string, Draft[]>();
  private readonly byId = new Map<string, Draft>();

  /** 记一份新草稿。超出上限时丢最老的。 */
  put(draft: Draft, sessionId: string): void {
    const list = this.bySessionId.get(sessionId) ?? [];
    // 同 id 覆盖：重来一轮时草稿也该跟着换掉那一份。
    const existing = list.findIndex((d) => d.id === draft.id);
    if (existing !== -1) {
      list.splice(existing, 1);
    }
    list.push(draft);
    while (list.length > MAX_DRAFTS_PER_SESSION) {
      const dropped = list.shift();
      if (dropped) {
        this.byId.delete(dropped.id);
      }
    }
    this.bySessionId.set(sessionId, list);
    this.byId.set(draft.id, draft);
  }

  get(id: string): Draft | undefined {
    return this.byId.get(id);
  }

  /** 某个会话的全部草稿，按产生顺序。落盘时写的就是这一份。 */
  bySession(sessionId: string): Draft[] {
    return [...(this.bySessionId.get(sessionId) ?? [])];
  }

  /** 会话切换/关闭时清掉该会话的草稿。 */
  dropBySession(sessionId: string): void {
    for (const draft of this.bySessionId.get(sessionId) ?? []) {
      this.byId.delete(draft.id);
    }
    this.bySessionId.delete(sessionId);
  }

  /**
   * 打开会话时把落盘的那批装回内存。整桶替换，不合并——
   * 同一个会话被重新打开时，磁盘上那份就是全部真相。
   *
   * 收的是 `SessionDraft`（`artifact` 是不透明的）：数据层不认识 `Artifact`，
   * 而这份快照只用于画卡片，采纳时会拿气泡里当下的文本重新解析。
   */
  load(sessionId: string, list: SessionDraft[] | undefined): void {
    this.dropBySession(sessionId);
    for (const draft of list ?? []) {
      this.put(draft as Draft, sessionId);
    }
  }
}
