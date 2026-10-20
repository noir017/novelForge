/**
 * 「名词补全」的匹配与排序（角色名、地名……），外加「名词高亮」在正文里认名字。**纯函数、零 DOM**：装配（按键、
 * 弹出框、插入）在 `names.ts`，名词图层与悬停浮窗在 `nameMarks.ts`；从光标前取查询词、按开头匹配、排序、边打边弹的
 * 判定、插入时替换哪一段、正文里哪几段是名字都在这里，单测见 `tests/unit/editor/namesCore.test.js`。
 *
 * ## 查询词：中文没有词边界
 *
 * 从光标往前取 1~{@link MAX_QUERY} 个字（碰到空白、标点就停），挑**能匹配上某个名字开头的最长那段**
 * （{@link queryBefore}）：「他看见林」认「林」，「青云」认「青云」。什么都匹配不上就是空查询——手动按键时列全部。
 *
 * ## 匹配与排序（{@link matchNames}）
 *
 * - **只认开头**：查询词是正名或某个别名（角色别名、设定关键词）的开头，不分大小写。一个名词只列一行：正名对得上就是
 *   正名，否则第一个对得上的别名（显示「别名 → 正名」，插入的是那个别名）。拼音首字母不认——`/` 命令面板的拼音键是
 *   每条命令手写的，没有现成的汉字转拼音表可复用（⚑）。
 * - **最近在本文件出现的排前面**：光标（准确说是查询词开头）往前 {@link RECENT_BEFORE} 字里出现过的，越近越前；只在
 *   光标后面 {@link RECENT_AFTER} 字里出现过的其次；都没出现过的最后。同一档里角色 → 设定 → 未建条目，正名先于别名，
 *   短的先于长的，最后按表里的先后。
 *
 * ## 边打边弹（{@link autoPopQuery}，⚑）
 *
 * 只认打字与输入法上屏（带 `change` 的那一下，组字中途不算）、刚插入了字、没有选区；查询词至少
 * {@link AUTO_MIN_CHARS} 个字；**已经打完整了不弹**（查询词正好是某个名字或别名）；名字剩下那截已经在光标后面的不算。
 *
 * ## 名词高亮：正文里哪几段是名字（{@link nameRanges}）
 *
 * 与补全同一张表、同一套叫法（正名与别名，不分大小写），一趟扫完（`locateTerms`）。
 * - **长的优先、不重叠**：「林昭阳」不会被认成「林昭」加一个「阳」；同一处起头的取最长的那个叫法。
 * - **一个字的叫法不认**（⚑）：「道」「气」这样的设定一标就是满屏。后端给的别名本来就不收一个字的，这里连正名一起挡。
 * - **英文叫法要整词**：前后挨着字母或数字的不算（「Lin」不认「Linear」里那一截）。中文没有词边界，照认。
 * - **卡或条目自己那一份里不标它自己**（⚑）：角色卡通篇是这个人的名字，标出来只是满屏的底色。
 * - 两条叫法撞了（角色的别名正好是某条设定的关键词）：表里排前面的那条算（角色 → 设定 → 未建条目）。
 */
import { foldLatin, locateTerms } from '../protocol';
import type { NameEntry, NameIndex, NameSource } from '../protocol';
import type { TextChange } from './history';

/** 从光标往前最多取几个字当查询词。 */
export const MAX_QUERY = 4;
/** 边打边弹：查询词至少几个字（⚑ 2：一个字时「林」「沈」这类常用字一打就弹，太吵）。 */
export const AUTO_MIN_CHARS = 2;
/** 弹出框一次最多列几条。 */
export const NAME_LIST_LIMIT = 50;
/** 「最近在本文件出现」往前看多少字。 */
export const RECENT_BEFORE = 20_000;
/** 往后看多少字（前面没出现过、后面出现过的排在第二档）。 */
export const RECENT_AFTER = 5_000;

/**
 * 哪些文件补全：正文（章节、草稿）、细纲、角色卡、设定条目，外加情节大纲与叙事线（⚑）——作者会写到名字的
 * Markdown。小说配置、故事前提、世界观后端都给 `setting`，分不出哪份是配置，一律不补；敏感词表（`sensitive`，
 * `.novelforge/sensitive.txt`，写作体检读它）、文风、全文大纲、技能、别的文件不补。是白名单：以后新加的种类缺省不补。
 * 看后端给的 `kind`，前端不拿路径猜。
 */
const COMPLETION_KINDS: ReadonlySet<string> = new Set(['chapter', 'draft', 'plot', 'character', 'lore', 'outline', 'threads']);

export function completionApplies(kind: string | undefined): boolean {
  return !!kind && COMPLETION_KINDS.has(kind);
}

/** 同一档里的先后：角色、设定、未建条目。 */
const SOURCE_ORDER: Record<NameSource, number> = { character: 0, lore: 1, unfiled: 2 };

/** 一个叫法（正名或别名）。 */
export interface NameForm {
  text: string;
  /** 小写，比较用。 */
  lower: string;
  alias: boolean;
}

/** 表里的一条（切好的）。 */
export interface NameItem {
  /** 在表里的先后。 */
  order: number;
  name: string;
  aliases: string[];
  source: NameSource;
  category: string;
  brief: string;
  path?: string;
  /** 类型那一格：角色卡写「角色」，设定与未建条目写分类，没有分类写「设定」。 */
  badge: string;
  /** 正名在前，别名按原来的先后。 */
  forms: NameForm[];
}

export interface NameCatalog {
  items: NameItem[];
  /** 小写的前 1~{@link MAX_QUERY} 个字：有没有哪个叫法这样开头（取查询词用）。 */
  prefixes: Set<string>;
  /** 小写的完整叫法（判「打完整了」用）。 */
  exact: Set<string>;
  initialized: boolean;
}

/** 把后端给的表切好。表到了做一次，之后每打一个字只查不切。 */
export function buildNameCatalog(index: NameIndex | undefined): NameCatalog {
  const items: NameItem[] = [];
  const prefixes = new Set<string>();
  const exact = new Set<string>();
  for (const entry of index?.names ?? []) {
    const item = toItem(entry, items.length);
    if (!item) {
      continue;
    }
    items.push(item);
    for (const form of item.forms) {
      exact.add(form.lower);
      const cps = Array.from(form.lower);
      for (let k = 1; k <= Math.min(MAX_QUERY, cps.length); k++) {
        prefixes.add(cps.slice(0, k).join(''));
      }
    }
  }
  return { items, prefixes, exact, initialized: index?.initialized !== false };
}

function toItem(entry: NameEntry, order: number): NameItem | undefined {
  const name = (entry.name ?? '').trim();
  if (!name) {
    return undefined;
  }
  const seen = new Set<string>([name.toLowerCase()]);
  const forms: NameForm[] = [{ text: name, lower: name.toLowerCase(), alias: false }];
  for (const raw of entry.aliases ?? []) {
    const text = (raw ?? '').trim();
    const lower = text.toLowerCase();
    if (text && !seen.has(lower)) {
      seen.add(lower);
      forms.push({ text, lower, alias: true });
    }
  }
  const source: NameSource = entry.source === 'lore' || entry.source === 'unfiled' ? entry.source : 'character';
  const category = entry.category ?? '';
  return {
    order,
    name,
    aliases: forms.filter((f) => f.alias).map((f) => f.text),
    source,
    category,
    brief: entry.brief ?? '',
    ...(entry.path ? { path: entry.path } : {}),
    badge: source === 'character' ? '角色' : category || '设定',
    forms,
  };
}

// ---------------------------------------------------------------- 查询词

/** 名字里会出现的字：文字、数字、附加符号，外加外文名里的间隔号与连字符、撇号。 */
const NAME_CHAR = /^[\p{L}\p{N}\p{M}·・•‧'’-]$/u;

export function isNameChar(ch: string): boolean {
  return NAME_CHAR.test(ch);
}

/** 一段文字的查询词与它在全文里的起点（`area.value` 的下标）。`query` 是空串时 `start` 就是光标。 */
export interface NameQuery {
  query: string;
  start: number;
}

/** 光标前那几个名字里会出现的字（至多 `max` 个，按码位），碰到别的就停。 */
function charsBefore(text: string, caret: number, max: number): string[] {
  const out: string[] = [];
  let pos = Math.max(0, Math.min(caret, text.length));
  while (out.length < max && pos > 0) {
    let width = 1;
    const low = text.charCodeAt(pos - 1);
    if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
      const high = text.charCodeAt(pos - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        width = 2;
      }
    }
    const ch = text.slice(pos - width, pos);
    if (!isNameChar(ch)) {
      break;
    }
    out.unshift(ch);
    pos -= width;
  }
  return out;
}

/**
 * 从光标往前取 1~{@link MAX_QUERY} 个字，挑能匹配上某个名字（或别名）开头的最长那段；一段都匹配不上给空查询。
 */
export function queryBefore(catalog: NameCatalog, text: string, caret: number): NameQuery {
  const at = Math.max(0, Math.min(caret, text.length));
  const chars = charsBefore(text, at, MAX_QUERY);
  for (let k = chars.length; k >= 1; k--) {
    const query = chars.slice(chars.length - k).join('');
    if (catalog.prefixes.has(query.toLowerCase())) {
      return { query, start: at - query.length };
    }
  }
  return { query: '', start: at };
}

/** `start` 到光标那一段还是不是一个查询词（全是名字里的字）。手动弹出之后接着打字时用：碰到空白、标点就收起。 */
export function queryBetween(text: string, start: number, caret: number): string | undefined {
  if (caret < start || start < 0 || caret > text.length) {
    return undefined;
  }
  const query = text.slice(start, caret);
  for (const ch of query) {
    if (!isNameChar(ch)) {
      return undefined;
    }
  }
  return query;
}

// ---------------------------------------------------------------- 匹配与排序

/** 弹出框里的一行。 */
export interface NameCandidate {
  item: NameItem;
  /** 显示并插入的那个叫法：正名对得上就是正名，否则第一个对得上的别名。空查询时是正名。 */
  form: string;
  viaAlias: boolean;
  /** `form` 里要高亮的字（码位下标）：查询词那几个。 */
  hits: number[];
  /** 0：查询词之前出现过；1：只在光标后面出现过；2：都没出现过。 */
  rank: number;
  /** 同一档里的远近：越大越近。 */
  near: number;
}

export interface MatchOptions {
  /** 当前文件的全部文字与查询词的起点、光标（算「最近出现」用）。 */
  text: string;
  start: number;
  caret: number;
  /** 最多列几条（缺省 {@link NAME_LIST_LIMIT}）。 */
  limit?: number;
  /**
   * 只要还没打完的（边打边弹）：叫法比查询词长、剩下那截不在光标后面。正好是查询词的那个叫法不列，
   * 那一个名词还有别的叫法对得上的照样列。
   */
  unfinished?: boolean;
}

export interface MatchResult {
  items: NameCandidate[];
  /** 一共对上几条（超过上限时比 `items` 多）。 */
  total: number;
}

/** 按开头匹配、排序。空查询列全部（手动按键时）。 */
export function matchNames(catalog: NameCatalog, query: string, opts: MatchOptions): MatchResult {
  const lower = query.toLowerCase();
  const qLen = Array.from(query).length;
  const after = opts.unfinished ? opts.text.slice(opts.caret, opts.caret + 64).toLowerCase() : '';
  const fits = (form: NameForm): boolean =>
    form.lower.startsWith(lower) &&
    (!opts.unfinished || (form.lower.length > lower.length && !after.startsWith(form.lower.slice(lower.length))));

  const found: NameCandidate[] = [];
  for (const item of catalog.items) {
    const form = item.forms.find(fits);
    if (form) {
      found.push({
        item,
        form: form.text,
        viaAlias: form.alias,
        hits: Array.from({ length: qLen }, (_, i) => i),
        rank: 2,
        near: 0,
      });
    }
  }

  // 「最近出现」：查询词开头之前那一段（不含正在打的这几个字）与光标之后那一段，各小写一次。
  const before = opts.text.slice(Math.max(0, opts.start - RECENT_BEFORE), Math.max(0, opts.start)).toLowerCase();
  const later = opts.text.slice(opts.caret, opts.caret + RECENT_AFTER).toLowerCase();
  for (const c of found) {
    let last = -1;
    let first = Infinity;
    for (const form of c.item.forms) {
      last = Math.max(last, before.lastIndexOf(form.lower));
      const at = later.indexOf(form.lower);
      if (at >= 0) {
        first = Math.min(first, at);
      }
    }
    if (last >= 0) {
      c.rank = 0;
      c.near = last;
    } else if (first !== Infinity) {
      c.rank = 1;
      c.near = -first;
    }
  }

  found.sort(compareCandidates);
  const limit = Math.max(1, opts.limit ?? NAME_LIST_LIMIT);
  return { items: found.slice(0, limit), total: found.length };
}

function compareCandidates(a: NameCandidate, b: NameCandidate): number {
  return (
    a.rank - b.rank ||
    b.near - a.near ||
    SOURCE_ORDER[a.item.source] - SOURCE_ORDER[b.item.source] ||
    Number(a.viaAlias) - Number(b.viaAlias) ||
    Array.from(a.form).length - Array.from(b.form).length ||
    a.item.order - b.item.order
  );
}

// ---------------------------------------------------------------- 边打边弹

/** 内容变化那一下（`onEditorChange` 的 `edit`）里判定要用的几样。 */
export interface AutoPopInput {
  /** `typing` / `composition` / `program` / …（`api.ts` 的 `EditSource`）。 */
  source: string;
  /** 这一处改动；组字中途没有。 */
  change?: TextChange;
  /** 改动之后的全文与选区。 */
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** 输入法正在组字。 */
  composing?: boolean;
}

/**
 * 光标前这几个字该不该弹（不看是怎么打出来的）：查询词至少 {@link AUTO_MIN_CHARS} 个字、不是哪个叫法的全称、
 * 还有没打完的叫法。该弹给查询词，不该弹给 undefined。边打边弹开着时，弹出框还开着、作者退格了也用它重判。
 */
export function autoQueryAt(catalog: NameCatalog, text: string, caret: number): NameQuery | undefined {
  const q = queryBefore(catalog, text, caret);
  if (Array.from(q.query).length < AUTO_MIN_CHARS || catalog.exact.has(q.query.toLowerCase())) {
    return undefined;
  }
  const open = matchNames(catalog, q.query, { text, start: q.start, caret, limit: 1, unfinished: true });
  return open.total > 0 ? q : undefined;
}

/**
 * 边打边弹：这一下改动之后要不要弹。只认打字与输入法上屏（带 `change`）、刚插入了字、光标就在插进来的字后面、
 * 没有选区；组字中途、删字、粘贴、程序改写、撤销一律不弹。
 */
export function autoPopQuery(catalog: NameCatalog, ev: AutoPopInput): NameQuery | undefined {
  if (ev.composing || (ev.source !== 'typing' && ev.source !== 'composition')) {
    return undefined;
  }
  const c = ev.change;
  if (!c || c.inserted === '' || ev.selectionStart !== ev.selectionEnd || ev.selectionEnd !== c.at + c.inserted.length) {
    return undefined;
  }
  return autoQueryAt(catalog, ev.text, ev.selectionEnd);
}

// ---------------------------------------------------------------- 插入

/** 接受一条时换掉哪一段、换成什么、光标落在哪。 */
export interface NameInsertion {
  start: number;
  end: number;
  text: string;
  caret: number;
}

/**
 * 换掉作者已经打的那几个字（查询词，从 `start` 到光标；有选区时连选中的一起），补成整个叫法；光标落在名字后面。
 * 光标后面的字一个不动。
 */
export function insertionFor(start: number, selectionStart: number, selectionEnd: number, form: string): NameInsertion {
  const from = Math.min(start, selectionStart);
  const end = Math.max(selectionStart, selectionEnd);
  return { start: from, end, text: form, caret: from + form.length };
}

// ---------------------------------------------------------------- 名词高亮

/** 名词图层上各来源的 class（颜色在 `css/standalone/names.css`）：角色、设定条目画淡底色，未建条目画虚下划线。 */
export const NAME_MARK_CLASS: Readonly<Record<NameSource, string>> = {
  character: 'ed-hl-name-character',
  lore: 'ed-hl-name-lore',
  unfiled: 'ed-hl-name-unfiled',
};

/** 正文里认名字用的那张表。表到了做一次，之后每次重算只查不建。 */
export interface NameMatcher {
  /** 要找的叫法（原样，`locateTerms` 折大小写去找）。 */
  terms: string[];
  /** 折过大小写的叫法 → 哪一条（撞了的取表里排前面的）。 */
  byForm: Map<string, NameItem>;
}

/** 一段名字。 */
export interface NameRange {
  start: number;
  end: number;
  cls: string;
  item: NameItem;
}

const LATIN_WORD = /[A-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/;

export function buildNameMatcher(catalog: NameCatalog): NameMatcher {
  const terms: string[] = [];
  const byForm = new Map<string, NameItem>();
  for (const item of catalog.items) {
    for (const form of item.forms) {
      const key = foldLatin(form.text);
      if (Array.from(key).length < 2 || byForm.has(key)) {
        continue;
      }
      byForm.set(key, item);
      terms.push(form.text);
    }
  }
  return { terms, byForm };
}

/** 这一段字是表里哪一条的叫法（悬停时按镜像层上那一段的字认回去）。 */
export function nameItemOf(matcher: NameMatcher, text: string): NameItem | undefined {
  return matcher.byForm.get(foldLatin(text));
}

/** 英文叫法前后挨着字母、数字就不是这个名字。 */
function wholeWord(text: string, start: number, end: number): boolean {
  if (LATIN_WORD.test(text[start]) && start > 0 && LATIN_WORD.test(text[start - 1])) {
    return false;
  }
  return !(LATIN_WORD.test(text[end - 1]) && end < text.length && LATIN_WORD.test(text[end]));
}

/**
 * 正文里哪几段是名字（见文件头「名词高亮」）。`selfPath`：正在看的这份文件——是某张卡或某个条目自己时，不标它自己。
 * 按位置排好、互不重叠。
 */
export function nameRanges(matcher: NameMatcher, text: string, selfPath?: string): NameRange[] {
  if (matcher.terms.length === 0 || !text) {
    return [];
  }
  const all: NameRange[] = [];
  for (const hit of locateTerms(text, matcher.terms, { foldCase: true })) {
    const item = matcher.byForm.get(foldLatin(hit.term));
    if (!item || (selfPath && item.path === selfPath)) {
      continue;
    }
    for (const at of hit.offsets) {
      const end = at + hit.term.length;
      if (wholeWord(text, at, end)) {
        all.push({ start: at, end, cls: NAME_MARK_CLASS[item.source], item });
      }
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: NameRange[] = [];
  let edge = 0;
  for (const r of all) {
    if (r.start >= edge) {
      out.push(r);
      edge = r.end;
    }
  }
  return out;
}
