import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readConfig } from '../config';
import {
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
  CharacterSections,
  LoreEntry,
  MANIFEST_VERSION,
  NovelConfig,
  ProjectManifest,
} from './types';
import {
  asArray,
  asNumber,
  asNumberArray,
  asString,
  extractH1,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
  stripH1,
} from './markdown';
import { isChapterFileName, isMarkdownExt, isMarkdownPath, parseChapterFileName } from './chapterFile';
import { Plot, isPlotFileName, parsePlotFile, parsePlotFileName, plotFileName } from './plotFile';
import { loreCategoryOfSlug } from './loreFile';
import {
  BookConfig,
  SETTING_FILE_DOCS,
  SettingDocFile,
  SettingFileDoc,
  isSettingFilled,
  parseBookConfig,
  parseSettingDoc,
  settingTemplate,
} from './settingFile';
import { SettingDoc, isFallbackChapterTitle, isLoreListFilled } from './pipeline';
import { Thread, parseThreads } from './threadsFile';
import {
  countWords,
  exists,
  hash,
  isIgnoredDir,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from './fs';
import { FinalizedFacts, parseContinuityFacts } from './continuity';
import { normalizeGender } from './gender';
import { SENSITIVE_FILE_NAME } from './sensitiveWords';

const NOVEL_DIR = '.novelforge';
/** 0.1.x 用的目录名。检测到就提示迁移，不静默改动用户文件。 */
const LEGACY_NOVEL_DIR = '.novel';
const MANIFEST_FILE = 'project.json';

/** 递归扫描的深度上限。防御性的：正常工程不会有这么深的卷/册嵌套。 */
const MAX_TREE_DEPTH = 8;

/**
 * 小说工程的数据访问层。
 *
 * 约定：所有 read* 方法每次都读盘（作者随时可能在编辑器里手改文件），
 * 只有章节列表做了一层缓存，由 FileSystemWatcher 主动失效。
 *
 * ## 一条轴，细纲镜像正文的路径
 *
 * 细纲（`summaries/` 下）**镜像正文在章节根下的相对路径**，扩展名换成 `.md`：
 * `chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`，与草稿（`drafts/`）同一套镜像。
 * 有正文的章**按路径**认它的细纲（{@link plotPathForChapter}），定稿反向更新的也是这一份；
 * 还没有正文的章只有细纲，按文件名的章号认，正文照它的路径反推着落（{@link chapterPathForPlot}）。
 * 章号仍取文件名数字前缀，界面上一律称「第 N 章」。
 *
 * 从前规划的单位是「剧情段」、发布的单位是章，两条轴之间隔着一个中转站（`manuscripts/`）；
 * 一章一纲之后那一层删掉了。细纲从前另放在 `plots/`、定稿另写一份单章摘要，两份并成一份之后
 * `plots/` 也不读了。老工程磁盘上的 `volumes/`、`manuscripts/`、`plots/` 一个字节都不动，
 * 这里只是不再读它们。
 *
 * 架构层的三份文档（`config.md` / `premise.md` / `world.md`）与大纲、文风同级，
 * 格式定义在 model/settingFile.ts。
 *
 * 章节 / 角色 / 设定三个目录都是**递归扫描**的：作者可以按卷、按阵营
 * 分子目录整理。角色 / 设定只认 `.md`（那是插件自己的数据格式）；章节
 * 则认「数字前缀 + 非二进制扩展名」的任意文件（见 model/chapterFile.ts）。
 * 章节的顺序始终由文件名的数字前缀决定，与它在哪一层无关。
 */
export class NovelProject {
  private chapterCache: Chapter[] | undefined;
  private plotCache: Plot[] | undefined;

  /**
   * 正在进行的 `listChapters()` / `listPlots()`。
   *
   * 缓存只在扫完之后才填得上，所以**并发**的两个调用方都会看到空缓存，
   * 各扫一遍全书。`buildProjectTree` 正是这样：`Promise.all` 里
   * `listChapters()` 与 `buildPipelineIndex()` 同时起跑，五百章工程于是
   * 把细纲读了两遍（流水线一遍、出场索引一遍）。记住这个在途的
   * promise，让后来者搭同一班车。
   */
  private chapterScan: Promise<Chapter[]> | undefined;
  private plotScan: Promise<Plot[]> | undefined;

  /**
   * 缓存的世代号。`invalidate()` 让它 +1。
   *
   * 光把 `*Scan` 清空不够：在途的那一轮**仍会跑完**，然后把变更之前的
   * 结果写进缓存，于是刚改过的东西又被旧数据盖回去。扫描结束时比一下世代号，
   * 对不上就只把结果给等它的人，不落缓存。两条轴共用一个号：`invalidate()`
   * 本来就是「磁盘变过了」这一件事，分开记没有意义。
   */
  private generation = 0;

  private constructor(public readonly root: string) {}

  /** 以某目录为工程根打开实例（不做初始化检查）。 */
  static open(root: string): NovelProject {
    return new NovelProject(path.resolve(root));
  }

  // ---------------------------------------------------------------- 路径

  get config(): NovelConfig {
    return readConfig();
  }

  get chaptersDir(): string {
    return path.join(this.root, this.config.chaptersDir);
  }

  /**
   * 草稿根目录。与 chapters/ 平级的兄弟目录，**不从 chaptersDir 派生**——
   * 作者把正文目录改名成 `正文/` 时，草稿仍然落在 `drafts/` 下。
   */
  get draftsDir(): string {
    return path.join(this.root, this.config.draftsDir);
  }

  get novelDir(): string {
    return path.join(this.root, NOVEL_DIR);
  }

  get manifestPath(): string {
    return path.join(this.novelDir, MANIFEST_FILE);
  }

  get stylePath(): string {
    return path.join(this.novelDir, 'style.md');
  }

  get outlinePath(): string {
    return path.join(this.novelDir, 'outline.md');
  }

  /** 叙事线（七期）。可选：没有这份文件就是还没排过，初始化时不建。 */
  get threadsPath(): string {
    return path.join(this.novelDir, 'threads.md');
  }

  /**
   * 本工程的写作技能（`.novelforge/skills/<名字>/SKILL.md`）。可选：作者手放进来的，
   * 初始化时不建。我的技能库在工程外（`~/.novelforge/skills/`），见 core/skills/。
   */
  get skillsDir(): string {
    return path.join(this.novelDir, 'skills');
  }

  /** 这个工程每个阶段绑了哪份技能（`.novelforge/skills.json`）。没绑过就没有这份文件。 */
  get skillBindingsPath(): string {
    return path.join(this.novelDir, 'skills.json');
  }

  /**
   * 自定义敏感词表（`.novelforge/sensitive.txt`，格式见 `model/sensitiveWords.ts`）。可选：作者在内置编辑器里点
   * 「编辑敏感词表…」时才建。只给编辑器的写作体检用，不进生成链。
   */
  get sensitivePath(): string {
    return path.join(this.novelDir, SENSITIVE_FILE_NAME);
  }

  get charactersDir(): string {
    return path.join(this.novelDir, 'characters');
  }

  get loreDir(): string {
    return path.join(this.novelDir, 'lore');
  }

  /** `summaries/`：一章一份的细纲，外加全书摘要 `global.md`。 */
  get summariesDir(): string {
    return path.join(this.novelDir, 'summaries');
  }

  /**
   * 细纲（`.novelforge/summaries/`）。一章一份，**镜像正文的相对路径**：`chapters/第一卷/012-夜入青云.md`
   * 的细纲是 `summaries/第一卷/012-夜入青云.md`。各级子目录里数字开头的 `.md` 都是细纲，根下的
   * `global.md` 是全书摘要。老工程的 `plots/` 不再扫描——那些文件一个字节都不动。
   */
  get plotsDir(): string {
    return this.summariesDir;
  }

  /** 小说配置（`.novelforge/config.md`）：类型、卖点、规模参数。 */
  get configPath(): string {
    return path.join(this.novelDir, 'config.md');
  }

  /** 故事前提（`.novelforge/premise.md`）。 */
  get premisePath(): string {
    return path.join(this.novelDir, 'premise.md');
  }

  /** 世界观（`.novelforge/world.md`）。 */
  get worldPath(): string {
    return path.join(this.novelDir, 'world.md');
  }

  /** 架构文档的绝对路径。角色图谱、设定清单没有自己的文件，给的是角色目录、设定目录。 */
  settingPath(doc: SettingDoc): string {
    switch (doc) {
      case 'config':
        return this.configPath;
      case 'premise':
        return this.premisePath;
      case 'world':
        return this.worldPath;
      case 'characters':
        return this.charactersDir;
      case 'lore':
        return this.loreDir;
    }
  }

  get sessionsDir(): string {
    return path.join(this.novelDir, 'sessions');
  }

  /** 删除的东西搬这里，不真删。落点（保留原相对路径、同名加序号）见 {@link trashPathFor}，会话删除也用它。 */
  get trashDir(): string {
    return path.join(this.novelDir, '.trash');
  }

  /**
   * 历史版本（`.novelforge/history/`）：网关覆盖一份创作产物之前存下的旧内容，镜像原文件的相对路径
   * （布局与节流见 workspace/history.ts）。是网关自己存的副本，不是作者的文件。
   */
  get historyDir(): string {
    return path.join(this.novelDir, 'history');
  }

  /** 0.1.x 的 `.novel/` 目录，仅用于迁移检测。 */
  get legacyNovelDir(): string {
    return path.join(this.root, LEGACY_NOVEL_DIR);
  }

  get globalSummaryPath(): string {
    return path.join(this.summariesDir, 'global.md');
  }

  /** 正文在章节根下的那段相对路径（正斜杠）。不在章节根下（配置被改坏等）时 undefined。 */
  private underChapters(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    return under.replace(/\\/g, '/');
  }

  /**
   * 正文（文件或目录）→ 细纲那边的镜像（工作区相对路径，正斜杠）。不在章节根下时 undefined。
   *
   * 文件：扩展名换成 `.md`（{@link plotPathForChapter} 用的就是它）。
   * 目录：原样镜像——搬 `chapters/卷一/` 时 `summaries/卷一/` 整棵跟着走（`handlers/chapter.ts` 的 `carryPlot`）。
   * 纯计算，不碰磁盘。
   */
  plotMirrorOf(chapterRelPath: string, isDir = false): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (!under) {
      return undefined;
    }
    const parsed = path.posix.parse(under);
    const mirror = isDir ? under : path.posix.join(parsed.dir, `${parsed.name}.md`);
    return this.relPath(path.join(this.plotsDir, mirror));
  }

  /**
   * 正文 → 它的细纲落在哪（工作区相对路径，正斜杠）。纯计算，文件可能并不存在。
   *
   * **镜像正文在章节根下的相对路径**，扩展名换成 `.md`（与草稿 {@link draftRelPathFor} 同一套）：
   *   `chapters/第一卷/003-深处.txt` → `.novelforge/summaries/第一卷/003-深处.md`
   *   `chapters/001 序.txt`          → `.novelforge/summaries/001 序.md`
   * 同号的两个文件（`001 序.txt` 与 `001 正文.txt`）于是各有各的细纲，互不覆盖。
   * 正文不在章节根下（配置被改坏）时退回 `summaries/NNN.md`，绝不抛。
   */
  plotPathForChapter(chapterRelPath: string): string {
    const mirror = this.plotMirrorOf(chapterRelPath);
    if (mirror) {
      return mirror;
    }
    const order = parseChapterFileName(path.basename(chapterRelPath))?.order ?? 0;
    return this.relPath(path.join(this.plotsDir, plotFileName(order, '')));
  }

  /**
   * 细纲 → 照它写出来的正文该叫什么（{@link plotPathForChapter} 的逆运算，扩展名 `.md`）：
   *   `.novelforge/summaries/第二卷/010-雪夜.md` → `chapters/第二卷/010-雪夜.md`
   * 不在 `summaries/` 下的路径给 undefined。纯计算，不碰磁盘。
   */
  chapterPathForPlot(plotRelPath: string): string | undefined {
    const under = path.relative(this.plotsDir, this.pathOf(plotRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    const parsed = path.posix.parse(under.replace(/\\/g, '/'));
    return this.relPath(path.join(this.chaptersDir, parsed.dir, `${parsed.name}.md`));
  }

  /**
   * 还没有正文、也还没有细纲的第 N 章落在哪个子目录（相对章节根与 `summaries/` 的同一段，`''` = 根）：
   * **跟上一章放在一起**。上一章 = 章号比它小的里面最大的那一章；它有正文看正文所在的子目录，
   * 只有细纲看细纲所在的子目录。前面一章都没有就是根。
   *
   * 分卷的书写到第二卷时，新排的细纲与新写的正文于是都落进 `第二卷/`，不会掉回根下。
   */
  async subdirForNewChapter(no: number): Promise<string> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    let best: { no: number; dir: string } | undefined;
    const consider = (candidate: number, dir: string | undefined) => {
      if (dir !== undefined && candidate < no && (!best || candidate > best.no)) {
        best = { no: candidate, dir };
      }
    };
    const written = new Set<number>();
    for (const chapter of chapters) {
      const under = this.underChapters(chapter.relPath);
      written.add(chapter.order);
      consider(chapter.order, under === undefined ? undefined : path.posix.dirname(under));
    }
    for (const plot of plots) {
      // 正文在的章看正文：上一轮已经按正文算过了，细纲只补「还没有正文」的那几号。
      if (!written.has(plot.no)) {
        const under = path.relative(this.plotsDir, this.pathOf(plot.relPath)).replace(/\\/g, '/');
        consider(plot.no, path.posix.dirname(under));
      }
    }
    const dir = best?.dir ?? '';
    return dir === '.' ? '' : dir;
  }

  /**
   * 还没有正文、也还没有细纲的第 N 章，细纲**应该**落在哪：与上一章同一个子目录
   * （{@link subdirForNewChapter}），`NNN-标题.md`。纯推导，文件并不存在。
   *
   * **回落标题不进文件名**：没有名字的章（`009.md`）在 `listChapters` 那边会
   * 拿到「第 9 章」，那是「没有标题」的样子而不是标题——拼进去会得到
   * `009-第-9-章.md`，一个凭空的假名字。
   */
  async plotPathForNewChapter(no: number, title = ''): Promise<string> {
    const stem = isFallbackChapterTitle(no, title) ? '' : safeStem(title);
    const dir = await this.subdirForNewChapter(no);
    return this.relPath(path.join(this.plotsDir, dir, plotFileName(no, stem)));
  }

  /**
   * 第 N 章的细纲**应该**在哪：已有就是那一份；有正文就是正文的镜像（{@link plotPathForChapter}）；
   * 两样都没有就跟上一章放在一起（{@link plotPathForNewChapter}）。
   *
   * 给「这一章还没有细纲」时找落点用：界面上要能选中它、切到细纲层去补规划，那就需要一个
   * 稳定的落点路径，而且它必须就是之后真正落盘的那一份。
   */
  async plotPathOfNo(no: number, title = ''): Promise<string> {
    const plot = await this.getPlot(no);
    if (plot) {
      return plot.relPath;
    }
    const chapter = await this.getChapter(no);
    return chapter ? this.plotPathForChapter(chapter.relPath) : this.plotPathForNewChapter(no, title);
  }

  /** 绝对路径 → 工作区相对路径（正斜杠）。 */
  relPath(absPath: string): string {
    return path.relative(this.root, absPath).replace(/\\/g, '/');
  }

  /** relPath 的逆运算。 */
  pathOf(relPath: string): string {
    return path.join(this.root, relPath);
  }

  async isInitialized(): Promise<boolean> {
    return exists(this.manifestPath);
  }

  /** 只有旧目录、没有新目录时为真——需要迁移。 */
  async needsMigration(): Promise<boolean> {
    if (await exists(this.novelDir)) {
      return false;
    }
    return exists(path.join(this.legacyNovelDir, MANIFEST_FILE));
  }

  /**
   * 把 `.novel/` 整体搬到 `.novelforge/`。
   * 用 rename 而非复制，避免留下两份会各自漂移的元数据。
   */
  async migrateLegacyDir(): Promise<void> {
    await fs.rename(this.legacyNovelDir, this.novelDir);
    this.invalidate();
  }

  invalidate(): void {
    this.chapterCache = undefined;
    this.plotCache = undefined;
    // 在途的那一轮扫的是**变更之前**的磁盘状态：不能再让新调用方搭它的车，
    // 世代号 +1 也让它扫完后不要回填缓存（见 generation）。
    this.chapterScan = undefined;
    this.plotScan = undefined;
    this.generation++;
  }

  // ---------------------------------------------------------------- 初始化
  //
  // 新工程分三步，由网关的 `Workspace.initializeProject` 串起来：固定目录（`scaffold`）→ 空模板（经网关 `write`，
  // `mode: 'create'`）→ manifest（`createManifest`）。这一层只留元数据与脚手架——建目录、写 `project.json`——以及模板
  // 的落点与内容（纯数据）；**写模板不在这里**：模板是作者的创作产物，写盘只经网关（AGENTS 第 7 条），而 `model/`
  // 不能反过来依赖网关。

  /** 建固定目录（已有的不动）。不写任何文件。 */
  async scaffold(): Promise<void> {
    for (const dir of [this.chaptersDir, this.charactersDir, this.loreDir, this.summariesDir, this.sessionsDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * 新工程的几份空模板：架构三件、文风、情节大纲、全书摘要。**只给落点（工作区相对路径）与内容，不碰磁盘。**
   *
   * 架构三件是结构完整、全是占位的空模板，`isSettingFilled` 为 false，主按钮于是从「生成小说配置」开始。
   * **不放示例角色卡**：角色图谱「有没有」看 `characters/` 下有没有卡，一张示例卡会让新工程一出生就跳过「生成角色图谱」
   * （卡的格式见 README）。示例设定条目同理（设定清单「有没有」看 `lore/` 下有没有条目），何况它的关键词「设定」会被
   * 任何一句带这两个字的话命中、混进上下文。
   */
  newProjectTemplates(title: string): { rel: string; text: string }[] {
    return [
      ...SETTING_FILE_DOCS.map((doc) => ({ rel: this.relPath(this.settingPath(doc)), text: settingTemplate(doc) })),
      { rel: this.relPath(this.stylePath), text: STYLE_TEMPLATE },
      { rel: this.relPath(this.outlinePath), text: OUTLINE_TEMPLATE(title) },
      { rel: this.relPath(this.globalSummaryPath), text: GLOBAL_SUMMARY_TEMPLATE },
    ];
  }

  /** 写新工程的 manifest（`project.json`）并同步章节索引。有了它 `isInitialized` 才为真。 */
  async createManifest(meta: { title: string; author: string }): Promise<void> {
    this.invalidate();
    const manifest: ProjectManifest = {
      version: MANIFEST_VERSION,
      title: meta.title,
      author: meta.author,
      chapters: [],
    };
    await this.writeManifest(manifest);
    await this.syncManifest();
  }

  // ---------------------------------------------------------------- 章节（发布区）

  /**
   * 递归扫描 chapters/ 下所有章节文件，按序号排序。
   *
   * **章节是正文的唯一真相**：生成的正文直接落在这里，定稿、角色卡、设定、
   * 文风全都从这里读。
   *
   * 「什么算章节」由 model/chapterFile.ts 定义：数字前缀 + 扩展名不在
   * 二进制黑名单里。`001-楔子.md`、`001-楔子.txt`、`001-楔子`（无扩展名）、
   * `004.json` 都算；`001-封面.png` 不算。
   *
   * 子目录只是给作者分卷用的收纳，不参与排序：`卷一/003-x.md` 与
   * `003-x.md` 是同一个「第 3 章」。序号重复时按路径稳定排序，
   * 让两条都出现在树上（作者能看见冲突，才能去改）。
   */
  async listChapters(): Promise<Chapter[]> {
    if (this.chapterCache) {
      return this.chapterCache;
    }
    // 已经有人在扫了就等它，别再扫一遍。invalidate() 会把这个句柄一起清掉，
    // 所以「扫到一半磁盘变了」的那一轮不会被后来者当成新鲜结果。
    if (this.chapterScan) {
      return this.chapterScan;
    }
    this.chapterScan = this.scanChapters();
    try {
      return await this.chapterScan;
    } finally {
      this.chapterScan = undefined;
    }
  }

  private async scanChapters(): Promise<Chapter[]> {
    const generation = this.generation;
    const chapters: Chapter[] = [];
    for (const abs of await listFilesDeep(this.chaptersDir, isChapterFileName, this.chapterSkipDirs())) {
      const parsed = parseChapterFileName(path.basename(abs));
      if (!parsed) {
        continue; // 容错优先：accept 与 parse 用同一套规则，理论上到不了这里
      }
      const raw = await readText(abs);
      const body = raw.trim();
      // 只有 markdown 家族才认 `# 标题`。.txt 正文里一行「# 分隔」不是标题，
      // 认了它既会顶掉文件名标题，又会把那行留在正文里。
      const markdown = isMarkdownExt(parsed.ext);
      const title =
        (markdown ? extractH1(body) : undefined) ?? (parsed.stem.trim() || `第 ${parsed.order} 章`);
      chapters.push({
        order: parsed.order,
        title,
        relPath: this.relPath(abs),
        wordCount: countWords(markdown ? stripH1(body) : body),
        // 哈希的永远是整份正文（含标题行）——定稿对不对得上靠它，口径不能变。
        contentHash: hash(body),
      });
    }

    chapters.sort((a, b) => a.order - b.order || a.relPath.localeCompare(b.relPath));
    // 扫的过程中磁盘变过（invalidate 被调用）：结果照样交给等它的人——那是他们
    // 请求时的状态，不算错——但不进缓存，否则下一次读会拿到已经过时的全书列表。
    if (generation === this.generation) {
      this.chapterCache = chapters;
    }
    return chapters;
  }

  /**
   * 扫章节时要跳过的目录（绝对路径）。
   *
   * `drafts/` 正常情况下是 `chapters/` 的兄弟，本来就扫不到；这里是
   * `chaptersDir` 被配成 `.` 或空串时的唯一防线——那时草稿会落进章节根，
   * 每份草稿都会变成一章。
   */
  private chapterSkipDirs(): ReadonlySet<string> {
    return new Set([this.draftsDir]);
  }

  async getChapter(order: number): Promise<Chapter | undefined> {
    return (await this.listChapters()).find((c) => c.order === order);
  }

  /** 读章节正文（markdown 家族会去掉 `# 标题` 行）。 */
  async readChapterText(chapter: Chapter): Promise<string> {
    const raw = (await readText(this.pathOf(chapter.relPath))).trim();
    return isMarkdownPath(chapter.relPath) ? stripH1(raw) : raw;
  }

  /** 读章节原始内容（含标题行）。 */
  async readChapterRaw(chapter: Chapter): Promise<string> {
    return (await readText(this.pathOf(chapter.relPath))).trim();
  }

  /**
   * 工程里能拿来拆的整本 txt（导入原稿、从参考书学写法）：`.txt`，**章节文件与草稿除外**，按路径排序。
   * 隐藏目录照例不扫（`.novelforge/` 里没有作者要导入的东西）。只列路径与大小，不读内容。
   */
  async listImportableTexts(): Promise<{ relPath: string; bytes: number }[]> {
    const chaptersRoot = path.resolve(this.chaptersDir);
    const isTxt = (name: string) => path.extname(name).toLowerCase() === '.txt';
    const out: { relPath: string; bytes: number }[] = [];
    for (const abs of await listFilesDeep(this.root, isTxt, new Set([this.draftsDir]))) {
      const back = path.relative(chaptersRoot, abs);
      const inChapters = !back.startsWith('..') && !path.isAbsolute(back);
      if (inChapters && isChapterFileName(path.basename(abs))) {
        continue;
      }
      try {
        out.push({ relPath: this.relPath(abs), bytes: (await fs.stat(abs)).size });
      } catch {
        // 列完到 stat 之间被删了：当没有。
      }
    }
    return out;
  }

  /** 下一个可用章节序号。 */
  async nextChapterOrder(): Promise<number> {
    const chapters = await this.listChapters();
    return chapters.length === 0 ? 1 : Math.max(...chapters.map((c) => c.order)) + 1;
  }

  // 新建章节（createChapter）搬进了 `core/workspace/`：同名一律报错退出、
  // 落盘后要 syncManifest，那些是网关的活。这一层只留领域查询。

  // ---------------------------------------------------------------- 草稿

  /**
   * 章节 → 它草稿的工作区相对路径（正斜杠）。
   *
   * 镜像章节在**章节根之下**的那段相对路径，文件名（含扩展名）原样沿用：
   *   `chapters/卷一/003-夜访.md` → `drafts/卷一/003-夜访.md`
   *   `chapters/005-手记.txt`     → `drafts/005-手记.txt`
   * 章节不在章节根之下（配置被改坏等）时返回 undefined。
   *
   * 纯计算，不碰磁盘——调用方常常只是想知道「草稿该在哪」，
   * 而不是「草稿在不在」。
   */
  draftRelPathFor(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    return this.relPath(path.join(this.draftsDir, under));
  }

  // 草稿的按需创建（ensureDraft）搬进了 `core/workspace/`：它是**写盘**，
  // 而这一层只留领域查询。路径推导（draftRelPathFor）留在这里——
  // 调用方常常只是想知道「草稿该在哪」，而不是「草稿在不在」。

  /**
   * 磁盘上已存在的草稿路径集合（工作区相对路径）。
   *
   * 走一次递归遍历而不是每章一次 stat：工程页每次刷新都要为所有章节判断
   * 「有没有草稿」，五百章工程逐个 stat 会把 syscall 翻一倍。
   */
  async listDraftPaths(): Promise<Set<string>> {
    const files = await listFilesDeep(this.draftsDir, () => true);
    return new Set(files.map((abs) => this.relPath(abs)));
  }

  // ---------------------------------------------------------------- manifest

  async readManifest(): Promise<ProjectManifest> {
    try {
      const raw = await readText(this.manifestPath);
      const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
      return {
        version: parsed.version ?? MANIFEST_VERSION,
        title: parsed.title ?? '未命名',
        author: parsed.author ?? '',
        // 读不出就是空数组。`syncManifest()` 每次都从磁盘重算，
        // 所以哪怕整份索引丢了，也只是这一次刷新多读几个文件。
        chapters: parsed.chapters ?? [],
        globalSummaryThrough: parsed.globalSummaryThrough,
      };
    } catch {
      return { version: MANIFEST_VERSION, title: '未命名', author: '', chapters: [] };
    }
  }

  async writeManifest(manifest: ProjectManifest): Promise<void> {
    await writeText(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * 用磁盘上的实际章节刷新 manifest 索引。返回刷新后的 manifest。
   */
  async syncManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    manifest.chapters = (await this.listChapters()).map((chapter) => ({
      file: chapter.relPath,
      order: chapter.order,
      title: chapter.title,
      wordCount: chapter.wordCount,
      contentHash: chapter.contentHash,
    }));
    await this.writeManifest(manifest);
    return manifest;
  }

  /**
   * 这一章定稿过、而且对得上的那份细纲：正文镜像的那份细纲的 `sourceHash` 等于正文现在的 `contentHash`。
   * 没定稿过、或定稿之后正文又改过，都是 undefined。
   */
  async finalizedPlotOf(chapter: Chapter): Promise<Plot | undefined> {
    const plot = await this.plotOfChapter(chapter);
    return plot?.sourceHash && plot.sourceHash === chapter.contentHash ? plot : undefined;
  }

  /**
   * 该定稿还没定稿的章：有正文，镜像的那份细纲没有对得上的 `sourceHash`（从没定稿过，或定稿之后正文
   * 又改过）。以细纲 frontmatter 为准，不另记索引。
   *
   * **空章节不算**：那不是「定稿旧了」，是还没写。把它们混进来，批量定稿的确认框会报一个
   * 虚高的调用次数，而那几次调用只会撞上「这一章是空的，跳过」。
   */
  async staleChapters(): Promise<Chapter[]> {
    const stale: Chapter[] = [];
    for (const chapter of await this.listChapters()) {
      if (chapter.wordCount > 0 && !(await this.finalizedPlotOf(chapter))) {
        stale.push(chapter);
      }
    }
    return stale;
  }

  /**
   * 第 `beforeNo` 章之前、**定稿过**的各章留下的连续性事实，按章号升序。定稿之后正文又改过、
   * 或从没定稿过的章不收：拿一份过期的事实去判矛盾，判出来的可能正是作者改过的地方。没有事实的章也不收。
   * 预检、写前冲突检查与装配器的 `recentFacts` 层共用这一份。
   */
  async finalizedFacts(beforeNo = Number.POSITIVE_INFINITY): Promise<FinalizedFacts[]> {
    const out: FinalizedFacts[] = [];
    const chapters = (await this.listChapters()).filter((c) => c.order < beforeNo && c.wordCount > 0);
    for (const chapter of chapters.sort((a, b) => a.order - b.order)) {
      const plot = await this.finalizedPlotOf(chapter);
      const facts = plot ? parseContinuityFacts(plot.sections.连续性事实) : [];
      if (plot && facts.length > 0) {
        out.push({ no: chapter.order, title: chapter.title, relPath: plot.relPath, facts });
      }
    }
    return out;
  }

  /**
   * 下一个可用**章号**。只看 `chapters/`。空工程给 1。
   */
  async nextChapterNo(): Promise<number> {
    const nos = (await this.listChapters()).map((c) => c.order);
    return nos.length === 0 ? 1 : Math.max(...nos) + 1;
  }

  // ---------------------------------------------------------------- 细纲

  /**
   * 列出全部细纲，按章号升序。
   *
   * 顺序由**文件名的数字前缀**决定，与章节同一套规则——作者重排顺序的
   * 方式就是改文件名前缀。号码撞车（手改重名）时按路径稳定排序，两条都留在
   * 列表里，让作者看得见冲突。
   *
   * **`summaries/` 下各级子目录都扫**：细纲镜像正文的相对路径，分卷的书细纲就在卷目录里。
   * 根下的 `global.md` 没有数字前缀，天然不在里面。
   */
  async listPlots(): Promise<Plot[]> {
    if (this.plotCache) {
      return this.plotCache;
    }
    // 与 listChapters 同构：已经有人在扫了就搭它的车。工程页刷新时
    // 流水线索引与出场索引会同时要这份列表，各扫一遍等于把细纲读两遍。
    if (this.plotScan) {
      return this.plotScan;
    }
    this.plotScan = this.scanPlots();
    try {
      return await this.plotScan;
    } finally {
      this.plotScan = undefined;
    }
  }

  private async scanPlots(): Promise<Plot[]> {
    const generation = this.generation;
    const files = await listFilesDeep(this.plotsDir, isPlotFileName);
    const plots: Plot[] = [];
    for (const abs of files) {
      try {
        plots.push(parsePlotFile(await readText(abs), this.relPath(abs)));
      } catch {
        // 读盘失败（权限、编码）当作这一章没有细纲。解析失败在 parsePlotFile
        // 里已经退化过一层了，能走到这里的只有 I/O 异常。
      }
    }
    plots.sort((a, b) => a.no - b.no || a.relPath.localeCompare(b.relPath));
    // 扫的过程中磁盘变过：结果照样交给等它的人（那是他们请求时的状态），
    // 但不进缓存——否则下一次读会拿到已经过时的全书列表。
    if (generation === this.generation) {
      this.plotCache = plots;
    }
    return plots;
  }

  /** 读一章的细纲。没有不是错误——那个路径可能刚被改名或删除。 */
  async readPlot(plotRelPath: string): Promise<Plot | undefined> {
    const abs = this.pathOf(plotRelPath);
    try {
      // 直接读、读不到才当没有：省掉一次 stat，也堵掉「查到了、读之前被
      // 改名了」的竞态——作者随时在手改文件，那条竞态是真会发生的。
      const raw = await readTextIfExists(abs);
      return raw === undefined ? undefined : parsePlotFile(raw, plotRelPath);
    } catch {
      // 读盘本身失败（权限、编码）当作没有这份细纲：解析失败在 parsePlotFile
      // 里已经退化过一层了，能走到这里的只有 I/O 异常。
      return undefined;
    }
  }

  /**
   * 按 target 里的细纲路径找那一章的细纲。
   *
   * 路径上那一份正是某一章正文的镜像、或者这个号还没有正文（只有计划）时就是它；**否则按路径里的
   * 章号认这一章现在的那一份**（{@link getPlot}）。
   *
   * 主按钮给的落点常常是纯序号的占位路径（`summaries/003.md`——拆细纲那一刻标题还没定），
   * 而采纳时按产物带的标题落成了 `003-雪夜.md`。之后凡是「按 target 找细纲」的地方
   * 都要认得它：只按路径读的话，流水线会说「这一章还没有细纲」，再采纳一次就绕过了
   * 覆盖审阅（第 3 条）。反过来，路径上躺着一份**不归这一章**的细纲（作者在外面给正文改了名，
   * 旧的那份成了孤儿）也不冒认——对话页与工程页看到的必须是同一份。作者手里的文件路径
   * （工程页右键、编辑器）不走这里，那是实打实的路径。
   */
  async resolvePlot(plotRelPath: string): Promise<Plot | undefined> {
    const no = parsePlotFileNameOf(plotRelPath);
    if (no === undefined) {
      return undefined;
    }
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    const rel = plotRelPath.replace(/\\/g, '/');
    const direct = plots.find((p) => p.relPath === rel);
    if (direct) {
      const sameNo = chapters.filter((c) => c.order === direct.no);
      if (sameNo.length === 0 || sameNo.some((c) => this.plotPathForChapter(c.relPath) === direct.relPath)) {
        return direct;
      }
    }
    return this.plotFor(no, plots, chapters);
  }

  /** 第 N 章的细纲（配对规则见 {@link plotFor}）。 */
  async getPlot(no: number): Promise<Plot | undefined> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    return this.plotFor(no, plots, chapters);
  }

  /** 这一章正文的细纲：正文镜像的那一份（{@link plotPathForChapter}）。还没有就是 undefined。 */
  async plotOfChapter(chapter: Chapter): Promise<Plot | undefined> {
    const rel = this.plotPathForChapter(chapter.relPath);
    return (await this.listPlots()).find((p) => p.relPath === rel);
  }

  /**
   * 第 N 章的细纲，**按路径配对**：
   *
   * - 有正文：只认正文镜像的那一份。没有就是没有——作者在外面给正文改了名，那就是一章新的，
   *   旧的细纲不冒认（同号的正文有两份时认路径排序第一份，与流水线同一个口径）。
   * - 还没有正文：认同号的第一份（计划），正文照它的路径反推着落（{@link chapterPathForPlot}）。
   *
   * 手上已经有两份列表的调用方（流水线索引、装配器）直接用它，免得每章再读一遍。
   */
  plotFor(no: number, plots: readonly Plot[], chapters: readonly Chapter[]): Plot | undefined {
    const chapter = chapters.find((c) => c.order === no);
    if (chapter) {
      const rel = this.plotPathForChapter(chapter.relPath);
      return plots.find((p) => p.relPath === rel);
    }
    return plots.find((p) => p.no === no);
  }

  /**
   * 每个章号认下的那一份细纲（{@link plotFor}），按章号升序。孤儿（作者在外面给正文改了名，旧细纲
   * 没人认）不在里面——叙事线、出场统计、拆细纲区间这些「一章一份」的地方都吃这一份，与工程页
   * 一行一章的口径一致。
   */
  pairPlots(plots: readonly Plot[], chapters: readonly Chapter[]): Plot[] {
    const nos = [...new Set(plots.map((p) => p.no))].sort((a, b) => a - b);
    return nos.map((no) => this.plotFor(no, plots, chapters)).filter((p): p is Plot => !!p);
  }

  /** {@link pairPlots} 的读盘版。 */
  async listChapterPlots(): Promise<Plot[]> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    return this.pairPlots(plots, chapters);
  }

  /**
   * 下一个可用章号。**跨细纲与 `chapters/` 取最大号再 +1。**
   *
   * 两边都要看：只看细纲的话，一个写了 99 章、从没用过本工具的老工程会
   * 从第 1 章开始规划，直接撞上已有的章；只看 `chapters/` 的话，规划了但还没写
   * 的章会被反复重号。工程页「新建细纲」用它。
   */
  async nextPlotNo(): Promise<number> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    const nos = [...plots.map((p) => p.no), ...chapters.map((c) => c.order)];
    return nos.length === 0 ? 1 : Math.max(...nos) + 1;
  }

  // 细纲的写入（writePlot / deletePlot）搬进了 `core/workspace/`：写入要记
  // `upstreamHash`，删除要进 `.trash/`——那些是网关的活，不是数据访问的活。
  // 这一层只留领域查询。

  // ---------------------------------------------------------------- 架构

  /** 读小说配置。文件不在就是一份全空的配置（字段全部缺席），绝不抛。 */
  async readBookConfig(): Promise<BookConfig> {
    const raw = (await readTextIfExists(this.configPath).catch(() => undefined)) ?? '';
    return parseBookConfig(raw, this.relPath(this.configPath));
  }

  /** 读前提 / 世界观（配置也能读，只取小节）。文件不在就是全空的小节。 */
  async readSettingDoc(doc: SettingFileDoc): Promise<SettingDocFile> {
    const abs = this.settingPath(doc);
    const raw = (await readTextIfExists(abs).catch(() => undefined)) ?? '';
    return parseSettingDoc(doc, raw, this.relPath(abs));
  }

  /**
   * 架构五件各自填过没有。全书状态机的第一格读它。
   *
   * 角色图谱没有自己的文件，**至少有一张角色卡就算**——作者手写的卡、从正文里
   * 提取的卡都算数。设定清单同理（至少一条条目），另外**已经有正文的书一律算填过**
   * （`isLoreListFilled`）：在写的书的设定从定稿里长出来，不被推回架构。有正文时连目录都不必扫。
   *
   * `known` 收调用方手上已经读过的：工程页一次刷新里配置、角色卡、设定条目与章节都已经读过一遍，
   * 再读一遍只是多几次 I/O（`tests/integration/views/projectTreeReads.test.js` 盯着）。
   */
  async settingFilled(known?: {
    config?: BookConfig;
    characters?: CharacterCard[];
    lore?: readonly LoreEntry[];
    chapters?: readonly Chapter[];
  }): Promise<Record<SettingDoc, boolean>> {
    const [config, premise, world, characters, chapters] = await Promise.all([
      known?.config ? { sections: known.config.sections as Record<string, string> } : this.readSettingDoc('config'),
      this.readSettingDoc('premise'),
      this.readSettingDoc('world'),
      known?.characters ?? this.listCharacters(),
      known?.chapters ?? this.listChapters(),
    ]);
    const hasProse = chapters.some((c) => c.wordCount > 0);
    // 只要知道有没有：不读条目内容，列一下文件就够了。
    const entries = hasProse ? 0 : known?.lore ? known.lore.length : (await listMarkdownDeep(this.loreDir)).length;
    return {
      config: isSettingFilled('config', config.sections),
      premise: isSettingFilled('premise', premise.sections),
      world: isSettingFilled('world', world.sections),
      characters: characters.length > 0,
      lore: isLoreListFilled(entries, hasProse),
    };
  }

  // ---------------------------------------------------------------- 全书摘要 / 叙事线

  async readGlobalSummary(): Promise<string> {
    if (!(await exists(this.globalSummaryPath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.globalSummaryPath)).body);
  }

  /** `threads.md` 的原文。没有这份文件返回空串。 */
  async readThreadsText(): Promise<string> {
    if (!(await exists(this.threadsPath))) {
      return '';
    }
    return readText(this.threadsPath);
  }

  /** 叙事线（解析失败退化为认不出的行跳过，绝不抛，第 1 条）。 */
  async readThreads(): Promise<Thread[]> {
    return parseThreads(await this.readThreadsText());
  }

  // ---------------------------------------------------------------- 角色 / 设定 / 文风

  async listCharacters(): Promise<CharacterCard[]> {
    const files = await listMarkdownDeep(this.charactersDir);
    const cards: CharacterCard[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = this.slugUnder(this.charactersDir, abs);
      cards.push({
        slug,
        relPath: this.relPath(abs),
        name: asString(frontmatter.name) || extractH1(body) || baseName(abs),
        aliases: asArray(frontmatter.aliases),
        tags: asArray(frontmatter.tags),
        gender: normalizeGender(frontmatter.gender),
        firstAppear: asNumber(frontmatter.firstAppear),
        lastSeen: asNumber(frontmatter.lastSeen),
        appearsIn: asNumberArray(frontmatter.appearsIn),
        updatedThrough: asNumber(frontmatter.updatedThrough),
        stateThrough: asNumber(frontmatter.stateThrough),
        stateHash: asString(frontmatter.stateHash) || undefined,
        body: stripH1(body),
        sections: pickSections<keyof CharacterSections>(body, CHARACTER_SECTION_KEYS) as CharacterSections,
      });
    }
    cards.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return cards;
  }

  async listLore(): Promise<LoreEntry[]> {
    const files = await listMarkdownDeep(this.loreDir);
    const entries: LoreEntry[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = this.slugUnder(this.loreDir, abs);
      const updatedThrough = asNumber(frontmatter.updatedThrough);
      const bodyHash = asString(frontmatter.bodyHash);
      entries.push({
        slug,
        relPath: this.relPath(abs),
        title: asString(frontmatter.title) || extractH1(body) || baseName(abs),
        keywords: asArray(frontmatter.keywords),
        brief: asString(frontmatter.brief),
        category: loreCategoryOfSlug(slug),
        ...(updatedThrough !== undefined && updatedThrough >= 0 ? { updatedThrough } : {}),
        ...(bodyHash ? { bodyHash } : {}),
        body: stripH1(body),
      });
    }
    return entries;
  }

  /**
   * 本书的分类表：`lore/` 下的全部目录（相对 `lore/`，可多层，空目录也算）。每本书的分类不一样，
   * 没有固定表（model/loreFile.ts）。
   */
  async listLoreCategories(): Promise<string[]> {
    const root = this.relPath(this.loreDir);
    return (await this.listFolders(this.loreDir)).map((rel) => rel.slice(root.length + 1));
  }

  /**
   * 某个区目录下的文件标识：去掉扩展名的相对路径（正斜杠）。
   * 根目录下的文件与改造前一致（就是文件名），子目录里的形如 `主角/林昭`——
   * 上下文明细里的 `character:<slug>` 因此仍然唯一。
   */
  private slugUnder(dirAbs: string, fileAbs: string): string {
    return path.relative(dirAbs, fileAbs).replace(/\\/g, '/').replace(/\.md$/i, '');
  }

  /**
   * 递归列出某目录下的全部子目录（工作区相对路径，正斜杠，已排序）。
   * 空目录也在内——作者建好卷目录还没往里写，树上也该看得见。
   */
  async listFolders(dirAbs: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_TREE_DEPTH) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || isIgnoredDir(entry.name)) {
          continue;
        }
        const abs = path.join(dir, entry.name);
        out.push(this.relPath(abs));
        await walk(abs, depth + 1);
      }
    };
    await walk(dirAbs, 1);
    out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return out;
  }

  async readStyleGuide(): Promise<string> {
    if (!(await exists(this.stylePath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.stylePath)).body);
  }

  /**
   * 文风指南还没被作者动过：文件不在、是空的，或者一字不差还是初始化写的那份模板。
   *
   * 生成小说配置时模型会顺带给一段文风，只在这种时候才写进 `style.md`（D14 + 第 3 条）。
   * 模板是插件自己写的通用建议，替换它不会吞掉作者的任何一个字；作者改过一个字，
   * 它就是作者的文件了。
   */
  async styleGuideUntouched(): Promise<boolean> {
    const raw = (await readTextIfExists(this.stylePath).catch(() => undefined)) ?? '';
    return !raw.trim() || raw.replace(/\r\n/g, '\n').trim() === STYLE_TEMPLATE.trim();
  }

  async readOutline(): Promise<string> {
    if (!(await exists(this.outlinePath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.outlinePath)).body);
  }
}

// ---------------------------------------------------------------- 回收站落点

/**
 * 删掉的东西搬进回收站的哪里（绝对路径）：**保留原相对路径**（`.trash/<rel>`），同名冲突时加序号
 * （`003-深处-2.md`），不覆盖之前删掉的东西（AGENTS 第 6 条）。只算落点、只读（看一眼哪个名字没被占），不搬任何东西。
 *
 * 规则只有这一份：网关的 `remove` / `deletePlot` / 定稿前复制旧版（`core/workspace/` 重新导出它），与会话删除
 * （`session.ts`，会话是 Novel Forge 自己的内部文件，网关拒写 `sessions/`，所以会话不走网关、只共用这条落点规则）。
 * 放在数据层而不是网关里：`model/` 不能反过来依赖 `workspace/`。
 */
export async function trashPathFor(project: Pick<NovelProject, 'trashDir'>, rel: string): Promise<string> {
  const base = path.join(project.trashDir, rel);
  if (!(await exists(base))) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------- 渲染模板

/**
 * 写角色卡时的入参。
 *
 * `appearsIn` 可省：手工新建的空卡还没有出场记录，硬要调用方传个 `[]`
 * 只是噪音。读回来的 `CharacterCard.appearsIn` 则一定是数组（缺席即空）。
 */
export type WritableCharacterCard = Omit<CharacterCard, 'relPath' | 'body' | 'appearsIn'> & {
  appearsIn?: number[];
};

/**
 * 写设定条目时的入参。slug 可以带子目录前缀（就是分类）。`brief` / `updatedThrough` / `bodyHash`
 * 没给就不写——改写一条已有条目时由调用方把读回来的原样带上。
 */
export type WritableLoreEntry = Omit<LoreEntry, 'relPath' | 'category' | 'brief'> & { brief?: string };

export function renderCharacterCard(card: WritableCharacterCard): string {
  const fm = stringifyFrontmatter({
    name: card.name,
    aliases: card.aliases,
    tags: card.tags,
    gender: card.gender,
    firstAppear: card.firstAppear,
    lastSeen: card.lastSeen,
    // 出场章节列表落在卡里，角色页不必读全部细纲就能显示「出场 12 章」，
    // 也方便作者/日后的检索功能按人物找章节。
    appearsIn: card.appearsIn?.length ? card.appearsIn.map(String) : undefined,
    updatedThrough: card.updatedThrough,
    // 「当前状态」归谁（D15，model/characterState.ts）：原样带着走。维护类动作重写整张卡时
    // 不重新盖章——作者改过的那一节，换个别名不该让它变成「机器写的」。
    stateThrough: card.stateThrough,
    stateHash: card.stateHash,
  });
  const body = stringifySections(card.sections as unknown as Record<string, string>, CHARACTER_SECTION_KEYS, {
    keepEmpty: true,
  });
  return `${fm}\n\n# ${card.name}\n\n${body}\n`;
}

/** 将设定条目渲染成作者可继续手改的普通 Markdown。 */
export function renderLoreEntry(entry: WritableLoreEntry): string {
  const fm = stringifyFrontmatter({
    title: entry.title,
    keywords: entry.keywords,
    brief: entry.brief?.trim() || undefined,
    updatedThrough: entry.updatedThrough,
    bodyHash: entry.bodyHash || undefined,
  });
  return `${fm}\n\n# ${entry.title}\n\n${entry.body.trim()}\n`;
}

export function emptyCharacterSections(): CharacterSections {
  return {
    身份: '',
    外貌: '',
    性格: '',
    语言习惯: '',
    人物关系: '',
    当前状态: '',
    未收伏笔: '',
  };
}

// ---------------------------------------------------------------- 工具函数

/**
 * 递归列出目录下满足 `accept` 的文件的绝对路径（按路径排序，保证稳定）。
 *
 * 隐藏目录与 node_modules 一律跳过：`.trash/` 里躺着刚删掉的东西，
 * 再扫出来就等于没删。`skipDirs` 是额外要跳过的目录绝对路径。
 */
async function listFilesDeep(
  dir: string,
  accept: (fileName: string) => boolean,
  skipDirs?: ReadonlySet<string>
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name) && !skipDirs?.has(abs)) {
          await walk(abs, depth + 1);
        }
      } else if (entry.isFile() && accept(entry.name)) {
        out.push(abs);
      }
    }
  };
  await walk(dir, 1);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * 只列 `.md`。角色 / 设定用这一条——那两个区是插件自己的数据格式
 * （frontmatter + 固定小节），不跟着章节一起放宽扩展名。只列路径、不读内容。名词补全的表（`views/nameIndex.ts`）
 * 用同一条列文件，好跟 `listCharacters` / `listLore` 认的是同一批；全书查找也按它列角色卡与设定条目（`views/bookFind.ts`）。
 */
export async function listMarkdownDeep(dir: string): Promise<string[]> {
  return listFilesDeep(dir, (name) => name.toLowerCase().endsWith('.md'));
}

function baseName(absPath: string): string {
  return path.basename(absPath).replace(/\.md$/i, '');
}

/**
 * 标题 → 文件名词干。**空标题给空串，不给「未命名」**。
 *
 * `sanitizeFileName` 的兜底名是「未命名」，那是给「作者输了一串全是非法
 * 字符的名字」用的。但细纲与场景都允许**没有标题**——流水线新建出来的章
 * 就是纯序号名 `030.md`（标题要等剧情排完才定得下来，见 actions.ts 的
 * `newPlotFlow`）。直接套 sanitize 会得到 `030-未命名.md`：那是个假标题，
 * 而且它会进文件名、进段落说法、进上下文，作者还得手动去掉。
 */
function safeStem(title: string): string {
  return title.trim() ? sanitizeFileName(title) : '';
}

/** 细纲路径的文件名里那个章号；认不出是 undefined。 */
function parsePlotFileNameOf(plotRelPath: string): number | undefined {
  return parsePlotFileName(path.basename(plotRelPath))?.no;
}

// ---------------------------------------------------------------- 初始化模板

const STYLE_TEMPLATE = `# 文风指南

> 这份文件会在每次续写时注入 LLM。可以手写，也可以用命令「Novel: 提取文风指南」从已写章节自动生成。

## 叙事视角

第三人称限知视角，跟随主角。

## 句式节奏

以短句为主，动作场面进一步压缩句长；描写段落可适当铺陈。

## 对白比例

对白约占三成，人物说话要有各自的口癖，不写「他说道」以外的花哨提示语。

## 修辞偏好

克制使用比喻，避免堆砌形容词。

## 禁用词表

- 不使用「不禁」「顿时」「仿佛整个世界」这类套话
- 不写「总之」「综上」等议论腔
`;

/**
 * 情节大纲的空模板。区间标题是给状态机读的（model/outlineFile.ts）：
 * 覆盖到第几章、第 N 章的细纲依据的是哪一节，都从这些标题里认。
 */
const OUTLINE_TEMPLATE = (title: string) => `# ${title} · 情节大纲

> 按章号区间分节（\`## 第1–20章：标题\`）。可以只写到一部分章，写到了再续。

`;

const GLOBAL_SUMMARY_TEMPLATE = `---
through: 0
generatedBy: novel-forge
---

# 全书滚动摘要

## 主线进展

（尚未生成。写完若干章后运行命令「Novel: 重建全书摘要」。）

## 已收伏笔

## 未收伏笔

## 人物关系变动
`;
