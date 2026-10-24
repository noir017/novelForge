/**
 * 工程页树上的各种行。
 *
 * **树是扁平渲染的**：`renderNodes` 递归遍历 `ProjectNode`，但产出的是扁平的
 * 行数组，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM——折叠一个文件夹只需要
 * 重画它所在的分组，不必搬 DOM 子树。
 *
 * 树上的行**不挂行内按钮**，全部操作走右键菜单（页面才干净）。例外只有三处：
 * 下一个该写的章行尾的「去写这一章」、故事架构第一件没填的那一行的「去生成」（全页各一颗），
 * 以及「文风与摘要」那两行悬停才亮的「重建」「从正文提取」之类——它们不是文件管理区。
 */
import { el as mk } from '../../dom';
import type { MenuItem } from '../../globals';
import { FINALIZE_CALLS, LORE_ENTRY_CALLS, LORE_EXPAND_CALLS, PLOT_STAGE_LABEL, describeCalls } from '../../protocol';
import type {
  ArchitectureRow,
  CastConflictView,
  CastEntry,
  CreationTarget,
  FailureView,
  LoreThinEntry,
  LoreUnfiledEntry,
  ProjectPlotNode,
  ProjectDirNode,
  ProjectFile,
  ProjectNode,
  ProjectTree,
  VolumeView,
} from '../../protocol';
import { linkBtn } from '../buttons';
import { formatWords } from '../format';
import { openIdeaForm } from '../forms';
import { onContextMenu } from '../menu';
import { setPendingCommand } from '../composer';
import { openPath, store, vscode } from '../store';
import {
  baseMenuItems,
  characterAction,
  entryItems,
  expandLore,
  fileAction,
  newItemsIn,
  openDraft,
  projectAction,
} from './actions';
import type { Section } from './actions';
import { SECTIONS } from './actions';
import { showProjectTab } from './tabs';
import type { ProjectTab } from './tabs';
import { foldedVolumes, indentOf, lastTree, loreView, openFolders, openGroups } from './treeState';

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
export function failureMark(relPath: string): HTMLElement | null {
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

/** 切到某个顶层分组所在的页签，展开它并滚到它。重画会换掉全部节点，所以先重画再找。 */
function revealGroup(group: { id: string; tab: ProjectTab }): void {
  openGroups[group.id] = true;
  rerender();
  showProjectTab(group.tab);
  document.querySelector<HTMLElement>(`#projectBody [data-group="${group.id}"]`)?.scrollIntoView?.({ block: 'start' });
}

/**
 * 递归渲染一层节点，返回扁平的行数组。
 *
 * `section` 是角色区或设定区（工程页只有这两个区按目录树画），决定文件行怎么画与「在此新建」建什么；
 * `tree` 用来按 relPath 查出场统计 / 出现章。
 *
 * `match` 给了就是在筛选（「设定」组标题旁的筛选框）：只画匹配的文件，没有匹配的文件夹
 * 整个不画，有匹配的文件夹一律展开——匹配的那一条藏在折叠着的目录里，等于没筛出来。
 * 展开集合 `openFolders` 不动，清掉筛选就回到原来的开合。
 */
export function renderNodes(
  nodes: ProjectNode[],
  depth: number,
  section: Section,
  tree?: ProjectTree,
  match?: (f: ProjectFile) => boolean
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      if (match) {
        const inner = renderNodes(node.children, depth + 1, section, tree, match);
        if (inner.length > 0) {
          rows.push(buildFolderRow(node, depth, section, true), ...inner);
        }
        continue;
      }
      rows.push(buildFolderRow(node, depth, section));
      if (openFolders.has(node.relPath)) {
        rows.push(
          ...(node.children.length === 0
            ? [emptyRow('（空文件夹）', depth + 1)]
            : renderNodes(node.children, depth + 1, section, tree))
        );
      }
    } else if (match && !match(node)) {
      continue;
    } else if (section === SECTIONS.characters) {
      rows.push(buildCharacterRow(node, depth, tree));
    } else {
      rows.push(buildLoreRow(node, depth, tree));
    }
  }
  return rows;
}

/**
 * 文件夹行。点行体展开/折叠，其余操作走右键。折叠状态不进后端。
 *
 * `forced`：筛选中被强制展开的文件夹（见 `renderNodes`）。这时点它、右键「折叠」都没有
 * 看得见的效果（筛选不清，它就一直开着），所以干脆不挂——免得悄悄改掉清筛选之后的开合。
 */
function buildFolderRow(node: ProjectDirNode, depth: number, section: Section, forced = false): HTMLElement {
  const row = mk('div', `row row-dir${forced ? ' row-dir-forced' : ''}`);
  row.style.paddingLeft = `${indentOf(depth)}px`;
  const open = forced || openFolders.has(node.relPath);

  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);

  const label = mk('span', 'row-label row-dir-label', `${open ? '📂' : '📁'} ${node.label}`);
  label.title = forced ? `${node.relPath}\n筛选中：有匹配的文件夹一律展开` : node.relPath;
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
  if (!forced) {
    caret.addEventListener('click', toggle);
    label.addEventListener('click', toggle);
  }

  onContextMenu(row, () => {
    const head: MenuItem[] = forced ? [] : [{ label: open ? '折叠' : '展开', run: toggle }, { sep: true }];
    return [
      ...head,
      // 「在此新建」的落点是这个文件夹自己，不是区根目录。
      ...newItemsIn(section, node.relPath),
      { sep: true },
      ...entryItems(node.relPath),
    ];
  });
  return row;
}

/**
 * 点这一行（或右键第一项）打开哪一份文件：正文 → 细纲，取第一个存在的。
 * 两份都还没有时退回主路径（细纲应该在的位置）——打开它会得到一个「文件不存在」，
 * 但这一行本来就只在其中一份存在时才出现（空章号不补行）。
 */
function openTargetOf(p: ProjectPlotNode): string {
  return p.chapterPath || (p.plotExists ? p.plotPath : '') || p.relPath;
}

/**
 * 章节组的一行：**一个章号**。细纲号 = 章号，所以一行同时报细纲与正文两面：
 * 状态徽章说这一章该做哪一步，字数写着「写了多少 / 目标多少」，⟳ 说上游变过。
 *
 * **下一个该写的章**在行尾多一个「去写这一章」——树行一律不挂行内按钮，这是唯一的
 * 例外（W2）：扫一眼就知道从哪接着写，而且全书只有这一行有，不会变成一排按钮。
 * 它只是「进入这一章」，真正花钱的那一下仍然是对话页的主按钮（第 20 条：只推一个）。
 */
function buildPlotRow(p: ProjectPlotNode, nextNo: number, depth = 0): HTMLElement {
  // row-plot + data-plot 是悬停浮窗的抓手：事件委托在 projectBody 上，
  // 行被重渲染丢弃也不会留下失效的监听器。
  const row = mk('div', `row row-plot${p.no === nextNo ? ' row-next' : ''}`);
  row.dataset.plot = p.relPath;
  row.style.paddingLeft = `${indentOf(depth)}px`;

  // 圆点报定稿：细纲照正文更新过、而且对得上。还没写正文的章无从定稿——那不是「过期」，
  // 是还没到那一步，给它一个空心点会让整列看起来全是待办。
  const written = !!p.chapterPath && p.wordCount > 0;
  const dot = mk('span', `dot${written && p.stale ? ' stale' : ''}`, written ? (p.stale ? '○' : '●') : '·');
  dot.title = !written ? '还没写正文' : p.stale ? '还没同步（或同步之后正文又改过）' : '已同步（细纲与正文对得上）';
  row.appendChild(dot);

  // 生成失败过：与「过期」是两回事——过期只说明该重跑，这个说明跑过但没成。
  // 两侧路径都要查：定稿失败挂在正文上，写细纲/写正文失败挂在细纲上。
  const mark = (p.chapterPath ? failureMark(p.chapterPath) : undefined) ?? failureMark(p.plotPath);
  if (mark) {
    row.appendChild(mark);
  }

  const opens = openTargetOf(p);
  const label = mk('span', 'row-label', p.label);
  label.title = p.chapterPath
    ? `${p.chapterPath}\n点击打开正文，细纲并排在旁边（还没有就按模板建一份；上一次并排开的是草稿就开草稿）；右键「进入这一章」去做下一步`
    : `${opens}\n点击在编辑器里打开；右键「进入这一章」去做下一步`;
  // 点名字 = **打开这一章**（W6 章节工作台）：正文在主区、细纲并排在旁边。在工程页上扫
  // 章节列表时，想看的多半就是这一章写成了什么样、对不对得上细纲。并排是宿主的能力，
  // 由后端按能力决定开几份、旁边开细纲还是草稿（跟上一次走，细纲没有就按模板建）；「进入这一章」在右键菜单与行尾那颗按钮里。
  // 单击开成临时标签（下一次单击别的章换掉它），双击（第二下点击）开成正常标签——转正。
  label.addEventListener('click', (e) =>
    vscode.postMessage({ type: 'openChapter', plotRelPath: p.relPath, ...(e.detail < 2 ? { preview: true } : {}) })
  );
  row.appendChild(label);

  // 状态徽章：这一章现在该做哪一步。**已完成的不挂**——一列「已完成」只是噪声。
  if (p.stage !== 'done') {
    const stage = mk('span', `row-stage stage-${p.stage}`, PLOT_STAGE_LABEL[p.stage]);
    stage.title = describeProgress(p);
    row.appendChild(stage);
  }

  // 上游变过（大纲那一节 / 细纲改了）。用 ⟳ 而不是感叹号：这不是错误，
  // 是「回头看一眼」——与失败标记要分得开。
  if (p.upstreamStale) {
    const stale = mk('span', 'row-upstream', '⟳');
    stale.title = '上游产物改过，这一章可能需要回头看';
    row.appendChild(stale);
  }

  // 「2980 / 3000」比单报字数多说一件事：写够没有。字数后面跟「草稿」，不新增 DOM。
  const words =
    p.wordCount > 0
      ? p.targetWords
        ? `${p.wordCount} / ${p.targetWords}`
        : formatWords(p.wordCount)
      : '未写';
  row.appendChild(mk('span', 'meta', words + (p.hasDraft ? ' · 草稿' : '')));

  if (p.no === nextNo) {
    const go = mk('button', 'chip-btn row-go', '去写这一章');
    go.title = '进入这一章：对话页的主按钮就是它的下一步';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath });
    });
    row.appendChild(go);
  }

  onContextMenu(row, () => {
    // 打开哪一份：与点名字同序（正文 → 细纲），点行做的那件事在菜单里排第一。
    const items: MenuItem[] = [];
    if (p.chapterPath) {
      items.push({ label: '打开正文', run: () => openPath(p.chapterPath) });
    }
    if (p.plotExists) {
      items.push({ label: '打开细纲', run: () => openPath(p.plotPath) });
    }
    items.push(
      { sep: true },
      // 这一行唯一「会切页」的动作，单独一段。
      { label: '进入这一章', run: () => vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath }) },
      { sep: true },
      // 两层入口。点哪一层就把创作页切到那一层——状态机给的是「该做的下一步」，
      // 而作者常常要回头改上一层。
      { label: `细纲（${pct(p.progress.plot)}）`, run: () => setTarget({ kind: 'plot', plotRelPath: p.plotPath }) },
      {
        label: `正文（${pct(p.progress.manuscript)}）`,
        run: () => setTarget({ kind: 'manuscript', plotRelPath: p.plotPath }),
      },
      { sep: true }
    );

    // 重写、定稿、草稿都只对有正文的章成立——读的都是正文。
    if (written) {
      items.push({ label: '重写正文', run: () => rewriteManuscript(p.plotPath) });
      // 定稿 = 照正文更新细纲（带连续性事实）+ 出场角色的当前状态（四期，D17）+ 这一章在叙事线上发生了什么
      // （叙事线重做：认事件、当前进度、归并）。调用次数与主按钮同源。后端先弹确认框挑这一次的模型。
      items.push({
        label: p.stale ? `同步（细纲 + 角色状态 + 叙事线 + 故事时间，${describeCalls(FINALIZE_CALLS).replace(/（.*）$/, '')}）` : '重新同步',
        run: () => projectAction('askFinalizeChapter', p.chapterPath),
      });
      // 单独记设定（设定名录，作者定案）：只对定稿过、正文没再改过的章——没定稿的「设定」一节是计划，
      // 记了也会被定稿冲掉。定稿时本来就会顺手记，这里是重记一次、或补老章节。
      if (!p.stale) {
        items.push({ label: '记设定（调用模型 1 次）', run: () => projectAction('recordLore', p.chapterPath) });
      }
    }
    if (p.chapterPath) {
      // 草稿按需创建：没有就建一个再打开，文案据此区分。
      items.push({ label: p.hasDraft ? '打开草稿' : '新建草稿', run: () => openDraft(p.chapterPath) });
      items.push({ sep: true });
    }

    // 改名/删除落在**主路径**上：有正文就是正文（草稿跟着走），
    // 只有细纲就是细纲。**没有「移动到…」**：顺序由章号决定。
    items.push(
      { label: '重命名', run: () => fileAction('rename', p.relPath) },
      { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', p.relPath) }
    );
    return items;
  });
  return row;
}

/** 章节组的全部行。扁平列表——顺序即章号。 */
export function buildPlotRows(plots: ProjectPlotNode[], nextNo: number): HTMLElement[] {
  return plots.map((p) => buildPlotRow(p, nextNo));
}

/**
 * 分了卷的书（2026-10-23）：一卷一个可折叠的标题行，下面是这一卷的章，卷里照旧按章号。
 * 卷的先后、哪一卷是新章的落点都是后端排好的（`ProjectTree.volumes`）。
 */
export function buildVolumeRows(tree: ProjectTree): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const v of tree.volumes) {
    rows.push(buildVolumeRow(v, tree.chaptersRoot));
    if (foldedVolumes.has(v.relPath)) {
      continue;
    }
    const plots = tree.plots.filter((p) => p.volume === v.name);
    rows.push(
      ...(plots.length === 0
        ? [emptyRow(v.latest ? '（空卷：接下来新建的章落在这里）' : '（空卷）', 1)]
        : plots.map((p) => buildPlotRow(p, tree.nextChapterNo, 1)))
    );
  }
  return rows;
}

/**
 * 卷的标题行：`📂 第二卷  第 31–45 章 · 4.2 万字`。点行体折叠 / 展开，其余走右键。
 * 直接放在章节根下的那几章叫「未分卷」：它不是目录，右键没有重命名与删除。
 */
function buildVolumeRow(v: VolumeView, chaptersRoot: string): HTMLElement {
  const row = mk('div', `row row-dir row-volume${v.latest ? ' is-latest' : ''}`);
  row.dataset.volume = v.relPath;
  row.style.paddingLeft = `${indentOf(0)}px`;
  const open = !foldedVolumes.has(v.relPath);

  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);

  const label = mk('span', 'row-label row-dir-label', `${open ? '📂' : '📁'} ${v.name || '未分卷'}`);
  label.title = v.name ? v.relPath : `${v.relPath}/\n直接放在章节根下、不在哪一卷里的章`;
  row.appendChild(label);

  const span = v.from === undefined ? '空' : v.from === v.to ? `第 ${v.from} 章` : `第 ${v.from}–${v.to} 章`;
  const meta = mk('span', 'meta', `${span}${v.words > 0 ? ` · ${formatWords(v.words)}` : ''}${v.latest ? ' · 新章落这里' : ''}`);
  if (v.latest) {
    meta.title = '新建细纲、新建章节文件、拆细纲排出的新章默认落进这一卷';
  }
  row.appendChild(meta);

  const toggle = () => {
    if (foldedVolumes.has(v.relPath)) {
      foldedVolumes.delete(v.relPath);
    } else {
      foldedVolumes.add(v.relPath);
    }
    rerender();
  };
  caret.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  onContextMenu(row, () => [
    { label: open ? '折叠' : '展开', run: toggle },
    { sep: true },
    {
      label: v.name ? '在此卷新建章节文件' : '新建章节文件（不放进卷里）',
      run: () => projectAction('newChapter', undefined, v.relPath),
    },
    { label: '新建卷…', run: () => projectAction('newFolder', undefined, chaptersRoot) },
    // 卷就是一个目录：改名时细纲、草稿跟着走（网关的 carryPlot / carryDraft）；删除只把正文挪进回收站，
    // 细纲留着、退回那几章的计划（与删一章同一个规矩）。没有「移动到…」——卷不进卷。
    ...(v.name
      ? [
          { sep: true as const },
          { label: '重命名', run: () => fileAction('rename', v.relPath) },
          { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', v.relPath) },
        ]
      : []),
  ]);
  return row;
}

/**
 * 「故事架构」组的一行：小说配置 / 故事前提 / 角色图谱 / 世界观 / 设定清单 / 情节大纲。
 *
 * 点名字打开那份文件；角色图谱、设定清单没有自己的文件：已有卡 / 条目时点它切到「角色」/「设定」
 * 页签，还没有时进入那一层（对话页的主按钮是「生成角色图谱 / 设定清单」）。已填的右键「讨论」
 * 进入这一层，「重写…」问一句要求后直接重新生成；没填的右键「进入这一层」去生成。
 *
 * **第一件还没填的**在行尾多一个「去生成」（与章节组的「去写这一章」同一个道理：
 * 扫一眼就知道从哪接着做，全组只有这一行有）。小说配置那一行直接打开一句话弹窗；
 * 其余几行进入那一层，真正花钱的那一下仍是对话页的主按钮（第 20 条：只推一个）。
 */
function buildArchitectureRow(a: ArchitectureRow, isNext: boolean, tree?: ProjectTree): HTMLElement {
  const row = mk('div', 'row row-plot row-architecture');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', `dot${a.filled ? '' : ' stale'}`, a.filled ? '●' : '○');
  dot.title = a.filled ? '已填写' : '还没填写';
  row.appendChild(dot);

  const mark = failureMark(a.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const target: CreationTarget = a.key === 'outline' ? { kind: 'outline' } : { kind: 'setting', doc: a.key };
  // 没有自己文件的两件：它就是下面那一组。
  const group = GROUP_OF[a.key];
  const label = mk('span', 'row-label', a.label);
  label.title = !group
    ? a.relPath
    : a.filled
      ? `切到「${group.label}」页签；右键「讨论」或「重写…」`
      : '进入这一层：对话页的主按钮就是生成它';
  label.addEventListener('click', (e) => {
    if (!group) {
      openPath(a.relPath, { preview: e.detail < 2 });
    } else if (a.filled) {
      revealGroup(group);
    } else {
      setTarget(target);
    }
  });
  row.appendChild(label);

  if (a.detail) {
    row.appendChild(mk('span', 'meta row-detail', a.detail));
  }

  const idea = () => openIdeaForm(tree?.book);
  const fromText = !!tree?.book.writtenThrough;
  if (isNext) {
    const go = mk('button', 'chip-btn row-go', '去生成');
    go.title =
      a.key === 'config'
        ? fromText
          ? '定好规模，照已写正文生成小说配置'
          : '写一句话与规模，生成小说配置'
        : '进入这一层：对话页的主按钮就是生成它';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.key === 'config') {
        idea();
      } else {
        setTarget(target);
      }
    });
    row.appendChild(go);
  }

  onContextMenu(row, () => [
    ...(group ? [] : [{ label: '打开', run: () => openPath(a.relPath) }]),
    ...(a.key === 'config' ? [{ label: fromText ? '照已写正文生成…' : '从一句话生成…', run: idea }] : []),
    // 已填的：讨论只是进入这一层（不花钱），重写直接发一轮生成（先问一句要求，覆盖前照样对比）。
    ...(a.filled
      ? [
          { label: '讨论', run: () => setTarget(target) },
          { label: '重写…', run: () => vscode.postMessage({ type: 'rewriteArchitecture', target }) },
        ]
      : [{ label: '进入这一层（去生成）', run: () => setTarget(target) }]),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/**
 * 「故事架构」组的全部行。顺序即生成顺序：每一件都吃前面几件——所以「去生成」
 * 只挂在第一件没填的那一行上。
 */
export function buildArchitectureRows(rows: ArchitectureRow[], tree?: ProjectTree): HTMLElement[] {
  const next = rows.findIndex((r) => !r.filled);
  return rows.map((r, i) => buildArchitectureRow(r, i === next, tree));
}

/**
 * 没有自己文件的架构件 → 它在工程页上的那一组（分组 id 与 index.ts 的 `buildGroup` 一致）
 * 与那一组所在的页签。
 */
const GROUP_OF: Partial<Record<ArchitectureRow['key'], { id: string; label: string; tab: ProjectTab }>> = {
  characters: { id: 'characters', label: '角色', tab: 'characters' },
  lore: { id: 'lore', label: '设定', tab: 'lore' },
};

/** 三段完成度，鼠标移上去看得见。 */
function describeProgress(p: ProjectPlotNode): string {
  return (
    `${PLOT_STAGE_LABEL[p.stage]}\n` +
    `细纲 ${pct(p.progress.plot)}｜正文 ${pct(p.progress.manuscript)}｜同步 ${pct(p.progress.summary)}`
  );
}

function pct(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function setTarget(target: CreationTarget): void {
  vscode.postMessage({ type: 'setTarget', target });
}

/**
 * 章节右键「重写正文」：创作页切到这一章的正文层，输入框上方挂一枚「/重写正文」，等作者写下要求再点发送——
 * 不自己开写。正文已经有字，发出去的「写正文」后端就按重写走（`resolveWriteMode`），写完先对比再写入。
 */
function rewriteManuscript(plotRelPath: string): void {
  const target: CreationTarget = { kind: 'manuscript', plotRelPath };
  setTarget(target);
  // 正在生成时后端不切、说一句；这里也不挂，免得那一轮完了一发送就重写了别的章。
  if (!store.busy) {
    setPendingCommand({ capability: 'generate', label: '重写正文', stage: 'manuscript', target });
  }
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
  // 单击开成临时标签，双击转正（见章节那一行）。
  label.addEventListener('click', (e) => openPath(f.relPath, { preview: e.detail < 2 }));
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
 * 出场统计来自后端的 `castByCard`（按定稿过的细纲聚合），前端不自己算——
 * 「第 3、7、12 章」这句话在日志里也要出现，两处文案必须一致。
 */
function buildCharacterRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.castByCard[f.relPath] ?? null;
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
      items.push({ label: '未在同步过的章里出现，无法自动更新', disabled: true });
    }
    // 定稿时这张卡的当前状态你改过、没被覆盖（D15）：拿机器给的那一版对比，决定用不用。
    const guarded = lastTree?.failures?.[f.relPath]?.find((x) => x.op === 'cardState');
    if (guarded) {
      const no = /第 (\d+) 章/.exec(guarded.message)?.[1];
      items.push(
        { sep: true },
        { label: `对比第 ${no ?? '?'} 章给出的状态…`, run: () => characterAction('reviewState', f.label, f.relPath) }
      );
    }
    items.push({ sep: true }, ...entryItems(f.relPath));
    return items;
  });
  return row;
}

/**
 * 设定行。比普通文件行多两样东西：出现章（「第 3–57 章 · 12 章」）与「＋N」待整合标记。
 *
 * 出现章来自后端的 `loreByEntry`（`views/lore.ts` 从定稿过的细纲「设定」一节算的），前端不自己算——
 * 与角色行的 `castByCard` 同一个道理。副标题仍是那一句 brief（没有就是关键词，后端给好了）。
 *
 * 出现章**另起一格放在右边、不截断**，不像角色行那样并进副标题：brief 常常二三十字，
 * 并进同一格的话出现章永远被省略号吃掉，而几百条里扫一眼要看的恰恰是「哪条用得多、用到哪了」。
 * 被挤掉的是 brief，悬停浮窗（detailTip）照样看得全。
 *
 * 右键菜单在打开与类文件操作之间多两项：「整合这一条」（有待整合的才有）与「展开…」（每一条都有，完善设定）。
 */
function buildLoreRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.loreByEntry[f.relPath] ?? null;
  const row = buildFileRow(f, SECTIONS.lore.icon, depth);
  row.classList.add('row-lore');

  if (stats?.detail) {
    row.appendChild(mk('span', 'meta lore-span', stats.detail));
  }

  // 水位之后又有几章写到了它：与角色卡的「＋N」同一个样子——没跟上正文不是错误，是件待办。
  if (stats && stats.pending > 0) {
    const flag = mk('span', 'meta cast-pending lore-pending', `＋${stats.pending}`);
    flag.title =
      stats.updatedThrough > 0
        ? `第 ${stats.updatedThrough} 章之后又有 ${stats.pending} 章的新内容没整合进这一条`
        : `有 ${stats.pending} 章的新内容还没整合进这一条`;
    row.appendChild(flag);
  }
  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(f.relPath) },
    { sep: true },
    ...(stats && stats.pending > 0
      ? [
          {
            label: `整合这一条（新增 ${stats.pending} 章，${describeCalls(LORE_ENTRY_CALLS).replace(/（.*）$/, '')}）`,
            run: () => projectAction('integrateLore', f.relPath),
          },
        ]
      : []),
    expandItem({ relPath: f.relPath }),
    { sep: true },
    ...entryItems(f.relPath),
  ]);
  return row;
}

/**
 * 「展开…」那一项（完善设定，2026-10-19）：往前想细一条设定——后端先问一句要求，再在对话页把目标换成这一条、
 * 发一轮生成，写好的照常上卡片、作者点了才落盘。次数写法同「建条目」「整合这一条」（第 4 条：动手前写明）。
 */
function expandItem(target: Parameters<typeof expandLore>[0]): MenuItem {
  return { label: `展开…（${describeCalls(LORE_EXPAND_CALLS).replace(/（.*）$/, '')}）`, run: () => expandLore(target) };
}

/**
 * 「待完善」那一组的全部行（完善设定，2026-10-19）。后端按最早要用到的章排好；这一组只列接下来几章要用的，
 * 不会像「出现过 · 未建条目」那样拖一条长尾，不分页。
 */
export function buildLoreThinRows(list: LoreThinEntry[]): HTMLElement[] {
  return list.map(buildLoreThinRow);
}

/**
 * 「待完善」的一行：`天机阁〔宗门〕· 第 12 章起要用 · 只有一句话`。
 *
 * 往前看的一组：还没写的几章细纲「设定」一节点名、却还没有条目或条目还只有一句话的设定——与「出现过 · 未建条目」
 * （往回记）正好相反，所以排在它前面。有条目的点名字打开那一条（同别的设定行）；还没有条目的点名字不做事
 * （同未建条目：没有文件可开，也不该手一滑就多出一个）。右键「展开…」，没有条目的后端先按分类建空条目再展开。
 */
function buildLoreThinRow(t: LoreThinEntry): HTMLElement {
  const missing = !t.relPath;
  // 还没有条目的复用 row-cast 的压暗：同样是「还没有文件」的东西。
  const row = mk('div', `row row-lore-thin${missing ? ' row-cast' : ''}`);
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', missing ? '○' : SECTIONS.lore.icon);
  dot.title = missing ? '接下来要用，还没有设定条目' : '接下来要用，条目还只有一句话';
  row.appendChild(dot);

  if (t.relPath) {
    const mark = failureMark(t.relPath);
    if (mark) {
      row.appendChild(mark);
    }
  }

  const label = mk('span', 'row-label', t.name);
  label.title = `第 ${t.chapters.join('、')} 章要用到\n右键「展开…」把它往前想细`;
  if (t.relPath) {
    const relPath = t.relPath;
    label.addEventListener('click', (e) => openPath(relPath, { preview: e.detail < 2 }));
  }
  row.appendChild(label);

  if (t.category) {
    row.appendChild(mk('span', 'meta lore-category', `〔${t.category}〕`));
  }
  row.appendChild(mk('span', 'meta row-detail', t.detail));

  onContextMenu(row, () => [
    ...(t.relPath ? [{ label: '打开', run: () => openPath(t.relPath!) }, { sep: true as const }] : []),
    expandItem(t.relPath ? { relPath: t.relPath } : { name: t.name, category: t.category }),
    { label: `要用到：第 ${t.chapters.join('、')} 章`, disabled: true },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/**
 * 「出场人物 · 未建卡」的一行。
 *
 * 只有一个动作：建卡（先建一张空卡，再问要不要用它的出场段落跑一次提取），在右键里。
 * 与「出现过 · 未建条目」一样**点名字不做事**：从前点名字就建卡，扫列表时手一滑角色区就多出
 * 一张空卡，后面那一问取消了它也留着。
 */
export function buildCastRow(c: CastEntry): HTMLElement {
  const row = mk('div', 'row row-cast');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', '○');
  dot.title = '同步过的章里出现过，还没有角色卡';
  row.appendChild(dot);

  const label = mk('span', 'row-label', c.name);
  label.title = `${c.aliases.length > 0 ? `又称 ${c.aliases.join('、')}\n` : ''}右键「创建角色卡」`;
  row.appendChild(label);
  row.appendChild(mk('span', 'meta row-detail', c.detail));

  onContextMenu(row, () => [
    { label: '创建角色卡（通读出场段落）', run: () => characterAction('createCard', c.name) },
    { label: `出场：${c.detail}`, disabled: true },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 「出现过 · 未建条目」一次先画这么多行，再多的收在「显示全部 N 个」后面。 */
const UNFILED_PAGE = 30;

/**
 * 「出现过 · 未建条目」那一组的全部行。
 *
 * 设定会比角色多一个数量级：后端按出现章数降序排好，前面那几十个才是真该建条目的，
 * 长尾（只出现过一两次的地名、物件）一口气摊开会把下面「文风与摘要」顶出好几屏。
 * 点过「显示全部」记在 `loreView` 上，重推树不缩回去。
 */
export function buildLoreUnfiledRows(list: LoreUnfiledEntry[], loreRoot: string): HTMLElement[] {
  const shown = loreView.showAllUnfiled ? list : list.slice(0, UNFILED_PAGE);
  const rows = shown.map((u) => buildLoreUnfiledRow(u, loreRoot));
  if (shown.length < list.length) {
    // 不是 `.row`：它不是名录里的一项，没有右键菜单，也不该被「这一组有几行」数进去。
    const more = mk('div', 'hint row-empty row-more');
    more.appendChild(
      linkBtn(`显示全部 ${list.length} 个`, () => {
        loreView.showAllUnfiled = true;
        rerender();
      })
    );
    rows.push(more);
  }
  return rows;
}

/**
 * 「出现过 · 未建条目」的一行：`名〔分类〕· 5 章 · 第 3 章起`。
 *
 * 两个动作，都在右键里：「建条目」调模型一次，拿定稿细纲里提到它的那几行写成一条（不重读正文）；
 * 「新建这条设定」带着名字发 `newLore`，建一份空条目、不调模型。都落在建议的分类目录里
 * （各章「设定」一节写的多数票；目录还没有时后端会建）。
 * 与「出场人物 · 未建卡」不同，**点名字不做事**：扫列表时手一滑就在设定区里多出一个文件，
 * 不值得放在最省事的位置。
 */
function buildLoreUnfiledRow(u: LoreUnfiledEntry, loreRoot: string): HTMLElement {
  // 复用 row-cast 的压暗：同样是「出现过、还没有文件」的东西。
  const row = mk('div', 'row row-cast row-lore-unfiled');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', '○');
  dot.title = '同步过的章里出现过，还没有设定条目';
  row.appendChild(dot);

  const label = mk('span', 'row-label', u.name);
  label.title = `${u.chapters.length > 0 ? `出现在第 ${u.chapters.join('、')} 章\n` : ''}右键「建条目」或「新建这条设定」`;
  row.appendChild(label);

  if (u.category) {
    row.appendChild(mk('span', 'meta lore-category', `〔${u.category}〕`));
  }
  row.appendChild(mk('span', 'meta row-detail', u.detail));

  const sub = u.category.replace(/^\/+|\/+$/g, '');
  const dir = sub ? `${loreRoot}/${sub}` : loreRoot;
  onContextMenu(row, () => [
    {
      label: `建条目（${describeCalls(LORE_ENTRY_CALLS).replace(/（.*）$/, '')}）`,
      run: () => projectAction('buildLore', undefined, undefined, u.name),
    },
    { label: '新建这条设定（空的，不调模型）', run: () => projectAction('newLore', undefined, dir, u.name) },
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
