import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallChoice } from '../model/callChoice';

/**
 * 「这一次」：作者在调模型之前的确认框上挑的模型与上下文详细度（`model/callChoice.ts`）。
 *
 * 挑完的活跑在 {@link withCallChoice} 里，**`readConfig()` 是唯一读它的地方**：详细度换掉
 * `contextDetail`，模型成了 `pinnedModel`（`refsForTask` 只给它）。不一路当参数递：确认框之后读
 * 配置的地方散在十几个函数里，漏掉一处就是弹窗上写着「精简」、实际按「详细」装。
 *
 * 用 `AsyncLocalStorage.run`：同时在跑的别的任务各在各的上下文里，互不串（独立版的
 * `shells/standalone/scopedHost.ts` 按窗口转发 Host 用的是同一个东西）。
 */
const scope = new AsyncLocalStorage<CallChoice>();

/**
 * 在作者的选择下跑 `fn`。嵌套时里面那一次的选择优先；模型那一项**整项替换**——里面选了
 * 「按分档」就是不钉模型，哪怕外面钉了。详细度里面没问（`undefined`）就沿用外面那一次。
 */
export function withCallChoice<T>(choice: CallChoice, fn: () => Promise<T>): Promise<T> {
  const outer = scope.getStore();
  const contextDetail = choice.contextDetail ?? outer?.contextDetail;
  return scope.run(
    {
      ...(choice.model ? { model: choice.model } : {}),
      ...(contextDetail ? { contextDetail } : {}),
    },
    fn
  );
}

/** 当前这一次的选择；不在任何确认框之后（对话页、启动期）是 undefined。 */
export function currentCallChoice(): CallChoice | undefined {
  return scope.getStore();
}
