import * as path from 'node:path';
import { resolveSectionDir, validateName } from './files/fileOps';
import { getHost } from './host';
import { exists, pad3, sanitizeFileName } from './model/fs';
import { Plot, emptyPlotSections } from './model/plotFile';
import { isFallbackChapterTitle } from './model/pipeline';
import { NovelProject } from './model/project';
import { describeError, scoped } from './runtime/logger';
import { Workspace } from './workspace';

const log = scoped('工程');

/**
 * 工程级交互流程的宿主无关实现。
 * 插件命令面板与独立版网页共用这些流程，行为不分叉。
 */

/** 初始化工程：问作品名与作者。defaultTitle 由壳给定（插件用工作区名，独立版用目录名）。 */
export async function initProjectFlow(project: NovelProject, defaultTitle: string): Promise<boolean> {
  if (await project.isInitialized()) {
    getHost().toast('当前目录已经是小说工程。');
    return false;
  }
  const title = await getHost().input({
    title: '初始化小说工程（1/2）',
    prompt: '作品名',
    value: defaultTitle,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return false;
  }
  const author = await getHost().input({ title: '初始化小说工程（2/2）', prompt: '作者名（可留空）' });
  // 固定目录与 manifest 在数据层，几份空模板经网关写（`mode: 'create'`，已有的不动），见 `Workspace.initializeProject`。
  await new Workspace(project).initializeProject({ title: title.trim(), author: (author ?? '').trim() });
  getHost().toast(`已初始化《${title.trim()}》。`);
  // **不追问「要不要新建第 1 章」**：新工程的第一步是生成小说配置，创作页的
  // 主按钮已经明写着这件事（`deriveBookNextStep`）。这里再弹一个问句等于给出
  // 第二个入口，而它通向的是一个还没有架构可依据的空细纲。
  return true;
}

/**
 * 新建一章的细纲：**只建一份空骨架**，不问标题、不打开它。返回相对路径。
 *
 * 章号取细纲与 `chapters/` 两边的最大号 +1（`nextPlotNo`），与上一章落在同一个子目录，有刚建的空卷就进最新的一卷
 * （分卷的书写到第二卷时就在 `summaries/第二卷/`；写正文时正文照它落进 `chapters/第二卷/`）。
 * 正常路径上细纲是「拆细纲」一批一批生成的；这条留给作者想在末尾手工加一章。
 *
 * ## 为什么不问标题
 *
 * 新建的那一刻还没有标题可言：标题是排完细纲、知道这一章要发生什么之后才
 * 定下来的东西。逼作者先编一个只会换来一个假标题，而它会进文件名、进界面说法、
 * 进上下文。所以先落成纯序号名 `007.md`，等他想好了走「重命名」（序号前缀会保留）。
 *
 * ## 为什么不打开文件
 *
 * 接下来该做的是排细纲，不是在一个空文件里发呆。「建完去哪」由调用方决定：
 * 面板走 `selectPlot`（状态机把他送到「待写细纲」），CLI 与命令面板只报一句路径。
 */
export async function newPlotFlow(project: NovelProject): Promise<string> {
  const no = await project.nextPlotNo();
  const relPath = await new Workspace(project).writePlot({
    no,
    title: '',
    // 手工新建的细纲没有上游——**upstreamHash 留空**，它才永远不会挂 ⟳
    // （手写的产物永不标脏）。
    upstreamHash: '',
    done: false,
    sections: emptyPlotSections(),
  });
  await project.syncManifest();
  getHost().toast(`已新建第 ${no} 章的细纲：${relPath}`);
  return relPath;
}

/**
 * 直接新建一个章节文件：**先问章节名称**，正文建出来的同时在它的镜像位置配好细纲。不打开它。
 * 返回正文的相对路径；作者在输入框上取消了就是 undefined，什么都不建。
 *
 * `dir` 是落点目录（工作区相对路径，如 `chapters/第一卷`），越界时落在 chapters/ 根下；缺省时与新排的细纲
 * 同一个规矩（`subdirForNewChapter`）：有刚建的空卷就进最新的一卷，否则跟上一章放在一起。
 * 序号是全书唯一的下一个——分卷只是收纳，不重置编号。
 *
 * 正常路径上的章节是写正文时生成的，不是从这里建的。这条留给「手里已经有一章
 * 现成的文字，想直接粘进来」——所以建完不把作者送进创作页，多半他接下来就是
 * 往里粘正文。
 *
 * ## 名字
 *
 * 2026-10-23 作者要求建之前先问名字（从前不问、一律纯序号名）。留空照旧落成纯序号名 `007.md`，以后走「重命名」再起。
 * 细纲的标题与文件名用同一份清洗过的名字：改名时细纲的标题才认得出是跟着正文走的（`fileOps.retitleCarriedPlot`）。
 *
 * ## 细纲
 *
 * - 这一章还没有细纲：建一份空骨架（与 {@link newPlotFlow} 同一份七节），标题就是这个名字。手工建的没有上游，
 *   `upstreamHash` 留空、永不挂 ⟳；「关键事件」空着就还算空白，批量拆细纲、从已写正文补齐照样会填它。
 * - 这一章已经排好了细纲（拆细纲走在正文前面）：名字先填它的标题，`dir` 缺省时正文落进它所在的子目录，不另建——
 *   一章两份细纲是错的。名字改了，细纲跟着新正文改名、改标题（{@link attachPlot}）。
 * - 正文的镜像位置已经有一份细纲（先前留下的）：认它，不盖（第 3 条）。
 */
export async function newChapterFlow(project: NovelProject, dir?: string): Promise<string | undefined> {
  const order = await project.nextChapterOrder();
  const plan = await project.getPlot(order);
  const input = await getHost().input({
    title: `新建第 ${order} 章`,
    prompt: plan
      ? `这一章已经有细纲，先填了它的标题｜留空就只用序号 ${pad3(order)}`
      : `章节名称（同时建一份空细纲）｜留空就只用序号 ${pad3(order)}`,
    placeHolder: '如「夜入青云」',
    value: plan?.title ?? '',
    validate: (v) => (v.trim() ? validateName(v) : undefined),
  });
  if (input === undefined) {
    return undefined;
  }
  const title = input.trim() ? sanitizeFileName(input) : '';
  const planned = plan ? project.chapterPathForPlot(plan.relPath) : undefined;
  // 没给落点、也没有排好的细纲：与新排的细纲同一个规矩——有刚建的空卷就进最新的一卷，否则跟上一章。
  const landing =
    dir ||
    (planned
      ? path.posix.dirname(planned)
      : project.relPath(path.join(project.chaptersDir, await project.subdirForNewChapter(order))));
  const target = resolveSectionDir(project, 'chapters', landing);
  const ws = new Workspace(project);
  const relPath = await ws.createChapter(order, title, '', target);
  const plotRel = await attachPlot(project, ws, relPath, order, title, plan);
  await project.syncManifest();
  getHost().toast(`已新建第 ${order} 章：${relPath}${plotRel ? `，细纲 ${plotRel}` : ''}`);
  return relPath;
}

/**
 * 给刚建的这一章配上细纲，返回它的路径（配不上是 undefined）。规则见 {@link newChapterFlow}。
 *
 * 排好的那份挪到新正文的镜像走网关的 `move`（字节原样、历史版本跟着搬），标题走 `retitlePlot`（只改标题两行）——
 * 都不整份重渲染，作者在细纲里手加的东西一个字不丢。挪不过去（镜像位置已有别的）就两份都留着、说出来。
 */
async function attachPlot(
  project: NovelProject,
  ws: Workspace,
  chapterRel: string,
  no: number,
  title: string,
  plan: Plot | undefined
): Promise<string | undefined> {
  const mirror = project.plotMirrorOf(chapterRel);
  if (!mirror) {
    return undefined;
  }
  if (!plan) {
    const made = await ensureChapterPlot(project, ws, { relPath: chapterRel, order: no, title });
    if (made && !made.created) {
      log.info('新建章节：镜像位置已经有细纲，认它、不另建', mirror);
    }
    return made?.rel;
  }
  let rel = plan.relPath;
  if (mirror !== rel) {
    try {
      await ws.move(rel, mirror);
      rel = mirror;
    } catch (err) {
      log.warn('新建章节：排好的细纲没能挪到新正文的镜像', `${rel} → ${mirror}｜${describeError(err)}`);
      getHost().toast(`第 ${no} 章排好的细纲 ${rel} 没能跟着新正文改名（${describeError(err)}），两份都留着。`, 'error');
      return undefined;
    }
  }
  if (title) {
    await ws.retitlePlot(rel, plan.title, title);
  }
  return rel;
}

/**
 * 这一章正文镜像位置上的细纲：已经有就认它；没有就按模板建一份空骨架（与 {@link newPlotFlow} 同一份七节，
 * 标题是这一章的名字，没有名字的章留空）。返回路径与是不是刚建的；正文不在章节根下、推不出镜像时是 undefined。
 *
 * 新建章节文件配细纲、工程页点开一章（细纲并排）、内置编辑器工具栏的「细纲」（2026-10-23）都走这里。
 */
export async function ensureChapterPlot(
  project: NovelProject,
  ws: Workspace,
  chapter: { relPath: string; order: number; title: string }
): Promise<{ rel: string; created: boolean } | undefined> {
  const mirror = project.plotMirrorOf(chapter.relPath);
  if (!mirror) {
    return undefined;
  }
  if (await exists(project.pathOf(mirror))) {
    return { rel: mirror, created: false };
  }
  // 「第 9 章」是 listChapters 给没有名字的章的回落值，不是名字，不进细纲的标题与文件名。
  const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title;
  // 手工新建的细纲没有上游——upstreamHash 留空，它才永远不会挂 ⟳（手写的产物永不标脏）。
  const rel = await ws.writePlot({ no: chapter.order, title, upstreamHash: '', done: false, sections: emptyPlotSections() });
  log.info(`按模板给第 ${chapter.order} 章建了细纲`, rel);
  return { rel, created: true };
}

/** 目录名当默认作品名。 */
export function dirBaseName(project: NovelProject): string {
  return path.basename(project.root) || '我的小说';
}
