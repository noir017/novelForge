/**
 * 导出全文（2026-10-24）：把全部章节按章号拼成一份纯文本，写到工程根下的 `导出/<书名>.txt`。**零调用。**
 *
 * 作者定的三条：
 * - **写进工程目录**，不弹另存为、不走浏览器下载——三个形态一个样；重复导出直接覆盖（`Workspace.writeExport`）。
 * - **章标题写成「第一章 楔子」**（汉字章号，网文 txt 最常见的写法）；没起名的章只写「第一章」。
 *   标题本身已经是「第…章」开头的（导入的原稿常这样起名）照原样，不再套一层。
 * - 分了卷的书，进一卷之前单起一行卷名（卷 = 章节根下的一级目录，更深的子目录只是收纳、不出行）。
 *
 * 开头一行书名（`《书名》`，manifest 里的作品名，没有就用目录名），有作者名再起一行。正文照磁盘上的原样（markdown
 * 正文去掉 `# 标题` 行），没有正文的章不放进去、在提示里说一句。读的是磁盘：编辑器里没保存的改动不在里面。
 */
import * as path from 'node:path';
import { getHost } from '../host';
import { countWords, sanitizeFileName } from '../model/fs';
import { isFallbackChapterTitle } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { cnNumber } from '../model/timelineFile';
import { Chapter } from '../model/types';
import { scoped } from '../runtime/logger';
import { Workspace } from '../workspace';
import { formatWordCount } from './bookText';

const log = scoped('导出');

/** 标题已经带着章号（「第一章 楔子」「第12回」）：照原样当标题行。 */
const NUMBERED_TITLE = /^第\s*[0-9０-９〇零一二两三四五六七八九十百千万]+\s*[章回节卷]/u;

/** 「第一章 楔子」；没起名的章只有「第一章」。 */
export function exportHeading(chapter: Pick<Chapter, 'order' | 'title'>): string {
  const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title.trim();
  if (NUMBERED_TITLE.test(title)) {
    return title;
  }
  const no = `第${cnNumber(chapter.order)}章`;
  return title ? `${no} ${title}` : no;
}

/** 这一章所在的卷（章节根下的一级目录名）；直接放在章节根下的是 `''`。 */
function volumeOf(project: NovelProject, chapter: Chapter): string {
  const under = path.relative(project.chaptersDir, project.pathOf(chapter.relPath)).replace(/\\/g, '/');
  const parts = under.split('/');
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : '';
}

/** 书名：manifest 里的作品名，没有（或还是缺省的「未命名」）就用目录名。 */
function bookTitleOf(project: NovelProject, manifestTitle: string): string {
  const title = manifestTitle.trim();
  return title && title !== '未命名' ? title : path.basename(project.root) || '未命名';
}

export interface ExportResult {
  /** 写到哪了（工作区相对路径）。 */
  rel: string;
  /** 放进去几章。 */
  chapters: number;
  /** 没有正文、没放进去的章数。 */
  skipped: number;
}

/** 工程页章节组右键「导出全文（txt）」。没有章节、全是空章时只提示，不写文件。 */
export async function exportBookText(project: NovelProject): Promise<ExportResult | undefined> {
  project.invalidate();
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    getHost().toast('还没有章节，没有可导出的。', 'error');
    return undefined;
  }

  const manifest = await project.readManifest();
  const title = bookTitleOf(project, manifest.title);
  const blocks: string[] = [`《${title}》`];
  if (manifest.author.trim()) {
    blocks[0] += `\n作者：${manifest.author.trim()}`;
  }

  let volume = '';
  let exported = 0;
  let skipped = 0;
  let words = 0;
  for (const chapter of chapters) {
    const body = (await project.readChapterText(chapter)).replace(/\r\n?/g, '\n').trim();
    if (!body) {
      skipped++;
      continue;
    }
    const v = volumeOf(project, chapter);
    if (v && v !== volume) {
      blocks.push(v);
    }
    volume = v;
    blocks.push(`${exportHeading(chapter)}\n\n${body}`);
    exported++;
    words += countWords(body);
  }
  if (exported === 0) {
    getHost().toast(`${chapters.length} 章都还没有正文，没有可导出的。`, 'error');
    return undefined;
  }

  const rel = await new Workspace(project).writeExport(
    `${project.relPath(project.exportDir)}/${sanitizeFileName(title)}.txt`,
    `${blocks.join('\n\n')}\n`
  );
  log.info(`导出全文 ${exported} 章`, `${rel}｜${formatWordCount(words)}${skipped > 0 ? `｜跳过 ${skipped} 章空章` : ''}`);
  getHost().toast(
    `已导出全文：${rel}（${exported} 章，${formatWordCount(words)}）${skipped > 0 ? `；${skipped} 章没有正文，没放进去` : ''}`
  );
  return { rel, chapters: exported, skipped };
}
