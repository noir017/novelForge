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
import { PLOT_STAGE_LABEL, volumeLabel } from '../../protocol';
import type {
  CastConflictView,
  CastEntry,
  CreationTarget,
  FailureView,
  ProjectPlotNode,
  ProjectVolumeNode,
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
 * 点这一行（或右键第一项）打开哪一份文件：成品 → 待拆分的正文 → 细纲，
 * 取第一个存在的。
 *
 * 为什么不直接用 `relPath`（主路径）：主路径只在成品与细纲之间二选一，
 * 于是「正文写完、还没拆成章节」那一档会打开细纲——那时磁盘上明明躺着
 * 几千字的正文。`relPath` 兜最后一手，理论上三个都空进不来这里。
 */
function openTargetOf(p: ProjectPlotNode): string {
  return p.chapterPath || p.manuscriptPath || p.plotPath || p.relPath;
}

/**
 * 章节组的一行：**一个已发布的章，或一个还没交付的剧情段**。
 *
 * 两种行长得像但说的不是一回事，所以文案由后端给（`p.label`：「第 12 章《夜访》」
 * / 「剧情 4《楼道》」）——前端按 `no` 自己拼会把每个剧情段都叫成「第 N 章」，
 * 而一个剧情段可以拆成三章。
 *
 * 徽章、四段进度、⟳ 只对**剧情段**有意义：它们说的是「这一段现在该做哪一步」。
 * 已发布的章那一行报的是摘要状态与草稿——造它的那一段早就做完了。
 */
function buildPlotRow(p: ProjectPlotNode): HTMLElement {
  // row-plot + data-plot 是悬停浮窗的抓手：事件委托在 projectBody 上，
  // 行被重渲染丢弃也不会留下失效的监听器。
  const row = mk('div', `row row-plot${p.kind === 'segment' ? ' row-segment' : ''}`);
  row.dataset.plot = p.relPath;
  row.style.paddingLeft = `${indentOf(0)}px`;

  // 摘要挂在成品上：还没交付的剧情段没有摘要是正常的，那不是「过期」，
  // 是还没到那一步。给它一个空心点会让整列看起来全是待办。
  const published = p.kind === 'chapter';
  const dot = mk('span', `dot${published && p.stale ? ' stale' : ''}`, published && p.stale ? '○' : '●');
  dot.title = !published ? '还没拆成发布章节' : p.stale ? '摘要缺失或已过期' : '摘要为最新';
  row.appendChild(dot);

  // 生成失败过：与「过期」是两回事——过期只说明该重跑，这个说明跑过但没成。
  // 两侧路径都要查：摘要失败挂在成品上，写正文/拆场景失败挂在细纲上。
  const mark = (p.chapterPath ? failureMark(p.chapterPath) : undefined) ?? failureMark(p.plotPath);
  if (mark) {
    row.appendChild(mark);
  }

  const opens = openTargetOf(p);
  // 说法由后端给：这一行可能是已发布的章，也可能是还没交付的剧情段
  // （「第 12 章《夜访》」/「剧情 4《楼道》」）。前端按 `no` 自己拼会把每个
  // 剧情段都叫成「第 N 章」，而一个剧情段可以拆成三章。
  const label = mk('span', 'row-label', p.label);
  label.title =
    `${opens}\n点击在编辑器里打开；右键「${p.kind === 'segment' ? '进入这一段' : '进入这一章'}」去做下一步`;
  // 点名字 = **打开这一章的文件**（独立版开内置编辑器的标签页，插件形态开
  // VS Code 的 tab）。从前点名字是「进入这一章」——那会把人从工程页弹到对话页，
  // 而在工程页上扫章节列表时，想看的多半就是这一章写成了什么样。
  // 「进入这一章」没有消失，它挪进了右键菜单。
  label.addEventListener('click', () => openPath(opens));
  row.appendChild(label);

  // 流水线徽章：这一段现在该做哪一步。全书扫一眼就知道卡在哪里，不必逐段点开。
  // **已发布的章不挂**：它的进度永远是满格，一列「已完成」只是噪声。
  if (p.kind === 'segment') {
    const stage = mk('span', `row-stage stage-${p.stage}`, PLOT_STAGE_LABEL[p.stage]);
    stage.title = describeProgress(p);
    row.appendChild(stage);
  }

  // 上游变过（卷纲/细纲/场景改了）。用 ⟳ 而不是感叹号：这不是错误，
  // 是「回头看一眼」——与失败标记要分得开。
  if (p.upstreamStale) {
    const stale = mk('span', 'row-upstream', '⟳');
    stale.title = '上游产物改过，这一段的下游可能需要重做';
    row.appendChild(stale);
  }

  // 字数后面跟「草稿」，不新增 DOM——树行一律不挂行内按钮。
  const words = p.wordCount > 0 ? formatWords(p.wordCount) : '未写';
  row.appendChild(mk('span', 'meta', words + (p.hasDraft ? ' · 草稿' : '')));

  onContextMenu(row, () => {
    // 打开哪一份：与点名字同序（成品 → 待拆分的正文 → 细纲），
    // 点行做的那件事在菜单里排第一，不必猜它去了哪儿。
    const items: MenuItem[] = [];
    if (published) {
      items.push({ label: '打开正文', run: () => openPath(p.chapterPath) });
    }
    if (p.manuscriptPath) {
      items.push({
        label: published ? '打开待拆分的正文' : '打开正文（待拆分）',
        run: () => openPath(p.manuscriptPath),
      });
    }
    if (p.plotPath) {
      items.push({ label: '打开细纲', run: () => openPath(p.plotPath) });
    }
    items.push(
      { sep: true },
      // 点名字不再做这件事了，它是这一行唯一「会切页」的动作，单独一段。
      {
        label: p.kind === 'segment' ? '进入这一段' : '进入这一章',
        run: () => vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath }),
      },
      { sep: true }
    );

    // 正文写完、还没拆成发布章节：把那一步放在最显眼的位置。
    if (p.kind === 'segment' && p.stage === 'split') {
      items.push(
        { label: '拆成章节', run: () => projectAction('splitManuscript', p.plotPath) },
        { sep: true }
      );
    }

    // 两层入口。点哪一层就把创作页切到那一层——状态机给的是「该做的
    // 下一步」，而作者常常要回头改上一层（设计文档里的「反向流动」）。
    //
    // 只有**手上有细纲**才给：已发布的章找不到来源段时（老工程里每一章都是）
    // 这两项会指到一个不存在的落点上。
    //
    // 卷纲不在这里：它是段的上游、不属于这一行，入口在卷那一行与创作页
    // 那一排状态点上。
    if (p.plotPath) {
      items.push(
        { label: `剧情（${pct(p.progress.plot)}）`, run: () => setTarget({ kind: 'plot', plotRelPath: p.plotPath }) },
        {
          label: `正文（${pct(p.progress.manuscript)}）`,
          run: () => setTarget({ kind: 'manuscript', plotRelPath: p.plotPath }),
        },
        { sep: true }
      );
    }

    // 总结、看摘要、草稿都只对已发布的章成立——三者读的都是成品。
    if (published) {
      items.push({
        label: p.stale ? '总结这一章' : '重新总结',
        run: () => projectAction('summarizePlot', p.chapterPath),
      });
      if (p.summaryPath) {
        items.push({ label: '看摘要', run: () => openPath(p.summaryPath) });
      }
      // 草稿按需创建：没有就建一个再打开，文案据此区分。
      items.push({ label: p.hasDraft ? '打开草稿' : '新建草稿', run: () => openDraft(p.chapterPath) });
      items.push({ sep: true });
    }

    // 改名/删除落在**主路径**上：有成品就是成品（摘要与草稿跟着走），
    // 只有细纲就是细纲（场景与中转站正文跟着走）。
    // **没有「移动到…」**：顺序由序号决定，把一章挪进子目录只会让它从流水线上消失。
    items.push(
      { label: '重命名', run: () => fileAction('rename', p.relPath) },
      { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', p.relPath) }
    );
    return items;
  });
  return row;
}

/**
 * 章节组的全部行。扁平列表——顺序即写作顺序（已发布的章在前，待写的剧情段在后）。
 *
 * 两段之间插一条分隔：那正是「写到哪了」的位置，扫一眼就看得见。
 */
export function buildPlotRows(plots: ProjectPlotNode[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let inserted = false;
  for (const p of plots) {
    if (!inserted && p.kind === 'segment' && rows.length > 0) {
      rows.push(mk('div', 'row-divider hint', '以下是还没拆成章的剧情段'));
      inserted = true;
    }
    rows.push(buildPlotRow(p));
  }
  return rows;
}

/**
 * 卷组的一行。**复用章节行的骨架**：序号 + 名字 + 徽章 + 字数 + 右键菜单。
 *
 * 卷上能做的事比段少得多——它只有一份卷纲，没有场景也没有正文。所以徽章报的是
 * 「拆出几段、交付了几段」，而不是四段进度。
 */
function buildVolumeRow(v: ProjectVolumeNode): HTMLElement {
  const row = mk('div', 'row row-plot row-volume');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', `dot${v.filled ? '' : ' stale'}`, v.filled ? '●' : '○');
  dot.title = v.filled ? '卷纲已排过走向' : '卷纲还是空壳——先把这一卷讲什么写出来，再拆剧情段';
  row.appendChild(dot);

  const mark = failureMark(v.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', volumeLabel(v.no, v.title));
  label.title = `${v.relPath}\n点击在编辑器里打开卷纲；右键「进入这一卷」去拆剧情段`;
  label.addEventListener('click', () => openPath(v.relPath));
  row.appendChild(label);

  const badge = mk(
    'span',
    'row-stage stage-plot',
    v.segmentCount === 0 ? '待拆剧情段' : `${v.deliveredCount}/${v.segmentCount} 段已交付`
  );
  badge.title = '这一卷拆出了多少剧情段，其中多少已经拆成发布章节。';
  row.appendChild(badge);

  if (v.upstreamStale) {
    const stale = mk('span', 'row-upstream', '⟳');
    stale.title = '全书大纲在这一卷之后改过，这一卷可能需要回头看一眼';
    row.appendChild(stale);
  }

  row.appendChild(mk('span', 'meta', v.wordCount > 0 ? formatWords(v.wordCount) : '未写'));

  onContextMenu(row, () => [
    { label: '打开卷纲', run: () => openPath(v.relPath) },
    { sep: true },
    // 卷上唯一的创作动作：进去拆下一个剧情段（主按钮会是「拆出剧情段」）。
    {
      label: '进入这一卷',
      run: () => setTarget({ kind: 'volume', volumeRelPath: v.relPath }),
    },
    { sep: true },
    // **没有「移动到…」**：卷的落点由卷号决定，挪走只会让它收纳的段变成孤儿。
    { label: '重命名', run: () => fileAction('rename', v.relPath) },
    { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', v.relPath) },
  ]);
  return row;
}

/** 卷组的全部行。扁平列表——顺序即卷号。 */
export function buildVolumeRows(volumes: ProjectVolumeNode[]): HTMLElement[] {
  return volumes.map(buildVolumeRow);
}

/** 三段完成度，鼠标移上去看得见。 */
function describeProgress(p: ProjectPlotNode): string {
  return (
    `${PLOT_STAGE_LABEL[p.stage]}\n` +
    `剧情 ${pct(p.progress.plot)}｜正文 ${pct(p.progress.manuscript)}｜摘要 ${pct(p.progress.summary)}`
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
 * 「第 3、7、12 章」这句话在日志里也要出现，两处文案必须一致。
 */
function buildCharacterRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.castByCard?.[f.relPath] ?? null;
  const detail = [f.detail, stats && stats.plots.length > 0 ? `出场 ${stats.plots.length} 章` : '']
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
    if (stats && stats.plots.length > 0) {
      items.push(
        {
          label: stats.pending > 0 ? `更新角色卡（新增 ${stats.pending} 章）` : '更新角色卡',
          run: () => characterAction('updateCard', f.label, f.relPath),
        },
        {
          label: `重新通读全部 ${stats.plots.length} 章`,
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
