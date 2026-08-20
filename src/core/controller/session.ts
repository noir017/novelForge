import type { ChatController } from './index';
import { getHost } from '../host';
import { serializeSession } from './serialize';
import { restoreTarget, pushPipeline } from './chat';
import { cancelGates } from './gate';
import { persist } from './persist';

/** 会话落盘与会话列表操作。接收 ChatController，字段只给 controller/ 同包用。 */

export async function newSession(c: ChatController): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，请先停止。', 'error');
    return;
  }
  await persist(c);
  // 换会话 = 上一条气泡走出视野，挂在它上面那张还没答的落盘卡片一并作废。
  cancelGates(c);
  // 走掉的那个会话的草稿留在它自己的 JSON 里，内存这份扔掉——不然开一天
  // 面板会攒下几十份没人再看的正文。
  c.drafts.dropBySession(c.current.id);
  c.current = c.store.create({
    target: c.current.target,
    stage: c.current.stage,
    targetNo: c.current.targetNo,
  });
  c.pending = [];
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  c.post({ type: 'attachments', items: [] });
}

export async function openSession(c: ChatController, id: string): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，请先停止。', 'error');
    return;
  }
  const loaded = await c.store.read(id);
  if (!loaded) {
    c.toast('这个会话读不出来，可能已被删除或损坏。', 'error');
    await c.pushSessions();
    return;
  }
  await persist(c);
  cancelGates(c);
  await restoreTarget(c, loaded);
  c.drafts.dropBySession(c.current.id);
  c.current = loaded;
  // 把落盘的那批草稿装回内存：`write draftId=…` 认的是它们，翻回一个旧会话
  // 接着让 agent 干活时，那几份草稿还得在。
  // （**落盘不再靠它**：写不写在产出的当下就问过了，气泡上没有采纳按钮。）
  c.drafts.load(loaded.id, loaded.drafts);
  c.pending = [];
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  c.post({ type: 'attachments', items: [] });
  await pushPipeline(c);
}

export async function deleteSession(c: ChatController, id: string): Promise<void> {
  const target = await c.store.read(id);
  const pick = await getHost().confirm(
    `删除对话「${target?.title ?? id}」？`,
    ['删除'],
    { modal: true, detail: '会移到 .novelforge/.trash/，可手动找回。' }
  );
  if (pick !== '删除') {
    return;
  }
  await c.store.delete(id);
  if (id === c.current.id) {
    c.current = c.store.create({
      target: c.current.target,
      stage: c.current.stage,
      targetNo: c.current.targetNo,
    });
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
  await c.pushSessions();
}

export async function renameSession(c: ChatController, id: string): Promise<void> {
  const target = await c.store.read(id);
  if (!target) {
    return;
  }
  const title = await getHost().input({
    title: '重命名对话',
    value: target.title,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return;
  }
  const updated = await c.store.rename(id, title);
  if (updated && id === c.current.id) {
    c.current.title = updated.title;
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
  await c.pushSessions();
}
