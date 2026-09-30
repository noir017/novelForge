/**
 * 情节大纲按章号区间切片：`outline.md` 里的 `## 第1–20章：第一幕 · 入局`。
 *
 * **纯函数、零 I/O、绝不抛。** 大纲是作者高频手改的纯 Markdown，这里只**读**它的
 * 结构，不规定它必须长什么样：一个区间标题都没有的大纲照样合法，只是「覆盖到第几章」
 * 说不上来（见 {@link outlineCoverage}）。
 *
 * ## 为什么要按区间切
 *
 * 三处要用：
 *
 * 1. **续写大纲**：总章数超过 20 时先只写第 1–20 章（一次写一百章的大纲，后半段
 *    会稀得像目录），细纲快追上时再续——判「追上没有」要知道覆盖到了第几章。
 * 2. **细纲的上游指纹**：第 12 章的细纲只依赖覆盖第 12 章的那一节。改了第 21–40 章
 *    那一节，前 20 章的细纲不该挂 ⟳（从前按卷算指纹也是为了这一条）。
 * 3. **写正文时只带本章所在的那一节**：整份大纲塞进去既浪费预算，又会让模型
 *    提前把后面的事写掉。
 *
 * ## 认哪些写法
 *
 * `##` 或 `###` 开头，`第 a–b 章`、`第a章-第b章` 或 `第 N 章`，横线认
 * `- – — ~ ～ 至 到`，后面的冒号（中英文）可有可无。**只认阿拉伯数字**：
 * 「第一章」这种写法要做中文数字解析，而移植过来的提示词一律要求阿拉伯数字。
 */

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
 * 大纲覆盖到了第几章。
 *
 * - 有区间标题：取最大的 `to`。
 * - 有内容但一个区间标题都没有（老工程、或作者自己写的散文式大纲）：`Infinity`
 *   ——说不上覆盖到哪，就**不拦**。拿 0 的话，那些工程会被状态机一直推去「续写大纲」，
 *   而它们的大纲明明写好了。
 * - 空：0。
 */
export function outlineCoverage(text: string): number {
  const ranges = parseOutlineRanges(text);
  if (ranges.length > 0) {
    return ranges.reduce((max, r) => Math.max(max, r.to), 0);
  }
  return (text ?? '').trim() ? Infinity : 0;
}

/** 覆盖第 `no` 章的那一节；重叠时取先出现的；没有就 undefined。 */
export function outlineSliceFor(text: string, no: number): OutlineRange | undefined {
  return parseOutlineRanges(text).find((r) => r.from <= no && no <= r.to);
}
