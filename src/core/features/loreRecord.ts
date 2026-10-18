import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { LlmProvider, StreamOptions } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { describeTaskModels } from '../model/tiers';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { Chapter } from '../model/types';
import {
  LoreLine,
  createLoreLookup,
  loreLinesFromJson,
  loreMentionIn,
  normalizeLoreName,
  verifyLoreLines,
} from '../model/loreFile';
import { Workspace } from '../workspace';
import { buildLoreIndex } from '../views/lore';
import { LORE_RECORD_SYSTEM } from './lorePrompt';
import { extractJsonObject, stripCodeFence, stripTrailingCommas } from './parse';

const log = scoped('设定');

/**
 * 记设定：这一章正文里出现了哪些设定，写进细纲的第九节「设定」（设定名录，2026-10-18）。
 *
 * 默认路径是**定稿时顺手记**（features/summarize.ts，并进定稿第一步，不加调用次数）。这里是作者定的
 * 「另外允许单独调用」：觉得哪一章记得不好、或者老工程里那些在这个功能之前就定稿过的章（细纲没有
 * 第九节），可以单独记——每章 1 次，只读正文、只出「设定」一个字段，只换掉第九节，另外八节与指纹
 * 一个字不动。
 *
 * 只对**定稿过、而且正文没再改过**的章开放：没定稿的章，第九节写的是计划，记了也会被定稿冲掉；
 * 定稿之后正文又改过的，先重新定稿（第 4 条：不偷偷补）。
 *
 * 补记是**串行**的：「已有设定」提示里除了条目，还有前面各章第九节记过、还没建条目的名字——
 * 后一章要看到前一章刚记下的名字，同一个东西才不会在两章里叫出两个名字。
 */

/**
 * 「本书的设定分类」与「已有设定」提示段。定稿与单独记设定共用。
 *
 * - 分类就是 `lore/` 下的目录树，每本书自己的（没有固定表）。还没有目录时让模型自己起短名字。
 * - 已有设定只列**这一章正文里提到的**（标题或关键词作为子串出现），加上计划第九节点名的，再加上
 *   前面各章记过、还没建条目、这一章正文里也出现了的名字：几百条全列会挤掉正文的预算，而且模型要的
 *   只是「同一个东西照抄这个名字」。最多 60 条。
 */
export async function loreHint(project: NovelProject, text: string, plan?: Plot): Promise<string> {
  const [categories, entries] = await Promise.all([project.listLoreCategories(), project.listLore()]);
  const planned = new Set((plan?.lore ?? []).map((l) => normalizeLoreName(l.name)));
  const lookup = createLoreLookup(entries);
  const plannedEntries = new Set(
    (plan?.lore ?? []).map((l) => lookup.find(l.name)?.slug).filter((s): s is string => !!s)
  );
  const hits = entries
    .filter((e) => plannedEntries.has(e.slug) || planned.has(normalizeLoreName(e.title)) || loreMentionIn(text, e))
    .map((e) => {
      const also = e.keywords.filter((k) => k !== e.title);
      return `${e.title}${e.category ? `〔${e.category}〕` : ''}${also.length > 0 ? `（也叫 ${also.join('、')}）` : ''}`;
    });
  const unfiled = (await buildLoreIndex(project, { entries })).unknown
    .filter((u) => u.name.length >= 2 && text.includes(u.name))
    .map((u) => `${u.name}${u.category ? `〔${u.category}〕` : ''}`);
  const list = [...hits, ...unfiled].slice(0, HINT_ENTRIES);
  const lines = [
    categories.length > 0
      ? `本书的设定分类：${categories.join('、')}。`
      : '本书还没有设定分类：category 给一个简短的分类名（如「地点」「宗门」「法宝」），拿不准就给 ""。',
  ];
  if (list.length > 0) {
    lines.push(`已有设定（本章正文里提到的；同一个东西请照抄这里的名字）：${list.join('、')}。`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** 已有设定最多列几条。 */
const HINT_ENTRIES = 60;

/**
 * 模型给的「设定」写进第九节之前的校验（model/loreFile.ts 的 `verifyLoreLines`，不调模型），
 * 丢掉与清空说明的都写日志（第 2 条）。`people` 是这一章出场人物的名字与别名，角色卡上的另外加上。
 */
export async function checkLore(
  project: NovelProject,
  chapter: Chapter,
  lines: readonly LoreLine[],
  text: string,
  people: readonly string[] = []
): Promise<LoreLine[]> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const result = verifyLoreLines(lines, text, {
    entries,
    people: [...people, ...cards.flatMap((c) => [c.name, ...c.aliases])],
  });
  if (result.dropped.length > 0) {
    log.warn(
      `第 ${chapter.order} 章有 ${result.dropped.length} 条设定没记`,
      result.dropped.map((d) => `- ${d.name}：${d.why}`).join('\n')
    );
  }
  if (result.cleared.length > 0) {
    log.info(
      `第 ${chapter.order} 章有 ${result.cleared.length} 条设定只记名字`,
      result.cleared.map((d) => `- ${d.name}：${d.why}`).join('\n')
    );
  }
  return result.lines;
}

/** 这一章能不能单独记设定：定稿过，而且记下的 `sourceHash` 对得上正文。 */
function freshFinalized(chapter: Chapter, plot: Plot | undefined): plot is Plot {
  return !!plot?.sourceHash && plot.sourceHash === chapter.contentHash;
}

/**
 * 单独记一章的设定：1 次调用，只换掉这一章细纲的第九节。返回写进去的行。
 * 解析不出来就抛（第九节不动）；调用方记失败。
 */
export async function recordChapterLore(
  project: NovelProject,
  chapter: Chapter,
  llm: LlmProvider,
  signal?: AbortSignal,
  budget?: { contextWindow: number; maxOutputTokens: number }
): Promise<LoreLine[]> {
  const plot = await project.plotOfChapter(chapter);
  if (!freshFinalized(chapter, plot)) {
    throw new Error(`第 ${chapter.order} 章还没定稿，或定稿之后正文又改过`);
  }
  const config = readConfig();
  const window = budget ?? { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens };
  const text = await project.readChapterText(chapter);
  const hint = await loreHint(project, text, plot);
  const inputBudget = Math.max(2000, window.contextWindow - window.maxOutputTokens - estimateTokens(hint) - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${chapter.order} 章正文超出输入预算，记设定只读了前 ${body.length} 字`, `原文 ${text.length} 字`);
  }
  const options: StreamOptions = {
    maxOutputTokens: window.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const startedAt = Date.now();
  const raw = await collectText(
    llm.stream(
      [
        { role: 'system', content: LORE_RECORD_SYSTEM },
        {
          role: 'user',
          content: `${hint}请记下这一章正文里出现的设定。\n\n【第${chapter.order}章 ${chapter.title}】\n\n${body}`,
        },
      ],
      options
    )
  );
  const parsed = parseLoreRecord(raw);
  if (!parsed) {
    throw new Error(`模型返回无法解析（${raw.length} 字）`);
  }
  const people = plot.cast.flatMap((c) => [c.name, ...c.aliases]);
  const lines = await checkLore(project, chapter, parsed, text, people);
  await new Workspace(project).patchPlotLore(plot.relPath, lines);
  await clearFailures(project, 'chapter', chapter.relPath, 'loreRecord');
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》记下 ${lines.length} 条设定`,
    `${plot.relPath}｜用时 ${elapsed(startedAt)}｜返回 ${raw.length} 字` +
      (lines.length > 0 ? `｜${lines.map((l) => l.name).join('、')}` : '')
  );
  return lines;
}

/** `{"设定": [...]}` → 一行一条。不是 JSON、或没有这个字段，返回 undefined。 */
export function parseLoreRecord(raw: string): LoreLine[] | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    try {
      data = JSON.parse(stripTrailingCommas(json));
    } catch {
      return undefined;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const field = obj.设定 ?? obj.settings ?? obj.lore;
  return field === undefined ? undefined : loreLinesFromJson(field);
}

/**
 * 工程页入口。给了 `relPath`（章节或细纲的路径）就记那一章；没给就**补记**全部还没记过设定
 * （细纲没有第九节）的定稿章。动手之前报调用次数（第 4 条），串行，可取消。
 */
export async function recordLore(project: NovelProject, relPath?: string): Promise<void> {
  const chapters = await project.listChapters();
  const host = getHost();
  let targets: Chapter[] = [];
  let skipped = 0;
  if (relPath) {
    const chapter =
      chapters.find((c) => c.relPath === relPath) ??
      (await (async () => {
        const plot = await project.resolvePlot(relPath);
        return plot ? chapters.find((c) => c.order === plot.no) : undefined;
      })());
    if (!chapter) {
      host.toast('这一章还没有正文，没有设定可记。');
      return;
    }
    if (!freshFinalized(chapter, await project.plotOfChapter(chapter))) {
      host.toast(`第 ${chapter.order} 章还没定稿，或定稿之后正文又改过：先定稿，定稿时会一并记下设定。`);
      return;
    }
    targets = [chapter];
  } else {
    for (const chapter of chapters) {
      const plot = await project.plotOfChapter(chapter);
      if (!plot?.sourceHash || plot.lore) {
        continue;
      }
      if (freshFinalized(chapter, plot)) {
        targets.push(chapter);
      } else {
        skipped++;
      }
    }
    if (targets.length === 0) {
      host.toast(
        skipped > 0
          ? `没有可以补记的章：还有 ${skipped} 章定稿之后正文又改过，先重新定稿（定稿时会一并记下设定）。`
          : '定稿过的章都已经记过设定了。'
      );
      return;
    }
  }

  const config = readConfig();
  const n = targets.length;
  const what = relPath ? `第 ${targets[0].order} 章` : `${n} 章`;
  const picked = await host.confirm(
    `记设定：读${what}正文，每章调用模型 1 次，共 ${n} 次。只换掉${relPath ? '这一章' : '这几章'}细纲的「设定」一节，别的不动。`,
    ['开始记'],
    {
      modal: true,
      detail: [
        relPath
          ? '这一章细纲原来的「设定」一节（定稿时记的）会被这一次的结果替换。'
          : `补记的是定稿过、但还没记过设定的章（这个功能之前定稿的章都是）。${skipped > 0 ? `另有 ${skipped} 章定稿之后正文又改过，这次不记，先重新定稿。` : ''}`,
        describeTaskModels(config, 'loreScan'),
        n > 1 ? '一章一章串行记，可以随时停下，已经记好的留着。' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (picked !== '开始记') {
    log.info('作者取消了记设定');
    return;
  }
  const pool = await createModelPool({ task: 'loreScan', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，记设定中止');
    return;
  }
  log.info('开始记设定', `${n} 章｜${pool.label}`);

  await runTask(
    '记设定',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let done = 0;
      let failed = 0;
      let lines = 0;
      for (const chapter of targets) {
        if (signal.aborted) {
          break;
        }
        report({ message: `记第 ${chapter.order} 章《${chapter.title}》的设定`, current: done, total: n });
        try {
          const recorded = await pool.run(`第 ${chapter.order} 章记设定`, (llm) =>
            recordChapterLore(project, chapter, llm, signal, pool.primaryBudget)
          );
          lines += recorded.length;
        } catch (err) {
          if (signal.aborted) {
            break;
          }
          failed++;
          log.error(`第 ${chapter.order} 章记设定失败`, describeError(err));
          await recordFailure(project, {
            scope: '设定',
            targetKind: 'chapter',
            targetKey: chapter.relPath,
            severity: 'warn',
            op: 'loreRecord',
            message: `记设定失败：${describeError(err)}`,
            detail: '细纲的「设定」一节没有改动；可以在这一章上右键「记设定」再试一次。',
          });
        } finally {
          done++;
          report({ current: done, total: n });
        }
      }
      const summary = `记了 ${done - failed} 章，共 ${lines} 条设定${failed > 0 ? `，失败 ${failed} 章（详见日志页）` : ''}`;
      log.info('记设定结束', `${summary}｜总耗时 ${elapsed(startedAt)}`);
      host.toast(`${summary}。`);
    },
    { scope: '设定' }
  );
}
