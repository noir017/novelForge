/**
 * 全书摘要的一次性读取。
 *
 * 摘要是**三条取数路径的共同原料**：流水线状态要它判新鲜度（[pipeline.ts](pipeline.ts)）、
 * 工程树要它标「已过期」（[projectView.ts](projectView.ts)）、出场索引要它的 `cast`
 * （[cast.ts](cast.ts)）。三处各自 `readSummary` 的话，一次工程页刷新就把每章的摘要
 * 读三遍——五百章工程即一千五百次多余的小文件读，而工程页每次保存都刷新。
 *
 * 于是把摘要提到与 `outline` / `manifest` 同一层：**读一次，摊给所有取数方**。
 * 这与 `buildPipelineIndex` 早就在做的事是同一个套路（那里摊的是大纲与 manifest），
 * 只是原料换成了摘要。
 *
 * 拿到索引的人只读不写：它是某一时刻的快照，磁盘变了要重新建一份，
 * 不做失效通知——工程页本来就是整棵树重推。
 */
import { NovelProject } from '../model/project';
import { Chapter, PlotSummary } from '../model/types';

/** 章节 relPath → 该章摘要（没总结过的章不在表里）。 */
export type SummaryIndex = Map<string, PlotSummary>;

/**
 * 读全书摘要。
 *
 * 章节列表由调用方传入：工程页那条路上它早就读过了，再读一遍等于把
 * `chapters/` 整个又扫一次。
 */
export async function buildSummaryIndex(
  project: NovelProject,
  chapters: Chapter[]
): Promise<SummaryIndex> {
  const out: SummaryIndex = new Map();
  for (const chapter of chapters) {
    const summary = await project.readSummary(chapter.relPath);
    if (summary) {
      out.set(chapter.relPath, summary);
    }
  }
  return out;
}

/**
 * 取某章摘要：有索引就查表，没有就读盘。
 *
 * 让「批量路径传索引、单章路径不传」两种调用共用一条取数逻辑，
 * 调用点不必各写一遍 `index ? index.get(...) : await read(...)`。
 */
export async function summaryOf(
  project: NovelProject,
  chapterRelPath: string,
  index?: SummaryIndex
): Promise<PlotSummary | undefined> {
  return index ? index.get(chapterRelPath) : project.readSummary(chapterRelPath);
}
