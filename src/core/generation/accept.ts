/**
 * 采纳：把一份产物写进磁盘。按产物种类分派到六条落盘路径。
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
import { sanitizeFileName } from '../model/fs';
import { NovelProject, emptyCharacterSections, renderCharacterCard } from '../model/project';
import { isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { isOutlineFilled, mergeOutline, outlineOverlaps } from '../model/outlineFile';
import { hasContent } from '../model/markdown';
import { CHARACTER_SECTION_KEYS, CharacterCard, CharacterSections } from '../model/types';
import { CreationTarget, SETTING_DOC_LABEL, plotOfTarget } from '../model/pipeline';
import { Artifact, ChapterRange, PlotFields, RosterEntry } from '../features/artifact';
import { BlueprintItem, blueprintToPlot } from '../features/blueprint';
import { chapterTargetOf, plotContentHash } from '../views/pipeline';
import { Workspace, pathOfTarget } from '../workspace';
import { plotUpstreamHash } from '../workspace/handlers/plot';

const log = scoped('创作');

/** 采纳的结果。`relPath` 是落盘位置，`skipped` 表示用户在审阅时放弃了。 */
export interface AcceptResult {
  relPath?: string;
  skipped?: boolean;
  /** 一句人话，直接进 toast。 */
  message: string;
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
 * 采纳产物，写进磁盘。
 *
 * **每一条覆盖已有内容的路径都走网关的覆盖审阅。** 例外有两条，都不覆盖任何东西：
 * 正文追加（往后加）与新建角色卡（同名已存在的一律跳过）。
 */
export async function acceptArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact
): Promise<AcceptResult> {
  const ws = new Workspace(project);
  switch (artifact.kind) {
    case 'settingDoc':
      return acceptSettingDoc(project, ws, artifact);
    case 'characterRoster':
      return acceptRoster(project, ws, artifact.characters);
    case 'outlineDoc':
      return acceptOutline(project, ws, artifact.text, artifact.range);
    case 'plot':
      return acceptPlot(project, ws, target, artifact);
    case 'manuscript':
      return acceptManuscript(project, ws, target, artifact.text);
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
  artifact: Extract<Artifact, { kind: 'settingDoc' }>
): Promise<AcceptResult> {
  const rel = pathOfTarget(project, { kind: 'setting', doc: artifact.doc });
  const what = SETTING_DOC_LABEL[artifact.doc];
  const current = await project.readSettingDoc(artifact.doc);
  const blank = !Object.values(current.sections).some((v) => v.trim());
  const r = await ws.write(rel, { artifact }, { mode: 'overwrite', what, review: !blank });
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
      const text = renderCharacterCard({
        ...existing,
        aliases: [...new Set([...existing.aliases, ...entry.aliases])],
        tags: existing.tags.length > 0 ? existing.tags : entry.role ? [entry.role] : [],
        sections,
      });
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
    await ws.writeCharacter({
      slug,
      name: entry.name,
      aliases: entry.aliases,
      tags: entry.role ? [entry.role] : [],
      sections: { ...emptyCharacterSections(), ...entry.sections },
    });
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
  // 按章号认：占位路径（`plots/003.md`）上采纳过一次之后，文件已经落成
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
    log.info(`第 ${existing.no} 章的细纲已写入`, existing.relPath);
    return { relPath: existing.relPath, message: `已写入 ${existing.relPath}` };
  }

  const no = parsePlotFileName(relPath.split('/').pop() ?? '')?.no;
  if (!no) {
    throw new Error(`认不出这份细纲的章号：${relPath}`);
  }
  const rel = await ws.writePlot({
    no,
    title: fields.title ?? '',
    role: fields.role ?? '',
    characters: fields.characters ?? [],
    // D3：目标字数必填。蓝图合同里没有它，缺省取配置的每章字数。
    targetWords: fields.targetWords ?? (await project.readBookConfig()).wordsPerChapter,
    upstreamHash: await plotUpstreamHash(project, relPath),
    done: false,
    sections: fields.sections,
  });
  log.info(`第 ${no} 章的细纲已新建`, rel);
  return { relPath: rel, message: `已新建 ${rel}` };
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
  range: ChapterRange
): Promise<AcceptResult> {
  const book = await project.readBookConfig();
  const written: string[] = [];
  const kept: number[] = [];
  for (const item of items) {
    const fields = blueprintToPlot(item);
    const existing = await project.getPlot(item.no);
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
          role: fields.role ?? '',
          characters: fields.characters ?? [],
          targetWords: existing?.targetWords ?? book.wordsPerChapter,
          upstreamHash: await plotUpstreamHash(project, project.plotPathForNo(item.no, '')),
          writtenFrom: existing?.writtenFrom,
          done: existing?.done ?? false,
          sections: fields.sections,
        },
        existing?.relPath
      )
    );
  }
  const cards = await createPlannedCards(project, ws, items);

  const where = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
  const parts = [
    `已写入${where}的细纲 ${written.length} 份`,
    kept.length > 0 ? `保留原样的第 ${kept.join('、')} 章` : '',
    cards.length > 0 ? `新建角色卡：${cards.join('、')}` : '',
  ].filter(Boolean);
  log.info(`${where}的细纲已落盘`, parts.join('；'));
  return written.length === 0 && cards.length === 0
    ? { skipped: true, message: `没有改动${where}的细纲。` }
    : { relPath: written[0], message: `${parts.join('，')}。` };
}

/**
 * 蓝图里新登场、后面还会出场的人：直接建卡（D19）。同名（或别名撞上）已有的不动。
 *
 * 卡上只写得出这么多：定位、在哪一章登场、那一章要他做什么。其余等写到了、有了摘要，
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
        sections: {
          ...emptyCharacterSections(),
          身份: `第 ${item.no} 章《${item.title}》登场${c.role ? `的${c.role}` : ''}。那一章：${item.purpose}`,
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
 * 正文：落在**同号的章节**上。
 *
 * - 章节还没有：新建 `chapters/NNN-<细纲标题>.md`（同名一律报错，见网关）。
 * - 已经有了：**追加**在末尾——「接着写」不该丢掉前面那几千字。重写 / 覆盖的
 *   语义在三期随自动续写一起定。
 *
 * 落盘之后在细纲上记 `writtenFrom`（正文据以写成的细纲指纹）。少了这一步，
 * 这一章会永远显示「正文与细纲对不上」或永远不显示，两种都是错的。
 * 追加是唯一不走覆盖审阅的落盘路径——它不覆盖任何东西。
 */
async function acceptManuscript(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  text: string
): Promise<AcceptResult> {
  const plotRelPath = plotOfTarget(target);
  if (!plotRelPath) {
    throw new Error('这段正文不属于任何章。');
  }
  const dest = await chapterTargetOf(project, plotRelPath);
  const rel = dest.exists
    ? (await ws.write(dest.rel, { text }, { mode: 'append' })).rel
    : await ws.createChapter(dest.no, dest.title, text);

  const plot = await project.resolvePlot(plotRelPath);
  if (plot) {
    await ws.recordWrittenFrom(plot.relPath, plotContentHash(plot));
  }
  await project.syncManifest();

  log.info(`已${dest.exists ? '追加' : '写入'} ${text.length} 字到第 ${dest.no} 章`, `${rel}｜该章摘要将变为过期`);
  return { relPath: rel, message: `已写入 ${rel}` };
}
