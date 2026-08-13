/** 剥掉包住整段模型输出的 Markdown 代码围栏，并清理首尾空白。 */
export function stripCodeFence(text: string): string {
  const m = /^\s*```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

/** 从可能夹杂废话的文本里抠出最外层 JSON 对象。 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

/** 从可能夹杂废话的文本里抠出最外层 JSON 数组。 */
export function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

/** 从文本中抠出最先出现的 JSON 对象或数组。 */
export function extractJson(text: string): string | undefined {
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  const starts = [arrayStart, objectStart].filter((n) => n >= 0);
  if (starts.length === 0) {
    return undefined;
  }
  const start = Math.min(...starts);
  const end = text[start] === '[' ? text.lastIndexOf(']') : text.lastIndexOf('}');
  return end > start ? text.slice(start, end + 1) : undefined;
}

/** 清理字符串并按首次出现顺序去重。 */
export function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 数字去重并升序排列。 */
export function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 把模型常见的字符串数组或分隔字符串归一成字符串数组。 */
export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
