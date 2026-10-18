/**
 * 内置编辑器「名词补全」（独立版，角色名 / 地名……）要的那份名词表。
 *
 * 前端发 `requestNameIndex`（带 `requestId`，以及手上那一份的 `sig`），后端回 `nameIndex`（同一个 `requestId`）——
 * **按需要，不常驻推送**：只有作者按了补全键、或开着「边打边弹」在打字时才要；手上那份没变（`sig` 对得上）就只回
 * 一个 `sig`、不带表，几百张卡的书也只是几十个字节。
 *
 * 构建见 `views/nameIndex.ts`（读了哪些盘写在那里），匹配与排序是前端的纯函数（`media/src/editor/namesCore.ts`）。
 */

/** 这个名词从哪来。 */
export type NameSource = 'character' | 'lore' | 'unfiled';

/** 一个名词（一张角色卡、一条设定，或名录里出现过、还没建条目的一个名字）。 */
export interface NameEntry {
  /** 正名：角色卡的名字、设定条目的标题、未建条目的名字。 */
  name: string;
  /**
   * 别的叫法：角色卡的别名（外加名字里括号内外各一截，`林昭（阿昭）` 认 `林昭` 与 `阿昭`），设定条目的关键词。
   * 不含正名本身，去重、去空白。未建条目没有。
   */
  aliases: string[];
  source: NameSource;
  /**
   * 类型：设定是它的分类（所在目录相对 `lore/` 的路径，`地点`、`宗门/正道`；根目录下是空串），未建条目是名录给的建议
   * 分类（各章 `〔分类〕` 的多数票，没写过是空串）。角色卡是空串（前端写「角色」）。
   */
  category: string;
  /**
   * 一句话：卡或条目里现成的那一句。设定取 `loreBrief`（frontmatter 的 `brief`，没写就是正文第一句）；角色卡取
   * 「身份」那一节的第一句，没写就是标签；未建条目取最近一章第九节冒号后面那句。都没有是空串。
   */
  brief: string;
  /** 卡或条目的路径。未建条目没有文件，缺席。 */
  path?: string;
}

export interface NameIndex {
  /** 还不是小说工程（没有 `.novelforge/project.json`）时为 false，`names` 是空的。 */
  initialized: boolean;
  /** 角色卡在前（按名字），其次设定条目，最后是未建条目（按出现章数降序）。 */
  names: NameEntry[];
}
