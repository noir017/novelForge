/**
 * 采纳：把一份产物写进磁盘。按产物种类分派到八条落盘路径。
 *
 * ## 与生成分开的那一步
 *
 * `generate` 只把文本交回界面，一个字都不写磁盘；这里才写，且只在用户点了
 * 采纳之后（AGENTS 第 19 条）。中间那一步是用户看着产物决定要不要的机会——
 * 少了它，「不静默覆盖」无从谈起。
 *
 * ## 守卫不在这里
 *
 * 落盘一律经 `workspace/` 网关：越界、同名、大小、乐观锁、覆盖审阅、
 * `.trash`、`upstreamHash` 记账，全在那一层做一次。本模块只做**分派**与
 * **人话消息**——每条路径的「跳过了哪几个人」「新建了哪一章」必须说出来，
 * 默默少建三张角色卡，作者要到写到那里才发现。
 */
import { scoped } from '../runtime/logger';
import { hash, sanitizeFileName, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, emptyCharacterSections, renderCharacterCard, renderLoreEntry } from '../model/project';
import { isPlotFilled, parsePlotFileName, plotContentHash, plotFileName } from '../model/plotFile';
import {
  LoreLine,
  LoreLookup,
  cleanLoreKeywords,
  createLoreLookup,
  loreThin,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import { isOutlineFilled, mergeOutline, outlineOverlaps } from '../model/outlineFile';
import { hasContent } from '../model/markdown';
import { stampState } from '../model/characterState';
import { keepGender } from '../model/gender';
import { CHARACTER_SECTION_KEYS, CharacterCard, CharacterSections, LoreEntry } from '../model/types';
import { CreationTarget, SETTING_DOC_LABEL, WriteMode, loreOfTarget, plotOfTarget } from '../model/pipeline';
import { Artifact, ChapterRange, LoreDraft, LoreListEntry, PlotFields, RosterEntry } from '../features/artifact';
import { BlueprintItem, blueprintToPlot } from '../features/blueprint';
import { unique } from '../features/parse';
import { chapterTargetOf } from '../views/pipeline';
import { buildLoreIndex } from '../views/lore';
import { integrationWatermark, loreEntryAt } from '../views/loreMaterial';
import { Workspace, pathOfTarget } from '../workspace';
import { plotUpstreamHash } from '../workspace/handlers/plot';
import { acceptSettledLore, plannedLoreSettle } from './loreSettle';

const log = scoped('创作');

/** 采纳的结果。`relPath` 是落盘位置，`skipped` 表示用户在审阅时放弃了。 */
export interface AcceptResult {
  relPath?: string;
  skipped?: boolean;
  /** 一句人话，直接进 toast。 */
  message: string;
}

/**
 * `onlyBlank`：批量那条路（工程页「补齐设定」）。第 19 条的批量那一面——不问、不覆盖：
 * 作者写过的节一个字不动，只填空着的节，也就不必弹审阅。
 */
export interface AcceptOptions {
  onlyBlank?: boolean;
  /**
   * 正文的写法（Draft 上记着的那一份）。`continue` 追加；其余在这一章已有正文时覆盖、
   * 写入前审阅。缺席（老会话里的 Draft）按「有正文就覆盖审阅」——宁可多问一句，
   * 也不把一整章叠到已有的后面。
   */
  writeMode?: WriteMode;
}

/**
 * 落盘之前就能说清的事：会新建哪几张角色卡。写入卡片上要列出来（D19），
 * 不能等写完了才在 toast 里说「顺便建了三张卡」。
 */
export async function plannedCards(project: NovelProject, artifact: Artifact): Promise<string[]> {
  if (artifact.kind !== 'plotBatch' && artifact.kind !== 'characterRoster') {
    return [];
  }
  const taken = takenNames(await project.listCharacters());
  const names =
    artifact.kind === 'plotBatch'
      ? artifact.items.flatMap((b) => b.newCharacters.map((c) => c.name))
      : artifact.characters.map((c) => c.name);
  return [...new Set(names)].filter((name) => !taken.has(name) && !taken.has(sanitizeFileName(name)));
}

function takenNames(cards: CharacterCard[]): Set<string> {
  return new Set(cards.flatMap((c) => [c.name, ...c.aliases, c.slug]));
}

/**
 * 同 {@link plannedCards}：落盘时会新建哪几条设定条目，写入卡片上列出来（设定名录）。
 *
 * - 细纲（批次与单章，完善设定 §3）：第九节里 `isNew` 的新设定建空条目。
 * - 展开一条设定：建议拆出来的子条目建空条目（完善设定 §1）。
 * - 设定清单：清单里还没有条目的那几条（已有的走覆盖审阅，不算新建）。
 *
 * 前两种是同一条规矩（{@link createPlannedLore}）：名字或关键词已被已有条目占了的、是角色卡上的人的，不建。
 * 落定设定（二期）另有一套认法（generation/loreSettle.ts），这里只取它「会新建」那一半。
 */
export async function plannedLore(project: NovelProject, artifact: Artifact): Promise<string[]> {
  if (artifact.kind === 'loreEntries' && artifact.settle) {
    return (await plannedLoreSettle(project, artifact.entries)).creates;
  }
  const lines = newLoreLines(artifact);
  if (artifact.kind !== 'loreList' && lines.length === 0) {
    return [];
  }
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = takenNames(cards);
  if (artifact.kind === 'loreList') {
    return artifact.entries.filter((e) => !existingLore(lookup, e) && !people.has(e.title)).map((e) => e.title);
  }
  return plannableLore(lines, lookup, people).map((l) => l.name);
}

/**
 * 产物里要建空条目的那几行：细纲批次与单章细纲是第九节里 `isNew` 的，展开是建议拆出来的子条目（没有 `relPath`
 * 的那几项，一句话当说明）。别的产物没有。
 */
function newLoreLines(artifact: Artifact): LoreLine[] {
  switch (artifact.kind) {
    case 'plotBatch':
      return artifact.items.flatMap((b) => (b.settings ?? []).filter((s) => s.isNew));
    case 'plot':
      return artifact.newLore ?? [];
    case 'loreEntries':
      return artifact.entries.filter((e) => !e.relPath).map((e) => ({ name: e.title, category: e.category, note: e.brief }));
    default:
      return [];
  }
}

/** 真会建的那几行：同名（归一后）只留第一行；名字或关键词已被已有条目占了的、是角色卡上的人的不建。 */
function plannableLore(lines: readonly LoreLine[], lookup: LoreLookup, people: ReadonlySet<string>): LoreLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = normalizeLoreName(l.name);
    if (!key || seen.has(key) || lookup.find(l.name) || people.has(l.name)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 设定清单里的一条认不认得出已有条目：先按名字，再按它的关键词（与名录同一张表，`createLoreLookup`）。 */
function existingLore(lookup: LoreLookup, entry: Pick<LoreListEntry, 'title' | 'keywords'>): LoreEntry | undefined {
  return lookup.find(entry.title) ?? entry.keywords.map((k) => lookup.find(k)).find((e) => !!e);
}

/**
 * 采纳产物，写进磁盘。
 *
 * **每一条覆盖已有内容的路径都走网关的覆盖审阅。** 例外都不覆盖任何东西：
 * 正文追加（往后加）与新建角色卡 / 设定条目（同名已存在的跳过或走各自的审阅）。
 */
export async function acceptArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact,
  opts: AcceptOptions = {}
): Promise<AcceptResult> {
  const ws = new Workspace(project);
  switch (artifact.kind) {
    case 'settingDoc':
      return acceptSettingDoc(project, ws, artifact, opts);
    case 'characterRoster':
      return acceptRoster(project, ws, artifact.characters);
    case 'loreList':
      return acceptLoreList(project, ws, artifact, opts);
    case 'loreEntries':
      // 落定设定（二期）是一批、没有目标条目，走自己的那条路（generation/loreSettle.ts）。
      return artifact.settle ? acceptSettledLore(project, ws, artifact.entries) : acceptLoreEntries(project, ws, target, artifact.entries);
    case 'outlineDoc':
      return acceptOutline(project, ws, artifact.text, artifact.range);
    case 'plot':
      return acceptPlot(project, ws, target, artifact);
    case 'manuscript':
      return acceptManuscript(project, ws, target, artifact.text, opts.writeMode);
    case 'plotBatch':
      return acceptPlotBatch(project, ws, artifact.items, artifact.range);
  }
}

/**
 * 小说配置 / 前提 / 世界观：整份替换，覆盖前审阅。配置的 frontmatter 由 handler 合并。
 *
 * **磁盘上那份一节内容都没有时不审阅**：新工程里躺着的是初始化写的空模板（全是占位），
 * 拿它跟产物 diff 一遍只是让作者多点一次；而作者哪怕只填了一节，照旧先问。
 * 配置的 frontmatter（总章数、每章字数）不受影响——handler 没给就沿用磁盘那份。
 */
async function acceptSettingDoc(
  project: NovelProject,
  ws: Workspace,
  artifact: Extract<Artifact, { kind: 'settingDoc' }>,
  opts: AcceptOptions
): Promise<AcceptResult> {
  const rel = pathOfTarget(project, { kind: 'setting', doc: artifact.doc });
  const what = SETTING_DOC_LABEL[artifact.doc];
  const current = await project.readSettingDoc(artifact.doc);
  const blank = !Object.values(current.sections).some((v) => v.trim());
  let art = artifact;
  // 批量只补空白：作者写过的节原样留着。配置不在这里合——生成链已经按「保留原文，
  // 追加生成」合过了（generation/structured.ts 的 completeConfig）。
  if (opts.onlyBlank && artifact.doc !== 'config') {
    const sections = { ...artifact.sections };
    for (const [key, value] of Object.entries(current.sections)) {
      if (hasContent(value)) {
        sections[key] = value;
      }
    }
    art = { ...artifact, sections };
  }
  const r = await ws.write(rel, { artifact: art }, { mode: 'overwrite', what, review: !blank && !opts.onlyBlank });
  if (r.skipped) {
    return { skipped: true, message: `没有改动${what}。` };
  }
  log.info(`${what}已写入`, rel);
  const styleNote = artifact.style ? await acceptStyle(project, ws, artifact.style) : '';
  return { relPath: rel, message: `已写入 ${rel}${styleNote}` };
}

/**
 * 配置草稿里附带的文风：**只在 `style.md` 还没被动过时写进去**（D14：文风的唯一出处
 * 是 `style.md`；第 3 条：作者写过的一个字都不覆盖）。没写进去也要说一句——
 * 作者看着卡片上那段文风，会以为它已经生效了。
 */
async function acceptStyle(project: NovelProject, ws: Workspace, style: string): Promise<string> {
  if (!(await project.styleGuideUntouched())) {
    log.info('文风指南已有作者的内容，配置里附带的文风没有写进去');
    return '；style.md 已有内容，附带的文风没有写进去';
  }
  const rel = await ws.writeStyleGuide(style);
  log.info('配置附带的文风已写入文风指南', rel);
  return `；文风写进了 ${rel}`;
}

/**
 * 角色图谱：每人一张角色卡。
 *
 * - **没有卡的人**直接建：新卡没有作者写过的内容可覆盖，不走审阅（与「给未建卡的
 *   人物新建角色卡」同一口径）。
 * - **同名（或别名撞上）已经有卡的**走覆盖审阅，一张一审：作者可能已经把那张卡改得
 *   很细，重新生成一次图谱不该静默抹掉它（第 3 条）。新图谱里空着的节沿用旧卡；
 *   出场统计、别名这些卡上的记账原样保留。
 *
 * 建了几张、覆盖了几张、保留了哪几张，必须说出来。
 */
async function acceptRoster(project: NovelProject, ws: Workspace, entries: RosterEntry[]): Promise<AcceptResult> {
  const cards = await project.listCharacters();
  const taken = takenNames(cards);
  const created: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  // 一张卡只处理一次：图谱里「林昭」与「阿昭」撞上的是同一张卡，第二次拿着写之前的
  // 旧内容再合并一遍，会把第一次刚换上的那一版又改回去。
  const handled = new Set<string>();

  for (const entry of entries) {
    const slug = sanitizeFileName(entry.name);
    const existing = cards.find((c) => c.name === entry.name || c.aliases.includes(entry.name) || c.slug === slug);
    if (existing && handled.has(existing.relPath)) {
      continue;
    }
    if (existing) {
      handled.add(existing.relPath);
      const sections = mergeSections(existing.sections, entry.sections);
      const merged = {
        ...existing,
        aliases: [...new Set([...existing.aliases, ...entry.aliases])],
        tags: existing.tags.length > 0 ? existing.tags : entry.role ? [entry.role] : [],
        gender: keepGender(existing.gender, entry.gender),
        sections,
      };
      // 新图谱给了「当前状态」就是机器写的开篇状态（D15）：盖章，定稿时才认得出它归机器。
      // 没给就沿用旧卡那一节，连同旧卡的章。
      const text = renderCharacterCard(hasContent(entry.sections.当前状态) ? stampState(merged, 0) : merged);
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `角色卡「${existing.name}」` });
      (r.skipped ? kept : replaced).push(existing.name);
      continue;
    }
    if (taken.has(entry.name) || taken.has(slug)) {
      kept.push(entry.name);
      continue;
    }
    taken.add(entry.name);
    taken.add(slug);
    // 图谱写的「当前状态」是开篇状态（`stateThrough: 0`），盖章归机器（D15）。
    await ws.writeCharacter(
      stampState(
        {
          slug,
          name: entry.name,
          aliases: entry.aliases,
          tags: entry.role ? [entry.role] : [],
          gender: entry.gender,
          sections: { ...emptyCharacterSections(), ...entry.sections },
        },
        0
      )
    );
    created.push(entry.name);
  }

  const parts = [
    created.length > 0 ? `新建 ${created.length} 张角色卡` : '',
    replaced.length > 0 ? `覆盖 ${replaced.join('、')}` : '',
    kept.length > 0 ? `保留原样的 ${kept.join('、')}` : '',
  ].filter(Boolean);
  log.info('角色图谱已落盘', parts.join('；') || '（没有改动）');
  const first = created[0] ?? replaced[0];
  const rel = first ? cards.find((c) => c.name === first)?.relPath ?? `${project.relPath(project.charactersDir)}/${sanitizeFileName(first)}.md` : undefined;
  return created.length + replaced.length === 0
    ? { skipped: true, message: `没有改动角色卡${kept.length > 0 ? `（保留原样的 ${kept.join('、')}）` : ''}。` }
    : { relPath: rel, message: `${parts.join('，')}。` };
}

/** 新的一版里有内容的节换新，空着的节沿用旧卡。 */
function mergeSections(old: CharacterSections, fresh: Partial<CharacterSections>): CharacterSections {
  const out = { ...old };
  for (const key of CHARACTER_SECTION_KEYS) {
    if (hasContent(fresh[key])) {
      out[key] = fresh[key]!.trim();
    }
  }
  return out;
}

/**
 * 设定清单：先建分类目录（空的也建——分类就是目录，作者看得到这本书的分类表），再一条一条落。
 *
 * - **还没有条目的**直接建在 `lore/<分类>/`：新文件不覆盖任何东西，不走审阅（同 `acceptRoster` 建新卡）。
 *   正文是机器写的，记下 `bodyHash`；水位 `updatedThrough: 0`——这是动笔之前排的，一章都还没整合过。
 * - **名字（或关键词）撞上已有条目的**走覆盖审阅，一条一审（第 3 条）：关键词并起来、一句话新的优先、
 *   正文新的没写出来就沿用旧的。正文换了新的，水位回到 0（新正文没整合过任何一章，之前并进去的事实
 *   下次整合时再并一遍），指纹记新正文的。
 * - 批量补齐（`onlyBlank`）只建新的，撞上已有的一律不动、不问（第 19 条批量那一面）。
 *
 * 建了几条、覆盖了几条、保留了哪几条、建了哪几个目录，必须说出来。
 */
async function acceptLoreList(
  project: NovelProject,
  ws: Workspace,
  artifact: Extract<Artifact, { kind: 'loreList' }>,
  opts: AcceptOptions
): Promise<AcceptResult> {
  const folders = await ws.ensureLoreFolders(artifact.categories);
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = takenNames(cards);
  const created: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  // 一条只处理一次：清单里两条撞上同一个已有条目时，第二次会拿着写之前的旧内容再合并一遍。
  const handled = new Set<string>();
  const fresh = new Set<string>();
  let first: string | undefined;
  // 模型给的关键词过一遍：人名、别的条目（已有的、清单里同一批的）的标题、名录里另记着的名字都不要
  // （model/loreFile.ts）。动笔之前名录是空的；写到一半再排清单时，定稿里记下的名字不能被一条吞掉。
  const others = {
    titles: [...entries.map((e) => e.title), ...artifact.entries.map((e) => e.title)],
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
    recorded: (await buildLoreIndex(project, { entries, cards }, { pending: false })).unknown.map((u) => u.name),
  };

  for (const entry of artifact.entries) {
    const key = normalizeLoreName(entry.title);
    if (!key || fresh.has(key)) {
      continue;
    }
    if (people.has(entry.title)) {
      log.info(`设定清单里的「${entry.title}」是角色卡上的人，不建条目`);
      continue;
    }
    const existing = existingLore(lookup, entry);
    if (existing) {
      if (handled.has(existing.relPath)) {
        continue;
      }
      handled.add(existing.relPath);
      if (opts.onlyBlank) {
        kept.push(existing.title);
        continue;
      }
      const body = entry.body.trim();
      const text = renderLoreEntry({
        slug: existing.slug,
        title: existing.title,
        keywords: unique([...existing.keywords, ...cleanLoreKeywords(existing.title, entry.keywords, others)]),
        brief: entry.brief || existing.brief,
        ...(body
          ? { body, updatedThrough: 0, bodyHash: hash(body) }
          : { body: existing.body, updatedThrough: existing.updatedThrough, bodyHash: existing.bodyHash }),
      });
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `设定「${existing.title}」` });
      (r.skipped ? kept : replaced).push(existing.title);
      first ??= r.skipped ? undefined : existing.relPath;
      continue;
    }
    fresh.add(key);
    const slug = await uniqueSlug(project.loreDir, `${entry.category ? `${entry.category}/` : ''}${slugify(entry.title)}`);
    const rel = await ws.writeLore({
      slug,
      title: entry.title,
      keywords: [entry.title, ...cleanLoreKeywords(entry.title, entry.keywords, others)],
      brief: entry.brief,
      body: entry.body,
      updatedThrough: 0,
      bodyHash: hash(entry.body.trim()),
    });
    created.push(entry.title);
    first ??= rel;
  }
  project.invalidate();

  const parts = [
    created.length > 0 ? `新建 ${created.length} 条设定条目` : '',
    replaced.length > 0 ? `覆盖 ${replaced.join('、')}` : '',
    kept.length > 0 ? `保留原样的 ${kept.join('、')}` : '',
    folders.length > 0 ? `新建分类目录 ${folders.join('、')}` : '',
  ].filter(Boolean);
  log.info('设定清单已落盘', parts.join('；') || '（没有改动）');
  return created.length + replaced.length + folders.length === 0
    ? { skipped: true, message: `没有改动设定条目${kept.length > 0 ? `（保留原样的 ${kept.join('、')}）` : ''}。` }
    : { relPath: first ?? project.relPath(project.loreDir), message: `${parts.join('，')}。` };
}

/**
 * 情节大纲：带区间（续写的那一段）时**只替换与这一段重叠的那几节**，其余原样保留
 * （model/outlineFile.ts 的 `mergeOutline`）；不带区间整篇替换。
 *
 * 审阅只在真的要换掉东西时弹：整篇替换一份写过的大纲，或者续写的这一段与已有的节
 * 重叠。纯续写（第 21–40 章接在第 20 章后面）一个字都不吞，不必让作者对比一遍。
 */
async function acceptOutline(
  project: NovelProject,
  ws: Workspace,
  text: string,
  range?: ChapterRange
): Promise<AcceptResult> {
  const rel = project.relPath(project.outlinePath);
  const existing = await project.readOutline();
  const next = range ? mergeOutline(existing, text, range) : text;
  const replacing = range ? outlineOverlaps(existing, range) : isOutlineFilled(existing);
  const r = await ws.write(rel, { artifact: { kind: 'outlineDoc', text: next } }, {
    mode: 'overwrite',
    what: '情节大纲',
    review: replacing,
  });
  if (r.skipped) {
    return { skipped: true, message: '没有改动大纲。' };
  }
  log.info('情节大纲已更新', `${rel}｜${next.length} 字${range ? `｜并入第 ${range.from}–${range.to} 章那一段` : ''}`);
  return { relPath: rel, message: `已写入 ${rel}` };
}

/**
 * 一章的细纲。
 *
 * - **已有这份文件**：整份替换、覆盖前审阅。渲染与记 `upstreamHash` 都在网关的
 *   plot handler 里——三个小节换新，标题 / 目标字数 / done 沿用磁盘那份。
 * - **还没有**（拆细纲给下一章找的落点、或老工程里只有正文的章）：按章号与产物
 *   带的标题新建。文件名里的标题要等这一刻才定得下来，所以落点可能不是 target 上
 *   那个纯序号的占位路径。
 */
async function acceptPlot(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  fields: PlotFields & { kind: 'plot' }
): Promise<AcceptResult> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    throw new Error('这份细纲不属于任何章。');
  }
  // 按章号认：占位路径（`summaries/003.md`）上采纳过一次之后，文件已经落成
  // `003-雪夜.md`，再采纳要覆盖它并先审阅，而不是当成新的再写一份。
  const existing = await project.resolvePlot(relPath);
  if (existing) {
    const r = await ws.write(existing.relPath, { artifact: fields }, {
      mode: 'overwrite',
      what: `第 ${existing.no} 章的细纲`,
    });
    if (r.skipped) {
      return { skipped: true, message: '没有改动这一章。' };
    }
    const lore = await createPlannedLore(project, ws, fields.newLore ?? []);
    log.info(`第 ${existing.no} 章的细纲已写入`, existing.relPath);
    return { relPath: existing.relPath, message: `已写入 ${existing.relPath}${loreNote(lore)}` };
  }

  const no = parsePlotFileName(relPath.split('/').pop() ?? '')?.no;
  if (!no) {
    throw new Error(`认不出这份细纲的章号：${relPath}`);
  }
  // 落点由网关定（有正文就是正文的镜像）；target 上的占位路径只拿来定子目录。
  const rel = await ws.writePlot(
    {
      no,
      title: fields.title ?? '',
      // D3：目标字数必填。蓝图合同里没有它，缺省取配置的每章字数。
      targetWords: fields.targetWords ?? (await project.readBookConfig()).wordsPerChapter,
      upstreamHash: await plotUpstreamHash(project, relPath),
      done: false,
      sections: fields.sections,
      lore: fields.lore,
    },
    undefined,
    relPath
  );
  const lore = await createPlannedLore(project, ws, fields.newLore ?? []);
  log.info(`第 ${no} 章的细纲已新建`, rel);
  return { relPath: rel, message: `已新建 ${rel}${loreNote(lore)}` };
}

/** 单章细纲顺带建了空条目时，toast 里那半句。 */
function loreNote(created: readonly string[]): string {
  return created.length > 0 ? `，新建设定条目：${created.join('、')}` : '';
}

/**
 * 一批细纲：一章一份，逐章落。
 *
 * - **已经排过的章**（关键事件有内容）走覆盖审阅，一章一审：主按钮那一批永远是空白的章
 *   （model/pipeline.ts 的拆细纲区间），走到这里说明作者在这之间自己排了——不静默盖掉。
 * - **空壳**（有文件、关键事件空着）直接填，并按产物的标题改名（`004.md` → `004-雪夜.md`）。
 * - **没有文件**的新建。目标字数缺省取配置的每章字数（D3）。
 *
 * 然后给蓝图里的新角色建卡（D19，同名已有的不动）。批量那条路（features/pipelineBatch.ts）
 * 也走这里——它只给空白的章，于是一张审阅都不会弹。
 */
export async function acceptPlotBatch(
  project: NovelProject,
  ws: Workspace,
  items: BlueprintItem[],
  range: ChapterRange,
  opts: { onlyBlank?: boolean } = {}
): Promise<AcceptResult> {
  const book = await project.readBookConfig();
  const written: string[] = [];
  const kept: number[] = [];
  for (const item of items) {
    const fields = blueprintToPlot(item);
    const existing = await project.getPlot(item.no);
    // 批量那条路只补空白（第 19 条）：跑的这几十秒里作者自己排了这一章，就不动它，也不问。
    if (existing && isPlotFilled(existing.sections) && opts.onlyBlank) {
      kept.push(item.no);
      continue;
    }
    if (existing && isPlotFilled(existing.sections)) {
      const r = await ws.write(existing.relPath, { artifact: { kind: 'plot', ...fields } }, {
        mode: 'overwrite',
        what: `第 ${item.no} 章的细纲`,
      });
      if (r.skipped) {
        kept.push(item.no);
      } else {
        written.push(r.rel);
      }
      continue;
    }
    written.push(
      await ws.writePlot(
        {
          no: item.no,
          title: existing?.title || fields.title || '',
          targetWords: existing?.targetWords ?? book.wordsPerChapter,
          upstreamHash: await plotUpstreamHash(project, plotFileName(item.no, '')),
          writtenFrom: existing?.writtenFrom,
          sourceHash: existing?.sourceHash,
          cast: existing?.cast,
          done: existing?.done ?? false,
          sections: fields.sections,
          lore: fields.lore ?? existing?.lore,
        },
        existing?.relPath
      )
    );
  }
  const cards = await createPlannedCards(project, ws, items);
  const lore = await createPlannedLore(
    project,
    ws,
    items.flatMap((b) => (b.settings ?? []).filter((s) => s.isNew))
  );

  const where = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
  const parts = [
    `已写入${where}的细纲 ${written.length} 份`,
    kept.length > 0 ? `保留原样的第 ${kept.join('、')} 章` : '',
    cards.length > 0 ? `新建角色卡：${cards.join('、')}` : '',
    lore.length > 0 ? `新建设定条目：${lore.join('、')}` : '',
  ].filter(Boolean);
  log.info(`${where}的细纲已落盘`, parts.join('；'));
  return written.length === 0 && cards.length === 0 && lore.length === 0
    ? { skipped: true, message: `没有改动${where}的细纲。` }
    : { relPath: written[0], message: `${parts.join('，')}。` };
}

/**
 * 蓝图里新登场、后面还会出场的人：直接建卡（D19）。同名（或别名撞上）已有的不动。
 *
 * 卡上只写得出这么多：定位、在哪一章登场、那一章的梗概。其余等写到了、定稿过，
 * 再从正文里更新——细纲里的「计划出场」不进出场统计（D13），这里也不写 `firstAppear`。
 */
async function createPlannedCards(project: NovelProject, ws: Workspace, items: BlueprintItem[]): Promise<string[]> {
  const taken = takenNames(await project.listCharacters());
  const created: string[] = [];
  for (const item of items) {
    for (const c of item.newCharacters) {
      const slug = sanitizeFileName(c.name);
      if (taken.has(c.name) || taken.has(slug)) {
        continue;
      }
      taken.add(c.name);
      taken.add(slug);
      await ws.writeCharacter({
        slug,
        name: c.name,
        aliases: [],
        tags: c.role ? [c.role] : [],
        gender: c.gender,
        sections: {
          ...emptyCharacterSections(),
          身份: `第 ${item.no} 章《${item.title}》登场${c.role ? `的${c.role}` : ''}。那一章：${item.synopsis}`,
        },
      });
      created.push(c.name);
    }
  }
  if (created.length > 0) {
    log.info(`细纲里的新角色已建卡：${created.join('、')}`);
  }
  return created;
}

/**
 * 细纲里本章首次引入、后面还会用到的设定（批次与单章都是第九节里 `isNew` 的那几行），以及展开一条设定时建议
 * 拆出来的子条目：直接建一条空条目（设定名录，同 D19 新角色建卡；第 19 条的例外）。名字或关键词已被已有条目
 * 占了的不动，是角色卡上的人的不建（{@link plannableLore}，卡片上列的是同一份）。
 *
 * 条目上只写得出这么多：标题、所在目录（就是分类，不存在就建）、一句话（第九节的说明 / 子条目的一句话）。
 * 正文留空，等写到了、定稿过，再从名录里「整合」——或者在工程页右键「展开」。
 */
async function createPlannedLore(project: NovelProject, ws: Workspace, lines: readonly LoreLine[]): Promise<string[]> {
  if (lines.length === 0) {
    return [];
  }
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const created: string[] = [];
  for (const s of plannableLore(lines, createLoreLookup(entries), takenNames(cards))) {
    const base = `${s.category ? `${s.category}/` : ''}${slugify(s.name)}`;
    const slug = await uniqueSlug(project.loreDir, base);
    await ws.writeLore({ slug, title: s.name, keywords: [s.name], brief: s.note, body: '' });
    created.push(s.name);
  }
  if (created.length > 0) {
    project.invalidate();
    log.info(`新设定已建空条目：${created.join('、')}`);
  }
  return created;
}

/**
 * 展开一条设定（完善设定，2026-10-19）。`entries` 里按 `relPath` 认出目标条目（展开不改名），其余是建议拆出来的
 * 子条目。还没定的问题（`questions`）不在这里——它只上卡片，不写进任何文件。
 *
 * 目标条目：
 * - 正文整份换成展开后的（暗设是第四节 `## 暗设`）；关键词只增不减（新给的过一遍人名、别的条目的标题——含这一次
 *   拆出去的子条目——与名录里另记着的名字）；一句话新的优先。
 * - 记作机器写的：`bodyHash` = 新正文的指纹（作者定案 4：正文写偏了以正文为准，整合可以直接改）；水位同整合
 *   （`integrationWatermark`）——展开喂的定稿记录就是整合会喂的那一份，写完 `＋N` 也就收了。
 * - **明面正文是空的、是占位，又没有暗设**才直接写（没有东西可吞）；其余走覆盖审阅（第 3 条）。三节都写着
 *   「（未交代）」的也先对比：那可能是作者手写的。
 * - 文件还不在（MCP 给了一条新路径、展开期间被删了）：按这个路径新建，标题取文件名；名字已被别的条目占了、
 *   是角色卡上的人的不建。
 *
 * 子条目：建空条目（{@link createPlannedLore}，与细纲带出新设定同一条规矩）。作者在覆盖审阅里放弃了这一条的
 * 展开时，拆出来的子条目也不建——它们是这一次展开的一部分。
 */
async function acceptLoreEntries(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  drafts: readonly LoreDraft[]
): Promise<AcceptResult> {
  const relPath = loreOfTarget(target);
  const main = relPath ? drafts.find((d) => d.relPath === relPath) : undefined;
  if (!relPath || !main) {
    return { skipped: true, message: '这份产物里没有要展开的那一条设定，没有写入任何文件。' };
  }
  const children = drafts.filter((d) => d !== main && !d.relPath);
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const { entry, exists } = await loreEntryAt(project, relPath, entries);
  const people = cards.flatMap((c) => [c.name, ...c.aliases]);
  if (!exists) {
    const owner = createLoreLookup(entries).find(entry.title);
    if (owner || takenNames(cards).has(entry.title)) {
      const why = owner ? `已经有条目了（${owner.relPath}）` : '是角色卡上的人';
      log.warn(`展开的设定「${entry.title}」没有新建：${why}`, relPath);
      return { skipped: true, message: `「${entry.title}」${why}，没有新建 ${relPath}。` };
    }
  }

  const fresh = cleanLoreKeywords(entry.title, main.keywords, {
    titles: [...entries.filter((e) => e.relPath !== relPath).map((e) => e.title), ...children.map((c) => c.title)],
    people,
    recorded: (await buildLoreIndex(project, { entries, cards }, { pending: false })).unknown.map((u) => u.name),
  });
  const body = main.body.trim();
  const text = renderLoreEntry({
    slug: entry.slug,
    title: entry.title,
    keywords: unique([...(exists ? entry.keywords : [entry.title]), ...fresh]),
    brief: main.brief || entry.brief,
    body,
    // 只往前推不往回退：条目早就整合到了更后面（之后前面某章正文又改过、水位停在了那里），不能把它拉回去，
    // 不然已经并进条目的那些章又挂上 ＋N。
    updatedThrough: Math.max(exists ? entry.updatedThrough ?? 0 : 0, await integrationWatermark(project)),
    bodyHash: hash(body),
  });
  const thin = exists ? loreThin(entry) : 'empty';
  const direct = (thin === 'empty' || thin === 'placeholder') && !splitLoreHidden(entry.body).hidden;
  const what = `设定「${entry.title}」`;
  const r = exists
    ? await ws.write(relPath, { text }, { mode: 'overwrite', what, review: !direct })
    : await ws.write(relPath, { text }, { mode: 'create', what });
  if (r.skipped) {
    log.info(`没有采纳${what}的展开`, children.length > 0 ? `拆出来的 ${children.length} 条也没建` : relPath);
    return {
      skipped: true,
      message: `没有改动${what}${children.length > 0 ? `（拆出来的 ${children.map((c) => c.title).join('、')} 也没建）` : ''}。`,
    };
  }
  const created = await createPlannedLore(
    project,
    ws,
    children.map((c) => ({ name: c.title, category: c.category, note: c.brief }))
  );
  project.invalidate();
  log.info(
    `已展开${what}`,
    `${relPath}｜正文 ${body.length} 字｜${direct ? '原来只有一句话，直接写' : '对比后采纳'}` +
      `${created.length > 0 ? `｜新建子条目 ${created.join('、')}` : ''}`
  );
  return {
    relPath,
    message: `已展开${what}${created.length > 0 ? `，新建设定条目：${created.join('、')}` : ''}。`,
  };
}

/**
 * 正文：落在**同号的章节**上。三种写法（model/pipeline.ts 的 `WriteMode`）：
 *
 * - 章节还没有：在细纲所在的子目录新建（`chapterTargetOf`；同名一律报错，见网关），细纲文件名与
 *   新正文对不上时跟着改名，保证细纲仍是正文的镜像。
 * - 章节在、但一个字正文都没有（只有标题行）：直接填，不审阅——没有东西可吞。
 * - `continue`：**追加**在末尾，不审阅（不覆盖任何东西）。
 * - 其余（`write` / `rewrite`，以及老会话里没记写法的）：**覆盖**，写入前审阅 diff
 *   （第 3 条）。标题行沿用原文件——那是作者起的名字，模型写的正文里没有它。
 *
 * 落盘之后在细纲上记 `writtenFrom`（正文据以写成的细纲指纹）。少了这一步，
 * 这一章会永远显示「正文与细纲对不上」或永远不显示，两种都是错的。
 * 作者在审阅时放弃了就什么都不记。**修稿（`revise`）也不记**：它没有照细纲重写，只改了
 * 审稿指出的那几处——细纲改过的 ⟳ 不能因为修了一次稿就消掉。
 */
async function acceptManuscript(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  text: string,
  mode?: WriteMode
): Promise<AcceptResult> {
  const plotRelPath = plotOfTarget(target);
  if (!plotRelPath) {
    throw new Error('这段正文不属于任何章。');
  }
  const dest = await chapterTargetOf(project, plotRelPath);
  let rel: string;
  let how: string;
  if (!dest.exists) {
    rel = await ws.createChapterAt(dest.rel, text, dest.plotRelPath);
    how = '新建';
  } else {
    const chapter = await project.getChapter(dest.no);
    const body = chapter ? await project.readChapterText(chapter) : '';
    const raw = chapter ? await project.readChapterRaw(chapter) : '';
    if (body.trim() && mode === 'continue') {
      rel = (await ws.write(dest.rel, { text }, { mode: 'append' })).rel;
      how = '追加';
    } else {
      const r = await ws.write(dest.rel, { text: withHeading(raw, body, text) }, {
        mode: 'overwrite',
        what: `第 ${dest.no} 章的正文`,
        review: !!body.trim(),
      });
      if (r.skipped) {
        return { skipped: true, message: `没有改动第 ${dest.no} 章。` };
      }
      rel = r.rel;
      how = body.trim() ? '覆盖' : '写入';
    }
  }

  const plot = mode === 'revise' ? undefined : await project.resolvePlot(plotRelPath);
  if (plot) {
    await ws.recordWrittenFrom(plot.relPath, plotContentHash(plot));
  }
  await project.syncManifest();

  log.info(`已${how}第 ${dest.no} 章：${text.length} 字`, `${rel}｜定稿过的话要重新定稿`);
  return { relPath: rel, message: how === '追加' ? `已追加到 ${rel}` : `已写入 ${rel}` };
}

/**
 * 覆盖一章时保留原文件的标题行（`# 标题`）。
 *
 * `raw` 是整个文件、`body` 是去掉标题行之后的正文：两者一样就说明原文件没有标题行
 * （`.txt`、或作者删了），那就原样只写正文，不凭空补一行。
 */
function withHeading(raw: string, body: string, text: string): string {
  const head = raw.trim() !== body.trim() ? /^[^\n]*\n?/.exec(raw.trimStart())?.[0].trim() : undefined;
  return head ? `${head}\n\n${text.trim()}\n` : `${text.trim()}\n`;
}
