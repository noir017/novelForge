/**
 * 全书查找替换的范围与上限。**纯数据、零 import**：面板上那几个勾选框（`media/src/editor/bookFind.ts`）与后端按范围
 * 列文件（`views/bookFind.ts`）、替换时认路径（`features/bookReplace.ts`）读的是同一张表——界面上写着「角色卡」，
 * 后端搜的就得是角色卡那个区。经 `media/src/protocol.ts` 打进浏览器产物。
 */

/** 一个范围：正文、细纲、草稿、角色卡、设定条目，以及其余几份创作文件（大纲 / 架构三件 / 文风 / 叙事线 / 全书摘要）。 */
export type BookFindScope = 'chapter' | 'plot' | 'draft' | 'character' | 'lore' | 'doc';

/** 面板上的顺序，也是结果分组的顺序。 */
export const BOOK_FIND_SCOPES: readonly BookFindScope[] = ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'];

/** 勾选框上的字与结果分组的标题。 */
export const BOOK_FIND_SCOPE_LABEL: Record<BookFindScope, string> = {
  chapter: '正文',
  plot: '细纲',
  draft: '草稿',
  character: '角色卡',
  lore: '设定条目',
  doc: '其他创作文件',
};

/** 勾选框的提示：这一项搜哪些文件。 */
export const BOOK_FIND_SCOPE_HINT: Record<BookFindScope, string> = {
  chapter: '章节根下的正文（按章号）',
  plot: '每一章的细纲（.novelforge/summaries/ 下，按章号）',
  draft: 'drafts/ 下的草稿',
  character: '角色卡（.novelforge/characters/）',
  lore: '设定条目（.novelforge/lore/）',
  doc: '情节大纲、小说配置、故事前提、世界观、文风指南、叙事线、全书摘要',
};

/** 打开面板时缺省勾上哪几项：只有正文（⚑ 作者最常搜的是正文；要连细纲、角色卡一起改名时自己勾上）。 */
export const DEFAULT_BOOK_FIND_SCOPES: readonly BookFindScope[] = ['chapter'];

/**
 * 一次最多列多少处。到了就停：后面的文件不再读，结果里说「只列了前 N 处」并说停在哪一份上（⚑）。
 * 搜一个「的」在三百章里能有十几万处——全列出来既读不完也看不完，多打几个字缩小范围才是正路。
 * 替换也只作用于列出来的这些（预览里看过的才换，第 19 条），换完再搜一次接着换。
 */
export const BOOK_FIND_LIMIT = 1000;

/** 每一处那一行上下文：命中之前最多带几个字、之后最多带几个字（同一行之内，超了用「…」截）。 */
export const BOOK_FIND_CONTEXT = { before: 24, after: 40 } as const;

/** 认不认得这个范围（前端传上来的是字符串）。 */
export function isBookFindScope(value: unknown): value is BookFindScope {
  return typeof value === 'string' && (BOOK_FIND_SCOPES as readonly string[]).includes(value);
}
