/**
 * 全文检索。**零模型调用的朴素全文扫描**，三期的 `search` 工具吃它。
 *
 * ## 为什么值得单独一个函数
 *
 * 作者问「主角前面说过他没去过北境吗」，现在只能靠手动 `@` 引用几章原文，
 * 跨章对账根本做不了。把它做成 AI 功能等于每问一句烧一次钱，而且会给出
 * 看起来很像但没有依据的答案——与「新鲜度只靠 hash 传播，不调模型」
 * （AGENTS 第 18 条）是同一条取舍：能用确定性方法算出来的，不花 token。
 *
 * ## 四条实现约束
 *
 * 1. **跳过 `.trash/` 与二进制**：回收站里躺着刚删掉的东西，搜出来等于没删；
 *    二进制读成 utf8 是一屏乱码。
 * 2. **单文件读入有上限**（复用 `MAX_EDITABLE_BYTES`），超了跳过并计入 `dropped`。
 * 3. **`dropped > 0` 时必须在返回值里说出来**（第 2 条：不静默截断）——
 *    三期的工具会把它转述给模型，模型不知道自己只看了一半会拿半份证据下结论。
 * 4. **默认按章号排序**，不按文件系统顺序：作者问「他前面说过吗」，
 *    时间线顺序才有意义。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { ArtifactKind, kindOfPath, normalizeRel } from './kind';
import { MAX_EDITABLE_BYTES, isInTrash } from './guard';

const log = scoped('工作区');

/** 递归扫描的深度上限。与 project.ts 的 MAX_TREE_DEPTH 同一个数量级。 */
const MAX_DEPTH = 8;

export interface SearchOptions {
  /** 限定目录，缺省全工程。 */
  path?: string;
  /** 限定种类，如 `['chapter','summary']`。 */
  kinds?: ArtifactKind[];
  /** 正则还是字面量。缺省字面量（作者搜的是人名地名，不是正则）。 */
  regex?: boolean;
  /** 每个文件最多返回几条命中。缺省 5。 */
  perFile?: number;
  /** 总共最多返回几条。缺省 50。 */
  limit?: number;
  /** 命中行前后各带几行。缺省 1。 */
  context?: number;
}

export interface SearchHit {
  rel: string;
  kind: ArtifactKind;
  no?: number;
  /** 行号，从 1 开始。 */
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** 扫了几个文件。 */
  scanned: number;
  /** 因为超上限（或文件太大）被丢掉了几条。**必须报出来**（第 2 条）。 */
  dropped: number;
  /** 降级说明，如「正则写坏了，按字面量搜的」。有值时调用方要转述。 */
  note?: string;
}

/**
 * 扫一遍工程找命中行。**绝不抛**：读不动的文件跳过，坏正则降级成字面量。
 *
 * 这是常驻界面与 agent 工具共用的取数路径，一个权限错误不该让整次检索失败。
 */
export async function search(
  project: NovelProject,
  pattern: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const perFile = clampPositive(opts.perFile, 5);
  const limit = clampPositive(opts.limit, 50);
  const context = Math.max(0, Math.trunc(opts.context ?? 1));
  const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;

  if (!pattern) {
    return { hits: [], scanned: 0, dropped: 0 };
  }

  let note: string | undefined;
  let matcher: (line: string) => boolean;
  if (opts.regex) {
    try {
      const re = new RegExp(pattern);
      matcher = (line) => re.test(line);
    } catch {
      // 坏正则不抛：降级成字面量并说出来。作者输错一个括号不该什么都搜不到，
      // 更不该只看到一句「出错了」。
      note = `正则「${pattern}」写不通，已按字面量搜索。`;
      matcher = (line) => line.includes(pattern);
    }
  } else {
    matcher = (line) => line.includes(pattern);
  }

  // 限定目录：越界给空结果，不抛（这条路径来自前端与模型）。
  let rootRel = '';
  if (opts.path !== undefined && opts.path.trim() !== '') {
    const normalized = normalizeRel(opts.path);
    if (normalized === undefined) {
      return { hits: [], scanned: 0, dropped: 0, note: `路径超出工程目录：${opts.path}` };
    }
    rootRel = normalized;
  }

  const files = await collectFiles(project, rootRel, kinds);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let dropped = 0;

  for (const file of files) {
    const abs = project.pathOf(file.rel);
    let text: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_EDITABLE_BYTES) {
        // 太大就跳过——但**要计进 dropped**，否则作者会以为那一章里没有他要找的东西。
        dropped++;
        continue;
      }
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue; // 权限、刚被删掉：跳过一份文件不该让整次检索失败
    }
    scanned++;

    const lines = text.split(/\r?\n/);
    let taken = 0;
    for (const [i, line] of lines.entries()) {
      if (!matcher(line)) {
        continue;
      }
      if (taken >= perFile) {
        dropped++;
        continue;
      }
      taken++;
      hits.push({
        rel: file.rel,
        kind: file.kind,
        no: file.no,
        line: i + 1,
        text: line,
        before: context > 0 ? lines.slice(Math.max(0, i - context), i) : undefined,
        after: context > 0 ? lines.slice(i + 1, i + 1 + context) : undefined,
      });
    }
  }

  // 按章号升序，无章号的排在最后（大纲、文风、角色卡都没有章号）。
  // 同章内按路径再按行号，输出稳定。
  hits.sort(
    (a, b) =>
      (a.no ?? Number.MAX_SAFE_INTEGER) - (b.no ?? Number.MAX_SAFE_INTEGER) ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line
  );

  if (hits.length > limit) {
    dropped += hits.length - limit;
    hits.length = limit;
  }

  if (dropped > 0) {
    log.debug(`检索「${pattern}」丢了 ${dropped} 条`, `扫了 ${scanned} 个文件，返回 ${hits.length} 条`);
  }
  return { hits, scanned, dropped, note };
}

interface Candidate {
  rel: string;
  kind: ArtifactKind;
  no?: number;
}

/**
 * 收集要扫的文件。
 *
 * 两条过滤在这里做，因为它们都只看路径、不必读盘：
 * **回收站里的一律跳过**（搜出来等于没删），**二进制一律跳过**
 * （`other` 且扩展名在黑名单里）。
 */
async function collectFiles(
  project: NovelProject,
  rootRel: string,
  kinds: Set<ArtifactKind> | undefined
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const rootAbs = rootRel === '' ? project.root : project.pathOf(rootRel);

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (isInTrash(project, childRel) || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const k = kindOfPath(project, childRel);
      if (kinds && !kinds.has(k.kind)) {
        continue;
      }
      // 认不出种类的文件里，只有可能是文本的才读——图片、压缩包、可执行
      // 读成 utf8 是一屏乱码，还会白白占掉 limit。
      if (k.kind === 'other' && !looksTextual(entry.name)) {
        continue;
      }
      out.push({ rel: childRel, kind: k.kind, no: k.no });
    }
  };

  await walk(rootAbs, rootRel, 1);
  return out;
}

/**
 * 这个文件名看着像纯文本吗。
 *
 * 复用章节那条判据（数字前缀 + 扩展名不在二进制黑名单）不合适——它要求数字
 * 前缀，而工程根下的 `README.md` 没有。这里只看扩展名：黑名单之外、且有扩展名
 * 的当文本；无扩展名的一律跳过（`.gitignore` 之类不是作者要搜的东西）。
 */
function looksTextual(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return false;
  }
  return !NON_TEXT_EXTENSIONS.has(ext);
}

/** 二进制黑名单。与 `model/chapterFile.ts` 的 `NON_CHAPTER_EXTENSIONS` 同源。 */
const NON_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.tif', '.tiff', '.avif', '.heic',
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz',
  '.docx', '.doc', '.pdf', '.odt', '.epub', '.mobi', '.azw3',
  '.xls', '.xlsx', '.ppt', '.pptx',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.apk',
  '.jar', '.class', '.wasm', '.pyc',
  '.db', '.sqlite', '.sqlite3',
]);

function clampPositive(value: number | undefined, def: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return def;
  }
  return Math.trunc(value);
}
