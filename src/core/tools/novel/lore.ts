/**
 * `lore` —— 设定名录：记设定、建条目、整合（设定名录，2026-10-18）。
 *
 * 每个动作都是工程页设定组那几项右键菜单背后的同一个函数，确认框（含调用次数）与对比都在
 * feature 自己那里。这几个 feature 不报调用次数，回给模型的只有一句「交出去了」（`handed`），次数以
 * 确认框为准。
 *
 * **没有「按目录整理」**：它会搬文件，而移动是第 25 条明确不给外部 agent 的——作者在工程页自己点。
 *
 * 设定出现在哪几章的唯一真相是定稿过的细纲第九节：先定稿（summary finalize，会顺手记设定），再建条目、整合。
 */
import { str } from '../schema';
import { defineActionTool, handed } from './actions';
import { buildLoreEntries, integrateLore } from '../../features/lore';
import { recordLore } from '../../features/loreRecord';

export const loreTool = defineActionTool({
  name: 'lore',
  summary: '设定条目（地点、势力、物品、概念……）。出现在哪几章以各章定稿过的细纲为准：先定稿再建条目、整合。',

  params: {
    path: str('章节路径（record），或设定条目的工程内相对路径（integrate）。'),
    name: str('名录里还没有条目的设定名字，与细纲里的写法一致。'),
  },

  actions: {
    record: {
      label: '记设定：给了 path 就单独记那一章（只换细纲的「设定」一节），没给就补记所有还没记过的定稿章',
      costly: true,
      uses: ['path'],
      async run(ctx, args) {
        const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
        await recordLore(ctx.project, path);
        return handed(path ? `${path} 记设定` : '补记设定');
      },
    },
    build: {
      label: '给定稿里出现过、还没有条目的设定建条目；给了 name 就建那一条，没给就建出现 2 章以上的全部',
      costly: true,
      uses: ['name'],
      async run(ctx, args) {
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
        await buildLoreEntries(ctx.project, name ? [name] : undefined);
        return handed(name ? `「${name}」建条目` : '批量建条目');
      },
    },
    integrate: {
      label: '把定稿里的新内容并进设定条目；给了 path 就整合那一条，没给就是有新内容的全部',
      costly: true,
      uses: ['path'],
      async run(ctx, args) {
        const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
        await integrateLore(ctx.project, path ? [path] : undefined);
        return handed(path ? `设定 ${path} 整合` : '整合设定');
      },
    },
  },
});
