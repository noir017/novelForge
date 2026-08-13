import { sanitizeAliases } from './naming';
import { SummaryCast } from './types';

/**
 * `林昭(阿昭、昭儿)` ←→ `{ name: '林昭', aliases: ['阿昭', '昭儿'] }`。
 *
 * 用括号而不是嵌套 YAML：本项目的 frontmatter 解析器（model/markdown.ts）
 * 刻意只支持字符串与字符串数组，为了一个字段引入真正的 YAML 依赖不值得。
 * 括号形式作者也能一眼看懂、直接手改。
 */
export function renderCastEntry(entry: SummaryCast): string {
  const aliases = entry.aliases.filter((a) => a.trim() && a.trim() !== entry.name);
  return aliases.length > 0 ? `${entry.name}(${aliases.join('、')})` : entry.name;
}

export function parseCastEntry(raw: string): SummaryCast | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  // 全角括号也认——作者手改时很可能打出中文括号。
  const m = /^(.*?)[（(]([^）)]*)[）)]\s*$/.exec(text);
  if (!m) {
    return { name: text, aliases: [] };
  }
  const name = m[1].trim();
  if (!name) {
    return { name: text, aliases: [] };
  }
  return {
    name,
    aliases: m[2]
      .split(/[、,，/]/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * frontmatter 的 `cast` 字段 → 结构化清单。
 * 字段**缺席**返回 undefined（调用方据此决定回退解析小节文本）；
 * 字段存在但为空数组返回 `[]`——那是「这一章确实没人出场」，不该回退。
 */
export function parseCast(v: string | string[] | undefined): SummaryCast[] | undefined {
  if (v === undefined) {
    return undefined;
  }
  const list = Array.isArray(v) ? v : [v];
  const out: SummaryCast[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const entry = parseCastEntry(raw);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 从「出场人物」小节的文本回退解析，如 `林昭、沈氏、客栈掌柜`。
 *
 * 用于 0.2.x 之前生成的摘要与作者手写的摘要——这些文件没有 cast 字段，
 * 但角色页上不该因此凭空少一批人。允许列表写法（`- 林昭`）与顿号分隔混用。
 *
 * 难点在于模型有时把这一节写成句子（「本章没有新人物出场，只有林昭独坐」）。
 * 那种东西按标点切开会得到一串假人名，全都会跑到角色页的「未建卡」组里。
 * 两条判据挡住它：**长度**（中文人名/称呼极少超过 8 字）与**句子特征词**
 * （人名里不会有「的」「了」「没」这类虚词）。宁可漏掉一两个长称呼，
 * 也不能让角色页塞满句子碎片——漏掉的那个重新生成摘要就有了（新摘要走
 * 结构化 cast，根本不经过这里）。
 */
export function castFromText(text: string): SummaryCast[] {
  const out: SummaryCast[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*·]\s*/, '').trim();
    if (!cleaned) {
      continue;
    }
    for (const part of cleaned.split(/[、,，;；]/)) {
      const entry = parseCastEntry(part);
      if (!entry?.name || !isPlausibleName(entry.name)) {
        continue;
      }
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        // 别名同样要过泛称关：这条回退路径产出的 cast 与 JSON 路径的一样，
        // 会被 identity.ts 拿去判断「谁是谁」。
        out.push({ name: entry.name, aliases: sanitizeAliases(entry.aliases, entry.name) });
      }
    }
  }
  return out;
}

/** 人名/称呼里不会出现的虚词。命中即判定为句子碎片。 */
const SENTENCE_MARKERS = /[的了是在不没有和与也都而被把从向对为及则却就还很]/;

function isPlausibleName(name: string): boolean {
  if (name.length === 0 || name.length > 8) {
    return false;
  }
  // 「无」「暂无」这类占位不是人名。
  if (/^(无|暂无|没有|未知|none|n\/a)$/i.test(name)) {
    return false;
  }
  return !SENTENCE_MARKERS.test(name);
}
