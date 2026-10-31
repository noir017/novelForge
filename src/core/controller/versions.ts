/**
 * 内置编辑器的「不丢稿」后端一半：冲突时的对比合并，与「版本」侧栏的列、读、现在存一版。
 *
 * 对比合并**不写盘**：结果经 `editorReplace` 交回发起的那个页面，前端用 `Pane.applyEdit` 换进编辑区（一步撤销，成为
 * 未保存），存不存由作者（第 3 条）。合并视图是宿主的能力（`Host.mergeTexts`，独立版有、插件壳没有）：没有的宿主只回一句
 * 说明，不抛。
 *
 * 「版本」侧栏的时间线是这份文件的快照（网关在覆盖之前存的，`workspace/history.ts`）与它在各存档点里的样子
 * （`workspace/checkpoints.ts`）混排；这里只读。两版之间怎么不同、放回哪一处都是前端的事（`editor/versionDiff.ts`），
 * 后端只给全文。
 */
import * as path from 'node:path';
import type { ChatController } from './index';
import { getHost } from '../host';
import { decodeFileText } from '../model/importText';
import type { VersionView } from '../protocol';
import { describeError, scoped } from '../runtime/logger';
import { WsError } from '../workspace/guard';
import { checkpointVersionsOf, readCheckpoint, readCheckpointBytes } from '../workspace/checkpoints';
import { historyUnavailable, listSnapshots, readSnapshot, snapshotNow } from '../workspace/history';

/** 存档点那几行的 id 前缀（后面是存档点的 id）。快照的 id 是文件名，不会以它开头。 */
export const CHECKPOINT_VERSION_PREFIX = 'cp:';

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
  // 磁盘上那一份（别处改过的）先存一版：放回去的合并结果一存盘就盖掉它，而节流按「改动小」可能不存。
  await snapshotNow(c.project, rel);
  c.post({ type: 'editorReplace', requestId, path: rel, text: merged, base: { text: disk.text, hash: disk.hash } });
}

/**
 * 列出这份文件的历史版本：快照与它在各存档点里的样子混排，新的在前。不存历史版本的文件照实说为什么。
 * 存档点读不动（目录坏了之类）只是少了那几行，快照照样列。
 */
export async function listVersions(c: ChatController, rel: string): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  if (unavailable) {
    c.post({ type: 'versions', path: rel, entries: [], unavailable });
    return;
  }
  const entries: VersionView[] = await listSnapshots(c.project, rel);
  try {
    for (const v of await checkpointVersionsOf(c.project, rel)) {
      entries.push({
        id: `${CHECKPOINT_VERSION_PREFIX}${v.id}`,
        time: v.time,
        words: v.words,
        bytes: v.bytes,
        checkpoint: { note: v.note, auto: v.auto },
      });
    }
  } catch (err) {
    log.warn(`列 ${rel} 在存档点里的样子失败`, describeError(err));
  }
  entries.sort((a, b) => b.time - a.time);
  c.post({ type: 'versions', path: rel, entries });
}

/** 读某一版的全文（快照，或存档点里的那一份），回给发起的那个页面。 */
export async function readVersion(c: ChatController, rel: string, id: string, requestId: string): Promise<void> {
  try {
    const text = id.startsWith(CHECKPOINT_VERSION_PREFIX)
      ? decodeFileText(await readCheckpointBytes(c.project, await readCheckpoint(c.project, id.slice(CHECKPOINT_VERSION_PREFIX.length)), rel))
      : await readSnapshot(c.project, rel, id);
    c.post({ type: 'versionText', requestId, path: rel, id, text });
  } catch (err) {
    c.post({ type: 'versionText', requestId, path: rel, id, error: describeError(err) });
  }
}

/**
 * 「现在存一版」：把**磁盘上当前**这份存一个快照（跳过节流）。编辑器里没保存的修改不在里面——那一份要
 * 先保存，保存本身就会把被覆盖的旧内容存一版。之后重推 `versions`。
 *
 * `quiet`：前端把一版（或一处）放回编辑区之前顺手发的：放回去的内容一存盘（开着自动保存时停笔两秒就存）就盖掉
 * 磁盘上这一份，而节流按「改动小」可能不存它。什么提示都不弹——作者点的是「恢复」，不是「存一版」；存不下的原因已经记了 warn。
 */
export async function saveVersion(c: ChatController, rel: string, quiet = false): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  if (unavailable) {
    if (!quiet) {
      c.toast(unavailable, 'error');
    }
    return;
  }
  const r = await snapshotNow(c.project, rel);
  if (quiet) {
    // 不说话；列表照样重推（多了一版的话面板上跟着出现）。
  } else if (r.saved) {
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
