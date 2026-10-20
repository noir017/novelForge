/**
 * 工程页的装配：把树、分组、横幅拼成四个页签（概览 / 章节 / 角色 / 设定，见 tabs.ts）。
 *
 * 折叠等 UI 状态完全留在前端（treeState.ts），切一下折叠走 `rerenderProject`
 * 拿最近那份快照重画，不必往后端要一次数据。「设定」组的筛选也一样（loreFilter.ts）。
 */
import { setHidden } from '../../dom';
import { describeCalls, loreExpandCalls } from '../../protocol';
import type { ProjectTree } from '../../protocol';
import { formatWords } from '../format';
import { el } from '../refs';
import { SECTIONS, characterAction, projectAction } from './actions';
import {
  buildGroup,
  buildInitPrompt,
  buildMetaRows,
  buildSummaryBanner,
  countLabel,
  summaryGroupLabel,
} from './groups';
import {
  bindRerender,
  buildArchitectureRows,
  buildCastRow,
  buildConflictRow,
  buildLoreThinRows,
  buildLoreUnfiledRows,
  buildPlotRows,
  emptyRow,
  renderNodes,
} from './rows';
import { openIdeaForm, openPlotBatchForm, openWriteBatchForm } from '../forms';
import { charactersEmptyRow, loreEmptyRow, nextStepRow } from './nextSteps';
import { hideDetailTip, installDetailTip } from './detailTip';
import { hideFailureTip, installFailureTip } from './errorTip';
import {
  buildLoreFilter,
  captureLoreFilterFocus,
  filterUnfiled,
  loreFilterComposing,
  loreMatcher,
  restoreLoreFilterFocus,
} from './loreFilter';
import { hideSummaryTip, installSummaryTip } from './summaryTip';
import { buildPanel, installProjectTabs } from './tabs';
import { lastTree, loreView, setLastTree } from './treeState';

export function renderProject(tree: ProjectTree): void {
  setLastTree(tree);
  // 筛选框里正在用输入法组字：这时重画会换掉输入框、打了一半的字就没了。树先记下，
  // 组字结束时（loreFilter.ts 的 compositionend）按最新的这一份重画。
  if (loreFilterComposing()) {
    return;
  }
  // 整页重建会换掉筛选框：焦点在里面（正打着字、旁边又推来一棵树）就把焦点与光标放回去。
  const focus = captureLoreFilterFocus();
  buildProjectPage(tree);
  restoreLoreFilterFocus(focus);
}

function buildProjectPage(tree: ProjectTree): void {
  el.projectBody.innerHTML = '';
  // 全部行都被换掉了，开着的浮窗指向的是已丢弃的节点。
  hideSummaryTip();
  hideDetailTip();
  hideFailureTip();
  // 还不是小说工程时，页签切过去都是空的。
  setHidden(el.projectTabs, !tree.initialized);

  if (!tree.initialized) {
    el.projectBody.appendChild(buildInitPrompt());
    return;
  }

  const overview = buildPanel('overview');
  const chapters = buildPanel('chapters');
  const characters = buildPanel('characters');
  const lore = buildPanel('lore');
  el.projectBody.append(overview, chapters, characters, lore);

  if (tree.staleCount > 0) {
    overview.appendChild(buildSummaryBanner(tree));
  }

  // 故事架构：后面一切的上游，排在最前面。
  const filled = tree.architecture.filter((a) => a.filled).length;
  overview.appendChild(
    buildGroup('architecture', '故事架构', `${filled}/${tree.architecture.length}`, {
      extraItems: () => [
        { label: tree.book.writtenThrough ? '照已写正文生成小说配置…' : '从一句话生成小说配置…', run: () => openIdeaForm(tree.book) },
        // 只补空白：已经有的那几件不动、不问（第 19 条的批量那一面）。
        { label: '补齐架构（只补空白）', run: () => projectAction('completeSettings') },
        // 已经有正文（导入的原稿、老工程）：照正文整理，不从一句话重新编。两次确认，次数在框里。
        { label: '从已写正文补齐（细纲、角色卡、架构、大纲）…', run: () => projectAction('deriveFromText') },
        { sep: true },
      ],
      build: () => buildArchitectureRows(tree.architecture, tree),
    })
  );

  overview.appendChild(
    buildGroup('meta', '文风与摘要', summaryGroupLabel(tree), {
      build: () => buildMetaRows(tree),
    })
  );

  // 一个章号一行（细纲号 = 章号）。细纲与正文是同一行的两面。
  chapters.appendChild(
    buildGroup('plots', '章节', `${tree.chapterCount} 章 · ${formatWords(tree.totalWords)}`, {
      panel: chapters,
      extraItems: () => [
        { label: '新建细纲（接在最后一章之后）', run: () => projectAction('newPlot') },
        { label: '新建章节文件（直接粘正文用）', run: () => projectAction('newChapter') },
        // 分卷目录建在章节根下（工具栏的「＋ 文件夹」拿掉之后，独立版只剩这一个入口）。这一组按章号平铺、
        // 不画目录，空目录在这里看不见；章节放进去之后，新的一章跟上一章落进同一个卷目录。
        { label: '在此新建文件夹', run: () => projectAction('newFolder', undefined, tree.chaptersRoot) },
        // 整本 txt 放进工程之后切成章（零调用；后端弹框挑文件、报切分结果）。
        { label: '导入原稿（选一本 txt）…', run: () => projectAction('importManuscript') },
        { sep: true },
        // 两个批量动作都「只补不改」：已经有产物的章一律跳过。都先开弹窗选区间。
        { label: '批量拆细纲…', run: () => openPlotBatchForm(tree) },
        { label: '批量写章…', run: () => openWriteBatchForm(tree) },
        { sep: true },
      ],
      build: () => {
        // 空分组与「下一章还没有细纲那一行」（拆细纲那一档）都写出全书的下一步（W12）。
        // 有下一章那一行时它自己带「去写这一章」，不再多说一句。
        if (tree.plots.length === 0) {
          return [
            tree.next
              ? nextStepRow(tree.next, tree)
              : emptyRow('还没有章节。先把故事架构与情节大纲写好，再拆出细纲；已经有写好的稿子，就把 txt 放进工程，右键「导入原稿」。'),
          ];
        }
        const rows = buildPlotRows(tree.plots, tree.nextChapterNo);
        const hasNextRow = tree.plots.some((p) => p.no === tree.nextChapterNo);
        return !hasNextRow && tree.next ? [...rows, nextStepRow(tree.next, tree)] : rows;
      },
    })
  );

  characters.appendChild(
    buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
      section: SECTIONS.characters,
      root: tree.charactersRoot,
      panel: characters,
      extraItems: () => [
        { label: '更新所有角色卡', run: () => characterAction('updateAllCards') },
        { label: '从头重建所有角色卡', run: () => characterAction('rebuildAllCards') },
        // 挑几章正文一次提一批（新角色直接建，已有的走对比）。不依赖定稿，上面两条依赖。
        { label: '提取/更新角色卡（挑几章正文）…', run: () => projectAction('extractCharacters') },
        { sep: true },
        { label: '清理别名（删掉「她」「姐姐」这类泛称）', run: () => characterAction('cleanAliases') },
        { label: '查找并合并重复角色卡', run: () => characterAction('mergeDuplicates') },
        { sep: true },
      ],
      build: () => [
        // 冲突排在最前面：它说明这棵树上的出场统计有一处是错的。
        ...tree.castConflicts.map(buildConflictRow),
        ...(tree.characters.length === 0
          ? [charactersEmptyRow(tree)]
          : renderNodes(tree.characters, 0, SECTIONS.characters, tree)),
      ],
    })
  );

  // 定稿过的细纲里出现、但还没建卡的人物。单独一组而不是混进角色树——
  // 那棵是文件树（能改名/移动/删除），这些人还没有文件。
  if (tree.cast.length > 0) {
    characters.appendChild(
      buildGroup('cast', '出场人物 · 未建卡', `${tree.cast.length} 人`, {
        extraItems: () => [
          { label: `给全部 ${tree.cast.length} 人建卡`, run: () => characterAction('createAllCards') },
          { sep: true },
        ],
        build: () => tree.cast.map(buildCastRow),
      })
    );
  }

  // 设定名录（第九节攒出来的）：已建条目是按目录（= 分类）分组的树，每行带出现章与待整合；
  // 标题旁一个筛选框，几百条时不用一层层翻目录。
  const unfiledAll = tree.loreUnfiled;
  const thinAll = tree.loreThin;
  const match = loreMatcher(tree);
  // 没东西可筛就不摆框；正筛着的时候哪怕条目都没了也留着，不然筛选串看不见、也清不掉。
  const showFilter = tree.lore.length > 0 || unfiledAll.length > 0 || thinAll.length > 0 || loreView.filter !== '';
  lore.appendChild(
    buildGroup('lore', '设定', countLabel(tree.lore, '条'), {
      section: SECTIONS.lore,
      root: tree.loreRoot,
      panel: lore,
      // 设定名录的三件维护（第三期）。次数都在后端的确认框里报，这里只说有几件待办。
      extraItems: () => {
        const unrecorded = tree.loreUnrecorded;
        const pending = Object.values(tree.loreByEntry).filter((s) => s.pending > 0).length;
        const items = [
          ...(unrecorded > 0
            ? [{ label: `补记设定（${unrecorded} 章定稿过、还没记）`, run: () => projectAction('recordLore') }]
            : []),
          ...(pending > 0
            ? [{ label: `整合设定（${pending} 条有新内容）`, run: () => projectAction('integrateLore') }]
            : []),
          ...(tree.lore.length > 0 ? [{ label: '按目录整理…', run: () => projectAction('organizeLore') }] : []),
        ];
        return items.length > 0 ? [...items, { sep: true as const }] : [];
      },
      head: showFilter ? buildLoreFilter(rerenderProject) : undefined,
      build: () => {
        if (tree.lore.length === 0) {
          return [loreEmptyRow(tree)];
        }
        const rows = renderNodes(tree.lore, 0, SECTIONS.lore, tree, match);
        if (rows.length === 0 && match) {
          const none = emptyRow('没有匹配的设定');
          none.classList.add('row-no-match');
          return [none];
        }
        return rows;
      },
    })
  );

  // 待完善（完善设定，2026-10-19）：还没写的几章细纲第九节点名、却还没有条目或条目还只有一句话的设定。
  // 往前看的一组，排在往回记的「出现过 · 未建条目」前面；一个都没有就整组不画，筛选时同未建条目。
  // 标题右键「全部展开」（三期）：次数与后端确认框同一个数，只算批量会写的（作者写过的跳过，`authored`）。
  const thin = filterUnfiled(thinAll);
  if (thin.length > 0) {
    const expandable = thinAll.filter((t) => !t.authored).length;
    lore.appendChild(
      buildGroup('loreThin', '待完善', `${thinAll.length} 个`, {
        extraItems: () =>
          expandable > 0
            ? [
                {
                  label: `全部展开（${expandable} 条，${describeCalls(loreExpandCalls(expandable)).replace(/（.*）$/, '')}）`,
                  run: () => projectAction('expandLoreAll'),
                },
                { sep: true },
              ]
            : [],
        build: () => buildLoreThinRows(thin),
      })
    );
  }

  // 定稿过的细纲第九节里出现、但还没有条目的名字。与「出场人物 · 未建卡」同一个道理单独一组：
  // 设定那棵是文件树（能改名/移动/删除），这些还没有文件。筛选时一个都没匹配上就整组不画。
  const unfiled = filterUnfiled(unfiledAll);
  if (unfiled.length > 0) {
    const frequent = unfiledAll.filter((u) => u.chapters.length >= 1).length;
    lore.appendChild(
      buildGroup('loreUnfiled', '出现过 · 未建条目', `${unfiledAll.length} 个`, {
        extraItems: () =>
          frequent > 0
            ? [{ label: `给全部 ${frequent} 个建条目`, run: () => projectAction('buildLore') }, { sep: true }]
            : [],
        build: () => buildLoreUnfiledRows(unfiled, tree.loreRoot),
      })
    );
  }
}

/** 折叠状态变了：拿最近一次收到的树重画，不往后端要数据。 */
function rerenderProject(): void {
  if (lastTree) {
    renderProject(lastTree);
  }
}

export function installProject(): void {
  bindRerender(rerenderProject);
  installSummaryTip();
  installDetailTip();
  installFailureTip();
  installProjectTabs();

  // 页签条上除了页签只剩「刷新」。
  el.projectTabs.querySelector('[data-action="refresh"]')?.addEventListener('click', () => projectAction('refresh'));
}

export { applySummary, invalidateSummaries } from './summaryTip';
