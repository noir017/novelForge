/**
 * `manuscript` handler：中转站里的正文。
 *
 * **落在 `manuscripts/`，不是 `chapters/`。** 那里是作者切好的发布章节；
 * 正文先落在中转站，什么时候切、怎么切由他自己定（第 23 条）。
 *
 * 三件事：
 *
 * 1. **渲染**：`Artifact{kind:'manuscript'}` → 就是那段正文。首次写入时
 *    补 frontmatter 与 `# 第N章… · 正文` 标题行。
 * 2. **追加是默认**：正文按场景分几次写，顺序拼起来才是完整的一章。
 *    两次追加之间插一行 `---`——那是**默认的拆分候选点**，场景边界正是
 *    最可能的章节边界；给一个能改的默认，比让作者从头自己标要好。
 * 3. **记账**：`beatsHash = await project.beatsHashFor(plotRelPath)`。
 *    少了这一步，这一章会永远显示「正文与场景对不上」或永远不显示。
 *
 * ## `contentHash` 只哈希正文本身（第 18b 条）
 *
 * 不含 frontmatter 与标题行——写一次 `beatsHash` 不该让摘要立刻过期。
 * 那个哈希在 `project.readManuscript` 里算，这里只负责别去污染正文。
 */
import * as fs from 'node:fs/promises';
import { rewriteFrontmatter, stringifyFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import { Handler, HandlerCtx } from './types';

export const manuscriptHandler: Handler = {
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'manuscript') {
      throw new Error(`「${ctx.rel}」不接 ${artifact.kind} 产物`);
    }
    return artifact.text;
  },

  /**
   * 记账：把这一章当前的场景指纹落进正文的 frontmatter。
   *
   * `rewriteFrontmatter` 只改 `---` 之间那一段，**正文一个字节不动**。
   * 没有 frontmatter 就是作者自己贴进来的正文——**不给它补一个**，
   * 从没记录过 `beatsHash` 的正文永不标脏（第 18a 条）。
   */
  async after(ctx: HandlerCtx, text: string) {
    const plotRelPath = ctx.path.plotRelPath;
    if (!plotRelPath) {
      return [];
    }
    const beatsHash = await ctx.project.beatsHashFor(plotRelPath);
    if (!beatsHash) {
      return [];
    }
    const next = rewriteFrontmatter(text, { beatsHash });
    if (next === undefined || next === text) {
      return [];
    }
    await fs.writeFile(ctx.project.pathOf(ctx.rel), next, 'utf8');
    return [`记下场景指纹 ${beatsHash}`];
  },
};

/** 首次写入时的 frontmatter + 标题行。第二次之后走追加，不再重复。 */
export async function manuscriptHead(
  project: NovelProject,
  plotRelPath: string
): Promise<string> {
  const plot = await project.readPlot(plotRelPath);
  const fm = stringifyFrontmatter({ plot: plotRelPath, generatedBy: 'novel-forge' });
  const heading = `# 第${plot?.no ?? 0}章${plot?.title ? ` ${plot.title}` : ''} · 正文`;
  return `${fm}\n\n${heading}\n\n`;
}
