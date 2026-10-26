/**
 * 工程页「存档点…」弹窗与编辑器「版本」侧栏「全书改动」的后端一半：列、存、写备注、跟现在比、退回。存储在
 * `workspace/checkpoints.ts`，退回的编排在 `features/checkpoint.ts`，设计见 `docs/design/plans/2026-10-20-checkpoints.md`。
 * 单份对比在内置编辑器的对比标签里（`media/src/editor/versionDiff.ts`，全文经 `readVersion` 的 `cp:` 取），这里不管。
 */
import type { ChatController } from './index';
import { describeError, scoped } from '../runtime/logger';
import { activeTasks } from '../runtime/progress';
import type { CheckpointView, RestoreCheckpointRequest } from '../protocol/checkpoints';
import { NovelProject } from '../model/project';
import {
  CheckpointInfo,
  checkpointUnavailable,
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  noteCheckpoint,
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
