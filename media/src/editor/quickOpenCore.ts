/**
 * 「转到…」（Ctrl+P）的匹配与排序。**纯函数、零 DOM**：面板（`quickOpen.ts`）只管画与按键，
 * 认章号、打分、挑前几条、切高亮都在这里，单测见 `tests/unit/editor/quickOpenCore.test.js`。
 *
 * ## 打分（高的排前面，同分按类型 → 章号 → 索引里的先后）
 *
 * | 档 | 分 | 说明 |
 * |---|---|---|
 * | 章号直接命中 | 1000 | `12`、`第12章`、`第 12 章`、`第十二章`、`十二`、`一百零五`、`１２`（全角数字）都认（{@link parseChapterNo}） |
 * | 章号前缀 | 550–590 | 只打阿拉伯数字时，`12` 也列出第 120–129 章（边打边缩小） |
 * | 名字子串 | 340–500 | 标题 / 角色名 / 设定标题 / 文件名里有这几个字（连着）。开头就是、整个就是的再高一点 |
 * | 别名子串 | 比名字低 5 | 角色别名 |
 * | 名字模糊 | 140–200 | 这几个字按先后顺序都在（中间可以隔着别的字），隔得越少越高 |
 * | 别名模糊 | 比名字低 5 | |
 * | 路径子串 | 65–100 | 兜底：文件名、卷目录（`第一卷`）、整个相对路径 |
 * | 路径模糊 | 10–60 | |
 *
 * 中文按字（按码位切，不按 UTF-16）；英文不分大小写；查询里的空白不算。
 *
 * ## 性能
 *
 * 索引到了先 {@link buildCatalog} 一次（小写、按字切好），之后每打一个字只是对每一条跑一遍子串 / 模糊
 * （名字几个字、路径几十个字）。挑前几条用定长的有序数组插入（{@link QUICK_OPEN_LIMIT} 条），不给几百章整个排序；
 * 面板也只画这几条。
 */
import type { QuickOpenDocKey, QuickOpenIndex } from '../protocol';

/** 一次最多列几条。 */
export const QUICK_OPEN_LIMIT = 50;
/** 空输入时「最近打开的」最多列几条。 */
export const RECENT_SHOWN = 8;
/** 空输入时在「最近打开的」后面再列前几章。 */
export const LEAD_CHAPTERS = 10;
/** localStorage 里最多记几条最近打开的。 */
export const RECENT_KEPT = 20;

export type QuickOpenKind = 'chapter' | 'character' | 'lore' | 'doc' | 'draft';

/** 同分时的先后：章节、角色、设定、文档、草稿。 */
const KIND_ORDER: Record<QuickOpenKind, number> = { chapter: 0, character: 1, lore: 2, doc: 3, draft: 4 };

/** 架构三件与情节大纲算「架构」（工程页「故事架构」那一组），其余几份叫「文档」。 */
const DOC_BADGE: Record<QuickOpenDocKey, string> = {
  config: '架构',
  premise: '架构',
  world: '架构',
  outline: '架构',
  style: '文档',
  threads: '文档',
  globalSummary: '文档',
};

/** 面板上的一条。 */
export interface QuickOpenEntry {
  /** 身份：章节是 `chapter:<章号>`，其余是 `file:<路径>`。最近打开的去重认它。 */
  key: string;
  kind: QuickOpenKind;
  /** 类型标记（「章」「角色」「设定」「架构」「文档」「草稿」）。 */
  badge: string;
  /** 主名称：章节是标题（没有标题时「第 N 章」），角色是名字，其余是标题 / 文件名。 */
  name: string;
  /** 一行小字：「第 12 章 · 第一卷 · 3200 字」/「别名 阿昭 / 小林」/ 路径。 */
  detail: string;
  /** 打开的那个文件：章节是正文（没有正文时是细纲）。 */
  path: string;
  /** 认得出这一条的全部路径（章节：正文与细纲），「最近打开的」按它认、路径兜底按它配。 */
  paths: string[];
  no?: number;
  chapterPath?: string;
  plotPath?: string;
  aliases: string[];
  /** `detail` 里每个别名的起点（别名命中时在小字里高亮）。 */
  aliasAt: number[];
  /** 「第 N 章」在 `detail` 里的长度（章号命中时高亮它；它总在开头）。 */
  noLabelLength: number;
  /** 在索引里的先后（同分时最后一道比较）。 */
  order: number;
  /** 搜索用：小写、按码位切好。章节的 `name` 只放标题（回落的「第 N 章」不参与名字匹配，章号另认）。 */
  search: { name: string[]; aliases: string[][]; paths: string[][] };
}

/** 一份索引切好之后的样子。 */
export interface QuickOpenCatalog {
  entries: QuickOpenEntry[];
  /** 路径 → 那一条（章节的正文与细纲都指向同一章）。 */
  byPath: Map<string, QuickOpenEntry>;
  initialized: boolean;
}

/** 一条结果。 */
export interface QuickOpenHit {
  entry: QuickOpenEntry;
  score: number;
  /** 主名称里要高亮的字（码位下标）。 */
  nameHits: number[];
  /** 这一条显示的小字：一般是 `entry.detail`，按路径命中时换成命中的那个路径（让人看得出为什么列出来）。 */
  detail: string;
  /** 小字里要高亮的字（码位下标）。 */
  detailHits: number[];
  /** 空输入时分的组。 */
  group?: 'recent' | 'chapters';
}

export interface QuickOpenResult {
  hits: QuickOpenHit[];
  /** 一共命中几条（超过上限时比 `hits` 多）。 */
  total: number;
}

// ---------------------------------------------------------------- 索引 → 条目

const chars = (text: string): string[] => Array.from(text.toLowerCase());

/** 把后端给的索引切成面板上的条目。索引到了做一次，之后每打一个字只搜不切。 */
export function buildCatalog(index: QuickOpenIndex): QuickOpenCatalog {
  const entries: QuickOpenEntry[] = [];
  const add = (e: Omit<QuickOpenEntry, 'order' | 'search' | 'aliasAt' | 'noLabelLength' | 'aliases'> & {
    aliases?: string[];
    searchName?: string;
    aliasAt?: number[];
    noLabelLength?: number;
  }): void => {
    const aliases = e.aliases ?? [];
    entries.push({
      key: e.key,
      kind: e.kind,
      badge: e.badge,
      name: e.name,
      detail: e.detail,
      path: e.path,
      paths: e.paths,
      ...(e.no !== undefined ? { no: e.no } : {}),
      ...(e.chapterPath ? { chapterPath: e.chapterPath } : {}),
      ...(e.plotPath ? { plotPath: e.plotPath } : {}),
      aliases,
      aliasAt: e.aliasAt ?? [],
      noLabelLength: e.noLabelLength ?? 0,
      order: entries.length,
      search: {
        name: chars(e.searchName ?? e.name),
        aliases: aliases.map(chars),
        paths: e.paths.map(chars),
      },
    });
  };

  for (const ch of index.chapters ?? []) {
    const path = ch.chapterPath || ch.plotPath;
    if (!path) {
      continue;
    }
    const noLabel = `第 ${ch.no} 章`;
    const state = ch.chapterPath ? `${ch.words} 字` : '只有细纲';
    add({
      key: `chapter:${ch.no}`,
      kind: 'chapter',
      badge: '章',
      name: ch.title || noLabel,
      searchName: ch.title,
      detail: [noLabel, ch.volume, state].filter(Boolean).join(' · '),
      noLabelLength: Array.from(noLabel).length,
      path,
      paths: [ch.chapterPath, ch.plotPath].filter((p): p is string => !!p),
      no: ch.no,
      chapterPath: ch.chapterPath,
      plotPath: ch.plotPath,
    });
  }
  for (const c of index.characters ?? []) {
    const aliases = (c.aliases ?? []).filter((a) => a.trim() !== '');
    let detail = c.path;
    const aliasAt: number[] = [];
    if (aliases.length > 0) {
      detail = '别名 ';
      aliases.forEach((a, i) => {
        if (i > 0) {
          detail += ' / ';
        }
        aliasAt.push(Array.from(detail).length);
        detail += a;
      });
    }
    add({ key: `file:${c.path}`, kind: 'character', badge: '角色', name: c.name, detail, path: c.path, paths: [c.path], aliases, aliasAt });
  }
  for (const l of index.lore ?? []) {
    add({ key: `file:${l.path}`, kind: 'lore', badge: '设定', name: l.title, detail: l.path, path: l.path, paths: [l.path] });
  }
  for (const d of index.docs ?? []) {
    add({ key: `file:${d.path}`, kind: 'doc', badge: DOC_BADGE[d.key] ?? '文档', name: d.label, detail: d.path, path: d.path, paths: [d.path] });
  }
  for (const d of index.drafts ?? []) {
    add({ key: `file:${d.path}`, kind: 'draft', badge: '草稿', name: d.name, detail: d.path, path: d.path, paths: [d.path] });
  }

  const byPath = new Map<string, QuickOpenEntry>();
  for (const entry of entries) {
    for (const p of entry.paths) {
      if (!byPath.has(p)) {
        byPath.set(p, entry);
      }
    }
  }
  return { entries, byPath, initialized: index.initialized !== false };
}

// ---------------------------------------------------------------- 章号

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_NUMERAL = /^[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万]+$/;

/**
 * 中文数字 → 数。认「十二」「二十」「一百零五」「一百一十二」「两百」「一千零一」「三万」这类常见写法，
 * 也认逐位写的「一〇五」「一二三」。认不出给 undefined。
 */
export function parseChineseNumber(text: string): number | undefined {
  if (!text || !CN_NUMERAL.test(text)) {
    return undefined;
  }
  const units = [...text].filter((c) => c in CN_UNIT || c === '万');
  if (units.length === 0) {
    // 逐位写：一〇五 = 105。只有一个字就是那个数。
    return Number([...text].map((c) => CN_DIGIT[c]).join(''));
  }
  let total = 0;
  let section = 0;
  let digit: number | undefined;
  for (const c of text) {
    if (c in CN_DIGIT) {
      digit = CN_DIGIT[c];
    } else if (c in CN_UNIT) {
      // 「十二」的十前面没有数：当一。
      section += (digit ?? 1) * CN_UNIT[c];
      digit = undefined;
    } else {
      // 万
      section += digit ?? 0;
      total += (section || 1) * 10000;
      section = 0;
      digit = undefined;
    }
  }
  return total + section + (digit ?? 0);
}

/**
 * 查询是不是在找第几章：`12`、`012`、`第12章`、`第 12 章`、`12章`、`第十二章`、`十二`、`第一百零五回`、全角的 `１２`。
 * 不是就给 undefined（`第一卷`、`12a`、`三叔` 都不是）。
 */
export function parseChapterNo(query: string): number | undefined {
  const q = query
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /^第?([0-9]+|[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万]+)[章回节]?$/.exec(q);
  if (!m) {
    return undefined;
  }
  const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}

// ---------------------------------------------------------------- 文本匹配

interface CharMatch {
  /** 连着的子串（true）还是按先后顺序的模糊（false）。 */
  sub: boolean;
  /** 第一个字的位置。 */
  first: number;
  /** 模糊匹配时中间隔了几个字（子串是 0）。 */
  gaps: number;
  hits: number[];
}

/** `q` 在 `text` 里：先找连着的子串，找不到再按先后顺序找每一个字。都是码位数组、已经小写。 */
export function matchChars(text: readonly string[], q: readonly string[]): CharMatch | undefined {
  if (q.length === 0 || q.length > text.length) {
    return undefined;
  }
  outer: for (let i = 0; i + q.length <= text.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (text[i + j] !== q[j]) {
        continue outer;
      }
    }
    return { sub: true, first: i, gaps: 0, hits: q.map((_, j) => i + j) };
  }
  const hits: number[] = [];
  let at = 0;
  for (const c of q) {
    while (at < text.length && text[at] !== c) {
      at++;
    }
    if (at >= text.length) {
      return undefined;
    }
    hits.push(at++);
  }
  return { sub: false, first: hits[0], gaps: hits[hits.length - 1] - hits[0] + 1 - hits.length, hits };
}

/** 名字（标题、角色名、别名、文件名）这一档的分。 */
function nameScore(m: CharMatch, textLength: number, qLength: number): number {
  if (m.sub) {
    return 400 + (m.first === 0 ? 50 : 0) + (textLength === qLength ? 50 : 0) - Math.min(m.first, 40) - Math.min(textLength - qLength, 40) * 0.5;
  }
  return 200 - Math.min(m.gaps, 40) - Math.min(m.first, 40) * 0.5;
}

/** 路径兜底这一档的分。命中落在文件名里（最后一个 `/` 之后）的高一点。 */
function pathScore(m: CharMatch, text: readonly string[], qLength: number): number {
  const base = text.lastIndexOf('/') + 1;
  if (m.sub) {
    return 100 - (m.first >= base ? 0 : 10) - Math.min(text.length - qLength, 100) * 0.25;
  }
  return 60 - Math.min(m.gaps, 40) - Math.min(m.first, 40) * 0.25 - (m.first >= base ? 0 : 5);
}

/** 一条在这个查询下的得分与高亮；不命中给 undefined。 */
function scoreEntry(entry: QuickOpenEntry, q: string[], no: number | undefined, digits: string | undefined): QuickOpenHit | undefined {
  let best: QuickOpenHit | undefined;
  const offer = (hit: QuickOpenHit): void => {
    if (!best || hit.score > best.score) {
      best = hit;
    }
  };
  const noHits = (): number[] => Array.from({ length: entry.noLabelLength }, (_, i) => i);

  if (entry.kind === 'chapter' && entry.no !== undefined) {
    if (no !== undefined && entry.no === no) {
      offer({ entry, score: 1000, nameHits: [], detail: entry.detail, detailHits: noHits() });
    } else if (digits !== undefined) {
      const s = String(entry.no);
      if (s.length > digits.length && s.startsWith(digits)) {
        offer({ entry, score: 600 - Math.min(s.length - digits.length, 5) * 10, nameHits: [], detail: entry.detail, detailHits: noHits() });
      }
    }
  }

  const name = matchChars(entry.search.name, q);
  if (name) {
    offer({ entry, score: nameScore(name, entry.search.name.length, q.length), nameHits: name.hits, detail: entry.detail, detailHits: [] });
  }
  entry.search.aliases.forEach((alias, i) => {
    const m = matchChars(alias, q);
    if (m) {
      const at = entry.aliasAt[i] ?? 0;
      offer({
        entry,
        score: nameScore(m, alias.length, q.length) - 5,
        nameHits: [],
        detail: entry.detail,
        detailHits: m.hits.map((h) => h + at),
      });
    }
  });
  // 名字与别名已经命中了就不必再看路径：路径那一档的分高不过它们。
  if (!best || best.score < 100) {
    entry.search.paths.forEach((p, i) => {
      const m = matchChars(p, q);
      if (m) {
        offer({ entry, score: pathScore(m, p, q.length), nameHits: [], detail: entry.paths[i], detailHits: m.hits });
      }
    });
  }
  return best;
}

/** a 排在 b 前面时为负。 */
function compareHits(a: QuickOpenHit, b: QuickOpenHit): number {
  return (
    b.score - a.score ||
    KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] ||
    (a.entry.no ?? 0) - (b.entry.no ?? 0) ||
    a.entry.order - b.entry.order
  );
}

/** 往定长的有序数组里插一条（超出上限的那条挤掉）。 */
function insertTop(top: QuickOpenHit[], hit: QuickOpenHit, limit: number): void {
  if (top.length >= limit && compareHits(hit, top[top.length - 1]) >= 0) {
    return;
  }
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareHits(top[mid], hit) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  top.splice(lo, 0, hit);
  if (top.length > limit) {
    top.pop();
  }
}

export interface SearchOptions {
  /** 最多列几条（缺省 {@link QUICK_OPEN_LIMIT}）。 */
  limit?: number;
  /** 最近打开过的路径，新的在前（空输入时用）。 */
  recent?: readonly string[];
  /** 空输入时最近打开的最多列几条（缺省 {@link RECENT_SHOWN}）。 */
  recentShown?: number;
  /** 空输入时再列前几章（缺省 {@link LEAD_CHAPTERS}）。 */
  leadChapters?: number;
}

/**
 * 搜一次。空输入时列「最近打开的」（按路径认回条目，认不出的——删了、不在索引里——跳过，同一章的正文与
 * 细纲只算一条），后面接前几章。
 */
export function searchQuickOpen(catalog: QuickOpenCatalog, query: string, opts: SearchOptions = {}): QuickOpenResult {
  const limit = Math.max(1, opts.limit ?? QUICK_OPEN_LIMIT);
  const q = chars(query.replace(/\s+/g, ''));
  if (q.length === 0) {
    return emptyQuery(catalog, opts, limit);
  }
  const no = parseChapterNo(query);
  const digits = /^[0-9]+$/.test(q.join('')) ? String(Number(q.join(''))) : undefined;
  const top: QuickOpenHit[] = [];
  let total = 0;
  for (const entry of catalog.entries) {
    const hit = scoreEntry(entry, q, no, digits);
    if (hit) {
      total++;
      insertTop(top, hit, limit);
    }
  }
  return { hits: top, total };
}

function emptyQuery(catalog: QuickOpenCatalog, opts: SearchOptions, limit: number): QuickOpenResult {
  const hits: QuickOpenHit[] = [];
  const seen = new Set<string>();
  const recentShown = opts.recentShown ?? RECENT_SHOWN;
  for (const path of opts.recent ?? []) {
    if (hits.length >= Math.min(recentShown, limit)) {
      break;
    }
    const entry = catalog.byPath.get(path);
    if (entry && !seen.has(entry.key)) {
      seen.add(entry.key);
      hits.push({ entry, score: 0, nameHits: [], detail: entry.detail, detailHits: [], group: 'recent' });
    }
  }
  let lead = opts.leadChapters ?? LEAD_CHAPTERS;
  for (const entry of catalog.entries) {
    if (lead <= 0 || hits.length >= limit) {
      break;
    }
    if (entry.kind === 'chapter' && !seen.has(entry.key)) {
      seen.add(entry.key);
      hits.push({ entry, score: 0, nameHits: [], detail: entry.detail, detailHits: [], group: 'chapters' });
      lead--;
    }
  }
  return { hits, total: hits.length };
}

// ---------------------------------------------------------------- 最近打开的 / 高亮

/** 把刚打开的路径记到最前面（去重、只留 {@link RECENT_KEPT} 条）。 */
export function pushRecent(list: readonly string[], path: string, max = RECENT_KEPT): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

/** 按高亮的下标（码位）把一段字切成几截，连着的高亮并成一截。 */
export function highlightSegments(text: string, hits: readonly number[]): { text: string; hit: boolean }[] {
  const set = new Set(hits);
  const out: { text: string; hit: boolean }[] = [];
  Array.from(text).forEach((c, i) => {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) {
      last.text += c;
    } else {
      out.push({ text: c, hit });
    }
  });
  return out;
}
