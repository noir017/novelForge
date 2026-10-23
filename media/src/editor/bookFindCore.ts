/**
 * 全书查找替换面板（`bookFind.ts`）的纯函数：结果按范围分组、勾选（哪几处勾掉了）与计数、拼替换请求、状态行与汇总的
 * 说法、按「行 + 列」认回编辑区里的位置。**零 DOM**（单测直接跑：`tests/unit/editor/bookFindCore.test.js`）。
 */
import { BOOK_FIND_SCOPES, BOOK_FIND_SCOPE_LABEL } from '../protocol';
import type {
  BookFindFile,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookReplaceRequest,
  BookReplaceSummary,
} from '../protocol';

/** 一处的身份：文件 + 位置。勾掉的那几处按它记，结果重推（预览重来一遍）时还认得出是哪几处。 */
export function hitKey(path: string, hit: { start: number; end: number }): string {
  return `${path}\u0000${hit.start}:${hit.end}`;
}

/** 结果按范围分组（面板上的组标题），组内顺序原样（后端已经按章号 / 路径排好）。 */
export interface ScopeGroup {
  scope: BookFindScope;
  label: string;
  files: BookFindFile[];
  /** 这一组列出来的处数。 */
  hits: number;
}

export function groupByScope(files: readonly BookFindFile[]): ScopeGroup[] {
  const groups: ScopeGroup[] = [];
  for (const scope of BOOK_FIND_SCOPES) {
    const inScope = files.filter((f) => f.scope === scope);
    if (inScope.length > 0) {
      groups.push({ scope, label: BOOK_FIND_SCOPE_LABEL[scope], files: inScope, hits: inScope.reduce((n, f) => n + f.hits.length, 0) });
    }
  }
  return groups;
}

/** 一份文件的勾选框：全勾、勾了一部分、一处都没勾。 */
export function fileCheck(file: BookFindFile, excluded: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const picked = file.hits.filter((h) => !excluded.has(hitKey(file.path, h))).length;
  return picked === 0 ? 'none' : picked === file.hits.length ? 'all' : 'some';
}

/** 勾着的有几个文件几处。`blocked` 里的文件（编辑器里有未保存的修改，替换时会跳过）不算。 */
export function pickedCount(
  files: readonly BookFindFile[],
  excluded: ReadonlySet<string>,
  blocked: ReadonlySet<string> = new Set()
): { files: number; hits: number } {
  let fileCount = 0;
  let hits = 0;
  for (const file of files) {
    if (blocked.has(file.path)) {
      continue;
    }
    const n = file.hits.filter((h) => !excluded.has(hitKey(file.path, h))).length;
    if (n > 0) {
      fileCount++;
      hits += n;
    }
  }
  return { files: fileCount, hits };
}

/** 重推的结果里已经没有的那几处，从「勾掉的」里拿掉（免得越攒越多）。 */
export function pruneExcluded(excluded: ReadonlySet<string>, files: readonly BookFindFile[]): Set<string> {
  const present = new Set(files.flatMap((f) => f.hits.map((h) => hitKey(f.path, h))));
  return new Set([...excluded].filter((k) => present.has(k)));
}

/**
 * 「替换所选」的请求：预览时的查找条件 + 每份文件预览时的 hash + 勾着的那几处。编辑器里有未保存修改的那几份照样带上
 * （列在 `dirty` 里），后端跳过它们、在汇总里说出来——作者看得到「这几份因为没保存没有换」。
 */
export function buildReplaceRequest(
  query: BookFindQuery,
  result: BookFindResult,
  excluded: ReadonlySet<string>,
  dirty: readonly string[]
): BookReplaceRequest {
  const dirtySet = new Set(dirty);
  const files = result.files
    .map((f) => ({
      path: f.path,
      hash: f.hash,
      hits: f.hits
        .filter((h) => dirtySet.has(f.path) || !excluded.has(hitKey(f.path, h)))
        .map((h) => ({ start: h.start, end: h.end })),
    }))
    .filter((f) => f.hits.length > 0);
  return {
    query: query.query,
    caseSensitive: query.caseSensitive === true,
    regex: query.regex === true,
    replacement: query.replacement ?? '',
    scopes: [...query.scopes],
    files,
    dirty: [...dirtySet].filter((p) => files.some((f) => f.path === p)),
  };
}

/** 状态行：「12 个文件，34 处」；预览时补上勾着几处。 */
export function resultStatus(
  result: BookFindResult,
  picked?: { files: number; hits: number },
  blockedFiles = 0
): string {
  if (result.error) {
    return '正则写错了';
  }
  if (result.files.length === 0) {
    return result.scanned === 0 && result.skipped.length === 0 ? '没有可搜的文件' : '全书没有找到';
  }
  const base = `${result.files.length} 个文件，${result.listed} 处`;
  if (!picked) {
    return base;
  }
  const blocked = blockedFiles > 0 ? `；${blockedFiles} 个文件有未保存的修改，会跳过` : '';
  return `${base} · 勾着 ${picked.files} 个文件 ${picked.hits} 处${blocked}`;
}

/** 状态行下面那几句说明：到了上限、有文件没搜。 */
export function resultNotes(result: BookFindResult): string[] {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(
      `只列了前 ${result.truncated.limit} 处：搜到「${result.truncated.at}」就停了，后面的文件没有搜。多打几个字缩小范围；` +
        '替换也只作用于列出来的这些，换完再搜一次接着换。'
    );
  }
  if (result.skipped.length > 0) {
    notes.push(`${result.skipped.length} 个文件没有搜：${result.skipped.map((s) => `${s.label}（${s.reason}）`).join('、')}`);
  }
  return notes;
}

/** 几章的称呼连起来：最多点五个名，多的说「等 N 个」。 */
export function listLabels(labels: readonly string[], max = 5): string {
  const shown = labels.slice(0, max).join('、');
  return labels.length > max ? `${shown} 等 ${labels.length} 个` : shown;
}

export interface SummaryLine {
  text: string;
  tone?: 'warn' | 'error';
}

/** 替换完的汇总：替换了几个文件几处、历史版本是退路、指纹链怎么处理的、角色卡改名、跳过了哪些与为什么。 */
export function summaryLines(s: BookReplaceSummary): SummaryLine[] {
  if (s.error) {
    return [{ text: s.error, tone: 'error' }];
  }
  const out: SummaryLine[] = [];
  out.push({ text: s.files > 0 ? `替换了 ${s.files} 个文件、共 ${s.hits} 处。` : '一处都没有替换。' });
  if (s.files > 0) {
    out.push({
      text:
        '每个改过的文件都可以在「历史」里找回替换前那一版（打开那份文件，点工具栏上的「历史」）。' +
        '跨文件的替换没有一步撤销，历史版本就是退路。',
    });
  }
  if (s.chainKept.length > 0) {
    out.push({ text: `${listLabels(s.chainKept)}：细纲与正文这次一起改了，指纹跟着刷新——正文不挂 ⟳，同步过的也不退回「待同步」。` });
  }
  if (s.plotOnly.length > 0) {
    out.push({ text: `${listLabels(s.plotOnly)}：只改了细纲、正文没跟着改，正文会挂 ⟳（可能跟不上细纲了）。`, tone: 'warn' });
  }
  if (s.bodyOnly.length > 0) {
    out.push({ text: `${listLabels(s.bodyOnly)}：只改了正文、细纲没跟着改，回到「待同步」。`, tone: 'warn' });
  }
  for (const card of s.renamedCards) {
    out.push({
      text: card.nameChanged
        ? `${card.label}：卡里的名字改成了「${card.name}」，文件名没跟着改（认人看的是卡里的名字与别名，不看文件名）；想改文件名，在工程页右键「重命名」。`
        : `${card.label}：别名改了（认人看的是卡里的名字与别名）。`,
    });
  }
  if (s.skipped.length > 0) {
    out.push({ text: `跳过了 ${s.skipped.length} 个文件：`, tone: 'warn' });
    for (const skip of s.skipped) {
      out.push({ text: `${skip.label}——${skip.message}`, tone: 'warn' });
    }
  }
  return out;
}

/**
 * 编辑区里第 `line` 行（从 1 起）第 `col` 个字（从 0 起）的下标；行号超了给末尾，列超了夹到那一行末尾。
 * 后端按磁盘上那一份算的「行 + 列」，编辑区里是 `\n` 换行（磁盘上的 `\r\n` 进 textarea 就成了 `\n`），按下标会差出几格。
 */
export function offsetAt(text: string, line: number, col: number): number {
  let pos = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      return text.length;
    }
    pos = nl + 1;
  }
  const nl = text.indexOf('\n', pos);
  const lineEnd = nl === -1 ? text.length : nl;
  return Math.min(pos + Math.max(0, col), lineEnd);
}

/** 两次查找条件是不是同一个（预览之后又改了输入框，就不是）。 */
export function sameQuery(a: BookFindQuery | null, b: BookFindQuery): boolean {
  return (
    !!a &&
    a.query === b.query &&
    !!a.caseSensitive === !!b.caseSensitive &&
    !!a.regex === !!b.regex &&
    (a.replacement ?? null) === (b.replacement ?? null) &&
    a.scopes.length === b.scopes.length &&
    a.scopes.every((s) => b.scopes.includes(s))
  );
}
