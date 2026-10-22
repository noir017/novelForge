/**
 * 情节大纲**一章一条**：`## 第3章：火折逼退`，下面第一行一句话写这一章发生什么、结果如何，
 * 最多再补两句（docs/design/plans/2026-10-21-outline-per-chapter.md）。
 *
 * **纯函数、零 I/O、绝不抛。** 大纲是作者高频手改的纯 Markdown，这里只**读**它的结构：认不出来的
 * 标题与段落不算进任何一章。
 *
 * ## 它不是一份文件，是各章细纲「梗概」的汇总
 *
 * 大纲一章一句，细纲里本来就有「梗概」，同一件事存两份（docs/design/plans/2026-10-22-outline-from-plots.md）。
 * 现在磁盘上没有 `outline.md`：读的时候把各章细纲的梗概拼成一章一条（{@link outlineEntriesOf}），存的时候按章号拆回
 * 各章细纲（{@link planOutlineSplit}）——只有梗概、别的几节都空的细纲是「空壳」：大纲排到了，细纲还没拆。
 * `.novelforge/outline.md` 这个路径仍是情节大纲的身份，网关（`workspace/`）接住它的读写。
 *
 * ## 为什么一章一条
 *
 * 从前按「第 a–b 章」分节，一节 3–5 章拼成一段叙述式的摘要。章与章的分界留给细纲去猜，
 * 摘要腔顺着大纲 → 细纲 → 正文一路往下传；续写时整份大纲进一次对话，越写越胖。一章一条之后：
 *
 * 1. **按远近带**（{@link outlineWindow}）：最近 10 章带整条，再往前一章只带第一行、最多几章随上下文详细度，更早的
 *    交给全文大纲——写到几百章也不随章数涨。
 * 2. **续写大纲**：总章数超过 20 时一次写 20 章，细纲快追上时再续——判「追上没有」要知道覆盖到了第几章。
 * 3. **续写的那一段按章号合并**（{@link mergeOutline}）：写第 21–40 章不该把作者手改过的前 20 章整份替换掉。
 *
 * ## 认哪些写法
 *
 * `##` 或 `###` 开头的 `第 N 章`，后面的冒号（中英文）可有可无。**只认阿拉伯数字**：「第一章」这种写法
 * 要做中文数字解析，而提示词一律要求阿拉伯数字。**区间标题（`第1–4章`、`第1章-第4章`）不认**——旧格式
 * 不兼容：它结束上一条，自己那一节被忽略。
 */
import { takeLast } from './contextDetail';
import { hasContent } from './markdown';
import { Plot, isPlotStub, normalizeSynopsis } from './plotFile';

export interface OutlineEntry {
  no: number;
  /** 冒号后面那一段，可能为空。 */
  title: string;
  /** 这一条的正文（不含标题行，已 trim）。第一行是这一章的概要。 */
  text: string;
}

/**
 * 章标题（连同不认的区间标题一起认出来，好让区间标题也能结束上一条）。「章」字可以在区间末尾
 * （`第1-20章`），也可以两头各一个（`第1章-第20章`），但至少得有一个——`## 第 3 节` 不是章标题。
 * 分组：1 级别、2 起、3 第一个「章」、4 止（有它就是区间）、5 第二个「章」、6 标题。
 */
export const OUTLINE_HEADING =
  /^(#{2,3})\s*第\s*(\d{1,5})\s*(章)?\s*(?:[-–—~～至到]\s*(?:第\s*)?(\d{1,5})\s*)?(章)?\s*[:：]?\s*(.*?)\s*$/;

/** 任何 `#`–`###` 标题。一条到下一个**同级或更高级**的标题为止。 */
const ANY_HEADING = /^(#{1,3})\s+\S/;

/** 按远近带时，离当前位置多近的带整条（{@link outlineWindow}）。 */
export const OUTLINE_NEAR = 10;

/** 只带第一行时，那一行最多几个字：提示词要的是一句话，作者手写的可能是一整段。 */
const BRIEF_MAX = 100;

type HeadingMatch = { level: number; no: number; range: boolean; title: string };

function matchHeading(line: string): HeadingMatch | undefined {
  const m = OUTLINE_HEADING.exec(line);
  if (!m || !(m[3] || m[5])) {
    return undefined;
  }
  const a = Number(m[2]);
  const b = m[4] !== undefined ? Number(m[4]) : a;
  if (!(a > 0 && b > 0)) {
    return undefined;
  }
  return { level: m[1].length, no: a, range: a !== b, title: m[6] ?? '' };
}

/**
 * 大纲切成块：一章一条（标题行到下一个同级或更高级标题之前）与其余部分。区间标题起一个 `other` 块。
 * {@link parseOutline} 与 {@link mergeOutline} 共用这一套认法，合并时原样拼回去。
 */
type OutlineBlock = { lines: string[] } & ({ kind: 'entry'; no: number; title: string } | { kind: 'other' });

function splitOutlineBlocks(text: string): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  let current: OutlineBlock | undefined;
  let level = 0;
  for (const line of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const h = matchHeading(line);
    if (h && !h.range) {
      current = { kind: 'entry', no: h.no, title: h.title, lines: [line] };
      level = h.level;
      blocks.push(current);
      continue;
    }
    const any = ANY_HEADING.exec(line);
    if (current?.kind === 'entry' && any && any[1].length <= level) {
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

/** 抽出全部条目，按出现顺序。同一章出现两次照收，取用时以先出现的为准。 */
export function parseOutline(text: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const b of splitOutlineBlocks(text)) {
    if (b.kind === 'entry') {
      out.push({ no: b.no, title: b.title, text: b.lines.slice(1).join('\n').trim() });
    }
  }
  return out;
}

/** 按章号去重（先出现的为准）、升序。 */
function entriesByNo(text: string): OutlineEntry[] {
  const seen = new Map<number, OutlineEntry>();
  for (const e of parseOutline(text)) {
    if (!seen.has(e.no)) {
      seen.set(e.no, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.no - b.no);
}

/** 区间标题（`## 第1–4章`）有几个：旧格式不认，生成之后要说一声。 */
export function outlineRangeHeadings(text: string): number {
  return (text ?? '').split(/\r?\n/).filter((line) => matchHeading(line)?.range).length;
}

/** 大纲写过没有：至少认得出一章。旧格式（区间标题）与没有章标题的散文式大纲都算没写过。 */
export function isOutlineFilled(text: string): boolean {
  return parseOutline(text).length > 0;
}

/**
 * 文件里有没有人写的东西（不管认不认得出章标题）——整份换掉之前要不要先让作者对比一遍（第 3 条）。
 *
 * 不能只看「有没有字」：模板里有一行 `>` 说明，老模板还有「（写一句话概括全书。）」这类括号提示和一串
 * 空的 `1.` `-`——那些都是给人看的脚手架。所以只认**实质行**：不是空行、不是 `>` 引用、不是标题、
 * 不是空的列表项、也不是整行一对括号的提示文字。
 */
export function hasOutlineContent(text: string): boolean {
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

/** 大纲覆盖到了第几章：最大的章号；一条都认不出是 0。 */
export function outlineCoverage(text: string): number {
  return parseOutline(text).reduce((max, e) => Math.max(max, e.no), 0);
}

/** 第 `no` 章那一条；出现两次取先出现的；没有就 undefined。 */
export function outlineEntryFor(text: string, no: number): OutlineEntry | undefined {
  return parseOutline(text).find((e) => e.no === no);
}

/** 大纲里有没有落在 [from, to] 里的条目——有，续写这一段才谈得上「覆盖」。 */
export function outlineOverlaps(text: string, range: { from: number; to: number }): boolean {
  return parseOutline(text).some((e) => e.no >= range.from && e.no <= range.to);
}

// ---------------------------------------------------------------- 按远近带

/** 一条只带第一行：`第3章 火折逼退：沈默用火折子逼退沈怀山，照骨镜开始搜人。` */
export function outlineBrief(e: OutlineEntry): string {
  const first =
    e.text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^([-*+]|\d+[.、)）])\s+/, ''))
      .find(Boolean) ?? '';
  const chars = [...first];
  const line = chars.length > BRIEF_MAX ? `${chars.slice(0, BRIEF_MAX).join('')}…` : first;
  const head = `第${e.no}章${e.title ? ` ${e.title}` : ''}`;
  return line ? `${head}：${line}` : head;
}

/** 一条整条带：标题行规范成 `## 第N章：标题`。 */
export function renderOutlineEntry(e: OutlineEntry): string {
  return `## 第${e.no}章${e.title ? `：${e.title}` : ''}${e.text ? `\n${e.text}` : ''}`;
}

/** 整份大纲每章只列第一行（排叙事线时整份放不下用它）。 */
export function outlineBriefs(text: string): string {
  return entriesByNo(text)
    .map((e) => `- ${outlineBrief(e)}`)
    .join('\n');
}

/** 「后面已经排好的」那一段的开头。 */
const LATER_LEAD = '后面已经排好的（只列第一行）：';

export interface OutlineWindow {
  /** 近段：带整条的，升序。 */
  near: OutlineEntry[];
  /** 中段：近段之前只带第一行的，升序，已按 `maxBefore` 封顶。 */
  before: OutlineEntry[];
  /** 远段：封顶之外更早的章号，升序。不逐章列，前情交给全文大纲。 */
  folded: number[];
  /** 区间之后已有的（`after` 时），升序，只带第一行。 */
  later: OutlineEntry[];
}

/**
 * 按远近带大纲，分三段（docs/design/plans/2026-10-22-planning-context-bands.md）：离这一次要写的地方最近的
 * {@link OUTLINE_NEAR} 章带整条（近段），再往前最多 `maxBefore` 章只带第一行（中段），更早的不逐章列（远段，
 * 交给全文大纲）。从前更早的一章不落地全列，写到几百章光这一行一行就能把窗口撑满。
 *
 * - 给了区间 [from, to]：第 from−10 章到第 to 章是近段；`after` 为真时 to 之后已有的也只带第一行（续写、
 *   重写大纲：后面已经排好的要接得上）。
 * - 没给区间（对话页讨论大纲）：最后 10 条是近段。
 * - `maxBefore` 缺省不限；`Infinity` 也是不限，0 是中段一章都不带。
 *
 * 一条都认不出返回 undefined。
 */
export function outlineWindow(
  text: string,
  opts: { range?: { from: number; to: number }; after?: boolean; maxBefore?: number } = {}
): OutlineWindow | undefined {
  const entries = entriesByNo(text);
  if (entries.length === 0) {
    return undefined;
  }
  const { range } = opts;
  const lastNo = entries[entries.length - 1].no;
  const nearFrom = range ? range.from - OUTLINE_NEAR : entries[Math.max(0, entries.length - OUTLINE_NEAR)].no;
  const nearTo = range ? range.to : lastNo;
  const earlier = entries.filter((e) => e.no < nearFrom);
  const before = takeLast(earlier, opts.maxBefore ?? Infinity);
  return {
    near: entries.filter((e) => e.no >= nearFrom && e.no <= nearTo),
    before,
    folded: earlier.slice(0, earlier.length - before.length).map((e) => e.no),
    later: opts.after ? entries.filter((e) => e.no > nearTo) : [],
  };
}

/** 拼成一段：中段一章一行 → 近段整条 → 「后面已经排好的」一章一行。哪一段空着就不出。 */
export function renderOutlineWindow(win: Pick<OutlineWindow, 'before' | 'near' | 'later'>): string {
  return [
    win.before.map((e) => `- ${outlineBrief(e)}`).join('\n'),
    win.near.map(renderOutlineEntry).join('\n\n'),
    win.later.length > 0 ? `${LATER_LEAD}\n${win.later.map((e) => `- ${outlineBrief(e)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 拆细纲时大纲带哪几条：**这一次要拆的**——区间里的（空壳上的梗概就是这一次的上游），外加区间前面还没拆的空壳
 * （`stubs`：没有关键事件，前序细纲一览不列它们）。已经拆过的章由前序细纲一览与前几章细纲带，同一份细纲不带两遍；
 * 区间之后的不带（后面的事别提前写掉）。`skip`：单章时这一章的梗概已经在本章细纲里。升序。
 */
export function outlineToSplit(
  text: string,
  range: { from: number; to: number },
  opts: { stubs: ReadonlySet<number>; skip?: number }
): OutlineEntry[] {
  return entriesByNo(text).filter(
    (e) => e.no !== opts.skip && ((e.no >= range.from && e.no <= range.to) || (e.no < range.from && opts.stubs.has(e.no)))
  );
}

// ---------------------------------------------------------------- 按章号合并

function blockText(b: OutlineBlock): string {
  return b.lines.join('\n').replace(/\s+$/, '');
}

/**
 * 把第 [from, to] 章新写的那段大纲并进旧大纲。
 *
 * 大纲是一段一段续写的：写第 21–40 章时模型只输出这一段，不该让作者手改过的第 1–20 章被整份替换掉。规则：
 *
 * - 旧大纲一条都认不出（{@link isOutlineFilled}）→ 直接用新的（旧格式不兼容；有内容时调用方先审阅）。
 * - 删掉旧大纲里**落在 [from, to] 里**的条目，新的放在第一个被删条目的位置；一条都没删就按章号插在
 *   前后两条之间（找不到就接在最后）。
 * - 新产出里落在区间外、旧大纲已经有的章**不并进来**：那是作者没要它重写的，不静默换掉（第 3 条）。
 * - 区间之外的条目、认不出的标题与段落原样保留。
 * - 新产出里第一条之前的东西（多半是一行 `# 情节大纲`）在合并时丢掉——旧大纲已经有自己的开头。
 *
 * 结果仍要走覆盖审阅：合并规则再周全，也得让作者看一眼 diff（第 3 条）。
 */
export function mergeOutline(existing: string, incoming: string, range: { from: number; to: number }): string {
  const fresh = (incoming ?? '').trim();
  if (!isOutlineFilled(existing)) {
    return `${fresh}\n`;
  }
  const inRange = (b: OutlineBlock) => b.kind === 'entry' && b.no >= range.from && b.no <= range.to;
  const blocks = splitOutlineBlocks(existing);
  const kept = blocks.filter((b) => !inRange(b));
  const keptNos = new Set(kept.flatMap((b) => (b.kind === 'entry' ? [b.no] : [])));

  const incomingBlocks = splitOutlineBlocks(fresh);
  const firstEntry = incomingBlocks.findIndex((b) => b.kind === 'entry');
  const insert = (firstEntry === -1 ? incomingBlocks : incomingBlocks.slice(firstEntry))
    .filter((b) => !(b.kind === 'entry' && !inRange(b) && keptNos.has(b.no)))
    .map(blockText)
    .join('\n\n')
    .trim();
  if (!insert) {
    return existing;
  }

  const first = blocks.findIndex(inRange);
  let at: number;
  if (first !== -1) {
    at = blocks.slice(0, first).filter((b) => !inRange(b)).length;
  } else {
    // 插在「后面那一条」之前；没有后面的就紧跟「前面最后一条」——不跟在末尾的附注后面。
    const after = kept.findIndex((b) => b.kind === 'entry' && b.no > range.to);
    let before = -1;
    kept.forEach((b, i) => {
      if (b.kind === 'entry' && b.no < range.from) {
        before = i;
      }
    });
    at = after !== -1 ? after : before !== -1 ? before + 1 : kept.length;
  }

  const parts = [...kept.slice(0, at).map(blockText), insert, ...kept.slice(at).map(blockText)].filter((p) => p.trim());
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------- 从细纲汇总

/** 汇总文档的标题行。编辑器打开的那一份带它，装配器读的（{@link outlineEntriesOf}）不带。 */
export const OUTLINE_DOC_HEADING = '# 情节大纲';

/** 汇总文档开头那段说明：给手改的作者看——存盘只认章标题与下面的梗概。 */
export const OUTLINE_DOC_NOTE =
  '> 一章一条，汇总自各章细纲的「梗概」。改了存盘就写回那一章的细纲；新加的章建一份只有梗概的细纲，删掉的空壳细纲进回收站。' +
  '只认「## 第N章：标题」与下面那几句，别的文字不保存。';

/**
 * 各章细纲（每个章号认下的那一份，`NovelProject.pairPlots`）→ 一章一条：章号、标题、梗概。梗概空着的不算——
 * 那一章大纲里没有。
 */
export function outlineEntriesOf(plots: readonly Pick<Plot, 'no' | 'title' | 'sections'>[]): OutlineEntry[] {
  return plots
    .filter((p) => hasContent(p.sections.梗概))
    .map((p) => ({ no: p.no, title: p.title, text: normalizeSynopsis(p.sections.梗概) }))
    .sort((a, b) => a.no - b.no);
}

/** 一章一条拼成大纲正文（不带标题行与说明）。 */
export function renderOutline(entries: readonly OutlineEntry[]): string {
  return entries.map(renderOutlineEntry).join('\n\n');
}

/** 给编辑器、覆盖审阅看的整份：标题行、说明、一章一条。 */
export function renderOutlineDoc(entries: readonly OutlineEntry[]): string {
  const body = renderOutline(entries);
  return `${OUTLINE_DOC_HEADING}\n\n${OUTLINE_DOC_NOTE}\n${body ? `\n${body}\n` : ''}`;
}

// ---------------------------------------------------------------- 按章号拆回各章细纲

/** 拆回去的一步。`update` 里给了哪个字段就是哪个变了。 */
export type OutlineSplitOp =
  | { op: 'create'; no: number; title: string; synopsis: string }
  | { op: 'update'; no: number; rel: string; title?: string; synopsis?: string }
  | { op: 'drop'; no: number; rel: string };

export interface OutlineSplitPlan {
  ops: OutlineSplitOp[];
  /** 大纲里删掉了、但已经排了细纲或写了正文的章：不删，说一声。 */
  kept: number[];
  /** 只有章标题、下面没写一个字的章：没地方存，说一声。 */
  empty: number[];
}

/**
 * 存一份汇总文档时，按章号拆回各章细纲要做哪几件事（落盘在 `Workspace.writeOutline`）。
 *
 * - 一条在、这一章有细纲：梗概或标题变了就改（标题空着 = 沿用细纲的标题）。
 * - 一条在、这一章没有细纲：建一份空壳。
 * - 原来在大纲里（梗概非空）、这一回没有了：空壳（{@link isPlotStub}，且这一章还没有正文）删掉；
 *   排了细纲或写了正文的不删，记进 `kept`。
 * - 同一章写了两条取先出现的；章号只按标题里写的认，**不搬细纲**（把第 5 章改叫第 6 章，等于改第 6 章、删第 5 章）。
 *
 * @param plots 每个章号认下的那一份细纲（`pairPlots`）
 * @param writtenNos 已经有正文的章号
 */
export function planOutlineSplit(text: string, plots: readonly Plot[], writtenNos: ReadonlySet<number>): OutlineSplitPlan {
  const byNo = new Map(plots.map((p) => [p.no, p]));
  const ops: OutlineSplitOp[] = [];
  const empty: number[] = [];
  const present = new Set<number>();
  for (const e of entriesByNo(text)) {
    const synopsis = normalizeSynopsis(e.text);
    if (!hasContent(synopsis)) {
      empty.push(e.no);
      continue;
    }
    present.add(e.no);
    const plot = byNo.get(e.no);
    if (!plot) {
      ops.push({ op: 'create', no: e.no, title: e.title, synopsis });
      continue;
    }
    const titleChanged = e.title !== '' && e.title !== plot.title;
    const synopsisChanged = synopsis !== normalizeSynopsis(plot.sections.梗概);
    if (titleChanged || synopsisChanged) {
      ops.push({
        op: 'update',
        no: e.no,
        rel: plot.relPath,
        ...(titleChanged ? { title: e.title } : {}),
        ...(synopsisChanged ? { synopsis } : {}),
      });
    }
  }
  const kept: number[] = [];
  for (const plot of plots) {
    if (present.has(plot.no) || !hasContent(plot.sections.梗概)) {
      continue;
    }
    if (isPlotStub(plot) && !writtenNos.has(plot.no)) {
      ops.push({ op: 'drop', no: plot.no, rel: plot.relPath });
    } else {
      kept.push(plot.no);
    }
  }
  return { ops, kept: kept.sort((a, b) => a - b), empty: empty.filter((no) => !byNo.get(no)?.sections.梗概.trim()) };
}
