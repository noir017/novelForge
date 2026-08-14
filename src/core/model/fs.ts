import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function hash(text: string): string {
  return crypto.createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** 中文按字符计，英文按词计，粗略但稳定。 */
export function countWords(text: string): number {
  const stripped = text.replace(/\s+/g, '');
  const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9']+/g) ?? []).length;
  return cjk + words;
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || '未命名'
  );
}

/** 从角色名生成 slug：ASCII 转小写连字符，中文保留。 */
export function slugify(name: string): string {
  return sanitizeFileName(name).toLowerCase() || 'unnamed';
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

/**
 * 读一个**可能不存在**的文件：读不到就给 undefined，不抛。
 *
 * 取代 `exists()` + `readText()` 两步走：那样每个文件要两次系统调用（工程页
 * 刷新时每章的细纲与摘要各占一次多余的 stat），而且中间那一瞬文件被删掉的话
 * 仍然会抛——作者随时在手改文件，这条竞态是真的会发生的。
 *
 * 「读不到」包含三种：不存在（ENOENT）、路径中间那一段不是目录（ENOTDIR）、
 * 目标本身是个目录（EISDIR）。对调用方它们是同一件事——**这一章没有这份产物**，
 * 而作者手里真的可能出现一个叫 `001-楔子.md` 的目录。其余错误（权限、编码）
 * 照常上抛：那些是调用方该知道的事，不该被悄悄当成「没有」。
 */
export async function readTextIfExists(absPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return undefined;
    }
    throw err;
  }
}

export async function writeText(absPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, text, 'utf8');
}

/** 扫描时跳过的目录名。 */
export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** 在某个区目录下找一个没被占用的 slug。slug 可以带子目录前缀。 */
export async function uniqueSlug(dirAbs: string, base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await exists(path.join(dirAbs, `${slug}.md`))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}
