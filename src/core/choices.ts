import { appearancesOf, buildCastIndex, describePlots } from './views/cast';
import { PickChoice } from './host';
import { NovelProject } from './model/project';

/**
 * 供「让用户挑一个」用的清单构造，宿主无关。
 *
 * 为什么在 core 而不在壳里：清单里的说明文字是**算出来的**——「＋3 章待读」
 * 要比对摘要出场章与角色卡的 `updatedThrough`，「1200 字」要读正文。那是业务
 * 知识，壳照抄一遍就会与工程页上的同一行说明分叉。壳只负责把清单交给
 * `Host.pick`（插件是 QuickPick，独立版是网页弹窗）。
 *
 * 空清单一律返回空数组，不在这里 toast——「还没有角色卡」该说什么、说在哪，
 * 由调用方按自己的上下文决定。
 */

/** 角色卡清单。`value` 是卡的相对路径（`updateCharacterCard` 认这个）。 */
export async function characterChoices(project: NovelProject): Promise<PickChoice<string>[]> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    return [];
  }
  // 出场章由摘要自动关联，所以清单里能直接告诉用户「这张卡还差几章没读」。
  const index = await buildCastIndex(project);
  return cards.map((card) => {
    const plots = appearancesOf(index, card);
    const pending = plots.filter((no) => no > (card.updatedThrough ?? 0)).length;
    return {
      label: card.name,
      description: pending > 0 ? `＋${pending} 章待读` : undefined,
      detail: describePlots(plots),
      value: card.relPath,
    };
  });
}

/** 章节清单。`value` 是章号——调用方拿它找细纲或成品。 */
export async function plotChoices(project: NovelProject): Promise<PickChoice<number>[]> {
  // 两边都列：老工程只有 `chapters/`，只列 `plots/` 的话下拉框是空的。
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);
  const byNo = new Map<number, { title: string; words: number }>();
  for (const chapter of chapters) {
    byNo.set(chapter.order, { title: chapter.title, words: chapter.wordCount });
  }
  for (const plot of plots) {
    const words =
      byNo.get(plot.no)?.words || (await project.readManuscript(plot.relPath))?.wordCount || 0;
    byNo.set(plot.no, { title: plot.title || byNo.get(plot.no)?.title || '', words });
  }

  return [...byNo.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, { title, words }]) => ({
      // 补零对齐，长篇下拉里看着才是一列。
      label: `${String(no).padStart(3, '0')} ${title || '（未命名）'}`,
      description: words > 0 ? `${words} 字` : '还没有正文',
      value: no,
    }));
}
