import { getHost } from '../host';
import { Plot } from '../model/plotFile';

/**
 * Host.pick 只支持单选。需要多段的场景（提取角色、提取文风）改为
 * 让用户输入段号列表，如 `1,2,3`（中英文逗号、空格皆可）。
 */
export async function pickPlotsByInput(
  plots: Plot[],
  title: string,
  placeHolder: string,
  defaults: number[]
): Promise<Plot[] | undefined> {
  const catalog = plots.map((p) => `${p.no}(${p.title})`).join('、');
  const value = await getHost().input({
    title,
    prompt: `可选段落：${catalog}`,
    value: defaults.join(','),
    placeHolder,
    validate: (v) => {
      const nos = parseNos(v);
      if (nos.length === 0) {
        return '请至少输入一个段号（逗号分隔）';
      }
      const unknown = nos.filter((n) => !plots.some((p) => p.no === n));
      return unknown.length > 0 ? `第 ${unknown.join('、')} 段不存在` : undefined;
    },
  });
  if (!value) {
    return undefined;
  }
  const nos = parseNos(value);
  return plots.filter((p) => nos.includes(p.no));
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
