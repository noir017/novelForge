/**
 * Token 粗估。
 *
 * 不引入 tiktoken：一是体积大、需要 wasm，二是不同服务商分词器本就不同，
 * 精确到个位没有意义。这里只要保证「不低估」，预算里再留 512 的安全余量即可。
 *
 * 经验系数：
 * - 中日韩字符：约 1 字 ≈ 1.5 token（GPT 系分词器对中文并不友好）
 * - 拉丁字母：约 4 字符 ≈ 1 token
 * - 其余字符（标点、空白、数字）：约 3 字符 ≈ 1 token
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let cjk = 0;
  let latin = 0;
  let other = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isCjk(code)) {
      cjk++;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++;
    } else {
      other++;
    }
  }

  return Math.ceil(cjk * 1.5 + latin / 4 + other / 3);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0x3000 && code <= 0x303f) // 中日韩标点
  );
}

/** 目标 token 数对应的大致字符数（按中文为主估算），用于截断文本。 */
export function tokensToChars(tokens: number): number {
  return Math.floor(tokens / 1.5);
}

/** 从尾部截取不超过 maxTokens 的文本，并尽量从段落边界开始。 */
export function takeTail(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const chars = tokensToChars(maxTokens);
  let slice = text.slice(-chars);
  // 对齐到段落开头，避免从半句话开始。
  const paragraphBreak = slice.indexOf('\n\n');
  if (paragraphBreak !== -1 && paragraphBreak < slice.length * 0.3) {
    slice = slice.slice(paragraphBreak + 2);
  }
  return slice.trimStart();
}

/** 从头部截取不超过 maxTokens 的文本，尾部加省略标记。 */
export function takeHead(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const chars = tokensToChars(maxTokens);
  return `${text.slice(0, chars).trimEnd()}\n……（此处因上下文预算截断）`;
}
