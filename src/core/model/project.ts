import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readConfig } from '../config';
import {
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
  CharacterSections,
  ChapterSummary,
  LoreEntry,
  MANIFEST_VERSION,
  ManifestChapter,
  NovelConfig,
  ProjectManifest,
  SUMMARY_SECTION_KEYS,
  SummaryCast,
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
  stringifyFrontmatter,
  stringifySections,
  stripH1,
} from './markdown';
import { isChapterFileName, isMarkdownExt, isMarkdownPath, parseChapterFileName } from './chapterFile';
import { ChapterPlan, WritableChapterPlan, parsePlanFile, renderPlanFile } from './planFile';
import {
  SCENE_SECTION_KEYS,
  Scene,
  WritableScene,
  isSceneFileName,
  parseSceneFile,
  renderSceneFile,
  sceneFileName,
} from './sceneFile';
import { countWords, exists, hash, isIgnoredDir, pad3, readText, sanitizeFileName, writeText } from './fs';
import { castFromText, parseCast, renderCastEntry } from './castParse';

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
 * 章节 / 角色 / 设定三个目录都是**递归扫描**的：作者可以按卷、按阵营
 * 分子目录整理。角色 / 设定只认 `.md`（那是插件自己的数据格式）；章节
 * 则认「数字前缀 + 非二进制扩展名」的任意文件（见 model/chapterFile.ts）。
 * 章节的顺序始终由文件名的数字前缀决定，与它在哪一层无关。
 */
export class NovelProject {
  private chapterCache: Chapter[] | undefined;

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

  /** 章节细纲（`.novelforge/plans/`）。镜像章节在 chaptersDir 之下的相对路径。 */
  get plansDir(): string {
    return path.join(this.novelDir, 'plans');
  }

  /** 剧情细节（`.novelforge/scenes/`）。每章一个同名目录，里面按 `NN-标题.md` 放场景。 */
  get scenesDir(): string {
    return path.join(this.novelDir, 'scenes');
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

  /**
   * 旧的摘要文件名：只用序号（`001.md`）。
   *
   * **已废弃，仅用于读取回退与一次性迁移**——同序号但不同文件名/路径的章节
   * （如 `001 序.txt` 与 `001 正文.txt`）会共用同一个 `001.md`，后写的覆盖先写的。
   * 新摘要改走 `summaryPathForChapter`，按完整文件名与路径映射。这里保留是为了
   * 让升级前已生成的旧摘要仍能被读到（`readSummary` 会先找新路径、再回退到这里）。
   */
  summaryPath(order: number): string {
    return path.join(this.summariesDir, `${pad3(order)}.md`);
  }

  /**
   * 章节（文件）→ 它的摘要文件路径。
   *
   * 镜像章节在**章节根之下**的相对路径到 summaries/ 下，扩展名换成 `.md`：
   *   chapters/001 序.txt        → .novelforge/summaries/001 序.md
   *   chapters/卷一/003 夜访.md  → .novelforge/summaries/卷一/003 夜访.md
   *   chapters/005-手记           → .novelforge/summaries/005-手记.md
   *
   * 这样同序号但不同文件名/路径的章节各有独立摘要，不再互相覆盖。与草稿的
   * 镜像策略（`draftRelPathFor`）一致——目录层级只是收纳，文件名（含扩展名）
   * 才是身份。
   *
   * 章节不在章节根之下（配置被改坏等极端情况）时回落到旧的序号命名，绝不抛错。
   */
  summaryPathForChapter(chapterRelPath: string): string {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      // 拿不到 order，用 basename 解析；实在解析不出就给 0，至少不崩。
      const order = parseChapterFileName(path.basename(chapterRelPath))?.order ?? 0;
      return this.summaryPath(order);
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
  summaryMirrorRelPath(chapterRelPath: string, isDir: boolean): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    const parsed = path.parse(under);
    const mirror = isDir ? under : path.join(parsed.dir, `${parsed.name}.md`);
    return this.relPath(path.join(this.summariesDir, mirror));
  }

  // ------------------------------------------------- 细纲 / 场景的镜像路径

  /**
   * 章节在**章节根之下**的那段相对路径；不在其下时 undefined。
   *
   * 摘要、草稿、细纲、场景四套镜像共用这一条判据。分开写过四遍之后，
   * 「作者把 chaptersDir 配成 `.`」这种边角只会在其中一两处被想到。
   */
  private underChapters(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    return !under || under.startsWith('..') || path.isAbsolute(under) ? undefined : under;
  }

  /**
   * 章节 → 它细纲文件的绝对路径。
   *
   * 与摘要同一套镜像规则，扩展名换 `.md`：
   *   `chapters/卷一/012-夜入青云.md` → `.novelforge/plans/卷一/012-夜入青云.md`
   *   `chapters/005-手记.txt`         → `.novelforge/plans/005-手记.md`
   *
   * 与摘要**不同的一点**：这里没有「按序号命名」的旧式回退。细纲是新东西，
   * 不存在需要兼容的历史文件，因此章节不在章节根之下时直接返回 undefined，
   * 由调用方说清「这一章不在 chapters/ 下，没法建细纲」，而不是悄悄落到
   * 一个按序号命名、同序号会互相覆盖的位置。
   */
  planPathForChapter(chapterRelPath: string): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (under === undefined) {
      return undefined;
    }
    const parsed = path.parse(under);
    return path.join(this.plansDir, path.join(parsed.dir, `${parsed.name}.md`));
  }

  /**
   * 章节（文件或目录）→ 细纲在 plans/ 下的**工作区相对路径**（正斜杠）。
   * 目录原样镜像。不在章节根之下时 undefined——`carryPlan` 据此判断
   * 「搬出 chapters/ 了，细纲留在原处」。纯计算，不碰磁盘。
   */
  planMirrorRelPath(chapterRelPath: string, isDir: boolean): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (under === undefined) {
      return undefined;
    }
    const parsed = path.parse(under);
    const mirror = isDir ? under : path.join(parsed.dir, `${parsed.name}.md`);
    return this.relPath(path.join(this.plansDir, mirror));
  }

  /**
   * 章节 → 它的场景**目录**绝对路径。
   *
   *   `chapters/卷一/012-夜入青云.md` → `.novelforge/scenes/卷一/012-夜入青云/`
   *
   * 比摘要多开一层同名目录：一章有若干场景，它们要能整体跟着章节走。
   */
  sceneDirForChapter(chapterRelPath: string): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (under === undefined) {
      return undefined;
    }
    const parsed = path.parse(under);
    return path.join(this.scenesDir, path.join(parsed.dir, parsed.name));
  }

  /**
   * 章节（文件或目录）→ 场景目录在 scenes/ 下的工作区相对路径。
   *
   * 文件：去掉扩展名后当目录名（`012-夜入青云.md` → `012-夜入青云/`）。
   * 目录：原样镜像（`卷一/` → `卷一/`）——搬一整卷时里面每章的场景目录
   * 都跟着走。
   */
  sceneMirrorRelPath(chapterRelPath: string, isDir: boolean): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (under === undefined) {
      return undefined;
    }
    const parsed = path.parse(under);
    const mirror = isDir ? under : path.join(parsed.dir, parsed.name);
    return this.relPath(path.join(this.scenesDir, mirror));
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
  }

  // ---------------------------------------------------------------- 初始化

  async initialize(meta: { title: string; author: string }): Promise<void> {
    await fs.mkdir(this.chaptersDir, { recursive: true });
    await fs.mkdir(this.charactersDir, { recursive: true });
    await fs.mkdir(this.loreDir, { recursive: true });
    await fs.mkdir(this.summariesDir, { recursive: true });
    await fs.mkdir(this.plansDir, { recursive: true });
    await fs.mkdir(this.scenesDir, { recursive: true });
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

  // ---------------------------------------------------------------- 章节

  /**
   * 递归扫描 chapters/ 下所有章节文件，按序号排序。
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
    this.chapterCache = chapters;
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

  /**
   * 新建章节文件，返回工作区相对路径。
   * `dir` 是工作区相对的落点目录（如 `chapters/卷一`），缺省落在 chapters/ 根下。
   *
   * `ext` 默认 `.md`：扫描时认任意扩展名，但插件自己建的东西仍然出 markdown，
   * 免得同一个工程里格式随建随变。非 markdown 家族不写标题行。
   *
   * **`title` 留空是合法的**，落成纯序号名 `001.md`：走流水线新建一章时还没有
   * 标题可言（它是写完细纲才定下来的东西）。`parseChapterFileName` 认这种名
   * （词干为空），`listChapters` 的标题回落链会给出「第 N 章」。
   *
   * 标题行写的是**清洗后**的词干而不是原样 `title`：两者一致，改名时
   * `renamedBody` 才认得出「这个 H1 是跟着文件名走的」，同步才不会从第一天
   * 就断掉。无标题时干脆不写标题行——凭空塞一行 `# ` 是同一个毛病。
   */
  async createChapter(order: number, title: string, content = '', dir?: string, ext = '.md'): Promise<string> {
    const stem = title.trim() ? sanitizeFileName(title) : '';
    const fileName = stem ? `${pad3(order)}-${stem}${ext}` : `${pad3(order)}${ext}`;
    const parent = dir ? this.pathOf(dir) : this.chaptersDir;
    const abs = path.join(parent, fileName);
    if (await exists(abs)) {
      throw new Error(`章节文件已存在：${this.relPath(abs)}`);
    }
    const text =
      isMarkdownExt(ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    await writeText(abs, text);
    this.invalidate();
    return this.relPath(abs);
  }

  /** 把文本追加到章节末尾，返回工作区相对路径。 */
  async appendToChapter(chapter: Chapter, text: string): Promise<string> {
    const abs = this.pathOf(chapter.relPath);
    const existing = (await readText(abs)).replace(/\s+$/, '');
    await writeText(abs, `${existing}\n\n${text.trim()}\n`);
    this.invalidate();
    return chapter.relPath;
  }

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

  /**
   * 按需创建草稿，返回它的工作区相对路径。
   *
   * **已存在就原样返回，绝不覆盖**——第二次点「打开草稿」不能把上次写的
   * 东西抹掉。这是「不静默覆盖」在草稿上的落法。
   */
  async ensureDraft(chapter: Chapter): Promise<string> {
    const rel = this.draftRelPathFor(chapter.relPath);
    if (!rel) {
      throw new Error(`这一章不在 ${this.config.chaptersDir}/ 下，无法建草稿：${chapter.relPath}`);
    }
    const abs = this.pathOf(rel);
    if (!(await exists(abs))) {
      // markdown 家族给一行标题好认；其余（.txt / 无扩展名 / .json）留空文件，
      // 往里塞 markdown 语法只会碍事。
      await writeText(abs, isMarkdownPath(rel) ? `# ${chapter.title} · 草稿\n\n` : '');
    }
    return rel;
  }

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
   * 按 file 匹配，匹配不上再按 order 兜底——作者把某章挪进子目录后
   * 路径变了，但那仍是同一章，不该因此丢掉「已总结」的记录。
   */
  async syncManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    const oldByFile = new Map(manifest.chapters.map((c) => [c.file, c]));
    const oldByOrder = new Map(manifest.chapters.map((c) => [c.order, c]));
    const chapters = await this.listChapters();

    manifest.chapters = chapters.map<ManifestChapter>((c) => {
      const old = oldByFile.get(c.relPath) ?? oldByOrder.get(c.order);
      return {
        file: c.relPath,
        order: c.order,
        title: c.title,
        wordCount: c.wordCount,
        contentHash: c.contentHash,
        summaryHash: old?.summaryHash,
        beatsHash: old?.beatsHash,
      };
    });

    await this.writeManifest(manifest);
    return manifest;
  }

  /**
   * 记录某章摘要已基于 hash 生成。
   *
   * 按 relPath 匹配 manifest 条目（同序号撞车时按路径区分），找不到再按 order 兜底。
   */
  async markSummarized(chapter: Chapter, sourceHash: string): Promise<void> {
    const manifest = await this.syncManifest();
    const entry =
      manifest.chapters.find((c) => c.file === chapter.relPath) ??
      manifest.chapters.find((c) => c.order === chapter.order);
    if (entry) {
      entry.summaryHash = sourceHash;
      await this.writeManifest(manifest);
    }
  }

  /**
   * 摘要过期/缺失的章节列表。
   * 以磁盘上摘要文件里的 sourceHash 为准，manifest 只作兜底——
   * 这样即使 manifest 被误删，也不会把所有章节都当成过期而重刷一遍。
   */
  async staleChapters(): Promise<Chapter[]> {
    const chapters = await this.listChapters();
    const stale: Chapter[] = [];
    for (const chapter of chapters) {
      const summary = await this.readSummary(chapter);
      if (!summary || summary.sourceHash !== chapter.contentHash) {
        stale.push(chapter);
      }
    }
    return stale;
  }

  // ---------------------------------------------------------------- 摘要

  /**
   * 读单章摘要。
   *
   * 先按**完整文件名与路径**找新式摘要（`summaryPathForChapter`），找不到再回退到
   * 旧的序号命名 `summaryPath(order)`——升级前已生成的摘要仍能读到，不至于一夜之间
   * 全部「丢失」。两条路径都找不到才算这一章没总结过。
   *
   * 同序号撞车时，新式路径各自独立（这是本次修复的核心）；旧式 `NNN.md` 只有一份，
   * 会被最先匹配到的同序号章节读到——但它的 sourceHash 对不上另一章，会被判过期，
   * 重新生成后落到新路径，不再互相覆盖。
   */
  async readSummary(chapter: Chapter): Promise<ChapterSummary | undefined> {
    // 新式：按文件名与路径映射。
    const abs = this.summaryPathForChapter(chapter.relPath);
    let raw: string | undefined;
    let readFrom = abs;
    if (await exists(abs)) {
      raw = await readText(abs);
    } else {
      // 旧式回退：按序号。升级前的摘要是这种命名。
      const legacy = this.summaryPath(chapter.order);
      if (await exists(legacy)) {
        raw = await readText(legacy);
        readFrom = legacy;
      }
    }
    if (raw === undefined) {
      return undefined;
    }
    const { frontmatter, body } = parseMarkdown(raw);
    const sections = pickSections<keyof SummarySections>(body, SUMMARY_SECTION_KEYS) as SummarySections;
    return {
      order: chapter.order,
      // 报告实际读到的路径（旧式回退时是 NNN.md），点开/明细才指得到文件。
      relPath: this.relPath(readFrom),
      sourceHash: asString(frontmatter.sourceHash),
      content: stripH1(body),
      sections,
      // frontmatter 的 cast 是结构化真相；没有它（0.2.x 之前的摘要、
      // 作者手写的摘要）就从「出场人物」小节的文本回退解析，不让角色页少人。
      cast: parseCast(frontmatter.cast) ?? castFromText(sections.出场人物),
    };
  }

  async writeSummary(chapter: Chapter, sections: SummarySections, cast: SummaryCast[] = []): Promise<string> {
    // 按完整文件名与路径落盘——同序号不同文件名的章节各有独立摘要。
    const abs = this.summaryPathForChapter(chapter.relPath);
    const fm = stringifyFrontmatter({
      order: chapter.order,
      title: chapter.title,
      sourceHash: chapter.contentHash,
      // 机器可读的出场人物。别名跟在名字后的括号里：`林昭(阿昭)`——
      // frontmatter 解析器只认字符串数组，不要为此引入嵌套 YAML。
      cast: cast.map(renderCastEntry),
      generatedBy: 'novel-forge',
    });
    const body = stringifySections(sections as unknown as Record<string, string>, SUMMARY_SECTION_KEYS, {
      keepEmpty: true,
    });
    await writeText(abs, `${fm}\n\n# 第${chapter.order}章 ${chapter.title} · 摘要\n\n${body}\n`);

    // 一次性迁移：新路径与旧式 `NNN.md` 不同时，若旧式文件还在且**该序号唯一**
    // （没有同序号撞车的兄弟章节），就把它删掉——它已被新路径取代，留着只会让
    // summaries/ 里同时冒出 `001.md` 与 `001 序.md` 两份。同序号撞车时不删：
    // 旧式文件是尚未重新生成摘要的那个兄弟章节的回退来源，删了会让它凭空「丢失」。
    const legacy = this.summaryPath(chapter.order);
    if (legacy !== abs && (await exists(legacy))) {
      const sameOrder = (await this.listChapters()).filter((c) => c.order === chapter.order).length;
      if (sameOrder <= 1) {
        await fs.unlink(legacy).catch(() => undefined);
      }
    }

    await this.markSummarized(chapter, chapter.contentHash);
    return this.relPath(abs);
  }

  // ---------------------------------------------------------------- 细纲

  /**
   * 读一章的细纲。没有细纲不是错误——这一章可以还没规划过。
   *
   * 与摘要不同，这里不做旧式路径回退：细纲没有历史包袱（见 planPathForChapter）。
   */
  async readPlan(chapterRelPath: string): Promise<ChapterPlan | undefined> {
    const abs = this.planPathForChapter(chapterRelPath);
    if (!abs || !(await exists(abs))) {
      return undefined;
    }
    try {
      return parsePlanFile(await readText(abs), this.relPath(abs));
    } catch {
      // 读盘本身失败（权限、编码）也当作没有细纲——解析失败在 parsePlanFile
      // 里已经退化过一层了，能走到这里的只有 I/O 异常。
      return undefined;
    }
  }

  /** 写细纲，返回工作区相对路径。 */
  async writePlan(chapterRelPath: string, plan: WritableChapterPlan): Promise<string> {
    const abs = this.planPathForChapter(chapterRelPath);
    if (!abs) {
      throw new Error(`这一章不在 ${this.config.chaptersDir}/ 下，无法建细纲：${chapterRelPath}`);
    }
    await writeText(abs, renderPlanFile(plan));
    return this.relPath(abs);
  }

  // ---------------------------------------------------------------- 场景

  /**
   * 列一章的全部场景，按场景号升序。
   *
   * 顺序由**文件名的数字前缀**决定，与章节同一套规则——作者重排场景顺序
   * 的方式就是改文件名前缀。号码撞车（手改重名）时按路径稳定排序，两条都
   * 留在列表里，让作者看得见冲突。
   */
  async listScenes(chapterRelPath: string): Promise<Scene[]> {
    const dir = this.sceneDirForChapter(chapterRelPath);
    if (!dir) {
      return [];
    }
    const files = await listFilesDeep(dir, isSceneFileName);
    const scenes: Scene[] = [];
    for (const abs of files) {
      scenes.push(parseSceneFile(await readText(abs), this.relPath(abs)));
    }
    scenes.sort((a, b) => a.no - b.no || a.relPath.localeCompare(b.relPath));
    return scenes;
  }

  /** 取某一场。找不到返回 undefined。 */
  async readScene(chapterRelPath: string, sceneNo: number): Promise<Scene | undefined> {
    return (await this.listScenes(chapterRelPath)).find((s) => s.no === sceneNo);
  }

  /**
   * 写一场，返回工作区相对路径。
   *
   * 文件名由场景号与标题决定，所以**改标题会改文件名**：先按场景号找到旧
   * 文件，路径不同就删掉旧的，避免 `02-翻墙.md` 与 `02-翻越侧峰.md` 并存
   * 变成两场。这与章节改名走 `renameEntry` 是两回事——那边是作者在管文件，
   * 这边是产物按自己的命名规则落盘。
   */
  async writeScene(chapterRelPath: string, scene: WritableScene): Promise<string> {
    const dir = this.sceneDirForChapter(chapterRelPath);
    if (!dir) {
      throw new Error(`这一章不在 ${this.config.chaptersDir}/ 下，无法建场景：${chapterRelPath}`);
    }
    const abs = path.join(dir, sceneFileName(scene.no, sanitizeFileName(scene.title)));
    const previous = await this.readScene(chapterRelPath, scene.no);
    await writeText(abs, renderSceneFile(scene));
    if (previous && this.pathOf(previous.relPath) !== abs) {
      await fs.unlink(this.pathOf(previous.relPath)).catch(() => undefined);
    }
    return this.relPath(abs);
  }

  /**
   * 删一场：搬进 `.trash/`，不真删（AGENTS.md 第 6 条）。
   * 返回是否确实删掉了一场。
   */
  async deleteScene(chapterRelPath: string, sceneNo: number): Promise<boolean> {
    const scene = await this.readScene(chapterRelPath, sceneNo);
    if (!scene) {
      return false;
    }
    const target = path.join(this.trashDir, scene.relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(this.pathOf(scene.relPath), target);
    return true;
  }

  /**
   * 一章全部场景拼起来的 hash——正文的上游指纹。
   *
   * 落在 manifest 的 `beatsHash` 里而不是章节文件的 frontmatter，是因为
   * **章节可以是 `.txt` / 无扩展名 / `.json`**（AGENTS.md 第 9 条），
   * 绝不能给正文文件加 frontmatter。
   *
   * 参与哈希的只有场景号与七个小节，不含 `status`——采纳正文时会把场景标成
   * `written`，那一次写入不该反过来让刚写好的正文立刻显示「上游已变更」。
   */
  async beatsHashFor(chapterRelPath: string): Promise<string> {
    const scenes = await this.listScenes(chapterRelPath);
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

  /** 记录某章正文所依据的场景指纹。写完正文后调用，与 markSummarized 同构。 */
  async markBeatsWritten(chapterRelPath: string, beatsHash: string): Promise<void> {
    const manifest = await this.syncManifest();
    const entry = manifest.chapters.find((c) => c.file === chapterRelPath);
    if (entry) {
      entry.beatsHash = beatsHash;
      await this.writeManifest(manifest);
    }
  }

  async readGlobalSummary(): Promise<string> {    if (!(await exists(this.globalSummaryPath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.globalSummaryPath)).body);
  }

  async writeGlobalSummary(content: string, through: number): Promise<string> {
    const fm = stringifyFrontmatter({ through, generatedBy: 'novel-forge' });
    await writeText(this.globalSummaryPath, `${fm}\n\n# 全书滚动摘要\n\n${content.trim()}\n`);
    const manifest = await this.readManifest();
    manifest.globalSummaryThrough = through;
    await this.writeManifest(manifest);
    return this.relPath(this.globalSummaryPath);
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

  async writeCharacter(card: WritableCharacterCard): Promise<string> {
    // slug 可以带子目录（如 `主角/林昭`），writeText 会补齐中间目录。
    const abs = path.join(this.charactersDir, `${card.slug}.md`);
    await writeText(abs, renderCharacterCard(card));
    return this.relPath(abs);
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

  async writeLore(entry: WritableLoreEntry): Promise<string> {
    const abs = path.join(this.loreDir, `${entry.slug}.md`);
    await writeText(abs, renderLoreEntry(entry));
    return this.relPath(abs);
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

  async writeStyleGuide(content: string): Promise<string> {
    await writeText(this.stylePath, `# 文风指南\n\n${content.trim()}\n`);
    return this.relPath(this.stylePath);
  }

  async readOutline(): Promise<string> {
    if (!(await exists(this.outlinePath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.outlinePath)).body);
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
