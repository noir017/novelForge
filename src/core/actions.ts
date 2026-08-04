import * as path from 'node:path';
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

/** 新建一章：问标题后落盘并打开。返回相对路径，取消返回 undefined。 */
export async function newChapterFlow(project: NovelProject): Promise<string | undefined> {
  const order = await project.nextChapterOrder();
  const title = await getHost().input({
    title: `新建第 ${order} 章`,
    prompt: '章节标题',
    value: `第${order}章`,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return undefined;
  }
  const relPath = await project.createChapter(order, title.trim());
  await getHost().openFile(relPath);
  return relPath;
}

/** 目录名当默认作品名。 */
export function dirBaseName(project: NovelProject): string {
  return path.basename(project.root) || '我的小说';
}
