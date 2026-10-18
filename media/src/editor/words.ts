/**
 * 字数统计。**与 view.js 的同名函数口径不同，别合并。**
 *
 * 这里的 `countWords` 与 core 的一致（`src/core/model/fs.ts`）：中文按字（基本区与扩展 A 区的汉字）、
 * 英文按词（连着的 `A-Z a-z 0-9 '` 算一个）、标点与空白不算——编辑器状态栏上的「N 字」要与工程页上
 * 后端算出来的章节字数对得上，两个数字不一样会让人以为有内容没保存。view.js 那边统计的是模型回复的
 * 长度（去空白后的字符数），是另一件事。
 *
 * 写法与 core 不同、结果一字不差（`tests/unit/editor/writingStats.test.js` 拿 core 那一份对拍）：core 用
 * 正则先去空白、再把每个汉字 match 成一个数组；这里一趟循环数完，不造中间字符串与数组——编辑器每敲一下
 * 都可能要数一遍几万字（见 `stats.ts`），快三倍左右。
 */

/** 这个 UTF-16 码元是不是算字的汉字（与 core 的 `[一-鿿㐀-䶿]` 同一个范围）。 */
export function isCjkCode(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/** 这个码元是不是英文词里的字符（与 core 的 `[A-Za-z0-9']` 同一个范围）。 */
export function isWordCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x27 // '
  );
}

export function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isWordCode(code)) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else {
      inWord = false;
      if (isCjkCode(code)) {
        n++;
      }
    }
  }
  return n;
}

export function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(2)} 万字` : `${n} 字`;
}

/** 千分位：3120 → 「3,120」。负数带负号。 */
export function groupDigits(n: number): string {
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${s}` : s;
}
