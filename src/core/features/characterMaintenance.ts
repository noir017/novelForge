import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildCastIndex, readCastChapters } from '../cast';
import { buildIdentityGroups } from '../model/identity';
import { trashPathFor } from '../files/fileOps';
import { getHost } from '../host';
import { elapsed, scoped } from '../logger';
import { rewriteFrontmatter } from '../model/markdown';
import { readText, writeText } from '../model/fs';
import { NovelProject } from '../model/project';
import { CharacterCard } from '../model/types';
import { DroppedAlias, explainDroppedAliases, normalizeName, sanitizeAliases } from '../model/naming';
import { runTask } from '../progress';

const log = scoped('角色卡');

/**
 * 角色卡的两条维护动作：清理别名、合并重复卡。
 *
 * 它们**不调模型**，纯本地整理，为的是收拾一类已经落盘的历史脏数据：
 *
 * - 别名并集只进不出，模型吐出的 `她`/`姐姐`/`少女` 一旦进了卡就再也出不去；
 *   更糟的是有时会混进**别人的名字**，而角色卡的名字与别名会随摘要提示词发给
 *   模型，等于反复教它认错人。
 * - 摘要里同一个人两种写法（`方源` / `古月方源`）曾让「全部建卡」建出两张卡。
 *   根因已在 [../identity.ts](../identity.ts) 修掉，但已经建出来的卡还在。
 *
 * 两条动作都只改 frontmatter（经 `rewriteFrontmatter`），**作者手写的正文一个
 * 字节都不动**；被合并掉的卡按「不真删」搬进 `.novelforge/.trash/`。
 */

// ---------------------------------------------------------------- 清理别名

interface AliasCleanup {
  card: CharacterCard;
  keep: string[];
  dropped: DroppedAlias[];
}

/**
 * 扫全部角色卡，删掉不是「专属称呼」的别名。
 *
 * 判据有两条：[../naming.ts](../naming.ts) 的泛称过滤，外加「这个别名是另一张卡
 * 的正式名」——后者是最有害的一种，它会让两个角色的出场章节互相串。
 */
export async function cleanCharacterAliases(project: NovelProject): Promise<void> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    getHost().toast('还没有角色卡。');
    return;
  }

  const nameOwner = new Map<string, CharacterCard>();
  for (const card of cards) {
    const key = normalizeName(card.name);
    if (key && !nameOwner.has(key)) {
      nameOwner.set(key, card);
    }
  }

  const plans: AliasCleanup[] = [];
  for (const card of cards) {
    const dropped = [...explainDroppedAliases(card.aliases, card.name)];
    const keep: string[] = [];
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      const owner = nameOwner.get(normalizeName(alias));
      if (owner && owner.slug !== card.slug) {
        dropped.push({ alias, reason: `是「${owner.name}」这张卡的正式名` });
        continue;
      }
      keep.push(alias);
    }
    if (dropped.length > 0) {
      plans.push({ card, keep, dropped });
    }
  }

  if (plans.length === 0) {
    log.info('角色卡别名检查通过', `${cards.length} 张卡，没有需要清理的称呼`);
    getHost().toast(`${cards.length} 张角色卡的别名都是专属称呼，无需清理。`);
    return;
  }

  const total = plans.reduce((sum, p) => sum + p.dropped.length, 0);
  const samples = plans
    .slice(0, 6)
    .map((p) => `「${p.card.name}」删 ${p.dropped.map((d) => d.alias).join('、')}`);
  const pick = await getHost().confirm(
    `${plans.length} 张角色卡里有 ${total} 个不该当别名的称呼，现在清理？`,
    ['清理'],
    {
      modal: true,
      detail: [
        '代词（她）、亲属称谓（姐姐）、泛称（少女／丫头）、描述短语（满身血迹的少女），'
          + '以及被误填成别名的**其他角色的名字**——它们会让程序把两个人认成一个。',
        samples.join('\n') + (plans.length > samples.length ? `\n……另有 ${plans.length - samples.length} 张` : ''),
        '不调模型。只改 frontmatter 的 aliases 字段，正文一个字都不动。',
      ].join('\n\n'),
    }
  );
  if (pick !== '清理') {
    log.info('用户取消了别名清理');
    return;
  }

  await runTask(
    '清理角色卡别名',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let done = 0;
      let failed = 0;
      for (const plan of plans) {
        if (signal.aborted) {
          log.warn(`清理被取消，已处理 ${done}/${plans.length} 张`);
          break;
        }
        report({ message: `「${plan.card.name}」`, current: done, total: plans.length });
        const abs = project.pathOf(plan.card.relPath);
        const rewritten = rewriteFrontmatter(await readText(abs), { aliases: plan.keep });
        if (!rewritten) {
          failed++;
          log.warn(`「${plan.card.name}」没有 frontmatter，跳过`, plan.card.relPath);
          continue;
        }
        await writeText(abs, rewritten);
        done++;
        log.info(
          `「${plan.card.name}」删掉 ${plan.dropped.length} 个称呼`,
          plan.dropped.map((d) => `${d.alias}（${d.reason}）`).join('、')
        );
      }
      project.invalidate();
      report({ message: '完成', current: plans.length, total: plans.length });
      log.info('别名清理结束', `${done} 张已改${failed > 0 ? `，${failed} 张跳过` : ''}｜用时 ${elapsed(startedAt)}`);
      getHost().toast(`已清理 ${done} 张角色卡的别名。`);
    },
    { scope: '角色卡' }
  );
}

// ---------------------------------------------------------------- 合并重复卡

/** 一组疑似同一个人的角色卡。 */
export interface DuplicateGroup {
  cards: CharacterCard[];
  /** 证据说明，直接进确认框。 */
  evidence: string;
  /** 摘要给出的证据强度：`summary` 有据可查，`naming` 只是名字长得像。 */
  strength: 'summary' | 'naming';
}

/**
 * 找出疑似重复的角色卡。导出供冒烟测试直接验证判据。
 *
 * 两类候选，强度不同：
 *
 * - **摘要证据**：几章摘要互相声明这几个称呼是同一个人，且从没在同一章里
 *   各自出场。这是 [../identity.ts](../identity.ts) 的聚类结论，可靠。
 * - **名字包含**：一张卡的名字是另一张的后缀（`古月赤城` ⊃ `赤城`）。
 *   只能算提示——`学堂家老 / 刑堂家老` 也满足，那是两个人。所以凡是被
 *   同章共现否掉的一律不列，剩下的也标明「只是名字像」。
 */
export async function findDuplicateCards(project: NovelProject): Promise<DuplicateGroup[]> {
  const cards = await project.listCharacters();
  const chapters = await readCastChapters(project);
  const identity = buildIdentityGroups(chapters);

  /**
   * 称呼 → 角色卡，**只认正式名**。
   *
   * 刻意不看 aliases：卡上的别名恰恰是这条流程要收拾的脏数据，拿它来认卡会
   * 反噬——实战里方源的卡挂着 `方正`、方正的卡挂着 `方源`，按别名认卡会把
   * 这对孪生姐弟报成「同一个人的两张卡」，正是最不能犯的错。
   * 真是同一个人的重复卡，它的正式名必然在摘要里出现过（卡就是照那个名字
   * 建出来的），所以只认正式名并不损失召回。
   */
  const cardByName = new Map<string, CharacterCard>();
  for (const card of cards) {
    const key = normalizeName(card.name);
    if (key && !cardByName.has(key)) {
      cardByName.set(key, card);
    }
  }

  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const groups: DuplicateGroup[] = [];
  const paired = new Set<string>();

  // ---- 1. 摘要聚类：一个组里落进了多张卡 ----
  for (const group of identity.groups) {
    const owners: CharacterCard[] = [];
    for (const name of group.names) {
      const card = cardByName.get(normalizeName(name));
      if (card && !owners.includes(card)) {
        owners.push(card);
      }
    }
    if (owners.length > 1) {
      owners.forEach((a) => owners.forEach((b) => paired.add(pairKey(a.slug, b.slug))));
      groups.push({
        cards: owners,
        strength: 'summary',
        evidence: `摘要里 ${group.names.slice(0, 5).join('、')} 指的是同一个人（共 ${group.chapters.length} 章），却分成了 ${owners.length} 张卡。`,
      });
    }
  }

  // ---- 2. 名字包含（弱提示） ----
  for (const a of cards) {
    for (const b of cards) {
      if (a.slug === b.slug || a.name.length <= b.name.length || !a.name.endsWith(b.name)) {
        continue;
      }
      if (paired.has(pairKey(a.slug, b.slug)) || identity.areDifferent(a.name, b.name)) {
        continue;
      }
      paired.add(pairKey(a.slug, b.slug));
      groups.push({
        cards: [a, b],
        strength: 'naming',
        evidence: `「${a.name}」的名字以「${b.name}」结尾，可能是同一个人的两种写法——但摘要里没有证据，请自行判断。`,
      });
    }
  }

  // 已有卡的正式名撞车也算重复（摘要里可能一次都没出现过）。
  const index = await buildCastIndex(project);
  for (const conflict of index.conflicts.filter((c) => c.kind === 'name')) {
    const owners = conflict.slugs.map((s) => bySlug.get(s)).filter((c): c is CharacterCard => !!c);
    if (owners.length > 1 && !paired.has(pairKey(owners[0].slug, owners[1].slug))) {
      paired.add(pairKey(owners[0].slug, owners[1].slug));
      groups.push({
        cards: owners,
        strength: 'summary',
        evidence: `这几张卡都声明自己叫「${conflict.name}」。`,
      });
    }
  }

  // 证据强的排前面，戏份重的再靠前。
  return groups.sort(
    (x, y) =>
      (x.strength === y.strength ? 0 : x.strength === 'summary' ? -1 : 1) ||
      countAppearances(y) - countAppearances(x)
  );
}

function countAppearances(group: DuplicateGroup): number {
  return group.cards.reduce((sum, c) => sum + c.appearsIn.length, 0);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/**
 * 查找并合并重复角色卡——工程页「角色」分组的右键动作。
 *
 * 逐组问作者保留哪一张，**绝不自动决定**：证据再强也只是启发式，
 * 把两个角色错并成一个远比多一张卡难收拾。
 */
export async function mergeDuplicateCharacterCards(project: NovelProject): Promise<void> {
  const groups = await findDuplicateCards(project);
  if (groups.length === 0) {
    log.info('没有发现重复角色卡');
    getHost().toast('没有发现重复的角色卡。');
    return;
  }

  const strong = groups.filter((g) => g.strength === 'summary').length;
  const pick = await getHost().confirm(
    `发现 ${groups.length} 组疑似重复的角色卡，逐组处理？`,
    ['逐组处理'],
    {
      modal: true,
      detail: [
        groups
          .slice(0, 8)
          .map((g) => `${g.strength === 'summary' ? '●' : '○'} ${g.cards.map((c) => `「${c.name}」`).join(' / ')}`)
          .join('\n') + (groups.length > 8 ? `\n……另有 ${groups.length - 8} 组` : ''),
        `● ${strong} 组有摘要证据，○ ${groups.length - strong} 组只是名字像，需要你自己判断。`,
        '不调模型。每组都会先问保留哪一张；被合并的卡搬进 .novelforge/.trash/，可手动找回。'
          + '注意：**被合并卡的正文小节不会自动融合**，合并后建议对保留的卡跑一次「从头重建角色卡」。',
      ].join('\n\n'),
    }
  );
  if (pick !== '逐组处理') {
    log.info('用户取消了重复卡合并');
    return;
  }

  let merged = 0;
  let skipped = 0;
  /** 已经被并掉的卡。同一张卡可能出现在两组候选里，第二次轮到它时文件已经不在了。 */
  const gone = new Set<string>();

  for (const group of groups) {
    const alive = group.cards.filter((c) => !gone.has(c.slug));
    if (alive.length < 2) {
      log.info('跳过一组重复卡', `${group.cards.map((c) => c.name).join(' / ')}｜其中的卡已在上一组里被合并`);
      continue;
    }
    // 戏份重的排前面：多半就是该保留的那张。
    const sorted = [...alive].sort((a, b) => b.appearsIn.length - a.appearsIn.length);
    // 按钮太多的模态框没法看。只让前几张当候选，其余照样会被并进去（详情里列全）。
    const choices = sorted.slice(0, 4);
    const labels = choices.map((c) => `保留「${c.name}」`);
    const choice = await getHost().confirm(`合并 ${sorted.map((c) => `「${c.name}」`).join(' / ')}？`, labels, {
      modal: true,
      detail: [
        group.evidence,
        sorted
          .map(
            (c) =>
              `「${c.name}」：${c.relPath}｜出场 ${c.appearsIn.length} 章｜已读到第 ${c.updatedThrough ?? 0} 章｜` +
              `别名 ${c.aliases.length > 0 ? c.aliases.join('、') : '无'}`
          )
          .join('\n'),
        sorted.length > choices.length
          ? `本组有 ${sorted.length} 张卡，按钮只列出出场最多的 ${choices.length} 张；选中哪一张，其余 ${sorted.length - 1} 张都会并进去。`
          : '',
        '选中的那张保留并吸收其余卡的别名/标签/出场章节；其余卡搬进回收站。取消则跳过这一组。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const keeper = choices[labels.indexOf(choice ?? '')];
    if (!keeper) {
      skipped++;
      log.info('跳过一组重复卡', sorted.map((c) => c.name).join(' / '));
      continue;
    }
    const losers = sorted.filter((c) => c.slug !== keeper.slug);
    if (await mergeInto(project, keeper, losers)) {
      losers.forEach((l) => gone.add(l.slug));
      merged++;
    }
  }

  project.invalidate();
  const summary = `合并 ${merged} 组${skipped > 0 ? `，跳过 ${skipped} 组` : ''}`;
  log.info('重复角色卡处理结束', summary);
  getHost().toast(`${summary}。`);
}

/** 把 losers 并进 keeper：元数据取并集，loser 的文件搬进回收站。返回是否成功。 */
async function mergeInto(project: NovelProject, keeper: CharacterCard, losers: CharacterCard[]): Promise<boolean> {
  const aliases = sanitizeAliases(
    [...keeper.aliases, ...losers.flatMap((l) => [l.name, ...l.aliases])],
    keeper.name
  );
  const tags = [...new Set([...keeper.tags, ...losers.flatMap((l) => l.tags)])];
  const appearsIn = [...new Set([...keeper.appearsIn, ...losers.flatMap((l) => l.appearsIn)])].sort(
    (a, b) => a - b
  );

  /**
   * 「已读到」是一条水位线，越过去的章节永远不会被重读。keeper 从没读过
   * loser 那些章，所以水位线必须退回**第一章没读过的之前**，否则合进来的
   * 出场章节会被增量更新整批跳过，而界面上看不出任何异常。
   */
  const unread = appearsIn.filter((o) => !keeper.appearsIn.includes(o));
  const updatedThrough = Math.min(keeper.updatedThrough ?? 0, unread.length > 0 ? Math.min(...unread) - 1 : Number.POSITIVE_INFINITY);

  const abs = project.pathOf(keeper.relPath);
  const rewritten = rewriteFrontmatter(await readText(abs), {
    aliases,
    tags,
    // frontmatter 里数组统一按字符串写；渲染出来是 `appearsIn: [2, 3, 5]`，与既有格式一致。
    appearsIn: appearsIn.map(String),
    firstAppear: appearsIn[0] ?? keeper.firstAppear,
    lastSeen: appearsIn[appearsIn.length - 1] ?? keeper.lastSeen,
    updatedThrough,
  });
  if (!rewritten) {
    log.error(`「${keeper.name}」没有 frontmatter，合并中止`, keeper.relPath);
    getHost().toast(`「${keeper.name}」的角色卡缺少 frontmatter，无法合并。`, 'error');
    return false;
  }
  await writeText(abs, rewritten);

  for (const loser of losers) {
    const dest = await trashPathFor(project, loser.relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(project.pathOf(loser.relPath), dest);
    log.info(`「${loser.name}」已并入「${keeper.name}」`, `原卡移到 ${project.relPath(dest)}`);
  }

  log.info(
    `「${keeper.name}」合并完成`,
    `别名 ${aliases.length} 个｜出场 ${appearsIn.length} 章｜「已读到」退回第 ${updatedThrough} 章` +
      `${unread.length > 0 ? `（新并入 ${unread.length} 章未读，建议跑一次更新）` : ''}`
  );
  return true;
}
