import { appearancesOf, buildCastIndex, describeChapters } from '../cast';
import { readConfig } from '../config';
import { getHost } from '../host';
import * as path from 'node:path';
import { collectStream, ChatOptions, LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { elapsed, scoped } from '../logger';
import { runTask } from '../progress';
import {
  NovelProject,
  emptyCharacterSections,
  exists,
  readText,
  renderCharacterCard,
  slugify,
  writeText,
} from '../model/project';
import { CHARACTER_SECTION_KEYS, Chapter, CharacterCard, CharacterSections } from '../model/types';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { stripCodeFence } from './summarize';

const log = scoped('角色卡');

/**
 * 单个角色的档案更新——右键角色行上的「更新角色卡」。
 *
 * 与 `extractCharacters`（一次从几章里扒出一批人）互补：那条流程面向
 * 「刚写完几章，把新出现的人补上」，这条面向「这个人写了三十章了，
 * 把他的档案重新过一遍」。
 *
 * 三件事是这条流程存在的理由：
 *
 * 1. **自动关联出场章节**。作者不必再手输章节号——出场章节由摘要索引给出。
 * 2. **控制上下文**。主角可能出现在几十章里，一次塞不进窗口，按输入预算
 *    切成多批、逐批精炼同一张卡（后一批看得到前一批的产出）。
 * 3. **先说要调几次模型**。分批意味着 N 次请求，动手前必须把 N 告诉作者
 *    ——「不偷偷烧 token」。
 */

/** 更新范围。 */
export type UpdateScope =
  /** 只读上次更新之后的新出场章节。首次更新时等同于全量。 */
  | 'incremental'
  /** 从头通读该角色的全部出场章节。 */
  | 'full';

export interface Batch {
  chapters: Chapter[];
  /** 这一批的语料（已按预算截断）。 */
  corpus: string;
}

/**
 * 更新一张已有角色卡。
 *
 * @param relPath 角色卡的工作区相对路径。
 * @param scope 增量还是全量；不给则问用户。
 */
export async function updateCharacterCard(
  project: NovelProject,
  relPath: string,
  scope?: UpdateScope
): Promise<void> {
  const cards = await project.listCharacters();
  const card = cards.find((c) => c.relPath === relPath);
  if (!card) {
    log.warn(`找不到角色卡 ${relPath}，可能刚被改名或删除`);
    getHost().toast('找不到这张角色卡，可能刚被改名或删除。', 'error');
    return;
  }

  const index = await buildCastIndex(project);
  const all = appearancesOf(index, card);
  if (all.length === 0) {
    log.warn(
      `「${card.name}」未在任何章节摘要中出现`,
      index.summaryCount === 0
        ? '这个工程还没有任何章节摘要，先运行「同步过期摘要」。'
        : '摘要里没有这个名字。可能是角色卡的 name/aliases 与正文里的写法对不上。'
    );
    getHost().toast(
      index.summaryCount === 0
        ? '还没有章节摘要，请先运行「同步过期摘要」。'
        : `摘要里没有出现「${card.name}」，无法自动关联章节。`,
      'error'
    );
    return;
  }

  const updatedThrough = card.updatedThrough ?? 0;
  const fresh = all.filter((o) => o > updatedThrough);

  // 增量没有新章节时不必白跑一趟模型。
  if (scope === 'incremental' && fresh.length === 0) {
    log.info(`「${card.name}」自第 ${updatedThrough} 章以来没有新的出场章节`);
    getHost().toast(`「${card.name}」没有新的出场章节，无需更新。`);
    return;
  }

  const picked = scope ?? (await askScope(card, all, fresh));
  if (!picked) {
    log.info('用户取消了更新');
    return;
  }
  const orders = picked === 'incremental' && fresh.length > 0 ? fresh : all;

  const chapters = (await project.listChapters()).filter((c) => orders.includes(c.order));
  if (chapters.length === 0) {
    log.warn(`「${card.name}」的出场章节都已不在磁盘上`, `摘要记录：${describeChapters(orders)}`);
    getHost().toast('这些出场章节的正文已不存在。', 'error');
    return;
  }

  await runUpdate(project, card, chapters, {
    scope: picked,
    // 全量重来时 lastSeen/appearsIn 以完整清单为准；增量只补新的。
    allAppearances: all,
  });
}

/** 批量计划里的一张卡。 */
export interface CardUpdatePlan {
  card: CharacterCard;
  /** 本次要读的出场章节序号。 */
  orders: number[];
  /** 预先算好的分批（总确认报调用次数用，执行时不重算）。 */
  batches: Batch[];
  /** 真正参与分析的章节数（空章节已剔除）。 */
  chapters: number;
}

export interface BatchUpdatePlan {
  plans: CardUpdatePlan[];
  skipped: { card: CharacterCard; reason: string }[];
}

/**
 * 批量计划：列出全部角色卡，逐卡算出要读哪些章、分几批。
 * 增量模式只取 updatedThrough 之后的新出场；无新出场/未在摘要出现/
 * 出场章节已不在磁盘/正文全空的卡计入 skipped。导出供总确认与冒烟测试。
 */
export async function planAllUpdates(project: NovelProject, scope: UpdateScope): Promise<BatchUpdatePlan> {
  const cards = await project.listCharacters();
  const index = await buildCastIndex(project);
  const config = readConfig();
  const allChapters = await project.listChapters();
  const result: BatchUpdatePlan = { plans: [], skipped: [] };

  for (const card of cards) {
    const all = appearancesOf(index, card);
    if (all.length === 0) {
      result.skipped.push({ card, reason: '未在摘要中出现' });
      continue;
    }
    const orders = scope === 'incremental' ? all.filter((o) => o > (card.updatedThrough ?? 0)) : all;
    if (orders.length === 0) {
      result.skipped.push({ card, reason: '没有新的出场章节' });
      continue;
    }
    const chapters = allChapters.filter((c) => orders.includes(c.order));
    if (chapters.length === 0) {
      result.skipped.push({ card, reason: '出场章节已不在磁盘上' });
      continue;
    }
    const batches = await planBatches(project, chapters, config);
    if (batches.length === 0) {
      result.skipped.push({ card, reason: '章节正文都为空' });
      continue;
    }
    result.plans.push({
      card,
      orders,
      batches,
      chapters: batches.reduce((sum, b) => sum + b.chapters.length, 0),
    });
  }
  return result;
}

/**
 * 批量更新全部角色卡——工程页「角色」分组的右键动作。
 * incremental：每卡只读上次更新后的新出场章节；full：每卡全量重读。
 *
 * 「不偷偷烧 token」：总确认框先报清卡数、章数、批数（= 预计调用次数），
 * 并让用户选采纳方式（逐张 diff 确认 / 全部直接采纳）。
 */
export async function updateAllCharacterCards(project: NovelProject, scope: UpdateScope): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，批量更新中止');
    return;
  }
  const config = readConfig();
  const { plans, skipped } = await planAllUpdates(project, scope);
  if (plans.length === 0) {
    log.info('没有需要更新的角色卡', skipped.length > 0 ? `跳过 ${skipped.length} 张` : undefined);
    getHost().toast(
      `没有需要更新的角色卡${skipped.length > 0 ? `（${skipped.length} 张被跳过）` : ''}。`
    );
    return;
  }

  const totalBatches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  const totalChapters = plans.reduce((sum, p) => sum + p.chapters, 0);
  const label = scope === 'incremental' ? '更新' : '从头重建';
  const pick = await getHost().confirm(
    `${label} ${plans.length} 张角色卡：共需通读 ${totalChapters} 章，` +
      `分 ${totalBatches} 批，预计调用模型 ${totalBatches} 次。现在开始？`,
    ['逐张确认后开始', '全部直接采纳并开始'],
    {
      modal: true,
      detail:
        skipped.length > 0
          ? `跳过 ${skipped.length} 张：${skipped.map((s) => `「${s.card.name}」（${s.reason}）`).join('、')}`
          : undefined,
    }
  );
  if (!pick) {
    log.info('用户取消了批量更新');
    return;
  }
  const autoApply = pick === '全部直接采纳并开始';

  log.info(
    `开始批量${label}角色卡`,
    `${plans.length} 张｜${totalChapters} 章分 ${totalBatches} 批｜模型 ${provider.label}｜` +
      (autoApply ? '全部直接采纳' : '逐张确认')
  );

  await runTask(
    `批量${label}角色卡`,
    async ({ signal, report }) => {
      // 每张卡的步数（批数 + 写入那一步），累加成总进度条的分母。
      const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
      let done = 0;
      let updated = 0;
      let failed = 0;
      let discarded = 0;

      for (let i = 0; i < plans.length; i++) {
        if (signal.aborted) {
          break;
        }
        const plan = plans[i];
        // 分批在确认前已算好（语料也已读取）；此处直接按既定计划执行。
        const outcome = await runCardUpdate(
          project,
          plan.card,
          { scope, allAppearances: plan.orders, batches: plan.batches, skipReview: autoApply },
          {
            signal,
            report: (message, current) =>
              report({
                message: `第 ${i + 1}/${plans.length} 张「${plan.card.name}」· ${message}`,
                current: done + (current ?? 0),
                total: totalSteps,
              }),
            provider,
            config,
          }
        );
        done += plan.batches.length + 1;
        if (outcome.status === 'updated') updated++;
        else if (outcome.status === 'failed') failed++;
        else if (outcome.status === 'discarded') discarded++;
        else if (outcome.status === 'cancelled') break;
      }

      report({ message: '完成', current: totalSteps, total: totalSteps });
      const summary =
        `已更新 ${updated} 张` +
        (discarded > 0 ? `，放弃 ${discarded} 张` : '') +
        (failed > 0 ? `，失败 ${failed} 张` : '') +
        (skipped.length > 0 ? `，跳过 ${skipped.length} 张` : '');
      log.info(`批量${label}角色卡结束`, summary);
      getHost().toast(`角色卡${label}完成：${summary}。`);
      // 与单卡流程不同：批量结束后不自动打开卡——连开几十个标签是灾难，
      // 每张卡的路径已经在日志里了。
    },
    { scope: '角色卡' }
  );
}

/**
 * 给摘要里出现、但还没建卡的人物建一张卡，并立刻用它的出场章节跑一次提取。
 * 工程页「出场人物 · 未建卡」那一组的右键动作。
 */
export async function createCardForCast(project: NovelProject, name: string): Promise<void> {
  const index = await buildCastIndex(project);
  const member = index.unknown.find((m) => m.name === name);
  if (!member) {
    log.warn(`摘要里已经没有「${name}」了，可能摘要刚被重算`);
    getHost().toast(`摘要里没有「${name}」了，请刷新工程页。`, 'error');
    return;
  }

  const chapters = (await project.listChapters()).filter((c) => member.chapters.includes(c.order));
  if (chapters.length === 0) {
    getHost().toast('这些出场章节的正文已不存在。', 'error');
    return;
  }

  // 先落一张空卡：这样即使模型调用失败/被取消，作者也拿到了一个可手写的档案，
  // 而不是白点一次。slug 冲突时自动加后缀。
  const slug = await uniqueSlug(project.charactersDir, slugify(name));
  const relPath = await project.writeCharacter({
    slug,
    name,
    aliases: member.aliases,
    tags: [],
    firstAppear: member.chapters[0],
    lastSeen: member.chapters[member.chapters.length - 1],
    appearsIn: member.chapters,
    sections: emptyCharacterSections(),
  });
  log.info(`新建角色卡「${name}」`, `${relPath}｜出场 ${describeChapters(member.chapters)}`);

  const card = (await project.listCharacters()).find((c) => c.relPath === relPath);
  if (!card) {
    return;
  }
  await runUpdate(project, card, chapters, {
    scope: 'full',
    allAppearances: member.chapters,
    // 刚建出来的空卡没有可覆盖的人工内容，不必走 diff 审阅。
    skipReview: true,
  });
}

// ---------------------------------------------------------------- 核心流程

/** 单卡执行的结果。批量编排据此统计。 */
export interface CardUpdateOutcome {
  status: 'updated' | 'discarded' | 'failed' | 'cancelled';
  /** status 为 updated 时给出推进后的水位线。 */
  updatedThrough?: number;
}

async function runUpdate(
  project: NovelProject,
  card: CharacterCard,
  chapters: Chapter[],
  opts: { scope: UpdateScope; allAppearances: number[]; skipReview?: boolean }
): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，更新中止');
    return;
  }
  const config = readConfig();
  const batches = await planBatches(project, chapters, config);
  if (batches.length === 0) {
    log.warn(`「${card.name}」的出场章节都是空的`);
    getHost().toast('这些章节都是空的，没有可分析的内容。', 'error');
    return;
  }

  // 空章节在 planBatches 里被剔掉了，报数以真正要读的为准——
  // 说「通读 12 章」却只读了 9 章，作者对不上账。
  const willRead = batches.reduce((sum, b) => sum + b.chapters.length, 0);
  const skipped = chapters.length - willRead;
  if (skipped > 0) {
    log.warn(`${skipped} 章正文为空，不参与分析`);
  }

  // 「不偷偷烧 token」：要调几次模型，动手前说清楚。
  const scopeLabel = opts.scope === 'incremental' ? '增量更新' : '全量重建';
  const confirm = await getHost().confirm(
    `${scopeLabel}「${card.name}」的角色卡：需要通读 ${willRead} 章，` +
      `分 ${batches.length} 批，预计调用模型 ${batches.length} 次。现在开始？`,
    ['开始'],
    {
      modal: true,
      detail:
        [
          batches.length > 1
            ? '章节太多，一次装不进上下文窗口，因此分批处理：后一批会看到前一批已经归纳出的内容，逐批精炼同一张卡。'
            : '',
          skipped > 0 ? `（另有 ${skipped} 章正文为空，已跳过。）` : '',
        ]
          .filter(Boolean)
          .join('\n\n') || undefined,
    }
  );
  if (confirm !== '开始') {
    log.info('用户取消了更新');
    return;
  }

  log.info(
    `开始${scopeLabel}「${card.name}」`,
    `${willRead} 章分 ${batches.length} 批｜章节 ${describeChapters(
      batches.flatMap((b) => b.chapters.map((c) => c.order))
    )}｜模型 ${provider.label}`
  );

  await runTask(
    `更新角色卡「${card.name}」`,
    async ({ signal, report }) => {
      const outcome = await runCardUpdate(
        project,
        card,
        { scope: opts.scope, allAppearances: opts.allAppearances, batches, skipReview: opts.skipReview },
        {
          signal,
          report: (message, current, total) => report({ message, current, total }),
          provider,
          config,
        }
      );
      if (outcome.status === 'updated') {
        getHost().toast(`「${card.name}」已更新，覆盖至第 ${outcome.updatedThrough} 章。`);
        await getHost().openFile(card.relPath);
      }
    },
    { scope: '角色卡' }
  );
}

/**
 * 单张卡的执行体：分批分析 → 合并 → 审阅/写回。
 *
 * 不自己开 runTask，进度经 ctx.report 交给外层——单卡与批量共用一条
 * 进度条，不叠两层。`batches` 由外层算好传入：批量场景在总确认前已算过
 * 一次，执行时不必重读章节。
 */
async function runCardUpdate(
  project: NovelProject,
  card: CharacterCard,
  opts: {
    scope: UpdateScope;
    allAppearances: number[];
    batches: Batch[];
    skipReview?: boolean;
  },
  ctx: {
    signal: AbortSignal;
    report: (message: string, current?: number, total?: number) => void;
    provider: LlmProvider;
    config: { contextWindow: number; maxOutputTokens: number; requestTimeoutMs: number };
  }
): Promise<CardUpdateOutcome> {
  const startedAt = Date.now();
  const { batches } = opts;
  // 批数 + 最后写入那一步。
  const steps = batches.length + 1;
  let sections: CharacterSections = { ...card.sections };
  let aliases = [...card.aliases];
  let tags = [...card.tags];
  /**
   * 真正分析成功 / 失败的章节。
   *
   * `updatedThrough` 是一条**水位线**（下次增量从它之后开始），所以不能
   * 简单地推到「最后一批成功的章节」——中间某批失败时，那几章会被水位线
   * 越过去，此后永远不会被重读，而界面上看不出任何异常。因此水位线只能
   * 推进到**第一个失败章节之前**，失败之后的成果照样写进卡里（那是白赚的），
   * 但下次更新会从失败处重来。
   */
  const analyzed: number[] = [];
  const failed: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (ctx.signal.aborted) {
      log.warn(`更新被取消，已完成 ${i}/${batches.length} 批`);
      return { status: 'cancelled' };
    }
    const batch = batches[i];
    const range = describeChapters(batch.chapters.map((c) => c.order));
    ctx.report(`分析 ${range}`, i, steps);

    const each = Date.now();
    const parsed = await analyzeBatch(ctx.provider, card, sections, batch, {
      index: i,
      total: batches.length,
      config: ctx.config,
      signal: ctx.signal,
    });
    if (!parsed) {
      // 单批解析失败不放弃整次更新：已归纳出的内容仍然值得写回。
      failed.push(...batch.chapters.map((c) => c.order));
      log.warn(
        `第 ${i + 1}/${batches.length} 批解析失败，跳过`,
        `范围 ${range}｜这几章不计入「已读到」，下次更新会重试`
      );
      continue;
    }
    sections = parsed.sections;
    aliases = unique([...aliases, ...parsed.aliases]);
    tags = unique([...tags, ...parsed.tags]);
    analyzed.push(...batch.chapters.map((c) => c.order));
    log.info(
      `第 ${i + 1}/${batches.length} 批完成（${range}）`,
      `${batch.chapters.length} 章，用时 ${elapsed(each)}`
    );
  }

  if (ctx.signal.aborted) {
    log.warn('更新被取消（写入前）');
    return { status: 'cancelled' };
  }

  // 一批都没成功：没有任何新内容，不要拿一份原样的卡去烦作者确认，
  // 更不能推进 updatedThrough（那等于宣称读过了这些章）。
  if (analyzed.length === 0) {
    log.error(
      `「${card.name}」的 ${batches.length} 批全部解析失败，角色卡未改动`,
      '模型没有按要求返回 JSON。可在日志上方看到每批的失败记录；换个模型或稍后重试。'
    );
    getHost().toast(`模型返回无法解析，「${card.name}」未改动。`, 'error');
    return { status: 'failed' };
  }

  ctx.report('写入角色卡', batches.length, steps);
  const appearances = unique2(
    opts.scope === 'incremental' ? [...card.appearsIn, ...opts.allAppearances] : opts.allAppearances
  );
  // 水位线只推进到第一个失败章节之前——越过去的话那几章再也不会被重读。
  const firstFailure = failed.length > 0 ? Math.min(...failed) : Number.POSITIVE_INFINITY;
  const covered = analyzed.filter((o) => o < firstFailure);
  const updatedThrough = Math.max(card.updatedThrough ?? 0, ...covered, 0);
  if (failed.length > 0) {
    log.warn(
      `${failed.length} 章解析失败，「已读到」只推进到第 ${updatedThrough} 章`,
      `失败章节：${describeChapters(unique2(failed))}｜下次更新会从这里重来`
    );
  }
  const merged = {
    slug: card.slug,
    name: card.name,
    aliases,
    tags,
    firstAppear: appearances[0] ?? card.firstAppear,
    lastSeen: appearances[appearances.length - 1] ?? card.lastSeen,
    appearsIn: appearances,
    updatedThrough,
    sections,
  };

  const abs = project.pathOf(card.relPath);
  const proposedText = renderCharacterCard(merged);
  if (opts.skipReview) {
    await writeText(abs, proposedText);
    log.info(`已写入角色卡「${card.name}」`, `${card.relPath}｜总耗时 ${elapsed(startedAt)}`);
  } else {
    const applied = await review(project, card, proposedText);
    if (!applied) {
      ctx.report('已放弃', steps, steps);
      return { status: 'discarded' };
    }
    log.info(
      `已更新角色卡「${card.name}」`,
      `${card.relPath}｜覆盖至第 ${merged.updatedThrough} 章｜总耗时 ${elapsed(startedAt)}`
    );
  }
  ctx.report('完成', steps, steps);
  return { status: 'updated', updatedThrough: merged.updatedThrough };
}

/**
 * 把出场章节按输入预算切成若干批。
 *
 * 一章都放不下时仍然单独成批（正文会被 takeHead 截断并打 warn）——
 * 宁可读半章，也不能把这一章整个跳过而不吭声。
 */
async function planBatches(
  project: NovelProject,
  chapters: Chapter[],
  config: { contextWindow: number; maxOutputTokens: number }
): Promise<Batch[]> {
  // 留出角色卡本体、提示词与输出的余量。
  const budget = Math.max(2000, config.contextWindow - config.maxOutputTokens - 3000);
  const batches: Batch[] = [];
  let current: { chapters: Chapter[]; parts: string[]; tokens: number } = {
    chapters: [],
    parts: [],
    tokens: 0,
  };

  const flush = () => {
    if (current.chapters.length > 0) {
      batches.push({ chapters: current.chapters, corpus: current.parts.join('\n\n') });
    }
    current = { chapters: [], parts: [], tokens: 0 };
  };

  for (const chapter of chapters) {
    const text = await project.readChapterText(chapter);
    if (!text.trim()) {
      continue;
    }
    const block = `【第${chapter.order}章 ${chapter.title}】\n${text}`;
    const tokens = estimateTokens(block);

    if (tokens > budget) {
      // 单章就超预算：自己单独一批，截断并说明。
      flush();
      const clipped = takeHead(block, budget);
      log.warn(
        `第 ${chapter.order} 章正文超出单批预算，已截断`,
        `${block.length} 字 → ${clipped.length} 字（预算 ${budget} token）`
      );
      batches.push({ chapters: [chapter], corpus: clipped });
      continue;
    }
    if (current.tokens + tokens > budget) {
      flush();
    }
    current.chapters.push(chapter);
    current.parts.push(block);
    current.tokens += tokens;
  }
  flush();
  return batches;
}

interface ParsedCard {
  sections: CharacterSections;
  aliases: string[];
  tags: string[];
}

/**
 * 分析一批章节，产出精炼后的角色卡内容。
 *
 * 关键点：把**当前已归纳出的卡**一并发过去，要求模型「在此基础上修订」而不是
 * 从零重写。这既让多批之间接得上，也是控制篇幅的抓手——提示词里反复强调
 * 保持精炼、不要堆砌。
 */
async function analyzeBatch(
  provider: LlmProvider,
  card: CharacterCard,
  current: CharacterSections,
  batch: Batch,
  ctx: {
    index: number;
    total: number;
    config: { maxOutputTokens: number; requestTimeoutMs: number };
    signal: AbortSignal;
  }
): Promise<ParsedCard | undefined> {
  const options: ChatOptions = {
    maxOutputTokens: Math.min(ctx.config.maxOutputTokens, 2000),
    temperature: 0.3,
    timeoutMs: ctx.config.requestTimeoutMs,
    signal: ctx.signal,
  };

  const currentCard = CHARACTER_SECTION_KEYS.map((k) => `${k}：${current[k]?.trim() || '（空）'}`).join('\n');
  const range = describeChapters(batch.chapters.map((c) => c.order));
  const progress =
    ctx.total > 1 ? `这是第 ${ctx.index + 1}/${ctx.total} 批（${range}）。\n` : `本次分析 ${range}。\n`;

  const raw = await collectStream(
    provider.chatStream(
      [
        { role: 'system', content: UPDATE_SYSTEM },
        {
          role: 'user',
          content:
            `${progress}要归纳的角色：${card.name}` +
            `${card.aliases.length > 0 ? `（又称 ${card.aliases.join('、')}）` : ''}\n\n` +
            `【当前的角色档案】\n${currentCard}\n\n` +
            `【正文】\n${batch.corpus}\n\n` +
            '请在当前档案的基础上修订，输出完整的 JSON。',
        },
      ],
      options
    )
  );

  return parseCardResponse(raw);
}

/** 让作者对比现有卡与新版本，确认后才写入。返回是否写入。 */
async function review(project: NovelProject, card: CharacterCard, proposedText: string): Promise<boolean> {
  const abs = project.pathOf(card.relPath);
  const currentText = await readText(abs);
  const host = getHost();

  let verdict: 'apply' | 'discard' | undefined;
  if (host.reviewReplace) {
    verdict = await host.reviewReplace(card.name, currentText, proposedText);
  } else {
    const pick = await host.confirm(`已生成「${card.name}」的新版角色卡。采纳？`, ['采纳', '跳过'], {
      modal: true,
    });
    verdict = pick === '采纳' ? 'apply' : pick === '跳过' ? 'discard' : undefined;
  }

  if (verdict !== 'apply') {
    log.info(`跳过角色卡「${card.name}」`, verdict === 'discard' ? '用户放弃' : '用户取消');
    return false;
  }
  await writeText(abs, proposedText);
  return true;
}

/**
 * 增量/全量二选一。带上章数，作者才判断得出该选哪个。
 *
 * **只在两个选项确有区别时才问**：从没更新过、或没有新出场章节时，增量与全量
 * 是同一件事，弹一个只有「开始」的框纯属多此一举——`runUpdate` 紧接着还会问
 * 一次（那一次带批数与预计调用次数，信息更全）。连着弹两个框会让人以为点错了。
 */
async function askScope(
  card: CharacterCard,
  all: number[],
  fresh: number[]
): Promise<UpdateScope | undefined> {
  const updatedThrough = card.updatedThrough ?? 0;
  if (updatedThrough === 0 || fresh.length === 0) {
    return 'full';
  }
  const pick = await getHost().confirm(
    `更新「${card.name}」的角色卡。上次更新覆盖到第 ${updatedThrough} 章。`,
    [`只读新增的 ${fresh.length} 章`, `重读全部 ${all.length} 章`],
    {
      modal: true,
      detail:
        `新增出场：${describeChapters(fresh)}\n` +
        `全部出场：${describeChapters(all)}\n\n` +
        '只读新增更省 token；全部重读更完整，适合角色卡被改乱或想彻底重来时。',
    }
  );
  if (!pick) {
    return undefined;
  }
  return pick.startsWith('只读') ? 'incremental' : 'full';
}

// ---------------------------------------------------------------- 解析

/**
 * 解析模型返回的角色卡 JSON。
 * 解析失败返回 undefined 由调用方跳过这一批——角色卡写错比没写更麻烦。
 */
export function parseCardResponse(raw: string): ParsedCard | undefined {
  const text = stripCodeFence(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;

  const sections = emptyCharacterSections();
  let any = false;
  for (const key of CHARACTER_SECTION_KEYS) {
    const value = obj[key];
    if (typeof value === 'string') {
      sections[key] = value.trim();
    } else if (Array.isArray(value)) {
      sections[key] = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => (/^[-*·]/.test(v.trim()) ? v.trim() : `- ${v.trim()}`))
        .join('\n');
    }
    if (sections[key]) {
      any = true;
    }
  }
  if (!any) {
    return undefined;
  }
  return { sections, aliases: toStringArray(obj.aliases), tags: toStringArray(obj.tags) };
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return unique(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean));
  }
  if (typeof v === 'string' && v.trim()) {
    return unique(v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean));
  }
  return [];
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function unique2(arr: number[]): number[] {
  return [...new Set(arr)].sort((a, b) => a - b);
}

async function uniqueSlug(dirAbs: string, base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await exists(path.join(dirAbs, `${slug}.md`))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

// ---------------------------------------------------------------- 提示词

/**
 * 更新角色卡的系统提示。
 *
 * 与 characters.ts 的批量提取提示词的区别，全在「控制篇幅」上：那条流程
 * 一次处理一批**新**角色，写多写少无所谓；这条会被同一个角色反复调用
 * （主角可能跑十几批），每批都往上堆的话，几轮下来角色卡会膨胀成一篇论文，
 * 而它每次续写都要注入上下文。所以这里给了硬性字数上限，并明确
 * 「性格 / 语言习惯」优先、「外貌 / 人物关系」从简。
 */
const UPDATE_SYSTEM = `你是小说编辑，负责维护一部长篇小说的人物档案。

作者会给你一位角色的**当前档案**和一批**正文**，你的任务是在当前档案的基础上修订，
产出这个角色更准确的档案。

请只输出一个 JSON 对象，除 JSON 外不要输出任何文字、解释或前后缀：

{
  "aliases": ["正文中对他的其它称呼"],
  "tags": ["主角" 或 "配角" 或 "反派" 等，最多 3 个],
  "身份": "他是谁、在故事中的位置。80 字以内。",
  "外貌": "只写反复出现、有辨识度的特征。50 字以内，没写清楚就留空。",
  "性格": "性格内核、行事逻辑、在压力下的反应。这一节最重要，可以写到 200 字，要具体到能据此判断他在新情境下会怎么做。",
  "语言习惯": "说话的节奏、口癖、常用词、回避什么话题。必须从正文对白中总结，能引用一两个短句最好。150 字以内。",
  "人物关系": "与其他角色的关系，一行一条，每条不超过 25 字。只列真正影响剧情的关系。",
  "当前状态": "读到本批正文结尾时，此人身在何处、处于什么处境、下一步想做什么。100 字以内。",
  "未收伏笔": "与此人相关、正文中提到但尚未解决的线索，一行一条。已经在正文里解决的要删掉。"
}

修订原则（**这几条比补充新内容更重要**）：
- **档案要精炼，不是越长越好**。它会在每次续写时注入模型，臃肿的档案会挤掉正文。
  每一节都不要超过上面给的字数；写满了就删掉最不重要的那句，而不是往后加。
- **优先保证「性格」和「语言习惯」**。这两节决定模型能不能把这个人写像；
  外貌、人物关系写个梗概即可。
- 与当前档案**不冲突**的内容保持原样，不要为改写而改写。
- 正文推翻了当前档案时以正文为准（人物会成长、关系会变），并在「当前状态」里体现变化。
- 「当前状态」永远只写最新情况，不要写成编年史。
- 「未收伏笔」要做减法：本批正文里已经揭晓的，从列表里删掉。
- 不要虚构正文里没有的信息。某一节确实无从判断就留空字符串 ""，不要写「未知」「待补充」。
- 所有内容用简体中文。`;
