/**
 * 存档点的两件功能层的事（存储在 `workspace/checkpoints.ts`，设计见 `docs/design/plans/2026-10-20-checkpoints.md`）：
 *
 * - {@link checkpointBefore}：批量动作之前自动存一个。九处批量动作（批量写章、补齐架构、批量拆细纲、全书替换、按目录
 *   整理设定、批量展开设定、导入原稿、从已写正文补齐、立即同步）在作者点了「开始」、第一次写盘之前调它。钩子在功能层，
 *   外部 agent 经 MCP 调同一个批量功能也一样先存。与最近一个存档点一模一样就不另存。**绝不抛**：存不下只记一条 warn，
 *   批量动作照常跑（第 1 条；每份文件覆盖之前照样存历史版本）。
 * - {@link restoreCheckpoint}：退回（单份或整本）的编排。面板上点了两下「退回」就是那一问（第 3 条）。
 */
import { describeError, scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import type { RestoreCheckpointRequest } from '../protocol/checkpoints';
import { Workspace, WsConflictError, WsError } from '../workspace';
import {
  CheckpointInfo,
  checkpointUnavailable,
  createCheckpoint,
  readCheckpoint,
  readCheckpointBytes,
} from '../workspace/checkpoints';
import { kindOfPath, normalizeRel } from '../workspace/kind';
import { readFile } from 'node:fs/promises';

const log = scoped('存档点');

/**
 * 批量动作之前自动存一个存档点，`note` 是给人看的那一句（「批量写章之前（第 12–20 章）」）。返回存档点的名字
 * （与最近一个一模一样时是最近那一个）；还不是小说工程、存不下都给 undefined。绝不抛。
 */
export async function checkpointBefore(project: NovelProject, note: string): Promise<string | undefined> {
  try {
    if (await checkpointUnavailable(project)) {
      return undefined;
    }
    const r = await createCheckpoint(project, { note, auto: true });
    return r.id;
  } catch (err) {
    log.warn(`没能先存一个存档点（${note}），照常进行`, describeError(err));
    return undefined;
  }
}

/** 存档点的说法：`10-20 22:30「第一卷写完」`（没备注就只有时间）。界面上、自动备注里都用它。 */
export function describeCheckpoint(cp: Pick<CheckpointInfo, 'time' | 'note'>): string {
  const d = new Date(cp.time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const note = cp.note.length > 20 ? `${cp.note.slice(0, 20)}…` : cp.note;
  return note ? `${when}「${note}」` : when;
}

export type RestoreSkipReason = 'dirty' | 'changed' | 'appeared' | 'notInCheckpoint' | 'inCheckpoint' | 'noBase' | 'unreadable' | 'failed';

export const RESTORE_SKIP_TEXT: Record<RestoreSkipReason, string> = {
  dirty: '编辑器里有未保存的修改：先保存（或放弃修改），再退回一次',
  changed: '面板打开之后别处又改过，没拿存档点里的旧稿去盖',
  appeared: '面板打开之后又建出来了，没动',
  notInCheckpoint: '存档点里没有这一份',
  inCheckpoint: '这一份存档点里有，不是之后新建的，不搬进回收站',
  noBase: '面板上没有它的记录，没动',
  unreadable: '存档点里这一份的内容读不出来',
  failed: '写不进去',
};

export interface RestoreOutcome {
  /** 没退回的原因（有任务在跑、存档点不在了、先存「退回之前」失败）。给了它别的都是空的。 */
  refused?: string;
  /** 退回之前先存的那一个存档点（与最近一个一模一样时是最近那一个）。 */
  before?: string;
  restored: string[];
  trashed: string[];
  skipped: { path: string; reason: RestoreSkipReason; detail?: string }[];
}

/**
 * 退回：`paths` 里的每一份写回成存档点里的那一份，`trash` 里的（存档点之后新建的）搬进回收站。
 *
 * 1. 有任务在跑、或正在生成（`busy`），不退——一边写一边退，结果谁也说不清。
 * 2. 先把要写回的内容全部读进来（存档点里的对象），再存「退回之前」：存的时候可能裁掉最旧的自动存档点，要退回的
 *    恰好是它也不怕。
 * 3. 先存一个「退回到 … 之前」的自动存档点——退回本身也能撤回。**存不下就不退回**（别处的自动存档点存不下不挡事，
 *    唯独这里挡：没有它，整本退回就收不回来了）。
 * 4. 逐份写回（`Workspace.restoreBytes`：字节原样、守卫照过、覆盖之前存一版历史、不跑记账）。编辑器里有未保存修改的
 *    跳过；乐观锁对不上（面板打开之后别处改过、又建出来）跳过。搬进回收站的同样带乐观锁。
 * 5. 动过章节就同步一次 manifest。
 */
export async function restoreCheckpoint(
  project: NovelProject,
  req: RestoreCheckpointRequest,
  opts: { busy: boolean }
): Promise<RestoreOutcome> {
  const out: RestoreOutcome = { restored: [], trashed: [], skipped: [] };
  if (opts.busy) {
    return { ...out, refused: '有任务在跑（或正在生成）：等它跑完、或先停下，再退回。' };
  }
  let cp: CheckpointInfo;
  try {
    cp = await readCheckpoint(project, req.id);
  } catch (err) {
    return { ...out, refused: describeError(err) };
  }

  const dirty = new Set(listOf(req.dirty).map(normalizeRel).filter((p): p is string => !!p));
  const expect = req.expect && typeof req.expect === 'object' ? req.expect : {};
  const skip = (path: string, reason: RestoreSkipReason, detail?: string) => out.skipped.push({ path, reason, ...(detail ? { detail } : {}) });

  // 先把要写回的内容读进来。
  const toWrite: { rel: string; bytes: Buffer }[] = [];
  for (const rel of unique(listOf(req.paths))) {
    if (!cp.files[rel]) {
      skip(rel, 'notInCheckpoint');
      continue;
    }
    try {
      toWrite.push({ rel, bytes: await readCheckpointBytes(project, cp, rel) });
    } catch (err) {
      skip(rel, 'unreadable', describeError(err));
    }
  }
  const toTrash: string[] = [];
  for (const rel of unique(listOf(req.trash))) {
    if (cp.files[rel]) {
      skip(rel, 'inCheckpoint');
    } else {
      toTrash.push(rel);
    }
  }
  if (toWrite.length === 0 && toTrash.length === 0) {
    return out;
  }

  try {
    out.before = (await createCheckpoint(project, { note: `退回到${describeCheckpoint(cp)}之前`, auto: true })).id;
  } catch (err) {
    log.warn(`没能先存一个「退回之前」的存档点，没有退回`, describeError(err));
    return { ...out, refused: `没能先存一个「退回之前」的存档点，没有退回：${describeError(err)}` };
  }

  const ws = new Workspace(project);
  let chapters = false;
  for (const { rel, bytes } of toWrite) {
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    const base = expect[rel];
    if (base === undefined) {
      skip(rel, 'noBase');
      continue;
    }
    try {
      await ws.restoreBytes(rel, bytes, base === null ? { absent: true } : { baseHash: base });
      out.restored.push(rel);
      chapters ||= kindOfPath(project, rel).kind === 'chapter';
    } catch (err) {
      if (err instanceof WsConflictError) {
        skip(rel, 'changed');
      } else if (err instanceof WsError && err.code === 'exists') {
        skip(rel, 'appeared');
      } else {
        skip(rel, 'failed', describeError(err));
      }
    }
  }
  for (const rel of toTrash) {
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    const base = expect[rel];
    if (typeof base !== 'string') {
      skip(rel, 'noBase');
      continue;
    }
    let current: string;
    try {
      current = await readFile(project.pathOf(rel), 'utf8');
    } catch {
      continue; // 已经没了：本来就是要它不在。
    }
    if (hash(current) !== base) {
      skip(rel, 'changed');
      continue;
    }
    try {
      await ws.remove(rel);
      out.trashed.push(rel);
      chapters ||= kindOfPath(project, rel).kind === 'chapter';
    } catch (err) {
      skip(rel, 'failed', describeError(err));
    }
  }
  if (chapters) {
    await project.syncManifest().catch((err) => log.warn('退回之后同步章节清单失败', describeError(err)));
  }
  log.info(
    `退回到存档点 ${cp.id}`,
    `退回 ${out.restored.length} 份｜搬进回收站 ${out.trashed.length} 份｜跳过 ${out.skipped.length} 份｜退回之前存在 ${out.before}`
  );
  return out;
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 规范化、去重；越界的丢掉。 */
function unique(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRel).filter((p): p is string => !!p))];
}
