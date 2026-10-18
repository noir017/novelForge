/**
 * 内置编辑器的「不丢稿」后端一半：冲突时的对比合并，与历史版本的列、读、对比、现在存一版。
 *
 * 两件事都**不写盘**：合并 / 对比的结果经 `editorReplace` 交回发起的那个页面，前端用 `Pane.applyEdit`
 * 换进编辑区（一步撤销，成为未保存），存不存由作者——恢复一版从不直接盖掉磁盘上的那一份（第 3 条）。
 * 快照本身由网关在覆盖之前存（`workspace/history.ts`），这里只读。
 *
 * 合并视图是宿主的能力（`Host.mergeTexts`，独立版有、插件壳没有）：没有的宿主只回一句说明，不抛。
 */
import * as path from 'node:path';
import type { ChatController } from './index';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { WsError } from '../workspace/guard';
import {
  historyUnavailable,
  listSnapshots,
  parseSnapshotFileName,
  readSnapshot,
  snapshotNow,
} from '../workspace/history';

const log = scoped('历史版本');

/**
 * 冲突条「对比合并…」：左边磁盘上此刻的那一份、右边编辑器里的这一份（`text`），逐段挑。采纳之后回
 * `editorReplace`，带上磁盘那份当新的乐观锁基线——作者看过了磁盘上的改动，之后照常 Ctrl+S，不必强制保存。
 * 放弃或关掉合并视图：什么都不回，编辑区与冲突条原样。
 */
export async function mergeWithDisk(c: ChatController, rel: string, text: string, requestId: string): Promise<void> {
  const host = getHost();
  if (!host.mergeTexts) {
    c.toast('这里没有对比合并视图：请用「用磁盘版本覆盖编辑器」或「用编辑器内容强制保存」。', 'error');
    return;
  }
  let disk: { text: string; hash: string };
  try {
    disk = await c.workspace.read(rel);
  } catch (err) {
    if (err instanceof WsError && err.code === 'notFound') {
      c.toast(`磁盘上已经没有「${rel}」了，没有可对比的：直接保存会按编辑器里的内容重新建出来。`, 'error');
      return;
    }
    throw err;
  }
  const verdict = await host.mergeTexts(`对比合并「${path.posix.basename(rel)}」：磁盘上的 ↔ 编辑器里的`, disk.text, text, {
    sides: { before: '磁盘上的', after: '编辑器里的' },
    applyLabel: '放回编辑器',
    message: `${rel}　·　放回之后仍是未保存，照常 Ctrl+S 保存即可（不必强制保存）`,
  });
  const merged = typeof verdict === 'object' ? verdict.merged : verdict === 'apply' ? text : undefined;
  if (merged === undefined) {
    log.info(`放弃对比合并 ${rel}`);
    return;
  }
  log.info(`对比合并 ${rel}：放回编辑器`, `${merged.length} 字符，基线换成磁盘上的 ${disk.hash}`);
  c.post({ type: 'editorReplace', requestId, path: rel, text: merged, base: { text: disk.text, hash: disk.hash } });
}

/** 列出这份文件的快照（新的在前）。不存历史版本的文件照实说为什么。 */
export async function listVersions(c: ChatController, rel: string): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  c.post({
    type: 'versions',
    path: rel,
    entries: unavailable ? [] : await listSnapshots(c.project, rel),
    ...(unavailable ? { unavailable } : {}),
  });
}

/** 读某一个快照的全文，回给发起的那个页面。 */
export async function readVersion(c: ChatController, rel: string, id: string, requestId: string): Promise<void> {
  try {
    const text = await readSnapshot(c.project, rel, id);
    c.post({ type: 'versionText', requestId, path: rel, id, text });
  } catch (err) {
    c.post({ type: 'versionText', requestId, path: rel, id, error: describeError(err) });
  }
}

/**
 * 「对比…」：左边那一个快照、右边编辑器里当前的这一份（`text`），逐段挑。采纳之后回 `editorReplace`
 * （不带基线：磁盘那一份没变，换进去的是作者挑出来的内容，成为未保存）。一处都没挑就不回，说一句。
 */
export async function compareVersion(
  c: ChatController,
  rel: string,
  id: string,
  text: string,
  requestId: string
): Promise<void> {
  const host = getHost();
  if (!host.mergeTexts) {
    c.toast('这里没有对比视图：快照在 .novelforge/history/ 里，可以直接打开看。', 'error');
    return;
  }
  let old: string;
  try {
    old = await readSnapshot(c.project, rel, id);
  } catch (err) {
    c.toast(describeError(err), 'error');
    return;
  }
  const when = describeSnapshotTime(id);
  const verdict = await host.mergeTexts(`对比「${path.posix.basename(rel)}」：${when} 的快照 ↔ 编辑器里的`, old, text, {
    sides: { before: '快照', after: '编辑器里的' },
    applyLabel: '放回编辑器',
    message: `${rel}　·　放回编辑区之后是未保存的，存不存由你`,
  });
  const merged = typeof verdict === 'object' ? verdict.merged : verdict === 'apply' ? text : undefined;
  if (merged === undefined) {
    return;
  }
  if (merged === text) {
    c.toast('没有挑快照里的任何一处，编辑区没有变化。');
    return;
  }
  log.info(`对比 ${rel} 的 ${id}：放回编辑器`, `${merged.length} 字符`);
  c.post({ type: 'editorReplace', requestId, path: rel, text: merged });
}

/**
 * 「现在存一版」：把**磁盘上当前**这份存一个快照（跳过节流）。编辑器里没保存的修改不在里面——那一份要
 * 先保存，保存本身就会把被覆盖的旧内容存一版。之后重推 `versions`。
 */
export async function saveVersion(c: ChatController, rel: string): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  if (unavailable) {
    c.toast(unavailable, 'error');
    return;
  }
  const r = await snapshotNow(c.project, rel);
  if (r.saved) {
    c.toast('已把磁盘上现在这一份存成一版（编辑器里没保存的修改不在里面）。');
  } else if (r.skipped === 'same') {
    c.toast('磁盘上这一份与最近一版一字不差，没有重复存。');
  } else if (r.skipped === 'missing') {
    c.toast('磁盘上还没有这份文件（还没保存过），没有可存的。', 'error');
  } else if (r.skipped === 'tooLarge') {
    c.toast('这份文件超过 2 MB，不存历史版本。', 'error');
  } else {
    c.toast(`没能存下这一版：${r.error ?? '原因不明'}`, 'error');
  }
  await listVersions(c, rel);
}

/** 快照那一刻的说法（`10-18 14:32`），合并视图的标题用。认不出的名字原样给。 */
function describeSnapshotTime(id: string): string {
  const at = parseSnapshotFileName(id);
  if (!at) {
    return id;
  }
  const d = new Date(at.time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
