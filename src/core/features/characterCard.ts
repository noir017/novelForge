import { appearancesOf, buildCastIndex, CastMember, describePlots } from '../views/cast';
import { readConfig } from '../config';
import { runPool, serialize } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { budgetForTask, createModelPool, ModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { readText, slugify, uniqueSlug, writeText } from '../model/fs';
import {
  NovelProject,
  emptyCharacterSections,
  renderCharacterCard,
} from '../model/project';
import { CHARACTER_SECTION_KEYS, Chapter, CharacterCard, CharacterSections } from '../model/types';
import { describeTaskModels } from '../model/tiers';
import { explainDroppedAliases, sanitizeAliases } from '../model/naming';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { parseCardResponse, ParsedCard } from './characterCardParse';
import { UPDATE_SYSTEM } from './characterCardPrompt';
import { unique, uniqueNumbers } from './parse';

export { parseCardResponse } from './characterCardParse';

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
  /** 这一批读了哪几章。 */
  plots: Chapter[];
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
  const nos = picked === 'incremental' && fresh.length > 0 ? fresh : all;

  const plots = (await project.listChapters()).filter((c) => nos.includes(c.order));
  if (plots.length === 0) {
    log.warn(`「${card.name}」的出场章都已不在磁盘上`, `摘要记录：${describePlots(nos)}`);
    getHost().toast('这些出场章的正文已不存在。', 'error');
    return;
  }

  await runUpdate(project, card, plots, {
    scope: picked,
    // 全量重来时 lastSeen/appearsIn 以完整清单为准；增量只补新的。
    allAppearances: all,
  });
}

/** 批量计划里的一张卡。 */
export interface CardUpdatePlan {
  card: CharacterCard;
  /** 本次要读的出场章号。 */
  nos: number[];
  /** 预先算好的分批（总确认报调用次数用，执行时不重算）。 */
  batches: Batch[];
  /** 真正参与分析的章数（没有正文的章已剔除）。 */
  plots: number;
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
  // 分批用**角色卡那一档**的窗口：批数就是确认框里那句「预计调用 N 次」，
  // 拿对话页模型的窗口来算，跑起来会超窗且数字对不上账。
  const budget = budgetForTask('characterCard');
  const allPlots = await project.listChapters();
  const result: BatchUpdatePlan = { plans: [], skipped: [] };

  for (const card of cards) {
    const all = appearancesOf(index, card);
    if (all.length === 0) {
      result.skipped.push({ card, reason: '未在摘要中出现' });
      continue;
    }
    const nos = scope === 'incremental' ? all.filter((n) => n > (card.updatedThrough ?? 0)) : all;
    if (nos.length === 0) {
      result.skipped.push({ card, reason: '没有新的出场章节' });
      continue;
    }
    const plots = allPlots.filter((c) => nos.includes(c.order));
    if (plots.length === 0) {
      result.skipped.push({ card, reason: '出场章节已不在磁盘上' });
      continue;
    }
    const batches = await planBatches(project, plots, budget);
    if (batches.length === 0) {
      result.skipped.push({ card, reason: '章节正文都为空' });
      continue;
    }
    result.plans.push({
      card,
      nos,
      batches,
      plots: batches.reduce((sum, b) => sum + b.plots.length, 0),
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
 *
 * 各卡之间没有先后依赖，按配置并发；**卡内的批仍然严格串行**（后一批要
 * 看到前一批的产出）。逐张确认时 diff 走 `serialize` 排队，一次只弹一张。
 */
export async function updateAllCharacterCards(project: NovelProject, scope: UpdateScope): Promise<void> {
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
  const totalPlots = plans.reduce((sum, p) => sum + p.plots, 0);
  const lanes = Math.min(config.concurrency, plans.length);
  const label = scope === 'incremental' ? '更新' : '从头重建';
  const pick = await getHost().confirm(
    `${label} ${plans.length} 张角色卡：共需通读 ${totalPlots} 章，` +
      `分 ${totalBatches} 批，预计调用模型 ${totalBatches} 次。现在开始？`,
    ['逐张确认后开始', '全部直接采纳并开始'],
    {
      modal: true,
      detail: [
        describeTaskModels(config, 'characterCard'),
        lanes > 1
          ? `并发 ${lanes} 张同时处理（同一张卡内的批次仍按顺序来）。逐张确认时，diff 会按完成顺序一张一张弹出。`
          : '逐张串行处理（并发数为 1）。',
        skipped.length > 0
          ? `跳过 ${skipped.length} 张：${skipped.map((s) => `「${s.card.name}」（${s.reason}）`).join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (!pick) {
    log.info('用户取消了批量更新');
    return;
  }
  const autoApply = pick === '全部直接采纳并开始';

  const pool = await createModelPool({ task: 'characterCard', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量更新中止');
    return;
  }

  log.info(
    `开始批量${label}角色卡`,
    `${plans.length} 张｜${totalPlots} 章分 ${totalBatches} 批｜模型 ${pool.label}｜` +
      (lanes > 1 ? `并发 ${lanes} 路｜` : '') +
      (autoApply ? '全部直接采纳' : '逐张确认')
  );

  await runTask(
    `批量${label}角色卡`,
    async ({ signal, report }) => {
      // 每张卡的步数（批数 + 写入那一步），累加成总进度条的分母。
      const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
      let done = 0;
      let finished = 0;
      let updated = 0;
      let failed = 0;
      let discarded = 0;
      const running = new Set<string>();

      // 并发下按卡内步数细分只会互相打架，所以完成粒度取到「卡」：
      // 一张卡结束时把它的全部步数一次性计入，进行中的另行报。
      const describeState = (): string =>
        lanes > 1
          ? `已完成 ${finished}/${plans.length} 张` +
            (running.size > 0 ? ` · ${running.size} 张进行中（${[...running].join('、')}）` : '')
          : '';

      await runPool(
        plans,
        lanes,
        async (plan, i) => {
          const outcome = await runCardUpdate(
            project,
            plan.card,
            { scope, allAppearances: plan.nos, batches: plan.batches, skipReview: autoApply },
            {
              signal,
              report: (message, current) =>
                report({
                  message:
                    lanes > 1
                      ? `${describeState()} · 「${plan.card.name}」${message}`
                      : `第 ${i + 1}/${plans.length} 张「${plan.card.name}」· ${message}`,
                  current: done + (lanes > 1 ? 0 : current ?? 0),
                  total: totalSteps,
                }),
              pool,
              config,
            }
          );
          return outcome;
        },
        {
          signal,
          onStart: (plan) => {
            running.add(`「${plan.card.name}」`);
          },
          onSettled: (result, plan, _index, count) => {
            running.delete(`「${plan.card.name}」`);
            finished = count;
            done += plan.batches.length + 1;
            if (result.status === 'rejected') {
              failed++;
              const reason = describeError(result.reason);
              log.error(`「${plan.card.name}」更新失败：${reason}`, result.reason);
              // 抛出来的异常（网络/超时/取消以外的错）此前只进了「失败 N 张」
              // 这个汇总数字，看不出是哪一张。挂到卡上才找得回来。
              void recordFailure(project, {
                scope: '角色卡',
                targetKind: 'character',
                targetKey: plan.card.relPath,
                severity: 'error',
                op: 'updateCard',
                message: `更新失败：${reason}`,
                detail: `批量${label}时抛出异常，这张卡未改动｜共 ${plan.batches.length} 批`,
              });
            } else if (result.value.status === 'updated') {
              updated++;
            } else if (result.value.status === 'failed') {
              failed++;
            } else if (result.value.status === 'discarded') {
              discarded++;
            }
            report({ message: describeState() || `「${plan.card.name}」完成`, current: done, total: totalSteps });
          },
        }
      );

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

  const plots = (await project.listChapters()).filter((c) => member.plots.includes(c.order));
  if (plots.length === 0) {
    getHost().toast('这些出场章节的正文已不存在。', 'error');
    return;
  }

  const card = await seedEmptyCard(project, member);
  if (!card) {
    return;
  }
  await runUpdate(project, card, plots, {
    scope: 'full',
    allAppearances: member.plots,
    // 刚建出来的空卡没有可覆盖的人工内容，不必走 diff 审阅。
    skipReview: true,
  });
}

/**
 * 给「出场人物 · 未建卡」里的**所有**人建卡——该分组的右键动作。
 *
 * 各人之间没有先后依赖，按配置并发。新卡都是空卡，一律 `skipReview`，
 * 没有 diff 排队的问题。
 *
 * 「不偷偷烧 token」：确认框里报清人数、章数与预计调用次数——摘要里
 * 冒出十几个路人是常事，一次点下去可能是几十次模型调用。
 */
export async function createCardsForAllCast(project: NovelProject): Promise<void> {
  const index = await buildCastIndex(project);
  if (index.unknown.length === 0) {
    log.info('没有未建卡的出场人物');
    getHost().toast('摘要里出现的人都已经有角色卡了。');
    return;
  }

  const config = readConfig();
  const cardBudget = budgetForTask('characterCard');
  const allPlots = await project.listChapters();
  const plans: { member: CastMember; plots: Chapter[]; batches: Batch[] }[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const member of index.unknown) {
    const plots = allPlots.filter((c) => member.plots.includes(c.order));
    if (plots.length === 0) {
      skipped.push({ name: member.name, reason: '出场章节已不在磁盘上' });
      continue;
    }
    const batches = await planBatches(project, plots, cardBudget);
    if (batches.length === 0) {
      skipped.push({ name: member.name, reason: '章节正文都为空' });
      continue;
    }
    plans.push({ member, plots, batches });
  }

  if (plans.length === 0) {
    log.info('没有可建卡的出场人物', skipped.map((s) => `${s.name}（${s.reason}）`).join('、'));
    getHost().toast('这些人物的出场章节都读不到内容，无法建卡。');
    return;
  }

  const totalBatches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  const totalPlots = plans.reduce((sum, p) => sum + p.batches.reduce((n, b) => n + b.plots.length, 0), 0);
  const lanes = Math.min(config.concurrency, plans.length);
  const confirm = await getHost().confirm(
    `给 ${plans.length} 位未建卡的人物建卡：共需通读 ${totalPlots} 章，` +
      `分 ${totalBatches} 批，预计调用模型 ${totalBatches} 次。现在开始？`,
    ['开始建卡'],
    {
      modal: true,
      detail: [
        `人物：${plans.map((p) => p.member.name).join('、')}`,
        describeTaskModels(config, 'characterCard'),
        lanes > 1 ? `并发 ${lanes} 位同时处理。` : '逐位串行处理（并发数为 1）。',
        skipped.length > 0
          ? `跳过 ${skipped.length} 位：${skipped.map((s) => `「${s.name}」（${s.reason}）`).join('、')}`
          : '',
        '新卡都是空卡，模型产出直接写入，不走 diff 审阅。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (confirm !== '开始建卡') {
    log.info('用户取消了批量建卡');
    return;
  }

  const pool = await createModelPool({ task: 'characterCard', concurrent: lanes > 1 });
  if (!pool) {
    log.error('没有可用的模型，批量建卡中止');
    return;
  }
  log.info(
    `开始批量建卡`,
    `${plans.length} 位｜${totalPlots} 章分 ${totalBatches} 批｜模型 ${pool.label}｜` +
      (lanes > 1 ? `并发 ${lanes} 路` : '串行')
  );

  await runTask(
    '批量建角色卡',
    async ({ signal, report }) => {
      const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
      let done = 0;
      let finished = 0;
      let created = 0;
      let failed = 0;
      const running = new Set<string>();
      /**
       * 每位人物那张刚落下的空卡的路径，按 plan 下标记。
       *
       * 抛异常时 `onSettled` 只拿得到 `plan`（那里只有名字），而失败记录要
       * 挂在**文件**上。空卡是在 worker 里现建的，只能这样把路径带出来。
       */
      const seeded: (string | undefined)[] = [];

      const describeState = (): string =>
        `已完成 ${finished}/${plans.length} 位` +
        (running.size > 0 ? ` · ${running.size} 位进行中（${[...running].join('、')}）` : '');

      await runPool(
        plans,
        lanes,
        async (plan, i) => {
          // 先落一张空卡：即便模型调用失败/被取消，作者也拿到了一个可手写的档案。
          const card = await seedEmptyCard(project, plan.member);
          if (!card) {
            throw new Error(`建卡失败：${plan.member.name}`);
          }
          seeded[i] = card.relPath;
          return runCardUpdate(
            project,
            card,
            {
              scope: 'full',
              allAppearances: plan.member.plots,
              batches: plan.batches,
              skipReview: true,
            },
            {
              signal,
              report: (message) =>
                report({ message: `${describeState()} · 「${plan.member.name}」${message}`, current: done, total: totalSteps }),
              pool,
              config,
            }
          );
        },
        {
          signal,
          onStart: (plan) => {
            running.add(`「${plan.member.name}」`);
          },
          onSettled: (result, plan, index, count) => {
            running.delete(`「${plan.member.name}」`);
            finished = count;
            done += plan.batches.length + 1;
            if (result.status === 'rejected') {
              failed++;
              const reason = describeError(result.reason);
              log.error(`「${plan.member.name}」建卡失败：${reason}`, result.reason);
              // 空卡已经落盘了（那是有意的），但它是空的——不挂个标记的话
              // 作者会看到一张干净的新卡，以为模型就只写出这么点东西。
              const relPath = seeded[index];
              if (relPath) {
                void recordFailure(project, {
                  scope: '角色卡',
                  targetKind: 'character',
                  targetKey: relPath,
                  severity: 'error',
                  op: 'updateCard',
                  message: `建卡失败：${reason}`,
                  detail: '空卡已留下，可手写或重新运行「更新角色卡」重试。',
                });
              }
            } else if (result.value.status === 'updated') {
              created++;
            } else if (result.value.status === 'failed') {
              failed++;
            }
            report({ message: describeState(), current: done, total: totalSteps });
          },
        }
      );

      report({ message: '完成', current: totalSteps, total: totalSteps });
      const summary =
        `已建 ${created} 张` +
        (failed > 0 ? `，失败 ${failed} 张（空卡已留下，可手写或重试）` : '') +
        (skipped.length > 0 ? `，跳过 ${skipped.length} 位` : '');
      log.info('批量建卡结束', summary);
      getHost().toast(`建卡完成：${summary}。`);
    },
    { scope: '角色卡' }
  );
}

/**
 * 先落一张空卡再让模型来填。
 *
 * 顺序不能反过来：模型调用失败或被取消时，作者至少拿到了一个可手写的档案，
 * 而不是白点一次。slug 冲突时自动加后缀。
 */
async function seedEmptyCard(project: NovelProject, member: CastMember): Promise<CharacterCard | undefined> {
  const slug = await uniqueSlug(project.charactersDir, slugify(member.name));
  const relPath = await new Workspace(project).writeCharacter({
    slug,
    name: member.name,
    aliases: sanitizeAliases(member.aliases, member.name),
    tags: [],
    firstAppear: member.plots[0],
    lastSeen: member.plots[member.plots.length - 1],
    appearsIn: member.plots,
    sections: emptyCharacterSections(),
  });
  log.info(`新建角色卡「${member.name}」`, `${relPath}｜出场 ${describePlots(member.plots)}`);
  return (await project.listCharacters()).find((c) => c.relPath === relPath);
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
  plots: Chapter[],
  opts: { scope: UpdateScope; allAppearances: number[]; skipReview?: boolean }
): Promise<void> {
  const config = readConfig();
  const batches = await planBatches(project, plots, budgetForTask('characterCard'));
  if (batches.length === 0) {
    log.warn(`「${card.name}」的出场章节都是空的`);
    getHost().toast('这些章节都是空的，没有可分析的内容。', 'error');
    return;
  }

  // 空章节在 planBatches 里被剔掉了，报数以真正要读的为准——
  // 说「通读 12 章」却只读了 9 章，作者对不上账。
  const willRead = batches.reduce((sum, b) => sum + b.plots.length, 0);
  const skipped = plots.length - willRead;
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
          describeTaskModels(config, 'characterCard'),
        ]
          .filter(Boolean)
          .join('\n\n') || undefined,
    }
  );
  if (confirm !== '开始') {
    log.info('用户取消了更新');
    return;
  }

  // 单卡内的批必须串行（后一批看前一批的产出），所以池按串行取模型：
  // 恒用首选，失败才随机换。
  const pool = await createModelPool({ task: 'characterCard', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，更新中止');
    return;
  }

  log.info(
    `开始${scopeLabel}「${card.name}」`,
    `${willRead} 章分 ${batches.length} 批｜章节 ${describePlots(
      batches.flatMap((b) => b.plots.map((p) => p.order))
    )}｜模型 ${pool.label}`
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
          pool,
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
    pool: ModelPool;
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
    const range = describePlots(batch.plots.map((p) => p.order));
    ctx.report(`分析 ${range}`, i, steps);

    const each = Date.now();
    const parsed = await analyzeBatch(ctx.pool, card, sections, batch, {
      index: i,
      total: batches.length,
      config: ctx.config,
      signal: ctx.signal,
    });
    if (!parsed) {
      // 单批解析失败不放弃整次更新：已归纳出的内容仍然值得写回。
      failed.push(...batch.plots.map((p) => p.order));
      log.warn(
        `第 ${i + 1}/${batches.length} 批解析失败，跳过`,
        `范围 ${range}｜这几章不计入「已读到」，下次更新会重试`
      );
      continue;
    }
    sections = parsed.sections;
    aliases = unique([...aliases, ...parsed.aliases]);
    tags = unique([...tags, ...parsed.tags]);
    analyzed.push(...batch.plots.map((p) => p.order));
    log.info(
      `第 ${i + 1}/${batches.length} 批完成（${range}）`,
      `${batch.plots.length} 章，用时 ${elapsed(each)}`
    );
  }

  if (ctx.signal.aborted) {
    log.warn('更新被取消（写入前）');
    return { status: 'cancelled' };
  }

  // 一批都没成功：没有任何新内容，不要拿一份原样的卡去烦作者确认，
  // 更不能推进 updatedThrough（那等于宣称读过了这些章）。
  if (analyzed.length === 0) {
    const detail =
      `范围 ${describePlots(batches.flatMap((b) => b.plots.map((p) => p.order)))}｜` +
      '模型没有按要求返回 JSON。可在日志页看到每批的失败记录；换个模型或稍后重试。';
    log.error(`「${card.name}」的 ${batches.length} 批全部解析失败，角色卡未改动`, detail);
    getHost().toast(`模型返回无法解析，「${card.name}」未改动。`, 'error');
    // 日志与 toast 都是「要求用户恰好在看」的出口。这一条必须留在卡上：
    // 界面上那张卡此刻与更新成功的一模一样，作者会以为已经更新过了。
    await recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: card.relPath,
      severity: 'error',
      op: 'updateCard',
      message: `${batches.length} 批全部解析失败，角色卡未改动`,
      detail,
    });
    return { status: 'failed' };
  }

  ctx.report('写入角色卡', batches.length, steps);
  // 别名在这里收一次口：并集是只进不出的，模型吐出的 `她`/`姐姐`/`少女` 一旦
  // 混进来就再也出不去，而别名是「谁是谁」的判据（cast.ts / model/identity.ts 都吃它），
  // 泛称会把几个角色串成一个。顺带把存量脏别名一并清掉——差异走 diff 审阅，看得见。
  const droppedAliases = explainDroppedAliases(aliases, card.name);
  aliases = sanitizeAliases(aliases, card.name);
  if (droppedAliases.length > 0) {
    log.info(
      `「${card.name}」丢弃 ${droppedAliases.length} 个非专属称呼`,
      droppedAliases.map((d) => `${d.alias}（${d.reason}）`).join('、')
    );
  }
  const appearances = uniqueNumbers(
    opts.scope === 'incremental' ? [...card.appearsIn, ...opts.allAppearances] : opts.allAppearances
  );
  // 水位线只推进到第一个失败章节之前——越过去的话那几章再也不会被重读。
  const firstFailure = failed.length > 0 ? Math.min(...failed) : Number.POSITIVE_INFINITY;
  const covered = analyzed.filter((o) => o < firstFailure);
  const updatedThrough = Math.max(card.updatedThrough ?? 0, ...covered, 0);
  if (failed.length > 0) {
    const detail = `失败章节：${describePlots(uniqueNumbers(failed))}｜下次更新会从这里重来`;
    log.warn(`${failed.length} 章解析失败，「已读到」只推进到第 ${updatedThrough} 章`, detail);
    // 这一条以前只有日志：卡确实更新了一部分，界面上完全看不出还缺一块。
    await recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: card.relPath,
      severity: 'warn',
      op: 'updateCard',
      message: `${failed.length} 章解析失败，「已读到」只推进到第 ${updatedThrough} 章`,
      detail,
    });
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
  // 全批都成功才算这张卡「好了」，把它挂着的旧感叹号收掉。
  // 有失败批次时不能清——上面刚记了一条 warn，清掉等于自己把它抹了。
  if (failed.length === 0) {
    await clearFailures(project, 'character', card.relPath, 'updateCard');
  }
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
  plots: Chapter[],
  /** 干活那个模型的窗口（`budgetForTask('characterCard')` / `pool.primaryBudget`）。 */
  window: { contextWindow: number; maxOutputTokens: number }
): Promise<Batch[]> {
  // 留出角色卡本体、提示词与输出的余量。
  const budget = Math.max(2000, window.contextWindow - window.maxOutputTokens - 3000);
  const batches: Batch[] = [];
  let current: { plots: Chapter[]; parts: string[]; tokens: number } = {
    plots: [],
    parts: [],
    tokens: 0,
  };

  const flush = () => {
    if (current.plots.length > 0) {
      batches.push({ plots: current.plots, corpus: current.parts.join('\n\n') });
    }
    current = { plots: [], parts: [], tokens: 0 };
  };

  for (const plot of plots) {
    const text = await project.readChapterText(plot);
    if (!text.trim()) {
      continue;
    }
    const block = `【第${plot.order}章 ${plot.title}】\n${text}`;
    const tokens = estimateTokens(block);

    if (tokens > budget) {
      // 单章就超预算：自己单独一批，截断并说明。
      flush();
      const clipped = takeHead(block, budget);
      log.warn(
        `第 ${plot.order} 章正文超出单批预算，已截断`,
        `${block.length} 字 → ${clipped.length} 字（预算 ${budget} token）`
      );
      batches.push({ plots: [plot], corpus: clipped });
      continue;
    }
    if (current.tokens + tokens > budget) {
      flush();
    }
    current.plots.push(plot);
    current.parts.push(block);
    current.tokens += tokens;
  }
  flush();
  return batches;
}

/**
 * 分析一批章节，产出精炼后的角色卡内容。
 *
 * 关键点：把**当前已归纳出的卡**一并发过去，要求模型「在此基础上修订」而不是
 * 从零重写。这既让多批之间接得上，也是控制篇幅的抓手——提示词里反复强调
 * 保持精炼、不要堆砌。
 */
async function analyzeBatch(
  pool: ModelPool,
  card: CharacterCard,
  current: CharacterSections,
  batch: Batch,
  ctx: {
    index: number;
    total: number;
    config: { requestTimeoutMs: number };
    signal: AbortSignal;
  }
): Promise<ParsedCard | undefined> {
  const options: StreamOptions = {
    // 输出上限跟着实际干活的模型走（pool 就在手边），不是对话页那个。
    maxOutputTokens: Math.min(pool.primaryBudget.maxOutputTokens, 2000),
    temperature: 0.3,
    timeoutMs: ctx.config.requestTimeoutMs,
    signal: ctx.signal,
  };

  const currentCard = CHARACTER_SECTION_KEYS.map((k) => `${k}：${current[k]?.trim() || '（空）'}`).join('\n');
  const range = describePlots(batch.plots.map((p) => p.order));
  const progress =
    ctx.total > 1 ? `这是第 ${ctx.index + 1}/${ctx.total} 批（${range}）。\n` : `本次分析 ${range}。\n`;

  const raw = await pool.run(`角色卡「${card.name}」${range}`, (llm) =>
    collectText(
      llm.stream(
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
    )
  );

  return parseCardResponse(raw);
}

/**
 * 让作者对比现有卡与新版本，确认后才写入。返回是否写入。
 *
 * 走 `serialize` 排队：批量更新时几张卡是并发分析的，但**同时弹三个 diff
 * 编辑器，用户根本不知道自己在看谁**。分析照跑，审阅在这里一张一张来，
 * 顺序即完成顺序。
 */
async function review(project: NovelProject, card: CharacterCard, proposedText: string): Promise<boolean> {
  const abs = project.pathOf(card.relPath);
  const host = getHost();

  const verdict = await serialize(async () => {
    // 现有内容在排到队之前可能已被别处改过，进队后再读一次才是当下的真相。
    const currentText = await readText(abs);
    if (host.reviewReplace) {
      return host.reviewReplace(card.name, currentText, proposedText);
    }
    const pick = await host.confirm(`已生成「${card.name}」的新版角色卡。采纳？`, ['采纳', '跳过'], {
      modal: true,
    });
    return pick === '采纳' ? 'apply' : pick === '跳过' ? 'discard' : undefined;
  });

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
        `新增出场：${describePlots(fresh)}\n` +
        `全部出场：${describePlots(all)}\n\n` +
        '只读新增更省 token；全部重读更完整，适合角色卡被改乱或想彻底重来时。',
    }
  );
  if (!pick) {
    return undefined;
  }
  return pick.startsWith('只读') ? 'incremental' : 'full';
}
