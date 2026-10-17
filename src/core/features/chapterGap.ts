/**
 * 已写的正文中间断了一截（`ChapterGap`）：主按钮那一步的说明框，以及补齐、重写大纲动手之前的那句提醒。
 *
 * 工程只按文件名开头的数字认章号，「写到第几章」是从第 1 章起连续有正文的那一截。导入的原稿换过编号、
 * 一章拆成两个文件时，后面几十章明明写了，补齐与大纲却只认得缺口前面那一截。这里不改文件名
 * （改名由作者自己做），只把缺哪几号、哪几号重复说清楚。
 */
import { getHost } from '../host';
import { ChapterGap } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { chapterGapOf, duplicateChapterNos } from '../views/pipeline';

/** 说明框里每个重复章号最多列几个文件名、最多列几个章号。 */
const DUPLICATE_LIST_LIMIT = 8;

function range(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/** 「第 25–31 章没有正文，后面还有 51 章已写（写到第 82 章）。」 */
export function describeGap(gap: ChapterGap): string {
  return `${range(gap.from, gap.to)}没有正文，后面还有 ${gap.later} 章已写（写到第 ${gap.last} 章）。`;
}

/** 同号的几个文件，一号一行。 */
function describeDuplicates(chapters: Chapter[]): string[] {
  const nos = duplicateChapterNos(chapters);
  const lines = nos.slice(0, DUPLICATE_LIST_LIMIT).map((no) => {
    const names = chapters.filter((c) => c.order === no).map((c) => c.relPath.split('/').pop());
    return `  第 ${no} 章：${names.join('、')}`;
  });
  if (nos.length > DUPLICATE_LIST_LIMIT) {
    lines.push(`  ……还有 ${nos.length - DUPLICATE_LIST_LIMIT} 个章号`);
  }
  return lines;
}

/** 主按钮「第 N–M 章缺正文…」：不花钱，弹一个说明框。没有缺口（刚改好名）时照实说。 */
export async function explainChapterGap(project: NovelProject): Promise<void> {
  project.invalidate();
  const chapters = await project.listChapters();
  const gap = chapterGapOf(chapters);
  if (!gap) {
    getHost().toast('章号已经连上了。', 'info');
    return;
  }
  const duplicates = describeDuplicates(chapters);
  const detail = [
    `工程只按文件名开头的数字认章号，从第 1 章起连续有正文才算写到那里。照现在的编号，从已写正文补齐与情节大纲只认得${gap.from > 1 ? range(1, gap.from - 1) : '前面那一截'}，第 ${gap.to + 1} 章以后会被当成没写过。`,
    ...(duplicates.length > 0
      ? ['', '下面这些章号不止一个文件，会抢同一章（作话、设定、备份之类不是正文的，挪出章节目录）：', ...duplicates]
      : []),
    '',
    '接上的办法：在工程页把章节文件按顺序重新编号（改文件名开头的数字，一章一个号）；或者确实缺了这几章，就把它们补写出来。',
  ].join('\n');
  await getHost().confirm(describeGap(gap), ['知道了'], { modal: true, detail });
}

/**
 * 补齐、重写大纲动手之前：章号断了一截就先问一句，这一次只照缺口前面那一截做。
 * 没有缺口返回 true；作者不点「仍然继续」返回 false。
 */
export async function confirmDespiteGap(chapters: Chapter[], what: string): Promise<boolean> {
  const gap = chapterGapOf(chapters);
  if (!gap) {
    return true;
  }
  const through = gap.from - 1;
  const basis = through > 0 ? `只照${range(1, through)}做` : '一章正文都照不上';
  const pick = await getHost().confirm(describeGap(gap), ['仍然继续'], {
    modal: true,
    detail:
      `${what}这一次${basis}，第 ${gap.to + 1} 章以后会被当成没写过——多半是文件名开头的章号没接上。` +
      '先把章号接上再来更好（主按钮上的说明框里列着缺哪几号、哪几号重复）。',
  });
  return pick === '仍然继续';
}
