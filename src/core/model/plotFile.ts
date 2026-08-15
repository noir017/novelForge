/**
 * 剧情段文件（`.novelforge/plots/NNN-标题.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts / sceneFile.ts 同类；路径规则与读写在
 * model/project.ts，解析与渲染只在这里定义一次。
 *
 * ## 剧情段是什么
 *
 * 一段剧情 ≈ 三千字正文的体量，是**创作单位**——它回答「接下来发生什么」，
 * 而不是「这一章从哪开始到哪结束」。这与从前的「章节细纲」有两处关键区别，
 * 两处都是有意的：
 *
 * 1. **不规定起讫。** 旧版有「开头」「结尾」两节，要求写出具体的画面或台词。
 *    那是场景层的活（见 sceneFile.ts 的文件头），而且写死之后还会经
 *    `plotContentHash` 传给场景层当上游指纹，等于用画面去约束画面。剧情段
 *    只说事件与因果，收在什么局面上写进「剧情脉络」的最后一环即可。
 * 2. **不等于发布章节。** 作者最后一定要把正文切成章节才好发布，但那是正文
 *    出来之后的事。生成时被「一章要有头有尾」框住，换来的是每一段都在强行
 *    收束——而长篇小说的剧情本来就是连续的。切章由作者在 `chapters/` 里
 *    自己做，工具不插手（不分析、不提示、不挂状态）。
 *
 * ## 为什么没有「场景一览」小节
 *
 * 场景列表是 `scenes/` 目录的派生数据。写进细纲文件就会漂移：作者删了一个
 * 场景文件，细纲里那一行还在，而界面上看不出哪份是真的。要看场景列表就现算
 * （core/views/pipeline.ts）。这与「摘要是出场人物的唯一真相、角色卡的 appearsIn
 * 只是缓存」是同一个取舍——只是这次连缓存都不落盘。
 */
import * as path from 'node:path';
import {
  asNumber,
  asString,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';

/**
 * 四节。顺序即「读它们的顺序」：先知道这一段要达成什么，再看事件怎么走、
 * 冲突在哪翻转、埋收了什么。
 *
 * 「剧情脉络」是主体，其余三节都是对它的补充说明——判「排过没有」只看它，
 * 见 {@link isPlotFilled}。
 */
export const PLOT_SECTION_KEYS = ['目标', '剧情脉络', '冲突与转折', '伏笔与回收'] as const;

export type PlotSectionKey = (typeof PLOT_SECTION_KEYS)[number];

export type PlotSections = Record<PlotSectionKey, string>;

export interface Plot {
  /** 剧情段文件的工作区相对路径。 */
  relPath: string;
  /** 段号，来自文件名数字前缀。**文件名是身份**，与章节/场景同一套规则。 */
  no: number;
  title: string;
  /** 所属幕/卷，如「第一幕 · 入局」。先用一个字段表达，暂不单开 arcs/ 层。 */
  arc: string;
  /** 这一段预计写多少字正文。 */
  targetWords?: number;
  /**
   * 生成这一段时所依据的 `outline.md` 内容 hash。
   * 与当前大纲对不上 = 上游已变更，界面上标脏。零模型调用的「变更影响」。
   */
  upstreamHash: string;
  /** 作者手工宣布这一段过了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  sections: PlotSections;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

/** 写盘时需要的字段（relPath / body 由调用方与渲染决定）。 */
export type WritablePlot = Omit<Plot, 'relPath' | 'body'>;

export interface PlotFileName {
  no: number;
  /** 去掉序号前缀与扩展名后的词干，可能为空（如 `007.md`）。 */
  stem: string;
}

/** 剧情段文件只认 markdown 家族——它是插件自己的数据格式，与角色卡/场景一致。 */
const PLOT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 文件名 → 段号与词干。不是 `.md`、或没有数字前缀，返回 undefined。
 *
 * 与 parseChapterFileName / parseSceneFileName 一样**先剥扩展名再匹配前缀**：
 * 分隔符集合里含 `.`，直接对整个文件名跑正则的话 `007.md` 会被吃成
 * 「第 007 段 + 词干 md」。
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
  // 0 号段没有意义，且会让「第 N 段」的文案错位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isPlotFileName(fileName: string): boolean {
  return parsePlotFileName(fileName) !== undefined;
}

/**
 * 段号 + 标题 → 文件名。三位数前缀，与章节对齐——一本书几百段是常态，
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
  return { 目标: '', 剧情脉络: '', 冲突与转折: '', 伏笔与回收: '' };
}

/**
 * 这一段有没有真的排过剧情。
 *
 * 判据是**「剧情脉络」非空**，只有它。旧版认「本章目标 或 冲突与节奏」，
 * 那时目标是一句话概括，够用；现在拆段那一步就把「目标」填上了，每一段
 * 一出生就带着它——拿它当判据的话，刚拆出来的空壳会全部立刻显示「已规划」，
 * 流水线状态从此撒谎，紧接着的批量拆场景还会照着空壳往下拆。
 *
 * 这与 `isSceneReady` 排除「目的」是同一条理由。占位文字（`（待补充）`）
 * 不算内容。
 */
export function isPlotFilled(sections: PlotSections): boolean {
  return meaningful(sections.剧情脉络);
}

/**
 * 解析剧情段文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
 * 整份文件被换成大白话都只该退化为「解析出来的少一点」。
 *
 * `no` 以文件名为准而不是 frontmatter 的 `plot`：文件名是身份（作者重排
 * 顺序的方式就是改文件名前缀），frontmatter 里那份只是给人看的。
 */
export function parsePlotFile(text: string, relPath: string): Plot {
  const { frontmatter, body } = parseMarkdown(text);
  const sections = pickSections<PlotSectionKey>(body, PLOT_SECTION_KEYS) as PlotSections;
  const fromName = parsePlotFileName(path.basename(relPath));
  return {
    relPath,
    no: fromName?.no ?? asNumber(frontmatter.plot) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    arc: asString(frontmatter.arc),
    targetWords: asNumber(frontmatter.targetWords),
    upstreamHash: asString(frontmatter.upstreamHash),
    done: asString(frontmatter.status).toLowerCase() === 'done',
    sections,
    body,
  };
}

/** 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。 */
export function renderPlotFile(plot: WritablePlot): string {
  const fm = stringifyFrontmatter({
    plot: plot.no,
    title: plot.title,
    arc: plot.arc || undefined,
    targetWords: plot.targetWords,
    upstreamHash: plot.upstreamHash || undefined,
    status: plot.done ? 'done' : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS, {
    keepEmpty: true,
  });
  const heading = `# 第${plot.no}段${plot.title ? ` ${plot.title}` : ''} · 剧情`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

/**
 * 一行摘要，如「1. 入宗风波 · 第一幕 · 入局」。
 *
 * 给三处共用：创作页的段落下拉、工程页的剧情行、装配进 prompt 的段落一览。
 * 文案只有一份，三处不会分叉。
 *
 * 「第 N 段《标题》」那个说法在 model/pipeline.ts 的 `plotLabel`——那个模块
 * 零 import，前端直接打包它，而这里要 `node:path`。
 */
export function describePlot(plot: Pick<Plot, 'no' | 'title' | 'arc'>): string {
  return [`${plot.no}. ${plot.title || '（未命名）'}`, plot.arc].filter((s) => s && s.trim()).join(' · ');
}

/** 占位文字与空白都不算内容。与 markdown.ts 的 SECTION_PLACEHOLDER 对齐。 */
function meaningful(text: string): boolean {
  const t = text.trim();
  return t !== '' && t !== '（待补充）' && t !== '(待补充)';
}
