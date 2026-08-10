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
import { bindRerender, buildCastRow, emptyRow, renderNodes } from './rows';
import { hideDetailTip, installDetailTip } from './detailTip';
import { hideSummaryTip, installSummaryTip } from './summaryTip';
import { lastTree, setLastTree } from './treeState';

export function renderProject(tree: ProjectTree): void {
  setLastTree(tree);
  el.projectBody.innerHTML = '';
  // 全部行都被换掉了，开着的浮窗指向的是已丢弃的节点。
  hideSummaryTip();
  hideDetailTip();
  // 还不是小说工程时，工具栏上的「新建章节」等按钮点了只会报错。
  setHidden(el.projectToolbar, !tree.initialized);

  if (!tree.initialized) {
    el.projectBody.appendChild(buildInitPrompt());
    return;
  }

  el.projectBody.appendChild(buildProjectHead(tree));

  el.projectBody.appendChild(
    buildGroup('chapters', '章节', `${tree.chapterCount} 章 · ${formatWords(tree.totalWords)}`, {
      section: SECTIONS.chapters,
      root: tree.chaptersRoot,
      build: () =>
        tree.chapters.length === 0
          ? [emptyRow('还没有章节。点上方「＋ 新建章节」开始。')]
          : renderNodes(tree.chapters, 0, SECTIONS.chapters),
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
      ],
      build: () =>
        tree.characters.length === 0
          ? [emptyRow('还没有角色卡。可运行「提取/更新角色卡」从正文抽取。')]
          : renderNodes(tree.characters, 0, SECTIONS.characters, tree),
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
      build: () =>
        tree.lore.length === 0
          ? [emptyRow('还没有设定条目。keywords 命中纲要时会自动注入上下文。')]
          : renderNodes(tree.lore, 0, SECTIONS.lore),
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

  el.projectToolbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '[data-action]');
    if (btn?.dataset.action) {
      projectAction(btn.dataset.action as Parameters<typeof projectAction>[0]);
    }
  });
}

export { applySummary, invalidateSummaries } from './summaryTip';
