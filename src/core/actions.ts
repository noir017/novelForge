import * as path from 'node:path';
import { resolveSectionDir } from './files/fileOps';
import { getHost } from './host';
import { NovelProject } from './model/project';

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
  await project.initialize({ title: title.trim(), author: (author ?? '').trim() });
  getHost().toast(`已初始化《${title.trim()}》。`);
  const pick = await getHost().confirm('要现在新建第 1 章吗？', ['新建第 1 章', '稍后']);
  if (pick === '新建第 1 章') {
    await newChapterFlow(project);
  }
  return true;
}

/**
 * 新建一章：**只建一个 0 字的章节文件**，不问标题、不打开它。返回相对路径。
 *
 * `dir` 是落点目录（工作区相对路径，如 `chapters/第一卷`），缺省或越界时落在 chapters/ 根下。
 * 序号仍然是全书唯一的下一个——分卷只是收纳，不重置编号。
 *
 * ## 为什么不问标题
 *
 * 新建的那一刻还没有标题可言：标题是写完细纲、知道这一章要发生什么之后才
 * 定下来的东西。逼作者先编一个（旧版预填「第N章」，多数人就直接回车）只会
 * 换来一个假标题，而它会进文件名、进 H1、进上下文。所以先落成纯序号名
 * `007.md`，等他想好了走「重命名」（序号前缀会保留）。
 *
 * ## 为什么不打开文件
 *
 * 接下来该做的是写细纲，不是在一个空正文里发呆——四层流水线存在的理由正是
 * 不让人从空白正文开始写。「建完去哪」由调用方决定：面板走
 * `selectChapter`（状态机把他送到「待写细纲」），CLI 与命令面板只报一句路径。
 */
export async function newChapterFlow(project: NovelProject, dir?: string): Promise<string> {
  const target = resolveSectionDir(project, 'chapters', dir);
  const order = await project.nextChapterOrder();
  const relPath = await project.createChapter(order, '', '', target);
  // 章节索引里立刻有这一条：createChapter 只写文件，manifest 得自己刷。
  await project.syncManifest();
  getHost().toast(`已新建第 ${order} 章：${relPath}`);
  return relPath;
}

/** 目录名当默认作品名。 */
export function dirBaseName(project: NovelProject): string {
  return path.basename(project.root) || '我的小说';
}
