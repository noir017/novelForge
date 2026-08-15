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
  Manuscript,
  NovelConfig,
  PlotSummary,
  ProjectManifest,
  SUMMARY_SECTION_KEYS,
  SummarySections,
} from './types';
import {
  asArray,
  asNumber,
  asNumberArray,
  asString,
  extractH1,
  parseMarkdown,
  pickSections,
  rewriteFrontmatter,
  stringifyFrontmatter,
  stringifySections,
  stripH1,
} from './markdown';
import { isChapterFileName, isMarkdownExt, isMarkdownPath, parseChapterFileName } from './chapterFile';
import { Plot, isPlotFileName, parsePlotFile, plotFileName } from './plotFile';
import { isFallbackChapterTitle } from './pipeline';
import {
  SCENE_SECTION_KEYS,
  Scene,
  isSceneFileName,
  parseSceneFile,
} from './sceneFile';
import {
  countWords,
  exists,
  hash,
  isIgnoredDir,
  pad3,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from './fs';
import { castFromText, parseCast } from './castParse';

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
 * ## 两条互不相干的轴
 *
 * - **创作轴**（流水线）：`plots/` → `scenes/<段>/` → `manuscripts/` → `summaries/`。
 *   前三者一一对应、都以细纲的文件名为身份；`summaries/` 挂在 `chapters/` 上。
 * - **发布轴**：`chapters/`。作者把正文切成一篇篇章节以便发布。这里只做文件
 *   操作（列出、改名、移动、删除、草稿），**不解析、不生成、不挂状态**。
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
   * `listChapters()` 与 `buildPipelineIndex()` 同时起跑，五百段工程于是
   * 把 `plots/` 读了两遍（流水线一遍、出场索引一遍）。记住这个在途的
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

  get charactersDir(): string {
    return path.join(this.novelDir, 'characters');
  }

  get loreDir(): string {
    return path.join(this.novelDir, 'lore');
  }

  get summariesDir(): string {
    return path.join(this.novelDir, 'summaries');
  }

  /** 每一章的细纲（`.novelforge/plots/`）。扁平目录，`NNN-标题.md`，序号即章号。 */
  get plotsDir(): string {
    return path.join(this.novelDir, 'plots');
  }

  /** 剧情细节（`.novelforge/scenes/`）。每段一个同名目录，里面按 `NN-标题.md` 放场景。 */
  get scenesDir(): string {
    return path.join(this.novelDir, 'scenes');
  }

  /**
   * 生成的正文（`.novelforge/manuscripts/`）。**中转站**：与细纲一一对应、同名，拆成发布章节之后就删掉。
   *
   * **不是 `chapters/`**：那里是作者切好的发布章节。正文先落在这里，作者
   * 什么时候切、怎么切由他自己定（见 model/plotFile.ts 的文件头）。
   */
  get manuscriptsDir(): string {
    return path.join(this.novelDir, 'manuscripts');
  }

  get sessionsDir(): string {
    return path.join(this.novelDir, 'sessions');
  }

  /** 删除的东西搬这里，不真删。会话存储也用这个目录。 */
  get trashDir(): string {
    return path.join(this.novelDir, '.trash');
  }

  /** 0.1.x 的 `.novel/` 目录，仅用于迁移检测。 */
  get legacyNovelDir(): string {
    return path.join(this.root, LEGACY_NOVEL_DIR);
  }

  get globalSummaryPath(): string {
    return path.join(this.summariesDir, 'global.md');
  }

  // ------------------------------------------------- 细纲的伴生路径
  //
  // 场景与正文都以细纲的**文件名词干**为身份，规则只有一条：
  //
  //   plots/007-入宗风波.md
  //     → scenes/007-入宗风波/        （目录：一章有若干场，要能整体跟着走）
  //     → manuscripts/007-入宗风波.md （中转站，拆分之后就删掉）
  //
  // **摘要不在这里**：它描述的是成品，挂在 `chapters/` 上（见下一节）。
  // 分界就是拆分那一刻——拆分之前正文还在中转站，摘要无从生成。

  /** 细纲路径 → 它的文件名词干（`plots/007-入宗风波.md` → `007-入宗风波`）。 */
  private plotStem(plotRelPath: string): string {
    return path.parse(plotRelPath).name;
  }

  /** 细纲 → 它的场景**目录**绝对路径。一章有若干场，所以多开一层同名目录。 */
  sceneDirForPlot(plotRelPath: string): string {
    return path.join(this.scenesDir, this.plotStem(plotRelPath));
  }

  /** 细纲 → 它的场景目录在工作区里的相对路径（正斜杠）。纯计算，不碰磁盘。 */
  sceneMirrorRelPath(plotRelPath: string): string {
    return this.relPath(this.sceneDirForPlot(plotRelPath));
  }

  /** 细纲 → 它在中转站里那份正文的绝对路径。 */
  manuscriptPathForPlot(plotRelPath: string): string {
    return path.join(this.manuscriptsDir, `${this.plotStem(plotRelPath)}.md`);
  }

  /** 细纲 → 它中转站正文的工作区相对路径（正斜杠）。纯计算，不碰磁盘。 */
  manuscriptMirrorRelPath(plotRelPath: string): string {
    return this.relPath(this.manuscriptPathForPlot(plotRelPath));
  }

  /**
   * 章号 + 标题 → 这一章的细纲**应该**落在哪。纯计算，文件可能并不存在。
   *
   * 给「这一章只有成品、还没有细纲」那种情况用（老工程里每一章都是）：
   * 界面上仍要能选中它、切到细纲层去补规划，那就需要一个稳定的落点路径。
   *
   * **回落标题不进文件名**：没有名字的章（`009.md`）在 `listChapters` 那边会
   * 拿到「第 9 章」，那是「没有标题」的样子而不是标题——拼进去会得到
   * `009-第-9-章.md`，一个凭空的假名字，而作者哪天真去补规划时，`writePlot`
   * 按真标题落的又是另一个文件名，同一章于是有了两份细纲。
   */
  plotPathForNo(no: number, title: string): string {
    const stem = isFallbackChapterTitle(no, title) ? '' : safeStem(title);
    return this.relPath(path.join(this.plotsDir, plotFileName(no, stem)));
  }

  // ------------------------------------------------- 章节（发布区）的路径
  //
  // 摘要与草稿两套伴生文件挂在**章节**上，因为它们描述的是成品：
  //
  //   chapters/007-入宗风波.md
  //     → .novelforge/summaries/007-入宗风波.md
  //     → drafts/007-入宗风波.md
  //
  // 细纲那一侧（scenes/ 与 manuscripts/）挂在 `plots/` 上，见上一节。
  // 分界就是拆分那一刻：拆分之前正文在中转站，拆分之后一切按章。

  /**
   * 章节在**章节根之下**的那段相对路径；不在其下时 undefined。
   *
   * 摘要与草稿两套镜像共用这一条判据。分开写过两遍之后，
   * 「作者把 chaptersDir 配成 `.`」这种边角只会在其中一处被想到。
   */
  private underChapters(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    return !under || under.startsWith('..') || path.isAbsolute(under) ? undefined : under;
  }

  /**
   * 章节（文件）→ 它的摘要文件路径。
   *
   * 镜像章节在**章节根之下**的相对路径到 summaries/ 下，扩展名换成 `.md`：
   *   chapters/001 序.txt        → .novelforge/summaries/001 序.md
   *   chapters/卷一/003 夜访.md  → .novelforge/summaries/卷一/003 夜访.md
   *
   * 这样同序号但不同文件名/路径的章节各有独立摘要，不再互相覆盖。与草稿的
   * 镜像策略（`draftRelPathFor`）一致——目录层级只是收纳，文件名（含扩展名）
   * 才是身份。
   *
   * 章节不在章节根之下（配置被改坏等极端情况）时回落到序号命名，绝不抛错。
   */
  summaryPathForChapter(chapterRelPath: string): string {
    const under = this.underChapters(chapterRelPath);
    if (!under) {
      const order = parseChapterFileName(path.basename(chapterRelPath))?.order ?? 0;
      return path.join(this.summariesDir, `${pad3(order)}.md`);
    }
    const parsed = path.parse(under);
    return path.join(this.summariesDir, path.join(parsed.dir, `${parsed.name}.md`));
  }

  /**
   * 章节（文件或目录）→ 摘要在 summaries/ 下的**工作区相对路径**（正斜杠）。
   *
   * 文件：扩展名换成 `.md`（与 `summaryPathForChapter` 同一套规则）。
   * 目录：原样镜像（目录下的每章摘要各自落在镜像位置，搬目录时整体跟着走）。
   *
   * 不在章节根之下时返回 undefined——`carrySummary` 据此判断「搬出 chapters/
   * 了，摘要留在原处」。纯计算，不碰磁盘。
   */
  summaryMirrorRelPath(chapterRelPath: string, isDir = false): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (!under) {
      return undefined;
    }
    const parsed = path.parse(under);
    const mirror = isDir ? under : path.join(parsed.dir, `${parsed.name}.md`);
    return this.relPath(path.join(this.summariesDir, mirror));
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

  async initialize(meta: { title: string; author: string }): Promise<void> {
    await fs.mkdir(this.chaptersDir, { recursive: true });
    await fs.mkdir(this.charactersDir, { recursive: true });
    await fs.mkdir(this.loreDir, { recursive: true });
    await fs.mkdir(this.summariesDir, { recursive: true });
    await fs.mkdir(this.plotsDir, { recursive: true });
    await fs.mkdir(this.scenesDir, { recursive: true });
    await fs.mkdir(this.manuscriptsDir, { recursive: true });
    await fs.mkdir(this.sessionsDir, { recursive: true });

    await writeIfAbsent(this.stylePath, STYLE_TEMPLATE);
    await writeIfAbsent(this.outlinePath, OUTLINE_TEMPLATE(meta.title));
    await writeIfAbsent(this.globalSummaryPath, GLOBAL_SUMMARY_TEMPLATE);
    await writeIfAbsent(path.join(this.charactersDir, 'example-protagonist.md'), CHARACTER_TEMPLATE);
    await writeIfAbsent(path.join(this.loreDir, 'example-setting.md'), LORE_TEMPLATE);

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
   * **章节不在创作流水线上**：这里只是把作者切好的发布章节列出来，供工程页
   * 显示与文件操作（改名/移动/删除/草稿）。不读它们的内容做任何分析——
   * 摘要、角色卡、设定、文风全都读 `manuscripts/`。
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
        // 哈希的永远是整份正文（含标题行）——摘要新鲜度靠它，口径不能变。
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
   * 用磁盘上的实际章节刷新 manifest 索引，保留已记录的 summaryHash。
   * 返回刷新后的 manifest。
   *
   * 按 file 匹配，匹配不上再按 order 兜底——作者给某章改了标题（文件名跟着变）
   * 之后路径变了，但那仍是同一章，不该因此丢掉「已总结」的记录。
   */
  async syncManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    const oldByFile = new Map(manifest.chapters.map((c) => [c.file, c]));
    const oldByOrder = new Map(manifest.chapters.map((c) => [c.order, c]));
    const chapters = await this.listChapters();

    manifest.chapters = chapters.map((chapter) => {
      const old = oldByFile.get(chapter.relPath) ?? oldByOrder.get(chapter.order);
      return {
        file: chapter.relPath,
        order: chapter.order,
        title: chapter.title,
        wordCount: chapter.wordCount,
        contentHash: chapter.contentHash,
        summaryHash: old?.summaryHash,
      };
    });

    await this.writeManifest(manifest);
    return manifest;
  }

  /**
   * 记录某章摘要已基于 hash 生成。
   *
   * 按 relPath 匹配 manifest 条目，找不到再按章号兜底。
   */
  async markSummarized(chapterRelPath: string, sourceHash: string): Promise<void> {
    const manifest = await this.syncManifest();
    const order = parseChapterFileName(path.basename(chapterRelPath))?.order;
    const entry =
      manifest.chapters.find((c) => c.file === chapterRelPath) ??
      (order === undefined ? undefined : manifest.chapters.find((c) => c.order === order));
    if (entry) {
      entry.summaryHash = sourceHash;
      await this.writeManifest(manifest);
    }
  }

  /**
   * 摘要过期/缺失的章节列表。
   *
   * 以磁盘上摘要文件里的 sourceHash 为准，manifest 只作兜底——这样即使
   * manifest 被误删，也不会把所有章都当成过期而重刷一遍。
   *
   * **空章节不算过期**：那不是「摘要旧了」，是还没写。把它们混进来，
   * 同步摘要的确认框会报一个虚高的调用次数，而那几次调用只会撞上
   * 「这一章是空的，跳过」。
   */
  async staleChapters(): Promise<Chapter[]> {
    const stale: Chapter[] = [];
    for (const chapter of await this.listChapters()) {
      if (chapter.wordCount === 0) {
        continue;
      }
      const summary = await this.readSummary(chapter.relPath);
      if (!summary || summary.sourceHash !== chapter.contentHash) {
        stale.push(chapter);
      }
    }
    return stale;
  }

  // ---------------------------------------------------------------- 细纲

  /**
   * 列出全部细纲，按章号升序。
   *
   * 顺序由**文件名的数字前缀**决定，与章节/场景同一套规则——作者重排顺序的
   * 方式就是改文件名前缀。号码撞车（手改重名）时按路径稳定排序，两条都留在
   * 列表里，让作者看得见冲突。
   *
   * 扁平扫描（不递归）：`plots/` 不设分卷子目录，段的归属靠 frontmatter 的
   * `arc` 表达。少一层目录，场景/正文/摘要三套伴生路径也就少一层要镜像的东西。
   */
  async listPlots(): Promise<Plot[]> {
    if (this.plotCache) {
      return this.plotCache;
    }
    // 与 listChapters 同构：已经有人在扫了就搭它的车。工程页刷新时
    // 流水线索引与出场索引会同时要这份列表，各扫一遍等于把 plots/ 读两遍。
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
        // 读盘失败（权限、编码）当作这一段不存在。解析失败在 parsePlotFile
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

  /** 读一段剧情。没有不是错误——那个路径可能刚被改名或删除。 */
  async readPlot(plotRelPath: string): Promise<Plot | undefined> {
    const abs = this.pathOf(plotRelPath);
    try {
      // 直接读、读不到才当没有：省掉一次 stat，也堵掉「查到了、读之前被
      // 改名了」的竞态——作者随时在手改文件，那条竞态是真会发生的。
      const raw = await readTextIfExists(abs);
      return raw === undefined ? undefined : parsePlotFile(raw, plotRelPath);
    } catch {
      // 读盘本身失败（权限、编码）当作没有这一段：解析失败在 parsePlotFile
      // 里已经退化过一层了，能走到这里的只有 I/O 异常。
      return undefined;
    }
  }

  /** 按段号取一段。 */
  async getPlot(no: number): Promise<Plot | undefined> {
    return (await this.listPlots()).find((p) => p.no === no);
  }

  /**
   * 下一个可用章号。**跨 `plots/` 与 `chapters/` 取最大号再 +1。**
   *
   * 两边都要看，因为一章的一生会在两个目录之间搬家：先有细纲（`plots/`），
   * 写完正文、拆分之后落进 `chapters/`，而细纲那份仍留着。只看 `plots/` 的话，
   * 一个写了 99 章、从没用过本工具的老工程会从第 1 章开始规划，直接把
   * 已有的章覆盖掉；只看 `chapters/` 的话，规划了但还没写的章会被反复重号。
   */
  async nextPlotNo(): Promise<number> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    const nos = [...plots.map((p) => p.no), ...chapters.map((c) => c.order)];
    return nos.length === 0 ? 1 : Math.max(...nos) + 1;
  }

  // 细纲的写入（writePlot / deletePlot / carryPlotCompanions）搬进了
  // `core/workspace/`：改名要连带搬走场景目录与中转站正文，写入要记
  // `upstreamHash`，删除要进 `.trash/`——那些是网关的活，不是数据访问的活。
  // 这一层只留领域查询。

  // ---------------------------------------------------------------- 正文

  /**
   * 读一段的正文。还没写过就返回 undefined。
   *
   * `beatsHash` 从 frontmatter 里取——正文文件是插件自己产出的 `.md`，
   * 可以带 frontmatter（章节不行，见 `Manuscript.beatsHash`）。
   */
  async readManuscript(plotRelPath: string): Promise<Manuscript | undefined> {
    const abs = this.manuscriptPathForPlot(plotRelPath);
    // 直接读、读不到才当没写过：省掉一次 stat（全书刷新时那是每段一次），
    // 与 readSummary 同一条取舍。
    const found = await readTextIfExists(abs);
    if (found === undefined) {
      return undefined;
    }
    const raw = found.trim();
    const { frontmatter, body } = parseMarkdown(raw);
    const text = stripH1(body);
    return {
      plotRelPath,
      relPath: this.relPath(abs),
      text,
      wordCount: countWords(text),
      // 哈希的是**正文本身**（不含 frontmatter 与标题行）：写一次 beatsHash
      // 不该让摘要立刻过期。与 `plotContentHash` 只哈希小节是同一条取舍。
      contentHash: hash(text),
      beatsHash: asString(frontmatter.beatsHash),
    };
  }

  /**
   * 一段正文的纯文本，没写过就是空串。
   *
   * 「通读全部正文」那几条路（角色卡、设定扫描、文风提取）要的就是这一个，
   * 每处各写一遍 `(await readManuscript(x))?.text ?? ''` 只是噪音。
   */
  async readManuscriptText(plotRelPath: string): Promise<string> {
    return (await this.readManuscript(plotRelPath))?.text ?? '';
  }

  // 正文的追加与拆分（appendToManuscript / splitManuscript）搬进了
  // `core/workspace/`：追加要插分隔标记、要记 beatsHash，拆分要建章节、
  // 要把原件搬进 `.trash/`。这一层只留读取。

  // ---------------------------------------------------------------- 摘要

  /**
   * 读一章的摘要。
   *
   * 传的是**章节**的相对路径（`chapters/007-入宗风波.md`）：摘要描述的是
   * 成品，所以身份跟着发布文件走。老工程里那些从没经过本工具的章一样读得到
   * 自己的摘要，不需要任何迁移。
   */
  async readSummary(chapterRelPath: string): Promise<PlotSummary | undefined> {
    const abs = this.summaryPathForChapter(chapterRelPath);
    // 直接读、读不到才当没有：省掉一次 stat（全书刷新时那是每章一次），
    // 也避开「查到了、读之前被删掉」的竞态。作者手里真会出现一个叫
    // `001-楔子.md` 的**目录**，`readTextIfExists` 把那种情况也当成「没有」。
    const raw = await readTextIfExists(abs);
    if (raw === undefined) {
      return undefined;
    }
    const { frontmatter, body } = parseMarkdown(raw);
    const sections = pickSections<keyof SummarySections>(body, SUMMARY_SECTION_KEYS) as SummarySections;
    return {
      no:
        parseChapterFileName(path.basename(chapterRelPath))?.order ??
        asNumber(frontmatter.chapter) ??
        asNumber(frontmatter.plot) ??
        0,
      relPath: this.relPath(abs),
      sourceHash: asString(frontmatter.sourceHash),
      content: stripH1(body),
      sections,
      // frontmatter 的 cast 是结构化真相；没有它（作者手写的摘要）就从
      // 「出场人物」小节的文本回退解析，不让角色页少人。
      cast: parseCast(frontmatter.cast) ?? castFromText(sections.出场人物),
    };
  }

  // 摘要的写入（writeSummary）搬进了 `core/workspace/`：它要渲染 frontmatter、
  // 记 sourceHash、同步 manifest。这一层只留读取与 markSummarized
  // （那是 manifest 的索引维护，不是产物写入）。

  // ---------------------------------------------------------------- 场景

  /**
   * 列一段的全部场景，按场景号升序。
   *
   * 顺序由**文件名的数字前缀**决定，与细纲同一套规则——作者重排场景顺序
   * 的方式就是改文件名前缀。号码撞车（手改重名）时按路径稳定排序，两条都
   * 留在列表里，让作者看得见冲突。
   */
  async listScenes(plotRelPath: string): Promise<Scene[]> {
    const files = await listFilesDeep(this.sceneDirForPlot(plotRelPath), isSceneFileName);
    const scenes: Scene[] = [];
    for (const abs of files) {
      scenes.push(parseSceneFile(await readText(abs), this.relPath(abs)));
    }
    scenes.sort((a, b) => a.no - b.no || a.relPath.localeCompare(b.relPath));
    return scenes;
  }

  /** 取某一场。找不到返回 undefined。 */
  async readScene(plotRelPath: string, sceneNo: number): Promise<Scene | undefined> {
    return (await this.listScenes(plotRelPath)).find((s) => s.no === sceneNo);
  }

  // 场景的写入（writeScene / deleteScene）搬进了 `core/workspace/`：
  // 改标题会改文件名（要清掉旧的），写入要记 `upstreamHash`，删除要进
  // `.trash/`。这一层只留领域查询。

  /**
   * 一段全部场景拼起来的 hash——正文的上游指纹。
   *
   * 参与哈希的只有场景号与七个小节，不含 `status`——采纳正文时会把场景标成
   * `written`，那一次写入不该反过来让刚写好的正文立刻显示「上游已变更」。
   *
   * `scenes` 传进来就不再读盘：调用方多半刚 `listScenes()` 过（流水线聚合就是
   * 这样），不复用的话全书刷新会把每段的场景各读两遍。
   */
  async beatsHashFor(plotRelPath: string, scenes?: Scene[]): Promise<string> {
    return beatsHashOf(scenes ?? (await this.listScenes(plotRelPath)));
  }

  /**
   * 记录某段正文所依据的场景指纹。写完正文后调用。
   *
   * 落在正文文件自己的 frontmatter 里（只改 frontmatter，正文一个字节不动），
   * 而不是 manifest——真相跟着文件走，作者手工搬动文件时不会与中央索引失联。
   */
  async markBeatsWritten(plotRelPath: string, beatsHash: string): Promise<void> {
    const abs = this.manuscriptPathForPlot(plotRelPath);
    if (!(await exists(abs))) {
      return;
    }
    const raw = await readText(abs);
    const next = rewriteFrontmatter(raw, { beatsHash: beatsHash || undefined });
    if (next !== undefined) {
      await writeText(abs, next);
    }
  }

  async readGlobalSummary(): Promise<string> {
    if (!(await exists(this.globalSummaryPath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.globalSummaryPath)).body);
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
        firstAppear: asNumber(frontmatter.firstAppear),
        lastSeen: asNumber(frontmatter.lastSeen),
        appearsIn: asNumberArray(frontmatter.appearsIn),
        updatedThrough: asNumber(frontmatter.updatedThrough),
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
      entries.push({
        slug,
        relPath: this.relPath(abs),
        title: asString(frontmatter.title) || extractH1(body) || baseName(abs),
        keywords: asArray(frontmatter.keywords),
        body: stripH1(body),
      });
    }
    return entries;
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

  async readOutline(): Promise<string> {
    if (!(await exists(this.outlinePath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.outlinePath)).body);
  }
}

/**
 * 一组场景的指纹。纯函数，便于**已经拿到场景**的调用方直接算，不必再读一遍盘。
 *
 * 口径就是 `beatsHashFor` 的那一份，只有一处定义：参与哈希的是场景号、标题、
 * 地点、时间与七个小节，**不含 `status`**（采纳正文会把场景标成 `written`，
 * 那次写入不该让刚写好的正文立刻显示「上游已变更」）。
 */
export function beatsHashOf(scenes: Scene[]): string {
  if (scenes.length === 0) {
    return '';
  }
  return hash(
    scenes
      .map((s) =>
        [`#${s.no}`, s.title, s.place, s.time, ...SCENE_SECTION_KEYS.map((k) => s.sections[k])].join('\n')
      )
      .join('\n---\n')
  );
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

/** 写设定条目时的入参。slug 可以带子目录前缀。 */
export type WritableLoreEntry = Omit<LoreEntry, 'relPath'>;

export function renderCharacterCard(card: WritableCharacterCard): string {
  const fm = stringifyFrontmatter({
    name: card.name,
    aliases: card.aliases,
    tags: card.tags,
    firstAppear: card.firstAppear,
    lastSeen: card.lastSeen,
    // 出场章节列表落在卡里，角色页不必读全部摘要就能显示「出场 12 章」，
    // 也方便作者/日后的检索功能按人物找章节。
    appearsIn: card.appearsIn?.length ? card.appearsIn.map(String) : undefined,
    updatedThrough: card.updatedThrough,
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

export function emptySummarySections(): SummarySections {
  return {
    梗概: '',
    出场人物: '',
    时间地点: '',
    关键事件: '',
    新增伏笔: '',
    状态变更: '',
  };
}

// ---------------------------------------------------------------- 工具函数

async function writeIfAbsent(absPath: string, text: string): Promise<void> {
  if (!(await exists(absPath))) {
    await writeText(absPath, text);
  }
}

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
 * （frontmatter + 固定小节），不跟着章节一起放宽扩展名。
 */
async function listMarkdownDeep(dir: string): Promise<string[]> {
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

const OUTLINE_TEMPLATE = (title: string) => `# ${title} · 全书大纲

> 这份文件由作者手工维护，用于记录长线规划。续写时不会整篇注入，请把每章的具体剧情写在续写面板的「剧情纲要」里。

## 一句话立意

（写一句话概括全书。）

## 主线

1.
2.

## 分卷规划

### 第一卷

-
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

const CHARACTER_TEMPLATE = `---
name: 示例主角
aliases: [小示, 示公子]
tags: [主角]
firstAppear: 1
---

# 示例主角

## 身份

（他/她是谁，在故事里承担什么位置。）

## 外貌

## 性格

## 语言习惯

（说话的节奏、口癖、常用词——这一节对保持角色声音很关键。）

## 人物关系

## 当前状态

（写到最新章节时，此人身在何处、处于什么处境。续写时会优先注入这一节。）

## 未收伏笔

（与此人相关、尚未回收的线索。）
`;

const LORE_TEMPLATE = `---
title: 示例设定
keywords: [示例, 设定]
---

# 示例设定

（世界观、势力、功法、地理等设定条目。keywords 命中续写纲要时会自动注入。）
`;
