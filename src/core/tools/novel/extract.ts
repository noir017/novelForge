/**
 * `extract` —— 从已写的东西里提炼：文风指南、叙事线。
 *
 * 两样都是工程页工具栏上的按钮背后的同一个函数。叙事线由机器**只追加**（第 19 条）：
 * 在 `threads.md` 末尾加新线，同名跳过，作者写的字一个都不动。设定条目从前也在这里（通读全书生成），
 * 那一套删了，换成 `lore` 工具（定稿时顺手记、按名录建条目与整合）。
 */
import { countedBy, defineActionTool } from './actions';
import { extractStyle } from '../../features/style';
import { generateThreads } from '../../features/threads';

export const extractTool = defineActionTool({
  name: 'extract',
  summary: '从已写的正文或细纲里提炼一份参考材料。',

  params: {},

  actions: {
    style: {
      label: '从已写的正文里提取文风指南（写进 style.md，覆盖前会先问作者）',
      costly: true,
      async run(ctx) {
        await extractStyle(ctx.project);
        return {
          text: '文风指南已交给 Novel Forge 执行（覆盖前会先问作者）。要看结果用 read 读 .novelforge/style.md。',
          calls: 0,
        };
      },
    },
    threads: {
      label: '从细纲排出叙事线（跨章的伏笔与线索，追加到 .novelforge/threads.md 末尾；已有的不动、同名跳过）',
      costly: true,
      async run(ctx) {
        return countedBy(await generateThreads(ctx.project), '排叙事线', '还没有细纲可排');
      },
    },
  },
});
