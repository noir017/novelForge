import type { ChatController } from './index';
import {
  dirBaseName,
  initProjectFlow,
  newChapterFlow,
  newPlotFlow,
  newVolumeFlow,
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
import { generatePlots, writeManuscripts } from '../features/pipelineBatch';
import { extractStyle } from '../features/style';
import { chapterForSummary, rebuildGlobalSummary, summarizeChapter, syncSummaries } from '../features/summarize';
import { splitManuscript } from '../features/splitChapter';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { CharacterAction, ProjectAction } from '../protocol';
import { selectPlot, setTarget } from './chat';

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
  dir?: string
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
    case 'newVolume': {
      const rel = await newVolumeFlow(c.project);
      if (rel) {
        // 建完**进入这一卷**：接下来要做的是把这一卷的走向写出来
        // （主按钮会是「写这一卷的卷纲」），再从它拆剧情段。
        await setTarget(c, { kind: 'volume', volumeRelPath: rel });
      }
      break;
    }
    case 'newPlot': {
      const rel = await newPlotFlow(c.project);
      if (rel) {
        // 建完**进入这一段**，落在哪一层由状态机决定（空段 → 待写剧情 →
        // 主按钮「写剧情」）。走 selectPlot 而不是自己拼 target：
        // 只有后端知道那一段处于什么状态，这与点段落名同一条路。
        await selectPlot(c, rel);
      }
      break;
    }
    case 'newChapter':
      // 发布区手工新建一篇。**不进创作页**——章节不在流水线上，
      // 建它多半是作者要往里粘一段切好的正文。
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
    case 'summarizePlot': {
      if (!relPath) {
        break;
      }
      // 传进来的可能是细纲路径（从流水线那一侧点的），也可能是章节路径
      // （从工程页那一行点的）。摘要挂在成品上，所以统一解析成章节。
      const chapter = await chapterForSummary(c.project, relPath);
      if (!chapter) {
        log.warn(`找不到 ${relPath} 对应的章节，可能还没拆分或刚被改名`);
        getHost().toast('这一章还没有拆分成发布章节，无法总结。', 'error');
        break;
      }
      await runTask(
        `总结第 ${chapter.order} 章`,
        async ({ signal, report }) => {
          report({ message: `《${chapter.title}》`, current: 0, total: 1 });
          const ok = await summarizeChapter(c.project, chapter, undefined, signal);
          report({ message: ok ? '完成' : '未生成', current: 1, total: 1 });
          if (ok) {
            getHost().toast(`第 ${chapter.order} 章摘要已生成。`);
          }
        },
        { scope: '摘要' }
      );
      break;
    }
    case 'splitManuscript': {
      if (!relPath) {
        break;
      }
      await splitManuscript(c.project, relPath);
      break;
    }
    case 'syncSummaries':
      await syncSummaries(c.project);
      break;
    case 'rebuildGlobalSummary':
      await rebuildGlobalSummary(c.project);
      break;
    case 'generatePlots':
      await generatePlots(c.project);
      break;
    case 'writeManuscripts':
      await writeManuscripts(c.project);
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
  }
  await c.pushState();
}
