/**
 * 一个剧情段的细纲（`.novelforge/plots/<卷词干>/NNN-段名.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts / volumeFile.ts 同类；
 * 路径规则与读写在 model/project.ts，解析与渲染只在这里定义一次。
 *
 * ## 一份细纲 = 一个剧情段，不等于一章
 *
 * 规划的单位是**剧情段**：一段按剧情自然长度展开的内容。它写完之后由作者在
 * 中转站正文里用单独一行 `---` 标断点，切成一到几个发布章
 * （见 features/splitChapter.ts）。所以：
 *
 * - 段号（文件名前缀）只是 `plots/` 里的**排序键**，与章号是两条轴。
 * - 界面上称「剧情 N」，那个 N 是**推导出来的位次**（最新章号 + 在未拆分的段
 *   里排第几），不是文件名里的段号——见 model/pipeline.ts 的 `segmentLabel`。
 * - 拆出去之后 `chapters` 记下落点，这一段就不再是待做项。
 *
 * 段的**归属靠目录**：`plots/01-觉醒之日/003-楼道.md` 属于
 * `volumes/01-觉醒之日.md` 这一卷。不落 frontmatter——目录已经说了，再记一份
 * 就会漂移（与「拆出去的章号不另存一份索引」同一条理由）。还没分卷的老工程把段直接
 * 放在 `plots/` 根下，那是合法的「未分卷」。
 *
 * ## 它不规定这一段从哪开始、到哪结束
 *
 * 旧版有「开头」「结尾」两节，要求写出具体的画面或台词。**画面是写正文时才定的
 * 东西**，写死在细纲里等于拿一句凭空的台词去约束整段文字；更糟的是它逼着每一段
 * 强行收束，而长篇小说的剧情本来就是连续的。
 *
 * 现在细纲只说事件与因果，收在什么局面上写进「剧情脉络」的最后一环即可。
 * 正文因此可以按剧情的自然长度写——写出来先落在中转站 `manuscripts/`，
 * 作者在里面标断点，一份正文可以拆成两章、三章。拆完中转站那份就删掉，
 * `chapters/` 是此后唯一的真相。
 *
 * 所以「不按章生成」与「按章管理」并不矛盾：**前者是给模型的自由度，
 * 后者是作者要的秩序**，中转站是两者之间的那道闸。
 *
 * ## 派生数据一律不写进这份文件
 *
 * 「这一段拆出去的章有几个字」「正文写到几成」都是别处算得出来的东西。写进细纲
 * 就会漂移：作者手删半段正文之后，细纲里那一行还在，而界面上看不出哪份是真的。
 * 要看就现算（core/views/pipeline.ts）。这与「摘要是出场人物的唯一真相、角色卡的
 * appearsIn 只是缓存」是同一个取舍——只是这次连缓存都不落盘。
 *
 * 唯一的例外是 `chapters`（这一段交付到了哪几章）：那不是派生数据，而是**只能
 * 记在这一侧的链**——`chapters/` 下的文件是作者的东西，拆分之后插件一个字节
 * 都不往里改，所以章那一侧无处安放这条指向。
 *
 * ## `targetWords` 是「写够没有」的唯一判据
 *
 * 状态机拿它判这一段的正文写完没有（到八成算写完，见 model/pipeline.ts 的
 * `manuscriptRatio`）。**没写就没有阈值可比**，那时「有字就算写完」——不拿一个
 * 猜出来的数字骗人（比如「一段总得有三千字」）。作者想要精确的判据，就在这里
 * 写一行。
 */
import * as path from 'node:path';
import {
  asArray,
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
 * 见 {@link isPlotFilled}。与卷纲的四节刻意不同名（那边是「剧情走向」），
 * 免得装配出来的上下文里两层长得一模一样。
 */
export const PLOT_SECTION_KEYS = ['目标', '剧情脉络', '冲突与转折', '伏笔与回收'] as const;

export type PlotSectionKey = (typeof PLOT_SECTION_KEYS)[number];

export type PlotSections = Record<PlotSectionKey, string>;

export interface Plot {
  /** 细纲文件的工作区相对路径。 */
  relPath: string;
  /**
   * 段号，来自文件名数字前缀。**文件名是身份**，与发布章节/场景同一套规则。
   *
   * 它只是 `plots/` 里的排序键，**不是章号**：一段可以拆成三章。界面上那个
   * 「剧情 N」是推导出来的位次（见 model/pipeline.ts 的 `segmentLabel`）。
   */
  no: number;
  title: string;
  /**
   * 所属的幕，如「第一幕 · 入局」。**不是卷**——卷由所在目录表达
   * （`plots/01-觉醒之日/`），这个字段留给作者自己标更细的分幕。
   */
  arc: string;
  /** 这一段预计写多少字正文。 */
  targetWords?: number;
  /**
   * 生成这一段细纲时所依据的**卷纲**内容 hash（未分卷的老段是 `outline.md` 的）。
   * 与当前上游对不上 = 上游已变更，界面上标脏。零模型调用的「变更影响」。
   */
  upstreamHash: string;
  /** 作者手工宣布这一段过了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  /**
   * 这一段正文拆出去的**发布章节**路径（frontmatter `chapters`）。
   *
   * 非空 = 这一段已经交付，它的正文此刻躺在 `chapters/` 里，中转站那份已经
   * 删掉了。界面上不再把它当成一个待做的剧情段（见 views/pipeline.ts 的
   * `isConsumed`），点开它所生成的任一章又能回到这份规划稿。
   *
   * **为什么记在细纲这一侧**：`chapters/` 下的文件是作者的东西，拆分之后
   * 插件一个字节都不往里改（第 23 条），所以这条链只能从段指向章。
   *
   * 老工程（以及本层出现之前拆的段）这个字段是空的，那时靠「同号的章存在
   * 且中转站已空」兜底判定，判据只在 views/pipeline.ts 写一次。
   */
  chapters: string[];
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

/** 细纲文件只认 markdown 家族——它是插件自己的数据格式，与角色卡/场景一致。 */
const PLOT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 文件名 → 段号与词干。不是 `.md`、或没有数字前缀，返回 undefined。
 *
 * 与 parseChapterFileName / parseSceneFileName 一样**先剥扩展名再匹配前缀**：
 * 分隔符集合里含 `.`，直接对整个文件名跑正则的话 `007.md` 会被吃成
 * 「第 007 章 + 词干 md」。
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
  // 0 号段没有意义，且会让序号文案错位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isPlotFileName(fileName: string): boolean {
  return parsePlotFileName(fileName) !== undefined;
}

/**
 * 段号 + 标题 → 文件名。三位数前缀，与发布章节对齐——一本书几百段是常态，
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
 * 解析细纲文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
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
    chapters: asArray(frontmatter.chapters),
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
    // 与 `arc` / `targetWords` 同一套写法：空就不写这一行。frontmatter 里
    // 一个空数组和没有这一行是同一个意思，而没有那一行更好读。
    chapters: plot.chapters?.length ? plot.chapters : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS, {
    keepEmpty: true,
  });
  const heading = `# 剧情段 ${plot.no}${plot.title ? ` ${plot.title}` : ''}`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

/**
 * 一行摘要，如「1. 入宗风波 · 第一幕 · 入局」。这里的序号是**段号**（文件名
 * 前缀），只在日志与 prompt 里出现；界面上那个「剧情 N」另有推导，见
 * model/pipeline.ts 的 `segmentLabel`。
 *
 * 给三处共用：创作页的下拉、工程页的行、装配进 prompt 的一览。
 * 文案只有一份，三处不会分叉。
 */
export function describePlot(plot: Pick<Plot, 'no' | 'title' | 'arc'>): string {
  return [`${plot.no}. ${plot.title || '（未命名）'}`, plot.arc].filter((s) => s && s.trim()).join(' · ');
}

/** 占位文字与空白都不算内容。与 markdown.ts 的 SECTION_PLACEHOLDER 对齐。 */
function meaningful(text: string): boolean {
  const t = text.trim();
  return t !== '' && t !== '（待补充）' && t !== '(待补充)';
}
