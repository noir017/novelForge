/**
 * 历史版本：网关**覆盖一份已存在的创作产物之前**，把磁盘上的旧内容存成一个快照。
 *
 * 「不静默覆盖」（第 3 条）管的是落盘之前那一问；问过了、写下去了，作者回头发现「刚才那一版其实更好」，
 * 从前只有定稿写回细纲会在回收站里留一份旧的。这一层让**每一条走网关的覆盖**（编辑器保存、重写 / 修稿
 * 落盘、定稿写回、MCP 的 `edit`、一键排版之后的保存……）都先把旧内容留一版。
 *
 * ## 布局
 *
 * ```
 * .novelforge/history/
 * ├── .gitignore                            第一次存快照时放进来，内容 `*`（Git 默认不收；想收就删掉它，之后不再补）
 * ├── chapters/第一卷/003-深处.txt/          每份文件一个目录：原文件的相对路径（连扩展名）原样当目录名
 * │   ├── 2026-10-18_14-32-05+0800.txt      每个快照一个文件：被覆盖那一刻的本地时间与时区
 * │   └── 2026-10-18_14-32-05+0800-2.txt    同一秒里的第二个
 * └── .novelforge/summaries/第一卷/003-深处.md/
 *     └── …                                  `.novelforge/` 里的文件（细纲、角色卡、大纲……）同样镜像
 * ```
 *
 * - **一一对应、不撞车**：目录名就是原文件的相对路径（含扩展名），`003.md` 与 `003.txt` 各是各的目录。
 * - **快照一律 `.txt`，字节原样拷贝**（不转码，GBK 的旧稿存下来还是 GBK）：不是 `.md`，插件壳的
 *   `.novelforge/**\/*.md` 监听就不会每存一版多跑一轮全量重扫；内置编辑器与「文件」页照样打得开。
 * - **时间从文件名读**（带时区，换了时区也排得对），不看 mtime——拷来拷去 mtime 会变。
 *
 * ## 存不存（{@link decideSnapshot}）
 *
 * - 只管创作产物：`kindOfPath` 不是 `other` 的（章节、草稿、细纲、角色卡、设定、架构、大纲、文风、叙事线、
 *   全书摘要、技能）；还不是小说工程（没有 `.novelforge/`）的目录里不存——不替作者凭空建出一个工程目录。
 * - 新内容与旧内容一样（什么都没覆盖）、旧内容与最新一个快照一样：不存。
 * - **节流**：最新一个快照不到 {@link HISTORY_QUIET_MS}（10 分钟），而且「旧内容 ↔ 最新快照」「旧内容 ↔ 新内容」
 *   两处改动都在 {@link HISTORY_SMALL_CHANGE}（300 字）以内——不存。自动保存每两秒存一次时攒不出几百个快照；
 *   **大改总是存**：整章重写、修稿、一键排版、定稿写回，新内容和旧内容一比就超出这个数。改动按公共前后缀粗算
 *   （{@link changedChars}）。
 * - 「现在存一版」（{@link snapshotNow}）跳过节流，但和最新快照一字不差时照样不重复存。
 *
 * ## 保留
 *
 * 每份文件最多留最近 {@link HISTORY_KEEP} 个，多的删掉最旧的。**这些是网关自己存的副本，不是作者的文件**，
 * 删它们不违背第 6 条「不真删」——第 6 条护的是作者的东西（章节、角色卡、会话……），而这里删的是网关为了
 * 「找得回来」额外抄的那几份，作者自己的文件一个字节都没动。
 *
 * ## 改名 / 搬家：快照跟着走（{@link moveHistory}）
 *
 * 快照按路径存。网关 `move` 成功之后（连同它带走的草稿、细纲，以及 `writePlot` 换了文件名的细纲），快照目录挪到新路径下；
 * 新路径下已经有快照就两边合并（撞名加序号、合并完按保留上限修剪）。搬不动只记 warn，**不挡搬家、不回滚**。删除（进回收站）
 * 不搬：快照留在原路径，文件从回收站搬回原处，历史也就回来了。
 *
 * ## 绝不挡住保存
 *
 * 存快照的任何一步失败（磁盘满、`.novelforge/history` 被占成了文件、权限……）都只记一条 warn，照常写盘
 * （第 1 条：容错优先）。{@link snapshotBeforeWrite} 不抛。
 *
 * ## 不进上下文、不触发重扫
 *
 * `kindOfPath` 把这里的东西判成 `other`（装配器只按种类与固定目录读，碰不到它）；全文检索跳过它（与
 * `.trash/` 同理：搜出来的是一份旧稿）；`watchPolicy` 挡掉它的变动；`isProtectedPath` 把这个目录列为固定目录，
 * 类文件操作搬不走、删不掉它。「文件」页照常看得见、点得开。
 */
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { countWords, hash } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { NovelProject } from '../model/project';
import { MAX_EDITABLE_BYTES, WsError } from './guard';
import { kindOfPath, normalizeRel } from './kind';

const log = scoped('历史版本');

/** 每份文件最多留几个快照。 */
export const HISTORY_KEEP = 50;
/** 最新一个快照「还新」的时长：这之内的小改动不另存。 */
export const HISTORY_QUIET_MS = 10 * 60 * 1000;
/** 「小改动」的上限（字符数，按公共前后缀粗算）。 */
export const HISTORY_SMALL_CHANGE = 300;
/** 第一次存快照时放进 `.novelforge/history/` 的 `.gitignore`。 */
export const HISTORY_GITIGNORE = '*\n';

// ---------------------------------------------------------------- 纯函数

/**
 * 这份文件的快照放在哪个目录（工程内相对路径）：`.novelforge/history/<原文件的相对路径>`，扩展名原样
 * 留在目录名里。越界给 undefined。纯函数，零 I/O。
 */
export function historyDirOf(project: NovelProject, rel: string): string | undefined {
  const normalized = normalizeRel(rel);
  return normalized === undefined ? undefined : `${project.relPath(project.historyDir)}/${normalized}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * 快照的文件名：被覆盖那一刻的本地时间 + 时区，`dup > 1` 时带序号（同一秒里的第二个）。
 * 例：`2026-10-18_14-32-05+0800.txt`、`2026-10-18_14-32-05+0800-2.txt`。
 */
export function snapshotFileName(at: Date, dup = 1): string {
  const off = -at.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return `${stamp}${dup > 1 ? `-${dup}` : ''}.txt`;
}

const SNAPSHOT_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})([+-])(\d{2})(\d{2})(?:-(\d+))?\.txt$/;

/** 读快照文件名：那一刻（毫秒时间戳）与序号。不是快照的名字（作者放进来的别的文件、子目录）给 undefined。 */
export function parseSnapshotFileName(name: string): { time: number; dup: number } | undefined {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) {
    return undefined;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const time = Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000;
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return { time, dup: m[10] ? Number(m[10]) : 1 };
}

/** 快照文件名按时刻排，新的在前；不是快照的名字丢掉。 */
export function sortSnapshotNames(names: readonly string[]): string[] {
  return names
    .map((name) => ({ name, at: parseSnapshotFileName(name) }))
    .filter((x): x is { name: string; at: { time: number; dup: number } } => !!x.at)
    .sort((a, b) => b.at.time - a.at.time || b.at.dup - a.at.dup)
    .map((x) => x.name);
}

/** 超出保留数的那几个（最旧的），要删掉。 */
export function snapshotsToPrune(names: readonly string[], keep = HISTORY_KEEP): string[] {
  return sortSnapshotNames(names).slice(Math.max(0, keep));
}

/**
 * 两份文字差了多少：去掉公共前缀与公共后缀之后，剩下那段中间较长的一边有几个字符。粗算——一处改动
 * 是准的；首尾各改一处会把中间全算进去（宁可多存一版）。
 */
export function changedChars(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) {
    p++;
  }
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) {
    s++;
  }
  return Math.max(a.length, b.length) - p - s;
}

export type SnapshotSkip = 'unchanged' | 'same' | 'small';

export type SnapshotDecision =
  | { save: true; reason: 'first' | 'force' | 'quiet' | 'bigChange' }
  | { save: false; reason: SnapshotSkip };

/**
 * 存不存这一版（规则见文件头）。`old` 是磁盘上要被覆盖的内容，`next` 是要写下去的（「现在存一版」没有），
 * `latest` 是最新一个快照，`now` 是此刻。
 */
export function decideSnapshot(input: {
  old: string;
  next?: string;
  latest?: { text: string; time: number };
  now: number;
  force?: boolean;
}): SnapshotDecision {
  const { old, next, latest, now } = input;
  if (next !== undefined && hash(next) === hash(old)) {
    return { save: false, reason: 'unchanged' };
  }
  if (latest && hash(latest.text) === hash(old)) {
    return { save: false, reason: 'same' };
  }
  if (input.force) {
    return { save: true, reason: 'force' };
  }
  if (!latest) {
    return { save: true, reason: 'first' };
  }
  if (now - latest.time >= HISTORY_QUIET_MS) {
    return { save: true, reason: 'quiet' };
  }
  const drift = changedChars(latest.text, old);
  const incoming = next === undefined ? 0 : changedChars(old, next);
  if (drift <= HISTORY_SMALL_CHANGE && incoming <= HISTORY_SMALL_CHANGE) {
    return { save: false, reason: 'small' };
  }
  return { save: true, reason: 'bigChange' };
}

// ---------------------------------------------------------------- 读

export interface SnapshotInfo {
  /** 快照的文件名，也是读它、对比它时的身份。 */
  id: string;
  /** 那一刻（毫秒时间戳）：这一版在磁盘上被覆盖掉的时候。 */
  time: number;
  words: number;
  bytes: number;
}

/**
 * 这份文件能不能存历史版本。能就给 undefined，不能给一句给人看的原因（界面上禁用按钮时说的就是它）。
 * 越界、不是创作产物、还不是小说工程，都不能。
 */
export async function historyUnavailable(project: NovelProject, rel: string): Promise<string | undefined> {
  const normalized = normalizeRel(rel);
  if (normalized === undefined) {
    return `路径超出工程目录：${rel}`;
  }
  if (kindOfPath(project, normalized).kind === 'other') {
    return '这份文件不是工程里的创作产物（章节、草稿、细纲、角色卡、设定、架构、大纲、文风、叙事线……），不存历史版本。';
  }
  if (!(await isDir(project.novelDir))) {
    return '这个目录还不是小说工程（没有 .novelforge/），不存历史版本。';
  }
  return undefined;
}

/** 列出这份文件的快照，新的在前。没有就是空数组；读不动的那一个跳过，不抛。 */
export async function listSnapshots(project: NovelProject, rel: string): Promise<SnapshotInfo[]> {
  const relDir = historyDirOf(project, rel);
  if (relDir === undefined) {
    return [];
  }
  const dir = project.pathOf(relDir);
  const out: SnapshotInfo[] = [];
  for (const name of sortSnapshotNames(await snapshotNamesIn(dir))) {
    try {
      const buf = await fs.readFile(path.join(dir, name));
      out.push({ id: name, time: parseSnapshotFileName(name)!.time, words: countWords(decodeFileText(buf)), bytes: buf.length });
    } catch {
      // 列的时候刚被裁掉、或者作者手删了：跳过这一个。
    }
  }
  return out;
}

/** 读某一个快照的全文。`id` 只认快照文件名（防 `../`）；不存在抛 `WsError('notFound')`。 */
export async function readSnapshot(project: NovelProject, rel: string, id: string): Promise<string> {
  const relDir = historyDirOf(project, rel);
  if (relDir === undefined || id.includes('/') || id.includes('\\') || !parseSnapshotFileName(id)) {
    throw new WsError('notFound', `找不到这一版：${id}`);
  }
  try {
    return decodeFileText(await fs.readFile(path.join(project.pathOf(relDir), id)));
  } catch {
    throw new WsError('notFound', `找不到这一版（可能已经被裁掉了）：${id}`);
  }
}

// ---------------------------------------------------------------- 存

export interface SnapshotResult {
  /** 存下来的快照文件名。 */
  saved?: string;
  /** 为什么没存。 */
  skipped?: SnapshotSkip | 'notTracked' | 'missing' | 'tooLarge';
  /** 存的时候出错了（已经记了 warn）。 */
  error?: string;
}

/**
 * 网关覆盖 `rel` 之前调：磁盘上那份旧内容该存就存一版（规则见文件头）。`next` 是马上要写下去的内容。
 * **绝不抛**：任何一步失败都只记 warn，调用方照常写盘。
 */
export async function snapshotBeforeWrite(
  project: NovelProject,
  rel: string,
  next: string | undefined,
  opts: { force?: boolean; now?: number } = {}
): Promise<SnapshotResult> {
  try {
    return await snapshot(project, rel, next, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`没能给 ${rel} 存历史版本，照常写盘`, message);
    return { error: message };
  }
}

/** 「现在存一版」：把**磁盘上当前**这份强制存一个快照（跳过节流；与最新快照一字不差时不重复存）。 */
export function snapshotNow(project: NovelProject, rel: string): Promise<SnapshotResult> {
  return snapshotBeforeWrite(project, rel, undefined, { force: true });
}

async function snapshot(
  project: NovelProject,
  rel: string,
  next: string | undefined,
  opts: { force?: boolean; now?: number }
): Promise<SnapshotResult> {
  const normalized = normalizeRel(rel);
  if (normalized === undefined || kindOfPath(project, normalized).kind === 'other') {
    return { skipped: 'notTracked' };
  }
  if (!(await isDir(project.novelDir))) {
    return { skipped: 'notTracked' };
  }
  const abs = project.pathOf(normalized);
  let buf: Buffer;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { skipped: 'missing' };
    }
    if (stat.size > MAX_EDITABLE_BYTES) {
      return { skipped: 'tooLarge' };
    }
    buf = await fs.readFile(abs);
  } catch {
    return { skipped: 'missing' };
  }
  const old = decodeFileText(buf);

  const dir = project.pathOf(historyDirOf(project, normalized)!);
  const names = sortSnapshotNames(await snapshotNamesIn(dir));
  let latest: { text: string; time: number } | undefined;
  if (names[0]) {
    try {
      latest = { text: decodeFileText(await fs.readFile(path.join(dir, names[0]))), time: parseSnapshotFileName(names[0])!.time };
    } catch {
      latest = undefined;
    }
  }

  const now = opts.now ?? Date.now();
  const decision = decideSnapshot({ old, next, latest, now, force: opts.force });
  if (!decision.save) {
    return { skipped: decision.reason };
  }

  await ensureHistoryRoot(project);
  await fs.mkdir(dir, { recursive: true });
  const name = await writeUnique(dir, new Date(now), buf);
  log.debug(`存了一版 ${normalized}`, `${name}｜${buf.length} 字节｜${decision.reason}`);

  const pruned = snapshotsToPrune([name, ...names]);
  for (const stale of pruned) {
    await fs.unlink(path.join(dir, stale)).catch(() => undefined);
  }
  if (pruned.length > 0) {
    log.debug(`裁掉 ${normalized} 最旧的 ${pruned.length} 个历史版本`, `只留最近 ${HISTORY_KEEP} 个`);
  }
  return { saved: name };
}

// ---------------------------------------------------------------- 搬

/**
 * 网关把 `from` 搬到了 `to`（一份文件或整个目录，`move` 本身与它连带搬走的草稿、细纲）之后，把快照目录也搬过去：
 * 在新路径上打开「历史」面板，看得到改名之前存的那几版。目录搬的是整棵——分卷目录改名，下面每份文件的快照都跟着走。
 *
 * - 新路径下还没有快照目录：整个挪过去。
 * - 已经有（以前那里有过同名文件，或者从回收站搬回来过）：两边合并。撞了名的按 {@link writeUnique} 的规矩加序号
 *   （同一刻、序号往上加，绝不盖掉已有的那一个），合并完的那几个目录按 {@link HISTORY_KEEP} 修剪。
 * - 搬不动（新位置被一个文件占了、磁盘满、权限……）：只记一条 warn，**绝不抛**——搬家已经成了，不能因为几份副本
 *   让它失败或回滚，与「存快照失败不挡保存」同一个口径。没搬过去的留在旧路径下，一个不丢。
 *
 * 删除（进回收站）不调它：快照留在原路径，作者从回收站把文件搬回原处，历史也就回来了。
 * 返回补进 `side` 的说明（没有快照目录时空数组）。
 */
export async function moveHistory(project: NovelProject, from: string, to: string): Promise<string[]> {
  try {
    return await carryHistory(project, from, to);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`没能把 ${from} 的历史版本搬到 ${to}，搬家照常`, `没搬过去的快照留在旧路径下｜${message}`);
    return [`历史版本没能跟过去，没搬过去的留在 ${from} 的旧路径下`];
  }
}

async function carryHistory(project: NovelProject, from: string, to: string): Promise<string[]> {
  const fromRel = normalizeRel(from);
  const toRel = normalizeRel(to);
  if (fromRel === undefined || toRel === undefined || fromRel === toRel) {
    return [];
  }
  // 历史目录里的东西本身不存历史（`kindOfPath` 判 `other`）；搬进、搬出它都不该再套一层 `history/.novelforge/history/…`。
  const root = project.relPath(project.historyDir);
  if ([fromRel, toRel].some((r) => r === root || r.startsWith(`${root}/`))) {
    return [];
  }
  const src = project.pathOf(historyDirOf(project, fromRel)!);
  if (!(await isDir(src))) {
    return [];
  }
  const dst = project.pathOf(historyDirOf(project, toRel)!);
  const there = await statOf(dst);
  if (!there) {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    log.debug(`历史版本跟着搬了`, `${fromRel} → ${toRel}`);
    return [`历史版本 ${fromRel} → ${toRel}`];
  }
  if (!there.isDirectory()) {
    throw new Error(`新路径的快照目录被一个文件占了：${project.relPath(dst)}`);
  }
  const renamed = await mergeHistoryDir(src, dst);
  log.debug(`历史版本跟着搬了，与新路径下原有的合并`, `${fromRel} → ${toRel}｜撞名加序号 ${renamed} 个`);
  return [`历史版本 ${fromRel} → ${toRel}（与那里原有的合并）`];
}

/**
 * 把快照目录 `src` 并进 `dst`（两边都是目录），返回撞了名、加了序号的有几个。子目录递归（整个分卷的快照），文件一个一个
 * 拷过去再删源（拷用 `COPYFILE_EXCL`：绝不盖掉 `dst` 里已有的那一个）。并进了文件的目录按保留上限修剪；`src` 搬空了就删掉
 * （只删空目录，那是网关自己建的）。
 */
async function mergeHistoryDir(src: string, dst: string): Promise<number> {
  let renamed = 0;
  let received = false;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const into = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const there = await statOf(into);
      if (!there) {
        await fs.rename(from, into);
      } else if (there.isDirectory()) {
        renamed += await mergeHistoryDir(from, into);
      } else {
        throw new Error(`快照目录被一个文件占了：${into}`);
      }
      continue;
    }
    const name = await copyUnique(from, dst, entry.name);
    await fs.unlink(from);
    received = true;
    if (name !== entry.name) {
      renamed++;
    }
  }
  if (received) {
    const names = await snapshotNamesIn(dst);
    for (const stale of snapshotsToPrune(names)) {
      await fs.unlink(path.join(dst, stale)).catch(() => undefined);
    }
  }
  await fs.rmdir(src).catch(() => undefined);
  return renamed;
}

/**
 * 把 `file` 拷进 `dir`，名字撞了就加序号：快照名去掉原有的序号、从 2 往上加（与 {@link writeUnique} 同一个规矩，那一刻与时区
 * 原样留着）；不是快照的名字（作者放进来的别的文件）在扩展名前加 `-2`、`-3`。返回落下的名字。
 */
async function copyUnique(file: string, dir: string, name: string): Promise<string> {
  const snap = SNAPSHOT_RE.test(name);
  const ext = snap ? '.txt' : path.extname(name);
  const stem = snap ? name.replace(/(?:-\d+)?\.txt$/, '') : name.slice(0, name.length - ext.length);
  for (let dup = 1; dup < 1000; dup++) {
    const candidate = dup === 1 ? name : `${stem}-${dup}${ext}`;
    try {
      await fs.copyFile(file, path.join(dir, candidate), fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error(`${name} 撞名太多`);
}

async function statOf(abs: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(abs);
  } catch {
    return undefined;
  }
}

/**
 * 历史根第一次出现时顺手放一个 `.gitignore`（`*`）。只在**建出这个目录**的那一次放：作者删掉它就是想让
 * Git 收这些快照，之后不再补回来。
 */
async function ensureHistoryRoot(project: NovelProject): Promise<void> {
  if (await isDir(project.historyDir)) {
    return;
  }
  await fs.mkdir(project.historyDir, { recursive: true });
  await fs.writeFile(path.join(project.historyDir, '.gitignore'), HISTORY_GITIGNORE, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
}

/** 按此刻起名写下去；同一秒已经有了就加序号。`wx`：绝不盖掉已有的那一个。 */
async function writeUnique(dir: string, at: Date, bytes: Buffer): Promise<string> {
  for (let dup = 1; dup < 1000; dup++) {
    const name = snapshotFileName(at, dup);
    try {
      await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' });
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error('同一秒里存了太多版');
}

async function snapshotNamesIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}
