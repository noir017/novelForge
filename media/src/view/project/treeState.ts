/**
 * 工程页的前端状态：折叠开合与最近一次收到的树。
 *
 * 展开/折叠**完全留在前端**，不进后端也不进推送——切一下折叠只需拿最近
 * 那份快照重画（`rerenderProject`），不必往后端要一次数据。
 */
import type { ProjectTree } from '../../protocol';

/**
 * 四个顶层分组默认展开；文件夹默认折叠——一进工程页就摊开整棵树反而看不清。
 * 放在模块级，重渲染后不会把用户折叠的东西又展开。
 */
export const openGroups: Record<string, boolean> = {
  chapters: true,
  characters: true,
  cast: true,
  lore: true,
  meta: true,
};

/** 展开着的文件夹（relPath 集合）。 */
export const openFolders = new Set<string>();

/** 最近一次收到的树。折叠时拿它重画即可。 */
export let lastTree: ProjectTree | null = null;

export function setLastTree(tree: ProjectTree): void {
  lastTree = tree;
}

/** 每层缩进 14px，第 0 层与改造前的行保持同样的左内边距。 */
export function indentOf(depth: number): number {
  return 16 + depth * 14;
}
