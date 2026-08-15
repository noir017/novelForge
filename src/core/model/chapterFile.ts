import * as path from 'node:path';

/**
 * 「什么文件算章节」的唯一定义。
 *
 * 纯函数、无 I/O，因此扫描器（model/project.ts）、内置编辑器的可编辑判定
 * （core/files/fileEditing.ts）、独立版的文件监听（standalone/fileHost.ts）
 * 三处共用同一份规则，不会各写一遍再慢慢跑偏。
 *
 * 规则：**数字前缀 + 扩展名不在二进制黑名单里**。
 *
 * 用黑名单而不是白名单，是因为正文的花样挡不完——作者可能从别处导入
 * `.txt`，可能存成无扩展名，也可能用 `.json` 存一份结构化稿。这些都该是
 * 章节。反过来「打开必然是乱码」的那批（图片、音视频、压缩包、Office
 * 文档、可执行文件）是可枚举的，把它们挡在外面就够了——否则往 chapters/
 * 里丢一张 `001-封面.png` 就会凭空多出「第 1 章」，还会被 utf8 读成乱码
 * 塞进 LLM 上下文。
 */

/** 不当作章节正文的扩展名。小写、含点。 */
export const NON_CHAPTER_EXTENSIONS: ReadonlySet<string> = new Set([
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.tif', '.tiff', '.avif', '.heic',
  // 音视频
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  // 压缩包
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz',
  // 富文档容器（.rtf 刻意不列：它是 ASCII 标记，编辑器打得开）
  '.docx', '.doc', '.pdf', '.odt', '.epub', '.mobi', '.azw3',
  '.xls', '.xlsx', '.ppt', '.pptx',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 可执行 / 二进制
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.apk',
  '.jar', '.class', '.wasm', '.pyc',
  // 数据库
  '.db', '.sqlite', '.sqlite3',
]);

/** markdown 家族。只有这一族才解析 `# 标题`。 */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

export interface ChapterFileName {
  order: number;
  /** 去掉序号前缀与扩展名后的词干，可能为空（如 `003.md`）。 */
  stem: string;
  /** 小写扩展名，含点；无扩展名为 ''。 */
  ext: string;
}

/**
 * 文件名 → 章节信息。无数字前缀、或扩展名在黑名单里，返回 undefined。
 *
 * 必须**先剥扩展名再匹配序号前缀**：前缀分隔符里含 `.`，直接对整个文件名
 * 跑正则的话，`003.md` 会被吃成「序号 003 + 词干 md」。
 *
 * 边角：`001.楔子` 会被 path.extname 认成扩展名 `.楔子`——它不在黑名单里，
 * 于是解析为第 1 章、词干为空、标题回落「第 1 章」。够合理，不额外处理。
 */
export function parseChapterFileName(fileName: string): ChapterFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext && NON_CHAPTER_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const m = /^(\d{1,5})[-_.\s]*(.*)$/.exec(base);
  if (!m) {
    return undefined;
  }
  return { order: Number(m[1]), stem: m[2], ext };
}

export function isChapterFileName(fileName: string): boolean {
  return parseChapterFileName(fileName) !== undefined;
}

export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}

export function isMarkdownPath(relPath: string): boolean {
  return isMarkdownExt(path.extname(relPath));
}

// ---------------------------------------------------------------- 拆分标记

/**
 * 正文里的拆分标记：**单独占一行的 `---`**（前后允许空白）。
 *
 * 选它而不是别的符号，是因为它在 Markdown 里本来就是分隔线：作者在编辑器里
 * 看到的就是一条横线，所见即所得，而且不认识这个约定的人也不会觉得碍眼。
 *
 * 三个及以上的短横（`----`）同样算——Markdown 本身就允许，作者顺手多打
 * 一个不该让拆分静默失效。
 */
const SPLIT_MARK = /^[ \t]*-{3,}[ \t]*$/;

/**
 * 把一章的正文按拆分标记切成若干片。**纯函数，绝不抛。**
 *
 * 规则：
 * - 逐行扫描，遇到标记行就断开，标记行本身不进任何一片；
 * - 每一片首尾的空白去掉；
 * - **空片直接丢弃**——连着两条 `---`、或首尾各有一条，都不该产出一个空章节。
 *
 * 于是「没有任何标记」返回一片（原文），「整篇只有标记」返回零片。
 * 调用方据此判断要不要重编号（一片就不必）、以及能不能拆（零片是错误）。
 *
 * 传进来的应当是**去掉 frontmatter 与 `# 标题` 行之后**的正文
 * （`Manuscript.text` 正是那个），否则第一片会带上标题行。
 */
export function splitByMark(text: string): string[] {
  const pieces: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const piece = current.join('\n').trim();
    if (piece) {
      pieces.push(piece);
    }
    current = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (SPLIT_MARK.test(line)) {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return pieces;
}
