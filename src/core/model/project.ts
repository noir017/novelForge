import * as crypto from 'crypto';
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
  SummarySections,
} from './types';
import { extractH1, parseMarkdown, pickSections, stringifyFrontmatter, stringifySections, stripH1 } from './markdown';

const NOVEL_DIR = '.novelforge';
/** 0.1.x 用的目录名。检测到就提示迁移，不静默改动用户文件。 */
const LEGACY_NOVEL_DIR = '.novel';
const MANIFEST_FILE = 'project.json';

/** 文件名形如 `001-楔子.md` / `12_初入江湖.md` / `003.md`。 */
const CHAPTER_FILE_RE = /^(\d{1,5})[-_.\s]*(.*?)\.md$/i;

/**
 * 小说工程的数据访问层。
 *
 * 约定：所有 read* 方法每次都读盘（作者随时可能在编辑器里手改文件），
 * 只有章节列表做了一层缓存，由 FileSystemWatcher 主动失效。
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

  get sessionsDir(): string {
    return path.join(this.novelDir, 'sessions');
  }

  /** 0.1.x 的 `.novel/` 目录，仅用于迁移检测。 */
  get legacyNovelDir(): string {
    return path.join(this.root, LEGACY_NOVEL_DIR);
  }

  get globalSummaryPath(): string {
    return path.join(this.summariesDir, 'global.md');
  }

  summaryPath(order: number): string {
    return path.join(this.summariesDir, `${pad3(order)}.md`);
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

  /** 扫描 chapters/ 下所有 `NNN-*.md`，按序号排序。 */
  async listChapters(): Promise<Chapter[]> {
    if (this.chapterCache) {
      return this.chapterCache;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.chaptersDir, { withFileTypes: true });
    } catch {
      this.chapterCache = [];
      return this.chapterCache;
    }

    const chapters: Chapter[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const m = CHAPTER_FILE_RE.exec(entry.name);
      if (!m) {
        continue;
      }
      const abs = path.join(this.chaptersDir, entry.name);
      const raw = await readText(abs);
      const body = raw.trim();
      const title = extractH1(body) ?? (m[2].trim() || `第 ${Number(m[1])} 章`);
      chapters.push({
        order: Number(m[1]),
        title,
        relPath: this.relPath(abs),
        wordCount: countWords(stripH1(body)),
        contentHash: hash(body),
      });
    }

    chapters.sort((a, b) => a.order - b.order);
    this.chapterCache = chapters;
    return chapters;
  }

  async getChapter(order: number): Promise<Chapter | undefined> {
    return (await this.listChapters()).find((c) => c.order === order);
  }

  /** 读章节正文（已去掉 `# 标题` 行）。 */
  async readChapterText(chapter: Chapter): Promise<string> {
    const raw = await readText(this.pathOf(chapter.relPath));
    return stripH1(raw.trim());
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

  /** 新建章节文件，返回工作区相对路径。 */
  async createChapter(order: number, title: string, content = ''): Promise<string> {
    const fileName = `${pad3(order)}-${sanitizeFileName(title)}.md`;
    const abs = path.join(this.chaptersDir, fileName);
    if (await exists(abs)) {
      throw new Error(`章节文件已存在：${fileName}`);
    }
    const text = `# ${title}\n\n${content.trim()}\n`;
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
   */
  async syncManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    const oldByFile = new Map(manifest.chapters.map((c) => [c.file, c]));
    const chapters = await this.listChapters();

    manifest.chapters = chapters.map<ManifestChapter>((c) => ({
      file: c.relPath,
      order: c.order,
      title: c.title,
      wordCount: c.wordCount,
      contentHash: c.contentHash,
      summaryHash: oldByFile.get(c.relPath)?.summaryHash,
    }));

    await this.writeManifest(manifest);
    return manifest;
  }

  /** 记录某章摘要已基于 hash 生成。 */
  async markSummarized(order: number, sourceHash: string): Promise<void> {
    const manifest = await this.syncManifest();
    const entry = manifest.chapters.find((c) => c.order === order);
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
      const summary = await this.readSummary(chapter.order);
      if (!summary || summary.sourceHash !== chapter.contentHash) {
        stale.push(chapter);
      }
    }
    return stale;
  }

  // ---------------------------------------------------------------- 摘要

  async readSummary(order: number): Promise<ChapterSummary | undefined> {
    const abs = this.summaryPath(order);
    if (!(await exists(abs))) {
      return undefined;
    }
    const raw = await readText(abs);
    const { frontmatter, body } = parseMarkdown(raw);
    return {
      order,
      relPath: this.relPath(abs),
      sourceHash: asString(frontmatter.sourceHash),
      content: stripH1(body),
      sections: pickSections<keyof SummarySections>(body, SUMMARY_SECTION_KEYS) as SummarySections,
    };
  }

  async writeSummary(chapter: Chapter, sections: SummarySections): Promise<string> {
    const abs = this.summaryPath(chapter.order);
    const fm = stringifyFrontmatter({
      order: chapter.order,
      title: chapter.title,
      sourceHash: chapter.contentHash,
      generatedBy: 'novel-forge',
    });
    const body = stringifySections(sections as unknown as Record<string, string>, SUMMARY_SECTION_KEYS, {
      keepEmpty: true,
    });
    await writeText(abs, `${fm}\n\n# 第${chapter.order}章 ${chapter.title} · 摘要\n\n${body}\n`);
    await this.markSummarized(chapter.order, chapter.contentHash);
    return this.relPath(abs);
  }

  async readGlobalSummary(): Promise<string> {
    if (!(await exists(this.globalSummaryPath))) {
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
    const files = await listMarkdown(this.charactersDir);
    const cards: CharacterCard[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = baseName(abs);
      cards.push({
        slug,
        relPath: this.relPath(abs),
        name: asString(frontmatter.name) || extractH1(body) || slug,
        aliases: asArray(frontmatter.aliases),
        tags: asArray(frontmatter.tags),
        firstAppear: asNumber(frontmatter.firstAppear),
        lastSeen: asNumber(frontmatter.lastSeen),
        body: stripH1(body),
        sections: pickSections<keyof CharacterSections>(body, CHARACTER_SECTION_KEYS) as CharacterSections,
      });
    }
    cards.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return cards;
  }

  async writeCharacter(card: Omit<CharacterCard, 'relPath' | 'body'>): Promise<string> {
    const abs = path.join(this.charactersDir, `${card.slug}.md`);
    await writeText(abs, renderCharacterCard(card));
    return this.relPath(abs);
  }

  async listLore(): Promise<LoreEntry[]> {
    const files = await listMarkdown(this.loreDir);
    const entries: LoreEntry[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = baseName(abs);
      entries.push({
        slug,
        relPath: this.relPath(abs),
        title: asString(frontmatter.title) || extractH1(body) || slug,
        keywords: asArray(frontmatter.keywords),
        body: stripH1(body),
      });
    }
    return entries;
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

export function renderCharacterCard(card: Omit<CharacterCard, 'relPath' | 'body'>): string {
  const fm = stringifyFrontmatter({
    name: card.name,
    aliases: card.aliases,
    tags: card.tags,
    firstAppear: card.firstAppear,
    lastSeen: card.lastSeen,
  });
  const body = stringifySections(card.sections as unknown as Record<string, string>, CHARACTER_SECTION_KEYS, {
    keepEmpty: true,
  });
  return `${fm}\n\n# ${card.name}\n\n${body}\n`;
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

export function hash(text: string): string {
  return crypto.createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** 中文按字符计，英文按词计，粗略但稳定。 */
export function countWords(text: string): number {
  const stripped = text.replace(/\s+/g, '');
  const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9']+/g) ?? []).length;
  return cjk + words;
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || '未命名'
  );
}

/** 从角色名生成 slug：ASCII 转小写连字符，中文保留。 */
export function slugify(name: string): string {
  return sanitizeFileName(name).toLowerCase() || 'unnamed';
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

export async function writeText(absPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, text, 'utf8');
}

async function writeIfAbsent(absPath: string, text: string): Promise<void> {
  if (!(await exists(absPath))) {
    await writeText(absPath, text);
  }
}

/** 列出目录下所有 .md 文件的绝对路径。 */
async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function baseName(absPath: string): string {
  return path.basename(absPath).replace(/\.md$/i, '');
}

function asString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) {
    return v[0] ?? '';
  }
  return v ?? '';
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) {
    return v.filter((s) => s.trim().length > 0);
  }
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asNumber(v: string | string[] | undefined): number | undefined {
  const s = asString(v);
  if (!s) {
    return undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
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
