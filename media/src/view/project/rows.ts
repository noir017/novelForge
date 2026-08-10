/**
 * 工程页树上的各种行。
 *
 * **树是扁平渲染的**：`renderNodes` 递归遍历 `ProjectNode`，但产出的是扁平的
 * 行数组，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM——折叠一个文件夹只需要
 * 重画它所在的分组，不必搬 DOM 子树。
 *
 * 树上的行**一律不挂行内按钮**，全部操作走右键菜单（页面才干净）。例外是
 * 「文风与摘要」那几行——它们不是文件管理区，「重建」「从正文提取」照旧
 * 留在行内。
 */
import { el as mk } from '../../dom';
import type { MenuItem } from '../../globals';
import type {
  CastConflictView,
  CastEntry,
  ProjectChapterNode,
  ProjectDirNode,
  ProjectFile,
  ProjectNode,
  ProjectTree,
} from '../../protocol';
import { formatWords } from '../format';
import { onContextMenu } from '../menu';
import { openPath } from '../store';
import {
  baseMenuItems,
  characterAction,
  entryItems,
  newItemsIn,
  openDraft,
  projectAction,
} from './actions';
import type { Section } from './actions';
import { SECTIONS } from './actions';
import { indentOf, openFolders } from './treeState';

/** 由 index.ts 注入：折叠状态变了要重画一遍树。 */
let rerender: () => void = () => {};

export function bindRerender(fn: () => void): void {
  rerender = fn;
}

/**
 * 递归渲染一层节点，返回扁平的行数组。
 *
 * `section` 决定文件图标与「在此新建」建什么；`tree` 只有角色区用得上
 * （要按 relPath 查出场统计），其余区传不传都行。
 */
export function renderNodes(
  nodes: ProjectNode[],
  depth: number,
  section: Section,
  tree?: ProjectTree
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      rows.push(buildFolderRow(node, depth, section));
      if (openFolders.has(node.relPath)) {
        rows.push(
          ...(node.children.length === 0
            ? [emptyRow('（空文件夹）', depth + 1)]
            : renderNodes(node.children, depth + 1, section, tree))
        );
      }
    } else if (node.kind === 'chapter') {
      rows.push(buildChapterRow(node, depth));
    } else if (section === SECTIONS.characters) {
      rows.push(buildCharacterRow(node, depth, tree));
    } else {
      rows.push(buildFileRow(node, section.icon, depth));
    }
  }
  return rows;
}

/** 文件夹行。点行体展开/折叠，其余操作走右键。折叠状态不进后端。 */
function buildFolderRow(node: ProjectDirNode, depth: number, section: Section): HTMLElement {
  const row = mk('div', 'row row-dir');
  row.style.paddingLeft = `${indentOf(depth)}px`;
  const open = openFolders.has(node.relPath);

  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);

  const label = mk('span', 'row-label row-dir-label', `${open ? '📂' : '📁'} ${node.label}`);
  label.title = node.relPath;
  row.appendChild(label);

  row.appendChild(mk('span', 'meta', node.fileCount > 0 ? `${node.fileCount} 项` : '空'));

  const toggle = () => {
    if (openFolders.has(node.relPath)) {
      openFolders.delete(node.relPath);
    } else {
      openFolders.add(node.relPath);
    }
    rerender();
  };
  caret.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  onContextMenu(row, () => [
    { label: open ? '折叠' : '展开', run: toggle },
    { sep: true },
    // 「在此新建」的落点是这个文件夹自己，不是区根目录。
    ...newItemsIn(section, node.relPath),
    { sep: true },
    ...entryItems(node.relPath),
  ]);
  return row;
}

function buildChapterRow(c: ProjectChapterNode, depth: number): HTMLElement {
  // row-chapter + data-order 是悬停浮窗的抓手：事件委托在 projectBody 上，
  // 行被重渲染丢弃也不会留下失效的监听器。
  const row = mk('div', 'row row-chapter');
  row.dataset.order = String(c.order);
  row.style.paddingLeft = `${indentOf(depth)}px`;

  const dot = mk('span', `dot${c.stale ? ' stale' : ''}`, c.stale ? '○' : '●');
  dot.title = c.stale ? '摘要缺失或已过期' : '摘要为最新';
  row.appendChild(dot);

  const label = mk('span', 'row-label', `${String(c.order).padStart(3, '0')} ${c.title}`);
  label.title = c.relPath;
  label.addEventListener('click', () => openPath(c.relPath));
  row.appendChild(label);

  // 「有草稿」跟在字数后面，不新增 DOM——树行一律不挂行内按钮。
  row.appendChild(
    mk('span', 'meta', formatWords(c.wordCount) + (c.hasDraft ? ' · 草稿' : ''))
  );

  onContextMenu(row, () => {
    const items: MenuItem[] = [
      { label: '打开', run: () => openPath(c.relPath) },
      // 从第 N 章续写意味着写第 N+1 章。
      { label: '在此续写', run: () => projectAction('continueFrom', c.order) },
      // 草稿按需创建：没有就建一个再打开，文案据此区分。
      { label: c.hasDraft ? '打开草稿' : '新建草稿', run: () => openDraft(c.relPath) },
      {
        label: c.stale ? '总结本章' : '重新总结',
        run: () => projectAction('summarizeChapter', c.order),
      },
    ];
    if (c.summaryPath) {
      items.push({ label: '看摘要', run: () => openPath(c.summaryPath) });
    }
    items.push({ sep: true }, ...entryItems(c.relPath));
    return items;
  });
  return row;
}

/**
 * 角色/设定/元数据行。
 *
 * `depth` 为 undefined 时不设缩进，也不挂类文件操作的右键菜单——
 * 「文风与摘要」那几行是工程的固定文件，不能重命名/移动/删除。
 */
export function buildFileRow(f: ProjectFile, icon: string, depth?: number): HTMLElement {
  const row = mk('div', 'row');
  if (depth !== undefined) {
    row.style.paddingLeft = `${indentOf(depth)}px`;
  }

  row.appendChild(mk('span', 'dot', icon));

  const label = mk('span', 'row-label', f.label);
  label.title = f.relPath;
  label.addEventListener('click', () => openPath(f.relPath));
  row.appendChild(label);

  if (f.detail) {
    row.appendChild(mk('span', 'meta row-detail', f.detail));
  }
  if (depth !== undefined) {
    onContextMenu(row, () => [
      { label: '打开', run: () => openPath(f.relPath) },
      { sep: true },
      ...entryItems(f.relPath),
    ]);
  }
  return row;
}

/**
 * 角色行。比普通文件行多两样东西：出场章节副标题，以及「更新角色卡」菜单。
 *
 * 出场统计来自后端的 `castByCard`（按摘要聚合），前端不自己算——
 * 「第 3、7、12 章」这句话在日志里也要出现，两处文案必须一致。
 */
function buildCharacterRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.castByCard?.[f.relPath] ?? null;
  const detail = [f.detail, stats && stats.chapters.length > 0 ? `出场 ${stats.chapters.length} 章` : '']
    .filter(Boolean)
    .join(' · ');
  const row = buildFileRow({ ...f, detail }, SECTIONS.characters.icon, depth);

  // 上次更新之后又出场了若干章：给个小标记，作者一眼看出这张卡该刷了。
  if (stats && stats.pending > 0) {
    const flag = mk('span', 'meta cast-pending', `＋${stats.pending}`);
    flag.title = `上次更新覆盖到第 ${stats.updatedThrough} 章，此后新增 ${stats.pending} 章出场`;
    row.appendChild(flag);
  }

  onContextMenu(row, () => {
    const items: MenuItem[] = [{ label: '打开', run: () => openPath(f.relPath) }, { sep: true }];
    if (stats && stats.chapters.length > 0) {
      items.push(
        {
          label: stats.pending > 0 ? `更新角色卡（新增 ${stats.pending} 章）` : '更新角色卡',
          run: () => characterAction('updateCard', f.label, f.relPath),
        },
        {
          label: `重新通读全部 ${stats.chapters.length} 章`,
          run: () => characterAction('rebuildCard', f.label, f.relPath),
        },
        { label: `出场：${stats.detail}`, disabled: true }
      );
    } else {
      items.push({ label: '未在摘要中出现，无法自动更新', disabled: true });
    }
    items.push({ sep: true }, ...entryItems(f.relPath));
    return items;
  });
  return row;
}

/**
 * 「出场人物 · 未建卡」的一行。
 * 只有一个动作：建卡（建完立刻用它的出场章节跑一次提取）。
 */
export function buildCastRow(c: CastEntry): HTMLElement {
  const row = mk('div', 'row row-cast');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', '○');
  dot.title = '摘要里出现过，还没有角色卡';
  row.appendChild(dot);

  const label = mk('span', 'row-label', c.name);
  if (c.aliases.length > 0) {
    label.title = `又称 ${c.aliases.join('、')}`;
  }
  row.appendChild(label);
  row.appendChild(mk('span', 'meta row-detail', c.detail));

  // 最常用的动作放在最省事的位置：点名字就是建卡。
  const create = () => characterAction('createCard', c.name);
  label.addEventListener('click', create);

  onContextMenu(row, () => [
    { label: '创建角色卡（通读出场章节）', run: create },
    { label: `出场：${c.detail}`, disabled: true },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

export function emptyRow(text: string, depth?: number): HTMLElement {
  const row = mk('div', 'hint row-empty', text);
  if (depth !== undefined) {
    row.style.paddingLeft = `${indentOf(depth)}px`;
  }
  return row;
}

/**
 * 「多张卡抢同一个称呼」的提示行，挂在角色分组顶部。
 *
 * 出场统计按称呼归属，一个称呼只能算给一张卡——有冲突就必然有一张的出场
 * 章节是错的，而这件事从界面上完全看不出来（两张卡各自都显示得好好的）。
 * 所以必须显式说出来，并指向能解决它的那两个菜单项。
 */
export function buildConflictRow(conflict: CastConflictView): HTMLElement {
  const cards = conflict.cards.map((c) => `「${c.name}」`);
  const text =
    conflict.kind === 'name'
      ? `⚠ ${cards.join('、')} 都叫「${conflict.name}」，出场统计只会算给其中一张。` +
        '多半是同一个人建了两张卡——用本组右键的「查找并合并重复角色卡」。'
      : `⚠ 「${conflict.name}」被 ${cards.join('、')} 同时当作自己的称呼，出场统计只会算给 ${cards[0] ?? ''}。` +
        '若它们本来就是同一个人，用本组右键的「查找并合并重复角色卡」；若是别名填错了人，用「清理别名」。';
  return mk('div', 'row-conflict', text);
}
