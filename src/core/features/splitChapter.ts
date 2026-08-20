/**
 * 把中转站里一个剧情段的正文拆成发布章节。
 *
 * ## 这一步在整条流水线里的位置
 *
 * 正文写出来先落在 `.novelforge/manuscripts/`，**那是中转站，不是成品**。
 * 之所以要这一道闸，是因为生成与发布的诉求相反：
 *
 * - 生成时不该被「一章要有头有尾」框住——那会让每一段都在强行收束，
 *   而长篇小说的剧情本来就是连续的（见 model/plotFile.ts 的文件头）。
 * - 发布时必须按章——读者按章追，作者按章发。
 *
 * 所以模型按剧情的自然长度写，作者读一遍、在想断的地方插一行 `---`，
 * 点「拆成章节」。拆完中转站那份就删掉，落点记进这一段的 frontmatter，
 * 此后那些文字按 `chapters/` 管理。
 *
 * ## 不再顺延后面的段号
 *
 * 从前一段拆成三章时，号在它之后、还没拆的每一份细纲都要**整体改名 +2**，
 * 连带搬走各自的场景目录与中转站正文——一次几十份文件的重命名风暴，只为
 * 维持「细纲与章同号」那条不变量。那条不变量现在没了：段号只是 `plots/` 里的
 * 排序键，章号自己连续（`nextChapterNo`），界面上的「剧情 N」是推导出来的位次
 * （`segmentDisplayNo`）。所以这里只拆，不动任何别的文件。
 *
 * ## 为什么在 features/ 而不在 project.ts
 *
 * 落盘那几行确实简单（`Workspace.splitManuscript`），但这条路要弹确认框、
 * 要在中途失败时说清做到哪了。那些是编排，不是数据访问。
 */
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { splitByMark } from '../model/chapterFile';
import { scoped } from '../runtime/logger';
import { Workspace } from '../workspace';

const log = scoped('拆分');

/**
 * 把某一章的中转站正文按 `---` 拆成发布章节。
 *
 * 返回建好的章节相对路径；用户取消或无事可做时返回空数组。
 */
export async function splitManuscript(project: NovelProject, plotRelPath: string): Promise<string[]> {
  const plot = await project.readPlot(plotRelPath);
  if (!plot) {
    getHost().toast('找不到这个剧情段的细纲，可能刚被改名或删除。', 'error');
    return [];
  }
  const manuscript = await project.readManuscript(plotRelPath);
  if (!manuscript?.text.trim()) {
    log.warn(`剧情段 ${plot.no} 还没有正文，无从拆分`, plotRelPath);
    getHost().toast('这个剧情段还没有正文。', 'error');
    return [];
  }

  const pieces = splitByMark(manuscript.text);
  if (pieces.length === 0) {
    // 整篇只有标记行。真发生了就是作者手抖，说清楚比默默不动好。
    log.warn(`剧情段 ${plot.no} 的正文只有分隔线，没有内容`, manuscript.relPath);
    getHost().toast('这一段的正文里只有分隔线，没有可拆的内容。', 'error');
    return [];
  }

  // 章号接在现有最后一章之后。**不动任何别的文件**：段号与章号是两条轴，
  // 后面那些还没拆的段不需要让路（见文件头）。
  const startNo = await project.nextChapterNo();

  if (!(await confirmSplit(plot, pieces, startNo))) {
    log.info(`用户取消了剧情段 ${plot.no} 的拆分`);
    return [];
  }

  // 第一片沿用原标题，其余留空（落成 `101.md`，界面显示「第 101 章」）。
  // **不调模型拟标题**：那要么多花一次调用，要么在拆分这个纯机械的动作里
  // 插进一次可能失败的网络请求。作者右键重命名一下就好。
  const titles = pieces.map((_, i) => (i === 0 ? plot.title : ''));
  const created = await new Workspace(project).splitManuscript(plotRelPath, titles);

  log.info(`剧情段 ${plot.no} 已拆成 ${created.length} 章`, created.join('、'));
  getHost().toast(
    created.length === 1
      ? `已发布为 ${created[0]}。`
      : `已拆成 ${created.length} 章：${created.join('、')}。`
  );
  return created;
}

/**
 * 拆分前的确认框。
 *
 * 一片时不弹：那等于「把这一段发布出去」，没有可商量的取舍。多片时必须弹——
 * 它会新建几个文件并删掉原件，而作者对「断在哪」是有意见的。
 *
 * 从前这个框里还要说明「后面几十章的号会顺延」；那一步没有了，框也就短了一半。
 */
async function confirmSplit(plot: Plot, pieces: string[], startNo: number): Promise<boolean> {
  if (pieces.length === 1) {
    return true;
  }
  const range = pieces.map((_, i) => `第 ${startNo + i} 章`).join('、');
  const detail = [
    `${pieces.map((p, i) => `第 ${startNo + i} 章：${p.length} 字`).join('\n')}`,
    '',
    `第一章沿用原标题《${plot.title || '未命名'}》，其余留空，可在工程页重命名。`,
    '后面还没拆的剧情段不受影响，一个文件都不会改名。',
  ].join('\n');

  const answer = await getHost().confirm(
    `把这一段拆成 ${pieces.length} 章（${range}）？`,
    ['拆分'],
    { modal: true, detail }
  );
  return answer === '拆分';
}
