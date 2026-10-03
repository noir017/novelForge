/**
 * `pipeline` —— 流水线上的批量动作：补齐架构、批量拆细纲、批量写章，外加新建一章的细纲骨架。
 *
 * 这些动作背着一批 agent 不该自己去执行的不变量：批量路径**跳过已有产物**、用不带全文兜底的
 * 严格解析（第 19 条）；正文落盘要在细纲上记 `writtenFrom`（第 18 条）。让它拿 `write` 自己拼，
 * 等于把这些交给一个每次都可能记错的东西。所以每个动作就是工程页那颗按钮背后的同一个函数，
 * 确认框（「有 N 章还没排细纲，需要调用 N 次模型」）照弹（第 4 条）。
 */
import { bool, int, str } from '../schema';
import { ArgError, countedBy, defineActionTool, toInt } from './actions';
import { newPlotFlow } from '../../actions';
import { completeSettings, generatePlots, writeManuscripts } from '../../features/pipelineBatch';
import { PLOT_BATCH, WRITE_BATCH_DEFAULT, isWriteBatchMode } from '../../model/pipeline';

export const pipelineTool = defineActionTool({
  name: 'pipeline',
  summary:
    '流水线上的批量动作。它们背着固定流程（只补空白不覆盖已有产物、正文落盘在细纲上记指纹），' +
    '所以走这里，不要自己用 write 拼。调模型的动作会先弹确认框告诉作者要调用几次，他可以不同意。',
  usage:
    '**连续多章的同类工作用这里**（batchPlots / batchManuscripts），比一章一章 generate 省钱，' +
    '而且有进度条、能停、失败的会挂在那一章上。from / to 指定章号区间，只给 from 时按缺省章数往后数。',

  params: {
    from: int('章号区间的起点。留空从下一个该写的章起。'),
    to: int('章号区间的终点（含）。要给就同时给 from。'),
    mode: str('批量写章的模式：draft=只写正文（缺省），finalize=每写完一章就定稿（摘要 + 出场角色的当前状态）。', [
      'draft',
      'finalize',
    ]),
    review: bool('批量写章时每写完一章先审稿，报告放进一个新会话。缺省 false。'),
  },

  actions: {
    completeSettings: {
      label: '补齐故事架构（小说配置 / 故事前提 / 角色图谱 / 世界观，只补空白）',
      costly: true,
      async run(ctx) {
        return countedBy(await completeSettings(ctx.project), '补齐故事架构', '四件都已经有了，或者小说配置还没有「一句话」可以展开');
      },
    },
    batchPlots: {
      label: `批量拆细纲（缺省从下一个该写的章起 ${PLOT_BATCH} 章；已有细纲的章跳过）`,
      costly: true,
      uses: ['from', 'to'],
      async run(ctx, args) {
        return countedBy(await generatePlots(ctx.project, { range: rangeOf(args, PLOT_BATCH) }), '批量拆细纲');
      },
    },
    batchManuscripts: {
      label: `批量写章，一章一章串行写（缺省从下一个该写的章起 ${WRITE_BATCH_DEFAULT} 章、只写正文；已有正文的章跳过）`,
      costly: true,
      uses: ['from', 'to', 'mode', 'review'],
      intent(args) {
        const scope = [
          describeRange(args),
          args.mode === 'finalize' ? '写完即定稿' : '',
          args.review === true ? '写完即审稿' : '',
        ]
          .filter(Boolean)
          .join('，');
        return {
          gate: 'mutating',
          title: '批量写章',
          detail: [scope, '随后还会告诉你预计调用几次，那一步你也可以不同意。'].filter(Boolean).join('\n'),
        };
      },
      async run(ctx, args) {
        if (args.mode !== undefined && !isWriteBatchMode(args.mode)) {
          throw new ArgError('mode 只能是 draft（只写正文）或 finalize（写完即定稿）。');
        }
        return countedBy(
          await writeManuscripts(ctx.project, {
            range: rangeOf(args, WRITE_BATCH_DEFAULT),
            mode: isWriteBatchMode(args.mode) ? args.mode : undefined,
            review: args.review === undefined ? undefined : args.review === true,
          }),
          '批量写章'
        );
      },
    },
    newPlot: {
      label: '新建一章的细纲骨架（接在最后一章之后）',
      costly: false,
      async run(ctx) {
        const rel = await newPlotFlow(ctx.project);
        return { text: `已新建 ${rel}（空骨架，还没有细纲内容）。`, calls: 0 };
      },
    },
  },
});

/**
 * 章号区间。不在这里截到总章数、大纲覆盖或批量上限——那些由 feature 自己按磁盘算，确认框里
 * 写着实际要处理哪几章。
 */
function rangeOf(args: Record<string, unknown>, span: number): { from: number; to: number } | undefined {
  if (args.from === undefined && args.to === undefined) {
    return undefined;
  }
  const from = toInt(args.from);
  const to = toInt(args.to);
  if (from === undefined) {
    throw new ArgError(args.from === undefined ? '给了 to 就要同时给 from（章号区间的起点）。' : 'from / to 要填章号（正整数）。');
  }
  if (args.to !== undefined && to === undefined) {
    throw new ArgError('from / to 要填章号（正整数）。');
  }
  const end = to ?? from + span - 1;
  if (from < 1 || end < from) {
    throw new ArgError(`章号区间不对：第 ${from}–${end} 章。from 从 1 起，to 不能小于 from。`);
  }
  return { from, to: end };
}

function describeRange(args: Record<string, unknown>): string {
  const from = toInt(args.from);
  const to = toInt(args.to);
  if (from === undefined) {
    return '';
  }
  return to !== undefined && to !== from ? `第 ${from}–${to} 章` : `从第 ${from} 章起`;
}
