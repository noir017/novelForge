/**
 * `run` —— 工程动作。**既有流程的一个口子，不是新的实现。**
 *
 * ## 为什么要有它
 *
 * 批量排细纲、批量写正文、定稿、同步摘要这些动作背着一批 agent 不该知道的
 * 不变量：批量路径要**跳过已有产物**、要用不带全文兜底的严格解析（第 19 条）；
 * 正文落盘要在细纲上记 `writtenFrom`（第 18 条）。让它拿着 `write` 自己拼，等于把
 * 这些不变量交给一个每次都可能记错的东西去执行。
 *
 * 所以这里是**白名单 + 转发**：每个 action 就是工程页那颗按钮背后的同一个
 * 函数，一个字都不重写。
 *
 * ## 确认框照弹，不给 agent 绕过去的快路
 *
 * 批量动作自带的确认框（写明「有 N 章还没排细纲，需要调用 N 次模型」）在
 * agent 这条路上**照样弹**（第 4 条）。**这一期没有为 agent 加任何一条绕过它
 * 的路。** 那些数字同时经 `usage.record` 报给调用方——弹窗写着 7 次、账上记 1 次，
 * 正是第 4 条要防的事，所以次数只在 feature 自己那里算一次，由返回值带回来。
 *
 * ## 明确不给的动作
 *
 * | 不给 | 为什么 |
 * |---|---|
 * | `delete` / `remove`（任何形式） | 作者要删东西会自己删。给 agent 一个删除工具，收益接近零而风险是丢内容——即使进了 `.trash/`，作者也未必知道它删过什么 |
 * | `rename` / `move` | 细纲的文件名由章号与标题决定、章节是作者的文件（第 7 条），一次误操作的收拾成本远高于收益 |
 * | `initProject` | 一个空工程被 agent 初始化一遍，作者的配置就没了 |
 * | `newChapter` | 正常路径上章节是写正文时生成的，不该由 agent 直接建一个空文件 |
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { bool, int, objectSchema, str } from '../schema';
import { text } from './naming';
import { newPlotFlow } from '../../actions';
import { completeSettings, generatePlots, writeManuscripts } from '../../features/pipelineBatch';
import { chapterForSummary, syncSummaries } from '../../features/summarize';
import { describeFinalize, finalizeChapter } from '../../features/finalize';
import { createCardForCast, updateCharacterCard } from '../../features/characterCard';
import { extractStyle } from '../../features/style';
import { generateLore } from '../../features/lore';
import { generateThreads } from '../../features/threads';
import { describeError } from '../../runtime/logger';
import { PLOT_BATCH, WRITE_BATCH_DEFAULT, WriteBatchMode, isWriteBatchMode } from '../../model/pipeline';

/** 一次动作的结果：说给模型听的一句话 + 这一下花了几次模型调用。 */
interface ActionResult {
  text: string;
  /** 报给调用方记账的次数。0 = 一次模型都没调（取消 / 无事可做）。 */
  calls: number;
}

interface ActionSpec {
  /** 界面上与错误提示里的说法。 */
  label: string;
  /** 会不会调模型。只用于工具描述，闸门由 feature 自己的确认框把。 */
  costly: boolean;
  /** 这个动作要哪个参数（缺了就当场报错，不放它跑一趟空的）。 */
  needsField?: 'path' | 'name';
  /** 参数说明，进工具描述。 */
  needs?: string;
  /**
   * 认哪几个可选参数。没列的给了就当场报错——模型以为自己传了一个区间、其实被忽略，
   * 比多一次往返更糟（`objectSchema` 的 `additionalProperties: false` 同一个道理）。
   */
  takes?: { range?: number; mode?: boolean };
  run(ctx: ToolContext, args: RunArgs): Promise<ActionResult>;
}

interface RunArgs {
  path: string;
  name: string;
  /** 章号区间。只给了 `from` 时按动作的缺省长度补齐 `to`（`takes.range`）。 */
  range?: { from: number; to: number };
  mode?: WriteBatchMode;
  review?: boolean;
}

const ACTIONS: Record<string, ActionSpec> = {
  // ---- 不花钱的
  newPlot: {
    label: '新建一章的细纲骨架（接在最后一章之后）',
    costly: false,
    async run(ctx) {
      const rel = await newPlotFlow(ctx.project);
      return { text: `已新建 ${rel}（空骨架，还没有细纲内容）。`, calls: 0 };
    },
  },

  // ---- 花钱的：确认框全在 feature 自己那里，这里只转发
  completeSettings: {
    label: '补齐故事架构（小说配置 / 故事前提 / 角色图谱 / 世界观，只补空白）',
    costly: true,
    async run(ctx) {
      return countedBy(await completeSettings(ctx.project), '补齐故事架构', '四件都已经有了，或者小说配置还没有「一句话」可以展开');
    },
  },
  summarize: {
    label: '给某一章定稿（摘要与连续性事实，再更新出场角色的当前状态）',
    costly: true,
    needsField: 'path',
    needs: 'path=那一章的章节路径或细纲路径',
    async run(ctx, args) {
      const chapter = await chapterForSummary(ctx.project, args.path);
      if (!chapter) {
        throw new Error(`${args.path} 这一章还没有正文，没有可定稿的东西。摘要描述的是写出来的那一章。`);
      }
      const outcome = await finalizeChapter(ctx.project, chapter, { signal: ctx.signal });
      return outcome
        ? { text: describeFinalize(chapter.order, outcome), calls: outcome.calls }
        : {
            text: `第 ${chapter.order} 章没有定稿（没有可用的模型，或这一章是空的）。`,
            calls: 0,
          };
    },
  },
  syncSummaries: {
    label: '补齐所有缺失/过期的摘要',
    costly: true,
    async run(ctx) {
      return countedBy(await syncSummaries(ctx.project), '摘要同步');
    },
  },
  batchPlots: {
    label: `批量拆细纲（缺省从下一个该写的章起 ${PLOT_BATCH} 章；已有细纲的章跳过）`,
    costly: true,
    takes: { range: PLOT_BATCH },
    async run(ctx, args) {
      return countedBy(await generatePlots(ctx.project, { range: args.range }), '批量拆细纲');
    },
  },
  batchManuscripts: {
    label: `批量写章，一章一章串行写（缺省从下一个该写的章起 ${WRITE_BATCH_DEFAULT} 章、只写正文；已有正文的章跳过）`,
    costly: true,
    takes: { range: WRITE_BATCH_DEFAULT, mode: true },
    async run(ctx, args) {
      return countedBy(
        await writeManuscripts(ctx.project, { range: args.range, mode: args.mode, review: args.review }),
        '批量写章'
      );
    },
  },
  generateThreads: {
    label: '从细纲排出叙事线（跨章的伏笔与线索，追加到 .novelforge/threads.md 末尾；已有的不动、同名跳过）',
    costly: true,
    async run(ctx) {
      return countedBy(await generateThreads(ctx.project), '排叙事线', '还没有细纲可排');
    },
  },
  updateCard: {
    label: '按新出场的章增量更新一张角色卡',
    costly: true,
    needsField: 'path',
    needs: 'path=那张角色卡的路径',
    async run(ctx, args) {
      await updateCharacterCard(ctx.project, args.path, 'incremental');
      return { text: `已处理角色卡 ${args.path}（实际调用次数见确认框与日志）。`, calls: 1 };
    },
  },
  createCard: {
    label: '给一位还没有卡的出场人物建卡',
    costly: true,
    needsField: 'name',
    needs: 'name=那个人的名字（与摘要里的出场人物一致）',
    async run(ctx, args) {
      await createCardForCast(ctx.project, args.name);
      return { text: `已处理「${args.name}」的角色卡（实际调用次数见确认框与日志）。`, calls: 1 };
    },
  },
  extractStyle: {
    label: '从已写的正文里提取文风指南',
    costly: true,
    async run(ctx) {
      await extractStyle(ctx.project);
      return { text: '文风指南已处理（覆盖前会先问作者）。', calls: 1 };
    },
  },
  generateLore: {
    label: '通读正文生成设定条目',
    costly: true,
    async run(ctx) {
      await generateLore(ctx.project);
      return { text: '设定生成已处理（实际调用次数见确认框与日志）。', calls: 1 };
    },
  },
};

const ACTION_NAMES = Object.keys(ACTIONS);

/**
 * 模型可能想干、但**故意不给**的动作。认出来单独回一句为什么，
 * 好过让它在「可用动作」里翻半天再猜一个。
 */
const REFUSED: Record<string, string> = {
  delete: '删除',
  remove: '删除',
  trash: '删除',
  rename: '改名',
  move: '移动',
  initProject: '初始化工程',
  newChapter: '直接新建章节文件',
  split: '拆分正文',
};

export const runTool: ToolDef = {
  name: 'run',
  // 大多数动作会调模型（而且是几十次那种）。
  costly: true,
  mutating: true,

  /**
   * 常规的「动手前问一句」。**框里要提醒他后面还有一个框**：批量动作自带的
   * 那个写着「预计调用 N 次」，在任何策略下都弹（第 25 条），作者在那一步
   * 仍然可以不同意。
   */
  intent(args): ToolIntent {
    const action = text(args.action);
    const target = text(args.path) || text(args.name);
    // 区间与模式写进框里：「批量写章」与「把第 5–8 章写完并定稿」是两件分量很不一样的事。
    const from = toInt(args.from);
    const to = toInt(args.to);
    const scope = [
      from !== undefined ? (to !== undefined && to !== from ? `第 ${from}–${to} 章` : `从第 ${from} 章起`) : '',
      args.mode === 'finalize' ? '写完即定稿' : '',
      args.review === true ? '写完即审稿' : '',
    ]
      .filter(Boolean)
      .join('，');
    return {
      gate: 'mutating',
      title: `执行工程动作 ${action}`,
      detail: [target, scope, '要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。']
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '执行一个工程动作。这些动作背着一批固定流程（批量动作只补空白不覆盖已有产物、' +
    '正文落盘要在细纲上记指纹），所以走这个口子，不要自己用 write 拼。' +
    '可用的 action：' +
    ACTION_NAMES.map((a) => `${a}=${ACTIONS[a].label}${ACTIONS[a].costly ? '（调模型）' : '（不调模型）'}`).join('；') +
    '。' +
    '要参数的几个：' +
    ACTION_NAMES.filter((a) => ACTIONS[a].needs).map((a) => `${a} 要 ${ACTIONS[a].needs}`).join('；') +
    '。' +
    '**连续多章的同类工作用这里的批量动作**（batchPlots / batchManuscripts），' +
    '比一章一章 generate 省钱，而且有进度条、能停、失败的会挂在那一章上。' +
    '这两个可以用 from / to 指定章号区间（只给 from 时按缺省章数往后数）；' +
    'batchManuscripts 另可给 mode=finalize（每写完一章就定稿）与 review=true（每写完一章先审稿，报告放进一个新会话）。' +
    '调模型的动作会先弹一个确认框告诉作者要调用几次，他可以不同意。' +
    '删除、改名、移动、新建章节文件都没有——那些由作者自己做。',

  parameters: objectSchema(
    {
      action: str('要执行哪个动作。', ACTION_NAMES),
      path: str('动作的作用对象，工程内相对路径。只有部分动作要。'),
      name: str('人物名字，只有 createCard 要。'),
      from: int('章号区间的起点，只有 batchPlots / batchManuscripts 认。留空从下一个该写的章起。'),
      to: int('章号区间的终点（含），只有 batchPlots / batchManuscripts 认。要给就同时给 from。'),
      mode: str(
        '批量写章的模式，只有 batchManuscripts 认：draft=只写正文（缺省），finalize=每写完一章就定稿（摘要 + 出场角色的当前状态）。',
        ['draft', 'finalize']
      ),
      review: bool('每写完一章先审稿，只有 batchManuscripts 认。缺省 false。'),
    },
    ['action']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (!action) {
      return { text: '', error: `action 是必填的。可用的是：${ACTION_NAMES.join(' / ')}。` };
    }
    if (REFUSED[action]) {
      return {
        text: '',
        error:
          `没有${REFUSED[action]}这个动作，而且这是有意的——那类操作由作者自己做。` +
          `可用的是：${ACTION_NAMES.join(' / ')}。`,
      };
    }
    const spec = ACTIONS[action];
    if (!spec) {
      return {
        text: '',
        error: `认不出动作「${action}」。可用的是：${ACTION_NAMES.join(' / ')}。`,
      };
    }

    const runArgs: RunArgs = {
      path: typeof args.path === 'string' ? args.path.trim() : '',
      name: typeof args.name === 'string' ? args.name.trim() : '',
    };
    if (spec.needsField && !runArgs[spec.needsField]) {
      return { text: '', error: `${action} 需要参数：${spec.needs}。` };
    }
    const extra = readExtras(action, spec, args);
    if ('error' in extra) {
      return { text: '', error: extra.error };
    }
    Object.assign(runArgs, extra);

    try {
      const r = await spec.run(ctx, runArgs);
      // 次数由 feature 自己算一次再报回来。弹窗写着 7 次、账上记 1 次，
      // 正是第 4 条要防的事。
      ctx.usage.record(r.calls);
      if (r.calls > 0) {
        ctx.report(`${spec.label}：调用模型 ${r.calls} 次`);
      }
      return {
        text: r.text,
        display: { title: `run ${action}`, detail: r.calls > 0 ? `${r.calls} 次调用` : '未调模型' },
      };
    } catch (err) {
      return { text: '', error: `${spec.label}失败：${describeError(err)}` };
    }
  },
};

/**
 * 区间与模式这几个可选参数：只给认它们的动作，值不对当场说清楚。
 *
 * 区间不在这里截到总章数、大纲覆盖或批量上限——那些由 feature 自己按磁盘算，确认框里写着
 * 实际要处理哪几章（同一个 `planPlotBatches` / `planWriteBatch`）。
 */
function readExtras(
  action: string,
  spec: ActionSpec,
  args: Record<string, unknown>
): Pick<RunArgs, 'range' | 'mode' | 'review'> | { error: string } {
  const from = toInt(args.from);
  const to = toInt(args.to);
  const hasRange = args.from !== undefined || args.to !== undefined;
  const hasMode = args.mode !== undefined || args.review !== undefined;
  if (hasRange && !spec.takes?.range) {
    return { error: `${action} 不认 from / to，只有 batchPlots / batchManuscripts 认。` };
  }
  if (hasMode && !spec.takes?.mode) {
    return { error: `${action} 不认 mode / review，只有 batchManuscripts 认。` };
  }

  const out: Pick<RunArgs, 'range' | 'mode' | 'review'> = {};
  if (hasRange) {
    if (from === undefined) {
      return {
        error: args.from === undefined ? '给了 to 就要同时给 from（章号区间的起点）。' : 'from / to 要填章号（正整数）。',
      };
    }
    if (args.to !== undefined && to === undefined) {
      return { error: 'from / to 要填章号（正整数）。' };
    }
    const end = to ?? from + spec.takes!.range! - 1;
    if (from < 1 || end < from) {
      return { error: `章号区间不对：第 ${from}–${end} 章。from 从 1 起，to 不能小于 from。` };
    }
    out.range = { from, to: end };
  }
  if (args.mode !== undefined) {
    if (!isWriteBatchMode(args.mode)) {
      return { error: 'mode 只能是 draft（只写正文）或 finalize（写完即定稿）。' };
    }
    out.mode = args.mode;
  }
  if (args.review !== undefined) {
    out.review = args.review === true;
  }
  return out;
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * feature 报回来的「计划调用几次」→ 一句话 + 记账。
 *
 * **0 次要说清楚**：作者取消了，或者压根没有待处理的东西。不说的话模型会以为
 * 是自己参数填错了，然后原地再发一遍——那正是无进展检测要拦的事。
 */
function countedBy(calls: number, what: string, idle = '没有待处理的章'): ActionResult {
  if (calls <= 0) {
    return {
      text:
        `${what}这一次没有调用模型：要么作者在确认框里取消了，要么${idle}。` +
        '不要重试同一个动作——先用 list 或 read 看看现在的状态。',
      calls: 0,
    };
  }
  return { text: `${what}已执行，计划调用模型 ${calls} 次。结果见工程页与日志。`, calls };
}
