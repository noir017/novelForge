import { buildIdentityGroups, IdentityChapter, RejectedLink } from '../model/identity';
import { NovelProject } from '../model/project';
import { CharacterCard, SummaryCast } from '../model/types';
import { normalizeName, sanitizeAliases } from '../model/naming';

/**
 * 出场人物索引：把各段摘要里的 `cast` 反向聚合成「谁在哪几段出现过」。
 *
 * 这是「摘要 → 角色」这条链路的中枢，三处在用：
 * - 工程页的角色区：已建卡的角色补出场段数，未建卡的单列一组等待建卡；
 * - 「更新角色卡」：拿某个角色的出场段去装配语料；
 * - 角色卡的 `appearsIn` 字段：写卡时从这里取。
 *
 * 关键约定：
 *
 * - **摘要是真相，角色卡里的 appearsIn 只是缓存**。任何时候想知道谁在哪出场，
 *   都从这里重算，不要读角色卡的字段——摘要重跑之后卡里的值就旧了。
 * - **匹配按名字与别名，不按 slug**。摘要里的名字是模型写的，角色卡的
 *   文件名是作者起的，两者没有硬关联；靠 `name ∪ aliases` 建索引。
 * - **正式名压过别名**。两趟登记：先把所有卡的 `name` 占上，再登记别名，
 *   别名抢不走别人的正式名。实战里模型给方源的卡挂过一条 `方正` 别名
 *   （那是她孪生弟弟），先到先得会让方正的出场章节整批记到方源头上。
 * - **卡上的别名先过泛称过滤**（[model/naming.ts](../model/naming.ts)）。`姐姐`、`她` 这类
 *   称呼谁都能用，拿去匹配会把几个角色串成一个。只影响匹配，不改文件。
 * - **未建卡的人物经 [model/identity.ts](../model/identity.ts) 聚类**，不再按主名硬分——
 *   摘要里 `方源` 与 `古月方源` 交替出现，只按主名分会各建一张卡。
 * - 一个名字被两张卡同时声明时先到先得，并在 `conflicts` 里留下记录，
 *   由工程页提示作者（出场统计必然有一张是错的）。
 */

/** 一位出场人物的聚合结果。 */
export interface CastMember {
  /** 展示名。已建卡的用卡上的 name，未建卡的用摘要里出现最多的那个写法。 */
  name: string;
  /** 摘要里见过的其它称呼（不含 name 本身）。 */
  aliases: string[];
  /** 出场段号，升序去重。 */
  plots: number[];
  /** 已建卡时给出那张卡；未建卡为 undefined。 */
  card?: CharacterCard;
}

/** 两张卡抢同一个称呼。 */
export interface CastConflict {
  /** 被抢的称呼。 */
  name: string;
  /** 卷入的角色卡 slug。第一个是当前占着这个称呼的那张。 */
  slugs: string[];
  /**
   * - `name`：两张卡的**正式名**一模一样，多半是同一个人被建了两张卡。
   * - `alias`：一个称呼被多张卡当成自己的（别名撞别名，或别名撞上别人的正式名）。
   */
  kind: 'name' | 'alias';
}

export interface CastIndex {
  /** 已建卡的角色（含一次都没在摘要里出现过的——手写的卡也要列出来）。 */
  known: CastMember[];
  /** 摘要里出现、但还没有角色卡的人物，按出场章数降序。 */
  unknown: CastMember[];
  /** 被多张角色卡同时声明的称呼，供上层提示作者。 */
  conflicts: CastConflict[];
  /**
   * 聚类时被守卫拦下的「看着像同一人但判定为两个人」的链接。
   * 维护命令用它解释「为什么方源和方正没有合并」。
   */
  rejectedLinks: RejectedLink[];
  /** 参与统计的摘要数。为 0 时上层不该显示「没有出场人物」——是还没生成摘要。 */
  summaryCount: number;
}

/**
 * 扫全部摘要，建出场索引。
 *
 * 代价是一次全量读摘要（几百段约几百次小文件读）。工程页每次刷新都调它，
 * 与既有的 `stalePlots()` / `buildProjectTree` 同一量级，没有额外放大：
 * 那两处本来就逐段读过一遍摘要。
 */
export async function buildCastIndex(project: NovelProject): Promise<CastIndex> {
  const cards = await project.listCharacters();
  const plots = await project.listPlots();

  const { cardByName, conflicts } = indexCards(cards);

  /** slug → 出场段号。 */
  const plotsOf = new Map<string, Set<number>>();
  /** slug → 摘要里见过的别称。 */
  const aliasesOf = new Map<string, Set<string>>();
  /** 没能归到任何一张卡的条目，按段收着，稍后整体聚类。 */
  const orphanPlots: IdentityChapter[] = [];

  let summaryCount = 0;
  for (const plot of plots) {
    const summary = await project.readSummary(plot.relPath);
    if (!summary) {
      continue;
    }
    summaryCount++;
    const orphans: SummaryCast[] = [];

    for (const entry of summary.cast) {
      const aliases = sanitizeAliases(entry.aliases, entry.name);
      // 名字与别名都拿去找卡：模型这一段写的是「阿昭」，也该记到林昭头上。
      const card =
        cardByName.get(normalizeName(entry.name)) ??
        aliases.map((a) => cardByName.get(normalizeName(a))).find(Boolean);
      if (!card) {
        orphans.push({ name: entry.name, aliases });
        continue;
      }

      const set = plotsOf.get(card.slug) ?? plotsOf.set(card.slug, new Set()).get(card.slug)!;
      set.add(plot.no);
      const known = aliasesOf.get(card.slug) ?? aliasesOf.set(card.slug, new Set()).get(card.slug)!;
      for (const alias of [entry.name, ...aliases]) {
        known.add(alias);
      }
    }

    if (orphans.length > 0) {
      orphanPlots.push({ order: plot.no, cast: orphans });
    }
  }

  const known: CastMember[] = cards.map((card) => ({
    name: card.name,
    aliases: [...(aliasesOf.get(card.slug) ?? [])].filter(
      (a) => a !== card.name && !card.aliases.includes(a)
    ),
    plots: sortedNos(plotsOf.get(card.slug)),
    card,
  }));

  const identity = buildIdentityGroups(orphanPlots);
  const unknown: CastMember[] = identity.groups.map((group) => ({
    name: group.primary,
    aliases: group.names.slice(1),
    plots: group.chapters,
  }));
  // 戏份重的排前面：作者要建的卡多半是这些。
  unknown.sort((a, b) => b.plots.length - a.plots.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return { known, unknown, conflicts, rejectedLinks: identity.rejected, summaryCount };
}

/**
 * 建「称呼 → 角色卡」表。
 *
 * **两趟**：先登记全部卡的正式名，再登记别名。正式名之间撞车才是真冲突
 * （同一个人两张卡）；别名撞上别人的正式名一律判别名输——那多半是模型给
 * 张三的卡挂了李四的名字，让它抢走李四的出场章节是最坏的结果。
 */
function indexCards(cards: readonly CharacterCard[]): {
  cardByName: Map<string, CharacterCard>;
  conflicts: CastConflict[];
} {
  const cardByName = new Map<string, CharacterCard>();
  const conflicts: CastConflict[] = [];
  const seen = new Map<string, CastConflict>();

  const clash = (name: string, kind: 'name' | 'alias', a: CharacterCard, b: CharacterCard): void => {
    const key = `${kind}:${normalizeName(name)}`;
    const existing = seen.get(key);
    if (existing) {
      existing.slugs = [...new Set([...existing.slugs, a.slug, b.slug])];
      return;
    }
    const conflict: CastConflict = { name, kind, slugs: [a.slug, b.slug] };
    seen.set(key, conflict);
    conflicts.push(conflict);
  };

  for (const card of cards) {
    const key = normalizeName(card.name);
    if (!key) {
      continue;
    }
    const owner = cardByName.get(key);
    if (owner && owner.slug !== card.slug) {
      // 两张卡的正式名撞了：出场统计必然有一张是错的，作者需要知道。
      clash(card.name, 'name', owner, card);
      continue;
    }
    cardByName.set(key, card);
  }

  for (const card of cards) {
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      const key = normalizeName(alias);
      if (!key) {
        continue;
      }
      const owner = cardByName.get(key);
      if (!owner) {
        cardByName.set(key, card);
        continue;
      }
      if (owner.slug === card.slug) {
        continue;
      }
      // 别名撞车一律判别名输：撞上别人的正式名尤其如此——那多半是模型给张三
      // 的卡挂了李四的名字，让它抢走李四的出场章节是最坏的结果。
      clash(alias, 'alias', owner, card);
    }
  }

  return { cardByName, conflicts };
}

/** 某个角色的出场段号。找不到（名字对不上任何摘要）时返回空数组。 */
export function appearancesOf(index: CastIndex, card: CharacterCard): number[] {
  return index.known.find((m) => m.card?.slug === card.slug)?.plots ?? [];
}

/**
 * 读出全部摘要的 cast，作为聚类的原料。
 *
 * 与 `buildCastIndex` 的区别：那里**先**把条目分给角色卡、只对剩下的孤儿聚类；
 * 这里不分卡，全量给出去——维护命令要问的恰恰是「已建的这几张卡是不是同一个人」，
 * 先按卡分开就什么也看不出来了。
 */
export async function readCastPlots(project: NovelProject): Promise<IdentityChapter[]> {
  const out: IdentityChapter[] = [];
  for (const plot of await project.listPlots()) {
    const summary = await project.readSummary(plot.relPath);
    if (!summary || summary.cast.length === 0) {
      continue;
    }
    out.push({
      order: plot.no,
      cast: summary.cast.map((entry) => ({
        name: entry.name,
        aliases: sanitizeAliases(entry.aliases, entry.name),
      })),
    });
  }
  return out;
}

function sortedNos(set: Set<number> | undefined): number[] {
  return set ? [...set].sort((a, b) => a - b) : [];
}

/**
 * `第 3、7、12 段` / `第 3、7、12 段等 20 段`——列表太长时只列前几个。
 * 前端与日志共用，保证同一份数据在两处说法一致。
 */
export function describePlots(nos: number[], max = 6): string {
  if (nos.length === 0) {
    return '未在摘要中出现';
  }
  const head = nos.slice(0, max).join('、');
  return nos.length > max ? `第 ${head} 段等 ${nos.length} 段` : `第 ${head} 段`;
}
