/**
 * `extract` —— 从已写的东西里提炼：文风指南、叙事线。
 *
 * 都是工程页上的按钮背后的同一个函数。叙事线从情节大纲排，由机器**只追加**（第 19 条）：
 * 一条线一个新文件（`.novelforge/threads/`），同名跳过，作者写的字一个都不动。从已写正文补记叙事线（四期）同样只追加：
 * 定稿过、叙事线还没判的章逐章认事件（带原文证据）、新线、新伏笔，当前进度作者改过的不写。设定条目从前也在这里（通读全书生成），
 * 那一套删了，换成 `lore` 工具（定稿时顺手记、按名录建条目与整合）。
 */
import { countedBy, defineActionTool } from './actions';
import { extractStyle } from '../../features/style';
import { generateThreads } from '../../features/threads';
import { backfillThreads } from '../../features/threadsBackfill';

export const extractTool = defineActionTool({
  name: 'extract',
  summary: '从已写的正文或情节大纲里提炼一份参考材料。',

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
      label: '从情节大纲排出叙事线（剧情线，伏笔挂在线下；一条线一个文件，写进 .novelforge/threads/；已有的不动、同名跳过）',
      costly: true,
      async run(ctx) {
        return countedBy(await generateThreads(ctx.project), '排叙事线', '情节大纲还是空的，没有可排的');
      },
    },
    threadsFromText: {
      label:
        '从已写正文补记叙事线：同步过、叙事线还没判的章按章号逐章认这一章在叙事线上发生了什么（每章 1–3 次；一条线都没有时先从情节大纲排一次），只往 .novelforge/threads/ 里追加',
      costly: true,
      async run(ctx) {
        return countedBy(await backfillThreads(ctx.project), '补记叙事线', '没有要补记的章（叙事线已经跟上同步进度，或还没有同步过的章）');
      },
    },
  },
});
