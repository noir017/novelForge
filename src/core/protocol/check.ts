/**
 * 内置编辑器「写作体检」要的那份词表（`checkTerms` 消息）。**后端算好推给编辑器**，编辑器按正文实时匹配——
 * 词从哪来、怎么认只在后端定一次，前端不读 `style.md` / `config.md`，也不解析敏感词表。
 *
 * - 随 `init` 推一次；之后每次 `pushState`（文件监听、保存、工程页动作）都现算一份，**内容变了才推**（与
 *   `chapterIndex` 同一个做法）——`style.md`、`config.md`、`sensitive.txt` 改了（新建、改、删）就会重推。
 * - 只给有内置编辑器的宿主推（`Host.openInEditor` 这个能力；插件那边打开的是 VS Code 自己的编辑器，用不上）。
 * - 比喻词与拉丁缩写不在这里：它们不随书变（`model/manuscriptCheck.ts` 的 `SIMILE_WORDS` / `SIMILE_LIMIT` /
 *   `latinAcronymRanges`），编辑器直接打包那一份。
 *
 * 构建见 `views/checkTerms.ts`。
 */

/** 敏感词表里的一个词。 */
export interface CheckSensitiveTerm {
  term: string;
  /** 建议的替换词（`词 => 替换词`）。没写就是只标出来。 */
  replacement?: string;
}

export interface CheckTermsView {
  /**
   * 这本书写正文时不该用的词：`style.md` 的「禁用词表」、小说配置「全局要求」里禁止的词、古代题材的现代说法。
   * **与写正文时写完数一遍的是同一份**（`views/checkTerms.ts` 的 `readBannedTerms`，`generate.ts` 也调它）。
   */
  banned: string[];
  /** 自定义敏感词表（`.novelforge/sensitive.txt`）。文件不在时是空的。 */
  sensitive: CheckSensitiveTerm[];
  /** 敏感词表在工程里的相对路径（「编辑敏感词表…」打开的就是它）。 */
  sensitivePath: string;
  /** 敏感词表这份文件在不在。 */
  sensitiveExists: boolean;
  /** 敏感词表里没看懂、跳过的行（1 起）与原因。 */
  sensitiveBad: { line: number; reason: string }[];
}
