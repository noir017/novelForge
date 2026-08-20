/**
 * 一卷的卷纲（`.novelforge/volumes/NN-卷名.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 plotFile.ts / sceneFile.ts / chapterFile.ts 同类；
 * 路径规则与读写在 model/project.ts，解析与渲染只在这里定义一次。
 *
 * ## 为什么要有这一层
 *
 * 从前大纲直接拆成一章一章的细纲。那一步跨度太大：全书大纲那一两千字里
 * 没有足够的信息去决定第 7 章该发生什么，模型只能一次吐出五章骨架，而那
 * 五章彼此的因果薄得像一份目录。更要紧的是，它把「章」当成了规划单位——
 * 而本工程的规划单位是**剧情段**（一段自然长度的剧情，写完再由作者切成章）。
 *
 * 所以中间插一层卷：
 *
 * ```
 * outline.md ──拆──▶ volumes/NN-卷名.md ──拆──▶ plots/NN-卷名/NNN-段名.md
 * ```
 *
 * 一卷是一条完整的中等弧线（几十万字里的一段），它的卷纲写清这一卷从什么
 * 局面开始、经过哪些事、收在什么局面上。**剧情段从卷纲里拆，一次只拆一段**
 * ——有了卷纲这个中等尺度的参照，「下一段该发生什么」才答得准。
 *
 * ## 卷不是一个创作阶段
 *
 * 它只做两件事：**收纳**（剧情段按卷落进 `plots/<卷词干>/`）与**拆分**
 * （从卷纲拆出下一个剧情段）。所以没有独立的 `CreationStage`——分卷与拆段
 * 都是「策划编辑」（`outline` 那个身份）的活，`CreationTarget` 多一个
 * `volume` 而 `stageOfTarget` 把它归到 `outline`。
 *
 * 少一个阶段就少一套配方、一套提示词、一组能力按钮，而卷纲要的恰恰就是
 * 大纲那一套上下文（全书大纲 + 全书摘要）。
 *
 * ## 为什么没有「剧情段一览」小节
 *
 * 与 plotFile.ts 不写「场景一览」是同一条理由：那是 `plots/<卷词干>/` 目录的
 * 派生数据，写进文件就会漂移。要看这一卷有哪些段就现算
 * （core/views/pipeline.ts）。
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
 * 四节。顺序即「读它们的顺序」：先知道这一卷要达成什么，再看剧情怎么走、
 * 关键在哪翻转、埋收了什么。
 *
 * 「剧情走向」是主体，判「这一卷排过没有」只看它，见 {@link isVolumeFilled}。
 * 与细纲的四节刻意不同名：细纲说的是一段剧情内部的事件因果，卷纲说的是
 * 一条中等弧线的走向，两者混用同一组小节名会让装配出来的上下文里两层
 * 长得一模一样，模型分不清自己在写哪一层。
 */
export const VOLUME_SECTION_KEYS = ['目标', '剧情走向', '关键转折', '伏笔与回收'] as const;

export type VolumeSectionKey = (typeof VOLUME_SECTION_KEYS)[number];

export type VolumeSections = Record<VolumeSectionKey, string>;

export interface Volume {
  /** 卷纲文件的工作区相对路径。 */
  relPath: string;
  /** 卷号，来自文件名数字前缀。**文件名是身份**，与细纲/章节/场景同一套规则。 */
  no: number;
  title: string;
  /**
   * 生成这一卷卷纲时所依据的 `outline.md` 内容 hash。
   * 与当前大纲对不上 = 上游已变更，界面上标脏。零模型调用的「变更影响」。
   */
  upstreamHash: string;
  /** 作者手工宣布这一卷完了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  sections: VolumeSections;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

/** 写盘时需要的字段（relPath / body 由调用方与渲染决定）。 */
export type WritableVolume = Omit<Volume, 'relPath' | 'body'>;

export interface VolumeFileName {
  no: number;
  /** 去掉序号前缀与扩展名后的词干，可能为空（如 `03.md`）。 */
  stem: string;
}

/** 卷纲文件只认 markdown 家族——它是插件自己的数据格式，与细纲/场景一致。 */
const VOLUME_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 文件名 → 卷号与词干。不是 `.md`、或没有数字前缀，返回 undefined。
 *
 * 与 parsePlotFileName 一样**先剥扩展名再匹配前缀**：分隔符集合里含 `.`，
 * 直接对整个文件名跑正则的话 `03.md` 会被吃成「第 03 卷 + 词干 md」。
 */
export function parseVolumeFileName(fileName: string): VolumeFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (!VOLUME_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = fileName.slice(0, fileName.length - ext.length);
  const m = /^(\d{1,4})[-_.\s]*(.*)$/.exec(base);
  if (!m) {
    return undefined;
  }
  const no = Number(m[1]);
  // 0 卷没有意义，且会让「第 N 卷」的文案错位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isVolumeFileName(fileName: string): boolean {
  return parseVolumeFileName(fileName) !== undefined;
}

/**
 * 卷号 + 标题 → 文件名。**两位数前缀**，与场景（`NN-标题.md`）对齐：
 * 一本书几百章是常态，几百卷不是。三位数只会让 `plots/001-…/` 那一层的
 * 目录名比它收纳的东西还长。
 *
 * `sanitize` 由调用方（project.ts 的 safeStem）负责；这里只管拼，
 * 保持零 I/O 与零跨层依赖。
 */
export function volumeFileName(no: number, safeTitle: string): string {
  return `${volumeStemName(no, safeTitle)}.md`;
}

/**
 * 卷号 + 标题 → **词干**（不带扩展名），如 `01-觉醒之日`。
 *
 * 它就是这一卷在 `plots/` 下那个目录的名字——卷纲文件与它收纳的剧情段目录
 * 同词干，与「细纲词干 → 场景目录 / 中转站正文」是同一条镜像规则。
 */
export function volumeStemName(no: number, safeTitle: string): string {
  const prefix = String(Math.max(1, Math.trunc(no))).padStart(2, '0');
  return safeTitle ? `${prefix}-${safeTitle}` : prefix;
}

export function emptyVolumeSections(): VolumeSections {
  return { 目标: '', 剧情走向: '', 关键转折: '', 伏笔与回收: '' };
}

/**
 * 这一卷有没有真的排过。
 *
 * 判据是**「剧情走向」非空**，只有它。与 `isPlotFilled` 只认「剧情脉络」
 * 同一条理由：拆卷那一步就把「目标」填上了，每一卷一出生就带着它——拿它
 * 当判据的话，刚拆出来的空壳会全部立刻显示「已规划」，而紧接着的拆段会
 * 照着空壳往下拆。
 */
export function isVolumeFilled(sections: VolumeSections): boolean {
  return meaningful(sections.剧情走向);
}

/**
 * 解析卷纲文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
 * 整份文件被换成大白话都只该退化为「解析出来的少一点」。
 *
 * `no` 以文件名为准而不是 frontmatter 的 `volume`：文件名是身份（作者重排
 * 顺序的方式就是改文件名前缀），frontmatter 里那份只是给人看的。
 */
export function parseVolumeFile(text: string, relPath: string): Volume {
  const { frontmatter, body } = parseMarkdown(text);
  const sections = pickSections<VolumeSectionKey>(body, VOLUME_SECTION_KEYS) as VolumeSections;
  const fromName = parseVolumeFileName(path.basename(relPath));
  return {
    relPath,
    no: fromName?.no ?? asNumber(frontmatter.volume) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    upstreamHash: asString(frontmatter.upstreamHash),
    done: asString(frontmatter.status).toLowerCase() === 'done',
    sections,
    body,
  };
}

/** 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。 */
export function renderVolumeFile(volume: WritableVolume): string {
  const fm = stringifyFrontmatter({
    volume: volume.no,
    title: volume.title,
    upstreamHash: volume.upstreamHash || undefined,
    status: volume.done ? 'done' : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(
    volume.sections as unknown as Record<string, string>,
    VOLUME_SECTION_KEYS,
    { keepEmpty: true }
  );
  const heading = `# 第${volume.no}卷${volume.title ? ` ${volume.title}` : ''} · 卷纲`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

/**
 * 一行摘要，如「1. 觉醒之日」。
 *
 * 给三处共用：工程页的卷行、卷的下拉、装配进 prompt 的分卷一览。
 * 文案只有一份，三处不会分叉。
 *
 * 「第 N 卷《标题》」那个说法在 model/pipeline.ts 的 `volumeLabel`——那个模块
 * 零 import，前端直接打包它，而这里要 `node:path`。
 */
export function describeVolume(volume: Pick<Volume, 'no' | 'title'>): string {
  return `${volume.no}. ${volume.title || '（未命名）'}`;
}

/** 占位文字与空白都不算内容。与 markdown.ts 的 SECTION_PLACEHOLDER 对齐。 */
function meaningful(text: string): boolean {
  const t = text.trim();
  return t !== '' && t !== '（待补充）' && t !== '(待补充)';
}
