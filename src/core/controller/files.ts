import type { ChatController } from './index';
import { deleteEntry, deletePlot, isPlotPath, moveEntry, renameEntry, renamePlot } from '../files/fileOps';
import { listDirs } from '../files/fileTree';
import { copyInto, moveInto, renameAny } from '../files/projectFiles';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { FileOpResult, InMessage } from '../protocol';
import { retargetPlot } from './chat';
import { Workspace } from '../workspace';

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
 * 类文件操作。工程页的 rename/move/delete 走 core/files/fileOps（三区锁定），
 * 文件页的 renameAny/paste 走 core/files/projectFiles（根范围）。
 * 有逐项结果的动作额外推 filesOpDone，前端据此 remap 编辑器标签。
 *
 * **细纲单独分流**：它的改名/删除要连带搬走场景目录与中转站正文，
 * 而 `plots/` 根本不是三个可管理区之一，照走 fileOps 会被区守卫直接拒掉
 * （新建出来的细纲是纯序号名，第一次命名走的正是这条路）。
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
      // 细纲没有「移动到…」：`plots/` 是扁平的，顺序由序号决定，
      // 挪进子目录只会让它从流水线上消失。前端不给这一项，这里兜一层。
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
