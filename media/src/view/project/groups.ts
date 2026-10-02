/**
 * 工程页里除了树行以外的东西：可折叠分组、工程标题头、摘要进度横幅，
 * 以及「文风与摘要」那几行固定文件。
 */
import { el as mk, spacer } from '../../dom';
import type { MenuItem } from '../../globals';
import type { ProjectNode, ProjectTree, ThreadsView } from '../../protocol';
import { linkBtn } from '../buttons';
import { formatWords } from '../format';
import { onContextMenu } from '../menu';
import { openWriteBatchForm } from '../forms';
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

  const head = mk('div', 'group-head');
  // 折叠开关吃掉整行的可点面积：标题栏上现在只有它，点哪儿都能折叠。
  const toggle = mk('button', 'group-toggle');
  const caret = mk('span', 'caret', openGroups[id] ? '▾' : '▸');
  toggle.appendChild(caret);
  toggle.appendChild(mk('span', 'group-name', label));
  toggle.appendChild(mk('span', 'meta', description));
  head.appendChild(toggle);
  box.appendChild(head);

  const body = mk('div', 'group-body');
  box.appendChild(body);

  if (opts.section) {
    // 登记在整个分组上：标题栏、分组内的空白、空提示行都能右键新建。
    onContextMenu(box, () => [
      ...(opts.extraItems?.() ?? []),
      ...newItemsIn(opts.section!, opts.root),
      { sep: true },
      ...baseMenuItems(),
    ]);
  } else if (opts.extraItems) {
    // 没有落点目录的分组（「出场人物 · 未建卡」）：只挂批量动作与通用项。
    onContextMenu(box, () => [...(opts.extraItems?.() ?? []), ...baseMenuItems()]);
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

export function buildProjectHead(tree: ProjectTree): HTMLElement {
  const head = mk('div', 'project-head');
  head.appendChild(mk('div', 'project-title', tree.title || '未命名'));
  // 字数是各章正文的字数之和（见 projectView），细纲不算。
  head.appendChild(
    mk(
      'div',
      'meta',
      [tree.author, `${tree.plotCount} 章`, formatWords(tree.totalWords)].filter(Boolean).join(' · ')
    )
  );
  if (tree.staleCount > 0) {
    head.appendChild(buildSummaryBanner(tree));
  }
  return head;
}

/**
 * 摘要进度横幅。
 *
 * 只说「76 章摘要缺失或已过期」的话，用户不知道分母，也看不出同步跑到哪了。
 * 这里给出「已完成 N/M」与一条进度条，同步过程中每章刷新一次
 * （后端 pushState 会重推整棵树）。
 *
 * 分母是**已有正文的章**（`summarizedCount + staleCount`），不是全部章：
 * 只有细纲、还没写正文的章没有摘要是正常的，算进分母会让进度条永远到不了头。
 */
function buildSummaryBanner(tree: ProjectTree): HTMLElement {
  const banner = mk('div', 'banner banner-summary');

  const line = mk('div', 'banner-line');
  line.appendChild(
    mk('span', undefined, `${tree.staleCount} 章摘要缺失或已过期，这些章的剧情不会进入上下文。`)
  );
  line.appendChild(spacer());
  // 同步在跑时不再显示「立即同步」——点第二次只会撞上「已有任务在进行」。
  // 任务名与 features/summarize.ts 的 runTask 名字必须一字不差，否则这里
  // 永远匹配不上，横幅上会一直挂着一个点了就报错的按钮。
  if (!hasTask('同步章节摘要')) {
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
    banner.appendChild(mk('div', 'meta sum-meta', `已总结 ${done} / ${total} 章（${percent}%）`));
  }
  return banner;
}

/** 分组副标题：待办数与总量一起给，不必展开就知道摘要覆盖到什么程度。 */
export function summaryGroupLabel(tree: ProjectTree): string {
  const total = tree.summarizedCount + tree.staleCount;
  if (total === 0) {
    return tree.plotCount === 0 ? '还没有章节' : '还没有正文';
  }
  return tree.staleCount > 0
    ? `已总结 ${tree.summarizedCount}/${total} 章 · ${tree.staleCount} 章待总结`
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
 * 「文风与摘要」那一组：全书摘要、文风指南、叙事线，外加一行批量动作（同步过期摘要、提取角色卡、
 * 批量拆细纲、批量写章）。情节大纲在「故事架构」那一组。
 *
 * 这几行是工程的固定文件，不给类文件操作（`buildFileRow` 不传 depth 即可），
 * 但它们的「重建」「从正文提取」是常用动作，照旧留在行内。
 */
export function buildMetaRows(tree: ProjectTree): HTMLElement[] {
  const rows: HTMLElement[] = [];

  const global = buildFileRow(
    {
      label: '全书摘要',
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
    { label: '重建全书摘要', run: () => projectAction('rebuildGlobalSummary') },
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
    { label: '从参考书学写法（工程里的 txt）…', run: () => projectAction('learnFromReference') },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(style);

  rows.push(buildThreadsRow(tree));

  // 情节大纲不在这一组：它是「故事架构」那一组的第五行（后面一切的上游）。

  const tools = mk('div', 'row row-tools');
  tools.appendChild(
    linkBtn(
      tree.staleCount > 0 ? `同步 ${tree.staleCount} 章过期摘要` : '同步过期摘要',
      () => projectAction('syncSummaries')
    )
  );
  tools.appendChild(linkBtn('提取/更新角色卡', () => projectAction('extractCharacters')));
  onContextMenu(tools, () => [
    { label: '同步过期摘要', run: () => projectAction('syncSummaries') },
    { label: '提取/更新角色卡', run: () => projectAction('extractCharacters') },
    { sep: true },
    // 两个批量动作都「只补不改」：已经有产物的章一律跳过。批量路径上
    // 没有逐个审阅的余地，跳过是唯一安全的做法。批量写章先开弹窗选区间与模式（W9）。
    { label: '批量拆细纲（只补缺）', run: () => projectAction('generatePlots') },
    { label: '批量写章…', run: () => openWriteBatchForm(tree) },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(tools);

  return rows;
}

const NO_THREADS: ThreadsView = { exists: false, total: 0, open: 0, closed: 0, overdue: 0 };

/**
 * 「叙事线」一行（七期）：可选的固定文件，与全书摘要同类，不进「故事架构」的 x/5——它不挡路。
 *
 * 还没有细纲时没有东西可排，不给按钮；排线在跑时也不给（点第二次只会撞上「已有任务在
 * 进行」）。任务名与 features/threads.ts 的 runTask 一字不差。按钮不直接花钱：后端先弹确认框，
 * 写明 1 次调用。
 */
function buildThreadsRow(tree: ProjectTree): HTMLElement {
  const th = tree.threads ?? NO_THREADS;
  const canPlan = (tree.book?.plotFilledNos ?? []).length > 0;
  const detail =
    th.total === 0
      ? canPlan
        ? '未生成'
        : '未生成 · 拆出细纲之后可以从细纲排出'
      : [
          `${th.total} 条`,
          `${th.open} 条进行中`,
          th.closed > 0 ? `${th.closed} 条已收` : '',
          th.overdue > 0 ? `⚠ ${th.overdue} 条已过回收章` : '',
        ]
          .filter(Boolean)
          .join(' · ');
  const row = buildFileRow({ label: '叙事线', relPath: tree.threadsPath, detail }, '🧵', undefined, {
    openable: th.exists,
  });
  const verb = th.total === 0 ? '从细纲排出' : '从细纲补充';
  if (canPlan && !hasTask('排叙事线')) {
    row.appendChild(rowActions(linkBtn(verb, () => projectAction('generateThreads'))));
  }
  onContextMenu(row, () => {
    const items: MenuItem[] = [];
    if (th.exists) {
      items.push({ label: '打开', run: () => openPath(tree.threadsPath) });
    }
    if (canPlan) {
      items.push({ label: `${verb}叙事线`, run: () => projectAction('generateThreads') });
    }
    return [...items, ...(items.length > 0 ? [{ sep: true as const }] : []), ...baseMenuItems()];
  });
  return row;
}

/** 行内操作的容器。平时藏起来，hover 才亮。 */
function rowActions(...buttons: HTMLElement[]): HTMLElement {
  const box = mk('span', 'row-actions');
  box.append(...buttons);
  return box;
}
