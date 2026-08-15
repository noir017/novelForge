/**
 * 策略与确认闸门：**哪些动作自动、哪些要问、问的时候说什么。**
 *
 * ## 这一层不是保护，是礼貌
 *
 * 真正的保护在下面两层，而且**与策略无关**：
 *
 * - `workspace/guard.ts` 的八条守卫（越界、回收站、保护目录、大小、同名、
 *   乐观锁）——任何模式下都在；
 * - **覆盖已有内容一律审阅**（`reviewOverwrite`，插件开 diff、独立版弹确认框）
 *   与**批量动作自带的确认框**（写明「预计调用 N 次」）——任何模式下都弹。
 *
 * 这里管的只是「动手之前要不要先问一句」。所以最放手的模式也**不会**让
 * agent 静默覆盖作者写过的东西：那是产品承诺（第 3 / 19 条），不是偏好设置。
 *
 * ## 矩阵
 *
 * | 模式 | list/read/search | generate | write 新建/追加 | write 覆盖 | edit | run |
 * |---|---|---|---|---|---|---|
 * | 谨慎 | 自动 | **每次确认** | 确认 | 审阅 | 确认 | 确认 |
 * | **默认** | 自动 | 预算内自动 | 确认 | 审阅 | 确认 | 确认 |
 * | 放手 | 自动 | 预算内自动 | 自动 | 审阅 | 确认 | 自动（批量动作自带的框仍然弹） |
 *
 * 两列**三种模式完全一样，且不可配置**：
 *
 * - **`write` 覆盖**——交给网关的覆盖审阅。在它之前再弹一个「确定吗」是纯噪声：
 *   diff 本身就同时回答了「要不要动」与「改了什么」，而后者是前者的依据。
 * - **`edit`**——它改的也是已有内容，但 `ws.edit` 走的是「拿这份内容和自己
 *   diff」那条路（`review: false`，理由见 `workspace/index.ts`），所以覆盖审阅
 *   在这里落成**确认框**：框里写清 old → new 两段原文，那就是它的 diff。
 *   放手模式也不放开——否则「覆盖已有内容一律过一遍人」就有了一个例外。
 *
 * ## 三个选项，不是两个
 *
 * 「跳过这一步」让 agent 继续跑别的，「停止 agent」结束整轮。只给「是/否」
 * 的话，作者想拒绝某一步就只能连整轮一起掐掉。
 *
 * 关掉对话框（Esc / 点外面）当**停止**处理：他被问「要不要动你的磁盘」而没有
 * 回答，那就不该替他答「继续」。停止不丢任何东西——已经写下的还在，模型还会
 * 得到最后一轮说明做到哪了。
 */
import type { NovelProject } from '../model/project';
import type { AgentPolicy } from '../model/agentPolicy';
import { kindOfPath } from '../workspace';
import type { ToolDef } from './registry';
import { describeForReview } from './tools/write';

// 类型、可选值与界面说法在数据层定义一次（`config.ts` 与 `protocol/` 要用，
// 它们不该依赖 agent 层）；这里只做判定。
export {
  AGENT_POLICIES,
  AGENT_POLICY_HINT,
  AGENT_POLICY_LABEL,
  DEFAULT_AGENT_POLICY,
  isAgentPolicy,
} from '../model/agentPolicy';
export type { AgentPolicy };

/** 作者在确认框里的三个选择。 */
export type GateVerdict = 'proceed' | 'skip' | 'stop';

export interface Gate {
  /** 要不要在执行前问一句。 */
  confirm: boolean;
  /**
   * 问什么。**说清会发生什么，不是「确定吗」**——「Agent 想调用 write，允许吗」
   * 这种问法，作者答不上来，因为他不知道 write 会写到哪。
   */
  message?: string;
  detail?: string;
  /** 同意那颗按钮上的字（「写入」「替换」「执行」「生成」）。 */
  proceed?: string;
}

const NO_GATE: Gate = { confirm: false };

/** 跳过与停止那两颗按钮上的字。三处（构造、判定、文案）共用一份。 */
export const SKIP_ACTION = '跳过这一步';
export const STOP_ACTION = '停止 agent';

/**
 * 这一步要不要先问一句。
 *
 * **零 I/O**：只看策略、工具定义与参数。目标叫什么由 `kindOfPath` 算
 * （那也是纯函数），所以确认框上的名字与随后 diff 上的名字**逐字一致**——
 * 作者不该在两个框里看到同一份东西的两个名字。
 */
export function gateFor(
  policy: AgentPolicy,
  tool: ToolDef,
  args: Record<string, unknown>,
  project?: NovelProject
): Gate {
  // 读工具在任何模式下都自动：它们不花钱、不改任何东西，问一句只是让人麻木。
  if (!tool.mutating && !tool.costly) {
    return NO_GATE;
  }

  switch (tool.name) {
    case 'generate':
      return policy === 'careful' ? generateGate(args, project) : NO_GATE;
    case 'write':
      return writeGate(policy, args, project);
    case 'edit':
      // ★ 三种模式一样。它改的是已有内容。
      return editGate(args, project);
    case 'run':
      return policy === 'bold' ? NO_GATE : runGate(args);
    default:
      // 没登记的工具：花钱或写盘就问一句。宁可多问，也不要有一条没人想过的路。
      return policy === 'bold' ? NO_GATE : { confirm: true, message: `Agent 要执行 ${tool.name}。`, proceed: '执行' };
  }
}

// ---------------------------------------------------------------- 各工具的文案

function generateGate(args: Record<string, unknown>, project?: NovelProject): Gate {
  const target = str(args.target);
  return {
    confirm: true,
    message: `Agent 要为「${nameOf(target, project)}」调一次创作模型`,
    detail: [target, str(args.ask) && `要求：${clip(str(args.ask))}`, '这一步会花钱。产出仍然要你点采纳才落盘。']
      .filter(Boolean)
      .join('\n'),
    proceed: '生成',
  };
}

function writeGate(policy: AgentPolicy, args: Record<string, unknown>, project?: NovelProject): Gate {
  const mode = str(args.mode) || 'create';
  // 覆盖：交给网关的覆盖审阅，三种模式一样，这里不再问一遍。
  if (mode === 'overwrite') {
    return NO_GATE;
  }
  if (policy === 'bold') {
    return NO_GATE;
  }
  const target = str(args.path);
  return {
    confirm: true,
    message: `Agent 要写入「${nameOf(target, project)}」`,
    detail: `${target}（${mode === 'append' ? '追加到末尾' : '新建'}）`,
    proceed: '写入',
  };
}

function editGate(args: Record<string, unknown>, project?: NovelProject): Gate {
  const target = str(args.path);
  return {
    confirm: true,
    message: `Agent 要改「${nameOf(target, project)}」里的一段文字`,
    // old → new 两段原文就是这一次编辑的 diff。不写出来，作者只能凭工具名点确定。
    detail: [
      target,
      `原文：${clip(str(args.old))}`,
      `改成：${clip(str(args.new)) || '（删掉）'}`,
      args.all === true ? '文件里所有出现的地方都改。' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    proceed: '替换',
  };
}

function runGate(args: Record<string, unknown>): Gate {
  const action = str(args.action);
  const target = str(args.path) || str(args.name);
  return {
    confirm: true,
    message: `Agent 要执行工程动作 ${action}`,
    detail: [
      target,
      '要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。',
    ]
      .filter(Boolean)
      .join('\n'),
    proceed: '执行',
  };
}

/**
 * 作者拒绝之后回给模型的那句话。
 *
 * **必须有信息量**：只回一句「被拒绝」，它多半会把同一个动作再发一遍——
 * 每一次都是一整轮上下文的钱（第 4 条）。
 */
export function declinedText(verdict: 'skip' | 'stop', gate: Gate): string {
  const what = gate.message ?? '这一步';
  return verdict === 'skip'
    ? `作者跳过了这一步（${what}），它没有执行，磁盘上什么都没变。` +
        '**不要重试同一个动作**——换个做法，或者问问他想怎么做。'
    : `作者选择停止（${what}）。不要再发起新的动作，把已经做到哪、还差什么说清楚就行。`;
}

// ---------------------------------------------------------------- 小工具

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 路径 → 人话名字。`describeForReview` 是覆盖审阅框用的那一份，共用它，
 * 两个框上的说法就不会分叉。拿不到 project（纯单测）时退回路径本身。
 */
function nameOf(rel: string, project?: NovelProject): string {
  if (!rel) {
    return '（没给路径）';
  }
  return project ? describeForReview(kindOfPath(project, rel), rel) : rel;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
}
