import type { ChatController } from './index';
import {
  dirBaseName,
  initProjectFlow,
  newChapterFlow,
  newPlotFlow,
} from '../actions';
import { newFolder, Section, sectionOf, sectionRoots } from '../files/fileOps';
import {
  createCardForCast,
  createCardsForAllCast,
  updateAllCharacterCards,
  updateCharacterCard,
} from '../features/characterCard';
import { cleanCharacterAliases, mergeDuplicateCharacterCards } from '../features/characterMaintenance';
import { extractCharacters, newCharacter, newLore } from '../features/characters';
import { generateLore } from '../features/lore';
import { completeSettings, generatePlots, writeManuscripts } from '../features/pipelineBatch';
import { extractStyle } from '../features/style';
import { importManuscript } from '../features/importManuscript';
import { deriveFromText } from '../features/derive';
import { learnFromReference } from '../features/reference';
import { generateThreads } from '../features/threads';
import { chapterForSummary, rebuildGlobalSummary, syncSummaries } from '../features/summarize';
import { finalizeChapterTask } from '../features/finalize';
import { reviewCharacterState } from '../features/characterState';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { CharacterAction, ProjectAction } from '../protocol';
import { normalizeRange } from '../model/session';
import { isWriteBatchMode } from '../model/pipeline';
import { selectPlot } from './chat';

const log = scoped('面板');

/** 工程页与角色卡动作。字段只给 controller/ 同包用。 */

/**
 * 工程页的按钮直调 core 流程，webview 不直接碰文件系统。
 * 插件的命令面板也复用同一批 core 流程，行为不会分叉。
 *
 * `relPath` 是动作的作用对象（如要总结哪一章）；`dir` 是「在某个文件夹上点＋」
 * 时的落点目录，从工具栏点则不带，落在区根目录。
 */
export async function projectAction(
  c: ChatController,
  action: ProjectAction,
  relPath?: string,
  dir?: string,
  batch: { range?: { from: number; to: number }; confirmed?: boolean; mode?: 'draft' | 'finalize'; review?: boolean } = {}
): Promise<void> {
  // refresh 每次切页/刷盘都来一趟，记了只会淹掉别的；其余动作都值得留痕。
  if (action !== 'refresh') {
    log.info(
      `工程页动作：${action}`,
      [relPath ? `对象 ${relPath}` : '', dir ? `落点 ${dir}` : ''].filter(Boolean).join('｜') || undefined
    );
  }
  switch (action) {
    case 'initProject':
      await initProjectFlow(c.project, dirBaseName(c.project));
      break;
    case 'refresh':
      break; // pushState 本身就是刷新
    case 'newPlot': {
      const rel = await newPlotFlow(c.project);
      if (rel) {
        // 建完**进入这一章**，落在哪一层由状态机决定（空细纲 → 待写细纲 →
        // 主按钮「写第 N 章细纲」）。走 selectPlot 而不是自己拼 target：
        // 只有后端知道那一章处于什么状态，这与点章名同一条路。
        await selectPlot(c, rel);
      }
      break;
    }
    case 'newChapter':
      // 手工新建一个章节文件。**不进创作页**——建它多半是作者要往里粘一段
      // 现成的正文。
      await newChapterFlow(c.project, dir);
      break;
    case 'newCharacter':
      await newCharacter(c.project, dir);
      break;
    case 'newLore':
      await newLore(c.project, dir);
      break;
    case 'newFolder': {
      // 落点目录决定建到哪个区；没给就问用户。
      const section = dir ? sectionOf(c.project, dir)?.section : await pickSection(c);
      if (!section) {
        break;
      }
      await newFolder(c.project, section, dir);
      break;
    }
    case 'finalizeChapter': {
      if (!relPath) {
        break;
      }
      // 传进来的可能是细纲路径（从流水线那一侧点的），也可能是章节路径
      // （从工程页那一行点的）。摘要挂在正文上，所以统一解析成章节。
      // 定稿 = 摘要（带连续性事实）+ 出场角色的当前状态（features/finalize.ts）。
      const chapter = await chapterForSummary(c.project, relPath);
      if (!chapter) {
        log.warn(`找不到 ${relPath} 对应的章节，可能还没写正文或刚被改名`);
        getHost().toast('这一章还没有正文，无法定稿。', 'error');
        break;
      }
      await finalizeChapterTask(c.project, chapter);
      break;
    }
    case 'syncSummaries':
      await syncSummaries(c.project);
      break;
    case 'rebuildGlobalSummary':
      await rebuildGlobalSummary(c.project);
      break;
    case 'generatePlots':
      // 区间与「弹窗已经报过调用次数」来自工程页的拆细纲弹窗（W5）；不带就是下一批 5 章，先问。
      await generatePlots(c.project, { range: normalizeRange(batch.range), confirmed: batch.confirmed === true });
      break;
    case 'completeSettings':
      await completeSettings(c.project);
      break;
    case 'writeManuscripts':
      // 区间、模式与「弹窗已经报过调用次数」来自批量写章弹窗（W9）；不带就是下一可写章起 3 章、只写正文，先问。
      await writeManuscripts(c.project, {
        range: normalizeRange(batch.range),
        mode: isWriteBatchMode(batch.mode) ? batch.mode : 'draft',
        review: batch.review === true,
        confirmed: batch.confirmed === true,
      });
      break;
    case 'extractCharacters':
      await extractCharacters(c.project);
      break;
    case 'generateLore':
      await generateLore(c.project);
      break;
    case 'extractStyle':
      await extractStyle(c.project);
      break;
    case 'generateThreads':
      await generateThreads(c.project);
      break;
    case 'importManuscript':
      await importManuscript(c.project);
      break;
    case 'deriveFromText':
      await deriveFromText(c.project);
      break;
    case 'learnFromReference':
      await learnFromReference(c.project);
      break;
  }

  // 这些流程大多会改动磁盘，且不一定触发 watcher（比如刚初始化的空工程）。
  // pushState 会顺带刷新当前页签。
  await c.pushState();
}

/** 工具栏上的「＋ 文件夹」没有落点，先问建到哪个区。 */
export async function pickSection(c: ChatController): Promise<Section | undefined> {
  return getHost().pick<Section>(
    sectionRoots(c.project).map((s) => ({ label: s.label, detail: `${s.root}/`, value: s.section })),
    '在哪个区新建文件夹？'
  );
}

/**
 * 角色卡动作。作用对象是**一个角色**（用名字标识），不是文件或章节，
 * 因此与 fileAction / projectAction 分开走。
 */
export async function characterAction(
  c: ChatController,
  action: CharacterAction,
  name: string,
  relPath?: string
): Promise<void> {
  log.info(`角色动作：${action} ${name}`, relPath);
  switch (action) {
    case 'updateCard':
    case 'rebuildCard':
      if (!relPath) {
        log.warn(`${action} 缺少角色卡路径，忽略`);
        break;
      }
      await updateCharacterCard(
        c.project,
        relPath,
        action === 'updateCard' ? 'incremental' : 'full'
      );
      break;
    case 'createCard':
      await createCardForCast(c.project, name);
      break;
    case 'createAllCards':
      await createCardsForAllCast(c.project);
      break;
    case 'updateAllCards':
      await updateAllCharacterCards(c.project, 'incremental');
      break;
    case 'rebuildAllCards':
      await updateAllCharacterCards(c.project, 'full');
      break;
    case 'cleanAliases':
      await cleanCharacterAliases(c.project);
      break;
    case 'mergeDuplicates':
      await mergeDuplicateCharacterCards(c.project);
      break;
    case 'reviewState':
      // 定稿时没覆盖的那一版（作者改过这张卡的当前状态，D15）：对比后决定用不用。
      if (relPath) {
        await reviewCharacterState(c.project, relPath);
      }
      break;
  }
  await c.pushState();
}
