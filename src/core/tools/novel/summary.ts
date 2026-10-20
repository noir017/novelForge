/**
 * `summary` —— 定稿与全文大纲：给一章定稿、把没定稿的章的细纲照正文补上、重建全文大纲。
 *
 * 定稿 = 反向更新细纲（照正文改那一章的细纲，带连续性事实）+ 出场角色的当前状态 + 本章推进了
 * 哪几条叙事线（第 23 条：这条链上唯一的人工闸口）。与工程页、章节工作台上的「定稿」是同一个函数。
 */
import { str } from '../schema';
import { countedBy, defineActionTool, handed } from './actions';
import { chapterForSummary, rebuildGlobalSummary, syncSummaries } from '../../features/summarize';
import { describeFinalize, finalizeChapter } from '../../features/finalize';

export const summaryTool = defineActionTool({
  name: 'summary',
  summary: '定稿与全文大纲。定稿 = 照正文反向更新那一章的细纲，没有正文的章定不了稿。',

  params: {
    path: str('那一章的章节路径或细纲路径（按章号认到同一章）。'),
  },

  actions: {
    finalize: {
      label: '给一章定稿（照正文反向更新它的细纲与连续性事实，再更新出场角色的当前状态、记下本章推进了哪几条叙事线）',
      costly: true,
      uses: ['path'],
      requires: ['path'],
      async run(ctx, args) {
        const rel = String(args.path).trim();
        const chapter = await chapterForSummary(ctx.project, rel);
        if (!chapter) {
          throw new Error(`${rel} 这一章还没有正文，没有可定稿的东西。定稿是照正文改细纲，没有正文就无从改起。`);
        }
        const outcome = await finalizeChapter(ctx.project, chapter, { signal: ctx.signal });
        return outcome
          ? { text: describeFinalize(chapter.order, outcome), calls: outcome.calls }
          : { text: `第 ${chapter.order} 章没有定稿（没有可用的模型，或这一章是空的）。`, calls: 0 };
      },
    },
    sync: {
      label: '把所有没定稿、或定稿后正文又改过的章逐章定稿（照正文更新细纲，再更新出场角色的当前状态、记下推进了哪几条叙事线）',
      costly: true,
      async run(ctx) {
        return countedBy(await syncSummaries(ctx.project), '批量定稿');
      },
    },
    rebuildGlobal: {
      label: '从定稿过的各章细纲重建全文大纲',
      costly: true,
      async run(ctx) {
        await rebuildGlobalSummary(ctx.project);
        return handed('全文大纲重建');
      },
    },
  },
});
