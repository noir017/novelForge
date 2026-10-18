/**
 * 自定义敏感词表（`.novelforge/sensitive.txt`）：发布平台不让出现的词，作者自己维护。**纯函数、绝不抛**
 * （第 1 条：作者会手改它，认不出的行跳过）；只 import 同样零 import 的 `manuscriptCheck.ts`，前端也能打包。
 *
 * 现在**只给内置编辑器的「写作体检」用**（后端读出来解析好，随 `checkTerms` 推给编辑器，正文里出现了就标出来，
 * 有替换词的在体检面板里可以一键替换）——不进生成链、不进装配器，模型看不到这份词表。
 *
 * ## 格式（⚑）
 *
 * ```
 * # 井号开头的行是注释，空行不算
 * 某个词
 * 某个词 => 换成的词
 * ```
 *
 * - 一行一个词，前后的空白不算；词中间可以有空格（英文词组）。
 * - `=>` 后面是建议的替换词（左右空白不算）。只认半角的 `=>`，一行只能有一个。
 * - 英文不分大小写，全角字母当半角（匹配在 `manuscriptCheck.ts` 的 `locateTerms`，`foldCase`）。
 * - 认不出的行跳过，不报错：`=>` 前面没有词、后面没有替换词、一行两个 `=>`、词太长（超过 {@link SENSITIVE_TERM_MAX} 个字）、
 *   替换词与原词一字不差、与前面某一行是同一个词（不分大小写）。体检面板里提一句「第 N 行没看懂」。
 *
 * 文件不在 = 没有敏感词。第一次在编辑器里点「编辑敏感词表…」时经网关新建一份 {@link SENSITIVE_TEMPLATE}。
 */
import { foldLatin } from './manuscriptCheck';

/** 文件名（在 `.novelforge/` 下）。 */
export const SENSITIVE_FILE_NAME = 'sensitive.txt';

/** 一个词最多几个字（码位）：再长就是一句话了。 */
export const SENSITIVE_TERM_MAX = 32;

/** 词表里的一个词。`line` 是它在文件里的第几行（1 起）。 */
export interface SensitiveTerm {
  term: string;
  /** 建议的替换词。没写就是只标出来。 */
  replacement?: string;
  line: number;
}

/** 没看懂、跳过的一行。 */
export interface SensitiveBadLine {
  line: number;
  /** 为什么没看懂（给人看的一句）。 */
  reason: string;
}

export interface SensitiveList {
  terms: SensitiveTerm[];
  bad: SensitiveBadLine[];
}

/** 解析词表。不是字符串（读不到）当空的。 */
export function parseSensitiveWords(text: string | undefined): SensitiveList {
  const terms: SensitiveTerm[] = [];
  const bad: SensitiveBadLine[] = [];
  const seen = new Map<string, number>();
  const lines = typeof text === 'string' ? text.replace(/^﻿/, '').split(/\r?\n/) : [];
  lines.forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#')) {
      return;
    }
    const parts = s.split('=>');
    if (parts.length > 2) {
      bad.push({ line, reason: '一行只能有一个「=>」' });
      return;
    }
    const term = parts[0].trim();
    const replacement = parts.length === 2 ? parts[1].trim() : undefined;
    if (!term) {
      bad.push({ line, reason: '「=>」前面没有词' });
      return;
    }
    if (replacement === '') {
      bad.push({ line, reason: '「=>」后面没有替换词（不想替换就把「=>」删掉）' });
      return;
    }
    if (Array.from(term).length > SENSITIVE_TERM_MAX) {
      bad.push({ line, reason: `太长了（一个词最多 ${SENSITIVE_TERM_MAX} 个字）` });
      return;
    }
    if (replacement !== undefined && replacement === term) {
      bad.push({ line, reason: '替换词与原词一样' });
      return;
    }
    const key = foldLatin(term);
    const first = seen.get(key);
    if (first !== undefined) {
      bad.push({ line, reason: `与第 ${first} 行是同一个词（英文不分大小写），只认第 ${first} 行` });
      return;
    }
    seen.set(key, line);
    terms.push(replacement !== undefined ? { term, replacement, line } : { term, line });
  });
  return { terms, bad };
}

/** 第一次「编辑敏感词表…」时新建的那一份：全是注释，一个词都不生效。 */
export const SENSITIVE_TEMPLATE = [
  '# 敏感词表：发布平台不让出现的词，自己维护，一行一个。',
  '#',
  '# 只用于内置编辑器的「体检」：正文（章节与草稿）里出现了就标出来、在状态栏「体检」那一格里数出来，',
  '# 不会替你改字，也不会发给模型（写正文时模型看不到这份词表）。',
  '#',
  '# 写法：',
  '#   某个词                只标出来',
  '#   某个词 => 换成的词     标出来，体检面板里可以「替换本处」或「本文件全部替换」',
  '#   # 开头的行是注释，空行不算',
  '# 英文不分大小写（全角字母当半角）。认不出的行会跳过，体检面板里会说是第几行。',
  '#',
  '# 例子（去掉行首的「# 」就生效）：',
  '# 某某平台',
  '# 赌博 => 博戏',
  '',
].join('\n');
