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
 * 3. **不传 provider**，走缺省（`config.active`，对话页选定的那个模型）。
 *    AGENTS 第 12 条：正文层中途换人会让文风断掉。非正文层将来可以走分档池，
 *    但那是四期的事，这一期全部走缺省。
 * 4. **流式内容照旧推给前端**：作者看得见 agent 在写什么，而不是盯着一个
 *    「正在生成」转十几秒（第 11 条：不闷着干活）。
 * 5. **`costly: true`**，每次调用记进 budget（第 4 条：不偷偷烧 token）。
 *
 * ## 层与目标从路径反推
 *
 * `kindOfPath` 一次给出 `stage` 与 `target`，不必让模型填 `{kind, chapterNo,
 * sceneNo}` 那种嵌套结构——路径是产物在这个工程里的身份，作者在文件管理器里
 * 看到的就是它。
 */
import { ToolContext, ToolDef, ToolResult, int, objectSchema, str } from '../registry';
import { generate } from '../../generation/generate';
import { kindOfPath } from '../../workspace';
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  Capability,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  isCapability,
  isValidAction,
} from '../../model/pipeline';

export const generateTool: ToolDef = {
  name: 'generate',
  costly: true,

  description:
    '调用创作模型，为某一份产物生成内容。target 是那份产物的工程内相对路径，' +
    '层由路径决定：.novelforge/plots/ 下是剧情层，.novelforge/scenes/<细纲名>/ 下是细节层，' +
    '.novelforge/manuscripts/ 与已发布的章是正文层，.novelforge/outline.md 是大纲层。' +
    '各层可用的 capability 不同：' +
    Object.entries(STAGE_CAPABILITIES)
      .map(([stage, caps]) => `${stage}=${caps.join('/')}`)
      .join('；') +
    '。' +
    '**返回的只有形状与 draftId，没有正文**——正文会直接流给作者看；' +
    '你要看内容就等作者采纳后再 read。' +
    '产物不会自动写盘：作者点了采纳卡片才落盘。' +
    '这个工具会真的调模型花钱，每次调用都记在预算里，不要重复生成同一份东西。',

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
          '剧情层给 .novelforge/plots/<章号>-<标题>.md，' +
          '细节层给 .novelforge/scenes/<细纲文件名去掉扩展名>/<场号>-<标题>.md，' +
          '正文层给 .novelforge/manuscripts/<章号>-<标题>.md，大纲给 .novelforge/outline.md。' +
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

    ctx.budget.calls += 1;
    let failure: string | undefined;

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
      { signal: ctx.signal }
    );

    if (!draft) {
      return { text: '', error: failure ?? '这次生成没有产出内容。' };
    }
    ctx.drafts.put(draft, ctx.sessionId);

    const what = `${STAGE_LABEL[path.stage]}·${CAPABILITY_LABEL[action.capability]}`;
    const shape = draft.summary ?? `${draft.words} 字`;
    ctx.report(`已生成 ${what}：${shape}（已用 ${ctx.budget.calls}/${ctx.budget.limits.calls} 次生成）`);

    return {
      // 只有形状与 id。**这里出现正文就是 bug。**
      text:
        `已生成：${what} · ${shape}，${draft.words} 字\n` +
        `draftId: ${draft.id}\n` +
        `落点：${rel}\n` +
        `内容已经流给作者看了，没有写进磁盘——要落盘得由作者点采纳卡片。` +
        `你不需要复述它的内容。`,
      display: { title: `generate ${what}`, detail: `${shape} · ${draft.words} 字` },
    };
  },
};

function describeCapabilities(): string {
  return CAPABILITIES.map((c) => `${c}=${CAPABILITY_LABEL[c]}`).join('，');
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}
