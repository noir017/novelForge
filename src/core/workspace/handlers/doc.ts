/**
 * `doc` handler：纯文本 + frontmatter，**没有上游指纹**。
 *
 * 接 `outline` / `style` / `globalSummary` / `character` / `lore` 五种。
 *
 * 它们的共同点是**在指纹链的最上游或链外**：
 *
 * - `outline.md` 是整条链的源头（细纲记的 `upstreamHash` 就是它的 hash），
 *   它自己没有上游可记。
 * - `style.md` / 角色卡 / 设定条目根本不在生产链上——它们是横切的记忆与
 *   约束，被装配进 prompt，但不由某一层产物「生出来」。
 * - `summaries/global.md` 的上游是全部单章摘要，那是一次显式的重建动作
 *   （features/summarize.ts 的 `through` 水位线），不是 hash 传播。
 *
 * 所以这里只做一件事：把 `Artifact{kind:'outlineDoc'}` 渲染成大纲文件。
 * 其余四种没有对应的结构化产物，只走 `{text}` 那条路。
 */
import { Handler, HandlerCtx } from './types';

export const docHandler: Handler = {
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'outlineDoc') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    // 逐字沿用 features/creation.ts 的 acceptOutline：整篇替换，带一行 H1。
    return `# 全书大纲\n\n${artifact.text.trim()}\n`;
  },
};
