import { NovelProject } from './model/project';
import { CharacterCard } from './model/types';

/**
 * 出场人物索引：把各章摘要里的 `cast` 反向聚合成「谁在哪些章出现过」。
 *
 * 这是「摘要 → 角色」这条链路的中枢，三处在用：
 * - 工程页的角色区：已建卡的角色补出场章数，未建卡的单列一组等待建卡；
 * - 「更新角色卡」：拿某个角色的出场章节去装配语料；
 * - 角色卡的 `appearsIn` 字段：写卡时从这里取。
 *
 * 关键约定：
 *
 * - **摘要是真相，角色卡里的 appearsIn 只是缓存**。任何时候想知道谁在哪出场，
 *   都从这里重算，不要读角色卡的字段——摘要重跑之后卡里的值就旧了。
 * - **匹配按名字与别名，不按 slug**。摘要里的名字是模型写的，角色卡的
 *   文件名是作者起的，两者没有硬关联；靠 `name ∪ aliases` 建索引。
 * - **一个名字只归一张卡**。同一个名字被两张卡都声明（作者手滑把别名写重了）
 *   时先到先得，并在结果里留下 `conflicts` 让上层能提示。
 */

/** 一位出场人物的聚合结果。 */
export interface CastMember {
  /** 展示名。已建卡的用卡上的 name，未建卡的用摘要里出现最多的那个写法。 */
  name: string;
  /** 摘要里见过的其它称呼（不含 name 本身）。 */
  aliases: string[];
  /** 出场章节序号，升序去重。 */
  chapters: number[];
  /** 已建卡时给出那张卡；未建卡为 undefined。 */
  card?: CharacterCard;
}

export interface CastIndex {
  /** 已建卡的角色（含一次都没在摘要里出现过的——手写的卡也要列出来）。 */
  known: CastMember[];
  /** 摘要里出现、但还没有角色卡的人物，按出场章数降序。 */
  unknown: CastMember[];
  /** 被多张角色卡同时声明的名字，供上层提示作者。 */
  conflicts: { name: string; slugs: string[] }[];
  /** 参与统计的摘要数。为 0 时上层不该显示「没有出场人物」——是还没生成摘要。 */
  summaryCount: number;
}

/**
 * 扫全部摘要，建出场索引。
 *
 * 代价是一次全量读摘要（几百章约几百次小文件读）。工程页每次刷新都调它，
 * 与既有的 `staleChapters()` / `buildProjectTree` 同一量级，没有额外放大：
 * 那两处本来就逐章读过一遍摘要。
 */
export async function buildCastIndex(project: NovelProject): Promise<CastIndex> {
  const cards = await project.listCharacters();
  const chapters = await project.listChapters();

  // 名字/别名 → 角色卡。先建好，扫摘要时直接命中。
  const cardByName = new Map<string, CharacterCard>();
  const conflicts = new Map<string, Set<string>>();
  for (const card of cards) {
    for (const alias of [card.name, ...card.aliases]) {
      const key = normalizeName(alias);
      if (!key) {
        continue;
      }
      const owner = cardByName.get(key);
      if (owner && owner.slug !== card.slug) {
        // 先到先得，但把冲突记下来——两张卡抢同一个名字时，
        // 出场统计必然有一张是错的，作者需要知道。
        const set = conflicts.get(alias) ?? new Set<string>();
        set.add(owner.slug);
        set.add(card.slug);
        conflicts.set(alias, set);
        continue;
      }
      cardByName.set(key, card);
    }
  }

  /** slug → 出场章节；未建卡的用 `?name` 作 key，与 slug 不会撞。 */
  const chaptersOf = new Map<string, Set<number>>();
  /** 未建卡人物：规范化名 → 各种写法的出现次数（选最常见的当展示名）。 */
  const spellings = new Map<string, Map<string, number>>();
  const aliasesOf = new Map<string, Set<string>>();

  let summaryCount = 0;
  for (const chapter of chapters) {
    const summary = await project.readSummary(chapter.order);
    if (!summary) {
      continue;
    }
    summaryCount++;
    for (const entry of summary.cast) {
      // 名字与别名都拿去找卡：模型这一章写的是「阿昭」，也该记到林昭头上。
      const card =
        cardByName.get(normalizeName(entry.name)) ??
        entry.aliases.map((a) => cardByName.get(normalizeName(a))).find(Boolean);
      const key = card ? card.slug : `?${normalizeName(entry.name)}`;

      const set = chaptersOf.get(key) ?? new Set<number>();
      set.add(chapter.order);
      chaptersOf.set(key, set);

      if (!card) {
        const counts = spellings.get(key) ?? new Map<string, number>();
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
        spellings.set(key, counts);
      }
      const known = aliasesOf.get(key) ?? new Set<string>();
      for (const alias of entry.aliases) {
        if (alias.trim()) {
          known.add(alias.trim());
        }
      }
      aliasesOf.set(key, known);
    }
  }

  const known: CastMember[] = cards.map((card) => ({
    name: card.name,
    aliases: [...(aliasesOf.get(card.slug) ?? [])].filter(
      (a) => a !== card.name && !card.aliases.includes(a)
    ),
    chapters: sortedChapters(chaptersOf.get(card.slug)),
    card,
  }));

  const unknown: CastMember[] = [];
  for (const [key, chapterSet] of chaptersOf) {
    if (!key.startsWith('?')) {
      continue;
    }
    const counts = spellings.get(key) ?? new Map<string, number>();
    // 展示名取出现次数最多的写法；打平时取先出现的（Map 保序）。
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key.slice(1);
    unknown.push({
      name,
      aliases: [...(aliasesOf.get(key) ?? [])].filter((a) => a !== name),
      chapters: sortedChapters(chapterSet),
    });
  }
  // 戏份重的排前面：作者要建的卡多半是这些。
  unknown.sort((a, b) => b.chapters.length - a.chapters.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return {
    known,
    unknown,
    conflicts: [...conflicts.entries()].map(([name, slugs]) => ({ name, slugs: [...slugs] })),
    summaryCount,
  };
}

/** 某个角色的出场章节。找不到（名字对不上任何摘要）时返回空数组。 */
export function appearancesOf(index: CastIndex, card: CharacterCard): number[] {
  return index.known.find((m) => m.card?.slug === card.slug)?.chapters ?? [];
}

/**
 * 名字规范化：去掉空白与常见分隔符后比较。
 *
 * 与 markdown.ts 的 `normalizeKey` 同思路但更保守——这里比的是人名，
 * 把中点也抹掉会让「阿·昭」与「阿昭」混为一谈，这在译名里恰恰是有意义的
 * 区别；只抹空白与引号。
 */
function normalizeName(name: string): string {
  return name.replace(/[\s"'「」『』]/g, '').toLowerCase();
}

function sortedChapters(set: Set<number> | undefined): number[] {
  return set ? [...set].sort((a, b) => a - b) : [];
}

/**
 * `第 3、7、12 章` / `第 3、7、12 章等 20 章`——章节列表太长时只列前几个。
 * 前端与日志共用，保证同一份数据在两处说法一致。
 */
export function describeChapters(chapters: number[], max = 6): string {
  if (chapters.length === 0) {
    return '未在摘要中出现';
  }
  const head = chapters.slice(0, max).join('、');
  return chapters.length > max ? `第 ${head} 章等 ${chapters.length} 章` : `第 ${head} 章`;
}
