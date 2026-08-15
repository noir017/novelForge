import { getHost } from '../host';

/** 能被挑选的东西：有个号、有个名字。细纲与发布章节都满足。 */
export interface Numbered {
  no: number;
  title: string;
}

/**
 * Host.pick 只支持单选。需要多章的场景（提取角色、提取文风）改为
 * 让用户输入章号列表，如 `1,2,3`（中英文逗号、空格皆可）。
 */
export async function pickPlotsByInput<T extends Numbered>(
  items: T[],
  title: string,
  placeHolder: string,
  defaults: number[]
): Promise<T[] | undefined> {
  const catalog = items.map((p) => `${p.no}(${p.title})`).join('、');
  const value = await getHost().input({
    title,
    prompt: `可选章节：${catalog}`,
    value: defaults.join(','),
    placeHolder,
    validate: (v) => {
      const nos = parseNos(v);
      if (nos.length === 0) {
        return '请至少输入一个章号（逗号分隔）';
      }
      const unknown = nos.filter((n) => !items.some((p) => p.no === n));
      return unknown.length > 0 ? `第 ${unknown.join('、')} 章不存在` : undefined;
    },
  });
  if (!value) {
    return undefined;
  }
  const nos = parseNos(value);
  return items.filter((p) => nos.includes(p.no));
}

function parseNos(text: string): number[] {
  const seen = new Set<number>();
  for (const part of text.split(/[,，\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return [...seen];
}
