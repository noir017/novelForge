/**
 * `list` —— 列一个目录里有什么。`Workspace.list` 的薄包装。
 *
 * 这一层的活是**把结构化数组压成模型一屏能扫完的文本**：
 *
 * ```
 * .novelforge/plots/（42 项）
 *   001-楔子.md          620 字
 *   002-入宗.md          710 字
 *   …
 *   （还有 32 项未列出，用 path 参数进子目录看）
 * ```
 *
 * 上限 60 项，超了必须说出来（AGENTS 第 2 条：不静默截断）。60 是按「一屏
 * 能扫完、又装得下一本书的章节目录的前半」定的：真要找具体某一章，`search`
 * 比翻页快得多。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { objectSchema, str } from '../schema';

/** 一次最多列几项。 */
export const LIST_LIMIT = 60;

export const listTool: ToolDef = {
  name: 'list',
  description:
    '列出工程里某个目录的直接子项（不递归），带类型与字数。' +
    'path 是工程内相对路径、用正斜杠，留空则列工程根。' +
    '几个固定位置：卷纲在 .novelforge/volumes/，细纲在 .novelforge/plots/<卷词干>/，' +
    '尚未拆分的正文在 .novelforge/manuscripts/，已发布的章在章节根目录（默认 chapters/），' +
    '单章摘要在 .novelforge/summaries/，角色卡在 .novelforge/characters/，设定在 .novelforge/lore/。' +
    `一次最多返回 ${LIST_LIMIT} 项，超出会截断并告诉你还有多少。`,
  parameters: objectSchema({
    path: str('要列的目录，工程内相对路径。留空列工程根。'),
  }),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const dir = typeof args.path === 'string' ? args.path.trim() : '';
    // `Workspace.list` 不抛：越界、不存在、读不动一律空数组。所以「空」有两种
    // 含义，这里不去区分——对模型来说「这里什么都没有」就是它要的答案，
    // 让它换个路径再试比给一句它读不懂的错误代码有用。
    const entries = await ctx.workspace.list(dir);
    const shown = entries.slice(0, LIST_LIMIT);
    const head = `${dir || '（工程根）'}（${entries.length} 项）`;

    const lines = shown.map((e) =>
      e.type === 'dir'
        ? `  ${e.name}/`
        : `  ${e.name}    ${e.words !== undefined ? `${e.words} 字` : `${e.bytes} 字节`}`
    );
    if (entries.length > shown.length) {
      lines.push(`  （还有 ${entries.length - shown.length} 项未列出，用 path 参数进子目录看）`);
    }
    if (entries.length === 0) {
      lines.push('  （空目录，或这个路径不存在）');
    }

    return {
      text: [head, ...lines].join('\n'),
      display: { title: `list ${dir || '/'}`, detail: `${entries.length} 项` },
    };
  },
};
