/**
 * 把中转站里的一章正文拆成发布章节。
 *
 * ## 这一步在整条流水线里的位置
 *
 * 正文写出来先落在 `.novelforge/manuscripts/`，**那是中转站，不是成品**。
 * 之所以要这一道闸，是因为生成与发布的诉求相反：
 *
 * - 生成时不该被「一章要有头有尾」框住——那会让每一章都在强行收束，
 *   而长篇小说的剧情本来就是连续的（见 model/plotFile.ts 的文件头）。
 * - 发布时必须按章——读者按章追，作者按章发。
 *
 * 所以模型按剧情的自然长度写，作者读一遍、在想断的地方插一行 `---`，
 * 点「拆成章节」。拆完中转站那份就删掉，此后一切按 `chapters/` 管理。
 *
 * ## 为什么在 features/ 而不在 project.ts
 *
 * 落盘那几行确实简单（`project.splitManuscript`），但这条路要弹确认框、
 * 要在拆成多章时**把后面待写的章号整体顺延**，还要在中途失败时说清做到哪了。
 * 那些都是编排，不是数据访问。
 */
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { chapterLabel } from '../model/pipeline';
import { splitByMark } from '../model/chapterFile';
import { scoped } from '../runtime/logger';

const log = scoped('拆分');

/**
 * 把某一章的中转站正文按 `---` 拆成发布章节。
 *
 * 返回建好的章节相对路径；用户取消或无事可做时返回空数组。
 */
export async function splitManuscript(project: NovelProject, plotRelPath: string): Promise<string[]> {
  const plot = await project.readPlot(plotRelPath);
  if (!plot) {
    getHost().toast('找不到这一章的细纲，可能刚被改名或删除。', 'error');
    return [];
  }
  const manuscript = await project.readManuscript(plotRelPath);
  if (!manuscript?.text.trim()) {
    log.warn(`第 ${plot.no} 章还没有正文，无从拆分`);
    getHost().toast(`第 ${plot.no} 章还没有正文。`, 'error');
    return [];
  }

  const pieces = splitByMark(manuscript.text);
  if (pieces.length === 0) {
    // 整篇只有标记行。真发生了就是作者手抖，说清楚比默默不动好。
    log.warn(`第 ${plot.no} 章的正文只有分隔线，没有内容`, manuscript.relPath);
    getHost().toast('这一章的正文里只有分隔线，没有可拆的内容。', 'error');
    return [];
  }

  // 后面那些**已经规划、还没拆分**的章要整体让路。已经拆过的（chapters/ 里
  // 有文件的）不在此列——那是成品，动它等于改作者已经发出去的东西。
  const shift = pieces.length - 1;
  const following = shift > 0 ? await followingPlots(project, plot.no) : [];

  if (!(await confirmSplit(plot, pieces, following, shift))) {
    log.info(`用户取消了第 ${plot.no} 章的拆分`);
    return [];
  }

  // **先移号、再落盘。** 反过来的话，落盘之后重编号失败会留下
  // 「章节已经建好、后面的细纲还撞着号」的中间态，作者得自己收拾；
  // 先移号失败则什么都没变，重来一次即可。
  //
  // 从大到小遍历：从小到大改会撞上还没让开的那一份。
  for (const p of [...following].sort((a, b) => b.no - a.no)) {
    // 换号时新号上没有旧文件，必须把原路径传进去——`writePlot` 据此把
    // 场景目录与中转站正文一起改名（carryPlotCompanions），并删掉旧的那份。
    await project.writePlot({ ...p, no: p.no + shift }, p.relPath);
  }
  if (following.length > 0) {
    log.info(
      `${following.length} 章的规划已顺延 ${shift} 位`,
      following.map((p) => `第 ${p.no} 章 → 第 ${p.no + shift} 章`).join('；')
    );
  }

  // 第一片沿用原标题，其余留空（落成 `101.md`，界面显示「第 101 章」）。
  // **不调模型拟标题**：那要么多花一次调用，要么在拆分这个纯机械的动作里
  // 插进一次可能失败的网络请求。作者右键重命名一下就好。
  const titles = pieces.map((_, i) => (i === 0 ? plot.title : ''));
  const created = await project.splitManuscript(plotRelPath, titles);

  log.info(`第 ${plot.no} 章已拆成 ${created.length} 章`, created.join('、'));
  getHost().toast(
    created.length === 1
      ? `已发布为 ${created[0]}。`
      : `已拆成 ${created.length} 章：${created.join('、')}。`
  );
  return created;
}

/**
 * 号在这一章之后、且**还没拆分**的章。
 *
 * 判据是「`chapters/` 里没有同号文件」：拆过的是成品，不该因为前面插进
 * 几章就被改名——那会打乱作者已经发布的顺序。
 */
async function followingPlots(project: NovelProject, no: number): Promise<Plot[]> {
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);
  const published = new Set(chapters.map((c) => c.order));
  return plots.filter((p) => p.no > no && !published.has(p.no)).sort((a, b) => a.no - b.no);
}

/**
 * 拆分前的确认框。
 *
 * 一片时不弹：那等于「把这一章发布出去」，没有可商量的取舍，
 * 也不会动到任何别的东西。多片时必须弹——它会新建文件、删掉原件，
 * 还可能把后面几十章的号整体挪动。
 */
async function confirmSplit(
  plot: Plot,
  pieces: string[],
  following: Plot[],
  shift: number
): Promise<boolean> {
  if (pieces.length === 1) {
    return true;
  }
  const range = pieces.map((_, i) => `第 ${plot.no + i} 章`).join('、');
  const detail = [
    `${pieces.map((p, i) => `第 ${plot.no + i} 章：${p.length} 字`).join('\n')}`,
    '',
    `第一章沿用原标题《${plot.title || '未命名'}》，其余留空，可在工程页重命名。`,
    following.length > 0
      ? `另有 ${following.length} 章已规划但还没拆分，章号会顺延 ${shift} 位` +
        `（第 ${following[0].no} 章 → 第 ${following[0].no + shift} 章，依此类推），` +
        '它们的场景与草稿正文会跟着一起改名。'
      : '后面没有已规划的章，不涉及重新编号。',
  ].join('\n');

  const answer = await getHost().confirm(
    `把${chapterLabel(plot.no, plot.title)}拆成 ${pieces.length} 章（${range}）？`,
    ['拆分'],
    { modal: true, detail }
  );
  return answer === '拆分';
}
