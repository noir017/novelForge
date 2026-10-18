/**
 * 一章的细纲（`.novelforge/summaries/NNN-标题.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts / settingFile.ts 同类；
 * 路径规则与读写在 model/project.ts，解析与渲染只在这里定义一次。
 *
 * ## 一份细纲 = 一章，前后两个阶段是同一份文件
 *
 * 细纲号（文件名前缀）**就是**章号，平铺在 `summaries/` 根下（子目录不认），
 * 正文落同号的 `chapters/NNN-标题.md`。
 *
 * - **写正文之前它是计划**：正文照它写。
 * - **定稿之后它是档案**：作者点「定稿」，模型拿着它与正文把它改成正文实际写成的样子
 *   （反向更新，features/summarize.ts）——正文写偏的改掉、没写到的删掉、一致的保留原措辞。
 *
 * 从前计划（`plots/` 三节）与档案（单章摘要）各存一份。作者的原则是相似的东西不留两份，
 * 摘要那一套更完善，于是细纲换成了摘要的八节；`plots/` 不再读（老工程里那个目录判成
 * `other`，一个字节都不动）。
 *
 * ## 它可以写具体场面
 *
 * 旧版明文禁止细纲写画面、动作、台词，只许写抽象的因果链。那是让模型去「扩写」
 * 一条梗概，写出来就是流水账。现在「关键事件」按发生的顺序一条一件事、合计 100–300 字，
 * 每条**可以写具体场面**——谁在哪、对谁做了什么、结果怎样；它仍然不是正文（不写成段的描写
 * 与对白）。计划与定稿都是一条一行的列表，定稿时才能逐条改，而不是把一整段重写一遍。
 * 「看点」写爽点，也写章末吊着读者的那一下（从前单列的「章末钩子」并进了这里）。
 *
 * ## frontmatter
 *
 * - `targetWords`：这一章写多少字。没写就用 `config.md` 的每章字数。
 * - `upstreamHash`：生成这份细纲时，情节大纲里覆盖本章那一节的指纹。
 * - `writtenFrom`：**正文据以写成的细纲指纹**，正文落盘那一步记，定稿时刷成反向更新之后的指纹。
 *   记在细纲这一侧，是因为章节是作者的文件、可以是 `.txt`、没有 frontmatter
 *   （第 9 条），这条链只能从这边指过去。与当前内容指纹对不上 = 细纲在正文（或定稿）之后
 *   改过，正文挂 ⟳。从没记过（作者手写的正文）就永不标脏（第 18a 条）。
 * - `sourceHash`：定稿时正文的 `contentHash`。**有它就表示这份细纲反向更新过**；与正文现在的
 *   指纹对得上才算这一章写完（第 23 条）。
 * - `cast`：定稿时记的**实际**出场，`林昭(阿昭)` 一项一人，给出场统计读（第 14 条）。定稿之前
 *   「出场人物」一节写的是**计划**出场，只给装配器挑角色卡、算「后几章才出场的人」、做一致性预检，
 *   **不进出场统计**——计划与实际混在一起会污染它（D13）。
 * - `status: done`：作者手工宣布这一章过了。只允许向前覆盖推导值。
 * - `preflightOk`：一致性预检的**永久放行**（五期补遗 §2），一行一条「名字：理由」——作者说过
 *   「这一章里他出场是刻意的安排（回忆、幻象……）」的那几个人，写这一章之前不再为他们亮卡。
 *   按章记：第 8 章是回忆，不代表第 12 章再排他也是。**重新生成这一章的细纲会丢掉它**（handlers/plot.ts
 *   的渲染不带它）：重排过的出场是新的安排，要再问一次。改名、记账、定稿都原样留着。作者要撤销就删掉那一行。
 *   不进内容指纹（{@link PLOT_SECTION_KEYS} 之外的都不进），记下它不会让正文变成「细纲改过」。
 * - `factCheckOk: true`：批量写章写前冲突检查（features/plotCheck.ts）的放行。检查说本章细纲与前面
 *   定稿的事实矛盾、作者看过认为是刻意安排时手写这一行；与 `preflightOk` 一样不进内容指纹。
 *
 * 老工程 `summaries/` 根下的单章摘要（`001-楔子.md`）本来就是这八节，带着 `sourceHash` 与 `cast`，
 * 直接当成定稿过的细纲读；它 frontmatter 里的 `chapter:` 不认，章号取文件名前缀。
 *
 * ## 派生数据一律不写进这份文件
 *
 * 「这一章写了几个字」「写到几成」都是别处算得出来的东西，写进来就会漂移。
 * 要看就现算（core/views/pipeline.ts）。
 */
import * as path from 'node:path';
import { hash } from './fs';
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
import { castFromText, parseCast, parseCastEntry, renderCastEntry } from './castParse';
import type { SummaryCast } from './types';

/**
 * 八节，照单章摘要原来的那八节。顺序即「读它们的顺序」：先知道这一章发生了什么、谁在、
 * 在哪，再看落在哪些事件上，然后是吊着读者的看点、埋下的线、人物变成了什么样，最后是
 * 后面各章必须保持一致的事实。判「排过没有」只看「关键事件」，见 {@link isPlotFilled}。
 */
export const PLOT_SECTION_KEYS = [
  '梗概',
  '出场人物',
  '时间地点',
  '关键事件',
  '看点',
  '新增伏笔',
  '状态变更',
  '连续性事实',
] as const;

export type PlotSectionKey = (typeof PLOT_SECTION_KEYS)[number];

/**
 * 八节的内容。缺失的小节为空串。
 *
 * - 「看点」：读者最爽、最想往下看的地方（爽点与章末吊着读者的东西）。拆书整理架构与大纲时靠它提炼卖点。
 * - 「连续性事实」：后面各章必须保持一致的事实，一条一行，每条挂一句正文里的证据原文（D18）：
 *   `- 林昭左臂被划伤，未愈 〔证据：「血顺着左臂往下淌」〕`。格式与解析在 model/continuity.ts。
 *   计划时是空的（证据句要回原文定位，没有正文就没法定位），定稿时才生成；写正文时不拿这一节
 *   当事实，而是拿证据原句回到那一章的正文里取原文段落（`evidence` 层）。
 */
export type PlotSections = Record<PlotSectionKey, string>;

/**
 * 模型排一章细纲时各字段的长度上限（字）。提示词里的合同（context/prompts.ts）与
 * 解码（features/blueprint.ts）共用这一份。
 *
 * 标题会变成文件名（`012-<标题>.md`），所以比上游（AI-Novel-Writer 的
 * `blueprint-semantic-contract.ts`，60 字）紧得多。关键事件是一条一件事的列表（与定稿时
 * 写出来的一样），合同要 3–6 条、合计 100–300 字；条数硬上限 8，总字数硬上限沿用上游的 1200。
 * 看点与新增伏笔是一条一句的列表。
 */
export const BLUEPRINT_LIMITS = {
  title: 18,
  synopsis: 400,
  timePlace: 120,
  /** 关键事件所有条目加起来最多几个字。 */
  keyEvents: 1200,
  /** 关键事件最多几条。 */
  keyEventItems: 8,
  /** 看点、新增伏笔各最多几条。 */
  listItems: 5,
  /** 看点、新增伏笔每条最多几个字。 */
  listItem: 120,
  stateChange: 400,
  characters: 12,
  name: 32,
} as const;

export interface Plot {
  /** 细纲文件的工作区相对路径。 */
  relPath: string;
  /** 章号，来自文件名数字前缀。**文件名是身份**，与发布章节同一套规则。 */
  no: number;
  title: string;
  /**
   * 这一章出场的人（只有名字）。定稿过（有 `sourceHash`）取 `cast`——实际出场；没定稿取
   * 「出场人物」一节——**计划**出场，只给装配器挑角色卡、预检用（见文件头）。
   */
  characters: string[];
  /**
   * 结构化的出场人物：frontmatter 的 `cast`，没有就从「出场人物」一节反解（手写的老摘要）。
   * **只有定稿过的细纲**这一份才是实际出场，出场统计据此过滤（`sourceHash`）。
   */
  cast: SummaryCast[];
  /** 这一章预计写多少字正文。 */
  targetWords?: number;
  /** 生成这份细纲时，情节大纲里覆盖本章那一节的指纹。与当前对不上 = 上游变了。 */
  upstreamHash: string;
  /** 正文据以写成的细纲指纹。见文件头。 */
  writtenFrom: string;
  /** 定稿时正文的 contentHash。空串 = 从没定稿过。见文件头。 */
  sourceHash: string;
  /** 作者手工宣布这一章过了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  /** 一致性预检的永久放行（frontmatter `preflightOk`）。见文件头。 */
  preflightOk: PreflightOk[];
  /** 写前冲突检查的放行（frontmatter `factCheckOk: true`）。见文件头。 */
  factCheckOk?: boolean;
  sections: PlotSections;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

/** 预检永久放行的一条：谁、为什么（作者没写理由时是空串）。 */
export interface PreflightOk {
  name: string;
  reason: string;
}

/**
 * 写盘时需要的字段（relPath / body 由调用方与渲染决定）。出场的人写在「出场人物」一节里，
 * `characters` 是读回来时推出来的，不写。`preflightOk` 不给就不写（见文件头）。
 */
export type WritablePlot = Omit<
  Plot,
  'relPath' | 'body' | 'characters' | 'cast' | 'writtenFrom' | 'sourceHash' | 'preflightOk' | 'factCheckOk'
> & {
  writtenFrom?: string;
  sourceHash?: string;
  cast?: SummaryCast[];
  preflightOk?: PreflightOk[];
  factCheckOk?: boolean;
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
 * `global.md`（全书摘要）没有数字前缀，天然不是细纲。
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
  return {
    梗概: '',
    出场人物: '',
    时间地点: '',
    关键事件: '',
    看点: '',
    新增伏笔: '',
    状态变更: '',
    连续性事实: '',
  };
}

/**
 * 这一章有没有真的排过。
 *
 * 判据是**「关键事件」非空**，只有它。「梗概」一句话就能写，拿它当判据的话
 * 只起了个头的空壳会立刻显示「已规划」，紧接着的批量写正文还会照着空壳往下写。
 * 占位文字（`（待补充）`）不算内容。
 */
export function isPlotFilled(sections: PlotSections): boolean {
  return hasContent(sections.关键事件);
}

/** 行首的列表记号：`- ` `* ` `· ` `• ` `1.` `1、` `1)`。 */
const LIST_MARKER = /^\s*(?:[-*·•]|\d+[.、)．])\s*/u;

/**
 * 一条一行的那几节（关键事件、看点、新增伏笔）→ 一条一项：按行切，去掉行首的列表记号，
 * 空行与占位文字（`（待补充）`）不算。**只按换行切**——一条里本来就可以有分号；
 * 作者手写成一整段的就是一项。
 */
export function sectionItems(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => hasContent(line));
}

/**
 * 一条一行的那几节压成一行，条与条之间用「；」接。给一章一行的一览用（前序细纲一览、
 * 写正文的边界、排叙事线）：直接把换行换成空格会得到「- 甲 - 乙」。
 */
export function sectionLine(text: string): string {
  return sectionItems(text).join('；');
}

/**
 * 细纲的内容指纹——**这一章正文的上游**。
 *
 * 只哈希**八个小节**，不含 frontmatter：`upstreamHash` / `writtenFrom` / `sourceHash` / `cast`
 * 自己就在 frontmatter 里，把它算进去会让「排一次细纲」「定稿一次」立刻使刚写好的正文过期。
 * 同理不含 `status`、`preflightOk`、`factCheckOk` 与标题——作者把这一章标成 done、记一条预检放行、
 * 改个标题，都不该让它的正文标脏。
 */
export function plotContentHash(plot: Pick<Plot, 'sections'>): string {
  return hash(PLOT_SECTION_KEYS.map((key) => plot.sections[key]).join('\n---\n'));
}

/**
 * 「出场人物」一节 → 计划出场的名字。按顿号、逗号、斜杠、分号、换行切开，去掉列表符号，
 * `林昭(阿昭)` 只取名字。括号里的斜杠不切（那是别名的分隔）。
 *
 * 与 `castFromText` 不同，这里**不按长度与虚词过滤**：那两条是为了挡住模型把定稿的这一节
 * 写成句子，计划里的名单是作者与排细纲的模型写的，「沈从文」这种名字不该因为带个「从」就漏掉。
 */
export function plannedNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim();
    if (!hasContent(cleaned)) {
      continue;
    }
    for (const part of splitOutsideBrackets(cleaned)) {
      const name = parseCastEntry(part)?.name.trim().slice(0, BLUEPRINT_LIMITS.name);
      if (name && !/^(无|暂无|没有|未知)$/.test(name) && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

/** 按顶层的分隔符切开：括号里的 `、` `/` 是别名分隔，不切。 */
function splitOutsideBrackets(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '（') {
      depth++;
    } else if ((ch === ')' || ch === '）') && depth > 0) {
      depth--;
    }
    if (depth === 0 && /[、,，/;；]/.test(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * 解析细纲文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
 * 整份文件被换成大白话都只该退化为「解析出来的少一点」。
 *
 * `no` 以文件名为准而不是 frontmatter 的 `no`：文件名是身份（作者重排顺序的方式
 * 就是改文件名前缀），frontmatter 里那份只是给人看的；老摘要的 `chapter:` 不认。
 * 占位文字读回来是空串，免得「（待补充）」被当成内容送进 prompt。
 */
export function parsePlotFile(text: string, relPath: string): Plot {
  const { frontmatter, body } = parseMarkdown(text);
  const raw = pickSections<PlotSectionKey>(body, PLOT_SECTION_KEYS) as PlotSections;
  const sections = emptyPlotSections();
  for (const key of PLOT_SECTION_KEYS) {
    sections[key] = hasContent(raw[key]) ? raw[key] : '';
  }
  const fromName = parsePlotFileName(path.basename(relPath));
  const sourceHash = asString(frontmatter.sourceHash);
  // frontmatter 的 cast 是结构化真相；没有它（作者手写的老摘要）就从「出场人物」小节反解。
  const cast = parseCast(frontmatter.cast) ?? castFromText(sections.出场人物);
  return {
    relPath,
    no: fromName?.no ?? asNumber(frontmatter.no) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    characters: sourceHash ? cast.map((c) => c.name) : plannedNames(sections.出场人物),
    cast,
    targetWords: positive(asNumber(frontmatter.targetWords)),
    upstreamHash: asString(frontmatter.upstreamHash),
    writtenFrom: asString(frontmatter.writtenFrom),
    sourceHash,
    done: asString(frontmatter.status).toLowerCase() === 'done',
    preflightOk: parsePreflightOk(asArray(frontmatter.preflightOk)),
    ...(asString(frontmatter.factCheckOk).toLowerCase() === 'true' ? { factCheckOk: true } : {}),
    sections,
    body,
  };
}

/** 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。 */
export function renderPlotFile(plot: WritablePlot): string {
  const fm = stringifyFrontmatter({
    no: plot.no,
    title: plot.title,
    targetWords: plot.targetWords,
    upstreamHash: plot.upstreamHash || undefined,
    writtenFrom: plot.writtenFrom || undefined,
    sourceHash: plot.sourceHash || undefined,
    // 机器可读的实际出场，只在定稿时写。别名跟在名字后的括号里：`林昭(阿昭)`——
    // frontmatter 解析器只认字符串数组，不要为此引入嵌套 YAML。
    cast: plot.sourceHash && plot.cast ? plot.cast.map(renderCastEntry) : undefined,
    status: plot.done ? 'done' : undefined,
    preflightOk: plot.preflightOk?.length ? renderPreflightOk(plot.preflightOk) : undefined,
    factCheckOk: plot.factCheckOk ? 'true' : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS, {
    keepEmpty: true,
  });
  const heading = `# 第${plot.no}章${plot.title ? ` ${plot.title}` : ''}`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}
