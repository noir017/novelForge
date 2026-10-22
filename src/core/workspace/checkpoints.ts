/**
 * 存档点：整本书在某一刻的样子。作者在工程页「存档点…」里手动存一个（带一句备注），批量动作之前机器自动存一个
 * （`features/checkpoint.ts` 的 `checkpointBefore`）；之后可以看每个存档点跟现在比改了哪几份，整本或单份退回去。
 * 设计见 `docs/design/plans/2026-10-20-checkpoints.md`。
 *
 * 历史版本（`history.ts`）管的是**一份文件**被覆盖之前的那一版；这里管的是**整本书一起**——批量写了二十章、全书替换
 * 改了几十份，按文件一份一份找回去不现实。两层互不替代：退回存档点时，被盖掉的每一份照样先存一版历史。
 *
 * ## 布局
 *
 * ```
 * .novelforge/checkpoints/
 * ├── .gitignore                                第一次建这个目录时放进来，内容 `*`（同历史版本）
 * ├── objects/3f/a9c1…                          文件内容，按 sha256 寻址：前两位当目录，余下 62 位当文件名；字节原样
 * └── points/2026-10-20_22-30-05+0800.json      一个存档点一份清单（名字的格式同历史版本的快照，去掉 `.txt`）
 * ```
 *
 * - **同样的内容只存一份**：第二个存档点只多存这期间改过的那几份，外加一份清单。
 * - **先写对象、最后写清单**：清单是提交点。写到一半失败，剩下的只是没人引用的对象，清理时带走。对象先写进临时文件
 *   再改名：断电时不会留下一个名字对、内容只有半截的对象。
 * - **字节原样**：不转码（GBK 的章节存下来还是 GBK）、不压缩。退回时原样写回（`Workspace.restoreBytes`）。
 *
 * ## 存哪些（{@link trackedFiles}）
 *
 * `kindOfPath` 不是 `other` 的——与历史版本同一个口径（章节、草稿、细纲、角色卡、设定、架构、大纲、文风、叙事线、
 * 全文大纲、技能、敏感词表）。只扫章节根、草稿根与 `.novelforge/` 三处，不扫整个工程根；隐藏目录、会话、回收站、
 * 历史版本、存档点自己都不进。超过网关大小上限（2 MB）的单份不存，记进清单的 `skipped`，界面上说出来（第 2 条）。
 *
 * ## 保留（{@link checkpointsToPrune}）
 *
 * 手动的永远留；自动的留最近 {@link CHECKPOINT_AUTO_KEEP} 个。给自动的写备注就是留住它（{@link noteCheckpoint}：变成手动）。
 * 删掉清单之后清理没人引用的对象（{@link collectGarbage}）：只删写下超过 {@link ORPHAN_GRACE_MS} 的——另一个进程可能
 * 正在存、对象写了清单还没写。有一份清单读不懂就整个不清（不知道它引用了哪些，宁可多留）。
 *
 * ## 内部文件
 *
 * 整个目录是 Novel Forge 的内部文件（`guard.ts` 的 `isInternalPath`）：搜不到、读当不存在、写搬删都拒；监听也挡掉它
 * （`watchPolicy.ts`）。这里的写盘都是这一层自己的（与 `history.ts` 一样在网关里），不经 `Workspace.write`。
 *
 * ## 排队
 *
 * 同一个工程的存、写备注、清理在进程里排队（{@link withCheckpointLock}，按工程根一把锁）：自动存档点可能与作者手动存的
 * 撞在一起，清理不能删掉另一个正在存的那一份的对象。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { countWords, hash, isIgnoredDir } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { NovelProject } from '../model/project';
import { MAX_EDITABLE_BYTES, WsError, isInHistory, isInTrash, isInternalPath } from './guard';
import { parseSnapshotFileName, snapshotFileName } from './history';
import { ArtifactKind, kindOfPath } from './kind';

const log = scoped('存档点');

/** 自动存档点留最近几个。 */
export const CHECKPOINT_AUTO_KEEP = 30;
/** 没人引用的对象，写下多久之后才清（另一个进程可能正在存）。 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
/** 第一次建存档点目录时放进去的 `.gitignore`。 */
export const CHECKPOINT_GITIGNORE = '*\n';
/** 扫目录的最大深度（同 `model/project.ts` 列章节）。 */
const MAX_DEPTH = 8;

/** 清单里的一份文件。 */
export interface CheckpointFile {
  /** 内容的 sha256（十六进制）：对象的名字。 */
  sha: string;
  bytes: number;
  words: number;
}

/** 一份清单（`points/<id>.json`）。 */
export interface CheckpointManifest {
  v: 1;
  /** 存下的那一刻（毫秒时间戳）。 */
  time: number;
  note: string;
  auto: boolean;
  /** 工程内相对路径 → 那一刻的内容。 */
  files: Record<string, CheckpointFile>;
  /** 超过大小上限、没存进去的。 */
  skipped: string[];
}

export interface CheckpointInfo extends CheckpointManifest {
  /** 清单的文件名去掉 `.json`。 */
  id: string;
}

// ---------------------------------------------------------------- 纯函数

/** 存档点的名字：那一刻的本地时间 + 时区，同一秒的第二个带序号。格式同历史版本的快照（去掉 `.txt`）。 */
export function checkpointIdOf(at: Date, dup = 1): string {
  return snapshotFileName(at, dup).replace(/\.txt$/, '');
}

/** 读存档点的名字：那一刻（毫秒时间戳）。不是存档点的名字（带斜杠、`..`、乱写的）给 undefined。 */
export function parseCheckpointId(id: string): number | undefined {
  if (typeof id !== 'string' || id.includes('/') || id.includes('\\')) {
    return undefined;
  }
  return parseSnapshotFileName(`${id}.txt`)?.time;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * 解析一份清单。**容错**（第 1 条）：认不出的整份给 undefined；单份文件的记录坏了就丢掉那一份（路径越界、sha 不像、
 * 数字不对）。`id` 用来在 `time` 缺了时从名字补。
 */
export function parseManifest(text: string, id?: string): CheckpointManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) {
    return undefined;
  }
  const files: Record<string, CheckpointFile> = {};
  for (const [rel, value] of Object.entries(obj.files as Record<string, unknown>)) {
    if (!isSafeRel(rel) || !value || typeof value !== 'object') {
      continue;
    }
    const f = value as Record<string, unknown>;
    if (typeof f.sha !== 'string' || !SHA_RE.test(f.sha)) {
      continue;
    }
    files[rel] = { sha: f.sha, bytes: numberOr(f.bytes, 0), words: numberOr(f.words, 0) };
  }
  const time = typeof obj.time === 'number' && Number.isFinite(obj.time) ? obj.time : id ? parseCheckpointId(id) : undefined;
  if (time === undefined) {
    return undefined;
  }
  return {
    v: 1,
    time,
    note: typeof obj.note === 'string' ? obj.note : '',
    auto: obj.auto === true,
    files,
    skipped: Array.isArray(obj.skipped) ? obj.skipped.filter((s): s is string => typeof s === 'string') : [],
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 清单里的路径只认工程内的相对路径（手改坏了的清单不能把退回引到工程外面去）。 */
function isSafeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) {
    return false;
  }
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** 两个存档点（或存档点与此刻）的文件是不是一模一样：路径一样、每份的 sha 一样。 */
export function sameFiles(a: Record<string, { sha: string }>, b: Record<string, { sha: string }>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) {
    return false;
  }
  return ka.every((k) => b[k]?.sha === a[k].sha);
}

/** 此刻磁盘上的一份（比较用）。 */
export interface CurrentFile {
  sha: string;
  words: number;
  /** 网关乐观锁的口径（`model/fs.ts` 的 `hash`，按 utf8 读出来算，与 `guardWrite` 读盘的方式一致）。 */
  hash: string;
}

export interface FileDiff {
  path: string;
  status: 'changed' | 'deleted' | 'added';
  wordsThen?: number;
  wordsNow?: number;
  hashNow?: string;
}

/**
 * 存档点 ↔ 此刻逐份比：改过的、之后删掉的、之后新建的。一模一样的只计数。按路径排（中文、数字按数值）。
 * 存档点里因为太大没存的（`skipped`）不算「之后新建」——那一份当时就在，只是没存。
 */
export function compareFiles(
  then: Record<string, CheckpointFile>,
  now: Record<string, CurrentFile>,
  skipped: readonly string[] = []
): { unchanged: number; entries: FileDiff[] } {
  const entries: FileDiff[] = [];
  let unchanged = 0;
  for (const [rel, f] of Object.entries(then)) {
    const cur = now[rel];
    if (!cur) {
      entries.push({ path: rel, status: 'deleted', wordsThen: f.words });
    } else if (cur.sha === f.sha) {
      unchanged++;
    } else {
      entries.push({ path: rel, status: 'changed', wordsThen: f.words, wordsNow: cur.words, hashNow: cur.hash });
    }
  }
  const tooLarge = new Set(skipped);
  for (const [rel, cur] of Object.entries(now)) {
    if (!then[rel] && !tooLarge.has(rel)) {
      entries.push({ path: rel, status: 'added', wordsNow: cur.words, hashNow: cur.hash });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
  return { unchanged, entries };
}

/** 该删掉的存档点（`list` 新的在前）：自动的超出保留数的那几个（最旧的）。手动的一个不删。 */
export function checkpointsToPrune(
  list: readonly Pick<CheckpointInfo, 'id' | 'auto'>[],
  keep = CHECKPOINT_AUTO_KEEP
): string[] {
  return list
    .filter((c) => c.auto)
    .slice(Math.max(0, keep))
    .map((c) => c.id);
}

// ---------------------------------------------------------------- 路径

const pointsDirOf = (project: NovelProject) => path.join(project.checkpointsDir, 'points');
const objectsDirOf = (project: NovelProject) => path.join(project.checkpointsDir, 'objects');
const objectPathOf = (project: NovelProject, sha: string) => path.join(objectsDirOf(project), sha.slice(0, 2), sha.slice(2));

/** 能不能存存档点。能就给 undefined，不能给一句给人看的原因。 */
export async function checkpointUnavailable(project: NovelProject): Promise<string | undefined> {
  return (await isDir(project.novelDir)) ? undefined : '这个目录还不是小说工程（没有 .novelforge/），存不了存档点。';
}

// ---------------------------------------------------------------- 扫

/**
 * 要进存档点的文件（工程内相对路径，排好序）。只扫章节根、草稿根与 `.novelforge/`；隐藏目录（含回收站）、
 * 会话、历史版本、存档点自己都不进；符号链接不跟。种类是 `other` 的不要；情节大纲也不要（它没有文件，是各章细纲梗概的汇总，
 * 细纲在存档点里就退得回；磁盘上残留的老 `outline.md` 不是现在的书）。
 */
export async function trackedFiles(project: NovelProject): Promise<string[]> {
  const skip = new Set([project.draftsDir, project.historyDir, project.checkpointsDir, project.sessionsDir, project.trashDir].map((d) => path.resolve(d)));
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name) && !skip.has(path.resolve(abs))) {
          await walk(abs, depth + 1);
        }
      } else if (entry.isFile()) {
        const rel = project.relPath(abs);
        if (
          !rel.startsWith('..') &&
          !isInternalPath(project, rel) &&
          !isInHistory(project, rel) &&
          !isInTrash(project, rel) &&
          kindOfPath(project, rel).kind !== 'other' &&
          kindOfPath(project, rel).kind !== 'outline'
        ) {
          found.add(rel);
        }
      }
    }
  };
  // 三个根各自从里面开始走：`.novelforge/` 本身是隐藏目录，从工程根走过来会被跳过。草稿根在章节根下面时
  // （`chaptersDir` 配成 `.`）走章节根时跳过它，单独再走一遍。
  await walk(project.chaptersDir, 1);
  await walk(project.draftsDir, 1);
  await walk(project.novelDir, 1);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 此刻磁盘上要进存档点的每一份：sha、字数、乐观锁 hash。读不动的跳过（刚被删掉）。 */
export async function scanCurrent(project: NovelProject): Promise<Record<string, CurrentFile>> {
  const out: Record<string, CurrentFile> = {};
  for (const rel of await trackedFiles(project)) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(project.pathOf(rel));
    } catch {
      continue;
    }
    out[rel] = { sha: shaOf(buf), words: countWords(decodeFileText(buf)), hash: hash(buf.toString('utf8')) };
  }
  return out;
}

// ---------------------------------------------------------------- 排队

const locks = new Map<string, Promise<void>>();

/** 同一个工程的存档点操作在进程里排队，一个做完再做下一个。 */
export async function withCheckpointLock<T>(project: NovelProject, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(project.root);
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

// ---------------------------------------------------------------- 读

/** 列出存档点，新的在前。读不懂的清单跳过（记一条 warn），不抛。 */
export async function listCheckpoints(project: NovelProject): Promise<CheckpointInfo[]> {
  return (await readAll(project)).list;
}

async function readAll(project: NovelProject): Promise<{ list: CheckpointInfo[]; unreadable: number }> {
  let names: string[];
  try {
    names = (await fs.readdir(pointsDirOf(project), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return { list: [], unreadable: 0 };
  }
  const list: CheckpointInfo[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const id = name.slice(0, -'.json'.length);
    if (parseCheckpointId(id) === undefined) {
      continue;
    }
    let manifest: CheckpointManifest | undefined;
    try {
      manifest = parseManifest(await fs.readFile(path.join(pointsDirOf(project), name), 'utf8'), id);
    } catch {
      manifest = undefined;
    }
    if (!manifest) {
      unreadable++;
      log.warn(`读不懂存档点清单 ${name}，跳过`);
      continue;
    }
    list.push({ ...manifest, id });
  }
  list.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  return { list, unreadable };
}

/** 读一个存档点的清单。不在、读不懂都抛 `WsError('notFound')`。 */
export async function readCheckpoint(project: NovelProject, id: string): Promise<CheckpointInfo> {
  if (parseCheckpointId(id) === undefined) {
    throw new WsError('notFound', `找不到这个存档点：${id}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path.join(pointsDirOf(project), `${id}.json`), 'utf8');
  } catch {
    throw new WsError('notFound', `找不到这个存档点（可能已经被裁掉了）：${id}`);
  }
  const manifest = parseManifest(text, id);
  if (!manifest) {
    throw new WsError('notFound', `存档点的清单读不懂：${id}`);
  }
  return { ...manifest, id };
}

/** 读存档点里的一份（字节原样）。存档点里没有这一份、对象丢了、对象内容与 sha 对不上，都抛 `WsError('notFound')`。 */
export async function readCheckpointBytes(project: NovelProject, cp: CheckpointInfo, rel: string): Promise<Buffer> {
  const f = cp.files[rel];
  if (!f) {
    throw new WsError('notFound', `存档点「${cp.id}」里没有 ${rel}`);
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(objectPathOf(project, f.sha));
  } catch {
    throw new WsError('notFound', `存档点「${cp.id}」里 ${rel} 的内容丢了`);
  }
  if (shaOf(buf) !== f.sha) {
    throw new WsError('notFound', `存档点「${cp.id}」里 ${rel} 的内容坏了（与记下的指纹对不上）`);
  }
  return buf;
}

/** 存档点 ↔ 此刻（见 {@link compareFiles}），每份带种类。 */
export async function diffCheckpoint(
  project: NovelProject,
  id: string
): Promise<{ unchanged: number; entries: (FileDiff & { kind: ArtifactKind })[] }> {
  const cp = await readCheckpoint(project, id);
  const { unchanged, entries } = compareFiles(cp.files, await scanCurrent(project), cp.skipped);
  return { unchanged, entries: entries.map((e) => ({ ...e, kind: kindOfPath(project, e.path).kind })) };
}

// ---------------------------------------------------------------- 存

export interface CreateCheckpointResult {
  id: string;
  /** false：自动存档点与最近一个一模一样，没有另存（`id` 是最近那一个）。 */
  created: boolean;
  files: number;
  /** 这一次新写下的对象有几个（其余与以前的存档点共用）。 */
  newObjects: number;
  skipped: string[];
  /** 自动的超出保留数，裁掉了哪几个。 */
  pruned: string[];
}

/**
 * 存一个存档点。`auto`：机器存的（批量动作之前、退回之前）——与最近一个存档点一模一样就不另存；存完按保留数
 * 裁掉最旧的自动存档点并清理对象。手动的一模一样也照样存。会抛（磁盘满、权限……），自动那条路由调用方兜住。
 */
export function createCheckpoint(
  project: NovelProject,
  opts: { note: string; auto: boolean; now?: number }
): Promise<CreateCheckpointResult> {
  return withCheckpointLock(project, () => create(project, opts));
}

async function create(project: NovelProject, opts: { note: string; auto: boolean; now?: number }): Promise<CreateCheckpointResult> {
  const reason = await checkpointUnavailable(project);
  if (reason) {
    throw new WsError('notFound', reason);
  }
  await ensureRoot(project);

  const files: Record<string, CheckpointFile> = {};
  const skipped: string[] = [];
  let newObjects = 0;
  for (const rel of await trackedFiles(project)) {
    const abs = project.pathOf(rel);
    let buf: Buffer;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_EDITABLE_BYTES) {
        skipped.push(rel);
        continue;
      }
      buf = await fs.readFile(abs);
    } catch {
      continue; // 列的时候还在、读的时候没了
    }
    const sha = shaOf(buf);
    if (await writeObject(project, sha, buf)) {
      newObjects++;
    }
    files[rel] = { sha, bytes: buf.length, words: countWords(decodeFileText(buf)) };
  }

  const { list } = await readAll(project);
  if (opts.auto && list[0] && sameFiles(list[0].files, files)) {
    log.debug(`与最近一个存档点一模一样，不另存`, `${opts.note}｜沿用 ${list[0].id}`);
    return { id: list[0].id, created: false, files: Object.keys(files).length, newObjects, skipped, pruned: [] };
  }

  const now = opts.now ?? Date.now();
  const manifest: CheckpointManifest = { v: 1, time: now, note: opts.note.trim(), auto: opts.auto, files, skipped };
  const id = await writeManifestUnique(project, new Date(now), manifest);
  log.info(
    `存了一个存档点 ${id}`,
    `${opts.auto ? '自动' : '手动'}｜${manifest.note || '（没写备注）'}｜${Object.keys(files).length} 份，新存 ${newObjects} 份内容` +
      (skipped.length ? `｜超过大小上限没存 ${skipped.length} 份` : '')
  );

  let pruned: string[] = [];
  if (opts.auto) {
    pruned = checkpointsToPrune([{ id, auto: true }, ...list]);
    for (const stale of pruned) {
      await fs.unlink(path.join(pointsDirOf(project), `${stale}.json`)).catch(() => undefined);
    }
    if (pruned.length > 0) {
      log.debug(`裁掉最旧的 ${pruned.length} 个自动存档点`, `只留最近 ${CHECKPOINT_AUTO_KEEP} 个`);
      await gc(project, now);
    }
  }
  return { id, created: true, files: Object.keys(files).length, newObjects, skipped, pruned };
}

/**
 * 给一个存档点写备注。自动的写了备注就留住（变成手动，不再被裁掉）；备注空着时手动的照样是手动。返回改好的那一份。
 */
export function noteCheckpoint(project: NovelProject, id: string, note: string): Promise<CheckpointInfo> {
  return withCheckpointLock(project, async () => {
    const cp = await readCheckpoint(project, id);
    const trimmed = note.trim();
    const next: CheckpointManifest = {
      v: 1,
      time: cp.time,
      note: trimmed || cp.note,
      auto: false,
      files: cp.files,
      skipped: cp.skipped,
    };
    const file = path.join(pointsDirOf(project), `${id}.json`);
    const tmp = path.join(pointsDirOf(project), `.${randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(next, null, 1), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, file);
    log.info(`存档点 ${id} 写了备注、留住了`, trimmed);
    return { ...next, id };
  });
}

/** 清理没人引用的对象（见文件头）。返回删了几个。 */
export function collectGarbage(project: NovelProject, now = Date.now()): Promise<number> {
  return withCheckpointLock(project, () => gc(project, now));
}

async function gc(project: NovelProject, now: number): Promise<number> {
  const { list, unreadable } = await readAll(project);
  if (unreadable > 0) {
    log.warn(`有 ${unreadable} 份存档点清单读不懂，这一次不清理对象`, '不知道它们引用了哪些内容，宁可多留');
    return 0;
  }
  const referenced = new Set<string>();
  for (const cp of list) {
    for (const f of Object.values(cp.files)) {
      referenced.add(f.sha);
    }
  }
  let removed = 0;
  const root = objectsDirOf(project);
  let prefixes: string[];
  try {
    prefixes = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }
  for (const prefix of prefixes) {
    const dir = path.join(root, prefix);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (referenced.has(`${prefix}${name}`)) {
        continue;
      }
      const abs = path.join(dir, name);
      try {
        const stat = await fs.stat(abs);
        if (now - stat.mtimeMs < ORPHAN_GRACE_MS) {
          continue;
        }
        await fs.unlink(abs);
        removed++;
      } catch {
        // 别处刚删掉：跳过。
      }
    }
    await fs.rmdir(dir).catch(() => undefined); // 只删空的
  }
  if (removed > 0) {
    log.debug(`清掉 ${removed} 份没有存档点再用到的内容`);
  }
  return removed;
}

// ---------------------------------------------------------------- 写盘（这一层自己的）

/**
 * 存档点目录第一次出现时放一个 `.gitignore`（`*`）。只在**建出这个目录**的那一次放：作者删掉它就是想让
 * git 收存档点，之后不再补回来（同历史版本）。
 */
async function ensureRoot(project: NovelProject): Promise<void> {
  if (await isDir(project.checkpointsDir)) {
    return;
  }
  await fs.mkdir(project.checkpointsDir, { recursive: true });
  await fs
    .writeFile(path.join(project.checkpointsDir, '.gitignore'), CHECKPOINT_GITIGNORE, { encoding: 'utf8', flag: 'wx' })
    .catch(() => undefined);
}

/** 写一个对象；已经有了（大小也对得上）就不写。先写临时文件再改名。返回是不是新写的。 */
async function writeObject(project: NovelProject, sha: string, buf: Buffer): Promise<boolean> {
  const abs = objectPathOf(project, sha);
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile() && stat.size === buf.length) {
      return false;
    }
  } catch {
    // 没有：往下写。
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, buf, { flag: 'wx' });
  await fs.rename(tmp, abs);
  return true;
}

/**
 * 按那一刻起名写下清单；同一秒已经有了就加序号。先写临时文件再改名（断电时不留半份清单——半份清单读不懂，
 * 会让清理整个停下来）；改名之前看一眼那个名字没人用，绝不盖掉已有的那一份（同一进程里有锁，跨进程撞在同一秒同一个
 * 序号上的机会可以不计）。
 */
async function writeManifestUnique(project: NovelProject, at: Date, manifest: CheckpointManifest): Promise<string> {
  const dir = pointsDirOf(project);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 1), { encoding: 'utf8', flag: 'wx' });
  try {
    for (let dup = 1; dup < 1000; dup++) {
      const id = checkpointIdOf(at, dup);
      const file = path.join(dir, `${id}.json`);
      if (await exists(file)) {
        continue;
      }
      await fs.rename(tmp, file);
      return id;
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fs.unlink(tmp).catch(() => undefined);
  throw new Error('同一秒里存了太多存档点');
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}
