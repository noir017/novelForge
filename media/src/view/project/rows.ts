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
import { PLOT_STAGE_LABEL } from '../../protocol';
import type {
  CastConflictView,
  CastEntry,
  CreationTarget,
  FailureView,
  ProjectChapterNode,
  ProjectPlotNode,
  ProjectDirNode,
  ProjectFile,
  ProjectNode,
  ProjectTree,
} from '../../protocol';
import { formatWords } from '../format';
import { onContextMenu } from '../menu';
import { openPath, vscode } from '../store';
import {
  baseMenuItems,
  characterAction,
  entryItems,
  fileAction,
  newItemsIn,
  openDraft,
  projectAction,
} from './actions';
import type { Section } from './actions';
import { SECTIONS } from './actions';
import { indentOf, lastTree, openFolders } from './treeState';

/**
 * 失败标记。有未解决的失败记录时插在文件名之前，鼠标移上去看原因
 * （浮窗在 [errorTip.ts](errorTip.ts)，事件委托抓 `.row-failure`）。
 *
 * 为什么不做成行内的一段文字：失败信息有好几行，摊在树上会把行撑爆，
 * 而绝大多数时候树上一个失败都没有。一个感叹号 + 悬停展开是最省地方的形态。
 *
 * 只要有一条是 `error`（整体失败、目标未改动）就按红色算——那比「部分完成」
 * 严重，不能被同一目标上的一条黄色记录盖过去。
 */
function failureMark(relPath: string): HTMLElement | null {
  const failures: FailureView[] | undefined = lastTree?.failures?.[relPath];
  if (!failures || failures.length === 0) {
    return null;
  }
  const hasError = failures.some((f) => f.severity === 'error');
  const mark = mk('span', `row-failure ${hasError ? 'is-error' : 'is-warn'}`, '❗');
  mark.dataset.failureKey = relPath;
  // 原生 title 作兜底：浮窗要等 300ms，而且它只在工程页里装了事件委托。
  mark.title = failures[0].message;
  return mark;
}

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

/**
 * 剧情行：创作流水线在工程页上的落点。
 *
 * 徽章、四段进度、⟳ 全在这里——它们说的是「这一段现在该做哪一步」，
 * 而那正是作者扫一眼全书要找的东西。章节行（发布区）不再有这些。
 */
function buildPlotRow(p: ProjectPlotNode): HTMLElement {
  // row-plot + data-plot 是悬停浮窗的抓手：事件委托在 projectBody 上，
  // 行被重渲染丢弃也不会留下失效的监听器。
  const row = mk('div', 'row row-plot');
  row.dataset.plot = p.relPath;
  row.style.paddingLeft = `${indentOf(0)}px`;

  // 还没写正文的段没有摘要是正常的——那不是「过期」，是还没到那一步。
  // 给它一个空心点会让整列看起来全是待办。
  const hasText = p.wordCount > 0;
  const dot = mk('span', `dot${hasText && p.stale ? ' stale' : ''}`, hasText && p.stale ? '○' : '●');
  dot.title = !hasText ? '还没有正文' : p.stale ? '摘要缺失或已过期' : '摘要为最新';
  row.appendChild(dot);

  // 生成失败过：与「过期」是两回事——过期只说明该重跑，这个说明跑过但没成。
  const mark = failureMark(p.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', `${String(p.no).padStart(3, '0')} ${p.title || '（未命名）'}`);
  label.title = `${p.relPath}\n点击进入这一段当前该做的那一步`;
  // 点名字 = **进入这一段**，由后端的状态机决定落在哪一层。
  // 与章节行刻意相反：章节是成品，点它多半是想读/改那段文字，所以那边点了
  // 就开文件；剧情段是流水线上的活，点它十次里有九次是想接着往下做。
  label.addEventListener('click', () => vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath }));
  row.appendChild(label);

  // 流水线徽章：这一段现在该做哪一步。全书扫一眼就知道卡在哪里，
  // 不必逐段点开。
  const stage = mk('span', `row-stage stage-${p.stage}`, PLOT_STAGE_LABEL[p.stage]);
  stage.title = describeProgress(p);
  row.appendChild(stage);

  // 上游变过（大纲/剧情/场景改了）。用 ⟳ 而不是感叹号：这不是错误，
  // 是「回头看一眼」——与失败标记要分得开。
  if (p.upstreamStale) {
    const stale = mk('span', 'row-upstream', '⟳');
    stale.title = '上游产物改过，这一段的下游可能需要重做';
    row.appendChild(stale);
  }

  row.appendChild(mk('span', 'meta', hasText ? formatWords(p.wordCount) : '未写'));

  onContextMenu(row, () => {
    const items: MenuItem[] = [
      { label: '进入这一段', run: () => vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath }) },
      { label: '打开剧情', run: () => openPath(p.relPath) },
      { sep: true },
      // 三层入口。点哪一层就把创作页切到那一层——状态机给的是「该做的
      // 下一步」，而作者常常要回头改上一层（设计文档里的「反向流动」）。
      { label: `剧情（${pct(p.progress.plot)}）`, run: () => setTarget({ kind: 'plot', plotRelPath: p.relPath }) },
      {
        label: `场景（${pct(p.progress.scene)}）`,
        run: () => setTarget({ kind: 'scene', plotRelPath: p.relPath, sceneNo: 1 }),
      },
      {
        label: `正文（${pct(p.progress.manuscript)}）`,
        run: () => setTarget({ kind: 'manuscript', plotRelPath: p.relPath }),
      },
      { sep: true },
    ];
    if (hasText) {
      items.push({ label: '打开正文', run: () => openPath(p.manuscriptPath) });
      items.push({
        label: p.stale ? '总结这一段' : '重新总结',
        run: () => projectAction('summarizePlot', p.relPath),
      });
      if (p.summaryPath) {
        items.push({ label: '看摘要', run: () => openPath(p.summaryPath) });
      }
    }
    // 只给重命名与删除，**没有「移动到…」**：`plots/` 是扁平的，顺序由
    // 序号决定，把一段挪进子目录只会让它从流水线上消失。
    items.push(
      { sep: true },
      { label: '重命名', run: () => fileAction('rename', p.relPath) },
      { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', p.relPath) }
    );
    return items;
  });
  return row;
}

/** 剧情组的全部行。扁平列表——`plots/` 本身扁平，顺序即写作顺序。 */
export function buildPlotRows(plots: ProjectPlotNode[]): HTMLElement[] {
  return plots.map(buildPlotRow);
}

/**
 * 章节行：**发布区，纯文件**。
 *
 * 没有徽章、没有进度、没有 ⟳——章节是作者从 `manuscripts/` 切出来的成品，
 * 工具不分析它的内容，也就没有任何「该做什么」可说。
 */
function buildChapterRow(c: ProjectChapterNode, depth: number): HTMLElement {
  const row = mk('div', 'row row-chapter');
  row.style.paddingLeft = `${indentOf(depth)}px`;
  row.appendChild(mk('span', 'dot', '·'));

  const label = mk('span', 'row-label', `${String(c.order).padStart(3, '0')} ${c.title}`);
  label.title = c.relPath;
  label.addEventListener('click', () => openPath(c.relPath));
  row.appendChild(label);

  // 「有草稿」跟在字数后面，不新增 DOM——树行一律不挂行内按钮。
  row.appendChild(mk('span', 'meta', formatWords(c.wordCount) + (c.hasDraft ? ' · 草稿' : '')));

  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(c.relPath) },
    // 草稿按需创建：没有就建一个再打开，文案据此区分。
    { label: c.hasDraft ? '打开草稿' : '新建草稿', run: () => openDraft(c.relPath) },
    { sep: true },
    ...entryItems(c.relPath),
  ]);
  return row;
}

/** 四段完成度，鼠标移上去看得见。 */
function describeProgress(p: ProjectPlotNode): string {
  return (
    `${PLOT_STAGE_LABEL[p.stage]}\n` +
    `剧情 ${pct(p.progress.plot)}｜场景 ${pct(p.progress.scene)}｜` +
    `正文 ${pct(p.progress.manuscript)}｜摘要 ${pct(p.progress.summary)}`
  );
}

function pct(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function setTarget(target: CreationTarget): void {
  vscode.postMessage({ type: 'setTarget', target });
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

  // 失败标记排在名字之前：扫一列文件名时，异常的那几行第一眼就跳出来。
  const mark = failureMark(f.relPath);
  if (mark) {
    row.appendChild(mark);
  }

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
 * 角色行。比普通文件行多两样东西：出场段落副标题，以及「更新角色卡」菜单。
 *
 * 出场统计来自后端的 `castByCard`（按摘要聚合），前端不自己算——
 * 「第 3、7、12 段」这句话在日志里也要出现，两处文案必须一致。
 */
function buildCharacterRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.castByCard?.[f.relPath] ?? null;
  const detail = [f.detail, stats && stats.plots.length > 0 ? `出场 ${stats.plots.length} 段` : '']
    .filter(Boolean)
    .join(' · ');
  const row = buildFileRow({ ...f, detail }, SECTIONS.characters.icon, depth);

  // 上次更新之后又出场了若干段：给个小标记，作者一眼看出这张卡该刷了。
  if (stats && stats.pending > 0) {
    const flag = mk('span', 'meta cast-pending', `＋${stats.pending}`);
    flag.title = `上次更新覆盖到第 ${stats.updatedThrough} 段，此后新增 ${stats.pending} 段出场`;
    row.appendChild(flag);
  }

  onContextMenu(row, () => {
    const items: MenuItem[] = [{ label: '打开', run: () => openPath(f.relPath) }, { sep: true }];
    if (stats && stats.plots.length > 0) {
      items.push(
        {
          label: stats.pending > 0 ? `更新角色卡（新增 ${stats.pending} 段）` : '更新角色卡',
          run: () => characterAction('updateCard', f.label, f.relPath),
        },
        {
          label: `重新通读全部 ${stats.plots.length} 段`,
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
 * 只有一个动作：建卡（建完立刻用它的出场段落跑一次提取）。
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
    { label: '创建角色卡（通读出场段落）', run: create },
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
