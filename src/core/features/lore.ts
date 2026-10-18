import * as path from 'node:path';
import { readConfig } from '../config';
import { runPool, serialize } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { takeHead } from '../context/tokenizer';
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { exists, hash, readText, sanitizeFileName, slugify, uniqueSlug } from '../model/fs';
import { parseMarkdown, stripH1 } from '../model/markdown';
import { describeTaskModels } from '../model/tiers';
import { NovelProject, renderLoreEntry } from '../model/project';
import { Plot, PLOT_SECTION_KEYS } from '../model/plotFile';
import { parseContinuityFacts } from '../model/continuity';
import { LoreEntry } from '../model/types';
import { LORE_ENTRY_LIMITS, cleanLoreKeywords, normalizeLoreCategory, normalizeLoreName } from '../model/loreFile';
import { runTask } from '../runtime/progress';
import { Workspace } from '../workspace';
import { finalizedPlots } from '../views/cast';
import { LoreFact, LoreRecord, UnfiledLore, buildLoreIndex } from '../views/lore';
import { LORE_ENTRY_SYSTEM, LORE_ORGANIZE_SYSTEM } from './lorePrompt';
import { extractJsonObject, stringArray, stripCodeFence, stripTrailingCommas, unique } from './parse';

const log = scoped('设定');

/**
 * 设定条目的三件维护：**建条目**（名录里出现过、还没有条目的名字）、**整合**（条目水位之后的新事实
 * 并进条目）、**按目录整理**（作者定案：分类就是目录，让模型出一份搬家清单）。
 *
 * 原料全来自**定稿过的细纲**（第九节、连续性事实、提到它的那几句），**不重读正文**——每章定稿时已经
 * 照正文记过、校验过了（features/loreRecord.ts）。从前这里是「通读全书 → 每条整合」那一套，每跑一次
 * 都从第 1 章扫起（三百章、五百条约 800 次调用），作者定案删掉：相似的东西不留两份。
 *
 * 写回的规矩（第 3 条：不静默覆盖）：
 * - 新条目直接建（不覆盖任何东西）。
 * - 整合时条目正文是机器写的（`bodyHash` 对得上，或正文是空的）：作者在确认框里选「逐条确认」还是
 *   「直接采纳」，同批量更新角色卡；作者改过的一律先给对比。
 * - 整合只并不删作者的字（提示词，第 27 条）；关键词只增不减。
 */

/** 「全部建条目」只建出现至少这么多章的（与批量建卡同一个门槛）。 */
export const BUILD_MIN_CHAPTERS = 2;
/** 按目录整理一次调用最多看几条。 */
const ORGANIZE_BATCH = 80;
/** 新目录最多几层。 */
const ORGANIZE_DEPTH = 3;
/** 建条目、整合时给模型的记录最多多少 token（原料是一句一句的记录，很少到这么多）。 */
const MATERIAL_TOKENS = 6000;

/** 模型交回来的一条。 */
interface EntryDraft {
  brief: string;
  keywords: string[];
  body: string;
}

// ---------------------------------------------------------------- 水位

/**
 * 整合能推到第几章：**第一处没定稿（或定稿之后正文又改过）的章之前**。第 5 章没定稿、第 6 章定稿了，
 * 水位最多到 4——否则第 5 章日后定稿，它的事实永远进不了条目（全书摘要的增量也是这么停的）。
 * 一章都没写是 0。
 */
async function integrationWatermark(project: NovelProject): Promise<number> {
  const chapters = [...(await project.listChapters())].sort((a, b) => a.order - b.order);
  let through = 0;
  for (const chapter of chapters) {
    if (chapter.wordCount === 0) {
      continue;
    }
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash || plot.sourceHash !== chapter.contentHash) {
      return chapter.order - 1;
    }
    through = chapter.order;
  }
  return through;
}

/** 条目正文是不是机器写的：空的，或记下的指纹对得上。没盖过章的非空正文算作者的。 */
export function loreOwnedByMachine(entry: Pick<LoreEntry, 'body' | 'bodyHash'>): boolean {
  const body = entry.body.trim();
  return !body || (!!entry.bodyHash && hash(body) === entry.bodyHash);
}

// ---------------------------------------------------------------- 原料

/**
 * 一个名字在定稿过的细纲里的**所有记录**，带章号：第九节冒号后那一句、连续性事实里提到它的、
 * 另外几节里提到它的句子。建条目的原料。
 */
function recordsAbout(plots: readonly Plot[], words: readonly string[], notes: readonly LoreFact[]): LoreFact[] {
  const out: LoreFact[] = [...notes];
  const hit = (text: string): boolean => words.some((w) => w.length >= 2 && text.includes(w));
  for (const plot of plots) {
    for (const fact of parseContinuityFacts(plot.sections.连续性事实)) {
      if (hit(fact.statement)) {
        out.push({ no: plot.no, text: fact.statement, source: 'fact' });
      }
    }
    for (const key of PLOT_SECTION_KEYS) {
      if (key === '连续性事实' || key === '出场人物') {
        continue;
      }
      for (const sentence of plot.sections[key].split(/(?<=[。！？!?])|\n+/u)) {
        const s = sentence.replace(/^\s*[-*·•]\s*/u, '').trim();
        if (s && hit(s)) {
          out.push({ no: plot.no, text: s, source: 'lore' });
        }
      }
    }
  }
  const seen = new Set<string>();
  return out
    .filter((f) => {
      const key = `${f.no}|${f.text}`;
      return !seen.has(key) && (seen.add(key), true);
    })
    .sort((a, b) => a.no - b.no);
}

function renderRecords(records: readonly LoreFact[]): string {
  return takeHead(records.map((f) => `- 第 ${f.no} 章：${f.text}`).join('\n'), MATERIAL_TOKENS);
}

// ---------------------------------------------------------------- 调模型

async function draftEntry(pool: ModelPool, label: string, user: string, signal: AbortSignal): Promise<EntryDraft> {
  const budget = pool.primaryBudget;
  const options: StreamOptions = {
    maxOutputTokens: budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: readConfig().requestTimeoutMs,
    signal,
  };
  const raw = await pool.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: LORE_ENTRY_SYSTEM },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const draft = parseEntryDraft(raw);
  if (!draft) {
    throw new Error(`模型返回无法解析（${raw.length} 字）`);
  }
  return draft;
}

/** `{brief, keywords, body}`；正文为空或不是 JSON 返回 undefined。正文里带了一级标题就剥掉。 */
export function parseEntryDraft(raw: string): EntryDraft | undefined {
  const obj = jsonObject(raw);
  if (!obj) {
    return undefined;
  }
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const body = stripH1(parseMarkdown(text(obj.body ?? obj.content)).body).trim();
  if (!body) {
    return undefined;
  }
  return {
    brief: text(obj.brief ?? obj.一句话).replace(/\s+/g, ' ').slice(0, LORE_ENTRY_LIMITS.brief),
    keywords: unique(stringArray(obj.keywords ?? obj.关键词)),
    body,
  };
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  for (const candidate of [json, stripTrailingCommas(json)]) {
    try {
      const data: unknown = JSON.parse(candidate);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      // 下一个写法
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 建条目

/**
 * 给名录里「出现过 · 未建条目」的名字建条目。给了 `names` 就建那几个；没给就建**出现 ≥2 章**的全部。
 * 每条 1 次，原料是定稿细纲里提到它的记录（不重读正文），新文件建在它的分类目录里（不存在就建）。
 */
export async function buildLoreEntries(project: NovelProject, names?: readonly string[]): Promise<void> {
  const host = getHost();
  const index = await buildLoreIndex(project);
  const wanted = names?.map(normalizeLoreName).filter(Boolean);
  const targets = wanted?.length
    ? index.unknown.filter((u) => wanted.includes(normalizeLoreName(u.name)))
    : index.unknown.filter((u) => u.chapters.length >= BUILD_MIN_CHAPTERS);
  if (targets.length === 0) {
    host.toast(
      wanted?.length
        ? '名录里没有这个名字，或者它已经有条目了。'
        : `没有出现 ${BUILD_MIN_CHAPTERS} 章以上、还没建条目的设定。`
    );
    return;
  }
  const config = readConfig();
  const n = targets.length;
  const lanes = Math.max(1, Math.min(config.concurrency, n));
  const picked = await host.confirm(
    `建 ${n} 条设定：每条调用模型 1 次，共 ${n} 次。只读定稿过的细纲里提到它们的那几行，不重读正文。`,
    ['开始建'],
    {
      modal: true,
      detail: [
        `要建的：${targets.slice(0, 20).map((u) => u.name).join('、')}${n > 20 ? ` 等 ${n} 条` : ''}`,
        wanted?.length ? '' : `只建出现 ${BUILD_MIN_CHAPTERS} 章以上的；出现得少的可以在「出现过 · 未建条目」里一条一条建。`,
        describeTaskModels(config, 'loreSynthesis'),
        lanes > 1 ? `最多 ${lanes} 条同时建。` : '一条一条串行建（并发数为 1）。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (picked !== '开始建') {
    log.info('作者取消了建条目');
    return;
  }
  const pool = await createModelPool({ task: 'loreSynthesis', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，建条目中止');
    return;
  }

  await runTask(
    '建设定条目',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const { created, failed } = await createLoreEntries(project, targets, { signal, pool, lanes, report });
      const summary = `新建 ${created} 条设定${failed > 0 ? `，失败 ${failed} 条（详见日志页）` : ''}`;
      log.info('建条目结束', `${summary}｜总耗时 ${elapsed(startedAt)}`);
      host.toast(`${summary}。`);
    },
    { scope: '设定' }
  );
}

/**
 * 建条目本身：**不问、不弹框**，调用方已经把条数与次数报过了（第 4 条）。每条 1 次，最多 `lanes` 条同时建；
 * 原料是定稿细纲里提到它的记录，水位记到 {@link integrationWatermark}。「建条目」与拆书「从已写正文补齐」
 * （features/derive.ts）共用。一条失败不连累别的，失败的写日志、计进 `failed`。
 */
export async function createLoreEntries(
  project: NovelProject,
  targets: readonly UnfiledLore[],
  opts: {
    signal: AbortSignal;
    pool: ModelPool;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ created: number; failed: number }> {
  const n = targets.length;
  const [plots, through] = await Promise.all([
    project.listChapters().then(async (chapters) => finalizedPlots(project.pairPlots(await project.listPlots(), chapters))),
    integrationWatermark(project),
  ]);
  let created = 0;
  let failed = 0;
  const siblings = targets.map((t) => t.name);
  await runPool([...targets], opts.lanes, (u) => buildOne(project, u, plots, through, opts.pool, opts.signal, siblings), {
    signal: opts.signal,
    onSettled: (result, u, _i, done) => {
      if (result.status === 'fulfilled') {
        created++;
      } else {
        failed++;
        log.error(`设定「${u.name}」建条目失败`, describeError(result.reason));
      }
      opts.report({ message: `已建 ${done}/${n} 条`, current: done, total: n });
    },
  });
  project.invalidate();
  return { created, failed };
}

async function buildOne(
  project: NovelProject,
  u: UnfiledLore,
  plots: readonly Plot[],
  through: number,
  pool: ModelPool,
  signal: AbortSignal,
  siblings: readonly string[]
): Promise<void> {
  const records = recordsAbout(plots, [u.name], u.notes);
  const category = normalizeLoreCategory(u.category);
  const draft = await draftEntry(
    pool,
    `设定「${u.name}」建条目`,
    `设定：${u.name}\n分类：${category || '未分类'}\n\n定稿细纲里关于它的记录（按章号）：\n${renderRecords(records)}`,
    signal
  );
  if (signal.aborted) {
    return;
  }
  // 等模型的时候作者可能已经手建了一条：撞上了就不建，不覆盖。
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  if (entries.some((e) => normalizeLoreName(e.title) === normalizeLoreName(u.name))) {
    log.info(`设定「${u.name}」已经有条目了，这一条不建`);
    return;
  }
  const keywords = cleanLoreKeywords(u.name, draft.keywords, {
    // 同一批里一起建的那几个名字也算「别的条目」：它们这一刻还没有文件。
    titles: [...entries.map((e) => e.title), ...siblings],
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
  });
  const slug = await uniqueSlug(project.loreDir, `${category ? `${category}/` : ''}${slugify(u.name)}`);
  const relPath = await new Workspace(project).writeLore({
    slug,
    title: u.name,
    keywords: [u.name, ...keywords],
    brief: draft.brief,
    body: draft.body,
    updatedThrough: through,
    bodyHash: hash(draft.body.trim()),
  });
  log.info(`新建设定「${u.name}」`, `${relPath}｜依据 ${records.length} 条记录｜${draft.body.length} 字`);
}

// ---------------------------------------------------------------- 整合

/** 一条要整合的：条目与水位之内的新事实。 */
interface IntegratePlan {
  record: LoreRecord;
  facts: LoreFact[];
}

/**
 * 把条目水位之后、定稿过的新事实并进条目。给了 `relPaths` 就整合那几条；没给就是名录上挂 `＋N` 的全部。
 * 每条 1 次。水位推到 {@link integrationWatermark}，更晚的事实留到下次（它们照样作为尾巴带进上下文）。
 */
export async function integrateLore(project: NovelProject, relPaths?: readonly string[]): Promise<void> {
  const host = getHost();
  const [index, through] = await Promise.all([buildLoreIndex(project), integrationWatermark(project)]);
  const plans: IntegratePlan[] = index.known
    .filter((r) => !relPaths?.length || relPaths.includes(r.entry.relPath))
    .map((record) => ({ record, facts: record.pending.filter((f) => f.no <= through) }))
    .filter((p) => p.facts.length > 0);
  if (plans.length === 0) {
    const waiting = index.known.some(
      (r) => (!relPaths?.length || relPaths.includes(r.entry.relPath)) && r.pending.length > 0
    );
    host.toast(
      waiting
        ? `新内容在第 ${through + 1} 章之后：第 ${through + 1} 章还没定稿（或定稿之后正文又改过），整合停在它前面。`
        : relPaths?.length
          ? '这一条没有新内容要整合。'
          : '没有要整合的设定：条目都跟上了定稿。'
    );
    return;
  }
  const config = readConfig();
  const n = plans.length;
  const authored = plans.filter((p) => !loreOwnedByMachine(p.record.entry)).length;
  const lanes = Math.max(1, Math.min(config.concurrency, n));
  const buttons = authored < n ? ['逐条确认后开始', '机器写的直接采纳并开始'] : ['逐条确认后开始'];
  const picked = await host.confirm(
    `整合 ${n} 条设定：每条调用模型 1 次，共 ${n} 次。把定稿里的新内容并进条目（整合到第 ${through} 章）。`,
    buttons,
    {
      modal: true,
      detail: [
        `要整合的：${plans.slice(0, 20).map((p) => p.record.entry.title).join('、')}${n > 20 ? ` 等 ${n} 条` : ''}`,
        authored > 0 ? `其中 ${authored} 条你改过，不管选哪个都会先给你对比再写。` : '',
        describeTaskModels(config, 'loreSynthesis'),
        lanes > 1 ? `最多 ${lanes} 条同时整合；逐条确认时，对比按完成顺序一条一条弹出。` : '一条一条串行整合（并发数为 1）。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (!picked) {
    log.info('作者取消了整合设定');
    return;
  }
  const autoApply = picked === '机器写的直接采纳并开始';
  const pool = await createModelPool({ task: 'loreSynthesis', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，整合设定中止');
    return;
  }

  await runTask(
    '整合设定',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      await runPool(plans, lanes, (p) => integrateOne(project, p, through, autoApply, pool, signal), {
        signal,
        onSettled: (result, p, _i, done) => {
          if (result.status === 'fulfilled') {
            if (result.value) {
              updated++;
            } else {
              skipped++;
            }
          } else {
            failed++;
            log.error(`设定「${p.record.entry.title}」整合失败`, describeError(result.reason));
            void recordFailure(project, {
              scope: '设定',
              targetKind: 'lore',
              targetKey: p.record.entry.relPath,
              severity: 'error',
              op: 'integrateLore',
              message: `整合失败：${describeError(result.reason)}`,
              detail: `这一条没有改动｜要并进的是第 ${unique(p.facts.map((f) => String(f.no))).join('、')} 章的新内容`,
            });
          }
          report({ message: `已整合 ${done}/${n} 条`, current: done, total: n });
        },
      });
      project.invalidate();
      const summary =
        `更新 ${updated} 条设定` +
        (skipped > 0 ? `，没采纳 ${skipped} 条` : '') +
        (failed > 0 ? `，失败 ${failed} 条（详见日志页）` : '');
      log.info('整合设定结束', `${summary}｜总耗时 ${elapsed(startedAt)}`);
      host.toast(`${summary}。`);
    },
    { scope: '设定' }
  );
}

/** 整合一条。返回是否写了。 */
async function integrateOne(
  project: NovelProject,
  plan: IntegratePlan,
  through: number,
  autoApply: boolean,
  pool: ModelPool,
  signal: AbortSignal
): Promise<boolean> {
  const { entry } = plan.record;
  const user = [
    `设定：${entry.title}`,
    `分类：${entry.category || '未分类'}`,
    entry.keywords.length > 0 ? `已有关键词：${entry.keywords.join('、')}` : '',
    '',
    `现有条目（作者认可过的内容，记录没有明确推翻的不删）：\n一句话：${entry.brief || '（没写）'}\n${entry.body.trim() || '（还是空的）'}`,
    '',
    `第 ${entry.updatedThrough ?? 0} 章之后定稿细纲里关于它的新记录（按章号）：\n${renderRecords(plan.facts)}`,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  const draft = await draftEntry(pool, `设定「${entry.title}」整合`, user, signal);
  if (signal.aborted) {
    return false;
  }
  // 已有的关键词原样留着（只增不减，可能是作者写的）；模型新给的过一遍人名与别的条目的标题。
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const fresh = cleanLoreKeywords(entry.title, draft.keywords, {
    titles: entries.filter((e) => e.slug !== entry.slug).map((e) => e.title),
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
  });
  const proposed = renderLoreEntry({
    slug: entry.slug,
    title: entry.title,
    keywords: unique([...entry.keywords, ...fresh]),
    brief: draft.brief || entry.brief,
    body: draft.body,
    updatedThrough: through,
    bodyHash: hash(draft.body.trim()),
  });
  const abs = project.pathOf(entry.relPath);
  const machine = loreOwnedByMachine(entry);
  if (!(machine && autoApply)) {
    const verdict = await serialize(async () => {
      // 排到队之前文件可能已被别处改过，进队后再读一次才是当下的真相。
      const current = await readText(abs);
      const host = getHost();
      if (host.reviewReplace) {
        return plainVerdict(await host.reviewReplace(`设定「${entry.title}」`, current, proposed, entry.relPath));
      }
      const pick = await host.confirm(`已整合设定「${entry.title}」。采纳？`, ['采纳', '跳过'], { modal: true });
      return pick === '采纳' ? 'apply' : pick === '跳过' ? 'discard' : undefined;
    });
    if (verdict !== 'apply' || signal.aborted) {
      log.info(`没采纳设定「${entry.title}」的整合`, verdict === 'discard' ? '作者放弃' : '作者取消');
      return false;
    }
  }
  await new Workspace(project).write(entry.relPath, { text: proposed }, { mode: 'overwrite', review: false });
  await clearFailures(project, 'lore', entry.relPath, 'integrateLore');
  log.info(
    `已整合设定「${entry.title}」`,
    `${entry.relPath}｜并进 ${plan.facts.length} 条新记录｜整合到第 ${through} 章${machine ? '' : '｜作者改过，对比后采纳'}`
  );
  return true;
}

// ---------------------------------------------------------------- 按目录整理

/** 整理的范围：只整理根目录下（未分类）的，还是全部。 */
export type OrganizeScope = 'unfiled' | 'all';

/** 校验过的一次搬家。 */
export interface LoreMove {
  from: string;
  /** 现在所在的目录（相对 `lore/`，根目录是空串）。 */
  category: string;
  /** 目标目录（相对 `lore/`，根目录是空串）。 */
  to: string;
  title: string;
}

/**
 * 按目录整理（作者定案）。模型只出一份搬家清单，程序校验，作者看过点了「照这样整理」才搬；
 * 搬家走网关的 `move`（只在设定区里），**条目内容一个字不改**。`scope` 没给就先问。
 */
export async function organizeLore(project: NovelProject, scope?: OrganizeScope): Promise<void> {
  const host = getHost();
  const entries = await project.listLore();
  if (entries.length === 0) {
    host.toast('还没有设定条目，没什么可整理的。');
    return;
  }
  const unfiled = entries.filter((e) => !e.category).length;
  let range = scope;
  if (!range) {
    const ask = await host.confirm(
      `按目录整理设定：让模型照本书的目录树给条目归类，先出一份搬家清单给你看，你点头了才搬。`,
      [...(unfiled > 0 ? [`只整理未分类的 ${unfiled} 条`] : []), `全部 ${entries.length} 条都看一遍`],
      { modal: true, detail: '目录就是分类，可以多层；模型可以提议新目录。只搬文件，条目内容一个字不改。' }
    );
    if (!ask) {
      return;
    }
    range = ask.startsWith('只整理') ? 'unfiled' : 'all';
  }
  const targets = range === 'unfiled' ? entries.filter((e) => !e.category) : entries;
  if (targets.length === 0) {
    host.toast('根目录下没有未分类的条目。');
    return;
  }
  const batches = chunk(targets, ORGANIZE_BATCH);
  const config = readConfig();
  const go = await host.confirm(
    `整理 ${targets.length} 条设定：分 ${batches.length} 批，调用模型 ${batches.length} 次，出一份搬家清单。`,
    ['开始'],
    { modal: true, detail: describeTaskModels(config, 'loreSynthesis') }
  );
  if (go !== '开始') {
    return;
  }
  const pool = await createModelPool({ task: 'loreSynthesis', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，整理中止');
    return;
  }

  await runTask(
    '按目录整理设定',
    async ({ signal, report }) => {
      const categories = await project.listLoreCategories();
      const folders = new Set<string>();
      const moves: LoreMove[] = [];
      const notes: string[] = [];
      for (const [i, batch] of batches.entries()) {
        if (signal.aborted) {
          return;
        }
        report({ message: `第 ${i + 1}/${batches.length} 批`, current: i, total: batches.length });
        try {
          const raw = await pool.run(`整理设定第 ${i + 1} 批`, (llm) =>
            collectText(
              llm.stream(
                [
                  { role: 'system', content: LORE_ORGANIZE_SYSTEM },
                  { role: 'user', content: organizePrompt([...categories, ...folders], batch) },
                ],
                { maxOutputTokens: pool.primaryBudget.maxOutputTokens, temperature: 0.2, timeoutMs: config.requestTimeoutMs, signal }
              )
            )
          );
          const plan = checkOrganizePlan(raw, batch, [...categories, ...folders]);
          plan.folders.forEach((f) => folders.add(f));
          moves.push(...plan.moves);
          notes.push(...plan.dropped);
        } catch (err) {
          if (signal.aborted) {
            return;
          }
          log.error(`整理设定第 ${i + 1} 批失败`, describeError(err));
          notes.push(`第 ${i + 1} 批失败：${describeError(err)}`);
        }
      }
      if (notes.length > 0) {
        log.warn(`搬家清单里有 ${notes.length} 处没收`, notes.join('\n'));
      }
      const used = new Set(moves.map((m) => m.to));
      const newFolders = [...folders].filter((f) => used.has(f) || moves.some((m) => m.to.startsWith(`${f}/`)));
      if (moves.length === 0) {
        host.toast('都放得好好的，不用搬。');
        return;
      }
      const listing = moves.slice(0, 60).map((m) => `${m.title}：${m.category || '未分类'} → ${m.to || '未分类'}`);
      const ok = await host.confirm(
        `搬 ${moves.length} 条设定${newFolders.length > 0 ? `，新建 ${newFolders.length} 个目录` : ''}。只搬文件，条目内容一个字不改。`,
        ['照这样整理'],
        {
          modal: true,
          detail: [
            newFolders.length > 0 ? `新目录：${newFolders.join('、')}` : '',
            listing.join('\n') + (moves.length > 60 ? `\n……还有 ${moves.length - 60} 条` : ''),
            notes.length > 0 ? `另有 ${notes.length} 处没收（详见日志页）。` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        }
      );
      if (ok !== '照这样整理') {
        log.info('作者没采纳搬家清单');
        return;
      }
      const moved = await applyMoves(project, newFolders, moves);
      host.toast(`已搬 ${moved} 条设定${moved < moves.length ? `，${moves.length - moved} 条没搬（详见日志页）` : ''}。`);
    },
    { scope: '设定' }
  );
}

function organizePrompt(categories: readonly string[], batch: readonly LoreEntry[]): string {
  return [
    `本书现有目录：${categories.length > 0 ? categories.join('、') : '（还没有目录）'}`,
    '',
    '要整理的条目（路径｜标题｜一句话）：',
    ...batch.map((e) => `- ${e.slug}｜${e.title}｜${e.brief || e.body.trim().split(/\n/)[0]?.slice(0, LORE_ENTRY_LIMITS.brief) || ''}`),
  ].join('\n');
}

/**
 * 校验模型给的搬家清单：`from` 得是这一批里的条目（认路径或标题），`to` 得是已有目录或这次提议的新目录
 * （最多三层、每段是合法的文件名），位置没变的去掉，同一条只搬一次。没收的写进 `dropped`（第 2 条）。
 */
export function checkOrganizePlan(
  raw: string,
  batch: readonly LoreEntry[],
  categories: readonly string[]
): { folders: string[]; moves: LoreMove[]; dropped: string[] } {
  const obj = jsonObject(raw);
  if (!obj) {
    throw new Error(`模型返回无法解析（${raw.length} 字）`);
  }
  const folders: string[] = [];
  const dropped: string[] = [];
  for (const f of stringArray(obj.folders)) {
    const dir = normalizeLoreCategory(f);
    const parts = dir.split('/');
    if (!dir || parts.length > ORGANIZE_DEPTH || parts.some((p) => sanitizeFileName(p) !== p)) {
      dropped.push(`新目录「${f}」不合规`);
      continue;
    }
    if (!folders.includes(dir) && !categories.includes(dir)) {
      folders.push(dir);
    }
  }
  const allowed = new Set([...categories, ...folders, '']);
  const bySlug = new Map(batch.map((e) => [e.slug, e]));
  const byTitle = new Map(batch.map((e) => [normalizeLoreName(e.title), e]));
  const moves: LoreMove[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(obj.moves) ? obj.moves : []) {
    const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const from = typeof m.from === 'string' ? m.from.trim().replace(/^\.novelforge\/lore\//, '').replace(/\.md$/i, '') : '';
    const entry = bySlug.get(from) ?? byTitle.get(normalizeLoreName(from));
    if (!entry) {
      dropped.push(`「${from}」不是这一批里的条目`);
      continue;
    }
    const to = normalizeLoreCategory(typeof m.to === 'string' ? m.to : '');
    if (!allowed.has(to)) {
      dropped.push(`「${entry.title}」要去的「${to}」既不是已有目录，也没在 folders 里新建`);
      continue;
    }
    if (to === entry.category || seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    moves.push({ from: entry.relPath, category: entry.category, to, title: entry.title });
  }
  return { folders, moves, dropped };
}

/**
 * 搬文件。返回搬了几条。目标位置已有同名文件的不搬、说出来。
 *
 * **新目录不先建**：`ws.move` 落盘前自己补齐父目录（落点过网关的守卫，第 7 条），所以新目录只在真有条目搬进去时出现。
 * 从前这里先直接 `fs.mkdir` 建出清单上的每个新目录（绕过网关）——它唯一的效果是：搬不成的时候留下一个空目录。
 */
async function applyMoves(project: NovelProject, folders: readonly string[], moves: readonly LoreMove[]): Promise<number> {
  const root = project.relPath(project.loreDir);
  const ws = new Workspace(project);
  let moved = 0;
  for (const m of moves) {
    const next = `${root}/${m.to ? `${m.to}/` : ''}${path.posix.basename(m.from)}`;
    if (await exists(project.pathOf(next))) {
      log.warn(`设定「${m.title}」没搬：目标位置已有同名文件`, `${m.from} → ${next}`);
      continue;
    }
    try {
      await ws.move(m.from, next);
      // 失败记录按路径挂，搬了家就挂不住了：一并收掉，下次失败再挂。
      await clearFailures(project, 'lore', m.from);
      moved++;
    } catch (err) {
      log.warn(`设定「${m.title}」没搬：${describeError(err)}`, `${m.from} → ${next}`);
    }
  }
  project.invalidate();
  let created = 0;
  for (const dir of folders) {
    created += (await exists(project.pathOf(`${root}/${dir}`))) ? 1 : 0;
  }
  log.info('按目录整理设定', `搬了 ${moved}/${moves.length} 条｜新目录 ${created}/${folders.length} 个`);
  return moved;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
