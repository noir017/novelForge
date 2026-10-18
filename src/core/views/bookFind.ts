/**
 * 全书查找（独立版「编辑 → 全书查找替换…」）：按范围逐份读盘、匹配，给出按文件分组的结果。**只读**，一个字节都不写；
 * 替换在 `features/bookReplace.ts`。一份文件里哪些字不搜、每一处的上下文在 `model/bookFind.ts`，匹配口径是
 * `model/textFind.ts`（与内置编辑器的查找条同一份）。
 *
 * ## 读了哪些盘（每搜一次）
 *
 * 不建索引、不缓存文件内容：作者在编辑器里存了一章，下一次搜到的就是新的。所以**每搜一次，范围里的每一份文件读一次**
 * （到了上限就停，后面的不读）：
 *
 * - **正文 / 细纲**：先要一份章节 / 细纲列表（`NovelProject.listChapters()` / `listPlots()`，工程上缓存着，每次
 *   `pushState` 都填上，作者打开面板时几乎总是热的——热的时候列表这一步**零读盘**；冷的时候各递归扫一遍、每份读一次），
 *   然后按章号逐份读一次。三百章的正文约三百次读盘，每份几 KB，加起来几十毫秒。
 * - **草稿**：递归列 `drafts/`（只列不读），文件名像章节的按章号排，逐份读一次；二进制扩展名（与章节同一张黑名单）不读。
 * - **角色卡 / 设定条目**：递归列各自的区（只认 `.md`，只列不读），逐份读一次。
 * - **其他创作文件**：情节大纲、架构三件、文风指南、叙事线、全书摘要七个固定路径，有的读一次。
 * - 单份超过 2 MB（网关的大小上限）不读，列进 `skipped`；读不了（权限、刚被删）同样。
 *
 * 前端在输入停顿 300ms 之后才发请求，新的一次发出之前先叫停上一次（`cancelled`，在两份文件之间看一眼）。
 *
 * ## 上限
 *
 * 列满 {@link BOOK_FIND_LIMIT} 处就停：这一份里多出来的不列（`count` 照实说一共几处），后面的文件不再读，`truncated`
 * 说停在哪一份上。替换也只作用于列出来的这些（预览里看过的才换），换完再搜一次接着换。
 *
 * ## 用的是磁盘上的内容（⚑）
 *
 * 编辑器里开着、有未保存修改的文件，这里搜的仍是磁盘上那一份——后端看不到编辑区，前端在结果上把那几份标出来
 * （「未保存：列的是磁盘上的」），替换时跳过它们。
 */
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { NovelProject, listMarkdownDeep } from '../model/project';
import { NON_CHAPTER_EXTENSIONS, parseChapterFileName } from '../model/chapterFile';
import { exists } from '../model/fs';
import { BOOK_FIND_LIMIT, BOOK_FIND_SCOPES, BookFindScope, isBookFindScope } from '../model/bookFindScope';
import { describeHits, fileHits, replacementsAt } from '../model/bookFind';
import { compileSearch } from '../model/textFind';
import { Workspace, WsError, kindOfPath } from '../workspace';
import type { ArtifactKind } from '../workspace';
import { describeEditorFile } from './editorLabel';
import type { BookFindFile, BookFindQuery, BookFindResult, BookFindSkip } from '../protocol';

const log = scoped('全书查找');

/** 一份要搜的文件。 */
export interface BookTarget {
  path: string;
  scope: BookFindScope;
}

/** 网关的种类 → 全书查找的范围。不在任何一个范围里的（技能、`other`）是 undefined。 */
export function scopeOfKind(kind: ArtifactKind): BookFindScope | undefined {
  switch (kind) {
    case 'chapter':
    case 'plot':
    case 'draft':
    case 'character':
    case 'lore':
      return kind;
    case 'setting':
    case 'outline':
    case 'style':
    case 'threads':
    case 'globalSummary':
      return 'doc';
    default:
      return undefined;
  }
}

/** 结果上怎么称呼这份文件：编辑器标签上的短标记 + 面包屑最后一段（「细纲 · 第 3 章 夜访」「角色 · 林晚」「情节大纲」）。 */
export function bookFileLabel(project: NovelProject, rel: string): string {
  const label = describeEditorFile(project, rel);
  const leaf = label.crumbs[label.crumbs.length - 1]?.label ?? label.title;
  return label.tag ? `${label.tag} · ${leaf}` : leaf;
}

/**
 * 按范围列出要搜的文件，顺序就是结果的顺序：范围按面板上的顺序（正文、细纲、草稿、角色卡、设定、其他），
 * 正文 / 细纲 / 草稿按章号，角色卡、设定按路径，其他按固定顺序。只列，不读内容（正文与细纲的列表借工程上的缓存）。
 */
export async function listBookTargets(project: NovelProject, scopes: readonly BookFindScope[]): Promise<BookTarget[]> {
  const wanted = new Set(scopes.filter(isBookFindScope));
  const out: BookTarget[] = [];
  for (const scope of BOOK_FIND_SCOPES) {
    if (!wanted.has(scope)) {
      continue;
    }
    for (const rel of await pathsOf(project, scope)) {
      out.push({ path: rel, scope });
    }
  }
  return out;
}

async function pathsOf(project: NovelProject, scope: BookFindScope): Promise<string[]> {
  switch (scope) {
    case 'chapter':
      return (await project.listChapters()).map((c) => c.relPath);
    case 'plot':
      return (await project.listPlots()).map((p) => p.relPath);
    case 'draft': {
      const rows = [...(await project.listDraftPaths())]
        .filter((rel) => !NON_CHAPTER_EXTENSIONS.has(path.posix.extname(rel).toLowerCase()))
        .map((rel) => ({ rel, no: parseChapterFileName(path.posix.basename(rel))?.order ?? Number.MAX_SAFE_INTEGER }));
      rows.sort((a, b) => a.no - b.no || a.rel.localeCompare(b.rel));
      return rows.map((r) => r.rel);
    }
    case 'character':
      return (await listMarkdownDeep(project.charactersDir)).map((abs) => project.relPath(abs));
    case 'lore':
      return (await listMarkdownDeep(project.loreDir)).map((abs) => project.relPath(abs));
    case 'doc': {
      const fixed = [
        project.outlinePath,
        project.configPath,
        project.premisePath,
        project.worldPath,
        project.stylePath,
        project.threadsPath,
        project.globalSummaryPath,
      ];
      const present = await Promise.all(fixed.map((abs) => exists(abs)));
      return fixed.filter((_, i) => present[i]).map((abs) => project.relPath(abs));
    }
  }
}

export interface SearchBookOptions {
  /** 叫停了没有。在两份文件之间看一眼，叫停了就不再往下读。 */
  cancelled?: () => boolean;
  /** 最多列多少处（测试用，缺省 {@link BOOK_FIND_LIMIT}）。 */
  limit?: number;
}

/**
 * 搜一遍。叫停了返回 undefined（不回话——前端早就不等这一份了）。正则写错、查找串为空、一个范围都没勾时不读盘，
 * 照实返回（`error` / 空结果）。
 */
export async function searchBook(
  project: NovelProject,
  q: BookFindQuery,
  opts: SearchBookOptions = {}
): Promise<BookFindResult | undefined> {
  const empty: BookFindResult = { files: [], listed: 0, scanned: 0, skipped: [] };
  const query = typeof q.query === 'string' ? q.query : '';
  const findOpts = { caseSensitive: q.caseSensitive === true, regex: q.regex === true };
  const compiled = compileSearch(query, findOpts);
  if (!compiled) {
    return empty;
  }
  if (!compiled.ok) {
    return { ...empty, error: compiled.error };
  }
  const limit = opts.limit ?? BOOK_FIND_LIMIT;
  const preview = typeof q.replacement === 'string' ? q.replacement : undefined;
  const ws = new Workspace(project);
  const targets = await listBookTargets(project, Array.isArray(q.scopes) ? q.scopes : []);

  const files: BookFindFile[] = [];
  const skipped: BookFindSkip[] = [];
  let listed = 0;
  let scanned = 0;
  let truncated: BookFindResult['truncated'];
  const started = Date.now();

  for (const target of targets) {
    if (opts.cancelled?.()) {
      log.debug(`叫停了：「${clip(query)}」`, `读了 ${scanned} / ${targets.length} 份`);
      return undefined;
    }
    let text: string;
    let hash: string;
    try {
      const file = await ws.read(target.path);
      text = file.text;
      hash = file.hash;
    } catch (err) {
      skipped.push({ path: target.path, label: bookFileLabel(project, target.path), reason: skipReason(err) });
      continue;
    }
    scanned++;
    const kind = kindOfPath(project, target.path).kind;
    const found = fileHits(text, kind, query, findOpts);
    if (found.matches.length === 0) {
      continue;
    }
    const room = limit - listed;
    if (room <= 0) {
      // 上一份正好把上限列满：这一份有命中，说明后面还有——停在这里，这一份不列。
      truncated = { limit, at: bookFileLabel(project, target.path) };
      break;
    }
    const shown = found.matches.slice(0, room);
    const lines = describeHits(text, shown);
    const after = preview !== undefined ? replacementsAt(text, shown, query, preview, findOpts) : undefined;
    files.push({
      path: target.path,
      scope: target.scope,
      label: bookFileLabel(project, target.path),
      hash,
      count: found.matches.length,
      hits: lines.map((h, i) => (after && after[i] !== undefined ? { ...h, replacement: after[i] } : h)),
    });
    listed += shown.length;
    if (found.matches.length > room) {
      truncated = { limit, at: bookFileLabel(project, target.path) };
      break;
    }
  }

  log.debug(
    `${preview !== undefined ? '预览替换' : '全书查找'}「${clip(query)}」`,
    `${files.length} 个文件 ${listed} 处｜读了 ${scanned} / ${targets.length} 份｜${Date.now() - started}ms${truncated ? `｜到上限停在 ${truncated.at}` : ''}`
  );
  return { files, listed, scanned, skipped, ...(truncated ? { truncated } : {}) };
}

function skipReason(err: unknown): string {
  if (err instanceof WsError) {
    if (err.code === 'tooLarge') {
      return '超过 2 MB，没有搜';
    }
    if (err.code === 'notFound' || err.code === 'notFile') {
      return '刚才还在，读的时候没有了';
    }
  }
  return `读不了：${err instanceof Error ? err.message : String(err)}`;
}

/** 日志里的查找串（第 11 条：日志里不出现正文全文；查找串本来就短，再截一下）。 */
export function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > 30 ? `${one.slice(0, 30)}…` : one;
}
