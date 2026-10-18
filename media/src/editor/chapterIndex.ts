/**
 * 编辑器的章节索引：章节条与上一章 / 下一章都从这里取「有哪几章、各自的正文与细纲在哪、写到哪一步」。
 *
 * 数据来自后端的 `chapterIndex` 消息——**哪个页签都推**、内容变了才推（`controller/index.ts` 的
 * `pushChapterIndex`）。从前章节条只吃工程树（`project` 消息），而工程树只在「工程」页签开着时才推：
 * 作者待在对话页时条上的字数与状态是旧的，从没打开过工程页时干脆没有数据。
 *
 * 章节顺序就是索引的顺序：后端按章号升序排好（第 8 条：文件名数字前缀决定顺序，与目录层级无关）。
 */
import type { ChapterIndexEntry } from '../protocol';
import { onMessage } from '../vscodeApi';

/** 一份文件是某一章的哪一面。 */
export type ChapterSide = 'chapter' | 'plot';

export const SIDE_LABEL: Record<ChapterSide, string> = { chapter: '正文', plot: '细纲' };

let chapters: ChapterIndexEntry[] = [];
const listeners = new Set<() => void>();

/** 装一次（`index.ts`）：收 `chapterIndex`，换工程时清空。 */
export function installChapterIndex(): void {
  onMessage((msg) => {
    if (msg.type === 'chapterIndex') {
      chapters = Array.isArray(msg.chapters) ? msg.chapters : [];
      notify();
    }
  });
  window.addEventListener('nf-workspace-reset', () => {
    chapters = [];
    notify();
  });
}

/** 全书的章节，按章号升序。 */
export function chapterIndex(): readonly ChapterIndexEntry[] {
  return chapters;
}

/** 章节索引变了时通知（章节条重画）。 */
export function onChapterIndex(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) {
    fn();
  }
}

/** 这个路径是哪一章的正文或细纲（别的文件——角色卡、大纲、草稿——不算）。 */
export function chapterAt(path: string): { entry: ChapterIndexEntry; side: ChapterSide; index: number } | undefined {
  const index = chapters.findIndex((c) => (c.chapterPath && c.chapterPath === path) || (c.plotExists && c.plotPath === path));
  if (index < 0) {
    return undefined;
  }
  const entry = chapters[index];
  return { entry, side: entry.chapterPath === path ? 'chapter' : 'plot', index };
}

/** 这一章这一面的文件路径；还没有（没写正文、没排细纲）时是空串。 */
export function pathOn(entry: ChapterIndexEntry, side: ChapterSide): string {
  return side === 'chapter' ? entry.chapterPath : entry.plotExists ? entry.plotPath : '';
}

export function flipSide(side: ChapterSide): ChapterSide {
  return side === 'chapter' ? 'plot' : 'chapter';
}
