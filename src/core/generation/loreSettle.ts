/**
 * 落定设定（完善设定二期）的落盘：把一段讨论里定下来的一批设定写进 `lore/`。只在作者在落盘卡片上点了「写入」之后
 * 发生（第 19 条）；分派在 generation/accept.ts（`loreEntries` 带 `settle`）。
 *
 * 气泡里那一份带着生成那一刻认出的路径，这里**按磁盘再认一遍**（features/loreSettle.ts 的 `findSettledEntry`，
 * 与生成链同一个函数）：作者这期间可能改了名、删了条目、新建了同名的。卡片上「会新建 / 会更新」两行也是这一遍
 * （{@link plannedLoreSettle}），说的和做的是同一件事。
 */
import { scoped } from '../runtime/logger';
import { hash, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, renderLoreEntry } from '../model/project';
import { cleanLoreKeywords, createLoreLookup, loreThin, normalizeLoreName, splitLoreHidden } from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import type { LoreDraft } from '../features/loreExpand';
import { findSettledEntry } from '../features/loreSettle';
import { unique } from '../features/parse';
import { buildLoreIndex } from '../views/lore';
import type { Workspace } from '../workspace';
import type { AcceptResult } from './accept';

const log = scoped('创作');

/** 一条要落定的设定按磁盘认下来：改哪一条已有的，或者新建；是人名的不建。 */
type Resolved = { draft: LoreDraft; existing?: LoreEntry; person?: boolean };

/** 按磁盘认一遍：人名的标出来；同一条已有条目被认了两次的只留第一次；新建的同名（归一后）只留第一条。 */
async function resolveAll(project: NovelProject, drafts: readonly LoreDraft[]): Promise<{ list: Resolved[]; entries: LoreEntry[]; people: string[] }> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = cards.flatMap((c) => [c.name, ...c.aliases, c.slug]);
  const isPerson = new Set(people.map(normalizeLoreName).filter(Boolean));
  const used = new Set<string>();
  const fresh = new Set<string>();
  const list: Resolved[] = [];
  for (const draft of drafts) {
    const key = normalizeLoreName(draft.title);
    if (!key) {
      continue;
    }
    const existing = findSettledEntry(entries, draft, lookup);
    if (existing) {
      if (!used.has(existing.relPath)) {
        used.add(existing.relPath);
        list.push({ draft, existing });
      }
      continue;
    }
    if (isPerson.has(key)) {
      list.push({ draft, person: true });
      continue;
    }
    if (!fresh.has(key)) {
      fresh.add(key);
      list.push({ draft });
    }
  }
  return { list, entries, people };
}

/** 落盘卡片上那两行：会新建哪几条、会更新哪几条（已有条目的标题）。与 {@link acceptSettledLore} 同一遍认法。 */
export async function plannedLoreSettle(
  project: NovelProject,
  drafts: readonly LoreDraft[]
): Promise<{ creates: string[]; updates: string[] }> {
  const { list } = await resolveAll(project, drafts);
  return {
    creates: list.filter((r) => !r.existing && !r.person).map((r) => r.draft.title),
    updates: list.filter((r) => r.existing).map((r) => r.existing!.title),
  };
}

/**
 * 落定设定：
 *
 * - **新的**直接建在 `lore/<分类>/`（目录不存在就建）：新文件不覆盖任何东西，不走审阅。正文是机器写的，记
 *   `bodyHash`；水位 `updatedThrough: 0`（同设定清单新建的）。
 * - **已有的**逐条落：关键词只增不减（新给的过一遍人名、别的条目的标题、名录里另记着的名字）、一句话新的优先、
 *   正文换成合并后的完整版，记作机器写的（`bodyHash`）。**水位不动**：这是在原有内容上并进讨论结论，不是整条换新
 *   ——不能照设定清单撞名时那样归 0，不然已经整合进去的那些章又挂上 ＋N。明面是空的、是占位、又没有暗设的直接写
 *   （没有东西可吞，同展开）；其余走覆盖审阅，一条一审（第 3 条），放弃了那一条就原样留着。
 * - 是角色卡上的人的不建（人不是设定）。
 *
 * 还没定的问题（`questions`）不在这里——它只上卡片，不写进任何文件。建了几条、更新了几条、保留了哪几条，必须说出来。
 */
export async function acceptSettledLore(project: NovelProject, ws: Workspace, drafts: readonly LoreDraft[]): Promise<AcceptResult> {
  const { list, entries, people } = await resolveAll(project, drafts);
  const others = {
    titles: [...entries.map((e) => e.title), ...drafts.map((d) => d.title)],
    people,
    recorded: (await buildLoreIndex(project, { entries }, { pending: false })).unknown.map((u) => u.name),
  };
  const created: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  const skippedPeople: string[] = [];
  let first: string | undefined;

  for (const { draft, existing, person } of list) {
    const body = draft.body.trim();
    if (person) {
      skippedPeople.push(draft.title);
      continue;
    }
    if (existing) {
      const thin = loreThin(existing);
      const direct = (thin === 'empty' || thin === 'placeholder') && !splitLoreHidden(existing.body).hidden;
      const text = renderLoreEntry({
        slug: existing.slug,
        title: existing.title,
        keywords: unique([...existing.keywords, ...cleanLoreKeywords(existing.title, draft.keywords, others)]),
        brief: draft.brief || existing.brief,
        ...(body
          ? { body, updatedThrough: existing.updatedThrough, bodyHash: hash(body) }
          : { body: existing.body, updatedThrough: existing.updatedThrough, bodyHash: existing.bodyHash }),
      });
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `设定「${existing.title}」`, review: !direct });
      (r.skipped ? kept : updated).push(existing.title);
      first ??= r.skipped ? undefined : existing.relPath;
      continue;
    }
    const slug = await uniqueSlug(project.loreDir, `${draft.category ? `${draft.category}/` : ''}${slugify(draft.title)}`);
    const rel = await ws.writeLore({
      slug,
      title: draft.title,
      keywords: [draft.title, ...cleanLoreKeywords(draft.title, draft.keywords, others)],
      brief: draft.brief,
      body,
      updatedThrough: 0,
      bodyHash: hash(body),
    });
    created.push(draft.title);
    first ??= rel;
  }
  project.invalidate();

  const parts = [
    created.length > 0 ? `新建 ${created.length} 条设定条目（${created.join('、')}）` : '',
    updated.length > 0 ? `更新 ${updated.join('、')}` : '',
    kept.length > 0 ? `保留原样的 ${kept.join('、')}` : '',
    skippedPeople.length > 0 ? `${skippedPeople.join('、')}是角色卡上的人，没建` : '',
  ].filter(Boolean);
  log.info('落定设定已落盘', parts.join('；') || '（没有改动）');
  return created.length + updated.length === 0
    ? { skipped: true, message: `没有改动设定条目${parts.length > 0 ? `（${parts.join('，')}）` : ''}。` }
    : { relPath: first ?? project.relPath(project.loreDir), message: `落定设定：${parts.join('，')}。` };
}
