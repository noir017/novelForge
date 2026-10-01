/**
 * 工程页的装配：把树、分组、横幅拼成一整页。
 *
 * 折叠等 UI 状态完全留在前端（treeState.ts），切一下折叠走 `rerenderProject`
 * 拿最近那份快照重画，不必往后端要一次数据。
 */
import { closestFrom, setHidden } from '../../dom';
import type { ProjectTree } from '../../protocol';
import { formatWords } from '../format';
import { el } from '../refs';
import { SECTIONS, characterAction, projectAction } from './actions';
import {
  buildGroup,
  buildInitPrompt,
  buildMetaRows,
  buildProjectHead,
  countLabel,
  summaryGroupLabel,
} from './groups';
import {
  bindRerender,
  buildArchitectureRows,
  buildCastRow,
  buildConflictRow,
  buildPlotRows,
  emptyRow,
  renderNodes,
} from './rows';
import { openIdeaForm, openPlotBatchForm, openWriteBatchForm } from '../forms';
import { charactersEmptyRow, loreEmptyRow, nextStepRow } from './nextSteps';
import { hideDetailTip, installDetailTip } from './detailTip';
import { hideFailureTip, installFailureTip } from './errorTip';
import { hideSummaryTip, installSummaryTip } from './summaryTip';
import { lastTree, setLastTree } from './treeState';

export function renderProject(tree: ProjectTree): void {
  setLastTree(tree);
  el.projectBody.innerHTML = '';
  // 全部行都被换掉了，开着的浮窗指向的是已丢弃的节点。
  hideSummaryTip();
  hideDetailTip();
  hideFailureTip();
  // 还不是小说工程时，工具栏上的「新建细纲」等按钮点了只会报错。
  setHidden(el.projectToolbar, !tree.initialized);

  if (!tree.initialized) {
    el.projectBody.appendChild(buildInitPrompt());
    return;
  }

  el.projectBody.appendChild(buildProjectHead(tree));

  // 故事架构：后面一切的上游，排在最前面。
  const filled = tree.architecture.filter((a) => a.filled).length;
  el.projectBody.appendChild(
    buildGroup('architecture', '故事架构', `${filled}/${tree.architecture.length}`, {
      extraItems: () => [
        { label: '从一句话生成小说配置…', run: () => openIdeaForm(tree.book) },
        // 只补空白：已经有的那几件不动、不问（第 19 条的批量那一面）。
        { label: '补齐设定（只补空白）', run: () => projectAction('completeSettings') },
        { sep: true },
      ],
      build: () => buildArchitectureRows(tree.architecture, tree),
    })
  );

  // 一个章号一行（细纲号 = 章号）。细纲与正文是同一行的两面。
  el.projectBody.appendChild(
    buildGroup('plots', '章节', `${tree.chapterCount} 章 · ${formatWords(tree.totalWords)}`, {
      extraItems: () => [
        { label: '新建细纲（接在最后一章之后）', run: () => projectAction('newPlot') },
        { label: '新建章节文件（直接粘正文用）', run: () => projectAction('newChapter') },
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
          return [tree.next ? nextStepRow(tree.next, tree) : emptyRow('还没有章节。先把故事架构与情节大纲写好，再拆出细纲。')];
        }
        const rows = buildPlotRows(tree.plots, tree.nextChapterNo);
        const hasNextRow = tree.plots.some((p) => p.no === tree.nextChapterNo);
        return !hasNextRow && tree.next ? [...rows, nextStepRow(tree.next, tree)] : rows;
      },
    })
  );

  el.projectBody.appendChild(
    buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
      section: SECTIONS.characters,
      root: tree.charactersRoot,
      extraItems: () => [
        { label: '更新所有角色卡', run: () => characterAction('updateAllCards') },
        { label: '从头重建所有角色卡', run: () => characterAction('rebuildAllCards') },
        { sep: true },
        { label: '清理别名（删掉「她」「姐姐」这类泛称）', run: () => characterAction('cleanAliases') },
        { label: '查找并合并重复角色卡', run: () => characterAction('mergeDuplicates') },
        { sep: true },
      ],
      build: () => [
        // 冲突排在最前面：它说明这棵树上的出场统计有一处是错的。
        ...(tree.castConflicts ?? []).map(buildConflictRow),
        ...(tree.characters.length === 0
          ? [charactersEmptyRow(tree)]
          : renderNodes(tree.characters, 0, SECTIONS.characters, tree)),
      ],
    })
  );

  // 摘要里出现但还没建卡的人物。单独一组而不是混进角色树——
  // 那棵是文件树（能改名/移动/删除），这些人还没有文件。
  if (tree.cast && tree.cast.length > 0) {
    el.projectBody.appendChild(
      buildGroup('cast', '出场人物 · 未建卡', `${tree.cast.length} 人`, {
        extraItems: () => [
          { label: `给全部 ${tree.cast.length} 人建卡`, run: () => characterAction('createAllCards') },
          { sep: true },
        ],
        build: () => tree.cast.map(buildCastRow),
      })
    );
  }

  el.projectBody.appendChild(
    buildGroup('lore', '设定', countLabel(tree.lore, '条'), {
      section: SECTIONS.lore,
      root: tree.loreRoot,
      extraItems: () => [
        { label: '从已写正文生成/更新设定', run: () => projectAction('generateLore') },
        { sep: true },
      ],
      build: () => (tree.lore.length === 0 ? [loreEmptyRow(tree)] : renderNodes(tree.lore, 0, SECTIONS.lore)),
    })
  );

  el.projectBody.appendChild(
    buildGroup('meta', '文风与摘要', summaryGroupLabel(tree), {
      build: () => buildMetaRows(tree),
    })
  );
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

  el.projectToolbar.addEventListener('click', (e) => {
    const form = closestFrom<HTMLElement>(e.target, '[data-form]');
    if (form?.dataset.form === 'plotBatch' && lastTree) {
      openPlotBatchForm(lastTree);
      return;
    }
    if (form?.dataset.form === 'writeBatch' && lastTree) {
      openWriteBatchForm(lastTree);
      return;
    }
    const btn = closestFrom<HTMLElement>(e.target, '[data-action]');
    if (btn?.dataset.action) {
      projectAction(btn.dataset.action as Parameters<typeof projectAction>[0]);
    }
  });
}

export { applySummary, invalidateSummaries } from './summaryTip';
