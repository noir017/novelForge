/**
 * 工程页「存档点…」弹窗的后端一半：列、存、写备注、跟现在比、单份对比、退回。存储在 `workspace/checkpoints.ts`，
 * 退回的编排在 `features/checkpoint.ts`，设计见 `docs/design/plans/2026-10-20-checkpoints.md`。
 *
 * 单份对比走宿主的合并视图（`Host.mergeTexts`，独立版与桌面版有）：存档点里的那一份 ↔ 磁盘上现在这份，挑好的**直接
 * 写盘**——这里没有编辑区可以放回去，合并视图里点的「写入」就是那一问（第 3 条）；经网关 `write`（`review: false`，
 * 带打开对比时磁盘那一份的 hash 当乐观锁），覆盖之前照样存一版历史。
 */
import * as path from 'node:path';
import type { ChatController } from './index';
import { getHost } from '../host';
import { decodeFileText } from '../model/importText';
import { describeError, scoped } from '../runtime/logger';
import { activeTasks } from '../runtime/progress';
import type { CheckpointView, RestoreCheckpointRequest } from '../protocol/checkpoints';
import { NovelProject } from '../model/project';
import { WsConflictError, WsError } from '../workspace';
import {
  CheckpointInfo,
  checkpointUnavailable,
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  noteCheckpoint,
  readCheckpoint,
  readCheckpointBytes,
} from '../workspace/checkpoints';
import { kindOfPath } from '../workspace/kind';
import { RESTORE_SKIP_TEXT, RestoreOutcome, describeCheckpoint, restoreCheckpoint } from '../features/checkpoint';

const log = scoped('存档点');

/** 列出存档点，回 `checkpoints`。 */
export async function pushCheckpoints(c: ChatController): Promise<void> {
  const unavailable = await checkpointUnavailable(c.project);
  c.post({
    type: 'checkpoints',
    entries: unavailable ? [] : (await listCheckpoints(c.project)).map((cp) => checkpointView(c.project, cp)),
    ...(unavailable ? { unavailable } : {}),
  });
}

export function checkpointView(project: NovelProject, cp: CheckpointInfo): CheckpointView {
  let chapters = 0;
  let chapterWords = 0;
  for (const [rel, f] of Object.entries(cp.files)) {
    if (kindOfPath(project, rel).kind === 'chapter') {
      chapters++;
      chapterWords += f.words;
    }
  }
  return {
    id: cp.id,
    time: cp.time,
    note: cp.note,
    auto: cp.auto,
    files: Object.keys(cp.files).length,
    chapters,
    chapterWords,
    skipped: cp.skipped,
  };
}

/** 「存一个存档点」（手动）。之后重推列表。 */
export async function saveCheckpoint(c: ChatController, note: string): Promise<void> {
  const unavailable = await checkpointUnavailable(c.project);
  if (unavailable) {
    c.toast(unavailable, 'error');
    return;
  }
  try {
    const r = await createCheckpoint(c.project, { note: typeof note === 'string' ? note : '', auto: false });
    // 份数与内容数对不上很正常：同样的内容（几份空模板、以前的存档点里已经有的）只存一份。
    const shared =
      r.newObjects === 0 ? '（内容都与以前的存档点共用，没多占地方）' : `（新存了 ${r.newObjects} 份内容，同样的内容只存一份）`;
    const large = r.skipped.length > 0 ? `；${r.skipped.length} 份超过 2 MB 没存：${clipList(r.skipped)}` : '';
    c.toast(`已存一个存档点：${r.files} 份文件${shared}${large}。`);
  } catch (err) {
    log.warn('存档点没存下', describeError(err));
    c.toast(`存档点没存下：${describeError(err)}`, 'error');
  }
  await pushCheckpoints(c);
}

/** 写备注（自动的就此留住）。之后重推列表。 */
export async function setCheckpointNote(c: ChatController, id: string, note: string): Promise<void> {
  try {
    const cp = await noteCheckpoint(c.project, id, typeof note === 'string' ? note : '');
    c.toast(`存档点 ${describeCheckpoint(cp)} 会一直留着，不会被自动裁掉。`);
  } catch (err) {
    c.toast(describeError(err), 'error');
  }
  await pushCheckpoints(c);
}

/** 跟现在比，回 `checkpointDiff`。 */
export async function pushCheckpointDiff(c: ChatController, id: string): Promise<void> {
  try {
    const d = await diffCheckpoint(c.project, id);
    c.post({ type: 'checkpointDiff', id, diff: { id, unchanged: d.unchanged, entries: d.entries } });
  } catch (err) {
    c.post({ type: 'checkpointDiff', id, error: describeError(err) });
  }
}

/** 单份对比（见文件头）。写了就 `pushState` 并重推这个存档点的比较。 */
export async function compareCheckpointFile(c: ChatController, id: string, rel: string): Promise<void> {
  const host = getHost();
  if (!host.mergeTexts) {
    c.toast('这里没有对比视图（独立版与桌面版有）：可以直接「退回这一份」，被盖掉的那一份会先存一版历史。', 'error');
    return;
  }
  let cp: CheckpointInfo;
  let old: string;
  try {
    cp = await readCheckpoint(c.project, id);
    old = decodeFileText(await readCheckpointBytes(c.project, cp, rel));
  } catch (err) {
    c.toast(describeError(err), 'error');
    return;
  }
  let disk: { text: string; hash: string } | undefined;
  try {
    disk = await c.workspace.read(rel);
  } catch (err) {
    if (!(err instanceof WsError && err.code === 'notFound')) {
      c.toast(describeError(err), 'error');
      return;
    }
    disk = undefined; // 现在没有这一份：右边是空的，挑好的照新建写。
  }
  const now = disk?.text ?? '';
  const verdict = await host.mergeTexts(
    `对比「${path.posix.basename(rel)}」：存档点 ${describeCheckpoint(cp)} ↔ 现在`,
    old,
    now,
    {
      sides: { before: '存档点里的', after: disk ? '现在的' : '现在（没有这一份）' },
      applyLabel: '写入',
      message: `${rel}　·　挑好之后直接写盘${disk ? '（被盖掉的这一份先存一版历史）' : ''}`,
    }
  );
  const merged = typeof verdict === 'object' ? verdict.merged : verdict === 'apply' ? now : undefined;
  if (merged === undefined) {
    return;
  }
  if (merged === now) {
    c.toast('没有挑存档点里的任何一处，没有改动。');
    return;
  }
  try {
    await c.workspace.write(
      rel,
      { text: merged },
      disk ? { mode: 'overwrite', review: false, baseHash: disk.hash } : { mode: 'create' }
    );
    log.info(`对比存档点 ${id} 的 ${rel}：写入`, `${merged.length} 字符`);
    c.toast(`已写入 ${rel}。`);
  } catch (err) {
    if (err instanceof WsConflictError || (err instanceof WsError && err.code === 'exists')) {
      c.toast(`对比期间 ${rel} 在磁盘上又变了，没写：重新对比一次。`, 'error');
    } else {
      c.toast(describeError(err), 'error');
    }
    return;
  }
  await c.pushState();
  await pushCheckpointDiff(c, id);
}

/** 退回（单份或整本）。之后 `pushState`、重推列表（多了「退回之前」那一个）与这个存档点的比较。 */
export async function restoreCheckpointFor(c: ChatController, request: RestoreCheckpointRequest): Promise<void> {
  const req = request && typeof request === 'object' ? request : ({} as RestoreCheckpointRequest);
  const busy = c.busy || activeTasks(c.project.root).length > 0;
  const outcome = await restoreCheckpoint(c.project, req, { busy });
  if (outcome.refused) {
    c.toast(outcome.refused, 'error');
  } else {
    c.toast(describeOutcome(outcome), outcome.restored.length + outcome.trashed.length === 0 ? 'error' : 'info');
  }
  if (outcome.restored.length + outcome.trashed.length > 0) {
    await c.pushState();
  }
  await pushCheckpoints(c);
  if (typeof req.id === 'string') {
    await pushCheckpointDiff(c, req.id);
  }
}

/** 退回的汇总（toast）：退回几份、搬进回收站几份、跳过的逐份说为什么（多了只列前几份，其余在日志里）。 */
export function describeOutcome(o: RestoreOutcome): string {
  const parts: string[] = [];
  if (o.restored.length + o.trashed.length === 0) {
    parts.push('一份都没有退回');
  } else {
    parts.push(`已退回 ${o.restored.length} 份` + (o.trashed.length > 0 ? `，搬进回收站 ${o.trashed.length} 份` : ''));
  }
  if (o.skipped.length > 0) {
    const shown = o.skipped.slice(0, 3).map((s) => `${s.path}（${s.detail ?? RESTORE_SKIP_TEXT[s.reason]}）`);
    parts.push(`跳过 ${o.skipped.length} 份：${shown.join('；')}${o.skipped.length > 3 ? ' 等，明细在日志里' : ''}`);
    for (const s of o.skipped) {
      log.info(`退回时跳过 ${s.path}`, s.detail ?? RESTORE_SKIP_TEXT[s.reason]);
    }
  }
  if (o.before && o.restored.length + o.trashed.length > 0) {
    parts.push('退回之前的样子存成了一个存档点，想反悔可以再退回去');
  }
  return `${parts.join('。')}。`;
}

function clipList(paths: string[]): string {
  return paths.length > 3 ? `${paths.slice(0, 3).join('、')} 等` : paths.join('、');
}
