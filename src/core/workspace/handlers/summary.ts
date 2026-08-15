/**
 * `summary` handler：单章摘要。
 *
 * 上游是**成品**（`chapters/`），不是中转站——摘要描述的是已经发布的那一章
 * （第 18 条的最后一环）。所以 `sourceHash` 记的是章节的 `contentHash`。
 *
 * 记账在 `Workspace.writeSummary` 那条领域路径上做（它手里才有 `Chapter`，
 * 也才知道该记哪个 hash）；这个 handler 只负责**写完之后同步 manifest**——
 * 「这一章已总结」是个中央索引，摘要文件自己的 frontmatter 是真相，
 * manifest 只是加速用的缓存（`staleChapters` 以磁盘上那份为准）。
 *
 * 摘要落盘仍是 Markdown 而不是结构化数据（第 14 条：作者要手改），
 * 结构化的出场人物写进 frontmatter 的 `cast`。
 */
import { Handler, HandlerCtx } from './types';

export const summaryHandler: Handler = {
  async after(ctx: HandlerCtx) {
    // 摘要文件本身是真相；manifest 那份只是缓存，刷一下让工程页的
    // 「已总结 n/N」跟得上。刷不动也不该让写摘要这件事失败。
    await ctx.project.syncManifest().catch(() => undefined);
    return [];
  },
};
