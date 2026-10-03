/**
 * 拆书两条路共用的取书：挑工程里的哪一本 txt、读出来、解码（导入原稿 features/importManuscript.ts、
 * 从参考书学写法 features/reference.ts）。
 *
 * 作者亲手点的入口可以选**本机任意一本**（`Host.pickHostFile`，没有这个能力的宿主退回工程里的清单）；
 * MCP 的 `book` 工具只认工程里的相对路径——外部 agent 不读工程外的文件。一整本书常常超过网关的 2 MiB
 * 编辑上限（第 7 条那一层是给编辑器与模型上下文的），这里另有一道 {@link MAX_IMPORT_BYTES}：只读、只解码，
 * 不进编辑器，也不整份进上下文，更不写回原处。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import { TextEncodingName, decodeTextBytes } from '../model/importText';
import { normalizeRel } from '../workspace/kind';
import { resolveInRoot } from '../workspace/guard';

/** 一整本最多多大。上游是 128 MB；三百万字的中文 txt 也就十来 MB。 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export interface BookText {
  /** 给作者看的路径：工程里的写相对路径，工程外的写绝对路径。 */
  shown: string;
  /** 书名：文件名去掉扩展名。 */
  title: string;
  text: string;
  encoding: TextEncodingName;
  bytes: number;
}

/**
 * 挑一本。返回工程内的相对路径，或（作者在本机选的）绝对路径，交给 {@link readBookText}。
 *
 * - 给了 `relPath`（MCP 的 `book` 工具）：只认工程里能拆的 txt（`NovelProject.listImportableTexts`，
 *   章节文件、草稿与隐藏目录除外）——不让它拿章节文件或工程外的路径来拆。
 * - 宿主能选本机文件：直接开选择器，从工程根起步。
 * - 否则从工程里的 txt 挑；一本都没有就说清楚该把 txt 放在哪，返回 undefined。
 */
export async function pickBookText(project: NovelProject, title: string, relPath?: string): Promise<string | undefined> {
  const host = getHost();
  if (relPath === undefined && host.pickHostFile) {
    return host.pickHostFile({ title, extensions: ['txt'], startDir: project.root });
  }
  const files = await project.listImportableTexts();
  if (relPath !== undefined) {
    const rel = normalizeRel(relPath);
    if (!rel || !files.some((f) => f.relPath === rel)) {
      throw new Error(`${relPath} 不是工程里能拆的 txt：要是 .txt、在工程目录里（不在隐藏目录里），也不能是章节文件。`);
    }
    return rel;
  }
  if (files.length === 0) {
    getHost().toast(
      `工程里还没有 txt。把整本 txt 放进工程目录（不要放进隐藏目录，也不要起数字开头的名字放进 ${project.config.chaptersDir}/），再来一次。`,
      'error'
    );
    return undefined;
  }
  return getHost().pick(
    files.map((f) => ({
      label: path.posix.basename(f.relPath),
      description: path.posix.dirname(f.relPath) === '.' ? '工程根目录' : path.posix.dirname(f.relPath),
      detail: formatBytes(f.bytes),
      value: f.relPath,
    })),
    title
  );
}

/**
 * 读一本、解码。`where` 是 {@link pickBookText} 给的：绝对路径照读，相对路径过 `resolveInRoot`
 * （越界一律拒绝）。超过 {@link MAX_IMPORT_BYTES}、不是文件、读不到都抛（话直接进 toast）。
 */
export async function readBookText(project: NovelProject, where: string): Promise<BookText> {
  const abs = path.isAbsolute(where) ? path.resolve(where) : resolveInRoot(project.root, where);
  const inside = path.relative(project.root, abs);
  const shown = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside.split(path.sep).join('/') : abs;
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`读不到 ${shown}。`);
  }
  if (!stat.isFile()) {
    throw new Error(`${shown} 不是文件。`);
  }
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new Error(`${shown} 有 ${formatBytes(stat.size)}，超过 ${formatBytes(MAX_IMPORT_BYTES)}，不读。`);
  }
  const { text, encoding } = decodeTextBytes(new Uint8Array(await fs.readFile(abs)));
  return { shown, title: path.basename(abs, path.extname(abs)), text, encoding, bytes: stat.size };
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 「12.3 万字」或「3200 字」。 */
export function formatWordCount(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`;
}
