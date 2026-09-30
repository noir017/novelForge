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
 * 容器只允许在末尾补闭合括号；多一个字、少一个字都拒收，交给拆半重试去处理。
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
}

/** 按 JSON 的词法把一段文本拆成标量序列与容器括号序列。认不出的字符返回 undefined。 */
function lexicalEvidence(source: string): LexicalEvidence | undefined {
  const scalars: string[] = [];
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
      continue;
    }
    const rest = source.slice(i);
    const literal = /^(?:true|false|null)/.exec(rest)?.[0];
    if (literal) {
      scalars.push(`l:${literal}`);
      i += literal.length;
      continue;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    if (number) {
      scalars.push(`n:${number}`);
      i += number.length;
      continue;
    }
    return undefined;
  }
  return { scalars, containers };
}

/**
 * 修过的那份只改了标点：能解析、标量逐个一致、容器括号序列相同，唯一的例外是在
 * 末尾补上缺的闭合括号。见文件头。
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
  return b.containers.startsWith(a.containers) && /^[\]}]+$/.test(b.containers.slice(a.containers.length));
}
