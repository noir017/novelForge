import { getHost } from '../host';
import { Chapter } from '../model/types';

/**
 * Host.pick 只支持单选。需要多章的场景（提取角色、提取文风）改为
 * 让用户输入章节序号列表，如 `1,2,3`（中英文逗号、空格皆可）。
 */
export async function pickChaptersByInput(
  chapters: Chapter[],
  title: string,
  placeHolder: string,
  defaults: number[]
): Promise<Chapter[] | undefined> {
  const catalog = chapters.map((c) => `${c.order}(${c.title})`).join('、');
  const value = await getHost().input({
    title,
    prompt: `可选章节：${catalog}`,
    value: defaults.join(','),
    placeHolder,
    validate: (v) => {
      const orders = parseOrders(v);
      if (orders.length === 0) {
        return '请至少输入一个章节序号（逗号分隔）';
      }
      const unknown = orders.filter((o) => !chapters.some((c) => c.order === o));
      return unknown.length > 0 ? `第 ${unknown.join('、')} 章不存在` : undefined;
    },
  });
  if (!value) {
    return undefined;
  }
  const orders = parseOrders(value);
  return chapters.filter((c) => orders.includes(c.order));
}

function parseOrders(text: string): number[] {
  const seen = new Set<number>();
  for (const part of text.split(/[,，\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return [...seen];
}
