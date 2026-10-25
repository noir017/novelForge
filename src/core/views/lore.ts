import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { parseContinuityFacts } from '../model/continuity';
import { LoreThinKind, createLoreLookup, loreMentionsIn, loreThin, normalizeLoreName } from '../model/loreFile';
import { CharacterCard, LoreEntry } from '../model/types';
import { normalizeName } from '../model/naming';
import { finalizedPlots } from './cast';
import { loreBatchExpandable } from './loreMaterial';

/**
 * 设定名录：把各章**定稿过的**细纲「设定」一节反向聚合成「哪个东西在哪几章出现过、
 * 有没有条目、条目落后了几章」。和出场人物索引（views/cast.ts）是一个路子：
 *
 * - **定稿过的细纲是真相**（第 14 条同理）。没定稿的「设定」一节写的是计划，不进统计——只给装配器挑条目用。
 * - **两趟认条目**：先按标题、再按关键词（model/loreFile.ts 的 `createLoreLookup`），关键词抢不走
 *   别人的标题。
 * - **待整合的新事实**：水位（条目的 `updatedThrough`）之后的定稿章里，「设定」一节冒号后面那句、
 *   以及连续性事实里提到它的标题或关键词的那一条。会变的状态（谁拿走了、毁了）一直记在连续性事实里，
 *   名录去那里认，不另存一份。
 * - **人名不是设定**：「设定」一节里的名字撞上角色卡的名字或别名就不算（模型偶尔把人也列进来）。
 * - **待完善**（完善设定，2026-10-19，按需算）：唯一往前看的一块——还没写的那几章细纲「设定」一节点名、却还没有条目
 *   或条目还只有一句话的，工程页「待完善」那一组列它（{@link thinLore}）；写前提醒（工作台、批量写章确认框）取其中
 *   要用到那几章的（{@link thinLoreFor}，三期）。
 *
 * 纯读盘、不调模型、不落盘（第 18 条：状态一律从磁盘推导）。
 */

/** 一条关于某个设定的新事实。 */
export interface LoreFact {
  /** 章号。 */
  no: number;
  text: string;
  /** `lore`：「设定」一节冒号后面那句；`fact`：连续性事实里提到它的那一条。 */
  source: 'lore' | 'fact';
}

/** 一条已建的设定。 */
export interface LoreRecord {
  entry: LoreEntry;
  /** 定稿过的细纲「设定」一节点名它的章，升序。 */
  chapters: number[];
  /** 水位之后、定稿过的章里关于它的新事实，按章号升序。 */
  pending: LoreFact[];
}

/** 定稿里出现过、还没有条目的名字。 */
export interface UnfiledLore {
  /** 展示名：各章写法里出现最多的那个。 */
  name: string;
  /** 建议的分类：各章 `〔分类〕` 的多数票，没写过是空串。 */
  category: string;
  chapters: number[];
  /** 各章冒号后面那句（建条目的原料）。 */
  notes: LoreFact[];
}

/** 「待完善」的哪一种：还没有条目，或条目还只有一句话（{@link LoreThinKind}）。 */
export type ThinLoreKind = 'missing' | LoreThinKind;

/** 工程页「待完善」那一行写的种类。 */
export const THIN_LORE_LABEL: Record<ThinLoreKind, string> = {
  missing: '还没有条目',
  empty: '只有一句话',
  placeholder: '只有占位',
  untold: '三节全是未交代',
};

/**
 * 接下来要用、却还是空的一条设定（完善设定 · 待完善，2026-10-19）：没定稿、也还没写正文的细纲「设定」一节点名了它，
 * 而它还没有条目，或条目还只有一句话。
 */
export interface ThinLore {
  /** 有条目是条目的标题；没有是各章「设定」一节写法里出现最多的那个。 */
  name: string;
  /** 有条目是条目所在的目录；没有是各章 `〔分类〕` 的多数票，没写过是空串。 */
  category: string;
  /** 条目路径；还没有条目时缺席。 */
  relPath?: string;
  kind: ThinLoreKind;
  /** 要用到它的章（细纲「设定」一节点名它的），升序。 */
  chapters: number[];
  /** 最早要用到的那一章。 */
  first: number;
  /**
   * 条目里有作者的字（三节全是「（未交代）」却没盖过机器的章、明面空着但写过暗设）：「全部展开」跳过它，
   * 要展开就单条展开、先对比（`loreBatchExpandable`，完善设定三期）。还没有条目的、空的、占位的没有这一项。
   */
  authored?: true;
}

export interface LoreIndex {
  /** 全部条目（含一次都没在定稿里出现过的），按 `listLore` 的顺序。 */
  known: LoreRecord[];
  /** 定稿里出现、还没有条目的名字，按出现章数降序。 */
  unknown: UnfiledLore[];
  /** 定稿过、但「设定」一节标题不在的章（还没记过设定），升序。 */
  unrecorded: number[];
  /** 参与统计的（定稿过的）细纲数。 */
  finalizedCount: number;
  /** 待完善（`opts.thin` 打开时才算，不然是空的），按最早要用到的章升序。 */
  thin: ThinLore[];
}

/**
 * 扫全部定稿过的细纲，建设定名录。`plots` / `entries` / `cards` 传进来就直接用（工程页刷新时
 * 已经读过了，同一次刷新里一个文件只读一次——tests/integration/views/projectTreeReads），不传就自己读。
 *
 * `opts.pending: false`：不算待整合的新事实（`known[].pending` 一律空）。那一步要拿每一章的连续性事实去对每一条
 * 条目，几百章 × 几百条时是这里最贵的一段；只要出现章与未建条目的调用方（编辑器的名词补全，`views/nameIndex.ts`）
 * 用不着它。
 *
 * `opts.thin: true`：顺带算「待完善」（{@link thinLore}）。只有工程页要，缺省不算。
 */
export async function buildLoreIndex(
  project: NovelProject,
  read: { plots?: readonly Plot[]; entries?: readonly LoreEntry[]; cards?: readonly CharacterCard[] } = {},
  opts: { pending?: boolean; thin?: boolean } = {}
): Promise<LoreIndex> {
  const withPending = opts.pending !== false;
  const [entries, cards, chapters] = await Promise.all([
    read.entries ?? project.listLore(),
    read.cards ?? project.listCharacters(),
    project.listChapters(),
  ]);
  const paired = project.pairPlots(read.plots ?? (await project.listPlots()), chapters);
  const finalized = finalizedPlots(paired);
  const lookup = createLoreLookup(entries);

  const people = new Set<string>();
  for (const card of cards) {
    for (const name of [card.name, ...card.aliases]) {
      people.add(normalizeName(name));
    }
  }

  const chaptersOf = new Map<string, Set<number>>();
  const pendingOf = new Map<string, LoreFact[]>();
  /** 归一后的名字 → 各章的写法、分类的票、章号与说明。 */
  const unfiled = new Map<string, UnfiledGroup>();
  const unrecorded: number[] = [];

  const watermark = (entry: LoreEntry): number => entry.updatedThrough ?? 0;
  const addPending = (entry: LoreEntry, fact: LoreFact): void => {
    const list = pendingOf.get(entry.slug) ?? pendingOf.set(entry.slug, []).get(entry.slug)!;
    list.push(fact);
  };

  for (const plot of finalized) {
    if (!plot.lore) {
      unrecorded.push(plot.no);
    }
    for (const line of plot.lore ?? []) {
      if (people.has(normalizeName(line.name))) {
        continue;
      }
      const entry = lookup.find(line.name);
      if (entry) {
        const set = chaptersOf.get(entry.slug) ?? chaptersOf.set(entry.slug, new Set()).get(entry.slug)!;
        set.add(plot.no);
        if (withPending && line.note && plot.no > watermark(entry)) {
          addPending(entry, { no: plot.no, text: line.note, source: 'lore' });
        }
        continue;
      }
      const key = normalizeLoreName(line.name);
      const group =
        unfiled.get(key) ??
        unfiled
          .set(key, { names: new Map(), categories: new Map(), chapters: new Set(), notes: [] })
          .get(key)!;
      group.names.set(line.name, (group.names.get(line.name) ?? 0) + 1);
      if (line.category) {
        group.categories.set(line.category, (group.categories.get(line.category) ?? 0) + 1);
      }
      group.chapters.add(plot.no);
      if (line.note) {
        group.notes.push({ no: plot.no, text: line.note, source: 'lore' });
      }
    }
  }

  // 连续性事实里提到的：状态的变化记在那里。只认水位之后的章。最长匹配（2026-10-25，`loreMentionsIn`）：「幻池秘境」里的
  // 「秘境」不算提到「秘境」那一条——从前子串就算，各个具体秘境的事都挂到上位概念名下，整合时一条条并进去。别人的名字
  // 再加名录里记着、还没建条目的，所以等「设定」一节都认完再认；水位之内的条目照样算别人的名字，只是不收。
  if (withPending && entries.length > 0) {
    const names = [...unfiled.values()].flatMap((g) => [...g.names.keys()]);
    const lowest = Math.min(...entries.map(watermark));
    for (const plot of finalized) {
      if (plot.no <= lowest) {
        continue;
      }
      for (const fact of parseContinuityFacts(plot.sections.连续性事实)) {
        for (const entry of loreMentionsIn(fact.statement, entries, names).keys()) {
          if (plot.no > watermark(entry)) {
            addPending(entry, { no: plot.no, text: fact.statement, source: 'fact' });
          }
        }
      }
    }
  }

  const known: LoreRecord[] = entries.map((entry) => ({
    entry,
    chapters: [...(chaptersOf.get(entry.slug) ?? [])].sort((a, b) => a - b),
    pending: (pendingOf.get(entry.slug) ?? []).sort((a, b) => a.no - b.no),
  }));

  const unknown: UnfiledLore[] = [...unfiled.values()].map((group) => ({
    name: topOf(group.names),
    category: topOf(group.categories),
    chapters: [...group.chapters].sort((a, b) => a - b),
    notes: group.notes,
  }));
  // 出现得多的排前面：作者要建的条目多半是这些；同样多的按第一次出现的章号。
  unknown.sort(
    (a, b) =>
      b.chapters.length - a.chapters.length ||
      a.chapters[0] - b.chapters[0] ||
      a.name.localeCompare(b.name, 'zh-Hans-CN')
  );

  const thin = opts.thin ? thinLore(paired, chapters, lookup, people) : [];
  return { known, unknown, unrecorded, finalizedCount: finalized.length, thin };
}

/**
 * 待完善（完善设定，2026-10-19）：**往前看**——没定稿、也还没写正文（没有章节文件，或有文件但 0 字）的细纲
 * 「设定」一节点名的设定里，还没有条目的、条目还只有一句话的（`loreThin`：空的、新建设定的占位、三节全是「（未交代）」）。
 * 名录别处都只认定稿过的「设定」一节（第 14 条），这里反过来只认计划：要提醒的正是「接下来几章要用、却还是空的」。
 * 已经写了正文、还没定稿的章不算——那一章已经写过去了，再展开也帮不上它。
 *
 * 人名照样不算（同上）。复用 {@link buildLoreIndex} 已经读进来的细纲、章节与条目，不多读盘。按最早要用到的章升序，
 * 同一章的按名字。
 */
function thinLore(
  plots: readonly Plot[],
  chapters: readonly { order: number; wordCount: number }[],
  lookup: ReturnType<typeof createLoreLookup>,
  people: ReadonlySet<string>
): ThinLore[] {
  const written = new Set(chapters.filter((c) => c.wordCount > 0).map((c) => c.order));
  /** 有条目的按 slug，没有的按归一后的名字。 */
  const byKey = new Map<string, { entry?: LoreEntry; kind: ThinLoreKind; group: UnfiledGroup }>();
  for (const plot of plots) {
    if (plot.sourceHash || written.has(plot.no)) {
      continue;
    }
    for (const line of plot.lore ?? []) {
      if (people.has(normalizeName(line.name))) {
        continue;
      }
      const entry = lookup.find(line.name);
      const kind: ThinLoreKind | undefined = entry ? loreThin(entry) : 'missing';
      if (!kind) {
        continue;
      }
      const key = entry ? `entry:${entry.slug}` : `name:${normalizeLoreName(line.name)}`;
      const item =
        byKey.get(key) ??
        byKey
          .set(key, { entry, kind, group: { names: new Map(), categories: new Map(), chapters: new Set(), notes: [] } })
          .get(key)!;
      item.group.names.set(line.name, (item.group.names.get(line.name) ?? 0) + 1);
      if (line.category) {
        item.group.categories.set(line.category, (item.group.categories.get(line.category) ?? 0) + 1);
      }
      item.group.chapters.add(plot.no);
    }
  }
  const out: ThinLore[] = [...byKey.values()].map(({ entry, kind, group }) => {
    const nos = [...group.chapters].sort((a, b) => a - b);
    return {
      name: entry?.title ?? topOf(group.names),
      category: entry ? entry.category : topOf(group.categories),
      ...(entry ? { relPath: entry.relPath } : {}),
      kind,
      chapters: nos,
      first: nos[0],
      ...(entry && !loreBatchExpandable(entry) ? { authored: true as const } : {}),
    };
  });
  return out.sort((a, b) => a.first - b.first || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 这几章要用、却还只有一句话的设定（写前提醒，完善设定三期）：就是「待完善」里要用到这几章的那几条（{@link thinLore}），
 * 口径一字不差——没定稿、也还没写正文的细纲「设定」一节点名的，没有条目或条目还只有一句话。每条的 `chapters` 只留这几章里的。
 * 工作台正文目标与批量写章的确认框用它；零调用、只读盘。
 */
export async function thinLoreFor(project: NovelProject, nos: readonly number[]): Promise<ThinLore[]> {
  const wanted = new Set(nos);
  if (wanted.size === 0) {
    return [];
  }
  const { thin } = await buildLoreIndex(project, {}, { pending: false, thin: true });
  return thin
    .map((item) => ({ ...item, chapters: item.chapters.filter((no) => wanted.has(no)) }))
    .filter((item) => item.chapters.length > 0)
    .map((item) => ({ ...item, first: item.chapters[0] }));
}

/** 还要整合几章：待整合事实来自几个不同的章。工程页的 `＋N`。 */
export function pendingChapters(record: LoreRecord): number {
  return new Set(record.pending.map((f) => f.no)).size;
}

/**
 * `第 3–57 章 · 12 章` / `第 3 章`；一次都没出现是空串。设定比人多得多、一条常常出现几十章，
 * 不像出场人物那样逐个列章号（`describePlots`），只给首尾与章数。
 */
export function describeSpan(nos: readonly number[]): string {
  if (nos.length === 0) {
    return '';
  }
  const first = nos[0];
  const last = nos[nos.length - 1];
  return first === last ? `第 ${first} 章` : `第 ${first}–${last} 章 · ${nos.length} 章`;
}

interface UnfiledGroup {
  names: Map<string, number>;
  categories: Map<string, number>;
  chapters: Set<number>;
  notes: LoreFact[];
}

/** 票数最多的那一项（同票取先出现的），没有就是空串。 */
function topOf(votes: Map<string, number>): string {
  let best = '';
  let max = 0;
  for (const [value, count] of votes) {
    if (count > max) {
      best = value;
      max = count;
    }
  }
  return best;
}
