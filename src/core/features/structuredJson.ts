/**
 * 结构化输出的 JSON 工具：认出「语法坏了但值得修」的输出，以及校验修过的那份
 * **只改了标点**。
 *
 * **纯函数、绝不抛**。移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的
 * `src/services/workflows/structured-syntax-repair.ts` 与
 * `commands/architecture.command.ts` 的 `extractSingleCompleteJsonObject`。
 *
 * ## 为什么修复要受这么严的约束
 *
 * 让模型「修一下这段 JSON」时，它很乐意顺手把第 3 章的关键事件改写一遍，或者把
 * 截断处缺的那两章补出来——那不是修复，是**不经作者过目的第二次生成**，而且补出来
 * 的章没有经过装配器，看不到前后文。所以修过的那份必须与原稿**逐个标量一致**，
 * 容器只允许在末尾补闭合括号，或者在最后一个值后面那一串收尾括号上多删少补（复跑之后：
 * 模型在结尾多写了一个 `]`）；多一个字、少一个字都拒收，交给拆半重试去处理。
 */
import { stripCodeFence } from './parse';

/**
 * 输出看起来是 JSON（剥掉围栏后以 `{` 或 `[` 开头）却解析不了——这种才值得花一次
 * 调用去修。开头就是一段话的，是模型没听懂格式要求，修标点救不回来。
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

interface LexicalEvidence {
  scalars: string[];
  containers: string;
  /** 标量与容器括号按出现的先后排在一起（括号是单个字符的那一项）：比「最后一个标量之前」那一截用。 */
  tokens: string[];
}

/** 按 JSON 的词法把一段文本拆成标量序列与容器括号序列。认不出的字符返回 undefined。 */
function lexicalEvidence(source: string): LexicalEvidence | undefined {
  const scalars: string[] = [];
  const tokens: string[] = [];
  let containers = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch) || ch === ',' || ch === ':') {
      i++;
      continue;
    }
    if ('{}[]'.includes(ch)) {
      containers += ch;
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let escaped = false;
      let closed = false;
      while (i < source.length) {
        const cur = source[i];
        if (!escaped && cur === '"') {
          i++;
          closed = true;
          break;
        }
        if (!escaped && cur.charCodeAt(0) < 0x20) {
          return undefined;
        }
        escaped = escaped ? false : cur === '\\';
        i++;
      }
      if (!closed) {
        return undefined;
      }
      try {
        scalars.push(`s:${JSON.stringify(JSON.parse(source.slice(start, i)))}`);
      } catch {
        return undefined;
      }
      tokens.push(scalars[scalars.length - 1]);
      continue;
    }
    const rest = source.slice(i);
    const literal = /^(?:true|false|null)/.exec(rest)?.[0];
    if (literal) {
      scalars.push(`l:${literal}`);
      tokens.push(scalars[scalars.length - 1]);
      i += literal.length;
      continue;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    if (number) {
      scalars.push(`n:${number}`);
      tokens.push(scalars[scalars.length - 1]);
      i += number.length;
      continue;
    }
    return undefined;
  }
  return { scalars, containers, tokens };
}

/** 去掉末尾那一串收尾括号（`]` `}`）之后的样子：最后一个标量或开括号为止。 */
function beforeClosingTail(tokens: readonly string[]): readonly string[] {
  let end = tokens.length;
  while (end > 0 && (tokens[end - 1] === ']' || tokens[end - 1] === '}')) {
    end--;
  }
  return tokens.slice(0, end);
}

/**
 * 修过的那份只改了标点：能解析、标量逐个一致、容器括号序列相同，唯一的例外是在
 * 末尾补上缺的闭合括号。见文件头。
 *
 * 复跑之后多认一种（第 13–15 章重拆：模型在结尾多写了一个 `]`，修复只删了它，却被判成改了内容、整批拒收）：
 * **只差在末尾那一串收尾括号上**——最后一个标量（或开括号）之前，标量与括号按先后一个不差，之后只有 `]` `}`，
 * 多删少补都行。最后一个标量后面不会再有内容，那一串括号怎么改都改不了哪个值属于哪个对象，是纯语法。
 */
export function preservesJsonEvidence(candidate: string, repaired: string): boolean {
  const after = stripCodeFence(repaired);
  try {
    JSON.parse(after);
  } catch {
    return false;
  }
  const a = lexicalEvidence(stripCodeFence(candidate));
  const b = lexicalEvidence(after);
  if (!a || !b || a.scalars.length !== b.scalars.length) {
    return false;
  }
  if (a.scalars.some((token, i) => token !== b.scalars[i])) {
    return false;
  }
  if (a.containers === b.containers) {
    return true;
  }
  if (b.containers.startsWith(a.containers) && /^[\]}]+$/.test(b.containers.slice(a.containers.length))) {
    return true;
  }
  const head = beforeClosingTail(a.tokens);
  const repairedHead = beforeClosingTail(b.tokens);
  return head.length === repairedHead.length && head.every((token, i) => token === repairedHead[i]);
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
