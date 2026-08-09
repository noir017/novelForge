/**
 * 字数统计。**与 view.js 的同名函数口径不同，别合并。**
 *
 * 这里的 `countWords` 与 core 的一致：中文按字、英文按词——编辑器状态栏上的
 * 「N 字」要与工程页上后端算出来的章节字数对得上，两个数字不一样会让人以为
 * 有内容没保存。view.js 那边统计的是模型回复的长度（去空白后的字符数），
 * 是另一件事。
 */

export function countWords(text: string): number {
  const stripped = text.replace(/\s+/g, '');
  const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9']+/g) || []).length;
  return cjk + words;
}

export function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(2)} 万字` : `${n} 字`;
}
