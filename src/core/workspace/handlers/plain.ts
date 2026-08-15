/**
 * `plain` handler：纯文本进出，无记账。
 *
 * 接 `other`（工程里的普通文本）与 `draft`（草稿）。
 *
 * 草稿在这里而不在 `doc` 里，是因为它**永不自动进上下文**（AGENTS 第 10 条）：
 * `context/builder.ts` 里没有任何一处读 `drafts/`，草稿只能经作者显式 `@`
 * 引用进 prompt。给它加任何 frontmatter 记账都是往那条约束上开口子。
 */
import { Handler, HandlerCtx } from './types';

export const plainHandler: Handler = {
  async render(_ctx: HandlerCtx, artifact) {
    // 纯文本区没有结构化产物可渲染——落到这里说明调用方把 artifact 写错了地方。
    throw new Error(`这个路径不接结构化产物（${artifact.kind}）`);
  },
};
