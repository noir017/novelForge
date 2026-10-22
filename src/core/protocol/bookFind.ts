/**
 * 全书查找替换（独立版内置编辑器「编辑 → 全书查找替换…」）的消息负载。
 *
 * - 查找 / 预览：前端发 `bookFind`（带 requestId；停顿之后才发，上一次还在搜的先发 `cancelBookFind` 叫停），后端
 *   按范围逐份读盘、匹配，回 `bookFindResult`（同一个 requestId；回复是广播，只有发问的那一边认）。带
 *   `replacement` 就是「预览替换」：每一处多带一个换成什么，每份文件带预览时读到的 hash（替换时的乐观锁基线）。
 * - 替换：前端发 `bookReplace`（预览里勾着的那几处、每份文件的基线、编辑器里有未保存修改的那几份），后端经网关
 *   逐份写，回 `bookReplaceDone`（汇总）。
 *
 * 搜索在 `views/bookFind.ts`（读了哪些盘写在那里），替换在 `features/bookReplace.ts`，口径在 `model/bookFind.ts`
 * 与 `model/textFind.ts`。
 */
import type { BookFindScope } from '../model/bookFindScope';

export type { BookFindScope } from '../model/bookFindScope';

/** 找什么、在哪找。 */
export interface BookFindQuery {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  /** 勾着的范围。一个都没有就什么都不搜。 */
  scopes: BookFindScope[];
  /** 给了就是「预览替换」：每一处带上换成什么（正则时 `$1` 按这一处在全文里展开）。空串也算（换成空 = 删掉）。 */
  replacement?: string;
}

/** 一处。 */
export interface BookFindHit {
  /** 磁盘上那一份（解码之后）的下标，`[start, end)`。替换时原样带回来。 */
  start: number;
  end: number;
  /** 第几行（从 1 起）与那一行里的第几个字（从 0 起）。点这一处时编辑器按它定位。 */
  line: number;
  col: number;
  /** 同一行里命中前后的一截（截过的带「…」）与命中的字（跨行画成「↵」）。只给人看。 */
  before: string;
  text: string;
  after: string;
  /** 预览：这一处换成什么。对不上（极少见）时缺席。 */
  replacement?: string;
}

/** 一份文件的命中。 */
export interface BookFindFile {
  path: string;
  scope: BookFindScope;
  /** 「第 3 章 夜访」「细纲 · 第 3 章 夜访」「角色 · 林晚」「情节大纲」——与编辑器标签、面包屑同一套叫法。 */
  label: string;
  /** 这一次读到的那一份的 hash（与编辑器的乐观锁同一个算法）。替换时带回来：之后磁盘变过就跳过这一份。 */
  hash: string;
  /** 这份文件里一共几处。比 `hits.length` 多 = 到了上限，后面的没列。 */
  count: number;
  hits: BookFindHit[];
}

/** 没搜的那一份与原因（超过 2 MB、读不了）。 */
export interface BookFindSkip {
  path: string;
  label: string;
  reason: string;
}

export interface BookFindResult {
  /** 有命中的文件，按范围（正文、细纲、草稿、角色卡、设定、其他）、范围里按章号 / 名字排。 */
  files: BookFindFile[];
  /** 列出来的处数（各份 `hits` 加起来）。 */
  listed: number;
  /** 读了几份文件。 */
  scanned: number;
  /** 到了上限就停（后面的文件没有读）：上限是几处，停在哪一份上。 */
  truncated?: { limit: number; at: string };
  skipped: BookFindSkip[];
  /** 正则写错了（浏览器给的原因），这时什么都没搜。 */
  error?: string;
}

/** 替换时一份文件：预览时的基线与勾着的那几处（`start` / `end` 原样取自预览）。 */
export interface BookReplaceFileRequest {
  path: string;
  hash: string;
  hits: { start: number; end: number }[];
}

export interface BookReplaceRequest {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  replacement: string;
  /** 预览时勾着的范围（替换只认落在这几个范围里的文件）。 */
  scopes: BookFindScope[];
  files: BookReplaceFileRequest[];
  /** 编辑器里开着、有未保存修改的那几份：一律跳过（让作者先保存或放弃）。 */
  dirty: string[];
}

/**
 * 为什么跳过：`dirty` 编辑器里有未保存的修改；`changed` 预览之后磁盘上改过（不拿旧的盖新的）；`gone` 磁盘上已经没有了；
 * `mismatch` 勾着的那几处在文件里对不上了；`unchanged` 换完与原来一字不差；`noHistory` 没能先存一版历史（这次替换的
 * 退路就是历史版本，存不下就不换）；`outOfScope` 不在全书替换的范围里；`error` 写的时候出错。
 */
export type BookReplaceSkipReason =
  | 'dirty'
  | 'changed'
  | 'gone'
  | 'mismatch'
  | 'unchanged'
  | 'noHistory'
  | 'outOfScope'
  | 'error';

export interface BookReplaceDone {
  path: string;
  label: string;
  /** 换了几处。 */
  count: number;
}

export interface BookReplaceSkipped {
  path: string;
  label: string;
  reason: BookReplaceSkipReason;
  /** 给人看的一句（为什么、作者接着该怎么做）。 */
  message: string;
}

/** 角色卡里的名字或别名换了（文件名没跟着改）。 */
export interface BookReplaceRenamedCard {
  path: string;
  label: string;
  /** 换完之后卡里的名字（frontmatter 的 `name`，没有就是 `# 标题`，再没有是文件名）。 */
  name: string;
  /** 名字换了（false = 只换了别名）。 */
  nameChanged: boolean;
}

export interface BookReplaceSummary {
  /** 换了的文件数与处数。 */
  files: number;
  hits: number;
  replaced: BookReplaceDone[];
  skipped: BookReplaceSkipped[];
  /**
   * 第 18 条（⚑）：这一次里细纲与正文**都**改了、改之前指纹对得上的章（「第 3 章 夜访」）——`writtenFrom`（与定稿过的
   * `sourceHash`）刷成替换之后的，不挂 ⟳、不退回待定稿。
   */
  chainKept: string[];
  /** 只改了细纲、正文没跟着改的章：正文挂 ⟳（正文可能跟不上细纲了）。 */
  plotOnly: string[];
  /** 只改了正文、细纲没跟着改的定稿过的章：回到「待定稿」。 */
  bodyOnly: string[];
  renamedCards: BookReplaceRenamedCard[];
  /** 整个请求没法做（正则写错、查找串为空）。 */
  error?: string;
}
