/**
 * 导入原稿（拆书 A 的前一半）：把作者自己写好的一整本 txt 切成 `chapters/NNN-标题.md`。**零调用。**
 *
 * 借鉴 AI-Novel-Writer 的「作者原稿导入」（`import-workflow.ts:515-559`）：上游导进来直接当定稿，
 * 再逐章跑定稿后处理。这里只落章节——摘要、角色卡、设定、大纲、细纲是「从已写正文补齐」
 * （features/derive.ts）的事，要调模型，确认框得另外报次数（第 4 条）。导入完问一句要不要接着补。
 *
 * - **接在已有章节之后**，章号按顺序重编（原书的「第一百章」不保留——一条轴，第 8 条）。
 * - **不覆盖**：`createChapter` 同名一律报错（第 3 条），撞上就停在那一章，前面导入的留着。
 * - 切的结果在确认框里给作者看（开头几章、结尾一章、丢掉了什么）；切得不对就改 txt 再来，不提供手调。
 */
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import { ENCODING_LABEL, SplitChapter, splitChapters } from '../model/importText';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { Workspace } from '../workspace';
import { formatWordCount, pickBookText, readBookText } from './bookText';
import { deriveFromText } from './derive';

const log = scoped('导入');

export interface ImportOutcome {
  /** 新建了几章。 */
  imported: number;
  /** 接着「从已写正文补齐」调了几次模型（作者没接着补就是 0）。 */
  calls: number;
}

const NONE: ImportOutcome = { imported: 0, calls: 0 };

export async function importManuscript(project: NovelProject, opts: { path?: string } = {}): Promise<ImportOutcome> {
  const rel = await pickBookText(project, '导入原稿：选一本工程里的 txt', opts.path);
  if (!rel) {
    return NONE;
  }
  let book;
  try {
    book = await readBookText(project, rel);
  } catch (err) {
    getHost().toast(describeError(err), 'error');
    return NONE;
  }
  const split = splitChapters(book.text);
  if (split.chapters.length === 0) {
    log.warn(`《${book.title}》里认不出章节标题，没有导入`, rel);
    getHost().toast(
      `《${book.title}》里认不出章节标题。每章开头要有单独一行的标题，如「第一章 雪夜」「第12章」「楔子」，改好再导入。`,
      'error'
    );
    return NONE;
  }

  const existing = await project.listChapters();
  const start = existing.length === 0 ? 1 : Math.max(...existing.map((c) => c.order)) + 1;
  const chapters = split.chapters;
  const end = start + chapters.length - 1;
  const words = chapters.reduce((s, c) => s + c.words, 0);
  const where = start === end ? `第 ${start} 章` : `第 ${start}–${end} 章`;
  const pick = await getHost().confirm(
    `从《${book.title}》认出 ${chapters.length} 章（${formatWordCount(words)}），导入为${where}？这一步不调用模型。`,
    ['导入'],
    {
      modal: true,
      detail: [
        `文件：${rel}（${ENCODING_LABEL[book.encoding]}）。`,
        `开头：${chapters.slice(0, 3).map((c, i) => describe(start + i, c)).join('；')}${chapters.length > 3 ? '……' : ''}`,
        chapters.length > 3 ? `结尾：${describe(end, chapters[chapters.length - 1])}。` : '',
        split.preface.words > 0 ? `第一个章标题之前的 ${split.preface.words} 字（「${split.preface.head}」）不导入。` : '',
        split.volumes.length > 0 ? `${split.volumes.length} 行卷标题（${split.volumes.slice(0, 2).join('、')}${split.volumes.length > 2 ? '……' : ''}）不算章，丢掉。` : '',
        split.empty.length > 0 ? `${split.empty.length} 个标题下面没有正文（多半是目录），跳过。` : '',
        existing.length > 0 ? `工程里已经有 ${existing.length} 章，接在第 ${start - 1} 章之后。` : '',
        `每章新建一个 ${project.config.chaptersDir}/NNN-标题.md，一段一行、去掉行首的空格；原 txt 不动。同名文件已经在就停下，不覆盖。`,
        '切得不对？改 txt 里的章标题（每章开头单独一行，如「第一章 雪夜」）再导入一次。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  );
  if (pick !== '导入') {
    log.info('作者取消了导入原稿');
    return NONE;
  }

  const ws = new Workspace(project);
  let imported = 0;
  let stopped: string | undefined;
  await runTask(
    '导入原稿',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      report({ message: describe(start, chapters[0]), current: 0, total: chapters.length });
      try {
        // 一批建：每一章照样过网关（同名报错、大小上限），manifest 最后同步一次。
        await ws.createChapters(
          chapters.map((c, i) => ({ order: start + i, title: c.title, content: c.body })),
          {
            signal,
            onEach: (_rel, i) => {
              imported = i + 1;
              if (i + 1 < chapters.length) {
                report({ message: describe(start + i + 1, chapters[i + 1]), current: i + 1, total: chapters.length });
              }
            },
          }
        );
        if (imported < chapters.length) {
          stopped = `被取消，停在第 ${start + imported} 章前面`;
        }
      } catch (err) {
        stopped = `第 ${start + imported} 章没写进去（${describeError(err)}）`;
        log.error(`导入原稿停在第 ${start + imported} 章`, describeError(err));
      }
      project.invalidate();
      report({ message: '收尾', current: chapters.length, total: chapters.length });
      log.info(`导入原稿：《${book.title}》${imported}/${chapters.length} 章`, `${rel}｜用时 ${elapsed(startedAt)}`);
    },
    { scope: '导入' }
  );

  const done = imported === 0 ? '' : imported === 1 ? `第 ${start} 章` : `第 ${start}–${start + imported - 1} 章`;
  if (stopped) {
    getHost().toast(`${done ? `已导入${done}；` : ''}${stopped}。`, 'error');
    return { imported, calls: 0 };
  }
  const next = await getHost().confirm(
    `已导入${done}。接着从已写正文补齐摘要、角色卡、设定、情节大纲与细纲？`,
    ['接着补齐'],
    {
      modal: true,
      detail:
        '这一步要调模型：先报摘要要调几次，摘要出来之后再报其余几样，每一次都可以不同意。\n' +
        '也可以以后在工程页「故事架构」那一组点「从已写正文补齐」，或者点创作页的主按钮。',
    }
  );
  if (next !== '接着补齐') {
    return { imported, calls: 0 };
  }
  return { imported, calls: await deriveFromText(project) };
}

/** 「第 3 章《雪夜》（原文「第三章 雪夜」，3200 字）」。 */
function describe(no: number, c: SplitChapter): string {
  return `第 ${no} 章${c.title ? `《${c.title}》` : ''}（原文「${c.heading}」，${c.words} 字）`;
}
