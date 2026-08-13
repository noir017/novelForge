import type { ChatController } from './index';
import { nowIso } from '../model/session';

/** 落盘当前会话，并在需要时刷新历史列表。 */
export async function persist(c: ChatController): Promise<void> {
  // 空会话不落盘——历史列表里不该出现一堆没说过话的占位。
  if (c.current.turns.length === 0) {
    return;
  }
  c.current.updatedAt = nowIso();
  await c.store.write(c.current);
  if (c.tab === 'history') {
    await c.pushSessions();
  }
}
