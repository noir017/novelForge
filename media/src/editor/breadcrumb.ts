/**
 * 工具栏上的路径：面包屑「细纲 › 第一卷 › 第 3 章 夜访」。
 *
 * 称呼由后端算（`EditorFileView.label.crumbs`，`views/editorLabel.ts`），前端不拿路径猜。原始相对路径挂在
 * 悬停提示上。带 `dir` 的段是目录：点了在「文件」页定位到它（`nf-reveal-in-files`，资源管理器自己展开、
 * view 切页签——编辑器不碰它们的状态）。
 *
 * 太长时**前面的段先省略**，最后一段（这份文件）最后才让：从前用 `direction: rtl` 做左侧省略，
 * `.novelforge/…` 开头的路径会把那个点号排到末尾去。
 *
 * 后端没给称呼（没打开工程）时只写原始路径，一段，不能点。
 */
import { el } from '../dom';
import { revealInFiles } from '../globals';
import type { OpenFile } from './paneElements';

export function renderBreadcrumb(target: HTMLElement, file: OpenFile): void {
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
      target.appendChild(el('span', last ? 'ed-crumb ed-crumb-file' : 'ed-crumb', crumb.label));
    }
  });
}
