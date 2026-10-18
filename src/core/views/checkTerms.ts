/**
 * 内置编辑器「写作体检」要的那份词表（`checkTerms` 消息，类型在 `protocol/check.ts`），以及**这本书的禁用词从
 * 哪几份文件、按什么规则取**——写正文的生成链（`generation/generate.ts` 的 `planWriting`）与编辑器的体检都调
 * {@link readBannedTerms}，同一个函数、同一份输入，编辑器里标出来的与写完一章之后数的不会是两份词表。
 *
 * 读了哪些盘：`style.md`（一次）、`config.md`（调用方给了 `book` 就不读——controller 构建 `ViewState` 时那趟
 * 流水线索引已经读过）、`.novelforge/sensitive.txt`（一次，没有就是没有）。controller 每次 `pushState` 都调，
 * 内容没变就不推（`controller/check.ts`）。
 */
import { NovelProject } from '../model/project';
import { bannedTerms } from '../model/manuscriptCheck';
import { pickSections } from '../model/markdown';
import { readTextIfExists } from '../model/fs';
import { parseSensitiveWords } from '../model/sensitiveWords';
import type { BookConfig } from '../model/settingFile';
import type { CheckTermsView } from '../protocol/check';

/**
 * 这本书写正文时不该用的词（`model/manuscriptCheck.ts` 的 `bannedTerms`）：`style.md` 的「禁用词表」一节、
 * 小说配置的「全局要求」、`config.md` 的类型与子类型。**生成链与编辑器的体检都从这里取**。
 */
export async function readBannedTerms(project: NovelProject, known: { book?: BookConfig } = {}): Promise<string[]> {
  const book = known.book ?? (await project.readBookConfig());
  return bannedTerms({
    styleBanList: pickSections(await project.readStyleGuide(), ['禁用词表']).禁用词表,
    guidance: book.sections.全局要求,
    genre: `${book.genre} ${book.subGenre}`,
  });
}

/** 编辑器的体检词表：禁用词 + 自定义敏感词表。读不到的当没有（第 1 条：绝不抛）。 */
export async function buildCheckTerms(project: NovelProject, known: { book?: BookConfig } = {}): Promise<CheckTermsView> {
  const banned = await readBannedTerms(project, known).catch(() => [] as string[]);
  const raw = await readTextIfExists(project.sensitivePath).catch(() => undefined);
  const list = parseSensitiveWords(raw);
  return {
    banned,
    sensitive: list.terms.map((t) => (t.replacement !== undefined ? { term: t.term, replacement: t.replacement } : { term: t.term })),
    sensitivePath: project.relPath(project.sensitivePath),
    sensitiveExists: raw !== undefined,
    sensitiveBad: list.bad.map((b) => ({ line: b.line, reason: b.reason })),
  };
}
