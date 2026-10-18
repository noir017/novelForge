/**
 * 工具栏上的路径：面包屑「细纲 › 第一卷 › 第 3 章 夜访」。
 *
 * 称呼由后端算（`EditorFileView.label.crumbs`，`views/editorLabel.ts`），前端不拿路径猜。原始相对路径挂在
 * 悬停提示上。带 `dir` 的段是目录：点了在「文件」页定位到它（`nf-reveal-in-files`，资源管理器自己展开、
 * view 切页签——编辑器不碰它们的状态）。
 *
 * **章节那一段的标题优先取章节索引**（`chapterIndex.ts`，后端的 `chapterIndex` 消息）：`editorLabel` 是纯函数、
 * 不读盘，只能拿文件名里的那一段；而有正文的章改了标题，文件名是不动的（第 7 条）——那时章节条、「转到…」、
 * 工程页说的都是新标题，面包屑不该还写旧的。索引里没有这一份（还没收到、不是正文或细纲）时照后端给的写；
 * 索引变了重画一遍。标签上仍写文件名（它说的是这个文件）。
 *
 * 太长时**前面的段先省略**，最后一段（这份文件）最后才让：从前用 `direction: rtl` 做左侧省略，
 * `.novelforge/…` 开头的路径会把那个点号排到末尾去。
 *
 * 后端没给称呼（没打开工程）时只写原始路径，一段，不能点。
 */
import { el } from '../dom';
import { revealInFiles } from '../globals';
import type { EditorCrumb } from '../protocol';
import { chapterAt, onChapterIndex } from './chapterIndex';
import type { OpenFile } from './paneElements';

/** 画过面包屑的那几格（两块编辑区各一格）与当时那份文件：章节索引变了重画。 */
const shown = new Map<HTMLElement, OpenFile>();

onChapterIndex(() => {
  for (const [target, file] of shown) {
    if (target.isConnected) {
      renderBreadcrumb(target, file);
    }
  }
});

export function renderBreadcrumb(target: HTMLElement, file: OpenFile): void {
  shown.set(target, file);
  target.replaceChildren();
  target.title = file.path;
  const crumbs = file.label?.crumbs ?? [{ label: file.path }];
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      target.appendChild(el('span', 'ed-crumb-sep', '›'));
    }
    const last = i === crumbs.length - 1;
    if (crumb.dir !== undefined && !last) {
      const dir = crumb.dir;
      const btn = el('button', 'ed-crumb ed-crumb-dir', crumb.label);
      btn.type = 'button';
      btn.title = `在「文件」页定位到 ${dir || '工程根目录'}`;
      btn.addEventListener('click', () => revealInFiles(dir, true));
      target.appendChild(btn);
    } else {
      target.appendChild(el('span', last ? 'ed-crumb ed-crumb-file' : 'ed-crumb', last ? leafOf(file, crumb) : crumb.label));
    }
  });
}

/** 最后一段：这份文件是某一章的正文或细纲、索引里有标题时写「第 N 章 标题」，否则照后端给的。 */
function leafOf(file: OpenFile, crumb: EditorCrumb): string {
  if (!file.label) {
    return crumb.label;
  }
  const at = chapterAt(file.path);
  const title = at?.entry.title.trim();
  return at && title ? `第 ${at.entry.no} 章 ${title}` : crumb.label;
}
