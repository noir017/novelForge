import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { isMarkdownPath, parseChapterFileName } from '../model/chapterFile';
import { exists, hash, readText, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { plannedFor } from '../model/threadFile';
import { kindOfPath, normalizeRel } from '../workspace/kind';
import { WsConflictError, WsError, isProtectedPath } from '../workspace/guard';
import { trashPathFor } from '../workspace';
import { Workspace } from '../workspace';

const log = scoped('文件');

/**
 * 工程页的类文件操作：新建文件夹、重命名、移动、删除。
 *
 * 三条硬约束：
 *
 * 1. **不越界**：每个操作都锁在它所属的区（chapters/ 、characters/ 、lore/）里。
 *    章节挪不进角色目录，任何路径也出不了工程根——`..` 一律拒绝。
 * 2. **不静默覆盖**：目标已存在就报错退出，绝不覆盖作者的文件。
 * 3. **不真删**：删除是搬进 `.novelforge/.trash/`，与会话删除同一套做法。
 *
 * 章节改名/移动时，`drafts/` 里对应的草稿与 `summaries/` 里对应的细纲一并搬走（由网关的
 * chapter handler 做）——两样都不是可管理区，但位置都由章节路径推导，章节动了就必须跟着动。
 *
 * **细纲走另一条路**（见下面的 `renamePlot` / `deletePlot`）：它镜像正文的路径，改名改的是标题——
 * 还没有正文时文件名跟着标题、章号前缀不动，有正文时文件名跟着正文不动，那不是「改个文件名」能表达的事。
 */

/** 三个可管理的区。每个区有自己的根目录，操作不跨区。 */
export type Section = 'chapters' | 'characters' | 'lore';

export interface SectionInfo {
  section: Section;
  /** 该区根目录的工作区相对路径。 */
  root: string;
  /** 该区根目录的绝对路径。 */
  rootAbs: string;
  label: string;
}

export function sectionRoots(project: NovelProject): SectionInfo[] {
  return [
    { section: 'chapters', root: project.relPath(project.chaptersDir), rootAbs: project.chaptersDir, label: '章节' },
    {
      section: 'characters',
      root: project.relPath(project.charactersDir),
      rootAbs: project.charactersDir,
      label: '角色',
    },
    { section: 'lore', root: project.relPath(project.loreDir), rootAbs: project.loreDir, label: '设定' },
  ];
}

/** 某个相对路径属于哪个区。不在任何区里（或越界）时返回 undefined。 */
export function sectionOf(project: NovelProject, relPath: string): SectionInfo | undefined {
  const normalized = normalizeRel(relPath);
  if (normalized === undefined) {
    return undefined;
  }
  return sectionRoots(project).find((s) => normalized === s.root || normalized.startsWith(`${s.root}/`));
}

/**
 * 「在这个目录里新建」的落点收敛：给定的目录必须落在该区内，
 * 否则退回区根目录。新建类流程都经这里，`dir` 越界不会把文件写到工程外面去。
 */
export function resolveSectionDir(project: NovelProject, section: Section, dir?: string): string {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  return resolveDirWithin(info, dir) ?? info.root;
}

/**
 * 把用户/前端给来的相对路径收敛为「工程内的、用正斜杠的」相对路径。
 * 绝对路径、`..` 逃逸、空路径一律返回 undefined。
 *
 * 实现搬进了 `workspace/kind.ts`（网关的第一条守卫要用同一份口径），
 * 这里保留导出名，调用方不动。
 */
export { normalizeRel };

/**
 * 工程的固定目录：改名/搬走会让工程结构散架（章节索引、草稿镜像、
 * 元数据与会话）。文件页的根范围操作对这些路径一律拒绝。
 *
 * 实现搬进了 `workspace/guard.ts`（守卫第 3 条），这里保留导出名。
 */
export { isProtectedPath };

// ---------------------------------------------------------------- 新建文件夹

/**
 * 在某个区里新建文件夹。`parentRel` 缺省为该区根目录。
 * 返回新目录的相对路径；用户取消或失败返回 undefined。
 */
export async function newFolder(
  project: NovelProject,
  section: Section,
  parentRel?: string
): Promise<string | undefined> {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  const parent = resolveDirWithin(info, parentRel) ?? info.root;

  const name = await getHost().input({
    title: '新建文件夹',
    prompt: `在 ${parent}/ 下新建文件夹`,
    placeHolder: '如「第一卷」',
    validate: (v) => validateName(v),
  });
  if (!name) {
    return undefined;
  }

  const rel = `${parent}/${sanitizeFileName(name)}`;
  // 经网关建（第 7 条）：落点过守卫——出不了工程根、建不进回收站 / 会话目录 / 历史版本；已有同名（目录或文件）就拒绝。
  try {
    await new Workspace(project).mkdir(rel);
  } catch (err) {
    const why = err instanceof WsError && err.code === 'exists' ? `已存在：${rel}` : describeWsError(err);
    log.warn(`新建文件夹被拒：${why}`, rel);
    getHost().toast(why, 'error');
    return undefined;
  }
  log.info(`已新建文件夹 ${rel}`);
  getHost().toast(`已新建文件夹 ${rel}`);
  return rel;
}

// ---------------------------------------------------------------- 细纲
//
// 细纲**不是**可管理区：它镜像正文的相对路径（`summaries/第一卷/003-深处.md` 跟着
// `chapters/第一卷/003-深处.txt`），还没有正文时文件名由「章号 + 标题」决定。挪到别处它就与正文
// 对不上了，所以改名与删除绕开 resolveTarget 那套区守卫，交给网关的领域写入器做；也没有
// 「移动到…」——搬正文时它自己跟着走（`handlers/chapter.ts` 的 `carryPlot`）。

/**
 * 这个路径是不是一份细纲。工程页的 rename/move/delete 据此分流。
 *
 * 判定在 `workspace/kind.ts` 的种类表里，这里只转发。
 */
export function isPlotPath(project: NovelProject, relPath: string): boolean {
  return kindOfPath(project, relPath).kind === 'plot';
}

/**
 * 重命名一份细纲：改的是**标题**，返回它（可能变了的）路径。
 *
 * - **还没有正文**：章号前缀由 `writePlot` 保留，文件名跟着新标题走。手工新建的细纲是纯序号名
 *   （`007.md`，标题要等细纲排完才定），所以这条路也是「给这一章起个名字」的第一次命名入口。
 * - **这一章已经有正文**：细纲镜像正文的路径，文件名跟着正文**不动**，只换细纲里的标题。
 *   **正文不跟着改名**：那是作者的文件，要改就在章节那一行上改（细纲会跟着正文搬过去）。
 */
export async function renamePlot(project: NovelProject, relPath: string): Promise<string | undefined> {
  const plot = await project.readPlot(relPath);
  if (!plot) {
    log.warn(`重命名被拒：找不到细纲 ${relPath}`);
    getHost().toast('找不到这份细纲，可能刚被改名或删除。', 'error');
    return undefined;
  }
  const mirrored = (await project.listChapters()).some((c) => project.plotPathForChapter(c.relPath) === plot.relPath);

  const input = await getHost().input({
    title: `重命名第 ${plot.no} 章的细纲`,
    prompt: mirrored
      ? `这一章已经有正文，细纲的文件名跟着正文不变，只改标题｜当前：${relPath}`
      : `章号前缀会保留｜当前：${relPath}`,
    value: plot.title,
    validate: (v) => validateName(v),
  });
  if (input === undefined || input.trim() === plot.title) {
    return undefined;
  }

  // 走 workspace.writePlot 而不是 fs.rename：落点由它定（有正文就是正文的镜像，否则由章号与
  // 标题共同决定），旧文件由它清掉。
  const to = await new Workspace(project).writePlot({ ...plot, title: input.trim() });
  await project.syncManifest();
  project.invalidate();
  log.info(`已重命名第 ${plot.no} 章的细纲`, `${relPath} → ${to}`);
  getHost().toast(to === relPath ? `已改标题：${input.trim()}` : `已重命名：${to}`);
  return to;
}

/**
 * 删一章的细纲：搬进 `.trash/`。**正文不受影响。** 它写进叙事线里的那一章的计划事件一起删（网关的 `deletePlot`，第 28 条
 * 「计划事件随细纲走」），确认框上先说有几条（第 3 条：删之前给一个判断的机会）。
 */
export async function deletePlot(project: NovelProject, relPath: string): Promise<boolean> {
  const plot = await project.readPlot(relPath);
  if (!plot) {
    log.warn(`删除被拒：找不到细纲 ${relPath}`);
    getHost().toast('找不到这份细纲，可能刚被改名或删除。', 'error');
    return false;
  }
  const plans = plannedFor(await project.readThreads(), plot.no).length;

  const pick = await getHost().confirm(`删除第 ${plot.no} 章的细纲${plot.title ? `《${plot.title}》` : ''}？`, ['删除'], {
    modal: true,
    detail: [
      // 说出来免得作者以为正文也没了。
      '这一章的正文不受影响。',
      ...(plans > 0 ? [`它写进叙事线里的 ${plans} 条计划（第 ${plot.no} 章）一起删掉，各条线改之前存一版历史。`] : []),
      '会移到 .novelforge/.trash/，可手动找回。',
    ].join('\n'),
  });
  if (pick !== '删除') {
    log.info(`用户取消了删除 ${relPath}`);
    return false;
  }

  await new Workspace(project).deletePlot(relPath);
  await project.syncManifest();
  project.invalidate();
  log.info(`已移到回收站：第 ${plot.no} 章的细纲`, relPath);
  getHost().toast(`已移到回收站：${relPath}${plans > 0 ? `；叙事线里第 ${plot.no} 章的计划一起删了` : ''}`);
  return true;
}

// ---------------------------------------------------------------- 重命名

/**
 * 重命名文件或文件夹。改的是**磁盘上的名字**，不动文件内容——
 * 例外是章节：正文的 `# 标题` 行（见下面 renamedBody 的说明）与跟着搬过去的细纲里的标题（`retitleCarriedPlot`）。
 *
 * 章节文件的 `NNN-` 序号前缀由重命名保留：序号决定全书顺序，
 * 不该在改个标题时被顺手改掉。
 */
export async function renameEntry(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, true);
}

/**
 * 工程根范围的重命名（文件页用）。不再要求路径在三个管理区内，
 * 但固定目录受 isProtectedPath 保护；章节的序号前缀/H1 同步与草稿跟随
 * 在路径确实位于章节区时照常生效。
 */
export async function renameEntryInRoot(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, false);
}

async function renameEntryImpl(
  project: NovelProject,
  relPath: string,
  requireSection: boolean
): Promise<string | undefined> {
  const target = requireSection
    ? await resolveTarget(project, relPath)
    : await resolveTargetInRoot(project, relPath);
  if (!target) {
    return undefined;
  }
  const { abs, rel, isDir } = target;

  const base = path.basename(rel);
  const ext = isDir ? '' : path.extname(base);
  const stem = isDir ? base : base.slice(0, base.length - ext.length);
  const isChapterFile = !isDir && target.info?.section === 'chapters';
  // 章节的序号前缀单独拆出来，让用户只编辑标题部分。
  const prefixMatch = isChapterFile ? /^(\d{1,5}[-_.\s]*)(.*)$/.exec(stem) : null;
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const editable = prefixMatch ? prefixMatch[2] : stem;
  // 序号写进对话框标题：「重命名第 12 章」比「重命名文件」更认得出改的是谁。
  // 未命名的章节（纯序号名 `007.md`）走的正是这条路，那时 editable 是空串，
  // 对话框等于「给这一章起个名字」——流水线新建之后的第一次命名。
  const order = isChapterFile ? parseChapterFileName(base)?.order : undefined;

  const input = await getHost().input({
    title: order !== undefined ? `重命名第 ${order} 章` : isDir ? '重命名文件夹' : '重命名文件',
    prompt: prefix ? `序号前缀「${prefix}」会保留` : `当前：${rel}`,
    value: editable,
    validate: (v) => validateName(v),
  });
  if (input === undefined || input.trim() === editable) {
    return undefined;
  }

  const nextStem = sanitizeFileName(input);
  // 序号后面没有分隔符（纯序号名 `007.md`）时补一个 `-`，不然拼出来是
  // `007夜入青云.md`——解析得出来，但与插件自己建章节的命名规矩不一致。
  const sep = prefix && nextStem && !/[-_.\s]$/.test(prefix) ? '-' : '';
  const nextRel = `${path.posix.dirname(rel)}/${prefix}${sep}${nextStem}${ext}`;
  if (nextRel === rel) {
    return undefined;
  }
  // 先改内容再改名：改名成功后内容一定是对的，反过来则可能留下半吊子状态。
  // 用清洗后的 nextStem 而不是用户原样输入，H1 才会继续与文件名一致，
  // 下次改名时仍然认得出「这个 H1 是跟着文件名走的」。
  //
  // 只对 markdown 家族做：.txt 章节的标题本来就只取文件名，往里写一行 `# x`
  // 是凭空多出来的 markdown 痕迹；.json 章节则是直接写坏文件。
  //
  // 经网关写（覆盖之前旧内容先存一版历史、大小守卫照过），不弹覆盖审阅：新名字是作者刚在输入框里起的。
  // chapter handler 写完只同步 manifest，**不碰这一章细纲上的 `writtenFrom`**——那一环只在生成落盘时由
  // `recordWrittenFrom` 记（与编辑器保存正文同一条路），挂着 ⟳ 的章改个名照样挂着（第 18 条）。
  //
  // 不留下「标题改了、文件名没改」的半截（第 3 条），分三道：
  // 1. 写标题之前先问网关搬不搬得成（`checkMove`：与 `move` 同一套守卫，外加细纲那一侧不会撞——细纲要跟着正文改名，
  //    第 8 条），搬不成就什么都不动、直接报错；
  // 2. 网关拒写标题（如正文超过 2 MB）就整个不改名；
  // 3. 写完标题之后 `move` 仍然失败（预检与搬家之间别处刚建了同名文件）：把正文改回原样再报错，改不回去就照实说。
  const ws = new Workspace(project);
  let titled: { body: string; updated: string } | undefined;
  if (!isDir && target.info?.section === 'chapters' && isMarkdownPath(rel)) {
    const body = await readText(abs);
    const updated = renamedBody(body, editable, nextStem);
    if (updated !== body) {
      try {
        await ws.checkMove(rel, nextRel, { plot: true });
        await ws.write(rel, { text: updated }, { mode: 'overwrite', review: false });
      } catch (err) {
        log.warn(`重命名被拒：${describeWsError(err)}`, `${rel} → ${nextRel}`);
        getHost().toast(describeWsError(err), 'error');
        return undefined;
      }
      titled = { body, updated };
      log.debug(`正文里的 # 标题跟着改名同步`, `「${editable}」→「${nextStem}」`);
    }
  }

  // 经网关搬：同名不覆盖、固定目录保护、草稿跟随、manifest 同步都在那一层。
  // 正文的细纲由 `carryPlot` 跟着搬；搬完再把细纲里的标题改成新名（`retitleCarriedPlot`），只认真跟过去的那一份。
  const plotFrom = isChapterFile ? project.plotMirrorOf(rel) : undefined;
  const hadPlot = !!plotFrom && (await exists(project.pathOf(plotFrom)));
  try {
    await ws.move(rel, nextRel);
  } catch (err) {
    const why = describeWsError(err);
    if (titled) {
      const notRestored = await restoreTitle(project, ws, rel, titled.body, titled.updated);
      if (notRestored) {
        log.error(`改名没成，正文的标题行也没能改回「# ${editable}」：${rel}`, `${rel} → ${nextRel}｜${why}｜没改回去：${notRestored}`);
        getHost().toast(
          `改名没成（${why}），${rel} 的标题行也没能改回「# ${editable}」：${notRestored}。请打开它看一眼第一行。`,
          'error'
        );
        return undefined;
      }
      log.warn(`重命名被拒：${why}`, `${rel} → ${nextRel}｜正文的标题行已改回「# ${editable}」`);
    } else {
      log.warn(`重命名被拒：${why}`, `${rel} → ${nextRel}`);
    }
    getHost().toast(why, 'error');
    return undefined;
  }
  log.info(`已重命名${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
  const plotNote = hadPlot ? await retitleCarriedPlot(project, ws, plotFrom!, nextRel, editable, nextStem) : '';
  getHost().toast(`已重命名为 ${nextRel}${plotNote}`);
  return nextRel;
}

/**
 * 章节改名之后，跟着搬过去的细纲把标题也改成新名（`Workspace.retitlePlot`），返回接在提示后面的半句。
 *
 * 工程页那一行先认细纲的标题，只搬文件不改标题，改完名那一行还挂着旧名字。细纲的标题与正文的旧名不一样时
 * 不动（作者在细纲上单独起过）、说出来；细纲没跟过来（新位置已有一份，`carryPlot` 已经报过）就什么都不做。
 * 改标题失败不算改名失败：正文与细纲都已经搬好了，记一条 warn、照实说。
 */
async function retitleCarriedPlot(
  project: NovelProject,
  ws: Workspace,
  plotFrom: string,
  chapterTo: string,
  from: string,
  to: string
): Promise<string> {
  const plotTo = project.plotMirrorOf(chapterTo);
  if (!plotTo || plotTo === plotFrom || (await exists(project.pathOf(plotFrom))) || !(await exists(project.pathOf(plotTo)))) {
    return '';
  }
  try {
    const r = await ws.retitlePlot(plotTo, from, to);
    if (r === 'kept') {
      const title = (await project.readPlot(plotTo))?.title ?? '';
      log.info('细纲的标题是另起的，没跟着正文改名', `${plotTo}｜「${title}」`);
      return `；细纲的标题「${title}」是另起的，没跟着改`;
    }
    if (r === 'retitled') {
      log.info('细纲的标题跟着正文改名', `${plotTo}｜「${from}」→「${to}」`);
    }
    return '';
  } catch (err) {
    log.warn('细纲的标题没能跟着改', `${plotTo}｜${describeWsError(err)}`);
    return `；细纲的标题没能跟着改（${describeWsError(err)}）`;
  }
}

/**
 * 章节改名写完 `# 标题` 行之后搬家没成：把正文改回原样（经网关，不弹审阅）。改回去了给 undefined，否则给一句原因。
 *
 * 只在正文还在原处、而且还是刚才写下去的那一份时改：不在原处说明搬家其实已经把它搬走了，在原处写等于凭空多出一章；
 * 内容变过说明这期间有人改过它，拿改名之前那一版盖回去会吞掉那几笔（第 3 条）——`baseHash` 乐观锁拦住。
 */
async function restoreTitle(
  project: NovelProject,
  ws: Workspace,
  rel: string,
  original: string,
  written: string
): Promise<string | undefined> {
  if (!(await exists(project.pathOf(rel)))) {
    return `${rel} 已经不在原处`;
  }
  try {
    await ws.write(rel, { text: original }, { mode: 'overwrite', review: false, baseHash: hash(written) });
    return undefined;
  } catch (err) {
    return err instanceof WsConflictError ? `这期间它又被改过，没有拿改名之前那一版盖掉` : describeWsError(err);
  }
}

/**
 * 网关的拒绝 → 工程页的一句人话。
 *
 * 逐字保留原来那几条文案：`已存在同名项：X` 是作者最常撞见的一条，
 * 换了措辞他会以为是另一个毛病。
 */
function describeWsError(err: unknown): string {
  if (err instanceof WsError) {
    return err.code === 'exists' ? `已存在同名项：${err.message.replace(/^已存在：/, '')}` : err.message;
  }
  return describeError(err);
}

/**
 * 章节改名时同步正文里的 `# 标题` 行——但**只在它与旧文件名一致时**。
 *
 * 两者一致说明作者从没单独改过标题，把它们继续保持同步是他要的；
 * 一旦不一致，那个 H1 就是作者手写的东西，改名不该动它。
 */
export function renamedBody(body: string, oldTitle: string, newTitle: string): string {
  if (!oldTitle || oldTitle === newTitle) {
    return body;
  }
  const m = /^(\s*)#\s+(.+?)[ \t]*(\r?\n|$)/.exec(body);
  if (!m || m[2].trim() !== oldTitle.trim()) {
    return body;
  }
  return `${m[1]}# ${newTitle}${m[3]}${body.slice(m[0].length)}`;
}

// ---------------------------------------------------------------- 移动

/**
 * 把文件或文件夹移到同区的另一个目录下。
 * `targetDir` 缺省时弹目录选择（含该区根目录）。
 */
export async function moveEntry(
  project: NovelProject,
  relPath: string,
  targetDir?: string
): Promise<string | undefined> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return undefined;
  }
  const { rel, info, isDir } = target;

  let destRel = targetDir === undefined ? undefined : resolveDirWithin(info, targetDir);
  if (targetDir !== undefined && destRel === undefined) {
    log.warn(`移动被拒：目标目录不在「${info.label}」区里`, `${rel} → ${targetDir}`);
    getHost().toast(`目标目录不在「${info.label}」区里：${targetDir}`, 'error');
    return undefined;
  }
  if (destRel === undefined) {
    destRel = await pickDestination(project, info, rel, isDir);
    if (destRel === undefined) {
      return undefined;
    }
  }

  const currentParent = path.posix.dirname(rel);
  if (destRel === currentParent) {
    getHost().toast('已经在这个目录里了。');
    return undefined;
  }
  // 目录不能移进自己的子孙里——那会把这棵子树从文件系统上摘下来。
  if (isDir && (destRel === rel || destRel.startsWith(`${rel}/`))) {
    log.warn(`移动被拒：不能把文件夹移进自己里面`, `${rel} → ${destRel}`);
    getHost().toast('不能把文件夹移动到它自己里面。', 'error');
    return undefined;
  }
  if (!(await exists(project.pathOf(destRel)))) {
    log.warn(`移动被拒：目标目录不存在 ${destRel}`);
    getHost().toast(`目标目录不存在：${destRel}`, 'error');
    return undefined;
  }

  const nextRel = `${destRel}/${path.basename(rel)}`;
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`移动被拒：目标目录里已有同名项 ${nextRel}`);
    getHost().toast(`目标目录里已有同名项：${nextRel}`, 'error');
    return undefined;
  }

  try {
    await new Workspace(project).move(rel, nextRel);
  } catch (err) {
    log.warn(`移动被拒：${describeWsError(err)}`, `${rel} → ${nextRel}`);
    getHost().toast(describeWsError(err), 'error');
    return undefined;
  }
  log.info(`已移动${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
  getHost().toast(`已移动到 ${nextRel}`);
  return nextRel;
}

// 草稿跟随搬进了 `core/workspace/handlers/chapter.ts` 的 `carryDraft`：
// 章节改名/移动经网关走，伴生动作由 handler 做一次，不再在这里各做一份。

async function pickDestination(
  project: NovelProject,
  info: SectionInfo,
  rel: string,
  isDir: boolean
): Promise<string | undefined> {
  const folders = await project.listFolders(info.rootAbs);
  const candidates = [info.root, ...folders].filter(
    // 自己和自己的子孙都不能当落点。
    (dir) => !(isDir && (dir === rel || dir.startsWith(`${rel}/`)))
  );
  const currentParent = path.posix.dirname(rel);
  return getHost().pick(
    candidates.map((dir) => ({
      label: dir === info.root ? `${info.label}（根目录）` : dir.slice(info.root.length + 1),
      description: dir === currentParent ? '当前位置' : undefined,
      detail: dir,
      value: dir,
    })),
    `把「${path.basename(rel)}」移动到`
  );
}

// ---------------------------------------------------------------- 删除

/**
 * 删除文件或文件夹：搬进 `.novelforge/.trash/`，不真删。
 * 目录连同里面的东西整体搬走，垃圾箱里保留原来的相对路径以便找回。
 */
export async function deleteEntry(project: NovelProject, relPath: string): Promise<boolean> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return false;
  }
  const { rel, info, isDir } = target;

  const detail = isDir ? await describeFolder(project, rel) : undefined;
  // 草稿不跟着删——那是作者另写的东西，删正文不代表要连草稿一起丢。
  // 但得说一句，否则「删了这一章」之后草稿还在，下次看见会以为闹鬼。
  const draftNote = await describeDraft(project, rel, info.section);
  const pick = await getHost().confirm(`删除${isDir ? '文件夹' : ''}「${path.basename(rel)}」？`, ['删除'], {
    modal: true,
    detail: [detail, draftNote, '会移到 .novelforge/.trash/，可手动找回。'].filter(Boolean).join('\n'),
  });
  if (pick !== '删除') {
    log.info(`用户取消了删除 ${rel}`);
    return false;
  }

  // 经网关删：搬进 `.trash/` 并保留原相对路径、章节还要 syncManifest，
  // 都在那一层。**草稿不跟着删**（第 10 条）——上面的确认框已经说过了。
  try {
    await new Workspace(project).remove(rel);
  } catch (err) {
    log.warn(`删除被拒：${describeWsError(err)}`, rel);
    getHost().toast(describeWsError(err), 'error');
    return false;
  }
  log.info(`已移到回收站：${rel}`, detail ?? '');
  getHost().toast(`已移到回收站：${rel}`);
  return true;
}

/** 有草稿时在确认框里说一声——它不会跟着删。 */
async function describeDraft(project: NovelProject, rel: string, section: Section): Promise<string | undefined> {
  if (section !== 'chapters') {
    return undefined;
  }
  const draft = project.draftRelPathFor(rel);
  if (!draft || !(await exists(project.pathOf(draft)))) {
    return undefined;
  }
  return `草稿 ${draft} 不会一起删除。`;
}

/** 删文件夹前先说清楚里面有多少东西——整棵子树一起没了不该是个意外。 */
async function describeFolder(project: NovelProject, rel: string): Promise<string> {
  const abs = project.pathOf(rel);
  let files = 0;
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs++;
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        files++;
      }
    }
  };
  await walk(abs, 1);
  if (files === 0 && dirs === 0) {
    return '这个文件夹是空的。';
  }
  return `里面有 ${files} 个文件${dirs > 0 ? `、${dirs} 个子文件夹` : ''}，会一并移走。`;
}

// 垃圾箱落点的计算（trashPathFor）在数据层（`model/project.ts`），由 `core/workspace/` 重新导出：删除一律经网关、
// 会话删除也用它，「保留原相对路径、同名加序号」这条规则只该有一份。
export { trashPathFor };

// ---------------------------------------------------------------- 内部工具

interface ResolvedTarget {
  abs: string;
  rel: string;
  info: SectionInfo;
  isDir: boolean;
}

/** 解析操作对象：必须存在、必须在某个区里、且不能是区的根目录本身。 */
async function resolveTarget(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  const info = sectionOf(project, rel);
  if (!info) {
    log.warn(`操作被拒：${rel} 不在章节/角色/设定三个区里`);
    getHost().toast('只能操作章节、角色、设定目录里的内容。', 'error');
    return undefined;
  }
  if (rel === info.root) {
    log.warn(`操作被拒：${rel} 是「${info.label}」区的固定根目录`);
    getHost().toast(`「${info.label}」是工程的固定目录，不能重命名或删除。`, 'error');
    return undefined;
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能刚被改名或删除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  return { abs, rel, info, isDir };
}

/** 根范围解析：路径合法、不是固定目录、存在即可（不要求在三区内）。 */
async function resolveTargetInRoot(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`操作被拒：${rel} 是工程的固定目录`);
    getHost().toast(`「${rel}」是工程的固定目录，不能改名或搬走。`, 'error');
    return undefined;
  }
  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能刚被改名或删除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  // 区外路径 info 为 undefined：下游用 `target.info?.section` 守卫。
  const info = sectionOf(project, rel);
  return { abs, rel, info: info as SectionInfo, isDir };
}

/** 把一个「目录相对路径」收敛到某个区内；不在区里返回 undefined。 */
function resolveDirWithin(info: SectionInfo, dirRel?: string): string | undefined {
  if (dirRel === undefined || dirRel.trim() === '') {
    return info.root;
  }
  const rel = normalizeRel(dirRel);
  if (!rel) {
    return undefined;
  }
  return rel === info.root || rel.startsWith(`${info.root}/`) ? rel : undefined;
}

export function validateName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return '不能为空';
  }
  if (/[\\/]/.test(trimmed)) {
    return '名字里不能有斜杠';
  }
  if (trimmed === '.' || trimmed === '..') {
    return '这个名字不能用';
  }
  // sanitizeFileName 会把非法字符全删掉，只剩兜底名——那等于用户什么也没输入。
  if (/^[\\/:*?"<>|\s]+$/.test(trimmed)) {
    return '名字里的字符都不能用于文件名';
  }
  return undefined;
}
