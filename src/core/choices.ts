import { appearancesOf, buildCastIndex, describeChapters } from './views/cast';
import { PickChoice } from './host';
import { NovelProject } from './model/project';

/**
 * 供「让用户挑一个」用的清单构造，宿主无关。
 *
 * 为什么在 core 而不在壳里：清单里的说明文字是**算出来的**——「＋3 章待读」
 * 要比对摘要出场章与角色卡的 `updatedThrough`，「1200 字」要读章节。那是业务
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
  // 出场章节由摘要自动关联，所以清单里能直接告诉用户「这张卡还差几章没读」。
  const index = await buildCastIndex(project);
  return cards.map((card) => {
    const chapters = appearancesOf(index, card);
    const pending = chapters.filter((order) => order > (card.updatedThrough ?? 0)).length;
    return {
      label: card.name,
      description: pending > 0 ? `＋${pending} 章待读` : undefined,
      detail: describeChapters(chapters),
      value: card.relPath,
    };
  });
}

/** 章节清单。`value` 是章序号——调用方拿它 `project.getChapter(order)`。 */
export async function chapterChoices(project: NovelProject): Promise<PickChoice<number>[]> {
  const chapters = await project.listChapters();
  return chapters.map((chapter) => ({
    // 补零对齐，长篇下拉里看着才是一列。
    label: `${String(chapter.order).padStart(3, '0')} ${chapter.title}`,
    description: `${chapter.wordCount} 字`,
    value: chapter.order,
  }));
}
