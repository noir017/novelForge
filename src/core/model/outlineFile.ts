/**
 * 情节大纲按章号区间切片：`outline.md` 里的 `## 第1–20章：第一幕 · 入局`。
 *
 * **纯函数、零 I/O、绝不抛。** 大纲是作者高频手改的纯 Markdown，这里只**读**它的
 * 结构，不规定它必须长什么样：一个区间标题都没有的大纲照样合法，只是「覆盖到第几章」
 * 说不上来（见 {@link outlineCoverage}）。
 *
 * ## 为什么要按区间切
 *
 * 四处要用：
 *
 * 1. **续写大纲**：总章数超过 20 时先只写第 1–20 章（一次写一百章的大纲，后半段
 *    会稀得像目录），细纲快追上时再续——判「追上没有」要知道覆盖到了第几章。
 * 2. **细纲的上游指纹**：第 12 章的细纲只依赖覆盖第 12 章的那一节。改了第 21–40 章
 *    那一节，前 20 章的细纲不该挂 ⟳（从前按卷算指纹也是为了这一条）。
 * 3. **写正文时只带本章所在的那一节**：整份大纲塞进去既浪费预算，又会让模型
 *    提前把后面的事写掉。
 * 4. **续写的那一段落盘时按区间合并**（{@link mergeOutline}）：写第 21–40 章不该把
 *    作者手改过的前 20 章整份替换掉。
 *
 * ## 认哪些写法
 *
 * `##` 或 `###` 开头，`第 a–b 章`、`第a章-第b章` 或 `第 N 章`，横线认
 * `- – — ~ ～ 至 到`，后面的冒号（中英文）可有可无。**只认阿拉伯数字**：
 * 「第一章」这种写法要做中文数字解析，而移植过来的提示词一律要求阿拉伯数字。
 */
import { hash } from './fs';

export interface OutlineRange {
  from: number;
  to: number;
  /** 冒号后面那一段，可能为空。 */
  title: string;
  /** 这一节的正文（不含标题行，已 trim）。 */
  text: string;
}

/**
 * 区间标题。「章」字可以在区间末尾（`第1-20章`），也可以两头各一个
 * （`第1章-第20章`），但至少得有一个——`## 第 3 节` 不是章号区间。
 * 分组：1 级别、2 起、3 第一个「章」、4 止、5 第二个「章」、6 标题。
 */
const RANGE_HEADING =
  /^(#{2,3})\s*第\s*(\d{1,5})\s*(章)?\s*(?:[-–—~～至到]\s*(?:第\s*)?(\d{1,5})\s*)?(章)?\s*[:：]?\s*(.*?)\s*$/;

/** 任何 `#`–`###` 标题。区间一节到下一个**同级或更高级**的标题为止。 */
const ANY_HEADING = /^(#{1,3})\s+\S/;

/**
 * 抽出全部区间，按出现顺序。
 *
 * `from > to` 时两者对调（`第 20–1 章` 只可能是手滑）；区间彼此重叠也照收，
 * 取用时以先出现的为准（见 {@link outlineSliceFor}）。
 */
export function parseOutlineRanges(text: string): OutlineRange[] {
  const lines = (text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const out: OutlineRange[] = [];
  let current: { range: Omit<OutlineRange, 'text'>; level: number; buf: string[] } | undefined;

  const flush = () => {
    if (current) {
      out.push({ ...current.range, text: current.buf.join('\n').trim() });
      current = undefined;
    }
  };

  for (const line of lines) {
    const m = RANGE_HEADING.exec(line);
    if (m && (m[3] || m[5])) {
      flush();
      const a = Number(m[2]);
      const b = m[4] !== undefined ? Number(m[4]) : a;
      if (a > 0 && b > 0) {
        current = {
          range: { from: Math.min(a, b), to: Math.max(a, b), title: m[6] ?? '' },
          level: m[1].length,
          buf: [],
        };
      }
      continue;
    }
    const h = ANY_HEADING.exec(line);
    if (h && current && h[1].length <= current.level) {
      // 同级或更高级的普通标题（`## 后续概览`）结束当前这一节。
      flush();
      continue;
    }
    current?.buf.push(line);
  }
  flush();
  return out;
}

/**
 * 大纲写过没有。
 *
 * 不能只看「有没有字」：模板里有一行 `>` 说明，老模板还有「（写一句话概括全书。）」
 * 这类括号提示和一串空的 `1.` `-`——那些都是给人看的脚手架，不是大纲。
 * 所以只认**实质行**：不是空行、不是 `>` 引用、不是标题、不是空的列表项、
 * 也不是整行一对括号的提示文字。区间一节里有内容当然也算。
 */
export function isOutlineFilled(text: string): boolean {
  for (const raw of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith('>') ||
      /^#{1,6}\s/.test(line) ||
      /^([-*+]|\d+[.、)）])\s*$/.test(line) ||
      /^[（(][^）)]*[）)]$/.test(line)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * 大纲覆盖到了第几章。
 *
 * - 有区间标题：取最大的 `to`。
 * - 写过（{@link isOutlineFilled}）但一个区间标题都没有（老工程、或作者自己写的
 *   散文式大纲）：`Infinity`——说不上覆盖到哪，就**不拦**。拿 0 的话，那些工程会被
 *   状态机一直推去「续写大纲」，而它们的大纲明明写好了。
 * - 没写过：0。
 */
export function outlineCoverage(text: string): number {
  const ranges = parseOutlineRanges(text);
  if (ranges.length > 0) {
    return ranges.reduce((max, r) => Math.max(max, r.to), 0);
  }
  return isOutlineFilled(text) ? Infinity : 0;
}

/** 覆盖第 `no` 章的那一节；重叠时取先出现的；没有就 undefined。 */
export function outlineSliceFor(text: string, no: number): OutlineRange | undefined {
  return parseOutlineRanges(text).find((r) => r.from <= no && no <= r.to);
}

// ---------------------------------------------------------------- 按区间合并

/**
 * 大纲切成块：区间节（标题行到下一个同级或更高级标题之前）与其余部分。
 * 与 {@link parseOutlineRanges} 同一套认法，只是保留原始行，合并时原样拼回去。
 */
type OutlineBlock = { lines: string[] } & ({ kind: 'range'; from: number; to: number } | { kind: 'other' });

function splitOutlineBlocks(text: string): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  let current: OutlineBlock | undefined;
  let level = 0;
  for (const line of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = RANGE_HEADING.exec(line);
    const a = m && (m[3] || m[5]) ? Number(m[2]) : 0;
    if (m && a > 0) {
      const b = m[4] !== undefined ? Number(m[4]) : a;
      current = { kind: 'range', from: Math.min(a, b), to: Math.max(a, b), lines: [line] };
      level = m[1].length;
      blocks.push(current);
      continue;
    }
    const h = ANY_HEADING.exec(line);
    if (current?.kind === 'range' && h && h[1].length <= level) {
      current = undefined;
    }
    if (!current) {
      current = { kind: 'other', lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}

function blockText(b: OutlineBlock): string {
  return b.lines.join('\n').replace(/\s+$/, '');
}

/**
 * 把第 [from, to] 章新写的那段大纲并进旧大纲。
 *
 * 大纲是一段一段续写的（D20）：写第 21–40 章时模型只输出这一段，不该让作者手改过的
 * 第 1–20 章被整份替换掉。规则：
 *
 * - 旧大纲没写过（{@link isOutlineFilled}）→ 直接用新的。
 * - 删掉旧大纲里**与 [from, to] 重叠**的区间节，新的几节放在第一个被删节的位置；
 *   一节都没删就按章号插在前后两节之间（找不到就接在最后）。
 * - 区间之外的节、没有区间标题的前言与附注原样保留。
 * - 新产出里区间标题之前的东西（多半是一行 `# 情节大纲`）在合并时丢掉——旧大纲已经有
 *   自己的开头，拼进中间只会多出一个标题。
 *
 * 结果仍要走覆盖审阅：合并规则再周全，也得让作者看一眼 diff（第 3 条）。
 */
export function mergeOutline(existing: string, incoming: string, range: { from: number; to: number }): string {
  const fresh = (incoming ?? '').trim();
  if (!isOutlineFilled(existing)) {
    return `${fresh}\n`;
  }
  const incomingBlocks = splitOutlineBlocks(fresh);
  const firstRange = incomingBlocks.findIndex((b) => b.kind === 'range');
  const insert = (firstRange === -1 ? incomingBlocks : incomingBlocks.slice(firstRange)).map(blockText).join('\n\n').trim();
  if (!insert) {
    return existing;
  }

  const overlaps = (b: OutlineBlock) => b.kind === 'range' && b.from <= range.to && b.to >= range.from;
  const blocks = splitOutlineBlocks(existing);
  const first = blocks.findIndex(overlaps);
  const kept = blocks.filter((b) => !overlaps(b));

  let at: number;
  if (first !== -1) {
    at = blocks.slice(0, first).filter((b) => !overlaps(b)).length;
  } else {
    // 插在「后面那一节」之前；没有后面的就紧跟「前面最后一节」——不跟在末尾的附注后面。
    const after = kept.findIndex((b) => b.kind === 'range' && b.from > range.to);
    let before = -1;
    kept.forEach((b, i) => {
      if (b.kind === 'range' && b.to < range.from) {
        before = i;
      }
    });
    at = after !== -1 ? after : before !== -1 ? before + 1 : kept.length;
  }

  const parts = [...kept.slice(0, at).map(blockText), insert, ...kept.slice(at).map(blockText)].filter((p) => p.trim());
  return `${parts.join('\n\n')}\n`;
}

/**
 * 第 `no` 章细纲的上游指纹：**覆盖本章的那一节**的指纹（区间、标题、正文都算——
 * 改了区间也是改了这一章的上游）；大纲没有覆盖这一章的区间时退回全书的指纹；
 * 大纲是空的给空串（空串 = 不记、不标脏）。
 *
 * 为什么不直接用全书的指纹：大纲是一段一段续写的，续写一次就让前 20 章的细纲
 * 全部挂 ⟳ 是在说谎——它们依据的那一节一个字都没变。
 *
 * 细纲落盘时记它（workspace/handlers/plot.ts），流水线判脏时比它
 * （views/pipeline.ts）——两处必须是同一个函数。
 */
export function outlineUpstreamHash(outline: string, no: number | undefined): string {
  if (!(outline ?? '').trim()) {
    return '';
  }
  const slice = no === undefined ? undefined : outlineSliceFor(outline, no);
  return slice ? hash(`${slice.from}-${slice.to}\n${slice.title}\n${slice.text}`) : hash(outline);
}
