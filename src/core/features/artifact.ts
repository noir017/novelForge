/**
 * 产物解析：模型的一坨输出 → 可以采纳落盘的结构化产物。
 *
 * ## 为什么要单独一层
 *
 * `generate` / `settle` / `split` 三个能力产出的是**要写进文件的
 * 东西**，不是聊天气泡。写进文件就意味着解析失败＝这一次生成白花钱，而且用户
 * 看着一段像模像样的回答却等不来那张「写入吗」的卡片，只会以为是插件坏了。
 *
 * 所以沿用摘要那一套**三层降级**（summarize.ts 的 parseSummaryResponse）：
 *
 * 1. **JSON**——提示词要求的形状。字段缺失、类型不对、数组/字符串混用逐个兜住，
 *    不整体作废。
 * 2. **Markdown 小节**——模型忽略 JSON 要求、改用 `## 剧情脉络` 时走这条。
 *    作者手改过的产物重新解析时也走这条。
 * 3. **全文塞进主字段**——信息密度低，但比让这次生成彻底作废强。
 *
 * ## 解析不落盘
 *
 * 这里只把文本变成对象，**一个字都不写磁盘**。落盘在 `generation/accept.ts`，
 * 且必须由用户在那张权限卡片上点了「写入」才发生（AGENTS.md 第 3 / 19 条：
 * 不静默覆盖、产物落盘前必须过一遍人）。分开还有一个好处：产出先摊在气泡里
 * 给他看，他改两个字再点写入。
 */
import { pickSections } from '../model/markdown';
import { PLOT_SECTION_KEYS, PlotSections, emptyPlotSections } from '../model/plotFile';
import { CreationAction } from '../model/pipeline';
import { extractJsonObject, stripCodeFence } from './parse';
import { toSectionText } from './summarize';

// ---------------------------------------------------------------- 产物形状

/** 卷纲拆出的一个剧情段。`no` 缺席时由调用方按现有段数续号。 */
export interface PlotOutlineItem {
  no?: number;
  title: string;
  goal: string;
  arc: string;
}

/** 大纲拆卷的一项。`no` 缺席时由调用方按现有卷数续号。 */
export interface VolumeOutlineItem {
  no?: number;
  title: string;
  goal: string;
  /** 这一卷的剧情走向。卷纲的主体那一节，`isVolumeFilled` 只看它。 */
  arc: string;
}

/**
 * 解析出来的产物。`kind` 与 `CreationTarget.kind` 不完全对应——
 * `split` 产出的是**下一层**的东西（大纲 split 出分卷清单，卷 split 出一个
 * 剧情段）。
 */
export type Artifact =
  | { kind: 'outlineDoc'; text: string }
  | { kind: 'volumeList'; volumes: VolumeOutlineItem[] }
  /**
   * 从一卷里拆出来的**一个**剧情段。
   *
   * 刻意不是列表：一次吐五段只会得到一串彼此没有因果的骨架（那正是「大纲直接
   * 拆章」的老毛病）。一次一段，模型手上有卷纲、也有这一卷已经排到哪了，
   * 「接下来该发生什么」才答得准。
   */
  | { kind: 'plotSegment'; segment: PlotOutlineItem }
  | { kind: 'plot'; sections: PlotSections }
  | { kind: 'manuscript'; text: string };

/**
 * 按 action 解析。**绝不抛**：解析这一步出异常，用户丢的是刚花掉的那次调用。
 * 实在认不出就退回一个「全文塞进主字段」的产物，让他至少能手工取用。
 *
 * **只看 action，不看 target。** 从前它还要收一份 target：`outline` 阶段兼管
 * 全书大纲与卷纲，同一个 `split` 在两者上产出的东西完全不同，只看 stage 分不开。
 * 卷纲独立成阶段之后 stage 就够了。
 */
export function parseArtifact(action: CreationAction, raw: string): Artifact {
  const text = stripCodeFence(raw).trim();
  const { stage, capability } = action;

  switch (stage) {
    case 'manuscript':
      return { kind: 'manuscript', text };
    case 'outline':
      return capability === 'split'
        ? { kind: 'volumeList', volumes: parseVolumeList(text) }
        // 大纲是 Markdown，没有 JSON 可解——原样收下。
        : { kind: 'outlineDoc', text };
    case 'volume':
      return capability === 'split'
        ? { kind: 'plotSegment', segment: parsePlotSegment(text) }
        // 卷纲同样是 Markdown。落点由 target 决定（见 generation/accept.ts）。
        : { kind: 'outlineDoc', text };
    case 'plot':
      // 剧情层没有 `split`，所以不必分岔。
      return { kind: 'plot', sections: parsePlotSections(text) };
  }
}

/** 产物是不是空的。空产物不必问「写不写」——写下去只会得到一个空文件。 */
export function isArtifactEmpty(artifact: Artifact): boolean {
  switch (artifact.kind) {
    case 'outlineDoc':
    case 'manuscript':
      return !artifact.text.trim();
    case 'volumeList':
      return artifact.volumes.length === 0;
    case 'plotSegment':
      return !artifact.segment.title.trim() && !artifact.segment.goal.trim();
    case 'plot':
      return !Object.values(artifact.sections).some((v) => v.trim());
  }
}

/** 一句话描述，给落盘卡片与气泡末尾那一行用（「3 卷」「剧情 · 3/4 节」）。 */
export function describeArtifact(artifact: Artifact): string {
  switch (artifact.kind) {
    case 'outlineDoc':
      return `全书大纲 · ${artifact.text.length} 字`;
    case 'volumeList':
      return `${artifact.volumes.length} 卷`;
    case 'plotSegment':
      return `1 个剧情段 · ${artifact.segment.title || '（未命名）'}`;
    case 'plot': {
      const filled = Object.values(artifact.sections).filter((v) => v.trim()).length;
      return `剧情 · ${filled}/${PLOT_SECTION_KEYS.length} 节`;
    }
    case 'manuscript':
      return `正文 · ${artifact.text.length} 字`;
  }
}

// ---------------------------------------------------------------- 细纲

/**
 * 四个小节。JSON → Markdown 小节 → 全文塞进「剧情脉络」。
 *
 * 兜底落到「剧情脉络」而不是「目标」：**「目标」不算 filled**
 * （`isPlotFilled` 只看剧情脉络），兜底进那一节的话，这一段采纳后会显示成
 * 「还没排剧情」的空壳。
 */
export function parsePlotSections(text: string): PlotSections {
  return parsePlotStrict(text) ?? { ...emptyPlotSections(), 剧情脉络: text.trim() };
}

/**
 * 只走前两层，**不做全文兜底**。解析不出结构就返回 undefined。
 *
 * 批量路径（工程页一次给几十段写剧情）必须用这个：那里没有人逐份过目，
 * 而全文兜底会把模型的一句「我不太确定这一段写什么」变成一份「已规划」的
 * 剧情——流水线状态从此开始撒谎，紧接着的批量写正文会照着这份垃圾往下写。
 *
 * 创作页反过来该用 {@link parsePlotSections}：那里产物就摊在屏幕上，
 * 用户看得见它是什么，兜底至少留住了这次调用的钱。
 */
export function parsePlotStrict(text: string): PlotSections | undefined {
  const fromJson = objectOf(text);
  if (fromJson) {
    const sections = emptyPlotSections();
    for (const key of PLOT_SECTION_KEYS) {
      sections[key] = toSectionText(fromJson[key]);
    }
    // 判据与摘要同源：语法合法但完全不相干的 JSON（`{"text":"..."}`）
    // 认下来会得到一份空剧情**并且不再降级**，比解析失败更糟。
    if (Object.values(sections).some((v) => v.trim())) {
      return sections;
    }
  }

  const picked = pickSections(text, PLOT_SECTION_KEYS) as PlotSections;
  return Object.values(picked).some((v) => v.trim()) ? { ...emptyPlotSections(), ...picked } : undefined;
}

// ---------------------------------------------------------------- 清单类

/**
 * 大纲拆卷。JSON `{volumes:[…]}` → 裸数组 → Markdown 列表逐行。
 *
 * 三层降级与 `parsePlotList` 逐条同构：一行纯文本也收下（当卷名兼目标），
 * 因为解析失败等于这一次调用白花钱。
 */
export function parseVolumeList(text: string): VolumeOutlineItem[] {
  const rows = listOf(text, 'volumes', '分卷', '卷');
  const out: VolumeOutlineItem[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const title = cleanListLine(row);
      if (title) {
        out.push({ title: clipTitle(title), goal: title, arc: '' });
      }
      continue;
    }
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const title = str(o.title ?? o.标题 ?? o.name ?? o.卷名);
    const goal = str(o.goal ?? o.目标 ?? o.summary ?? o.梗概);
    if (!title && !goal) {
      continue;
    }
    out.push({
      no: num(o.no ?? o.序号 ?? o.order ?? o.volume ?? o.卷号),
      title: clipTitle(title || goal),
      goal,
      arc: toSectionText(o.arc ?? o.剧情走向 ?? o.走向 ?? o.脉络),
    });
  }
  return out;
}

/**
 * 卷纲拆出**一个**剧情段。
 *
 * 模型仍然可能吐一个列表（提示词说了一次一段，但它不总听）。那时**只取第一项**
 * 而不是全收：契约是一次一段，收下三段会让「一次只拆一段」这条设计在数据这一侧
 * 悄悄失效，而作者以为自己点的是「拆一段」。
 *
 * 一项都解析不出来时退回「全文当目标」的兜底——与 `parsePlotSections` 同一条
 * 理由：至少留住这次调用。
 */
export function parsePlotSegment(text: string): PlotOutlineItem {
  const first = parsePlotList(text)[0];
  if (first) {
    return first;
  }
  const obj = objectOf(text);
  const title = obj ? str(obj.title ?? obj.标题 ?? obj.name) : '';
  const goal = obj ? str(obj.goal ?? obj.目标 ?? obj.summary) : '';
  const fallback = (goal || text).trim();
  return { title: clipTitle(title || fallback), goal: fallback, arc: obj ? str(obj.arc ?? obj.幕) : '' };
}

/** 卷纲拆段（多项形态）。JSON `{plots:[…]}` → 裸数组 → Markdown 列表逐行。 */
export function parsePlotList(text: string): PlotOutlineItem[] {
  const rows = listOf(text, 'plots', 'chapters', '剧情', '章节');
  const out: PlotOutlineItem[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const title = cleanListLine(row);
      if (title) {
        out.push({ title: clipTitle(title), goal: title, arc: '' });
      }
      continue;
    }
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const title = str(o.title ?? o.标题 ?? o.name);
    const goal = str(o.goal ?? o.目标 ?? o.summary ?? o.梗概);
    if (!title && !goal) {
      continue;
    }
    out.push({
      no: num(o.no ?? o.序号 ?? o.order ?? o.plot),
      title: clipTitle(title || goal),
      goal,
      arc: str(o.arc ?? o.幕 ?? o.卷),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 取值工具

/** 最外层 JSON 对象。不是对象（数组、纯文本）返回 undefined。 */
function objectOf(text: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(text);
  if (!json) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(json);
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 清单：`{plots:[…]}` → `[…]` 裸数组 → Markdown 逐行。
 *
 * 三条路都要留。模型漏掉外层键、或整个忘了 JSON 直接列了一串
 * `1. 入宗风波 —— 林昭进入宗门`，都是每天都会遇到的事。
 */
function listOf(text: string, ...keys: string[]): unknown[] {
  const obj = objectOf(text);
  if (obj) {
    for (const key of keys) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    // 键名认不出时，取第一个数组值——`{"章节列表":[…]}` 这种也别丢。
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) {
      return firstArray;
    }
  }

  const bare = bareArray(text);
  if (bare) {
    return bare;
  }
  // 最后一层：Markdown 列表。只认真正的列表行，避免把一段说明文字拆成几十项。
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]|\d+[.)、])\s+/.test(line))
    .map((line) => cleanListLine(line))
    .filter(Boolean);
}

function bareArray(text: string): unknown[] | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function cleanListLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s*/, '')
    .replace(/^\**|\**$/g, '')
    .trim();
}

/**
 * 标题长度收口。
 *
 * 标题会变成文件名（`012-<标题>.md`），而模型很爱把一整句梗概当标题。
 * 在标点处断一次再截断，比硬切 18 个字读起来像个标题。
 */
function clipTitle(text: string): string {
  const head = text.split(/[。！？；;\n]/)[0].trim() || text.trim();
  return head.length > 18 ? head.slice(0, 18) : head;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
