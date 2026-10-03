/**
 * 状态简报：**外部 agent 与界面说同一套话**（第 20 条）。
 *
 * ```
 * # 当前工程
 * 《青云志》· 已写 99 章 · 31.2 万字（计划 300 章）
 * 当前目标：第 100 章（.novelforge/plots/100.md）
 * 状态：待写细纲
 * 下一步（由状态机算出，不要另做判断）：写第 100 章细纲
 *   先把这一章要发生什么定下来：本章目的、关键事件、章末钩子。
 * 提醒：第 12、13 章的上游产物改过（⟳）
 * ```
 *
 * **判据一个都不在这里重新实现**：`buildPipelineIndex` 取数、`deriveStage` /
 * `deriveNextStep` / `deriveBookStage` 判断，与创作页主按钮吃的是同一份输出。
 * 两处各判各的，界面上就会出现「徽章说待写细纲，agent 让你写正文」——而那种分叉
 * 没有任何测试拦得住，只会让作者不再相信界面。
 *
 * MCP server 把它贴在工具结果末尾，变了才贴（[mcp/server.ts](../mcp/server.ts)）。
 */
import type { NovelProject } from '../model/project';
import { basename } from 'node:path';
import {
  CreationTarget,
  NextStepPlan,
  PLOT_STAGE_LABEL,
  chapterLabel,
  deriveBookNextStep,
  deriveBookStage,
  deriveNextStep,
  plotOfTarget,
} from '../model/pipeline';
import { parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { BookFacts } from '../model/pipeline';
import { buildBookFacts, buildPipelineIndex, buildPlotPipeline, factsOf } from './pipeline';
import type { PipelineIndex, PlotPipeline } from './pipeline';

/** 「⟳ 上游改过」最多点名几章，超了写「等 N 章」。 */
export const STALE_LIST_LIMIT = 5;

/**
 * 拼一份「现在这本书走到哪了」。**只取数，判断全在 `model/pipeline.ts`。**
 *
 * `target` 没指向某一章（作者还在架构或大纲那一层）时报全书那一层的下一步——
 * 与创作页主按钮在那两层显示的是同一句话。选中的那一章做完了也转去问全书，
 * 主按钮与这里于是一起落到下一个该写的章上（controller/chat.ts 的 `pushPipeline`
 * 是同一条路）。
 *
 * 代价是一次 `buildPipelineIndex`，与工程页刷新同一趟活。MCP 每次工具调用之后
 * 都现算一份：作者可能正在另一个窗口里改文件——照着一份旧快照往下走，比多读一次
 * 盘糟得多。
 */
export async function buildStateBrief(
  project: NovelProject,
  target?: CreationTarget
): Promise<string> {
  const index = await buildPipelineIndex(project);
  const { rows, chapters, manifest, config } = index;
  const facts = await buildBookFacts(project, index);

  const written = chapters.filter((c) => c.wordCount > 0);
  const words = written.reduce((sum, c) => sum + c.wordCount, 0);
  const lines: string[] = ['# 当前工程'];
  lines.push(
    `《${manifest.title || '未命名'}》· 已写 ${written.length} 章 · ${formatWords(words)}` +
      (config.totalChapters ? `（计划 ${config.totalChapters} 章）` : '')
  );

  const current = target ? await findPipeline(project, index, target) : undefined;
  if (current) {
    const where = current.plot.exists ? current.plot.relPath : current.chapter.relPath || current.plot.relPath;
    lines.push(`当前目标：${chapterLabel(current.no, current.title)}（${where}）`);
    lines.push(`状态：${PLOT_STAGE_LABEL[current.stage]}`);
    const next = deriveNextStep(current.stage, factsOf(current));
    lines.push(
      ...(next
        ? describeNext(next, '')
        : describeNext(bookStep(index, facts), '全书都写完了。需要改动的话作者会说。').map((l, i) =>
            i === 0 ? `这一章都做完了。${l}` : l
          ))
    );
  } else {
    lines.push(target?.kind === 'setting' || target?.kind === 'outline' ? `当前目标：${target.kind === 'setting' ? '故事架构' : '情节大纲'}` : '当前目标：还没选定某一章');
    lines.push(...describeNext(bookStep(index, facts), '全书都写完了。需要改动的话作者会说。'));
  }

  const stale = rows.filter((p) => p.plot.upstreamStale || p.chapter.upstreamStale);
  if (stale.length > 0) {
    const named = stale.slice(0, STALE_LIST_LIMIT).map((p) => `第 ${p.no} 章`).join('、');
    const rest = stale.length > STALE_LIST_LIMIT ? `等 ${stale.length} 章` : '';
    lines.push(`提醒：${named}${rest}的上游产物改过，现有内容可能已经对不上（⟳）`);
  }
  return lines.join('\n');
}

/**
 * 全书级的下一步：架构 / 大纲 / 拆细纲三档由纯函数直接给；「在写」那一档转去问
 * 下一个该写的章。与 controller/chat.ts 的 `bookNextStep` 同一条判据。
 */
function bookStep(index: PipelineIndex, facts: BookFacts): NextStepPlan | undefined {
  const stage = deriveBookStage(facts);
  const step = deriveBookNextStep(stage, facts);
  if (step || stage !== 'writing') {
    return step;
  }
  const chapter = index.byNo.get(facts.nextChapterNo);
  return chapter ? deriveNextStep(chapter.stage, factsOf(chapter)) : undefined;
}

/**
 * 「下一步」那两行。**label 与 hint 逐字来自状态机**，不在这里改写措辞——
 * 界面上的主按钮写着「写第 12 章」，agent 却说「去扩写第 12 章」，作者会以为
 * 它们是两件事。
 *
 * 状态机不给下一步时**照实说**（第 20 条：做完了就不给下一步）。造一个假的
 * 出来，agent 会自作主张挑一章开始烧钱。
 */
function describeNext(next: { label: string; hint: string } | undefined, done: string): string[] {
  if (!next) {
    return [`下一步：${done}`];
  }
  return [`下一步（由状态机算出，不要另做判断）：${next.label}`, `  ${next.hint}`];
}

/**
 * target → 那一章的流水线。**按章号认**（细纲号 = 章号），与 `selectPlot` 同一条判据：
 * target 里记的可能是一份还不存在的细纲（点了「拆细纲 / 写第 N 章细纲」之后会话里的
 * 就是这种），也可能是章节路径。
 *
 * 索引里只有「有细纲或正文文件」的章号。**不在索引里的章也要给一份空壳**——与
 * `buildPlotPipelineView` 同一条路：否则作者刚点了主按钮、会话落在第 2 章那份还不存在的
 * 细纲上，界面说「写第 2 章细纲」，agent 这里却说「还没选定某一章」（第 20 条）。
 */
async function findPipeline(
  project: NovelProject,
  index: PipelineIndex,
  target: CreationTarget
): Promise<PlotPipeline | undefined> {
  const rel = plotOfTarget(target);
  if (!rel) {
    return undefined;
  }
  const no = parsePlotFileName(basename(rel))?.no ?? parseChapterFileName(basename(rel))?.order;
  if (no === undefined) {
    return undefined;
  }
  return (
    index.byNo.get(no) ??
    buildPlotPipeline(project, { no }, { outline: index.outline, config: index.config, chapters: index.chapters })
  );
}

function formatWords(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`;
}
