/**
 * 窄屏（≤900px，与 `css/standalone/narrow.css` 同一个界）：编辑区只有一块、盖在侧栏上，活动栏是底栏。
 * 按视口宽度认，不看是不是触屏——桌面上把窗口拖窄（或分屏）也是这一套；平板横屏可以是宽屏 + 触屏。
 */
import type { InMessage } from './protocol';

export const NARROW_WIDTH = 900;

export function narrowScreen(): boolean {
  return window.innerWidth <= NARROW_WIDTH;
}

/**
 * 「打开这一章」：后端按宿主能力开正文、再把细纲（或草稿）并排开在第二块。窄屏上没有第二块，并排的那份只能开进同一块，
 * 而工程页单击开的是临时标签——细纲一到就把正文那个临时标签顶掉了，作者点的是正文、看到的是细纲。所以窄屏上不要并排的那份。
 */
export function openChapterMessage(plotRelPath: string, preview?: boolean): InMessage {
  return { type: 'openChapter', plotRelPath, ...(preview ? { preview: true } : {}), ...(narrowScreen() ? { beside: false } : {}) };
}
