import type { ChatController } from './index';
import {
  deleteEntry,
  deletePlot,
  isPlotPath,
  moveEntry,
  renameEntry,
  renamePlot,
} from '../files/fileOps';
import { listDirs } from '../files/fileTree';
import { copyInto, moveInto, renameAny } from '../files/projectFiles';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { FileOpResult, InMessage } from '../protocol';
import { retargetPlot } from './chat';
import { Workspace } from '../workspace';
import { parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { basename } from 'node:path';

const log = scoped('面板');

/** 文件页与草稿。字段只给 controller/ 同包用。 */

/**
 * 列举资源管理器要的目录并广播。
 *
 * 顺带把 `dirs` 记成新的关注集合——工程有变动时 `pushTabData` 会照着
 * 再推一遍。空数组是合法输入（前端把树全折叠了），此时只更新集合。
 */
export async function pushDirListings(
  c: ChatController,
  dirs: string[],
  ephemeral?: boolean
): Promise<void> {
  // 选择器一次性列举不能改掉资源管理器的关注集合，否则展开着的树会被冲掉。
  if (!ephemeral) {
    c.watchedDirs = dirs;
  }
  if (dirs.length === 0) {
    return;
  }
  c.post({ type: 'dirListings', listings: await listDirs(c.project.root, dirs) });
}

/**
 * 打开某章的草稿。首次点击按需创建，已存在原样打开（绝不覆盖）。
 *
 * **必须先在真实章节列表里查到这一章**：这条路径会写盘，拿前端传上来的
 * 任意相对路径去拼 `drafts/<任意>` 就等于开了一个绕过区守卫的写入口子。
 * 别为了省一次扫描把这一步优化掉。
 */
export async function openDraft(c: ChatController, chapterRelPath: string): Promise<void> {
  const chapter = (await c.project.listChapters()).find((ch) => ch.relPath === chapterRelPath);
  if (!chapter) {
    log.warn(`找不到章节 ${chapterRelPath}，可能刚被改名或删除`);
    c.toast('找不到这一章，可能刚被改名或删除。', 'error');
    await c.pushState();
    return;
  }
  const rel = await new Workspace(c.project).ensureDraft(chapter);
  log.info(`打开第 ${chapter.order} 章的草稿`, rel);
  const host = getHost();
  if (host.openBeside) {
    await host.openBeside(rel);
  } else {
    await host.openFile(rel);
  }
  // 刚建出来的草稿要让 hasDraft 立刻翻过来，菜单文案跟着变。
  await c.pushState();
}

/**
 * 打开一章：正文在主区，这一章的细纲并排在旁边（W6 章节工作台）。
 *
 * 从前点工程页的行名只开一份（有正文开正文，否则开细纲），对照着看要再去右键开另一份。
 * **并排是宿主的能力，不是壳的名字**：有 `openBeside` 的（独立版落在第二块编辑区，VS Code
 * 落在 `ViewColumn.Beside`）两份都开，没有的只开正文——与 `openDraft` 同一个判法。
 * 还没写正文的章只开细纲；两样都没有才说找不到。
 */
export async function openChapter(c: ChatController, plotRelPath: string): Promise<void> {
  const no = chapterNoOf(plotRelPath);
  const [plot, chapter] = no !== undefined ? await Promise.all([c.project.getPlot(no), c.project.getChapter(no)]) : [];
  const host = getHost();
  if (!plot && !chapter) {
    c.toast('这一章还没有细纲也没有正文。', 'error');
    return;
  }
  if (!chapter) {
    await host.openFile(plot!.relPath);
    return;
  }
  await host.openFile(chapter.relPath);
  if (plot && host.openBeside) {
    await host.openBeside(plot.relPath);
  }
  log.info(`打开第 ${chapter.order} 章`, `${chapter.relPath}${plot && host.openBeside ? ` ｜ 并排 ${plot.relPath}` : ''}`);
}

/**
 * 点审稿报告上的引文（五期 W10）：在编辑器里打开那一章、选中那一句。
 *
 * 宿主有 `revealText` 就交给它（独立版选中内置编辑器里那一段，插件用 `revealRange`）；没有就
 * 只打开文件，并把那一句写进提示——作者自己 Ctrl+F 也找得到。能力探测，不判断是哪个壳。
 */
export async function revealQuote(c: ChatController, relPath: string, quote: string): Promise<void> {
  const host = getHost();
  const clip = quote.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (host.revealText) {
    const found = await host.revealText(relPath, quote);
    if (!found) {
      c.toast(`这一句在现在的正文里找不到了（正文可能改过）：「${clip}」`, 'error');
    }
    return;
  }
  await host.openFile(relPath);
  c.toast(`在编辑器里找这一句：「${clip}」`);
}

/** 细纲路径或章节路径 → 章号（细纲号 = 章号）。 */
function chapterNoOf(relPath: string): number | undefined {
  const name = basename(relPath);
  return parsePlotFileName(name)?.no ?? parseChapterFileName(name)?.order;
}

/**
 * 类文件操作。工程页的 rename/move/delete 走 core/files/fileOps（三区锁定），
 * 文件页的 renameAny/paste 走 core/files/projectFiles（根范围）。
 * 有逐项结果的动作额外推 filesOpDone，前端据此 remap 编辑器标签。
 *
 * **细纲单独分流**：它的文件名由章号与标题共同决定（改名只改标题，章号前缀
 * 由 `writePlot` 保留），而 `plots/` 根本不是三个可管理区之一，照走 fileOps 会被
 * 区守卫直接拒掉（新建出来的细纲是纯序号名，第一次命名走的正是这条路）。
 */
export async function fileAction(
  c: ChatController,
  msg: Extract<InMessage, { type: 'fileAction' }>
): Promise<void> {
  const { action, relPath, relPaths, op, targetDir } = msg;
  log.info(
    `文件动作：${action}`,
    [relPath ?? '', relPaths ? relPaths.join('、') : '', targetDir !== undefined ? `目标目录 ${targetDir || '（根）'}` : '']
      .filter(Boolean)
      .join('｜') || undefined
  );
  let results: FileOpResult[] | undefined;
  // 改名/移动过的路径。当前创作目标正指着其中某一条时要跟着走，否则创作页
  // 会拿到一份「这一章找不到」的空壳。
  const moved: { from: string; to: string }[] = [];
  const isPlot = !!relPath && isPlotPath(c.project, relPath);
  switch (action) {
    case 'rename':
      if (relPath) {
        // 两条路：细纲的文件名由章号与标题决定，其余是普通文件。
        const to = isPlot ? await renamePlot(c.project, relPath) : await renameEntry(c.project, relPath);
        if (to) {
          moved.push({ from: relPath, to });
        }
      }
      break;
    case 'renameAny':
      if (relPath) {
        results = [await renameAny(c.project, relPath)];
      }
      break;
    case 'move':
      // 细纲没有「移动到…」：它平铺在 `plots/` 下，挪进子目录它就不在这条链上了。
      // 前端不给这一项，这里兜一层。
      if (relPath && !isPlot) {
        const to = await moveEntry(c.project, relPath, targetDir);
        if (to) {
          moved.push({ from: relPath, to });
        }
      }
      break;
    case 'delete':
      if (relPath) {
        await (isPlot ? deletePlot(c.project, relPath) : deleteEntry(c.project, relPath));
      }
      break;
    case 'paste':
      results =
        op === 'copy'
          ? await copyInto(c.project, relPaths ?? [], targetDir ?? '')
          : await moveInto(c.project, relPaths ?? [], targetDir ?? '');
      break;
  }
  // 复制不动原路径，目标照旧指着原来那一章，不必跟。
  if (results && op !== 'copy') {
    for (const r of results) {
      if (r.ok && r.to) {
        moved.push({ from: r.from, to: r.to });
      }
    }
  }
  for (const m of moved) {
    await retargetPlot(c, m.from, m.to);
  }
  if (results && results.length > 0) {
    c.post({
      type: 'filesOpDone',
      op: action === 'renameAny' ? 'rename' : op === 'copy' ? 'copy' : 'move',
      results,
    });
  }
  await c.pushState();
}
