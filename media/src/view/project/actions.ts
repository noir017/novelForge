/**
 * 工程页发出去的那几条消息，以及三个可管理区各自的差异。
 */
import type { CharacterAction, ProjectAction } from '../../protocol';
import type { MenuItem } from '../../globals';
import { vscode } from '../store';

/**
 * `relPath` 是动作的作用对象（如要总结哪一章）；`dir` 给新建类动作指定落点
 * 目录，缺省落在该区的根目录。
 */
export function projectAction(action: ProjectAction, relPath?: string, dir?: string): void {
  vscode.postMessage({ type: 'projectAction', action, relPath, dir });
}

export function fileAction(action: 'rename' | 'move' | 'delete', relPath: string): void {
  vscode.postMessage({ type: 'fileAction', action, relPath });
}

/**
 * 角色卡动作。作用对象是一个**角色**（用名字标识），不是文件——
 * 未建卡的人物根本没有文件，所以不能走 fileAction。
 */
export function characterAction(action: CharacterAction, name?: string, relPath?: string): void {
  // 批量动作（updateAllCards/rebuildAllCards）没有具体角色，name 兜底空串。
  vscode.postMessage({ type: 'characterAction', action, name: name ?? '', relPath });
}

/** 打开某章的草稿。传的是**章节**路径，草稿路径由后端推导并按需创建。 */
export function openDraft(relPath: string): void {
  vscode.postMessage({ type: 'openDraft', path: relPath });
}

/**
 * 所有页面都有的兜底菜单：一个刷新。
 *
 * **复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，
 * 会按当前页签推数据，天然适用于所有页面，无需新增协议。
 */
export function baseMenuItems(): MenuItem[] {
  return [{ label: '刷新', run: () => projectAction('refresh') }];
}

/**
 * 三个可管理区各自的差异：新建什么、菜单上怎么称呼、文件行用什么图标。
 * 与 core/files/fileOps.ts 的 Section 一一对应。
 */
export interface Section {
  newAction: ProjectAction;
  newLabel: string;
  icon: string;
}

export const SECTIONS = {
  chapters: { newAction: 'newChapter', newLabel: '在此新建章节', icon: '📄' },
  characters: { newAction: 'newCharacter', newLabel: '在此新建角色卡', icon: '👤' },
  lore: { newAction: 'newLore', newLabel: '在此新建设定', icon: '🌐' },
} as const satisfies Record<string, Section>;

/** 「在此新建 X / 在此新建文件夹」两项，落点是 `dir`。 */
export function newItemsIn(section: Section, dir?: string): MenuItem[] {
  return [
    { label: section.newLabel, run: () => projectAction(section.newAction, undefined, dir) },
    { label: '在此新建文件夹', run: () => projectAction('newFolder', undefined, dir) },
  ];
}

/** 重命名 / 移动 / 删除——文件与文件夹都是这三个。 */
export function entryItems(relPath: string): MenuItem[] {
  return [
    { label: '重命名', run: () => fileAction('rename', relPath) },
    { label: '移动到…', run: () => fileAction('move', relPath) },
    { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', relPath) },
  ];
}
