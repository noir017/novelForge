/**
 * `summary` —— 定稿与摘要：给一章定稿、补齐缺失或过期的摘要、重建全书摘要。
 *
 * 定稿 = 摘要（带连续性事实）+ 出场角色的当前状态 + 本章推进了哪几条叙事线（第 23 条：
 * 这条链上唯一的人工闸口）。与工程页、章节工作台上的「定稿」是同一个函数。
 */
import { str } from '../schema';
import { countedBy, defineActionTool, handed } from './actions';
import { chapterForSummary, rebuildGlobalSummary, syncSummaries } from '../../features/summarize';
import { describeFinalize, finalizeChapter } from '../../features/finalize';

export const summaryTool = defineActionTool({
  name: 'summary',
  summary: '定稿与摘要。摘要描述的是写出来的那一章，没有正文的章定不了稿。',

  params: {
    path: str('那一章的章节路径或细纲路径（按章号认到同一章）。'),
  },

  actions: {
    finalize: {
      label: '给一章定稿（摘要与连续性事实，再更新出场角色的当前状态、记下本章推进了哪几条叙事线）',
      costly: true,
      uses: ['path'],
      requires: ['path'],
      async run(ctx, args) {
        const rel = String(args.path).trim();
        const chapter = await chapterForSummary(ctx.project, rel);
        if (!chapter) {
          throw new Error(`${rel} 这一章还没有正文，没有可定稿的东西。摘要描述的是写出来的那一章。`);
        }
        const outcome = await finalizeChapter(ctx.project, chapter, { signal: ctx.signal });
        return outcome
          ? { text: describeFinalize(chapter.order, outcome), calls: outcome.calls }
          : { text: `第 ${chapter.order} 章没有定稿（没有可用的模型，或这一章是空的）。`, calls: 0 };
      },
    },
    sync: {
      label: '补齐所有缺失或过期的摘要',
      costly: true,
      async run(ctx) {
        return countedBy(await syncSummaries(ctx.project), '摘要同步');
      },
    },
    rebuildGlobal: {
      label: '从各章摘要重建全书摘要',
      costly: true,
      async run(ctx) {
        await rebuildGlobalSummary(ctx.project);
        return handed('全书摘要重建');
      },
    },
  },
});
