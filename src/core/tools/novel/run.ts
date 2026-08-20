/**
 * `run` —— 工程动作。**既有流程的一个口子，不是新的实现。**
 *
 * ## 为什么要有它
 *
 * 拆分、批量排剧情、同步摘要这些动作背着一批 agent 不该知道的不变量：
 * 拆分要**先移号再落盘**、后面还没发布的细纲要连同场景目录与中转站正文一起
 * 顺延（第 23 条）；批量路径要**跳过已有产物**、要用不带全文兜底的严格解析
 * （第 19 条）。让它拿着 `write` 自己拼，等于把这些不变量交给一个每次都可能
 * 记错的东西去执行。
 *
 * 所以这里是**白名单 + 转发**：每个 action 就是工程页那颗按钮背后的同一个
 * 函数，一个字都不重写。
 *
 * ## 确认框照弹，不给 agent 绕过去的快路
 *
 * 批量动作自带的确认框（写明「有 N 章还没排剧情，需要调用 N 次模型」）在
 * agent 这条路上**照样弹**（第 4 条）。**这一期没有为 agent 加任何一条绕过它
 * 的路。** 那些数字同时经 `usage.record` 报给调用方——弹窗写着 7 次、账上记 1 次，
 * 正是第 4 条要防的事，所以次数只在 feature 自己那里算一次，由返回值带回来。
 *
 * ## 明确不给的动作
 *
 * | 不给 | 为什么 |
 * |---|---|
 * | `delete` / `remove`（任何形式） | 作者要删东西会自己删。给 agent 一个删除工具，收益接近零而风险是丢内容——即使进了 `.trash/`，作者也未必知道它删过什么 |
 * | `rename` / `move` | 改名会连带搬走场景目录与中转站正文（第 7 条），一次误操作的收拾成本远高于收益 |
 * | `initProject` | 一个空工程被 agent 初始化一遍，作者的配置就没了 |
 * | `newChapter` | 正常路径上发布章节是**拆分**出来的（第 23 条），不该由 agent 直接建 |
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { text } from './naming';
import { newPlotFlow } from '../../actions';
import { splitManuscript } from '../../features/splitChapter';
import { breakdownScenes, generatePlots, writeManuscripts } from '../../features/pipelineBatch';
import { chapterForSummary, summarizeChapter, syncSummaries } from '../../features/summarize';
import { createCardForCast, updateCharacterCard } from '../../features/characterCard';
import { extractStyle } from '../../features/style';
import { generateLore } from '../../features/lore';
import { kindOfPath } from '../../workspace';
import { describeError } from '../../runtime/logger';
import type { NovelProject } from '../../model/project';

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
  run(ctx: ToolContext, args: RunArgs): Promise<ActionResult>;
}

interface RunArgs {
  path: string;
  name: string;
}

const ACTIONS: Record<string, ActionSpec> = {
  // ---- 不花钱的两个
  newPlot: {
    label: '新建一章的细纲骨架',
    costly: false,
    async run(ctx) {
      const rel = await newPlotFlow(ctx.project);
      return { text: `已新建 ${rel}（空骨架，还没有剧情）。`, calls: 0 };
    },
  },
  split: {
    label: '把中转站正文按 --- 拆成发布章',
    costly: false,
    needsField: 'path',
    needs: 'path=那一章的细纲路径',
    async run(ctx, args) {
      const plotRelPath = await requirePlotPath(ctx, args.path, 'split');
      const created = await splitManuscript(ctx.project, plotRelPath);
      if (created.length === 0) {
        return {
          text:
            `没有拆出任何章（${plotRelPath}）。可能这一章还没有正文、正文里没有单独一行的 ---、` +
            '或者作者在确认框里取消了。不要重试同一个动作。',
          calls: 0,
        };
      }
      return {
        text:
          `已拆成 ${created.length} 章：${created.join('、')}。` +
          '中转站那份已经进回收站，此后这几章按发布章管理。',
        calls: 0,
      };
    },
  },

  // ---- 花钱的：确认框全在 feature 自己那里，这里只转发
  summarize: {
    label: '给某一章生成摘要',
    costly: true,
    needsField: 'path',
    needs: 'path=那一章的章节路径或细纲路径',
    async run(ctx, args) {
      const chapter = await chapterForSummary(ctx.project, args.path);
      if (!chapter) {
        throw new Error(
          `${args.path} 还没有拆分成发布章节，没有可总结的成品。摘要描述的是已发布的那一章。`
        );
      }
      const ok = await summarizeChapter(ctx.project, chapter, undefined, ctx.signal);
      return {
        text: ok
          ? `第 ${chapter.order} 章的摘要已生成。`
          : `第 ${chapter.order} 章的摘要没有生成（没有可用的模型，或这一章是空的）。`,
        // 请求发出去了钱就花了，成不成都记账。
        calls: 1,
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
    label: '给所有还没排剧情的章各排一次',
    costly: true,
    async run(ctx) {
      return countedBy(await generatePlots(ctx.project), '批量写剧情');
    },
  },
  batchScenes: {
    label: '给所有剧情已排、还没拆场景的章各拆一次',
    costly: true,
    async run(ctx) {
      return countedBy(await breakdownScenes(ctx.project), '批量拆场景');
    },
  },
  batchManuscripts: {
    label: '给所有场景已备好、还没写正文的章各写一遍',
    costly: true,
    async run(ctx) {
      return countedBy(await writeManuscripts(ctx.project), '批量写正文');
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
  newChapter: '直接新建发布章节',
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
    return {
      gate: 'mutating',
      title: `执行工程动作 ${action}`,
      detail: [target, '要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。']
        .filter(Boolean)
        .join('\n'),
      proceed: '执行',
    };
  },

  description:
    '执行一个工程动作。这些动作背着一批固定流程（拆分要先顺延后面的章号、' +
    '批量动作只补空白不覆盖已有产物），所以走这个口子，不要自己用 write 拼。' +
    '可用的 action：' +
    ACTION_NAMES.map((a) => `${a}=${ACTIONS[a].label}${ACTIONS[a].costly ? '（调模型）' : '（不调模型）'}`).join('；') +
    '。' +
    '要参数的几个：' +
    ACTION_NAMES.filter((a) => ACTIONS[a].needs).map((a) => `${a} 要 ${ACTIONS[a].needs}`).join('；') +
    '。' +
    '**连续多章的同类工作用这里的批量动作**（batchPlots / batchScenes / batchManuscripts），' +
    '比一章一章 generate 省钱，而且有进度条、能停、失败的会挂在那一章上。' +
    '调模型的动作会先弹一个确认框告诉作者要调用几次，他可以不同意。' +
    '删除、改名、移动、新建发布章节都没有——那些由作者自己做。',

  parameters: objectSchema(
    {
      action: str('要执行哪个动作。', ACTION_NAMES),
      path: str('动作的作用对象，工程内相对路径。只有部分动作要。'),
      name: str('人物名字，只有 createCard 要。'),
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
 * feature 报回来的「计划调用几次」→ 一句话 + 记账。
 *
 * **0 次要说清楚**：作者取消了，或者压根没有待处理的章。不说的话模型会以为
 * 是自己参数填错了，然后原地再发一遍——那正是无进展检测要拦的事。
 */
function countedBy(calls: number, what: string): ActionResult {
  if (calls <= 0) {
    return {
      text:
        `${what}这一次没有调用模型：要么作者在确认框里取消了，要么没有待处理的章。` +
        '不要重试同一个动作——先用 list 或 read 看看现在的状态。',
      calls: 0,
    };
  }
  return { text: `${what}已执行，计划调用模型 ${calls} 次。结果见工程页与日志。`, calls };
}

/**
 * 「随便哪个路径」→ 它属于哪一章的细纲。
 *
 * 判定走 `kindOfPath`（工程里唯一那张种类表），这里一行路径规则都不写。
 */
async function requirePlotPath(ctx: ToolContext, rel: string, action: string): Promise<string> {
  const path = kindOfPath(ctx.project, rel);
  const plotRelPath = path.plotRelPath;
  if (!plotRelPath) {
    throw new Error(
      `认不出「${rel}」属于哪一章。${action} 要的是那一章的细纲路径，` +
        '形如 .novelforge/plots/<章号>-<标题>.md（中转站正文路径也认）。'
    );
  }
  await ensureExists(ctx.project, plotRelPath);
  return plotRelPath;
}

async function ensureExists(project: NovelProject, plotRelPath: string): Promise<void> {
  if (!(await project.readPlot(plotRelPath))) {
    throw new Error(`找不到细纲 ${plotRelPath}，可能刚被改名或删除。先用 list 看看现在有哪些。`);
  }
}
