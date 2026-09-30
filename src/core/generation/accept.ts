/**
 * 采纳：把一份产物写进磁盘。按产物种类分派到五条落盘路径。
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
import { NovelProject, emptyCharacterSections } from '../model/project';
import { parsePlotFileName } from '../model/plotFile';
import { CreationTarget, SETTING_DOC_LABEL, plotOfTarget } from '../model/pipeline';
import { Artifact, PlotFields, RosterEntry } from '../features/artifact';
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
      return acceptOutline(project, ws, artifact.text);
    case 'plot':
      return acceptPlot(project, ws, target, artifact);
    case 'manuscript':
      return acceptManuscript(project, ws, target, artifact.text);
    case 'plotBatch':
      // 生成链与批次的落盘随下一个 commit 一起接上；这之前没有任何路径产出它。
      throw new Error('细纲批次还不能落盘。');
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
  return { relPath: rel, message: `已写入 ${rel}` };
}

/**
 * 角色图谱：每人建一张角色卡。
 *
 * **同名（或别名撞上）已存在的一律跳过，绝不覆盖**——作者可能已经把那张卡改得
 * 很细，再生成一次图谱不该把它抹掉。跳过的必须说出来。新卡没有作者写过的内容
 * 可覆盖，所以不走审阅（与「给未建卡的人物新建角色卡」同一口径）。
 */
async function acceptRoster(project: NovelProject, ws: Workspace, entries: RosterEntry[]): Promise<AcceptResult> {
  const cards = await project.listCharacters();
  const taken = new Set(cards.flatMap((c) => [c.name, ...c.aliases, c.slug]));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const slug = sanitizeFileName(entry.name);
    if (taken.has(entry.name) || taken.has(slug)) {
      skipped.push(entry.name);
      continue;
    }
    taken.add(entry.name);
    taken.add(slug);
    created.push(
      await ws.writeCharacter({
        slug,
        name: entry.name,
        aliases: entry.aliases,
        tags: entry.role ? [entry.role] : [],
        sections: { ...emptyCharacterSections(), ...entry.sections },
      })
    );
  }

  const note = skipped.length > 0 ? `，跳过已有的 ${skipped.join('、')}` : '';
  log.info(`角色图谱：新建 ${created.length} 张角色卡`, `${created.join('、') || '（无）'}${note}`);
  return { relPath: created[0], message: `已新建 ${created.length} 张角色卡${note}。` };
}

/** 情节大纲：整篇替换，覆盖前审阅。按区间合并留到二期。 */
async function acceptOutline(project: NovelProject, ws: Workspace, text: string): Promise<AcceptResult> {
  const rel = project.relPath(project.outlinePath);
  const r = await ws.write(rel, { artifact: { kind: 'outlineDoc', text } }, { mode: 'overwrite', what: '情节大纲' });
  if (r.skipped) {
    return { skipped: true, message: '没有改动大纲。' };
  }
  log.info('情节大纲已更新', `${rel}｜${text.length} 字`);
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
    targetWords: fields.targetWords,
    upstreamHash: await plotUpstreamHash(project, relPath),
    done: false,
    sections: fields.sections,
  });
  log.info(`第 ${no} 章的细纲已新建`, rel);
  return { relPath: rel, message: `已新建 ${rel}` };
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
