/**
 * 拆书两条路共用的取书：挑工程里的哪一本 txt、读出来、解码（导入原稿 features/importManuscript.ts、
 * 从参考书学写法 features/reference.ts）。
 *
 * **只读工程里的文件**（作者拍板：txt 放进工程里读，不加读工程外文件的宿主能力）。一整本书常常超过
 * 网关的 2 MiB 编辑上限（第 7 条那一层是给编辑器与模型上下文的），这里另有一道 {@link MAX_IMPORT_BYTES}：
 * 只读、只解码，不进编辑器，也不整份进上下文。路径仍过 `resolveInRoot`（越界一律拒绝）。
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
  relPath: string;
  /** 书名：文件名去掉扩展名。 */
  title: string;
  text: string;
  encoding: TextEncodingName;
  bytes: number;
}

/**
 * 挑一本：工程里的 `.txt`（章节文件、草稿与隐藏目录除外，`NovelProject.listImportableTexts`）。
 *
 * 给了 `relPath`（agent 的 `run`）就只认这张清单里的——不让它拿章节文件或工程外的路径来拆。
 * 没有可挑的就说清楚该把 txt 放在哪，返回 undefined。
 */
export async function pickBookText(project: NovelProject, title: string, relPath?: string): Promise<string | undefined> {
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

/** 读一本、解码。超过 {@link MAX_IMPORT_BYTES}、不在工程里、读不到都抛（话直接进 toast）。 */
export async function readBookText(project: NovelProject, relPath: string): Promise<BookText> {
  const abs = resolveInRoot(project.root, relPath);
  let size: number;
  try {
    size = (await fs.stat(abs)).size;
  } catch {
    throw new Error(`读不到 ${relPath}。`);
  }
  if (size > MAX_IMPORT_BYTES) {
    throw new Error(`${relPath} 有 ${formatBytes(size)}，超过 ${formatBytes(MAX_IMPORT_BYTES)}，不读。`);
  }
  const { text, encoding } = decodeTextBytes(new Uint8Array(await fs.readFile(abs)));
  return { relPath, title: path.posix.basename(relPath, path.posix.extname(relPath)), text, encoding, bytes: size };
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 「12.3 万字」或「3200 字」。 */
export function formatWordCount(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`;
}
