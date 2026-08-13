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
