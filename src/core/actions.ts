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
 * 新建一章：问标题后落盘并打开。返回相对路径，取消返回 undefined。
 * `dir` 是落点目录（工作区相对路径，如 `chapters/第一卷`），缺省或越界时落在 chapters/ 根下。
 * 序号仍然是全书唯一的下一个——分卷只是收纳，不重置编号。
 */
export async function newChapterFlow(project: NovelProject, dir?: string): Promise<string | undefined> {
  const target = resolveSectionDir(project, 'chapters', dir);
  const order = await project.nextChapterOrder();
  const title = await getHost().input({
    title: `新建第 ${order} 章`,
    prompt: target === project.relPath(project.chaptersDir) ? '章节标题' : `章节标题（建到 ${target}/）`,
    value: `第${order}章`,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return undefined;
  }
  const relPath = await project.createChapter(order, title.trim(), '', target);
  await getHost().openFile(relPath);
  return relPath;
}

/** 目录名当默认作品名。 */
export function dirBaseName(project: NovelProject): string {
  return path.basename(project.root) || '我的小说';
}
