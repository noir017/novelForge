/**
 * 工作区卡的内容：**当前这一层的产物本身**。
 *
 * 与 [pipeline.ts](pipeline.ts) 同级同类——那边聚合「这一章走到哪一步了」，
 * 这边取出「我现在正在改的那份东西写了什么」。取数在这里，判断在纯函数层。
 *
 * ## 为什么需要它
 *
 * 作者看不见自己正在改的细纲写了什么——那些都在磁盘上，要看只能去开文件。
 * 于是流水线在界面上只剩下几个百分比，像个进度报表，而不是一个工作台。
 *
 * ## 正文层给的是细纲，不是正文
 *
 * 写正文时最常回头看的是「这一章要落实哪几件事、看点落在哪」——所以正文层的
 * 卡片摊的是本章细纲的各节，外加字数与目标。正文本身上万字，塞进浮窗读不下去，
 * 真要读，「打开」按钮就在旁边。大纲同理只给预览——它可能有几千字。
 */
import { scoped } from '../runtime/logger';
import { basename } from 'node:path';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, parsePlotFileName, plotContentHash } from '../model/plotFile';
import { SETTING_SECTION_KEYS } from '../model/settingFile';
import { hasContent, pickSections } from '../model/markdown';
import { LORE_BODY_KEYS, LORE_HIDDEN_KEY, loreThin, splitLoreHidden } from '../model/loreFile';
import { outlineUpstreamHash } from '../model/outlineFile';
import {
  CreationTarget,
  SETTING_DOC_LABEL,
  STAGE_LABEL,
  describeTarget,
  describeThinLore,
  describeThreadReminders,
  plotLabel,
  stageOfTarget,
  unrecordedBefore,
} from '../model/pipeline';
import { chapterOfPlotNo } from './pipeline';
import { thinLoreFor } from './lore';
import { threadReminders } from './threads';
import { loreEntryAt } from './loreMaterial';
import { WorkbenchSection, WorkbenchView } from '../protocol';

const log = scoped('工作区');

/** 大纲预览最多摊这么多字。再多就该去开文件了。 */
const OUTLINE_PREVIEW = 400;

/**
 * 当前目标那一层的产物。
 *
 * **绝不抛**：作者可能刚把某一章改名或删掉，而界面上的 target 还指着它。
 * 那种时候给一张「找不到」的卡，比让整条推送失败强。
 */
export async function buildWorkbench(
  project: NovelProject,
  target: CreationTarget
): Promise<WorkbenchView> {
  try {
    return await build(project, target);
  } catch (err) {
    log.warn('工作区卡取数失败', String(err));
    const stage = stageOfTarget(target);
    return { stage, title: STAGE_LABEL[stage], layer: STAGE_LABEL[stage], relPath: '', sections: [] };
  }
}

async function build(project: NovelProject, target: CreationTarget): Promise<WorkbenchView> {
  if (target.kind === 'setting') {
    const label = SETTING_DOC_LABEL[target.doc];
    if (target.doc === 'characters') {
      const cards = await project.listCharacters();
      return {
        stage: 'setting',
        title: `架构 · ${label}`,
        layer: label,
        relPath: project.relPath(project.charactersDir),
        sections: cards.length > 0 ? [{ key: '角色', text: cards.map((c) => c.name).join('、') }] : [],
        empty: cards.length > 0 ? undefined : '还没有角色卡。按前提排出主角、盟友与对手。',
      };
    }
    // 设定清单同理：没有自己的文件，卡上按分类（目录）列出已有的条目名。
    if (target.doc === 'lore') {
      const entries = await project.listLore();
      const byCategory = new Map<string, string[]>();
      for (const e of entries) {
        const list = byCategory.get(e.category) ?? byCategory.set(e.category, []).get(e.category)!;
        list.push(e.title);
      }
      return {
        stage: 'setting',
        title: `架构 · ${label}`,
        layer: label,
        relPath: project.relPath(project.loreDir),
        sections: [...byCategory].map(([category, titles]) => ({ key: category || '未分类', text: titles.join('、') })),
        empty: entries.length > 0 ? undefined : '还没有设定条目。把世界观里点到的地点、势力、能力体系、关键物品排成一份清单。',
      };
    }
    const doc = await project.readSettingDoc(target.doc);
    const sections = sectionsOf(doc.sections, SETTING_SECTION_KEYS[target.doc]);
    return {
      stage: 'setting',
      title: `架构 · ${label}`,
      layer: label,
      relPath: doc.relPath,
      sections,
      empty: sections.length > 0 ? undefined : `还没有${label}。`,
    };
  }

  if (target.kind === 'outline') {
    const text = await project.readOutline();
    return {
      stage: 'outline',
      title: '情节大纲',
      layer: '情节大纲',
      relPath: project.relPath(project.outlinePath),
      sections: text.trim() ? [{ key: '大纲', text: clip(text, OUTLINE_PREVIEW) }] : [],
      empty: text.trim() ? undefined : '这部书还没有情节大纲。按章号区间把全书的走向排出来。',
    };
  }

  // 单条设定（展开，完善设定 2026-10-19）：卡上摊这一条的一句话与各节（暗设也摊——作者自己看，不进写正文的上下文）。
  if (target.kind === 'lore') {
    const { entry, exists } = await loreEntryAt(project, target.relPath);
    const { visible, hidden } = splitLoreHidden(entry.body);
    const picked = pickSections(visible, LORE_BODY_KEYS);
    // 还只有一句话的（空的、占位、三节全是「（未交代）」）正文不摊：摊出来全是空话。
    const thin = exists ? loreThin(entry) : 'empty';
    const body = thin
      ? []
      : LORE_BODY_KEYS.some((k) => hasContent(picked[k]))
        ? sectionsOf(picked, LORE_BODY_KEYS)
        : [{ key: '正文', text: visible }];
    const sections: WorkbenchSection[] = [
      ...(entry.brief.trim() ? [{ key: '一句话', text: entry.brief.trim() }] : []),
      ...body,
      ...(hidden ? [{ key: LORE_HIDDEN_KEY, text: hidden }] : []),
    ];
    return {
      stage: 'setting',
      title: describeTarget(target, { title: entry.title }),
      layer: '设定条目',
      relPath: exists ? entry.relPath : '',
      sections,
      empty: !exists
        ? '还没有这条设定（文件不在了，可能刚被改名或删除）。'
        : sections.length === 0
          ? '这条设定还只有一句话。打 /展开 按已排的细纲把它往前想细。'
          : undefined,
    };
  }

  const no = parsePlotFileName(basename(target.plotRelPath))?.no ?? 0;
  const plot = await project.resolvePlot(target.plotRelPath);
  const chapter = no > 0 ? chapterOfPlotNo(await project.listChapters(), no) : undefined;
  const head = plotLabel(no, plot?.title || chapter?.title);

  if (target.kind === 'plot') {
    if (!plot) {
      return {
        stage: 'plot',
        title: `细纲 · ${head}`,
        layer: STAGE_LABEL.plot,
        relPath: chapter?.relPath ?? '',
        sections: [],
        empty: chapter ? '这一章已经有正文了，但还没有细纲。' : '这一章还没排细纲。',
      };
    }
    const sections = sectionsOf(plot.sections, PLOT_SECTION_KEYS);
    const outline = await project.readOutline();
    return {
      stage: 'plot',
      title: `细纲 · ${head}`,
      layer: STAGE_LABEL.plot,
      relPath: plot.relPath,
      sections,
      // 上游变更在这里是一句人话，不只是流水线条上那个 ⟳。作者正在看这一章，
      // 此刻正是告诉他「它依据的大纲已经改了」最有用的时机。
      warning:
        plot.upstreamHash && outlineUpstreamHash(outline, plot.no) !== plot.upstreamHash
          ? '情节大纲里覆盖这一章的那一节在细纲之后改过，两者可能已经对不上。'
          : undefined,
      // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
      empty: sections.length > 0 ? undefined : '这一章还没排细纲。',
    };
  }

  // 正文层：摊细纲各节 + 篇幅。见文件头。
  const book = await project.readBookConfig();
  const words = chapter?.wordCount ?? 0;
  const goal = plot?.targetWords ?? book.wordsPerChapter;
  // 与 pipeline.ts 同一条判据：记录过、且现在对不上，才算脏。没记录过
  // （正文是作者自己写的）不标脏——凭空的过期标记比不标更糟。
  const stale = !!chapter && !!plot?.writtenFrom && plotContentHash(plot) !== plot.writtenFrom;
  // 写前提醒（完善设定三期）：还没写的这一章细纲点名、却还只有一句话的设定。零调用、不拦、不进主按钮（第 20 条）；
  // 口径就是「待完善」（没定稿、也还没写正文的细纲），所以已经写了字的章不提。「设定」一节空着就不读设定区。
  const thin =
    plot && !plot.sourceHash && words === 0 && (plot.lore?.length ?? 0) > 0 ? await thinLoreFor(project, [plot.no]) : [];
  // 叙事线提醒（二期）：伏笔逾期、线断了——同一个口径，还没写的章才提（写前检查）。零调用、不拦。
  const threads = no > 0 && words === 0 ? await threadReminders(project, [no]) : undefined;
  const notice = [
    thin.length > 0 ? describeThinLore('本章', thin.map((t) => t.name)) : '',
    threads ? describeThreadReminders('本章', threads.reminders, unrecordedBefore(threads.through, no)) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    stage: 'manuscript',
    title: `正文 · ${head}`,
    layer: STAGE_LABEL.manuscript,
    relPath: chapter?.relPath ?? '',
    sections: [
      {
        key: '篇幅',
        text: words === 0 ? '还没有正文' : goal ? `${words} / 约 ${goal} 字` : `${words} 字`,
      },
      ...(goal ? [] : [{ key: '目标篇幅', text: '细纲与配置里都没写，所以有正文就算写够' }]),
      ...(plot ? sectionsOf(plot.sections, PLOT_SECTION_KEYS) : []),
    ],
    warning: stale ? '这一章的细纲在正文写完（或定稿）之后改过，现有正文可能已经与它对不上。' : undefined,
    ...(notice ? { notice } : {}),
    empty: plot ? undefined : '这一章没有细纲，写正文时模型只能照着前文往下编。',
  };
}

/** 非空小节 → 卡片条目。空小节与占位文字都不显示：卡片是给人看的，不是表单。 */
function sectionsOf(
  sections: Record<string, string>,
  keys: readonly string[]
): WorkbenchSection[] {
  const out: WorkbenchSection[] = [];
  for (const key of keys) {
    const text = (sections[key] ?? '').trim();
    if (text && text !== '（待补充）' && text !== '(待补充)') {
      out.push({ key, text });
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
