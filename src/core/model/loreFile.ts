/**
 * 设定的格式定义：细纲第九节「设定」的一行一条、条目的一句话简介与分类、怎么认「同一个东西」。
 *
 * **纯函数、零 I/O**，与 plotFile.ts / threadsFile.ts 同类；条目的读写在 model/project.ts，
 * 名录（谁出现在哪几章、哪些还没建条目）在 views/lore.ts。
 *
 * ## 两处存储，各管一件事
 *
 * - **每章出现了哪些设定** → 那一章细纲的第九节（`Plot.lore`）。写之前是计划（这一章打算用到、
 *   要引入哪些），定稿后是实际（正文里真出现的，以及这一章新确立的定义或规则）。名录只认定稿过的，
 *   和出场人物同一个道理（第 14 条）。会变的状态（谁拿走了、毁了没）不在这里记——照旧进连续性事实，
 *   名录按条目的名字去那里认，不保留两份。
 * - **每个东西是什么** → `lore/<分类>/<名>.md`，一条一份，作者可以手改。
 *
 * ## 分类就是目录
 *
 * 条目所在目录相对 `lore/` 的路径就是它的分类，可以多层（`宗门/正道/青云宗.md` 的分类是
 * `宗门/正道`），根目录下的是「未分类」。**没有固定的分类表**：每本书自己的目录树就是它的分类表
 * （作者定案：每本书的分类不一样）。不另设字段，作者把文件拖到别的目录就是改分类，不会出现
 * 「字段说 A、目录说 B」两份真相。第九节里的 `〔分类〕` 只是给还没建条目的名字定去向用的建议。
 */
import { attachEvidence } from './continuity';
import { hasContent } from './markdown';
import type { LoreEntry } from './types';

/** 第九节的小节名。 */
export const PLOT_LORE_KEY = '设定';

/** 第九节一行的长度上限（字）与最多几行。提示词、解码与解析共用这一份。 */
export const LORE_LINE_LIMITS = {
  lines: 12,
  name: 32,
  category: 40,
  note: 60,
} as const;

/**
 * 条目的字数上限（新增第 27 条：设定条目不能无限膨胀）。正文三节只是机器写入时的格式，
 * 作者写成什么样都照读；整合、建条目的提示词按这几个数做减法。
 */
export const LORE_ENTRY_LIMITS = {
  brief: 40,
  概要: 150,
  规则与边界: 250,
  现状: 150,
  body: 600,
} as const;

/** 机器写条目正文时用的三节。 */
export const LORE_BODY_KEYS = ['概要', '规则与边界', '现状'] as const;

/**
 * 架构 · 设定清单起步时一条正文三节合计最多几字：那是写之前排的，现状多半还没交代，写到了再从定稿里
 * 整合（整合时的上限是 {@link LORE_ENTRY_LIMITS}.body）。提示词与解码共用。
 */
export const LORE_LIST_BODY_MAX = 300;

/** 第九节的一行：`- 名〔分类〕：本章确立的定义或规则`。 */
export interface LoreLine {
  name: string;
  /** 分类路径（`宗门/正道`），没写是空串。 */
  category: string;
  /** 冒号后面那句；只是出现、没有新东西时是空串。 */
  note: string;
}

const LIST_MARKER = /^\s*(?:[-*·•]|\d+[.、)．])\s*/u;
const NOTHING = /^[（(]?\s*(?:无|暂无|没有|本章无)\s*[)）]?$/u;
const BRACKETED = /^(.+?)\s*[〔【[]\s*([^〕】\]]*?)\s*[〕】\]]\s*(?:[：:]\s*(.*))?$/u;

/**
 * 读回第九节。**绝不抛**（第 1 条）：作者会手改，`〔〕` 写成 `【】` `[]`、没写分类、冒号全角半角
 * 都认；认不出分类的整行就是名字（有冒号就切出说明）。同一个名字（归一后）只留第一行。
 * 空行、占位文字与「（无）」跳过。
 */
export function parseLoreLines(text: string): LoreLine[] {
  const out: LoreLine[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!hasContent(line) || NOTHING.test(line)) {
      continue;
    }
    let name: string;
    let category = '';
    let note = '';
    const m = BRACKETED.exec(line);
    if (m) {
      name = m[1];
      category = m[2];
      note = m[3] ?? '';
    } else {
      const at = line.search(/[：:]/u);
      name = at >= 0 ? line.slice(0, at) : line;
      note = at >= 0 ? line.slice(at + 1) : '';
    }
    const clipped = clipLine({ name, category, note });
    const key = normalizeLoreName(clipped.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(clipped);
  }
  return out;
}

/** 渲染第九节。一行也没有时写「（无）」——标题在，表示这一章记过、只是没有设定。 */
export function renderLoreLines(lines: readonly LoreLine[]): string {
  if (lines.length === 0) {
    return '（无）';
  }
  return lines
    .map((l) => `- ${l.name}${l.category ? `〔${l.category}〕` : ''}${l.note ? `：${l.note}` : ''}`)
    .join('\n');
}

/** 一行按上限截短，分类规范成 `a/b`。 */
export function clipLine(line: LoreLine): LoreLine {
  return {
    name: oneLine(line.name).slice(0, LORE_LINE_LIMITS.name),
    category: normalizeLoreCategory(line.category).slice(0, LORE_LINE_LIMITS.category),
    note: oneLine(line.note).slice(0, LORE_LINE_LIMITS.note),
  };
}

/**
 * 分类路径的规范写法：反斜杠、全角斜杠都当 `/`，每一段去掉首尾空白，空段丢掉。
 * 「未分类」与根目录是同一件事，写成空串。
 */
export function normalizeLoreCategory(value: string): string {
  const parts = (value ?? '')
    .replace(/[\\／]/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === '未分类') {
    return '';
  }
  return parts.join('/');
}

/** 条目的分类：slug（去掉扩展名的相对路径）的目录部分，根目录下是空串。 */
export function loreCategoryOfSlug(slug: string): string {
  const at = slug.lastIndexOf('/');
  return at > 0 ? slug.slice(0, at) : '';
}

/**
 * 认「同一个东西」用的写法：小写，去掉空白、标点与符号。`青崖镇` 与 `「青崖镇」`、
 * `Qing Ya` 与 `qingya` 算同一个。
 */
export function normalizeLoreName(value: string): string {
  return (value ?? '').toLocaleLowerCase('zh-Hans-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 条目的一句话：frontmatter 的 `brief`，没写就取正文第一句（跳过小标题与列表记号），
 * 截到 {@link LORE_ENTRY_LIMITS}.brief 字。名录那一行与上下文里「一行带」都用它。
 */
export function loreBrief(entry: Pick<LoreEntry, 'brief' | 'body'>): string {
  const brief = oneLine(entry.brief ?? '');
  if (brief) {
    return brief.slice(0, LORE_ENTRY_LIMITS.brief);
  }
  for (const raw of (entry.body ?? '').split(/\r?\n/)) {
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!hasContent(line) || /^#/.test(line)) {
      continue;
    }
    const first = line.split(/(?<=[。！？!?])/u)[0].trim();
    return first.slice(0, LORE_ENTRY_LIMITS.brief);
  }
  return '';
}

/** 名字表：一个名字（归一后）→ 条目。 */
export interface LoreLookup {
  find(name: string): LoreEntry | undefined;
}

/**
 * 建「名字 → 条目」表。**两趟**：先登记全部条目的标题，再登记关键词，关键词抢不走别人的标题
 * （与 views/cast.ts 的角色卡一样）。同一个键先到先得。
 */
export function createLoreLookup(entries: readonly LoreEntry[]): LoreLookup {
  const byKey = new Map<string, LoreEntry>();
  for (const entry of entries) {
    const key = normalizeLoreName(entry.title);
    if (key && !byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  for (const entry of entries) {
    for (const keyword of entry.keywords) {
      const key = normalizeLoreName(keyword);
      if (key && !byKey.has(key)) {
        byKey.set(key, entry);
      }
    }
  }
  return { find: (name) => byKey.get(normalizeLoreName(name)) };
}

/**
 * 一段文字有没有提到这个条目：标题或任一关键词（至少两个字）作为子串出现，不分大小写。
 * 返回命中的那个词，没提到是 undefined。连续性事实认条目、上下文关键词命中都用它。
 */
export function loreMentionIn(text: string, entry: Pick<LoreEntry, 'title' | 'keywords'>): string | undefined {
  const haystack = (text ?? '').toLocaleLowerCase('zh-Hans-CN');
  for (const word of [entry.title, ...entry.keywords]) {
    const w = (word ?? '').trim();
    if (w.length >= 2 && haystack.includes(w.toLocaleLowerCase('zh-Hans-CN'))) {
      return w;
    }
  }
  return undefined;
}

/**
 * 机器写进条目的关键词过一遍（建条目、整合、设定清单）：**人名不要**（角色卡上的名字与别称——
 * 真跑时模型把「沈怀山」写成了「伪人」的关键词，写正文时一提到这个人就把「伪人」整条带进来），
 * **别的条目的标题不要**（「青羊镇」与「沈家老宅」互相写进对方的关键词，提到一个就命中两条），
 * **名录里另记着的名字不要**（`recorded`：定稿时单独记下、还没建条目的。「魔法体系」把「寒冰锁」收成
 * 关键词，往后各章记下的「寒冰锁」都被认成「魔法体系」，它永远建不出自己的条目——旧的整本重扫就是
 * 这样把几十个法术并进了一条），一个字的不要（子串命中会到处撞），与本条标题重复的去掉。
 * 作者手写的关键词不经过这里：作者认定两个名字是同一个东西，自己加。
 */
export function cleanLoreKeywords(
  title: string,
  keywords: readonly string[],
  others: { titles: readonly string[]; people: readonly string[]; recorded?: readonly string[] }
): string[] {
  const self = normalizeLoreName(title);
  const banned = new Set(
    [...others.titles, ...others.people, ...(others.recorded ?? [])].map(normalizeLoreName).filter((k) => k && k !== self)
  );
  const out: string[] = [];
  const seen = new Set<string>([self]);
  for (const raw of keywords) {
    const word = oneLine(raw);
    const key = normalizeLoreName(word);
    if (Array.from(word).length < 2 || !key || seen.has(key) || banned.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(word);
  }
  return out;
}

function oneLine(value: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- 模型给的「设定」

/**
 * 模型输出里的「设定」字段 → 一行一条。写法五花八门都收（第 1 条）：
 * `[{name, category, fact}]`（`title` / `note` / `说明` 也认）、`["名〔分类〕：说明"]`、整段多行字符串。
 * 定稿、单独记设定、排细纲（`settings`）三处共用。
 */
export function loreLinesFromJson(value: unknown): LoreLine[] {
  if (typeof value === 'string') {
    return parseLoreLines(value);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: LoreLine[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let line: LoreLine | undefined;
    if (typeof item === 'string') {
      line = parseLoreLines(item)[0];
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const text = (v: unknown): string => (typeof v === 'string' ? v : '');
      line = clipLine({
        name: text(obj.name ?? obj.title ?? obj.名称 ?? obj.名字),
        category: text(obj.category ?? obj.分类),
        note: text(obj.fact ?? obj.note ?? obj.说明 ?? obj.事实),
      });
    }
    const key = line ? normalizeLoreName(line.name) : '';
    if (!line || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** 校验时丢掉或改动的一行，写进日志（第 2 条）。 */
export interface LoreLineIssue {
  name: string;
  why: string;
}

/**
 * 定稿与单独记设定写进第九节之前的校验，**不调模型**：
 *
 * - 名字（已有条目时它的标题或任一关键词）必须**逐字出现在正文里**，否则整行丢——第九节是名录的
 *   唯一来源，模型编出来的名字会变成一条凭空的「未建条目」；
 * - 是角色卡上的人（名字或别名）就丢：人不是设定；
 * - 认得出已有条目的，名字换成条目的标题、分类换成条目所在的目录（已建条目以实际目录为准）；
 * - 说明要在正文里找得到依据（与连续性事实同一套 `attachEvidence`），找不到就清空说明、留下名字；
 * - 最多 {@link LORE_LINE_LIMITS}.lines 行。
 */
export function verifyLoreLines(
  lines: readonly LoreLine[],
  content: string,
  known: { entries: readonly LoreEntry[]; people: readonly string[] }
): { lines: LoreLine[]; dropped: LoreLineIssue[]; cleared: LoreLineIssue[] } {
  const lookup = createLoreLookup(known.entries);
  const people = new Set(known.people.map(normalizeLoreName).filter(Boolean));
  const kept: LoreLine[] = [];
  const seen = new Set<string>();
  const dropped: LoreLineIssue[] = [];
  const cleared: LoreLineIssue[] = [];
  for (const raw of lines) {
    const line = clipLine(raw);
    const key = normalizeLoreName(line.name);
    if (!key) {
      continue;
    }
    if (people.has(key)) {
      dropped.push({ name: line.name, why: '是角色卡上的人' });
      continue;
    }
    const entry = lookup.find(line.name);
    const words = entry ? [line.name, entry.title, ...entry.keywords] : [line.name];
    if (!words.some((w) => w.trim() && content.includes(w.trim()))) {
      dropped.push({ name: line.name, why: '正文里没有这个名字' });
      continue;
    }
    const name = entry?.title ?? line.name;
    const dedupe = normalizeLoreName(name);
    if (seen.has(dedupe)) {
      continue;
    }
    let note = line.note;
    if (note && attachEvidence([note], content, words).facts.length === 0) {
      cleared.push({ name, why: `说明在正文里找不到依据：${note}` });
      note = '';
    }
    if (kept.length >= LORE_LINE_LIMITS.lines) {
      dropped.push({ name, why: `超过 ${LORE_LINE_LIMITS.lines} 行` });
      continue;
    }
    seen.add(dedupe);
    kept.push({ name, category: entry ? entry.category : line.category, note });
  }
  return { lines: kept, dropped, cleared };
}
