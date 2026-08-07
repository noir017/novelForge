/**
 * 轻量 Markdown 结构工具：YAML frontmatter 与「## 小节」的解析/序列化。
 *
 * 这里刻意不引入 yaml 依赖：frontmatter 只支持 `key: value` 与
 * `key: [a, b]` / `key:\n  - a\n  - b` 两种数组写法，足够角色卡使用，
 * 且解析失败时退化为忽略该行而不是抛错——作者手改文件不该让插件崩掉。
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdown(text: string): ParsedMarkdown {
  const normalized = text.replace(/^﻿/, '');
  const match = FM_FENCE.exec(normalized);
  if (!match) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: normalized.slice(match[0].length).trim(),
  };
}

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    // 缩进的 `- item` 归属于上一个键。
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      const arr = result[currentListKey];
      const value = stripQuotes(listItem[1].trim());
      if (Array.isArray(arr)) {
        arr.push(value);
      } else {
        result[currentListKey] = [value];
      }
      continue;
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    const rawValue = kv[2].trim();

    if (rawValue === '') {
      // 可能是块状数组的起始，先占位为空数组。
      result[key] = [];
      currentListKey = key;
      continue;
    }

    currentListKey = null;
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      result[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      result[key] = stripQuotes(rawValue);
    }
  }
  return result;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export function stringifyFrontmatter(data: Record<string, string | number | string[] | undefined>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => quoteIfNeeded(v)).join(', ')}]`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  return /[:#\[\]{},]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

/**
 * 把正文按 `## 小节名` 切开。返回小节名 → 内容（不含标题行，已 trim）。
 * `##` 之前的前言内容放在 key `''` 下。
 */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current = '';
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (current !== '' || content !== '') {
      const existing = sections.get(current);
      sections.set(current, existing ? `${existing}\n${content}` : content);
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].replace(/[:：]\s*$/, '').trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 按给定键顺序抽取小节，缺失的填空串。
 * 小节名匹配时忽略空白与常见标点差异（如「语言习惯」/「语言 习惯」）。
 */
export function pickSections<K extends string>(body: string, keys: readonly K[]): Record<K, string> {
  const found = splitSections(body);
  const normalizedIndex = new Map<string, string>();
  for (const [name, content] of found) {
    normalizedIndex.set(normalizeKey(name), content);
  }

  const result = {} as Record<K, string>;
  for (const key of keys) {
    result[key] = normalizedIndex.get(normalizeKey(key)) ?? '';
  }
  return result;
}

function normalizeKey(s: string): string {
  return s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase();
}

/**
 * 空小节的占位文字。
 *
 * `keepEmpty` 写出的摘要里，没内容的小节仍会留一个 `## 小节名` + 这行字——
 * 文件结构保持完整，作者手改时知道该往哪填。读回来的一侧要认得它：
 * 展示摘要时六个小节全是「（待补充）」不如干脆不显示。
 */
export const SECTION_PLACEHOLDER = '（待补充）';

/** 把小节 Record 序列化回 `## 小节名` 形式，跳过空小节。 */
export function stringifySections(
  sections: Record<string, string>,
  keys: readonly string[],
  opts: { keepEmpty?: boolean } = {}
): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = (sections[key] ?? '').trim();
    if (!value && !opts.keepEmpty) {
      continue;
    }
    parts.push(`## ${key}\n\n${value || SECTION_PLACEHOLDER}`);
  }
  return parts.join('\n\n');
}

/**
 * 取正文**首行**的 `# 标题`，首行不是标题则返回 undefined。
 *
 * 刻意只看首行，与 stripH1 互为逆运算。早先这里带 `m` 标志扫全文，
 * 于是正文中段任何一行 `# xxx` 都会被当成标题——但 stripH1 只剥开头那行，
 * 结果是标题取自正文中段、那行却还留在正文里。章节可以是 .txt 之后，
 * 「正文里出现一行以 # 开头的字」不再是稀罕事，这个不对称必须堵上。
 */
export function extractH1(body: string): string | undefined {
  const m = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  return m ? m[1].trim() : undefined;
}

/** 去掉正文开头的 `# 标题` 行，返回纯正文。 */
export function stripH1(body: string): string {
  return body.replace(/^#\s+.+?(\r?\n|$)/, '').trim();
}
