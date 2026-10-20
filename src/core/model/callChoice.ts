/**
 * 调模型之前那一问里的两个下拉框：作者为**这一次**挑模型与上下文详细度，不写回设置
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * 宿主怎么问见 `Host.confirmCall`，core 只经 `features/askCall.ts` 问；挑完的活跑在
 * `runtime/callScope.ts` 的 `withCallChoice` 里，`readConfig()` 在那里面读到的就是这一份。
 *
 * 纯数据 + 纯函数，只 import 同样零 import 的 `contextDetail.ts`：经 `media/src/protocol.ts` 打进浏览器产物，
 * 下拉框上的字与日志、VS Code 模态框里的那一行是同一份。
 */
import { CONTEXT_DETAIL_LABEL, ContextDetail, isContextDetail } from './contextDetail';

/** 作者为这一次挑的。缺席的那一项沿用外面那一次，再缺席沿用设置。 */
export interface CallChoice {
  /** 只用这一个模型（不换人）。缺席 = 按分档。 */
  model?: string;
  contextDetail?: ContextDetail;
}

/** 确认框上的两个下拉框：选项与打开时选着哪个。 */
export interface CallPrompt {
  /** 可选的模型，与对话页下拉框同一份（按服务商分组）。「按分档」不在这里，由界面放在第一项。 */
  models: { ref: string; label: string; group: string }[];
  /** 打开时选着的模型；`''` = 按分档。 */
  model: string;
  /** 按分档时这几项活各交给谁（`describeTaskModels`），一行一项。选了具体模型就不必看。 */
  tiers: string[];
  /** 打开时的级别。缺席 = 这一次的上下文不看详细度，不显示那个下拉框。 */
  contextDetail?: ContextDetail;
}

/** 确认框的回答：点的哪颗按钮，加上作者的选择。 */
export interface CallAnswer {
  action: string;
  choice: CallChoice;
}

/** 模型下拉框的第一项：不指定模型，各项活按任务档位走。 */
export const TIERED_LABEL = '按分档';

/** 「只用 openrouter/x · 上下文详细度「精简」」：日志与 VS Code 模态框里那一行。 */
export function describeCallChoice(choice: CallChoice): string {
  const model = choice.model ? `只用 ${choice.model}（失败不换人）` : TIERED_LABEL;
  return choice.contextDetail ? `${model} · 上下文详细度「${CONTEXT_DETAIL_LABEL[choice.contextDetail]}」` : model;
}

/**
 * 前端交上来的选择（工程页表单的 `projectAction.call`、网页弹窗的 `promptResult.choice`）的容错读取：
 * 不是对象 = 没有（表单没问过）；认不出的那一项丢掉，沿用设置。
 */
export function normalizeCallChoice(raw: unknown): CallChoice | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { model, contextDetail } = raw as Record<string, unknown>;
  return {
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(isContextDetail(contextDetail) ? { contextDetail } : {}),
  };
}
