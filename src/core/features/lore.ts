import * as path from 'node:path';
import { readConfig } from '../config';
import { runPool, Settled } from '../concurrency';
import { clearFailures, recordFailure } from '../errorLog';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { getHost } from '../host';
import { collectStream, ChatOptions } from '../llm/provider';
import { budgetForTask, createModelPool, ModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../logger';
import { parseMarkdown, stripH1 } from '../model/markdown';
import { describeTaskModels } from '../model/tiers';
import {
  exists,
  NovelProject,
  readText,
  renderLoreEntry,
  slugify,
} from '../model/project';
import { Chapter, LoreEntry } from '../model/types';
import { runTask } from '../progress';
import { stripCodeFence } from './summarize';

const log = scoped('设定');

const LORE_CATEGORIES = ['世界观', '地理', '势力', '制度', '能力', '物件', '历史', '其他'] as const;
type LoreCategory = (typeof LORE_CATEGORIES)[number];

interface ParsedLoreCandidate {
  title: string;
  category: LoreCategory;
  keywords: string[];
  facts: string[];
}

interface LoreDraft extends ParsedLoreCandidate {
  chapters: number[];
  existing?: LoreEntry;
}

interface GeneratedLore {
  draft: LoreDraft;
  keywords: string[];
  body: string;
}

interface ChapterScanUnit {
  chapter: Chapter;
  text: string;
  part: number;
  parts: number;
}

/**
 * 从全书正文生成/更新世界观设定。
 *
 * 第一阶段严格按章节顺序逐章分析：后一章会看到此前已经发现的设定目录，
 * 尽量沿用同一个标题，避免同一地点或势力被拆成多条。第二阶段按设定并发
 * 精炼跨章事实。新条目直接创建，已有条目必须经过宿主审阅才会覆盖。
 */
export async function generateLore(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    log.warn('还没有章节，无法生成设定');
    getHost().toast('还没有章节。');
    return;
  }

  const existing = await project.listLore();
  const config = readConfig();
  // 切扫描片段用**逐章识别那一档**的窗口：片段数 = 确认框里那句「调用 N 次」，
  // 拿错窗口既会让那个数字失真，也会让每个片段超出干活模型的窗口。
  const scanBudget = budgetForTask('loreScan');
  const inputBudget = Math.max(2000, scanBudget.contextWindow - scanBudget.maxOutputTokens - 2500);
  const scanUnits = await prepareScanUnits(project, chapters, Math.max(1000, Math.floor(inputBudget * 0.7)));
  if (scanUnits.length === 0) {
    log.error('所有章节都无法读取，设定生成中止');
    getHost().toast('章节正文都无法读取，详见日志页。', 'error');
    return;
  }
  const confirmed = await getHost().confirm(
    `将通读全部 ${chapters.length} 章生成设定：逐章识别固定调用模型 ${scanUnits.length} 次，` +
      '之后每发现一条设定再调用 1 次完成跨章整合。现在开始？',
    ['开始生成'],
    {
      modal: true,
      detail: [
        `预计调用次数：${scanUnits.length} + 识别出的设定条数。` +
          `${scanUnits.length > chapters.length ? `其中 ${chapters.length} 章按输入预算拆为 ${scanUnits.length} 个完整片段，不会截掉长章后半段。` : ''}` +
          '扫描结束后会在进度与日志中给出实际总数。',
        existing.length > 0
          ? `现有 ${existing.length} 条设定只会生成修改建议，逐条确认后才覆盖。`
          : '当前没有设定条目；新识别出的条目会自动创建。',
        describeTaskModels(config, 'loreScan'),
        describeTaskModels(config, 'loreSynthesis'),
        config.concurrency > 1
          ? `逐章识别保持串行；设定整合最多 ${config.concurrency} 路并发。`
          : '全部串行处理（并发数为 1）。',
      ].join('\n\n'),
    }
  );
  if (confirmed !== '开始生成') {
    log.info('用户取消了自动生成设定');
    return;
  }

  // 逐章识别有前后依赖，恒用首选模型；第二阶段的设定彼此独立，可轮转负载均衡。
  const scanPool = await createModelPool({ task: 'loreScan', concurrent: false });
  if (!scanPool) {
    log.error('没有可用的模型，设定生成中止');
    return;
  }
  // 两阶段是**两档**（逐章识别只做事实摘录，整合要合并跨章事实且不能推翻
  // 作者已写的内容），所以哪怕串行也各建一个池——串行时复用扫描池会把
  // 整合悄悄降级到快速档。只有两档解析到同一份清单时才是同一批模型。
  const synthesisPool = await createModelPool({
    task: 'loreSynthesis',
    concurrent: config.concurrency > 1,
  });
  if (!synthesisPool) {
    log.error('没有可用的模型，设定生成中止');
    return;
  }

  log.info(
    '开始从正文生成设定',
    `${chapters.length} 章分 ${scanUnits.length} 个扫描片段｜已有 ${existing.length} 条｜` +
      `逐章识别 ${scanPool.label}｜设定整合 ${synthesisPool.label}｜` +
      (config.concurrency > 1 ? `整合并发 ${config.concurrency} 路` : '串行')
  );

  await runTask(
    '生成世界观设定',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const drafts = await scanChapters(scanUnits, existing, scanPool, signal, report);
      if (signal.aborted) {
        log.warn(`设定扫描被取消，已发现 ${drafts.length} 条；尚未写入文件`);
        return;
      }
      if (drafts.length === 0) {
        log.warn('通读完成，但没有识别出可复用的世界观设定');
        getHost().toast('没有从正文中识别出可生成的设定。');
        return;
      }

      const modelCalls = scanUnits.length + drafts.length;
      const totalSteps = scanUnits.length + drafts.length * 2;
      report({
        message: `识别出 ${drafts.length} 条设定，开始逐条整合`,
        current: scanUnits.length,
        total: totalSteps,
      });
      log.info(
        `逐章扫描完成，识别出 ${drafts.length} 条设定`,
        `实际计划调用模型 ${modelCalls} 次（扫描 ${scanUnits.length} + 整合 ${drafts.length}）`
      );

      const generated = await synthesizeDrafts(
        project,
        drafts,
        synthesisPool,
        signal,
        report,
        scanUnits.length,
        totalSteps,
        config.concurrency
      );
      if (signal.aborted) {
        log.warn(`设定整合被取消，已完成 ${generated.length}/${drafts.length} 条；尚未写入文件`);
        return;
      }
      if (generated.length === 0) {
        log.error('所有设定的整合结果都无法解析，磁盘未改动');
        getHost().toast('设定生成失败：模型结果均无法解析，详见日志页。', 'error');
        return;
      }

      const applied = await applyGeneratedLore(
        project,
        generated,
        report,
        scanUnits.length + drafts.length,
        totalSteps,
        signal
      );
      const failed = drafts.length - generated.length;
      const summary = [
        `新建 ${applied.created} 条`,
        `更新 ${applied.updated} 条`,
        applied.skipped > 0 ? `跳过 ${applied.skipped} 条` : '',
        failed > 0 ? `生成失败 ${failed} 条` : '',
      ]
        .filter(Boolean)
        .join('，');
      log.info('自动生成设定结束', `${summary}｜总耗时 ${elapsed(startedAt)}`);
      getHost().toast(`设定生成完成：${summary}。${failed > 0 ? '失败项详见日志页。' : ''}`);
    },
    { scope: '设定' }
  );
}

/** 在确认前读盘并按输入预算切片，保证长章的后半段也会被模型看到。 */
async function prepareScanUnits(
  project: NovelProject,
  chapters: Chapter[],
  maxTokens: number
): Promise<ChapterScanUnit[]> {
  const units: ChapterScanUnit[] = [];
  for (const chapter of chapters) {
    try {
      const text = await project.readChapterText(chapter);
      const chunks = splitForBudget(text.trim() ? text : '（本章正文为空）', maxTokens);
      if (chunks.length > 1) {
        log.info(`第 ${chapter.order} 章正文拆分为 ${chunks.length} 个设定识别片段`, `${estimateTokens(text)} token`);
      }
      chunks.forEach((chunk, index) => {
        units.push({ chapter, text: chunk, part: index + 1, parts: chunks.length });
      });
    } catch (err) {
      log.error(`第 ${chapter.order} 章正文读取失败，跳过该章`, describeError(err));
    }
  }
  return units;
}

function splitForBudget(text: string, maxTokens: number): string[] {
  const normalized = text.trim();
  if (!normalized || estimateTokens(normalized) <= maxTokens) {
    return [normalized];
  }
  const out: string[] = [];
  let rest = normalized;
  while (rest) {
    if (estimateTokens(rest) <= maxTokens) {
      out.push(rest);
      break;
    }
    let low = 1;
    let high = rest.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTokens(rest.slice(0, mid)) <= maxTokens) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    let cut = Math.max(1, low);
    const boundary = rest.lastIndexOf('\n\n', cut);
    if (boundary > cut * 0.35) {
      cut = boundary;
    }
    const chunk = rest.slice(0, cut).trim();
    if (chunk) {
      out.push(chunk);
    }
    rest = rest.slice(cut).trimStart();
  }
  return out.length > 0 ? out : [normalized];
}

async function scanChapters(
  units: ChapterScanUnit[],
  existing: LoreEntry[],
  pool: ModelPool,
  signal: AbortSignal,
  report: (update: { message?: string; current?: number; total?: number }) => void
): Promise<LoreDraft[]> {
  const drafts: LoreDraft[] = [];
  const config = readConfig();
  const budget = pool.primaryBudget;
  const inputBudget = Math.max(2000, budget.contextWindow - budget.maxOutputTokens - 2500);
  const options: ChatOptions = {
    maxOutputTokens: budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };

  let scanned = 0;
  for (const unit of units) {
    if (signal.aborted) {
      break;
    }
    const { chapter } = unit;
    const partLabel = unit.parts > 1 ? `（片段 ${unit.part}/${unit.parts}）` : '';
    report({
      message: `识别第 ${chapter.order} 章《${chapter.title}》${partLabel}`,
      current: scanned,
      total: units.length,
    });
    const startedAt = Date.now();
    try {
      const catalog = buildCatalog(existing, drafts);
      const catalogBudget = Math.max(600, Math.floor(inputBudget * 0.2));
      const clippedCatalog = takeHead(catalog, catalogBudget);
      if (clippedCatalog.length < catalog.length) {
        log.warn(
          `第 ${chapter.order} 章识别时，设定目录超出输入预算，已截断`,
          `${catalog.length} 字 → ${clippedCatalog.length} 字（目录预算 ${catalogBudget} token）`
        );
      }
      const raw = await pool.run(`第 ${chapter.order} 章设定识别`, (llm) =>
        collectStream(
          llm.chatStream(
            [
              { role: 'system', content: LORE_EXTRACT_SYSTEM },
              {
                role: 'user',
                content:
                  `已有及此前发现的设定目录（同一对象必须沿用这里的标题）：\n${clippedCatalog || '（暂无）'}` +
                  `\n\n【第 ${chapter.order} 章 ${chapter.title}${partLabel}】\n${unit.text}`,
              },
            ],
            options
          )
        )
      );
      const parsed = parseLoreCandidates(raw);
      mergeCandidates(drafts, existing, parsed, chapter.order);
      log.info(
        `第 ${chapter.order} 章${partLabel}设定识别完成`,
        `识别 ${parsed.length} 项｜累计 ${drafts.length} 条｜产出 ${raw.length} 字｜用时 ${elapsed(startedAt)}`
      );
    } catch (err) {
      if (signal.aborted) {
        break;
      }
      log.error(`第 ${chapter.order} 章设定识别失败，继续下一章`, describeError(err));
    } finally {
      scanned++;
      report({ current: scanned, total: units.length });
    }
  }
  return drafts;
}

function buildCatalog(existing: LoreEntry[], drafts: LoreDraft[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  // 新发现的目录优先放前面：目录过长时，后续片段最需要看见的是本轮刚统一的标题。
  for (const entry of drafts) {
    const key = normalizeTitle(entry.title);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(`- ${entry.title}${entry.keywords.length ? `（关键词：${entry.keywords.join('、')}）` : ''}`);
  }
  for (const draft of existing) {
    const key = normalizeTitle(draft.title);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(`- ${draft.title}${draft.keywords.length ? `（关键词：${draft.keywords.join('、')}）` : ''}`);
  }
  return lines.join('\n');
}

function mergeCandidates(
  drafts: LoreDraft[],
  existing: LoreEntry[],
  candidates: ParsedLoreCandidate[],
  chapterOrder: number
): void {
  for (const candidate of candidates) {
    const match = findDraft(drafts, candidate) ?? findExisting(existing, candidate);
    if (match && 'chapters' in match) {
      match.keywords = unique([...match.keywords, ...candidate.keywords]);
      match.facts = unique([...match.facts, ...candidate.facts]);
      match.chapters = uniqueNumbers([...match.chapters, chapterOrder]);
      continue;
    }

    const existingEntry = match && !('chapters' in match) ? match : undefined;
    drafts.push({
      title: existingEntry?.title ?? candidate.title,
      category: candidate.category,
      keywords: unique([...(existingEntry?.keywords ?? []), ...candidate.keywords, candidate.title]),
      facts: candidate.facts,
      chapters: [chapterOrder],
      existing: existingEntry,
    });
  }
}

function findDraft(drafts: LoreDraft[], candidate: ParsedLoreCandidate): LoreDraft | undefined {
  return drafts.find((draft) => sameLore(draft, candidate));
}

function findExisting(existing: LoreEntry[], candidate: ParsedLoreCandidate): LoreEntry | undefined {
  return existing.find((entry) => sameLore(entry, candidate));
}

function sameLore(
  left: Pick<LoreEntry, 'title' | 'keywords'>,
  right: Pick<ParsedLoreCandidate, 'title' | 'keywords'>
): boolean {
  const leftTitle = normalizeTitle(left.title);
  const rightTitle = normalizeTitle(right.title);
  if (!leftTitle || !rightTitle) {
    return false;
  }
  if (leftTitle === rightTitle) {
    return true;
  }
  const leftAliases = new Set(left.keywords.map(normalizeTitle).filter(Boolean));
  const rightAliases = new Set(right.keywords.map(normalizeTitle).filter(Boolean));
  return leftAliases.has(rightTitle) && rightAliases.has(leftTitle);
}

async function synthesizeDrafts(
  project: NovelProject,
  drafts: LoreDraft[],
  pool: ModelPool,
  signal: AbortSignal,
  report: (update: { message?: string; current?: number; total?: number }) => void,
  baseDone: number,
  totalSteps: number,
  concurrency: number
): Promise<GeneratedLore[]> {
  const running = new Set<string>();
  const lanes = Math.max(1, Math.min(concurrency, drafts.length));
  const results = await runPool(
    drafts,
    lanes,
    (draft) => synthesizeOne(draft, pool, signal),
    {
      signal,
      onStart: (draft) => {
        running.add(draft.title);
        report({
          message: `整合设定（进行中：${[...running].join('、')}）`,
          current: baseDone,
          total: totalSteps,
        });
      },
      onSettled: (result, draft, _index, done) => {
        running.delete(draft.title);
        if (result.status === 'rejected') {
          log.error(`设定「${draft.title}」生成失败`, describeError(result.reason));
          // 只有**已存在**的条目挂得住标记：新条目此刻还没有文件，
          // 记一条谁也看不到的记录不如不记（工程页按 relPath 匹配）。
          // 那种情况仍然只有日志与「生成失败 N 条」的汇总——它本来也没有
          // 可标记的对象，不为此在树上凭空造一行。
          if (draft.existing) {
            void recordFailure(project, {
              scope: '设定',
              targetKind: 'lore',
              targetKey: draft.existing.relPath,
              severity: 'error',
              op: 'generateLore',
              message: `整合失败：${describeError(result.reason)}`,
              detail: `依据第 ${draft.chapters.join('、')} 章｜这一条未改动，可重新运行「从全部章节生成/更新设定」`,
            });
          }
        } else {
          log.info(
            `设定「${draft.title}」生成完成`,
            `依据 ${draft.chapters.length} 章｜正文 ${result.value.body.length} 字`
          );
        }
        report({
          message:
            `已整合 ${done}/${drafts.length} 条` +
            (running.size > 0 ? ` · ${running.size} 条进行中（${[...running].join('、')}）` : ''),
          current: baseDone + done,
          total: totalSteps,
        });
      },
    }
  );
  return fulfilled(results);
}

async function synthesizeOne(draft: LoreDraft, pool: ModelPool, signal: AbortSignal): Promise<GeneratedLore> {
  const config = readConfig();
  const budget = pool.primaryBudget;
  const inputBudget = Math.max(2000, budget.contextWindow - budget.maxOutputTokens - 2500);
  const source = [
    draft.existing?.body ? `作者现有内容（视为权威，除非正文明确更新，不得删除或改写其事实）：\n${draft.existing.body}` : '',
    `正文中提取的事实（来自第 ${draft.chapters.join('、')} 章）：\n${draft.facts.map((f) => `- ${f}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const clipped = takeHead(source, inputBudget);
  if (clipped.length < source.length) {
    log.warn(
      `设定「${draft.title}」的素材超出整合预算，已截断`,
      `${source.length} 字 → ${clipped.length} 字（预算 ${inputBudget} token）`
    );
  }

  const options: ChatOptions = {
    maxOutputTokens: budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const startedAt = Date.now();
  const raw = await pool.run(`设定「${draft.title}」`, (llm) =>
    collectStream(
      llm.chatStream(
        [
          { role: 'system', content: LORE_SYNTHESIS_SYSTEM },
          {
            role: 'user',
            content:
              `设定标题：${draft.title}\n分类：${draft.category}\n已有关键词：${draft.keywords.join('、')}` +
              `\n\n${clipped}`,
          },
        ],
        options
      )
    )
  );
  const parsed = parseLoreDocument(raw);
  if (!parsed) {
    throw new Error(`模型返回无法解析（${raw.length} 字）`);
  }
  log.debug(`设定「${draft.title}」模型返回`, `${raw.length} 字｜用时 ${elapsed(startedAt)}`);
  return {
    draft,
    keywords: unique([draft.title, ...draft.keywords, ...parsed.keywords]),
    body: parsed.body,
  };
}

function fulfilled(results: Settled<GeneratedLore>[]): GeneratedLore[] {
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function applyGeneratedLore(
  project: NovelProject,
  generated: GeneratedLore[],
  report: (update: { message?: string; current?: number; total?: number }) => void,
  baseDone: number,
  totalSteps: number,
  signal: AbortSignal
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const [index, item] of generated.entries()) {
    if (signal.aborted) {
      break;
    }
    report({
      message: item.draft.existing ? `审阅设定「${item.draft.title}」` : `写入设定「${item.draft.title}」`,
      current: baseDone + index,
      total: totalSteps,
    });
    if (item.draft.existing) {
      const verdict = await reviewExisting(project, item, signal);
      if (verdict === 'updated') {
        updated++;
      } else {
        skipped++;
      }
    } else {
      const category = slugify(item.draft.category);
      const base = `${category}/${slugify(item.draft.title)}`;
      const slug = await uniqueLoreSlug(project, base);
      const relPath = await project.writeLore({
        slug,
        title: item.draft.title,
        keywords: item.keywords,
        body: item.body,
      });
      created++;
      log.info(`新建设定「${item.draft.title}」`, `${relPath}｜${item.body.length} 字`);
    }
    report({ current: baseDone + index + 1, total: totalSteps });
  }
  return { created, updated, skipped };
}

async function reviewExisting(
  project: NovelProject,
  item: GeneratedLore,
  signal: AbortSignal
): Promise<'updated' | 'skipped'> {
  const existing = item.draft.existing!;
  const currentText = await readText(project.pathOf(existing.relPath));
  const proposedText = renderLoreEntry({
    slug: existing.slug,
    title: existing.title,
    keywords: item.keywords,
    body: item.body,
  });
  if (currentText.replace(/\r\n/g, '\n').trim() === proposedText.trim()) {
    log.info(`设定「${existing.title}」无需更新`, existing.relPath);
    // 内容一致也算这一条整合成功了（上次可能是失败挂着的），收掉感叹号。
    await clearFailures(project, 'lore', existing.relPath, 'generateLore');
    return 'skipped';
  }

  const host = getHost();
  let verdict: 'apply' | 'discard' | undefined;
  if (host.reviewReplace) {
    verdict = await host.reviewReplace(`设定「${existing.title}」`, currentText, proposedText);
  } else {
    const picked = await host.confirm(`已生成设定「${existing.title}」的更新。采纳？`, ['采纳', '跳过'], {
      modal: true,
    });
    verdict = picked === '采纳' ? 'apply' : picked === '跳过' ? 'discard' : undefined;
  }
  if (verdict !== 'apply') {
    log.info(`跳过设定「${existing.title}」`, verdict === 'discard' ? '用户放弃' : '用户取消');
    return 'skipped';
  }
  if (signal.aborted) {
    log.info(`停止后不再写入设定「${existing.title}」`);
    return 'skipped';
  }
  await project.writeLore({
    slug: existing.slug,
    title: existing.title,
    keywords: item.keywords,
    body: item.body,
  });
  // 写成了：这一条挂着的失败记录该清掉。
  await clearFailures(project, 'lore', existing.relPath, 'generateLore');
  log.info(
    `已更新设定「${existing.title}」`,
    `${existing.relPath}｜${currentText.length} 字 → ${proposedText.length} 字`
  );
  return 'updated';
}

async function uniqueLoreSlug(project: NovelProject, base: string): Promise<string> {
  let slug = base;
  let suffix = 2;
  while (await exists(path.join(project.loreDir, `${slug}.md`))) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

/** 容错解析逐章识别结果；坏条目忽略，不让一章的脏输出带崩全书任务。 */
export function parseLoreCandidates(raw: string): ParsedLoreCandidate[] {
  const cleaned = stripCodeFence(raw);
  const json = extractJson(cleaned);
  if (!json) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null
      ? ((data as Record<string, unknown>).settings ?? (data as Record<string, unknown>).lore)
      : undefined;
  if (!Array.isArray(list)) {
    return [];
  }

  const out: ParsedLoreCandidate[] = [];
  for (const value of list) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const obj = value as Record<string, unknown>;
    const title = singleLineValue(obj.title ?? obj.name, 80);
    const facts = stringArray(obj.facts ?? obj.content ?? obj.details);
    if (!title || facts.length === 0) {
      continue;
    }
    const categoryRaw = stringValue(obj.category);
    const category = LORE_CATEGORIES.includes(categoryRaw as LoreCategory)
      ? (categoryRaw as LoreCategory)
      : '其他';
    out.push({
      title,
      category,
      keywords: unique(stringArray(obj.keywords)),
      facts: unique(facts),
    });
  }
  return out;
}

function parseLoreDocument(raw: string): { keywords: string[]; body: string } | undefined {
  const cleaned = stripCodeFence(raw);
  const json = extractJson(cleaned);
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const rawBody = stringValue(obj.body ?? obj.content);
  const body = stripH1(parseMarkdown(rawBody).body).trim();
  if (!body) {
    return undefined;
  }
  return { keywords: unique(stringArray(obj.keywords)), body };
}

function extractJson(text: string): string | undefined {
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  const starts = [arrayStart, objectStart].filter((n) => n >= 0);
  if (starts.length === 0) {
    return undefined;
  }
  const start = Math.min(...starts);
  const end = text[start] === '[' ? text.lastIndexOf(']') : text.lastIndexOf('}');
  return end > start ? text.slice(start, end + 1) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function singleLineValue(value: unknown, maxLength: number): string {
  return stringValue(value).replace(/\s+/g, ' ').slice(0, maxLength).trim();
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[，,、\n]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase('zh-Hans-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

const LORE_EXTRACT_SYSTEM = `你是长篇小说的世界观设定编辑。阅读单章正文，识别值得在后续写作中反复引用的稳定设定。

只提取世界规则、地理地点、组织势力、社会制度、能力体系、关键物件、历史背景等设定。不要把剧情梗概、人物性格或一次性动作当成设定；不确定的内容不要脑补。

请输出 JSON 数组，除 JSON 外不要输出任何文字：
[
  {
    "title": "简短且可复用的设定标题；同一对象必须沿用用户给出的目录标题",
    "category": "世界观|地理|势力|制度|能力|物件|历史|其他",
    "keywords": ["正文和纲要中可能出现的名称、别称或触发词"],
    "facts": ["本章明确建立或更新的原子事实，每条都能脱离本章剧情单独理解"]
  }
]

同一对象只输出一项；没有可复用设定时输出 []。`;

const LORE_SYNTHESIS_SYSTEM = `你是长篇小说的设定集编辑。把跨章节事实整理为一条精炼、可直接注入后续写作上下文的设定。

请输出一个 JSON 对象，除 JSON 外不要输出任何文字：
{
  "keywords": ["3-10 个高辨识度名称、别称或触发词"],
  "body": "Markdown 正文，不含 frontmatter 和一级标题"
}

要求：
1. 只写正文明确建立的事实，不补完、不推测；冲突或尚不确定的信息明确标注。
2. 合并重复事实，保留随剧情发生的有效更新；不要写逐章剧情摘要。
3. 若提供了作者现有内容，把它视为权威资料；只在正文明确更新时调整，不得无故删除。
4. 用简短小节或项目符号组织，重点写规则、边界、代价、关系和当前有效状态，控制在 800 字以内。
5. keywords 必须能在续写纲要中准确命中，避免“世界”“地方”“组织”等泛词。`;
