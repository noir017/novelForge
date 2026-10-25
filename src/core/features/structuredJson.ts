/**
 * 结构化输出的 JSON 小工具：整段或「唯一一个完整对象」取 JSON、认出「看起来是 JSON 却解析不了」的输出，以及转写
 * （2026-10-25 起，features/transcribe.ts）要的两样：原文写「无」的换空、转写的每段文字都得出自原文。
 *
 * **纯函数、绝不抛**。「唯一一个完整对象」移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的
 * `commands/architecture.command.ts` 的 `extractSingleCompleteJsonObject`。从前这里还有语法修复的证据校验（修过的那份只许
 * 改标点）；语法修复整个换成了转写——转写顺带把语法理顺，「只许照抄」由 `unfaithfulStrings` 查。
 */
import { stripCodeFence } from './parse';

/**
 * 输出看起来是 JSON（剥掉围栏后以 `{` 或 `[` 开头）却解析不了：转写照样转它（顺带理顺语法），不按「不像这一步的输出」
 * 跳过（features/transcribe.ts）。
 */
export function isRepairableJsonSyntax(content: string): boolean {
  const candidate = stripCodeFence(content);
  if (!/^[{[]/.test(candidate)) {
    return false;
  }
  try {
    JSON.parse(candidate);
    return false;
  } catch {
    return true;
  }
}

/** 解析整段输出（剥掉围栏）。失败返回 undefined。 */
export function parseJson(content: string): unknown {
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    return undefined;
  }
}

/** 从 `start` 那个 `{` 起，找到与它配对的 `}`；字符串里的括号不算。找不到返回 undefined。 */
function completeObjectEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
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
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

export type SingleObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'none' | 'truncated' | 'multiple' };

/**
 * 输出里**唯一一个**完整的顶层 JSON 对象。
 *
 * 比「第一个 `{` 到最后一个 `}`」严：模型先吐一个示例对象、再吐真正的那个时，
 * 宽松的抠法会把两者连成一段非法 JSON，或者更糟——拿到那个示例。有两个完整对象
 * 就说不清哪个是答案，报 `multiple`；最后一个没闭合，报 `truncated`。
 */
export function singleJsonObject(content: string): SingleObjectResult {
  const source = stripCodeFence(content);
  const found: Record<string, unknown>[] = [];
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf('{', from);
    if (start === -1) {
      break;
    }
    const end = completeObjectEnd(source, start);
    if (end === undefined) {
      return found.length > 0 ? { ok: true, value: found[0] } : { ok: false, reason: 'truncated' };
    }
    try {
      const value: unknown = JSON.parse(source.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        found.push(value as Record<string, unknown>);
      }
    } catch {
      // 坏掉的片段不修也不收，接着往后找。
    }
    from = end + 1;
  }
  if (found.length === 1) {
    return { ok: true, value: found[0] };
  }
  return { ok: false, reason: found.length > 1 ? 'multiple' : 'none' };
}

// ---------------------------------------------------------------- 转写（2026-10-25 细纲试点）

/** 整段是 JSON 就取它，否则取「唯一一个完整对象」（{@link singleJsonObject}）；都不是返回 undefined。 */
export function jsonValueOf(content: string): unknown {
  const whole = parseJson(content);
  if (whole !== undefined) {
    return whole;
  }
  const single = singleJsonObject(content);
  return single.ok ? single.value : undefined;
}

/** 原文里「哪一节没有内容就写『无』」，转写模型偶尔照抄成 `"无"`：文字换成空的，列表里的去掉。 */
const NONE = /^[（(]?\s*无\s*[)）]?[。.]?$/u;

export function withoutNone(value: unknown): unknown {
  if (typeof value === 'string') {
    return NONE.test(value.trim()) ? '' : value;
  }
  if (Array.isArray(value)) {
    return value.filter((x) => !(typeof x === 'string' && NONE.test(x.trim()))).map(withoutNone);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNone(v)]));
  }
  return value;
}

/** 比对用的样子：去掉空白、标点与符号。 */
function bare(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 原文是一段坏了语法的 JSON 时，里面的 `\n`、`\"`、`一` 还是转义的样子；还原了再比，不然多出一个 `n`。 */
function unescapeJson(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\[nrtbf]/g, ' ')
    .replace(/\\(["\\/])/g, '$1');
}

/**
 * 转写有没有照抄：JSON 里每一段文字都得在原文里找得到，交回找不到的那几段（最多 `limit` 段，截到 30 字，给说明与
 * 重转那一次用）。
 *
 * 比对之前两边都去掉空白、标点与符号：去掉行首的「-」、把两行并成一条、拆成两条、换个引号都不算改；改了一个字、
 * 补了原文没有的一句就找不到。`skip` 里那几个键的值是按对应关系填的（章号、推进 / 埋、主角 / 反派……），不比；
 * 数组里的文字跟着数组所在的键。
 */
export function unfaithfulStrings(source: string, value: unknown, skip: ReadonlySet<string>, limit = 3): string[] {
  const hay = bare(unescapeJson(source));
  const off: string[] = [];
  const walk = (v: unknown, key: string | undefined): void => {
    if (off.length >= limit || (key !== undefined && skip.has(key))) {
      return;
    }
    if (typeof v === 'string') {
      const needle = bare(v);
      if (needle && !hay.includes(needle)) {
        off.push(Array.from(v.trim()).length > 30 ? `${Array.from(v.trim()).slice(0, 30).join('')}…` : v.trim());
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        walk(x, k);
      }
    }
  };
  walk(value, undefined);
  return off;
}
