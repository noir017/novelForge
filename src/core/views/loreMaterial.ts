import { NovelProject } from '../model/project';
import { hash } from '../model/fs';
import { Plot, PLOT_SECTION_KEYS } from '../model/plotFile';
import { parseContinuityFacts } from '../model/continuity';
import { createLoreLookup, loreCategoryOfSlug, loreMentionIn, loreThin, splitLoreHidden } from '../model/loreFile';
import { LoreEntry } from '../model/types';
import { finalizedPlots } from './cast';
import type { LoreFact } from './lore';

/**
 * 一条设定的原料：定稿过的细纲里关于它的记录（建条目、整合、展开共用）、没定稿的细纲里用到它的地方
 * （展开用），以及写完之后水位记到第几章、条目正文是不是机器写的。
 *
 * 纯读盘、不调模型、不落盘。从 features/lore.ts 挪过来（完善设定，2026-10-19）：装配器展开一条设定时要
 * 同一份原料，而 context/ 不依赖 features/（见 context/README.md）。挪过来的那几样行为一字不变。
 */

/** 建条目、整合、展开时给模型的记录最多多少 token（原料是一句一句的记录，很少到这么多）。 */
export const MATERIAL_TOKENS = 6000;

// ---------------------------------------------------------------- 水位

/**
 * 整合能推到第几章：**第一处没定稿（或定稿之后正文又改过）的章之前**。第 5 章没定稿、第 6 章定稿了，
 * 水位最多到 4——否则第 5 章日后定稿，它的事实永远进不了条目（全书摘要的增量也是这么停的）。
 * 一章都没写是 0。展开写下的条目水位也记这个（展开喂的定稿记录就是整合会喂的那一份）。
 */
export async function integrationWatermark(project: NovelProject): Promise<number> {
  const chapters = [...(await project.listChapters())].sort((a, b) => a.order - b.order);
  let through = 0;
  for (const chapter of chapters) {
    if (chapter.wordCount === 0) {
      continue;
    }
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash || plot.sourceHash !== chapter.contentHash) {
      return chapter.order - 1;
    }
    through = chapter.order;
  }
  return through;
}

// ---------------------------------------------------------------- 定稿过的记录

/**
 * 一个名字在定稿过的细纲里的**所有记录**，带章号：第九节冒号后那一句、连续性事实里提到它的、
 * 另外几节里提到它的句子。建条目的原料。
 */
export function recordsAbout(plots: readonly Plot[], words: readonly string[], notes: readonly LoreFact[]): LoreFact[] {
  const out: LoreFact[] = [...notes];
  const hit = (text: string): boolean => words.some((w) => w.length >= 2 && text.includes(w));
  for (const plot of plots) {
    for (const fact of parseContinuityFacts(plot.sections.连续性事实)) {
      if (hit(fact.statement)) {
        out.push({ no: plot.no, text: fact.statement, source: 'fact' });
      }
    }
    for (const key of PLOT_SECTION_KEYS) {
      if (key === '连续性事实' || key === '出场人物') {
        continue;
      }
      for (const sentence of plot.sections[key].split(/(?<=[。！？!?])|\n+/u)) {
        const s = sentence.replace(/^\s*[-*·•]\s*/u, '').trim();
        if (s && hit(s)) {
          out.push({ no: plot.no, text: s, source: 'lore' });
        }
      }
    }
  }
  const seen = new Set<string>();
  return out
    .filter((f) => {
      const key = `${f.no}|${f.text}`;
      return !seen.has(key) && (seen.add(key), true);
    })
    .sort((a, b) => a.no - b.no);
}

// ---------------------------------------------------------------- 谁写的

/**
 * 条目正文是不是机器写的：空的，或记下的指纹对得上。没盖过章的非空正文算作者的。从 features/lore.ts 挪过来
 * （完善设定三期）：名录算「待完善」时要判批量展开会不会写它（{@link loreBatchExpandable}），而 views/ 不依赖 features/。
 */
export function loreOwnedByMachine(entry: Pick<LoreEntry, 'body' | 'bodyHash'>): boolean {
  const body = entry.body.trim();
  return !body || (!!entry.bodyHash && hash(body) === entry.bodyHash);
}

/**
 * 批量展开（完善设定三期）会不会写这一条：还只有一句话（`loreThin`），而且没有作者的字。第 19 条批量那一面——
 * 没有卡片、不问，只写吞不掉东西的：明面空的、新建设定的占位（都没有暗设），以及机器写的（`bodyHash` 对得上，
 * 设定清单起步时留下的三节「（未交代）」就是这种）。三节全是「（未交代）」却没盖过章的、明面空着但写过暗设的，
 * 都可能是作者手写的，批量跳过——要展开就单条展开，先对比。
 */
export function loreBatchExpandable(entry: Pick<LoreEntry, 'body' | 'bodyHash'>): boolean {
  const thin = loreThin(entry);
  if (!thin) {
    return false;
  }
  if (loreOwnedByMachine(entry)) {
    return true;
  }
  return thin !== 'untold' && !splitLoreHidden(entry.body).hidden;
}

// ---------------------------------------------------------------- 展开要的原料

/**
 * 路径上的那一条条目（单条设定这个目标认的就是它）。文件还不在时（MCP 给了一条新路径、展开期间被删了）
 * 按路径拼一条空的：标题取文件名、分类取它在 `lore/` 下的目录，`exists: false`。`entries` 给了就不再读盘。
 */
export async function loreEntryAt(
  project: NovelProject,
  relPath: string,
  entries?: readonly LoreEntry[]
): Promise<{ entry: LoreEntry; exists: boolean }> {
  const found = (entries ?? (await project.listLore())).find((e) => e.relPath === relPath);
  if (found) {
    return { entry: found, exists: true };
  }
  const root = project.relPath(project.loreDir);
  const slug = (relPath.startsWith(`${root}/`) ? relPath.slice(root.length + 1) : relPath).replace(/\.(md|markdown)$/i, '');
  const title = slug.slice(slug.lastIndexOf('/') + 1);
  return {
    entry: { slug, relPath, title, keywords: [], brief: '', category: loreCategoryOfSlug(slug), body: '' },
    exists: false,
  };
}

/** 没定稿的细纲里用到这一条的一处：第九节点名它的那一行，或梗概、关键事件里提到它的一句。 */
export interface LorePlannedUse {
  no: number;
  /** 那一章细纲的标题（可能是空串）。 */
  title: string;
  where: '设定' | '梗概' | '关键事件';
  text: string;
}

/** 展开一条设定的原料（完善设定 §1「喂什么」）。 */
export interface LoreExpansionMaterial {
  /** 已排（没定稿）的细纲里用到它的地方，按章号升序——展开是为这些情节服务的。 */
  uses: LorePlannedUse[];
  /** 定稿过的细纲里关于它的全部记录（{@link recordsAbout}，第九节那一句也算）——已经写进正文的，不能推翻。 */
  records: LoreFact[];
}

/**
 * 展开一条设定要喂的两样原料。同一个号只认一份细纲（`pairPlots`，与名录同一个口径）；有 `sourceHash` 的是
 * 定稿过的，其余是计划。第九节里的名字按名录同一张表认（`createLoreLookup`：标题优先、关键词抢不走别人的
 * 标题），句子里的提及按标题或关键词认（`loreMentionIn`）。`read` 里给了就直接用，不再读盘。
 */
export async function expansionMaterial(
  project: NovelProject,
  entry: LoreEntry,
  read: { plots?: readonly Plot[]; entries?: readonly LoreEntry[] } = {}
): Promise<LoreExpansionMaterial> {
  const [plots, chapters, entries] = await Promise.all([
    read.plots ?? project.listPlots(),
    project.listChapters(),
    read.entries ?? project.listLore(),
  ]);
  const paired = project.pairPlots(plots, chapters);
  const lookup = createLoreLookup(entries.some((e) => e.relPath === entry.relPath) ? entries : [...entries, entry]);
  const isSelf = (name: string): boolean => lookup.find(name)?.relPath === entry.relPath;

  const uses: LorePlannedUse[] = [];
  for (const plot of paired.filter((p) => !p.sourceHash).sort((a, b) => a.no - b.no)) {
    for (const line of plot.lore ?? []) {
      if (isSelf(line.name)) {
        uses.push({ no: plot.no, title: plot.title, where: '设定', text: line.note ? `${line.name}：${line.note}` : line.name });
      }
    }
    for (const key of ['梗概', '关键事件'] as const) {
      for (const sentence of (plot.sections[key] ?? '').split(/(?<=[。！？!?])|\n+/u)) {
        const s = sentence.replace(/^\s*(?:[-*·•]|\d+[.、)．])\s*/u, '').trim();
        if (s && loreMentionIn(s, entry)) {
          uses.push({ no: plot.no, title: plot.title, where: key, text: s });
        }
      }
    }
  }

  const finalized = finalizedPlots(paired);
  const notes: LoreFact[] = finalized.flatMap((plot) =>
    (plot.lore ?? [])
      .filter((line) => line.note && isSelf(line.name))
      .map((line) => ({ no: plot.no, text: line.note, source: 'lore' as const }))
  );
  const records = recordsAbout(finalized, [entry.title, ...entry.keywords], notes);
  return { uses, records };
}
