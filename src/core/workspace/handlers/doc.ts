/**
 * `doc` handler：纯文本 + frontmatter，**没有上游指纹**。
 *
 * 接 `outline` / `style` / `globalSummary` / `threads` / `character` / `lore` 六种。
 *
 * 它们的共同点是**在指纹链的最上游或链外**：
 *
 * - `outline.md` 是细纲的上游（细纲记的 `upstreamHash` 是它覆盖本章那一节的
 *   hash）。它自己的上游是架构，那一环留到二期再接。
 * - `style.md` / 角色卡 / 设定条目根本不在生产链上——它们是横切的记忆与
 *   约束，被装配进 prompt，但不由某一层产物「生出来」。
 * - `summaries/global.md` 的上游是全部单章摘要，那是一次显式的重建动作
 *   （features/summarize.ts 的 `through` 水位线），不是 hash 传播。
 * - `threads.md`（叙事线，七期）由工程页「排叙事线」与定稿追加，是跨章的计划与记录，
 *   同样不在链上。
 *
 * 所以这里只做一件事：把 `Artifact{kind:'outlineDoc'}` 渲染成大纲文件。
 * 其余五种没有对应的结构化产物，只走 `{text}` 那条路。
 */
import { Handler, HandlerCtx } from './types';

export const docHandler: Handler = {
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'outlineDoc') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    // 整篇替换，带一行 H1。按区间续写时只替换重叠的那几节——那一步在 accept 里先合并好
    // （`mergeOutline`），到这里的已经是合并后的全文。
    return `# 情节大纲\n\n${artifact.text.trim()}\n`;
  },
};
