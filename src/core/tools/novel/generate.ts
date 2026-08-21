/**
 * `generate` —— 「agent 只做上层调度，实际生成通过工具调用」的落点。
 *
 * ## 五件必须做对的事
 *
 * 1. **产物绝不回灌 agent 上下文**。返回文本里只有形状与 draftId，**没有
 *    正文**。一份三千字的正文塞回循环，agent 每走一步就重烧一遍——十步之后
 *    这一份正文被算了十次钱。要看内容让它显式 `read`。
 * 2. **`history` 传空数组**。agent 的工具调用不是作者的讨论，混进装配器会被
 *    当成创作要求装进 prompt（「用户刚才说：list .novelforge/plots」）。唯一
 *    该带历史的能力是 `settle`——它要沉淀的就是一段讨论，而**这一期不支持它**。
 * 3. **哪一层用哪个模型**，AGENTS 第 12 条的延伸：
 *
 *    | 层 | 用哪个模型 | 为什么 |
 *    |---|---|---|
 *    | `manuscript` | **对话页选定的那个**，不走池 | 中途换人会让文风断掉 |
 *    | `outline` | 同上 | 一次定调，而且没有对应档位 |
 *    | `plot` | `plotOutline` 档 | 与工程页「批量写剧情」同一个模型 |
 *    | `scene` | `sceneBreakdown` 档 | 同上 |
 *
 *    走池时**必须把池的 `primaryBudget` 一起传下去**（第 13 条）：
 *    `config.contextWindow` 跟着对话页那个模型走，拿 200k 的窗口给快速档的
 *    32k 模型装配上下文会稳定超窗。
 * 4. **流式内容照旧推给前端**：作者看得见 agent 在写什么，而不是盯着一个
 *    「正在生成」转十几秒（第 11 条：不闷着干活）。
 * 5. **发请求之前先 `usage.record(1)`**（第 4 条：不偷偷烧 token）。记在前面是
 *    因为**请求发出去钱就花了**——中途抛异常、被取消，那一次照样收费。等函数
 *    返回再记，异常那条路上的钱就丢账了。**这里只报数，不判断触没触顶**：
 *    上限是调用方的事，工具连「上限是多少」都不知道。
 *
 * ## 层与目标从路径反推
 *
 * `kindOfPath` 一次给出 `stage` 与 `target`，不必让模型填 `{kind, chapterNo,
 * sceneNo}` 那种嵌套结构——路径是产物在这个工程里的身份，作者在文件管理器里
 * 看到的就是它。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { int, objectSchema, str } from '../schema';
import { clip, describePath, text } from './naming';
import { generate } from '../../generation/generate';
import { createModelPool } from '../../llm/pool';
import type { LlmProvider } from '../../llm/provider';
import { scoped } from '../../runtime/logger';
import type { LlmTask } from '../../model/tiers';
import { kindOfPath } from '../../workspace';
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  Capability,
  CreationStage,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  isCapability,
  isValidAction,
} from '../../model/pipeline';

const log = scoped('Agent');

/**
 * 哪一层走哪一档。**列在这里的才走池**——不在表里的（正文、大纲）严格用
 * 对话页选定的那个模型，不走池、不 fallback（第 12 条）。
 */
const TIER_TASK: Partial<Record<CreationStage, LlmTask>> = {
  plot: 'plotOutline',
  scene: 'sceneBreakdown',
};

export const generateTool: ToolDef = {
  name: 'generate',
  costly: true,

  /**
   * 花钱但不写盘 → `costly`。调用方据此决定问不问（谨慎模式问，平时不问）。
   *
   * 卡片上必须写清**会花钱**与**产出还会再问一次**：「Agent 想调用 generate，
   * 允许吗」作者答不上来，他不知道会写到哪、花多少。**这一问是「要不要花钱
   * 生成」，落盘是另一问**——产出之后当场还有一张卡（第 19 条）。
   */
  intent(args, project): ToolIntent {
    const target = text(args.target);
    return {
      gate: 'costly',
      title: `为「${describePath(target, project)}」调一次创作模型`,
      detail: [target, text(args.ask) && `要求：${clip(text(args.ask))}`, '这一步会花钱。产出之后还会再问你一次要不要落盘。']
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '调用创作模型，为某一份产物生成内容。target 是那份产物的工程内相对路径，' +
    '层由路径决定：.novelforge/plots/ 下是剧情层，.novelforge/scenes/<细纲名>/ 下是细节层，' +
    '.novelforge/manuscripts/ 与已发布的章是正文层，' +
    '.novelforge/outline.md 与 .novelforge/volumes/ 下的卷纲都算大纲层。' +
    '大纲层的 split 看给的是哪一份：给 outline.md 拆出**分卷清单**，' +
    '给某一卷的卷纲拆出**一个剧情段**（一次只拆一段，拆下一段就再调一次）。' +
    '各层可用的 capability 不同：' +
    Object.entries(STAGE_CAPABILITIES)
      .map(([stage, caps]) => `${stage}=${caps.join('/')}`)
      .join('；') +
    '。' +
    '**返回的只有形状与 draftId，没有正文**——正文会直接流给作者看；' +
    '你要看内容就等它落盘之后再 read。' +
    '产出之后会当场请作者点头，同意才落盘，结果写在返回里；不必也不要再用 write 写同一份。' +
    '这个工具会真的调模型花钱，每次调用都会记账，不要重复生成同一份东西。',

  parameters: objectSchema(
    {
      target: str('要生成的那份产物的工程内相对路径。'),
      capability: str(`要它干什么。${describeCapabilities()}`, CAPABILITIES),
      ask: str('补充要求，可留空。留空时按上一层的产物照常生成。'),
      targetWords: int('目标字数，只对正文层有意义。留空不限。'),
    },
    ['target', 'capability']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.target === 'string' ? args.target.trim() : '';
    const capability = args.capability;

    if (!isCapability(capability)) {
      return { text: '', error: `capability 只能是：${CAPABILITIES.join(' / ')}。` };
    }
    // `settle` 沉淀的是**一段已经发生过的讨论**，而 agent 手里没有那段讨论
    // （history 恒为空，见文件头第 2 条）。喂它一个空历史，它会凭空编一份
    // 「刚才讨论出的结论」——那比不支持更糟。
    if (capability === 'settle') {
      return {
        text: '',
        error:
          'settle 要沉淀的是作者与模型刚刚讨论出的结论，而你手上没有那段讨论。' +
          '请让作者在对话页手动执行「落定剧情」；要按你自己的思路排剧情用 capability=generate。',
      };
    }

    const path = kindOfPath(ctx.project, rel);
    if (!path.stage || !path.target) {
      return {
        text: '',
        error:
          `认不出「${rel}」是哪一层的产物。` +
          '剧情层给 .novelforge/plots/<卷词干>/<段号>-<标题>.md，' +
          '细节层给 .novelforge/scenes/<细纲在 plots/ 之下的整段路径去掉扩展名>/<场号>-<标题>.md，' +
          '正文层给 .novelforge/manuscripts/<同上>.md，' +
          '大纲给 .novelforge/outline.md，卷纲给 .novelforge/volumes/<卷号>-<卷名>.md。' +
          '可以先用 list 看看那个目录下实际有什么。',
      };
    }

    const action = { stage: path.stage, capability: capability as Capability };
    if (!isValidAction(action)) {
      return {
        text: '',
        error:
          `${STAGE_LABEL[path.stage]}层不支持 ${capability}。` +
          `这一层可用：${STAGE_CAPABILITIES[path.stage].join(' / ')}。`,
      };
    }

    // 记在发请求之前：请求发出去钱就花了，抛异常也一样。
    ctx.usage.record(1);
    let failure: string | undefined;
    const picked = await pickModel(path.stage);

    const { draft } = await generate(
      ctx.project,
      {
        action,
        target: path.target,
        targetNo: path.no,
        ask: typeof args.ask === 'string' ? args.ask : '',
        targetWords: toPositiveInt(args.targetWords),
        // 空数组，见文件头第 2 条。**不要改成 ctx 里的什么历史。**
        history: [],
      },
      {
        // 正文流给前端气泡，不进 agent 上下文。
        onDelta: (delta) => ctx.onDelta?.(delta),
        onDone: () => undefined,
        onError: (message) => {
          failure = message;
        },
        onCancelled: () => {
          failure = '生成被取消。';
        },
      },
      // provider 留空 = 用对话页选定的那个模型（第 12 条）。
      //
      // **不带 thinking**（第 26 条）：作者选的那一档是给「他自己在跟模型讨论
      // 这件事」的，而这里是 agent 在一轮里顺手产出一份产物——它可能一轮里调
      // 好几次，每次都按极限档想一遍，等于把那个下拉框变成一个倍率不明的开关。
      // 循环本身仍然按那一档想（`controller/agent.ts` 递给 runAgent）。
      { signal: ctx.signal, ...picked }
    );

    if (!draft) {
      return { text: '', error: failure ?? '这次生成没有产出内容。' };
    }
    ctx.drafts.put(draft, ctx.sessionId);

    const what = `${STAGE_LABEL[path.stage]}·${CAPABILITY_LABEL[action.capability]}`;
    const shape = draft.summary ?? `${draft.words} 字`;
    // 只说发生了什么。「已用 3/10 次生成」那半句是调用方的账，它才知道上限。
    ctx.report(`已生成 ${what}：${shape}`);

    return {
      draftIds: [draft.id],
      // 只有形状与 id。**这里出现正文就是 bug。**
      text:
        `已生成：${what} · ${shape}，${draft.words} 字\n` +
        `draftId: ${draft.id}\n` +
        `落点：${rel}\n` +
        `内容已经流给作者看了。要不要落盘正在问他，结论就在下面。` +
        `你不需要复述它的内容。`,
      display: { title: `generate ${what}`, detail: `${shape} · ${draft.words} 字` },
    };
  },
};

/**
 * 这一层该用哪个模型。
 *
 * 返回空对象 = 用对话页选定的那个（`generate` 的缺省）。这也是池建不出来时的
 * 退路：报一条 warn 然后照常跑，好过让 agent 在这里硬失败——作者已经在对话页
 * 选了一个能用的模型。
 *
 * **只取 `pool.primary`，不用 `pool.run` 的失败换人**：`generate` 是流式的，
 * 换一个模型重跑会把半份产物再冲一遍进作者的气泡。串行恒用该档首选本来就是
 * 池的行为，这里少的只有 fallback 那一半，而且**绝不跨档**。
 */
async function pickModel(
  stage: CreationStage
): Promise<{ provider?: LlmProvider; budget?: { contextWindow: number; maxOutputTokens: number } }> {
  const task = TIER_TASK[stage];
  if (!task) {
    return {};
  }
  const pool = await createModelPool({ task });
  if (!pool) {
    log.warn(`${STAGE_LABEL[stage]}层没有可用的分档模型，改用对话页选定的那个`);
    return {};
  }
  // 窗口必须跟着干活那个模型走（第 13 条）。
  return { provider: pool.primary, budget: pool.primaryBudget };
}

function describeCapabilities(): string {
  return CAPABILITIES.map((c) => `${c}=${CAPABILITY_LABEL[c]}`).join('，');
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}
