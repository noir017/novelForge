/**
 * 调模型之前的那一问（第 4 条的确认框）：按钮之外，让作者为**这一次**挑模型与上下文详细度
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * 每个调模型之前的确认框都经这里问，于是两个下拉框的选项、缺省与「按分档时每项活交给谁」只拼一处。
 * 问完的活由调用方跑在 `withCallChoice(answer.choice, …)` 里（runtime/callScope.ts）——**确认框之前读的
 * `config` 不能带进去**，作者的选择在那之后才有。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CallAnswer, CallChoice, describeCallChoice } from '../model/callChoice';
import { listModelChoices } from '../model/providers';
import { describeTaskModels, LlmTask } from '../model/tiers';
import { scoped } from '../runtime/logger';

const log = scoped('确认框');

export interface CallAsk {
  message: string;
  actions: string[];
  /** 补充说明：调几次、跳过哪些、会改什么。这活交给哪个模型不必写——下拉框下面列着。 */
  detail?: string;
  /** 这一次会用到的任务：「按分档」下面逐项列它们各交给谁。 */
  tasks: LlmTask[];
  /** 这一次的上下文看不看详细度。不看就不给作者那个下拉框——调了也白调。 */
  contextDetail: boolean;
  /**
   * 打开时的缺省。缺席取当前这一次（嵌套的那一问跟着外面那一次），再缺席取设置。
   * 工程页表单已经问过、后端还要再问一次时（批量写章补建角色卡）传表单上的选择。
   */
  preset?: CallChoice;
}

export async function askCall(ask: CallAsk): Promise<CallAnswer | undefined> {
  const host = getHost();
  const config = readConfig();
  // 「按分档」那几行说的是不钉模型时谁干活：外面那一次钉了模型也照分档说。
  const tiered = { ...config, pinnedModel: undefined };
  // 转写不跟这一次挑的模型走（model/tiers.ts），单列一行、一直显示。
  const tasks = [...new Set(ask.tasks)];
  const fixed = tasks.filter((task) => task === 'transcribe').map((task) => `${describeTaskModels(tiered, task)}（不跟这一次挑的模型）`);
  const answer = await host.confirmCall(ask.message, ask.actions, {
    detail: ask.detail,
    call: {
      models: listModelChoices(config.providers, host.supportsVscodeLm).map(({ ref, label, group }) => ({ ref, label, group })),
      model: ask.preset ? (ask.preset.model ?? '') : (config.pinnedModel ?? ''),
      tiers: tasks.filter((task) => task !== 'transcribe').map((task) => describeTaskModels(tiered, task)),
      ...(fixed.length > 0 ? { fixed } : {}),
      ...(ask.contextDetail ? { contextDetail: ask.preset?.contextDetail ?? config.contextDetail } : {}),
    },
  });
  if (answer) {
    log.info(`${answer.action}：${describeCallChoice(answer.choice)}`);
  }
  return answer;
}
