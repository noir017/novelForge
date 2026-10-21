import * as fsp from 'node:fs/promises';
import { hash } from '../model/fs';
import { loreBrief } from '../model/loreFile';
import { namesOf } from '../model/manuscriptCheck';
import { NovelProject, listMarkdownDeep } from '../model/project';
import type { CharacterCard, LoreEntry } from '../model/types';
import type { NameEntry, NameIndex } from '../protocol';
import { buildLoreIndex } from './lore';

/**
 * 内置编辑器「名词补全」的名词表：角色卡（名字、别名）、设定条目（标题、关键词、分类）、设定名录里出现过还没建条目的
 * 名字。每一条带类型与一句话（卡或条目里现成的那一句）。**纯读盘、不调模型**（第 4 条：补全不烧 token）。
 *
 * **按需要**：前端按了补全键、或开着「边打边弹」在打字时才要（`requestNameIndex`），不进每次文件变动都重推的工程树 /
 * `ViewState`。前端带着手上那一份的指纹（`have`）来，没变就只回指纹（controller 那一层比，见 {@link nameIndexSig}）。
 * 匹配与排序在前端（`media/src/editor/namesCore.ts`），这里只给一份平铺的表。
 *
 * ## 读了哪些盘
 *
 * 几百张卡、几百条设定也要快——作者每存一次稿前端就会再问一次（问的时候带着指纹），所以**没变的时候不读任何一份卡或
 * 条目的内容**：
 *
 * - **角色卡与设定条目**：递归列 `.novelforge/characters/` 与 `.novelforge/lore/`（与 `listCharacters` / `listLore`
 *   同一个列法），每个文件 `stat` 一次，拼成「路径 · 大小 · 修改时间」的签名。签名与上一次一样就用上一次读好的那一份
 *   （按工程实例记在内存里）；不一样（新建、删掉、改过任何一张）才整份重读——每个文件读一次，与工程页同一个解析
 *   （`NovelProject.listCharacters` / `listLore`）。
 * - **未建条目**：设定名录（`views/lore.ts` 的 `buildLoreIndex`，关掉「待整合」那一步）从定稿过的细纲「设定」一节算出来。
 *   细纲与章节列表借工程上的缓存（`listPlots()` / `listChapters()`，每次 `pushState` 重算 `ViewState` 时就填上了，
 *   几乎总是热的），热的时候**一份细纲都不读**；卡与条目用上面那一份，不再读。
 *
 * 不读正文、大纲、配置。
 */
export async function buildNameIndex(project: NovelProject): Promise<NameIndex> {
  if (!(await project.isInitialized())) {
    return { initialized: false, names: [] };
  }
  const { cards, lore } = await readSources(project);
  const catalog = await buildLoreIndex(project, { entries: lore, cards }, { pending: false });

  const names: NameEntry[] = [];
  for (const card of cards) {
    names.push({
      name: card.name,
      aliases: aliasesOf(card.name, card.aliases),
      source: 'character',
      category: '',
      brief: loreBrief({ brief: '', body: card.sections.身份 ?? '' }) || card.tags.join('、'),
      path: card.relPath,
    });
  }
  for (const entry of lore) {
    names.push({
      name: entry.title,
      aliases: aliasesOf(entry.title, entry.keywords),
      source: 'lore',
      category: entry.category,
      brief: loreBrief(entry),
      path: entry.relPath,
    });
  }
  // 名录里出现过、还没建条目的名字（⚑ 进表）：定稿过的正文里真出现过，作者接着写多半还会用到。一句话取最近那一章的说明。
  for (const item of catalog.unknown) {
    const latest = [...item.notes].sort((a, b) => b.no - a.no).find((n) => n.text.trim() !== '');
    names.push({
      name: item.name,
      aliases: [],
      source: 'unfiled',
      category: item.category,
      brief: latest?.text.trim() ?? '',
    });
  }
  return { initialized: true, names };
}

/** 名词表的指纹：前端带着它来问，对得上就不再发一遍表。 */
export function nameIndexSig(index: NameIndex): string {
  return hash(JSON.stringify(index));
}

/**
 * 别的叫法：别名 / 关键词，外加名字里括号内外各一截（`manuscriptCheck.ts` 的 `namesOf`，查提前登场也是这么认人的）。
 * 不含正名，去重；一个字的不要——补全按开头认，一个字的别名会把「林」这类常用字认成「已经打完整了」。
 */
function aliasesOf(name: string, aliases: readonly string[]): string[] {
  const self = name.trim();
  return namesOf(name, aliases).filter((n) => n !== self);
}

// ---------------------------------------------------------------- 卡与条目：没变就不读

interface Sources {
  sig: string;
  cards: CharacterCard[];
  lore: LoreEntry[];
}

/** 按工程实例记着上一次读好的卡与条目（换工程就是另一个实例，旧的随它回收）。 */
const sourceCache = new WeakMap<NovelProject, Sources>();

async function readSources(project: NovelProject): Promise<Sources> {
  const [cardFiles, loreFiles] = await Promise.all([
    listMarkdownDeep(project.charactersDir),
    listMarkdownDeep(project.loreDir),
  ]);
  const stamps = await Promise.all(
    [...cardFiles, ...loreFiles].map(async (abs) => {
      try {
        const s = await fsp.stat(abs);
        return `${abs}\u0000${s.size}\u0000${s.mtimeMs}`;
      } catch {
        // 列出来之后、stat 之前被删了：签名里记一笔，下一次自然对不上。
        return `${abs}\u0000gone`;
      }
    })
  );
  const sig = `${cardFiles.length}\u0001${stamps.join('\n')}`;
  const known = sourceCache.get(project);
  if (known && known.sig === sig) {
    return known;
  }
  const [cards, lore] = await Promise.all([project.listCharacters(), project.listLore()]);
  const next: Sources = { sig, cards, lore };
  sourceCache.set(project, next);
  return next;
}
