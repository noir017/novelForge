import { basename } from 'node:path';
import { buildCastIndex, describePlots } from './cast';
import { THIN_LORE_LABEL, buildLoreIndex, describeSpan, pendingChapters } from './lore';
import { loreBrief } from '../model/loreFile';
import { listActiveFailures } from '../runtime/errorLog';
import { scoped } from '../runtime/logger';
import { hasContent, stripH1 } from '../model/markdown';
import { BookConfig } from '../model/settingFile';
import { DEFAULT_PARAGRAPH_STYLE } from '../model/paragraphFormat';
import { BookFacts, BookStage, SETTING_DOCS, SETTING_DOC_LABEL, SettingDoc, chapterLabel, deriveBookNextStep, deriveBookStage } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, parsePlotFileName } from '../model/plotFile';
import { isOutlineFilled, outlineCoverage } from '../model/outlineFile';
import { describeStateThrough } from '../model/characterState';
import { buildBookFacts, buildPlotPipeline, buildPipelineIndex, chapterOfPlotNo } from './pipeline';
import { chapterIndexEntryOf } from './chapterIndex';
import { volumeOf } from './quickOpen';
import { buildThreadsView } from './threads';
import { threadsMarkOf } from '../model/threadFile';
import {
  ArchitectureRow,
  CastConflictView,
  CastEntry,
  CastSummary,
  LoreSummary,
  LoreThinEntry,
  LoreUnfiledEntry,
  PlotPipelineView,
  PlotSummaryView,
  ProjectDirNode,
  ProjectFileNode,
  ProjectNode,
  ProjectPlotNode,
  ProjectTree,
  IdeaDefaults,
  NextStepView,
  VolumeView,
} from '../protocol';

const log = scoped('角色卡');

/**
 * 每个工程上一次报过的冲突签名。工程页每次刷新都会走到这里，同一批冲突反复打进日志
 * 会把日志页淹掉——变了才说一次。按工程根分开：独立版同时开着几个工程时不互相顶掉。
 */
const lastConflictSignature = new Map<string, string>();

/**
 * 工程页的数据来源。
 *
 * ## 「故事架构」与「章节」两组
 *
 * - **故事架构**：小说配置 / 故事前提 / 角色图谱 / 世界观 / 设定清单 / 情节大纲六行，各带
 *   「填过没有」。它们是后面一切的上游，排在最前面。
 * - **章节**：一个章号一行（细纲号 = 章号）。一行同时报细纲与正文两面：排过没有、
 *   写了多少、定稿没有、上游变没变。
 *
 * 角色 / 设定两个区仍是任意深度的目录树：数据层给出扁平的文件清单（含各级
 * 子目录里的），这里按 relPath 折成层级。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.stylePath);
  const outlinePath = project.relPath(project.outlinePath);
  const globalSummaryPath = project.relPath(project.globalSummaryPath);
  const threadsPath = project.relPath(project.threadsDir);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const charactersRoot = project.relPath(project.charactersDir);
  const loreRoot = project.relPath(project.loreDir);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      plotCount: 0,
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      summarizedCount: 0,
      architecture: [],
      plots: [],
      volumes: [],
      characters: [],
      lore: [],
      cast: [],
      castByCard: {},
      loreByEntry: {},
      loreUnfiled: [],
      loreThin: [],
      loreUnrecorded: 0,
      castConflicts: [],
      failures: {},
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      globalSummaryPath,
      threadsPath,
      threads: { lines: [], current: 0, through: 0, watch: { lines: [], foreshadowing: [], unplanted: [] } },
      bookStage: 'setting',
      nextChapterNo: 1,
      book: { idea: '', configHasContent: false, plotFilledNos: [] },
      paragraphStyle: DEFAULT_PARAGRAPH_STYLE,
    };
  }

  const [characters, lore, characterDirs, loreDirs, draftPaths, pipelineIndex, threadBook, volumeNames] = await Promise.all([
    project.listCharacters(),
    project.listLore(),
    project.listFolders(project.charactersDir),
    project.listFolders(project.loreDir),
    // 一次遍历拿到全部已存在的草稿，胜过每章一次 stat。
    project.listDraftPaths(),
    // 全书流水线索引：大纲、配置、manifest、细纲与章节都只读一次摊给所有章。
    buildPipelineIndex(project),
    // 叙事线目录一次读完（一条线一个文件）。
    project.readThreads(),
    // 分卷：章节根下的一级目录，空卷也要（刚建、还没放章的那一卷在页签上看得见）。
    project.listVolumes(),
  ]);
  // 章节列表、细纲列表、manifest 与大纲原文都用流水线那一趟读到的同一份，
  // 不再单独读一次。
  const { rows, chapters, plots, manifest, outline } = pipelineIndex;
  const book = await buildBookFacts(project, pipelineIndex, { characters, lore });

  const plotsRoot = project.relPath(project.plotsDir);
  const plotRows: ProjectPlotNode[] = rows.map((p) => {
    const chapterPath = p.chapter.relPath;
    const draftPath = chapterPath ? (project.draftRelPathFor(chapterPath) ?? '') : '';
    return {
      // 章节条、上一章 / 下一章用的那几个字段与这里同一个函数算（views/chapterIndex.ts）。
      ...chapterIndexEntryOf(p),
      // 一卷是章节根下的一级目录：卷里再分的子目录（`第一卷/上`）算在这一卷里。
      volume: (chapterPath ? volumeOf(chapterPath, chaptersRoot) : volumeOf(p.plot.relPath, plotsRoot)).split('/')[0],
      // 空章不算没定稿：那不是「定稿旧了」，是还没写。
      stale: p.chapter.words > 0 && p.summary.stale,
      progress: p.progress,
      upstreamStale: p.plot.upstreamStale || p.chapter.upstreamStale,
      draftPath,
      hasDraft: draftPath !== '' && draftPaths.has(draftPath),
    };
  });

  const coverage = outlineCoverage(outline);
  // 角色图谱、设定清单两行报的是条数：它们没有自己的文件，「填过」看的就是那一组里有没有东西。
  // 设定清单在有正文的书上算填过（`isLoreListFilled`），一条都没有时照实说 0 条；没填过才说「待生成」。
  const counted: Partial<Record<SettingDoc, string>> = { characters: `${characters.length} 人`, lore: `${lore.length} 条` };
  const architecture: ArchitectureRow[] = [
    ...SETTING_DOCS.map((doc) => ({
      key: doc,
      label: SETTING_DOC_LABEL[doc],
      relPath: project.relPath(project.settingPath(doc)),
      filled: book.settings[doc],
      detail: doc === 'characters' || book.settings[doc] ? counted[doc] ?? '' : '待生成',
    })),
    {
      key: 'outline' as const,
      label: '情节大纲',
      relPath: outlinePath,
      filled: isOutlineFilled(outline),
      detail: isOutlineFilled(outline) ? `覆盖到第 ${coverage} 章` : '待生成',
    },
  ];

  // 「状态截至第 3 章」（四期，D15）：当前状态写到哪一章了，写下一章前一眼看得出跟没跟上。
  const characterLeaves = characters.map<ProjectFileNode>((card) => ({
    kind: 'file',
    label: card.name,
    relPath: card.relPath,
    detail: [
      ...card.tags,
      ...(card.aliases.length > 0 ? [`别名 ${card.aliases.join('/')}`] : []),
      ...(describeStateThrough(card.stateThrough) ? [describeStateThrough(card.stateThrough)] : []),
    ].join(' · '),
  }));

  // 设定行的副标题是一句话简介（没写就是正文第一句，再没有才是关键词）：几百条的名录里，
  // 一眼要看出它是什么，关键词帮不上这个忙。
  const loreLeaves = lore.map<ProjectFileNode>((entry) => ({
    kind: 'file',
    label: entry.title,
    relPath: entry.relPath,
    detail: loreBrief(entry) || entry.keywords.join('/'),
  }));

  // 设定名录（views/lore.ts）：已建条目补出现章与待整合，未建条目单列一组；还没写的几章要用、却还是空的
  // 设定（待完善）也单列一组。
  const loreIndex = await buildLoreIndex(project, { plots, entries: lore, cards: characters }, { thin: true });
  const loreByEntry: Record<string, LoreSummary> = {};
  for (const record of loreIndex.known) {
    loreByEntry[record.entry.relPath] = {
      chapters: record.chapters,
      detail: describeSpan(record.chapters),
      updatedThrough: record.entry.updatedThrough ?? 0,
      pending: pendingChapters(record),
      keywords: record.entry.keywords,
    };
  }
  const loreUnfiled: LoreUnfiledEntry[] = loreIndex.unknown.map((item) => ({
    name: item.name,
    category: item.category,
    chapters: item.chapters,
    detail: `${item.chapters.length} 章 · 第 ${item.chapters[0]} 章起`,
  }));
  const loreThin: LoreThinEntry[] = loreIndex.thin.map((item) => ({
    name: item.name,
    category: item.category,
    ...(item.relPath ? { relPath: item.relPath } : {}),
    kind: item.kind,
    chapters: item.chapters,
    detail: `第 ${item.first} 章起要用 · ${THIN_LORE_LABEL[item.kind]}`,
    ...(item.authored ? { authored: true as const } : {}),
  }));

  // 出场人物索引：已建卡的补出场统计，未建卡的单列一组。
  // 与角色树分开——那是文件树，这些人还没有文件。
  // 细纲复用流水线那一趟读到的列表：同一次刷新里这已经是第三个要它的人了。
  const castIndex = await buildCastIndex(project, plots);
  const castByCard: Record<string, CastSummary> = {};
  for (const member of castIndex.known) {
    if (!member.card) {
      continue;
    }
    const updatedThrough = member.card.updatedThrough ?? 0;
    castByCard[member.card.relPath] = {
      plots: member.plots,
      detail: describePlots(member.plots),
      updatedThrough,
      // 上次更新之后又出场了几章——角色行上的「有新内容可更新」提示吃这个数。
      pending: member.plots.filter((n) => n > updatedThrough).length,
    };
  }
  const cast: CastEntry[] = castIndex.unknown.map((member) => ({
    name: member.name,
    aliases: member.aliases,
    plots: member.plots,
    detail: describePlots(member.plots),
  }));

  const bySlug = new Map(characters.map((c) => [c.slug, c]));
  const castConflicts: CastConflictView[] = castIndex.conflicts.map((conflict) => ({
    name: conflict.name,
    kind: conflict.kind,
    cards: conflict.slugs
      .map((slug) => bySlug.get(slug))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ name: c.name, relPath: c.relPath })),
  }));
  reportConflicts(project.root, castConflicts);

  // 定稿只算**有正文**的章：还没写的章无从定稿，算进来会让顶部黄条报一个
  // 永远清不掉的待办数。
  const written = plotRows.filter((p) => p.chapterPath && p.wordCount > 0);
  const staleCount = written.filter((p) => p.stale).length;
  // 未解决的失败记录，一次查询拿全部（按 relPath 索引，各区共用一张表）。
  // 库不可用时是空对象——工程页照常渲染，只是没有感叹号。
  const failures = await listActiveFailures(project);
  const bookStage = deriveBookStage(book);
  // 空状态（W12）说的「下一步」：与对话页主按钮在全书那一档给的同一步。
  const next = await bookStepView(bookStage, book, {
    config: () => pipelineIndex.config,
    plotPathOf: (no) => rows.find((r) => r.no === no)?.plot.relPath ?? project.plotPathOfNo(no),
  });
  // 「新章落这里」与真正的落点同一个函数：接在最后一章之后的那一章落进哪个子目录。
  const after = rows.reduce((max, r) => Math.max(max, r.no), 0) + 1;
  const landing = (await project.subdirForNewChapter(after)).split('/')[0];
  return {
    initialized: true,
    plotCount: plotRows.length,
    chapterCount: chapters.length,
    totalWords: plotRows.reduce((sum, p) => sum + p.wordCount, 0),
    staleCount,
    summarizedCount: written.length - staleCount,
    architecture,
    plots: plotRows,
    volumes: buildVolumes(volumeNames, plotRows, chaptersRoot, landing),
    characters: nest(charactersRoot, characterLeaves, characterDirs),
    lore: nest(loreRoot, loreLeaves, loreDirs),
    cast,
    castByCard,
    loreByEntry,
    loreUnfiled,
    loreThin,
    loreUnrecorded: loreIndex.unrecorded.length,
    castConflicts,
    failures,
    chaptersRoot,
    charactersRoot,
    loreRoot,
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    globalSummaryPath,
    threadsPath,
    // 「叙事线」页签：一条线一行。线上的实际事件都是定稿写进来的：状态按叙事线判到的那一章算（四期的水位，不超过定稿到），
    // 定稿了还没判的章另说「⚠ 第 a–b 章还没判」。
    threads: buildThreadsView(threadBook, finalizedThrough(rows), {
      mark: threadsMarkOf(manifest),
      finalized: finalizedNos(rows),
    }),
    bookStage,
    nextChapterNo: book.nextChapterNo,
    ...(next ? { next } : {}),
    book: {
      ...ideaDefaultsOf(pipelineIndex.config, book.nextChapterNo - 1),
      outlineCoverage: coverage > 0 ? coverage : undefined,
      plotFilledNos: [...book.plotFilledNos],
    },
    paragraphStyle: pipelineIndex.config.paragraphStyle ?? DEFAULT_PARAGRAPH_STYLE,
  };
}

/** 一句话弹窗的默认值：`config.md` 里已经写了的那几样。 */
export function ideaDefaultsOf(config: BookConfig, writtenThrough = 0): IdeaDefaults {
  return {
    idea: config.sections.一句话 ?? '',
    totalChapters: config.totalChapters,
    wordsPerChapter: config.wordsPerChapter,
    configHasContent: Object.values(config.sections).some((v) => hasContent(v)),
    ...(writtenThrough > 0 ? { writtenThrough } : {}),
  };
}

/**
 * 全书那一档的下一步（生成架构 / 情节大纲 / 拆细纲），补上落点与弹窗默认值。
 *
 * 对话页的主按钮（`controller/chat.ts` 的 `bookNextStep`）与工程页的空状态（W12）共用
 * 这一份，两处说的是同一步、同一句话（第 20 条：只推一个下一步）。判据在纯函数层
 * （`deriveBookNextStep`），这里只补落点：
 *
 * - 架构、大纲两档：纯函数自己给了 target；小说配置那一步还要一句话弹窗的默认值。
 * - 拆细纲那一档：落在区间第一章的细纲上（已有空壳就用它，否则用它应该在的位置）。
 * - 在写、写完了：undefined——那时的下一步是单章状态机的事。
 */
export async function bookStepView(
  stage: BookStage,
  facts: BookFacts,
  at: { config(): BookConfig | Promise<BookConfig>; plotPathOf(no: number): string | Promise<string> }
): Promise<NextStepView | undefined> {
  const step = deriveBookNextStep(stage, facts);
  if (!step) {
    return undefined;
  }
  if (step.form === 'idea') {
    return { ...step, target: step.target!, formDefaults: ideaDefaultsOf(await at.config()) };
  }
  if (step.target) {
    return { ...step, target: step.target };
  }
  const no = step.range?.from ?? facts.nextChapterNo;
  return { ...step, target: { kind: 'plot', plotRelPath: await at.plotPathOf(no) }, no };
}

/**
 * 一章流水线的完整视图（创作页的流水线条）。
 *
 * 与 `buildPlotSummaryView` 同一套取舍：数据小、只在切目标时取一次，
 * 所以单独一条消息，不塞进每次文件变动都全量重推的 `ProjectTree`。
 *
 * 传的是**细纲路径**（可能还不存在）或**章节路径**，都认到同一章：章节路径就是那一章、细纲是它的
 * 镜像；细纲路径按 `resolvePlot` 认这一章现在的那一份。
 * 两边都没有时给一份空壳（「写第 N 章细纲」）——作者可能刚把它改了名，
 * 界面该显示「它还没有」而不是崩掉。
 */
export async function buildPlotPipelineView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotPipelineView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const plot = direct ? await project.plotOfChapter(direct) : await project.resolvePlot(plotRelPath);
  const p = await buildPlotPipeline(
    project,
    { no, plot, chapter: direct ?? chapterOfPlotNo(chapters, no) },
    { chapters }
  );
  return {
    plotRelPath: p.plot.relPath,
    no: p.no,
    title: p.title,
    plot: p.plot,
    chapter: p.chapter,
    summary: p.summary,
    stage: p.stage,
    progress: p.progress,
  };
}

/**
 * 冲突进日志。前端也会显示一条，但日志才是事后能翻的地方——
 * 「上周那批出场统计怎么会错」只有这里答得上。
 */
function reportConflicts(root: string, conflicts: CastConflictView[]): void {
  const signature = conflicts.map((c) => `${c.kind}:${c.name}:${c.cards.map((x) => x.relPath).join(',')}`).join('|');
  if (signature === (lastConflictSignature.get(root) ?? '')) {
    return;
  }
  lastConflictSignature.set(root, signature);
  if (conflicts.length === 0) {
    return;
  }
  log.warn(
    `${conflicts.length} 个称呼被多张角色卡同时声明，出场统计必然有一张是错的`,
    conflicts
      .map(
        (c) =>
          `「${c.name}」← ${c.cards.map((x) => x.name).join(' / ')}` +
          `（${c.kind === 'name' ? '两张卡的正式名一模一样，多半是同一个人建了两张卡' : '被多张卡当成自己的称呼，出场统计只算给第一张'}）`
      )
      .join('；') + '｜可用角色分组右键的「查找并合并重复角色卡」「清理别名」处理'
  );
}

/**
 * 单章细纲的浮窗视图。工程页鼠标悬停在章节行上时按需取一次。
 *
 * 与 `buildProjectTree` 分开是有意的：细纲正文上千字，而那棵树每次
 * 文件变动都全量重推，把细纲塞进去等于每保存一次正文就多推几百 KB。
 *
 * 传的是**细纲路径或章节路径**（工程页那一行同时代表两者），认到同一章；细纲是正文镜像的那一份。
 *
 * 细纲不存在不是错误——那一章可以还没排、只有作者手写的正文。这时给 `exists: false`，
 * 让前端说清「还没有细纲」，而不是弹一个空浮窗或报错。没定稿的细纲是计划（`finalized: false`），
 * 定稿过、正文后来又改过的标过期。
 */
export async function buildPlotSummaryView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotSummaryView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const chapter = direct ?? chapterOfPlotNo(chapters, no);
  const plot = chapter ? await project.plotOfChapter(chapter) : await project.getPlot(no);
  const title = plot?.title || chapter?.title || '';
  const label = chapterLabel(no, title);

  if (!plot) {
    return {
      no,
      title,
      label,
      exists: false,
      finalized: false,
      stale: false,
      relPath: '',
      sections: [],
      emptyHint: chapter
        ? '这一章还没有细纲。右键「同步」可以照正文整理一份。'
        : '这一章还没有细纲。',
    };
  }
  // 与 staleChapters() / buildProjectTree 同一套判据：以 sourceHash 为准。
  // 正文没了（细纲成了孤儿）也算过期——浮窗里那句提示总比默认「新鲜」诚实。
  const finalized = !!plot.sourceHash;
  const stale = finalized && (!chapter || plot.sourceHash !== chapter.contentHash);

  // 没内容的小节（占位文字读回来就是空串）在浮窗里是纯噪声，滤掉。
  const sections = PLOT_SECTION_KEYS.map((name) => ({ name: name as string, text: plot.sections[name].trim() })).filter(
    (s) => s.text !== ''
  );

  // 一个小节都没认出来（作者手改细纲、把 `## 小节名` 全删了改成大白话）时
  // 退回细纲全文，总比给一个空浮窗好。只在「一个小节标题都没有」时才退：小节都在、
  // 只是内容全是占位的，那就是一份货真价实的空细纲，退回全文只会把八行「（待补充）」摊在浮窗里。
  const body = stripH1(plot.body.trim()).trim();
  if (sections.length === 0 && !/^#{2,3}\s/m.test(body) && body !== '') {
    sections.push({ name: '细纲', text: body });
  }
  return { no, title, label, exists: true, finalized, stale, relPath: plot.relPath, sections };
}

/**
 * 「章节」页签的分卷（2026-10-23）。卷按卷里最小的章号排——章号全书连续，卷的先后跟着章走；还空着的卷排在最后
 * （`listVolumes` 的顺序），作者刚建的那一卷就在底下。直接放在章节根下的章是「未分卷」一段（`name` 为空），
 * 照它的章号排。只有细纲、`chapters/` 下还没有那个目录的卷（拆了细纲、正文还没写）也算一卷。
 *
 * 一卷都没有（`chapters/` 下没有目录、章全在根下）就是空数组，页签照旧平铺。`landing` 是新章落进的那一卷。
 */
function buildVolumes(names: string[], rows: ProjectPlotNode[], chaptersRoot: string, landing: string): VolumeView[] {
  const spans = new Map<string, { from: number; to: number; words: number }>();
  for (const r of rows) {
    const span = spans.get(r.volume);
    if (span) {
      span.from = Math.min(span.from, r.no);
      span.to = Math.max(span.to, r.no);
      span.words += r.wordCount;
    } else {
      spans.set(r.volume, { from: r.no, to: r.no, words: r.wordCount });
    }
  }
  const filled = [...spans.keys()].sort((a, b) => spans.get(a)!.from - spans.get(b)!.from);
  const empty = names.filter((n) => !spans.has(n));
  if (empty.length === 0 && filled.every((n) => n === '')) {
    return [];
  }
  return [...filled, ...empty].map((name) => ({
    name,
    relPath: name ? `${chaptersRoot}/${name}` : chaptersRoot,
    ...(spans.has(name) ? { from: spans.get(name)!.from, to: spans.get(name)!.to } : {}),
    words: spans.get(name)?.words ?? 0,
    latest: name === landing,
  }));
}

/**
 * 把扁平的文件清单按 relPath 折成目录树。
 *
 * `dirs` 是磁盘上实际存在的子目录（含空目录）——作者刚建好卷目录还没
 * 往里写东西时，树上也该看得见，否则「新建文件夹」点完像是什么都没发生。
 *
 * 每层内目录在前、文件在后；章节每层内正序（第 1 章在上），
 * 角色/设定保持传入顺序（已按拼音排好）。
 */
function nest(root: string, leaves: ProjectNode[], dirs: string[]): ProjectNode[] {
  const dirNodes = new Map<string, ProjectDirNode>();

  /** 建出某个目录及其所有祖先，返回它。relPath 为 root 时返回 undefined（根不是节点）。 */
  const ensureDir = (relPath: string): ProjectDirNode | undefined => {
    if (relPath === root || !relPath.startsWith(`${root}/`)) {
      return undefined;
    }
    const existing = dirNodes.get(relPath);
    if (existing) {
      return existing;
    }
    const node: ProjectDirNode = {
      kind: 'dir',
      label: relPath.slice(relPath.lastIndexOf('/') + 1),
      relPath,
      children: [],
      fileCount: 0,
    };
    dirNodes.set(relPath, node);
    return node;
  };

  for (const dir of dirs) {
    ensureDir(dir);
  }
  // 叶子所在目录可能不在 dirs 里（listFolders 与文件扫描各读一次盘，
  // 中间目录被删掉时会对不上）——按需补出来，不让文件凭空消失。
  for (const leaf of leaves) {
    const parent = leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/'));
    for (const ancestor of ancestorsOf(parent, root)) {
      ensureDir(ancestor);
    }
  }

  const topLevel: ProjectNode[] = [];
  const attach = (node: ProjectNode, parentPath: string): void => {
    const parent = dirNodes.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      topLevel.push(node);
    }
  };

  // 先挂目录（浅的在前，保证父目录已建好），再挂文件。
  for (const relPath of [...dirNodes.keys()].sort(byDepthThenName)) {
    const node = dirNodes.get(relPath)!;
    attach(node, relPath.slice(0, relPath.lastIndexOf('/')));
  }
  for (const leaf of leaves) {
    attach(leaf, leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/')));
  }

  // 每层排序 + 统计子树文件数。
  const finish = (nodes: ProjectNode[]): number => {
    nodes.sort(compareNodes);
    let count = 0;
    for (const node of nodes) {
      if (node.kind === 'dir') {
        node.fileCount = finish(node.children);
        count += node.fileCount;
      } else {
        count += 1;
      }
    }
    return count;
  };
  finish(topLevel);
  return topLevel;
}

/** `a/b/c` 在 root=`a` 下的祖先链：`a/b`、`a/b/c`。 */
function ancestorsOf(dir: string, root: string): string[] {
  if (dir === root || !dir.startsWith(`${root}/`)) {
    return [];
  }
  const out: string[] = [];
  const segments = dir.slice(root.length + 1).split('/');
  let current = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

function byDepthThenName(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-Hans-CN');
}

/**
 * 每层内目录在前、文件在后。
 *
 * 目录按名称排；角色/设定的文件保持传入顺序（已按拼音排好）。
 * 章节不走这里——它是单独的一条扁平列表（`ProjectPlotNode`），按章号排。
 */
function compareNodes(a: ProjectNode, b: ProjectNode): number {
  if (a.kind === 'dir' && b.kind !== 'dir') {
    return -1;
  }
  if (a.kind !== 'dir' && b.kind === 'dir') {
    return 1;
  }
  if (a.kind === 'dir' && b.kind === 'dir') {
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  }
  return 0;
}

/**
 * 定稿到的最后一章：定稿过（细纲上记着 `sourceHash`）、正文还在的章里章号最大的那一章；一章都没有是 0。
 * 定稿之后正文又改过的也算——那一章的叙事线事件是定稿那一次记下的，还在线上。
 */
function finalizedThrough(rows: readonly { no: number; summary: { exists: boolean }; chapter: { exists: boolean } }[]): number {
  return Math.max(0, ...finalizedNos(rows));
}

/** 定稿过、正文还在的章号（同 {@link finalizedThrough} 的口径）：叙事线「还没判」的那几章从这里面挑（四期）。 */
function finalizedNos(rows: readonly { no: number; summary: { exists: boolean }; chapter: { exists: boolean } }[]): number[] {
  return rows.filter((r) => r.summary.exists && r.chapter.exists).map((r) => r.no);
}
