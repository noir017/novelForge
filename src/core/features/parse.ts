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

/**
 * 去掉 `]` / `}` 前面多出来的逗号（`["甲", "乙",]`）。模型最常见的 JSON 语法错就是这一个，
 * 它不改任何值，可以放心地自己修，不必为它再调一次模型。字符串里的逗号不动。
 */
export function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === ',') {
      const rest = json.slice(i + 1).trimStart();
      if (rest.startsWith(']') || rest.startsWith('}')) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * 模型交回来的 JSON 里取那一组：`{"threads":[…]}` / `{"events":[…]}` / `{"conflicts":[…]}`，也认上游的
 * `{"candidates":[…]}` 与直接一个数组。解不出返回 undefined。
 *
 * 从前放在 features/threads.ts（七期排线与判事件用），写前冲突检查（features/plotCheck.ts）也借它；
 * 叙事线重做之后那一份要整个换掉，宽松取一组 JSON 这件事本来就属于这里。
 */
export function jsonList(raw: string, key: string): unknown[] | undefined {
  const text = stripCodeFence(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const inner = extractJson(text);
    try {
      value = inner ? JSON.parse(inner) : undefined;
    } catch {
      value = undefined;
    }
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const list = o[key] ?? o.candidates;
    return Array.isArray(list) ? list : undefined;
  }
  return undefined;
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
