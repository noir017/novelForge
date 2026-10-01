/**
 * 一章的细纲（`.novelforge/plots/NNN-标题.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts / settingFile.ts 同类；
 * 路径规则与读写在 model/project.ts，解析与渲染只在这里定义一次。
 *
 * ## 一份细纲 = 一章
 *
 * 细纲号（文件名前缀）**就是**章号。从前一份细纲是一个「剧情段」，写完再由作者
 * 标断点切成几章，段号与章号是两条轴；那套跑出来的正文是梗概体的流水账——细纲
 * 太虚、又没有长度锚点。现在一章一份、平铺在 `plots/` 根下（不再按卷分子目录），
 * 正文直接落同号的 `chapters/NNN-标题.md`。
 *
 * ## 它可以写具体场面
 *
 * 旧版明文禁止细纲写画面、动作、台词，只许写抽象的因果链。那是让模型去「扩写」
 * 一条梗概，写出来就是流水账。现在「关键事件」写 100–300 字，**可以写具体场面**
 * ——落在哪几个场面上、谁对谁做了什么；它仍然不是正文（不写成段的描写与对白）。
 * 「章末钩子」必填：每一章都要留一个让人翻下一页的东西。
 *
 * ## frontmatter
 *
 * - `role`：本章在结构里的功能（开篇 / 铺垫 / 小高潮 / 转折……），自由文本。
 * - `characters`：**计划**出场的人。只给装配器挑角色卡用，**不进出场统计**——
 *   出场统计只认摘要（第 14 条），计划与实际混在一起会污染它（D13）。
 * - `targetWords`：这一章写多少字。没写就用 `config.md` 的每章字数。
 * - `upstreamHash`：生成这份细纲时，情节大纲里覆盖本章那一节的指纹。
 * - `writtenFrom`：**正文据以写成的细纲指纹**，由正文落盘那一步记（不是细纲落盘）。
 *   记在细纲这一侧，是因为章节是作者的文件、可以是 `.txt`、没有 frontmatter
 *   （第 9 条），这条链只能从这边指过去。与当前内容指纹对不上 = 细纲在正文之后
 *   改过。从没记过（作者手写的正文）就永不标脏（第 18a 条）。
 * - `status: done`：作者手工宣布这一章过了。只允许向前覆盖推导值。
 * - `preflightOk`：一致性预检的**永久放行**（五期补遗 §2），一行一条「名字：理由」——作者说过
 *   「这一章里他出场是刻意的安排（回忆、幻象……）」的那几个人，写这一章之前不再为他们亮卡。
 *   按章记：第 8 章是回忆，不代表第 12 章再排他也是。**重新生成这一章的细纲会丢掉它**（handlers/plot.ts
 *   的渲染不带它）：重排过的出场是新的安排，要再问一次。改名、记账都原样留着。作者要撤销就删掉那一行。
 *   不进内容指纹（{@link PLOT_SECTION_KEYS} 之外的都不进），记下它不会让正文变成「细纲改过」。
 *
 * ## 派生数据一律不写进这份文件
 *
 * 「这一章写了几个字」「写到几成」都是别处算得出来的东西，写进来就会漂移。
 * 要看就现算（core/views/pipeline.ts）。
 */
import * as path from 'node:path';
import {
  asArray,
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';

/**
 * 三节。顺序即「读它们的顺序」：先知道这一章要达成什么，再看落在哪些事件上，
 * 最后是把读者拽进下一章的那个钩子。判「排过没有」只看「关键事件」，
 * 见 {@link isPlotFilled}。
 */
export const PLOT_SECTION_KEYS = ['本章目的', '关键事件', '章末钩子'] as const;

export type PlotSectionKey = (typeof PLOT_SECTION_KEYS)[number];

/**
 * 模型产出一章细纲时各字段的长度上限（字）。提示词里的合同（context/prompts.ts）与
 * 解码（features/blueprint.ts）共用这一份。
 *
 * 标题会变成文件名（`012-<标题>.md`），所以比上游（AI-Novel-Writer 的
 * `blueprint-semantic-contract.ts`，60 字）紧得多；关键事件的目标是 100–300 字，
 * 硬上限沿用上游的 1200。
 */
export const BLUEPRINT_LIMITS = {
  title: 18,
  role: 30,
  purpose: 240,
  keyEvents: 1200,
  suspenseHook: 160,
  characters: 12,
  name: 32,
} as const;

export type PlotSections = Record<PlotSectionKey, string>;

export interface Plot {
  /** 细纲文件的工作区相对路径。 */
  relPath: string;
  /** 章号，来自文件名数字前缀。**文件名是身份**，与发布章节同一套规则。 */
  no: number;
  title: string;
  /** 本章在结构中的功能，如「小高潮」。 */
  role: string;
  /** 计划出场的人（只给装配器挑角色卡用，见文件头）。 */
  characters: string[];
  /** 这一章预计写多少字正文。 */
  targetWords?: number;
  /** 生成这份细纲时，情节大纲里覆盖本章那一节的指纹。与当前对不上 = 上游变了。 */
  upstreamHash: string;
  /** 正文据以写成的细纲指纹。见文件头。 */
  writtenFrom: string;
  /** 作者手工宣布这一章过了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  /** 一致性预检的永久放行（frontmatter `preflightOk`）。见文件头。 */
  preflightOk: PreflightOk[];
  sections: PlotSections;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

/** 预检永久放行的一条：谁、为什么（作者没写理由时是空串）。 */
export interface PreflightOk {
  name: string;
  reason: string;
}

/** 写盘时需要的字段（relPath / body 由调用方与渲染决定）。`preflightOk` 不给就不写（见文件头）。 */
export type WritablePlot = Omit<Plot, 'relPath' | 'body' | 'writtenFrom' | 'preflightOk'> & {
  writtenFrom?: string;
  preflightOk?: PreflightOk[];
};

/** `沈秋：回忆里的一场` ↔ `{ name, reason }`。全角半角冒号都认；没有冒号就整行是名字。 */
export function parsePreflightOk(lines: readonly string[]): PreflightOk[] {
  const out: PreflightOk[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const at = line.search(/[：:]/u);
    const name = (at >= 0 ? line.slice(0, at) : line).trim();
    if (name && !out.some((x) => x.name === name)) {
      out.push({ name, reason: at >= 0 ? line.slice(at + 1).trim() : '' });
    }
  }
  return out;
}

export function renderPreflightOk(entries: readonly PreflightOk[]): string[] {
  return entries.map((e) => (e.reason.trim() ? `${e.name}：${e.reason.trim()}` : e.name));
}

export interface PlotFileName {
  no: number;
  /** 去掉序号前缀与扩展名后的词干，可能为空（如 `007.md`）。 */
  stem: string;
}

/** 细纲文件只认 markdown 家族——它是插件自己的数据格式，与角色卡一致。 */
const PLOT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 文件名 → 章号与词干。不是 `.md`、或没有数字前缀，返回 undefined。
 *
 * 与 parseChapterFileName 一样**先剥扩展名再匹配前缀**：分隔符集合里含 `.`，
 * 直接对整个文件名跑正则的话 `007.md` 会被吃成「第 007 章 + 词干 md」。
 */
export function parsePlotFileName(fileName: string): PlotFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (!PLOT_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = fileName.slice(0, fileName.length - ext.length);
  const m = /^(\d{1,4})[-_.\s]*(.*)$/.exec(base);
  if (!m) {
    return undefined;
  }
  const no = Number(m[1]);
  // 0 号章没有意义，且会让序号文案错位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isPlotFileName(fileName: string): boolean {
  return parsePlotFileName(fileName) !== undefined;
}

/**
 * 章号 + 标题 → 文件名。三位数前缀，与发布章节对齐——一本书几百章是常态，
 * 两位数不够用。
 *
 * `sanitize` 由调用方（project.ts 的 sanitizeFileName）负责；这里只管拼，
 * 保持零 I/O 与零跨层依赖。
 */
export function plotFileName(no: number, safeTitle: string): string {
  const prefix = String(Math.max(1, Math.trunc(no))).padStart(3, '0');
  return safeTitle ? `${prefix}-${safeTitle}.md` : `${prefix}.md`;
}

export function emptyPlotSections(): PlotSections {
  return { 本章目的: '', 关键事件: '', 章末钩子: '' };
}

/**
 * 这一章有没有真的排过。
 *
 * 判据是**「关键事件」非空**，只有它。「本章目的」一句话就能写，拿它当判据的话
 * 只起了个头的空壳会立刻显示「已规划」，紧接着的批量写正文还会照着空壳往下写。
 * 占位文字（`（待补充）`）不算内容。
 *
 * 老工程里的四节细纲（目标 / 剧情脉络 / …）在这里三节全空——如实说「待写细纲」，
 * 不崩（第 1 条）。那些文件一个字节都不动。
 */
export function isPlotFilled(sections: PlotSections): boolean {
  return hasContent(sections.关键事件);
}

/**
 * 解析细纲文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
 * 整份文件被换成大白话都只该退化为「解析出来的少一点」。
 *
 * `no` 以文件名为准而不是 frontmatter 的 `no`：文件名是身份（作者重排顺序的方式
 * 就是改文件名前缀），frontmatter 里那份只是给人看的。占位文字读回来是空串，
 * 免得「（待补充）」被当成内容送进 prompt。
 */
export function parsePlotFile(text: string, relPath: string): Plot {
  const { frontmatter, body } = parseMarkdown(text);
  const raw = pickSections<PlotSectionKey>(body, PLOT_SECTION_KEYS) as PlotSections;
  const sections = emptyPlotSections();
  for (const key of PLOT_SECTION_KEYS) {
    sections[key] = hasContent(raw[key]) ? raw[key] : '';
  }
  const fromName = parsePlotFileName(path.basename(relPath));
  return {
    relPath,
    no: fromName?.no ?? asNumber(frontmatter.no) ?? asNumber(frontmatter.plot) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    role: asString(frontmatter.role),
    characters: asArray(frontmatter.characters),
    targetWords: positive(asNumber(frontmatter.targetWords)),
    upstreamHash: asString(frontmatter.upstreamHash),
    writtenFrom: asString(frontmatter.writtenFrom),
    done: asString(frontmatter.status).toLowerCase() === 'done',
    preflightOk: parsePreflightOk(asArray(frontmatter.preflightOk)),
    sections,
    body,
  };
}

/** 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。 */
export function renderPlotFile(plot: WritablePlot): string {
  const fm = stringifyFrontmatter({
    no: plot.no,
    title: plot.title,
    role: plot.role || undefined,
    // 空就不写这一行：frontmatter 里一个空数组和没有这一行是同一个意思，
    // 而没有那一行更好读。
    characters: plot.characters?.length ? plot.characters : undefined,
    targetWords: plot.targetWords,
    upstreamHash: plot.upstreamHash || undefined,
    writtenFrom: plot.writtenFrom || undefined,
    status: plot.done ? 'done' : undefined,
    preflightOk: plot.preflightOk?.length ? renderPreflightOk(plot.preflightOk) : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS, {
    keepEmpty: true,
  });
  const heading = `# 第${plot.no}章${plot.title ? ` ${plot.title}` : ''}`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

/**
 * 一行摘要，如「12. 夜入青云 · 小高潮」。给三处共用：创作页的下拉、工程页的行、
 * 装配进 prompt 的前序细纲一览。文案只有一份，三处不会分叉。
 */
export function describePlot(plot: Pick<Plot, 'no' | 'title' | 'role'>): string {
  return [`${plot.no}. ${plot.title || '（未命名）'}`, plot.role].filter((s) => s && s.trim()).join(' · ');
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}
