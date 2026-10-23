/**
 * 工程页里除了树行以外的东西：可折叠分组、定稿进度横幅，
 * 以及「文风与摘要」那两行固定文件。
 */
import { el as mk, spacer } from '../../dom';
import type { MenuItem } from '../../globals';
import type { ProjectNode, ProjectTree } from '../../protocol';
import { linkBtn } from '../buttons';
import { onContextMenu } from '../menu';
import { openPath } from '../store';
import { hasTask } from '../tasks';
import { baseMenuItems, newItemsIn, projectAction } from './actions';
import type { Section } from './actions';
import { buildFileRow } from './rows';
import { openGroups } from './treeState';

interface GroupOptions {
  /** 给了 section + root 的分组，标题栏与空白处右键能「在此新建」。 */
  section?: Section;
  root?: string;
  /**
   * 排在新建项之前的额外菜单项（如角色区的批量动作）。
   * 没有 `section` 的分组只挂这些 + 通用项，所以自带的分隔线要自己写。
   */
  extraItems?: () => MenuItem[];
  /**
   * 标题栏上折叠开关之外的一样东西（「设定」组的筛选框、「叙事线」组的「从大纲排出」）。挂在开关**旁边**而不是里面：
   * 开关是一颗 `<button>`，放进去的话点输入框、在里面按空格回车都会把组折起来。
   */
  head?: HTMLElement;
  /**
   * 这一组是某个页签的主分组时传那一页的容器：页里分组下面的空白处右键也给这一组的菜单
   * （「角色」页空白处右键就能「在此新建角色卡」）。
   */
  panel?: HTMLElement;
  /** 惰性调用：折叠时不生成行。 */
  build: () => HTMLElement[];
}

/**
 * 可折叠分组。
 *
 * 三个可管理区（给了 `section` + `root`）在标题栏与分组空白处右键能
 * 「在此新建」，落点是该区根目录；行上的右键各自登记，会先命中。
 */
export function buildGroup(
  id: string,
  label: string,
  description: string,
  opts: GroupOptions
): HTMLElement {
  const box = mk('div', 'group');
  box.dataset.group = id;

  const head = mk('div', 'group-head');
  // 折叠开关吃掉整行的可点面积：标题栏上除了它只有 `opts.head`（筛选框），点别处都能折叠。
  const toggle = mk('button', 'group-toggle');
  const caret = mk('span', 'caret', openGroups[id] ? '▾' : '▸');
  toggle.appendChild(caret);
  toggle.appendChild(mk('span', 'group-name', label));
  toggle.appendChild(mk('span', 'meta', description));
  head.appendChild(toggle);
  if (opts.head) {
    head.appendChild(opts.head);
  }
  box.appendChild(head);

  const body = mk('div', 'group-body');
  box.appendChild(body);

  // 登记在整个分组上：标题栏、分组内的空白、空提示行都能右键。
  const menu = opts.section
    ? () => [
        ...(opts.extraItems?.() ?? []),
        ...newItemsIn(opts.section!, opts.root),
        { sep: true as const },
        ...baseMenuItems(),
      ]
    : opts.extraItems
      ? // 没有落点目录的分组（「出场人物 · 未建卡」）：只挂批量动作与通用项。
        () => [...(opts.extraItems?.() ?? []), ...baseMenuItems()]
      : undefined;
  if (menu) {
    onContextMenu(box, menu);
    if (opts.panel) {
      onContextMenu(opts.panel, menu);
    }
  }

  const sync = () => {
    caret.textContent = openGroups[id] ? '▾' : '▸';
    body.innerHTML = '';
    if (!openGroups[id]) {
      return;
    }
    for (const row of opts.build()) {
      body.appendChild(row);
    }
  };
  toggle.addEventListener('click', () => {
    openGroups[id] = !openGroups[id];
    sync();
  });
  sync();
  return box;
}

/** 还不是小说工程时的引导。 */
export function buildInitPrompt(): HTMLElement {
  const box = mk('div', 'project-empty');
  box.appendChild(mk('p', undefined, '当前工作区还不是 Novel Forge 小说工程。'));

  const btn = mk('button', 'primary', '初始化小说工程');
  btn.addEventListener('click', () => projectAction('initProject'));
  box.appendChild(btn);

  box.appendChild(mk('p', 'hint', '会创建 chapters/ 与 .novelforge/ 目录及模板文件。'));
  return box;
}

/**
 * 定稿进度横幅，在「概览」页的最上面。
 *
 * 只说「76 章还没定稿」的话，用户不知道分母，也看不出同步跑到哪了。
 * 这里给出「已定稿 N/M」与一条进度条，同步过程中每章刷新一次
 * （后端 pushState 会重推整棵树）。
 *
 * 分母是**已有正文的章**（`summarizedCount + staleCount`），不是全部章：
 * 只有细纲、还没写正文的章无从定稿，算进分母会让进度条永远到不了头。
 */
export function buildSummaryBanner(tree: ProjectTree): HTMLElement {
  const banner = mk('div', 'banner banner-summary');

  const line = mk('div', 'banner-line');
  line.appendChild(
    mk('span', undefined, `${tree.staleCount} 章写了正文还没同步（或同步之后正文又改过），这些章的连续性事实与出场人物不会进入上下文。`)
  );
  line.appendChild(spacer());
  // 同步在跑时不再显示「立即同步」——点第二次只会撞上「已有任务在进行」。
  // 任务名与 features/summarize.ts 的 runTask 名字必须一字不差，否则这里
  // 永远匹配不上，横幅上会一直挂着一个点了就报错的按钮。
  if (!hasTask('同步章节细纲')) {
    line.appendChild(linkBtn('立即同步', () => projectAction('syncSummaries')));
  }
  banner.appendChild(line);

  const done = tree.summarizedCount;
  const total = done + tree.staleCount;
  if (total > 0) {
    const percent = Math.round((done / total) * 100);
    const bar = mk('div', 'sum-bar');
    const fill = mk('div', 'sum-fill');
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    banner.appendChild(bar);
    banner.appendChild(mk('div', 'meta sum-meta', `已同步 ${done} / ${total} 章（${percent}%）`));
  }
  return banner;
}

/** 分组副标题：待办数与总量一起给，不必展开就知道定稿覆盖到什么程度。 */
export function summaryGroupLabel(tree: ProjectTree): string {
  const total = tree.summarizedCount + tree.staleCount;
  if (total === 0) {
    return tree.plotCount === 0 ? '还没有章节' : '还没有正文';
  }
  return tree.staleCount > 0
    ? `已同步 ${tree.summarizedCount}/${total} 章 · ${tree.staleCount} 章待同步`
    : `${total} 章已全部同步`;
}

/** 顶层分组的副标题：文件总数（含子文件夹里的）。 */
export function countLabel(nodes: ProjectNode[], unit: string): string {
  let files = 0;
  let folders = 0;
  const walk = (list: ProjectNode[]) => {
    for (const n of list) {
      if (n.kind === 'dir') {
        folders++;
        walk(n.children);
      } else {
        files++;
      }
    }
  };
  walk(nodes);
  return folders > 0 ? `${files} ${unit} · ${folders} 个文件夹` : `${files} ${unit}`;
}

/**
 * 「文风与摘要」那一组：全文大纲、文风指南两行。情节大纲在「故事架构」那一组，叙事线在自己的页签。
 *
 * 这几行是工程的固定文件，不给类文件操作（`buildFileRow` 不传 depth 即可），
 * 但它们的「重建」「从正文提取」是常用动作，照旧留在行内（悬停才亮）。
 *
 * 从前这一组底下还有一行工具（同步过期细纲、提取/更新角色卡，右键再加批量拆细纲、批量写章），
 * 是单章摘要时代留下的：细纲并进 summaries/ 之后只改了字没挪地方，四件事在别处都有入口——
 * 同步在「概览」页顶的黄条上，提取角色卡在「角色」组右键，两个批量在「章节」组右键。
 */
export function buildMetaRows(tree: ProjectTree): HTMLElement[] {
  const rows: HTMLElement[] = [];

  const global = buildFileRow(
    {
      label: '全文大纲',
      relPath: tree.globalSummaryPath,
      // `globalSummaryThrough` 记的是**章号**。
      detail:
        tree.globalSummaryThrough > 0
          ? `覆盖至第 ${tree.globalSummaryThrough} 章${
              tree.globalSummaryThrough < tree.plotCount ? ' ⚠ 落后于正文' : ''
            }`
          : '未生成',
    },
    '📖'
  );
  global.appendChild(rowActions(linkBtn('重建', () => projectAction('rebuildGlobalSummary'))));
  onContextMenu(global, () => [
    { label: '打开', run: () => openPath(tree.globalSummaryPath) },
    { label: '重建全文大纲', run: () => projectAction('rebuildGlobalSummary') },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(global);

  const style = buildFileRow({ label: '文风指南', relPath: tree.styleGuidePath, detail: '' }, '🎨');
  style.appendChild(
    rowActions(
      linkBtn('从正文提取', () => projectAction('extractStyle')),
      linkBtn('从参考书学', () => projectAction('learnFromReference'))
    )
  );
  onContextMenu(style, () => [
    { label: '打开', run: () => openPath(tree.styleGuidePath) },
    { label: '从正文提取文风', run: () => projectAction('extractStyle') },
    // 别人的书放进工程：只学怎么写——文风写这里，结构与节奏写成一份「规划」阶段的技能。
    { label: '从参考书学写法（选一本 txt）…', run: () => projectAction('learnFromReference') },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(style);

  // 情节大纲不在这一组：它是「故事架构」那一组的第六行（后面一切的上游）。叙事线也不在：它单占一个页签
  // （叙事线重做第 8 个提交，`threads.ts`），从前这一组里那一行计数删了。

  return rows;
}

/** 行内操作的容器。平时藏起来，hover 才亮。 */
function rowActions(...buttons: HTMLElement[]): HTMLElement {
  const box = mk('span', 'row-actions');
  box.append(...buttons);
  return box;
}
