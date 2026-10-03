/**
 * 「带 action 的工具」共用的那一套：动作表 → 一个 `ToolDef`。
 *
 * 工程动作按**它动的是什么**分成几个工具（流水线、摘要、角色卡、提炼、拆书、技能），每个工具
 * 一张动作表、只带自己用得到的参数。分开的理由是参数：塞在一个工具里时，模型面对的是一大把
 * 「只有某几个动作认」的参数，记错一个就白跑一趟；分开之后每个工具的 schema 就是它的全部用法。
 *
 * ## 这里做的四件事
 *
 * 1. **参数对得上动作**：每个动作声明它认哪几个参数（`uses`）、哪几个必填（`requires`）。
 *    给了它不认的参数当场报错——模型以为自己传了一个区间、其实被忽略，比多一次往返更糟。
 * 2. **故意不给的动作**（删除、改名……）认出来单独回一句为什么，好过让模型在可选动作里猜。
 * 3. **意图**：查询类动作报 `auto`（不进对话页），其余报 `mutating`；装、绑技能自己报 `always`。
 * 4. **记账**：次数由 feature 自己算一次再报回来（弹窗写着 7 次、账上记 1 次，正是第 4 条要防的事）。
 *
 * 确认框全在 feature 自己那里，这一层只转发，**没有为外部 agent 加任何一条绕过它的路**。
 */
import type { GateKind, ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { text } from './naming';
import { describeError } from '../../runtime/logger';

/** 一次动作的结果：说给模型听的一句话 + 这一下花了几次模型调用。 */
export interface ActionResult {
  text: string;
  /** 报给调用方记账的次数。0 = 一次模型都没调（取消 / 无事可做 / 次数只在确认框里）。 */
  calls: number;
}

export interface ActionSpec {
  /** 工具描述与错误提示里的说法。 */
  label: string;
  /** 会不会调模型。只进工具描述，闸门由 feature 自己的确认框把。 */
  costly: boolean;
  /** 认哪几个参数（`action` 之外）。没列的给了就当场报错。 */
  uses?: string[];
  /** 其中哪几个必填，缺了当场报错，不放它跑一趟空的。 */
  requires?: string[];
  /** 缺省 `mutating`；查询类报 `auto`。要说得更具体（装、绑技能）就实现 `intent`。 */
  gate?: GateKind;
  intent?(args: Record<string, unknown>): ToolIntent;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ActionResult>;
}

export interface ActionToolDef {
  name: string;
  /** 一句话说这个工具管什么。动作清单由这里拼在后面。 */
  summary: string;
  /** 动作清单之后的补充说明（怎么用才对）。 */
  usage?: string;
  /** `action` 之外的参数，扁平标量。 */
  params: Record<string, ReturnType<typeof str>>;
  actions: Record<string, ActionSpec>;
}

/**
 * 外部 agent 可能想干、但**故意不给**的动作。哪个工具都一样：那类操作由作者自己做。
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
  uninstall: '卸载技能',
  uninstallSkill: '卸载技能',
  deleteSkill: '卸载技能',
};

export function defineActionTool(def: ActionToolDef): ToolDef {
  const names = Object.keys(def.actions);
  const anyCostly = names.some((a) => def.actions[a].costly);

  const tool: ToolDef = {
    name: def.name,
    costly: anyCostly,
    mutating: names.some((a) => gateOf(def.actions[a]) !== 'auto'),

    intent(args): ToolIntent {
      const action = text(args.action);
      const spec = def.actions[action];
      if (spec?.intent) {
        return spec.intent(args);
      }
      const target = [text(args.path), text(args.name)].filter(Boolean).join(' ');
      return {
        gate: spec ? gateOf(spec) : 'mutating',
        title: spec ? spec.label : `执行 ${def.name} ${action}`,
        detail: [
          target,
          spec?.costly ? '要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },

    description:
      `${def.summary}可用的 action：` +
      names
        .map((a) => {
          const s = def.actions[a];
          const need = s.requires?.length ? `，要 ${s.requires.join(' / ')}` : '';
          return `${a}=${s.label}（${s.costly ? '调模型' : '不调模型'}${need}）`;
        })
        .join('；') +
      '。' +
      (def.usage ?? ''),

    parameters: objectSchema({ action: str('要执行哪个动作。', names), ...def.params }, ['action']),

    check(args) {
      const action = text(args.action);
      const spec = def.actions[action];
      if (!spec) {
        const why = REFUSED[action]
          ? `没有${REFUSED[action]}这个动作，而且这是有意的——那类操作由作者自己做。`
          : action
            ? `认不出动作「${action}」。`
            : 'action 是必填的。';
        return `${why}${def.name} 可用的是：${names.join(' / ')}。`;
      }

      const uses = new Set(spec.uses ?? []);
      for (const key of Object.keys(args)) {
        if (key !== 'action' && args[key] !== undefined && !uses.has(key)) {
          const who = names.filter((a) => def.actions[a].uses?.includes(key));
          return `${action} 不认 ${key}${who.length > 0 ? `，只有 ${who.join(' / ')} 认` : ''}。`;
        }
      }
      const missing = (spec.requires ?? []).filter((key) => !text(args[key]) && typeof args[key] !== 'number');
      if (missing.length > 0) {
        return `${action} 需要参数：${missing.join('、')}。${describeParams(def, missing)}`;
      }
      return undefined;
    },

    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const issue = tool.check!(args);
      if (issue) {
        return { text: '', error: issue };
      }
      const action = text(args.action);
      const spec = def.actions[action];

      try {
        const r = await spec.run(ctx, args);
        ctx.usage.record(r.calls);
        if (r.calls > 0) {
          ctx.report(`${spec.label}：调用模型 ${r.calls} 次`);
        }
        return {
          text: r.text,
          display: { title: `${def.name} ${action}`, detail: r.calls > 0 ? `${r.calls} 次调用` : '未调模型' },
        };
      } catch (err) {
        if (err instanceof ArgError) {
          return { text: '', error: err.message };
        }
        return { text: '', error: `${spec.label}失败：${describeError(err)}` };
      }
    },
  };
  return tool;
}

/** 查询类动作自己报 `auto`；其余一律 `mutating`（宁可多问，也不要有一条没人想过的路）。 */
function gateOf(spec: ActionSpec): GateKind {
  return spec.gate ?? 'mutating';
}

function describeParams(def: ActionToolDef, keys: string[]): string {
  return keys.map((k) => `${k}：${def.params[k]?.description ?? ''}`).join(' ');
}

/** 参数值不对（区间倒了、阶段写错）：当场回给模型，不算「执行失败」。 */
export class ArgError extends Error {}

// ---------------------------------------------------------------- 回给模型的话

/**
 * feature 报回来的「计划调用几次」→ 一句话 + 记账。
 *
 * **0 次要说清楚**：作者取消了，或者压根没有待处理的东西。不说的话模型会以为
 * 是自己参数填错了，然后原地再发一遍。
 */
export function countedBy(calls: number, what: string, idle = '没有待处理的章'): ActionResult {
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

/**
 * 不报次数的那几个 feature（结论都在确认框、提示条与日志里）：只说交出去了、去哪看结果。
 * 次数记 0——确认框里写的才是实数，这里猜一个反倒是第 4 条要防的那种对不上。
 */
export function handed(what: string): ActionResult {
  return {
    text: `${what}已交给 Novel Forge 执行（确认框、结果与调用次数都在作者那边的界面和日志里）。要知道改了什么，用 read 看对应文件。`,
    calls: 0,
  };
}

export function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}
