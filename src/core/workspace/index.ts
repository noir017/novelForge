/**
 * Workspace —— 工程的**唯一读写网关**。
 *
 * ## 为什么要有它
 *
 * 写盘从前散在六处（`model/project.ts`、`features/creation.ts` 的
 * `acceptArtifact`、`files/fileOps.ts`、`files/fileEditing.ts`、
 * `files/projectFiles.ts`、拆章），**每处各带一部分保护，谁也不认识谁**。
 * 既有落盘路径背着一批不变量，绕过任何一条都会安静地损坏工程：
 *
 * - 细纲文件名由「章号 + 标题」决定，改标题要清掉旧文件名
 * - 写细纲要记 `upstreamHash`、写正文要在细纲上记 `writtenFrom`，漏了新鲜度链就断
 * - 删除一律进 `.trash/`；同名目标一律报错退出
 *
 * 所以 `write` 不是「往这个路径写字节」，而是「按这个路径**应有的种类**写一份
 * 合法产物」——种类判定（`kind.ts`）、守卫（`guard.ts`）、渲染/记账/伴生
 * （`handlers/`）在这一层各做一次。
 *
 * ## 记账下沉
 *
 * `upstreamHash` 从前**只在采纳路径上记**。作者在内置编辑器里
 * 改一份细纲，指纹链就断了——那一章从此再也不挂 ⟳。下沉到写入路径本身之后，
 * **谁写都记**。
 *
 * ## 新代码不许绕过这里
 *
 * 不要在别处 `fs.writeFile`。八条守卫（见 `guard.ts`）只在这条路上做，
 * 绕过去等于给自己开一个后门，而后门在界面上看不出来。
 */
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { decodeFileText } from '../model/importText';
import {
  countWords,
  exists,
  hash,
  pad3,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from '../model/fs';
import { Chapter, SummaryCast } from '../model/types';
import { parseMarkdown, replaceSection, rewriteFrontmatter, stringifyFrontmatter } from '../model/markdown';
import { LoreLine, PLOT_LORE_KEY, renderLoreLines } from '../model/loreFile';
import {
  NewThread,
  ThreadsMark,
  advanceThreadsMark,
  renderThreadFile,
  replacePlannedEvents,
  threadFileName,
  threadsMarkOf,
} from '../model/threadFile';
import { setConfigParagraphStyle } from '../model/settingFile';
import type { ParagraphStyle } from '../model/paragraphFormat';
import { isMarkdownExt, isMarkdownPath, parseChapterFileName } from '../model/chapterFile';
import { isFallbackChapterTitle } from '../model/pipeline';
import { endsMidSentence } from '../model/manuscriptCheck';
import {
  NovelProject,
  WritableCharacterCard,
  WritableLoreEntry,
  renderCharacterCard,
  renderLoreEntry,
  trashPathFor,
} from '../model/project';
import {
  PlotSections,
  PreflightOk,
  WritablePlot,
  emptyPlotSections,
  parsePlotFile,
  plotFileName,
  renderPlotFile,
  renderPreflightOk,
} from '../model/plotFile';
import { isOutlineFilled, parseOutline, planOutlineSplit, renderOutlineDoc } from '../model/outlineFile';
import { Artifact } from '../features/artifact';
import {
  ArtifactKind,
  PathKind,
  kindOfPath,
  normalizeRel,
} from './kind';
import {
  MAX_EDITABLE_BYTES,
  WsConflictError,
  WsError,
  guardCopySource,
  guardCreate,
  guardMutate,
  guardRead,
  guardWrite,
  isInternalPath,
  reviewOverwrite,
} from './guard';
import { Handler, HandlerCtx, handlerFor } from './handlers';
import { renderFinalizedPlot } from './handlers/plot';
import { moveHistory, snapshotBeforeWrite, snapshotNow } from './history';
import { SearchOptions, SearchResult, search } from './search';

const log = scoped('工作区');

export interface WsEntry {
  name: string;
  rel: string;
  type: 'file' | 'dir';
  kind: ArtifactKind;
  /** 文本文件给字数，其余给字节数。 */
  words?: number;
  bytes: number;
}

export interface WsFile {
  rel: string;
  text: string;
  hash: string;
  bytes: number;
  kind: ArtifactKind;
  /** 按 offset/limit 截过。**必须说出来**（AGENTS 第 2 条：不静默截断）。 */
  truncated?: { from: number; total: number };
}

export type WriteInput = { text: string } | { artifact: Artifact };

export interface WriteOptions {
  /** 缺省 `create`（同名报错）。 */
  mode?: 'create' | 'overwrite' | 'append';
  /**
   * 覆盖前是否审阅。缺省 true。
   *
   * **agent 路径不允许传 false**——「不静默覆盖」是产品承诺，不是偏好设置
   * （AGENTS 第 3 / 19 条）。留这个开关只给**已经有自己那道闸**的调用方：批量路径（它跳过已有
   * 产物，根本走不到覆盖）、内置编辑器（乐观锁）、`edit` 与 `setParagraphStyle`（改的就是作者点的那几个字），
   * 以及功能层自己问过作者的覆盖（更新角色卡 / 提取角色的审阅采纳、批量更新时的「全部直接采纳」、章节改名时
   * 同步正文的 `# 标题` 行）——同一件事不问第二次。传了 false 照样过守卫、照样存历史版本。
   */
  review?: boolean;
  /** 乐观锁基线。给了就比对，磁盘变过报冲突。 */
  baseHash?: string;
  /** 覆盖审阅框里显示的名字，如「第 12 章的细纲」。 */
  what?: string;
  /**
   * 不跑写后的记账与伴生（`handler.after`），由调用方在一批写完之后补上。**只给一次写好几章的调用方用**——
   * {@link Workspace.createChapters}（导入原稿）与全书替换（`features/bookReplace.ts`）：章节的 after 只是重算
   * manifest，逐章重算是 O(n²) 次读盘；**只对章节生效**，别的种类的 after 记的是指纹，不能延后。
   */
  deferAfter?: boolean;
}

export interface WriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /** 这次写入连带做了什么（记了哪个 hash、搬了哪个伴生目录）。进日志用。 */
  side?: string[];
}

export interface TextEdit {
  old: string;
  new: string;
  /** 命中多处时是否全替换。缺省 false——不唯一就报错，不猜作者要改哪一处。 */
  all?: boolean;
}

export class Workspace {
  constructor(private readonly project: NovelProject) {}

  // ---------------------------------------------------------------- list

  /**
   * 列一个目录的直接子项（不递归）。缺省列工程根。
   *
   * **不抛**：越界、不存在、读不动都给空数组。这是常驻界面的取数路径，
   * 作者在别处删掉一个正展开的目录时整页不该跟着炸。
   */
  async list(relDir?: string): Promise<WsEntry[]> {
    const rel = (relDir ?? '').trim() === '' ? '' : normalizeRel(relDir!);
    if (rel === undefined) {
      return [];
    }
    const abs = rel === '' ? this.project.root : this.project.pathOf(rel);

    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: WsEntry[] = [];
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      if (isInternalPath(this.project, childRel)) {
        continue;
      }
      const childAbs = path.join(abs, dirent.name);
      let isDir = dirent.isDirectory();
      let bytes = 0;
      try {
        const stat = await fs.stat(childAbs);
        isDir = stat.isDirectory();
        bytes = stat.isFile() ? stat.size : 0;
      } catch {
        if (!isDir && !dirent.isFile()) {
          continue;
        }
      }
      const kind = kindOfPath(this.project, childRel).kind;
      out.push({
        name: dirent.name,
        rel: childRel,
        type: isDir ? 'dir' : 'file',
        kind: isDir ? 'other' : kind,
        // 大文件不为了报个字数去整份读盘——那是全量遍历时的几百次多余 I/O。
        words: !isDir && bytes <= MAX_EDITABLE_BYTES ? await wordsOf(childAbs) : undefined,
        bytes,
      });
    }
    out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })));
    return out;
  }

  // ---------------------------------------------------------------- read

  /**
   * 读一份文件。
   *
   * `offset` / `limit` 按**行**切。截过必须在 `truncated` 里说出来——
   * 三期的 agent 工具会把它转述给模型，模型不知道自己只看了一半的话，
   * 会拿着半份正文去下结论。
   */
  async read(rel: string, opts?: { offset?: number; limit?: number }): Promise<WsFile> {
    let full: string;
    let normalized: string;
    if (this.isOutline(rel)) {
      // 情节大纲没有文件：各章细纲梗概的汇总（磁盘上残留的老 `outline.md` 不读）。
      normalized = normalizeRel(rel)!;
      full = await this.project.readOutlineDoc();
    } else {
      const abs = await guardRead(this.project, rel);
      normalized = normalizeRel(rel)!;
      full = decodeFileText(await fs.readFile(abs));
    }
    const kind = kindOfPath(this.project, normalized).kind;

    const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
    const limit = opts?.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    if (offset === 0 && limit === undefined) {
      return {
        rel: normalized,
        text: full,
        hash: hash(full),
        bytes: Buffer.byteLength(full, 'utf8'),
        kind,
      };
    }

    const lines = full.split(/\r?\n/);
    const sliced = lines.slice(offset, limit === undefined ? undefined : offset + limit);
    const text = sliced.join('\n');
    const truncated = sliced.length < lines.length ? { from: offset, total: lines.length } : undefined;
    return {
      rel: normalized,
      text,
      // hash 恒是**整份文件**的 hash：它是乐观锁基线，按半份算就永远对不上。
      hash: hash(full),
      bytes: Buffer.byteLength(text, 'utf8'),
      kind,
      truncated,
    };
  }

  // ---------------------------------------------------------------- write

  /**
   * 写一份产物。
   *
   * 五步，顺序不能换：
   *
   * 1. `kindOfPath` 判种类 → 取 handler
   * 2. handler 定最终落点（场景的文件名由磁盘上那份的标题决定）
   * 3. `guardWrite` 过八条守卫（越界 / 回收站 / 大小 / 同名 / 乐观锁）
   * 4. 覆盖前审阅（`mode: 'overwrite'` 且目标已有不同内容时）
   * 5. 落盘 → handler 记账与伴生
   */
  async write(rel: string, input: WriteInput, opts: WriteOptions = {}): Promise<WriteResult> {
    const mode = opts.mode ?? 'create';
    const normalized = normalizeRel(rel);
    if (normalized === undefined) {
      throw new WsError('outOfRoot', `路径超出工程目录：${rel}`);
    }

    if (this.isOutline(normalized)) {
      return this.writeOutline(input, { ...opts, mode });
    }

    const artifact = 'artifact' in input ? input.artifact : undefined;
    let ctx = this.ctxOf(normalized);
    const handler = handlerFor(ctx.path.kind);

    // 步骤 2：落点最终由 handler 说了算。场景的文件名带标题，标题在磁盘上。
    if (handler.resolve) {
      const resolved = await handler.resolve(ctx, artifact);
      if (resolved !== normalized) {
        ctx = this.ctxOf(resolved);
      }
    }
    const target = ctx.rel;

    let text = artifact ? await this.render(handler, ctx, artifact) : (input as { text: string }).text;

    const guarded = await guardWrite(this.project, target, {
      mode,
      baseHash: opts.baseHash,
      text: mode === 'append' ? undefined : text,
    });

    // 步骤 4：覆盖前审阅。**append 不走这一条**——追加不覆盖任何东西。
    // 独立版的合并视图可能交回作者挑过的那一份：写它，记账与伴生照常跑在最终文本上。
    if (mode === 'overwrite' && guarded.existed && opts.review !== false) {
      const review = await reviewOverwrite(opts.what ?? target, target, guarded.current ?? '', text);
      if (!review.ok) {
        return { rel: target, skipped: true, message: `没有改动 ${target}。` };
      }
      text = review.text ?? text;
    }

    const final = mode === 'append' ? appendText(guarded, text, ctx.path.kind === 'chapter') : text;
    if (guarded.existed) {
      // 覆盖（含追加）之前先把磁盘上的旧内容存一版（history.ts：只管创作产物、有节流）。绝不抛——存不下也照常写盘。
      await snapshotBeforeWrite(this.project, target, final);
    }
    await writeText(guarded.abs, final);
    this.project.invalidate();

    const side = handler.after && !(opts.deferAfter && ctx.path.kind === 'chapter') ? await handler.after(ctx, final) : [];
    if (side.length > 0) {
      log.debug(`写入 ${target} 时连带`, side.join('｜'));
    }
    return { rel: target, message: `已写入 ${target}`, side };
  }

  // ---------------------------------------------------------------- edit

  /**
   * 定点替换。
   *
   * **要么全成要么全不成**：多条编辑里有一条对不上就整批不落盘。半截状态
   * （前两条改了、第三条没改）比报错难收拾得多——作者看不出改到哪了。
   *
   * `old` 命中多处且没给 `all` 时报错，不猜他要改哪一处。
   */
  async edit(rel: string, edits: TextEdit[]): Promise<WriteResult> {
    let text: string;
    if (this.isOutline(rel)) {
      text = await this.project.readOutlineDoc();
    } else {
      text = await readText(await guardRead(this.project, rel));
    }
    const normalized = normalizeRel(rel)!;
    let replaced = 0;

    for (const edit of edits) {
      const count = countOccurrences(text, edit.old);
      if (count === 0) {
        throw new WsError('notFound', `找不到要替换的内容：${clip(edit.old)}`);
      }
      if (count > 1 && !edit.all) {
        throw new WsError(
          'notUnique',
          `「${clip(edit.old)}」在 ${normalized} 里出现 ${count} 处，没有指定 all 就不猜改哪一处。`
        );
      }
      text = edit.all ? text.split(edit.old).join(edit.new) : text.replace(edit.old, edit.new);
      replaced += edit.all ? count : 1;
    }

    // 走 write 而不是直接落盘：记账与伴生对 edit 一样要做（作者在编辑器里
    // 改一份细纲，指纹链现在会断——这一期修的正是它）。
    // review: false 是安全的：edit 本来就是「在这份内容上改几个字」，
    // 拿它和自己 diff 一遍没有意义。
    const r = await this.write(normalized, { text }, { mode: 'overwrite', review: false });
    return { ...r, message: `已替换 ${replaced} 处：${normalized}` };
  }

  // ---------------------------------------------------------------- move

  /**
   * 改名/移动。**目标已存在一律拒绝**（第 3 条：不静默覆盖）。
   *
   * 伴生搬迁交给 handler：章节带走草稿与细纲（两样都镜像正文的路径，正文一搬就得跟着走）。
   * 历史版本也跟着走（`history.ts` 的 `moveHistory`）：搬的这一份（或整个目录）的快照目录挪到新路径下，伴生的草稿、
   * 细纲各自的快照由 handler 那边跟着挪。搬快照失败只记 warn，不挡搬家。
   */
  async move(from: string, to: string): Promise<WriteResult> {
    const { fromAbs, fromRel, toRel } = await this.guardMove(from, to);

    const ctx = this.ctxOf(fromRel);
    // 目录不进种类表（`chapters/第一卷` 没有数字前缀），但草稿镜像跟着**整棵
    // 子树**走——移动 `chapters/卷一/` 时 `drafts/卷一/` 得跟着。所以落在
    // 章节根之下的目录也按章节处理。
    const handler = handlerFor(
      ctx.path.kind === 'other' && this.project.draftRelPathFor(fromRel) ? 'chapter' : ctx.path.kind
    );

    await fs.mkdir(path.dirname(this.project.pathOf(toRel)), { recursive: true });
    await fs.rename(fromAbs, this.project.pathOf(toRel));
    this.project.invalidate();

    // 主文件已经搬过去了：快照先跟上（绝不抛），伴生那一步出了错也不会把它们落在旧路径下。
    const history = await moveHistory(this.project, fromRel, toRel);
    const side = [...history, ...(handler.companions ? await handler.companions(ctx, fromRel, toRel) : [])];
    if (side.length > 0) {
      log.info(`${fromRel} → ${toRel} 时连带`, side.join('｜'));
    }
    return { rel: toRel, message: `已移动到 ${toRel}`, side };
  }

  /**
   * 搬家之前的预检，**只读、不碰磁盘上的任何东西**：与 {@link move} 同一套守卫——来源在、不是固定目录 / 内部文件 /
   * 回收站里的东西；落点在工程内、不在回收站、没有同名。能搬就正常返回，搬不成抛 `WsError`（与 `move` 抛的同一种）。
   *
   * `plot: true` 再多查一样：这是一章正文，它镜像的细纲在、新路径镜像的位置上却已经有东西。`move` 遇到这种情况照样搬
   * 正文，细纲留在原处、说一句（第 7 条：目标已有就不动）；但**先改了正文的 `# 标题` 行再搬家**的调用方（`files/fileOps.ts`
   * 的章节改名）要把它当成搬不成——写标题之前就停下，什么都不动（第 3 条），不然标题与文件名换了，细纲却留在旧路径上。
   *
   * 预检过了不等于一定搬得成（预检与搬家之间别处可能刚建了同名文件）：调用方仍要接住 `move` 的失败。
   */
  async checkMove(from: string, to: string, opts: { plot?: boolean } = {}): Promise<void> {
    const { fromRel, toRel } = await this.guardMove(from, to);
    if (!opts.plot || this.ctxOf(fromRel).path.kind !== 'chapter') {
      return;
    }
    const mine = this.project.plotMirrorOf(fromRel);
    const next = this.project.plotMirrorOf(toRel);
    if (!mine || !next || mine === next) {
      return;
    }
    if ((await exists(this.project.pathOf(mine))) && (await exists(this.project.pathOf(next)))) {
      throw new WsError('exists', `已存在：${next}（新名字对应的细纲位置上已经有一份，这一章的细纲 ${mine} 跟不过去）`);
    }
  }

  /**
   * `move` 与 `checkMove` 共用的守卫。来源过「改名 / 删除」那一套（固定目录、内部文件、回收站、存在），落点过写入那一套：
   * 把一份细纲搬成 `.novelforge/plots` 本身，或者搬进回收站装作删掉，都不该放行；同名一律拒绝（第 3 条）。
   */
  private async guardMove(from: string, to: string): Promise<{ fromAbs: string; fromRel: string; toRel: string }> {
    const fromAbs = await guardMutate(this.project, from);
    const fromRel = normalizeRel(from)!;
    const toRel = normalizeRel(to);
    if (toRel === undefined) {
      throw new WsError('outOfRoot', `路径超出工程目录：${to}`);
    }
    await guardWrite(this.project, toRel, { mode: 'create' });
    return { fromAbs, fromRel, toRel };
  }

  // ---------------------------------------------------------------- remove

  /**
   * 删除：**搬进 `.novelforge/.trash/` 并保留原相对路径**，不真删
   * （AGENTS 第 6 条）。同名冲突时加序号，不覆盖之前删掉的东西。
   */
  async remove(rel: string): Promise<WriteResult> {
    const abs = await guardMutate(this.project, rel);
    const normalized = normalizeRel(rel)!;
    const ctx = this.ctxOf(normalized);
    const handler = handlerFor(ctx.path.kind);

    // 伴生先处理（有的 handler 删除时要连带搬东西或重算索引），主文件删完再做的话，
    // 中途失败会留下一堆孤儿。
    const side = handler.onRemove ? await handler.onRemove(ctx, normalized) : [];

    const dest = await trashPathFor(this.project, normalized);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(abs, dest);
    this.project.invalidate();

    log.info(`已移到回收站：${normalized}`, `落点 ${this.project.relPath(dest)}`);
    return { rel: normalized, message: `已移到回收站：${normalized}`, side };
  }

  // ---------------------------------------------------------------- copy

  /**
   * 复制一份文件或一整个目录（文件页的「复制 → 粘贴」）。**目标已有就拒绝**：不加序号、不覆盖（第 3 条）。
   *
   * 守卫两头都过：
   *
   * - **来源**（`guardCopySource`）：在工程内、存在、不是固定目录、不是内部文件（会话、工程库）、不是符号链接。
   *   回收站与历史版本里的东西**复制得出来**——复制只读来源，读得到就复制得出来，原件一个字节不动。
   * - **落点**（`guardCreate`）：在工程内、不在回收站 / 会话目录 / 历史版本里、没有同名；目录不能复制进它自己里面。
   *   复制目录时先把整棵树列出来、**逐个文件**过一遍，全过了才动手，守卫拦下一份就整个不复制。
   *
   * 字节原样拷贝（`COPYFILE_EXCL`：竞态里也绝不盖掉别处刚建的文件）：GBK 的章节、图片都不转码。没有大小上限——与 `move`
   * 一样，复制不把内容读进编辑器或模型。目录里的符号链接不跟进去，跳过并在 `side` 里说出来（链到工程外的东西不该被抄进来）。
   *
   * 拷完按**副本**的种类补账（handler 的 `afterCopy`）：细纲副本去掉定稿那一侧的指纹（`handlers/plot.ts`，第 18 条）；
   * 复制进 `chapters/` 的章节最后统一同步一次 manifest，像新建一样。**没有伴生**：复制一章不带草稿、也不带细纲——副本是
   * 一章新的（第 8 条：细纲按路径认，旧细纲不冒认），草稿是作者对原章的笔记，跟着复制会变成两份各自漂移的东西。
   * 没覆盖任何东西，所以不存历史版本；原件的历史也不抄过去。
   */
  async copy(from: string, to: string): Promise<WriteResult> {
    const source = await guardCopySource(this.project, from);
    const toRel = normalizeRel(to);
    if (toRel === undefined) {
      throw new WsError('outOfRoot', `路径超出工程目录：${to}`);
    }
    if (source.isDir && toRel.startsWith(`${source.rel}/`)) {
      throw new WsError('intoSelf', `不能把「${source.rel}」复制进它自己里面：${toRel}`);
    }
    await guardCreate(this.project, toRel);

    const plan = source.isDir
      ? await copyPlanOf(this.project, source.rel, toRel)
      : { dirs: [], files: [{ from: source.rel, to: toRel }], skipped: [] };
    for (const rel of [...plan.dirs, ...plan.files.map((f) => f.to)]) {
      await guardCreate(this.project, rel);
    }

    if (!source.isDir) {
      await fs.mkdir(path.dirname(this.project.pathOf(toRel)), { recursive: true });
    }
    for (const dir of plan.dirs) {
      await fs.mkdir(this.project.pathOf(dir), { recursive: true });
    }
    for (const file of plan.files) {
      await fs.copyFile(this.project.pathOf(file.from), this.project.pathOf(file.to), fsConstants.COPYFILE_EXCL);
    }
    this.project.invalidate();

    const side = plan.skipped.map((rel) => `${rel} 是符号链接，没复制`);
    let chapters = false;
    for (const file of plan.files) {
      const ctx = this.ctxOf(file.to);
      if (ctx.path.kind === 'chapter') {
        chapters = true;
        continue;
      }
      const handler = handlerFor(ctx.path.kind);
      if (handler.afterCopy) {
        side.push(...(await handler.afterCopy(ctx, file.from)));
      }
    }
    if (chapters) {
      await this.project.syncManifest();
    }
    // 与 move 同一个口径：有连带的事才记一条（去掉了哪份细纲的指纹、跳过了哪个链接）。
    if (side.length > 0) {
      log.info(`${source.rel} → ${toRel} 复制时连带`, side.join('｜'));
    }
    return { rel: toRel, message: `已复制到 ${toRel}`, side };
  }

  // ---------------------------------------------------------------- mkdir

  /**
   * 建一个目录，可以一次建几层（`宗门/正道`）。工程页 / 文件页的「新建文件夹」走它。
   *
   * 守卫与复制的落点同一套（`guardCreate`）：在工程内、不在回收站 / 会话目录 / 历史版本里；落点上已经有东西（目录或文件）
   * 报 `exists`、什么都不动（第 3 条）。只建目录，不写任何文件，所以没有种类、没有记账。
   */
  async mkdir(rel: string): Promise<WriteResult> {
    const abs = await guardCreate(this.project, rel);
    const normalized = normalizeRel(rel)!;
    await fs.mkdir(abs, { recursive: true });
    this.project.invalidate();
    return { rel: normalized, message: `已新建文件夹 ${normalized}` };
  }

  // ---------------------------------------------------------------- restoreBytes

  /**
   * 把一份文件写回成存档点里的那一份（`features/checkpoint.ts` 的退回），**字节原样**。
   *
   * 与 `write` 不同的地方都是有意的：
   *
   * - **不跑 handler**（不渲染、不定落点、不记账）：退回要的是当时那一份一个字节不差——细纲 frontmatter 里的
   *   `upstreamHash` / `writtenFrom` / `sourceHash` 一起回到当时，不按大纲此刻的指纹重记（第 18 条：整本退回之后
   *   就是当时那条链）。章节的 manifest 由调用方在一批写完之后同步一次（同 `deferAfter`）。
   * - **不弹覆盖审阅**：面板上点了两下「退回」就是那一问（第 3 条），乐观锁挡住这期间别处的改动。
   *
   * 守卫照过：越界、写不进去的三处（内部文件 / 回收站 / 历史版本）、大小上限、乐观锁——`absent: true` 表示作者看到时
   * 磁盘上没有这一份，这期间又被建出来就报 `exists`；给了 `baseHash` 就比对，磁盘变过报冲突。覆盖之前照样给旧内容存
   * 一版历史（跳过节流：退回是一次大改，被盖掉的那一份得在「历史」面板里找得到）。父目录不在就补齐（存档点之后整个
   * 卷目录被删了）。
   */
  async restoreBytes(rel: string, bytes: Buffer, opts: { baseHash?: string; absent?: boolean } = {}): Promise<WriteResult> {
    const normalized = normalizeRel(rel);
    if (normalized === undefined) {
      throw new WsError('outOfRoot', `路径超出工程目录：${rel}`);
    }
    if (bytes.length > MAX_EDITABLE_BYTES) {
      throw new WsError('tooLarge', `内容超过大小上限，未写入：${normalized}`);
    }
    const guarded = await guardWrite(this.project, normalized, {
      mode: opts.absent ? 'create' : 'overwrite',
      baseHash: opts.baseHash,
    });
    if (guarded.existed) {
      await snapshotNow(this.project, normalized);
    }
    await fs.mkdir(path.dirname(guarded.abs), { recursive: true });
    await fs.writeFile(guarded.abs, bytes);
    this.project.invalidate();
    return { rel: normalized, message: `已退回 ${normalized}` };
  }

  // ---------------------------------------------------------------- search

  /**
   * 全文检索。**零模型调用的朴素扫描**，实现在 `search.ts`。
   *
   * 跳过 `.trash/` 与二进制、单文件读入有上限、超上限的条数在 `dropped` 里
   * 报出来、默认按章号排序——作者问「他前面说过吗」，时间线顺序才有意义。
   */
  async search(pattern: string, opts?: SearchOptions): Promise<SearchResult> {
    return search(this.project, pattern, opts);
  }

  // ---------------------------------------------------------------- 领域写入器
  //
  // 上面那几个方法收的是**路径**。下面这几个收的是**领域对象**（一份细纲、
  // 一章正文），因为它们的落点由内容决定：细纲的文件名是「章号 + 标题」，
  // 改标题就是改文件名。调用方手里只有对象，让它自己去拼路径等于把命名规则
  // 复制一份出去。
  //
  // 它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。

  // ---------------------------------------------------------------- 情节大纲

  /** 这个路径是不是情节大纲（没有文件，读写由这一层接住）。越界、认不出的都不是。 */
  isOutline(rel: string): boolean {
    const normalized = normalizeRel(rel);
    return normalized !== undefined && kindOfPath(this.project, normalized).kind === 'outline';
  }

  /**
   * 写情节大纲：**按章号拆回各章细纲**（docs/design/plans/2026-10-22-outline-from-plots.md）。磁盘上没有 `outline.md`，
   * 大纲是各章细纲「梗概」的汇总（`NovelProject.readOutlineDoc`）。
   *
   * 守卫、乐观锁、覆盖审阅都在**整份汇总**上做，与写一份文件同一个口径：越界由 `write` 先拦；超过大小上限拒；`create` 时
   * 大纲已经有条目报同名；给了 `baseHash` 就比此刻汇总出来的那一份，对不上抛 `WsConflictError`（内置编辑器拿它出冲突条）；
   * 覆盖之前审阅（现有 ↔ 新版，作者在合并视图里挑过的写挑过的那份）。产物（生成的大纲）先规范成一章一条再审阅——
   * 审阅框里看到的就是会写下去的样子。
   *
   * 拆的规矩在 `model/outlineFile.ts` 的 `planOutlineSplit`，落盘一章一份：
   *
   * - 改梗概：只换「梗概」一节（外科式，别的节与 frontmatter 一个字不动，先存一版历史）——上游指纹不动，
   *   排过细纲的章因此挂 ⟳（第 18 条）；
   * - 改标题：经 {@link writePlot}（还没有正文时文件名跟着改，与工程页的改名同一条路）；
   * - 新的一章：建一份只有梗概的细纲（空壳），不记上游指纹；
   * - 删掉的空壳进回收站（{@link deletePlot}）；排了细纲或写了正文的不删，说一声。
   *
   * 一章写不成（落点上已经有别的文件）不挡别的章，在返回的说明里列出来。
   */
  async writeOutline(input: WriteInput, opts: WriteOptions = {}): Promise<WriteResult> {
    const mode = opts.mode ?? 'create';
    const rel = this.project.relPath(this.project.outlinePath);
    const current = await this.project.readOutlineDoc();
    let text: string;
    if ('artifact' in input) {
      if (input.artifact.kind !== 'outlineDoc') {
        throw new Error(`「${rel}」不接 ${input.artifact.kind} 产物`);
      }
      text = renderOutlineDoc(parseOutline(input.artifact.text).map((e) => ({ ...e, text: e.text.trim() })));
    } else {
      text = mode === 'append' ? `${current.trimEnd()}\n\n${input.text}` : input.text;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new WsError('tooLarge', '内容超过大小上限，未写入。');
    }
    const filled = isOutlineFilled(current);
    if (mode === 'create' && filled) {
      throw new WsError('exists', `已存在：${rel}`);
    }
    // 一条章标题都认不出（旧格式的区间分节、散文式）却要整份换掉：照拆的规矩会把大纲排到的空壳全删掉。不写，说清楚。
    if (filled && !isOutlineFilled(text)) {
      throw new Error('新的情节大纲里认不出「## 第N章：标题」这样的章标题，没有写入（照它拆，大纲排到的章会全被删掉）。要删某几章，在大纲里删掉那几条再保存。');
    }
    if (opts.baseHash && hash(current) !== opts.baseHash) {
      log.warn(`写入被拒：${rel} 在别处被改过`, '情节大纲是各章梗概的汇总，期间有细纲改过。已把现在的版本交回调用方，未覆盖。');
      throw new WsConflictError(current, hash(current));
    }
    if (mode === 'overwrite' && filled && opts.review !== false) {
      const review = await reviewOverwrite(opts.what ?? '情节大纲', rel, current, text);
      if (!review.ok) {
        return { rel, skipped: true, message: `没有改动 ${rel}。` };
      }
      text = review.text ?? text;
    }

    const [plots, chapters] = await Promise.all([this.project.listChapterPlots(), this.project.listChapters()]);
    const plan = planOutlineSplit(text, plots, new Set(chapters.map((c) => c.order)));
    const done = { created: [] as number[], synopsis: [] as number[], title: [] as number[], dropped: [] as number[] };
    const failed: string[] = [];
    for (const op of plan.ops) {
      try {
        if (op.op === 'create') {
          await this.writePlot({ no: op.no, title: op.title, upstreamHash: '', done: false, sections: { ...emptyPlotSections(), 梗概: op.synopsis } });
          done.created.push(op.no);
        } else if (op.op === 'drop') {
          if (await this.deletePlot(op.rel)) {
            done.dropped.push(op.no);
          }
        } else if (op.title !== undefined) {
          const plot = await this.project.readPlot(op.rel);
          if (!plot) {
            throw new WsError('notFound', `找不到 ${op.rel}`);
          }
          await this.writePlot({ ...plot, title: op.title, sections: { ...plot.sections, 梗概: op.synopsis ?? plot.sections.梗概 } }, op.rel);
          done.title.push(op.no);
          if (op.synopsis !== undefined) {
            done.synopsis.push(op.no);
          }
        } else if (op.synopsis !== undefined) {
          await this.patchPlotSynopsis(op.rel, op.synopsis);
          done.synopsis.push(op.no);
        }
      } catch (err) {
        failed.push(`第 ${op.no} 章：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (done.created.length > 0) {
      // 新章可能落在了还没有正文的卷目录里：章节索引不用动，但细纲列表要重读。
      this.project.invalidate();
    }

    const side = [
      done.created.length ? `新建第 ${nos(done.created)} 章的细纲（只有梗概）` : '',
      done.synopsis.length ? `改了第 ${nos(done.synopsis)} 章的梗概` : '',
      done.title.length ? `改了第 ${nos(done.title)} 章的标题` : '',
      done.dropped.length ? `第 ${nos(done.dropped)} 章只有梗概的细纲进了回收站` : '',
      plan.kept.length ? `第 ${nos(plan.kept)} 章已经排了细纲或写了正文，大纲里删掉那一条没删它（要删去工程页删细纲）` : '',
      plan.empty.length ? `第 ${nos(plan.empty)} 章只有标题、没写梗概，没保存` : '',
      ...failed.map((f) => `没写成：${f}`),
    ].filter(Boolean);
    if (side.length > 0) {
      log.info('写回情节大纲', side.join('｜'));
    }
    const changed = done.created.length + done.synopsis.length + done.title.length + done.dropped.length;
    return {
      rel,
      message: changed > 0 ? `已写回情节大纲：${side.join('；')}` : side.length > 0 ? `情节大纲没有改动：${side.join('；')}` : '情节大纲没有改动。',
      side,
    };
  }

  /**
   * 只换一章细纲的「梗概」一节（在汇总的大纲里改了这一章那一条）：外科式，别的节、作者加的小节与 frontmatter 一个字不动，
   * 上游指纹也不动（排过细纲的章于是挂 ⟳，第 18 条）。改之前存一版历史。返回是否写了。
   */
  async patchPlotSynopsis(plotRelPath: string, synopsis: string): Promise<boolean> {
    const raw = await readTextIfExists(this.project.pathOf(plotRelPath)).catch(() => undefined);
    if (raw === undefined) {
      return false;
    }
    const next = replaceSection(raw, '梗概', synopsis);
    if (next === raw) {
      return false;
    }
    await this.overwrite(plotRelPath, next);
    this.project.invalidate();
    return true;
  }

  /**
   * 写一章的细纲，返回工作区相对路径。
   *
   * 落点（细纲镜像正文的相对路径，见 model/project.ts 的 `plotPathForChapter`）：
   *
   * - **这一章已经有正文**：正文的镜像。文件名跟着正文走，改标题只改 frontmatter 里那个标题。
   * - **还没有正文、已有细纲**：留在那一份所在的子目录，文件名按「章号 + 标题」重拼——改标题会改
   *   文件名，改章号也会。
   * - **都没有**：`at`（调用方给的落点，如主按钮的占位路径 `summaries/第二卷/003.md`）所在的子目录；
   *   没给就跟上一章放在一起（`plotPathForNewChapter`）。
   *
   * 旧文件必须删掉，否则 `007-入宗.md` 与 `007-入宗风波.md` 并存会变成同一章的两份细纲。
   * 「旧文件是哪一份」有两种问法：
   *
   * - **改标题**（章号没变）：按 `plot.no` 就找得到，这是绝大多数调用。
   * - **改章号**：新号上根本没有旧文件，必须由调用方把原路径经 `fromRelPath`
   *   传进来。不传的话旧文件会留在原地成为孤儿。
   *
   * **`upstreamHash` 以调用方给的为准**，不在这里补：手工新建的细纲传的就是空串，
   * 它才永远不会挂 ⟳。
   *
   * @param fromRelPath 改章号时传原细纲路径；改标题或新建时不必传。
   * @param at 新建时调用方想要的落点（只取它的子目录）；不是细纲路径就不认。
   */
  async writePlot(plot: WritablePlot, fromRelPath?: string, at?: string): Promise<string> {
    // 换号时新号上是空的，只有调用方知道原来那份在哪。
    const previous = fromRelPath
      ? await this.project.readPlot(fromRelPath)
      : await this.project.getPlot(plot.no);
    const rel = await this.plotRelPathOf(plot, previous?.relPath, at);
    // 落点上已经有一份**别的**细纲（不是这一章要替换的那份）：不静默盖掉它（第 3 条）。
    // 手改文件名撞了号、或两章起了同一个标题都会走到这里。
    if (rel !== previous?.relPath && (await readTextIfExists(this.project.pathOf(rel)).catch(() => undefined)) !== undefined) {
      throw new WsError('exists', `已经有一份细纲叫 ${rel}，没有覆盖它。`);
    }

    const text = renderPlotFile(plot);
    if (previous) {
      // 换掉的是这一章原来那份（改标题、改章号时它在旧路径上），旧内容先存一版。
      await snapshotBeforeWrite(this.project, previous.relPath, text);
    }
    await writeText(this.project.pathOf(rel), text);

    if (previous && previous.relPath !== rel) {
      await fs.unlink(this.project.pathOf(previous.relPath)).catch(() => undefined);
      // 改标题（还没有正文）、改章号都换了文件名：这一份的快照（连同刚存的那一版）跟着搬到新路径下，绝不抛。
      await moveHistory(this.project, previous.relPath, rel);
    }
    // 细纲列表有缓存，写完不失效的话下一次读到的还是写之前那份——新建的章
    // 不出现在工程页上，改过标题的章还挂着旧名字。
    this.project.invalidate();
    return rel;
  }

  /** {@link writePlot} 的落点。规则见那里。 */
  private async plotRelPathOf(plot: WritablePlot, previousRel?: string, at?: string): Promise<string> {
    const chapter = await this.project.getChapter(plot.no);
    if (chapter) {
      return this.project.plotPathForChapter(chapter.relPath);
    }
    const anchor = previousRel ?? (at && kindOfPath(this.project, at).kind === 'plot' ? normalizeRel(at) : undefined);
    const dir = anchor
      ? path.posix.dirname(anchor)
      : this.project.relPath(path.join(this.project.plotsDir, await this.project.subdirForNewChapter(plot.no)));
    return `${dir}/${plotFileName(plot.no, safeStem(plot.title))}`;
  }

  /**
   * 删一章的细纲：搬进 `.trash/`，不真删（AGENTS 第 6 条）。返回是否确实删掉了。
   *
   * **不碰 `chapters/`**：那是已经写出来的正文。删掉细纲只是放弃这一章的规划稿
   * （定稿过的话连同档案），不该顺手把正文一起带走。
   *
   * 落点与 `remove`、`finalizePlot` 同一套（`trashPathFor`：保留原相对路径，同名加序号）——定稿时
   * 复制进回收站的那一版旧计划，不能被这一次删除盖掉。
   *
   * **它写进叙事线里的计划事件一起删**（复跑之后，第 28 条「计划事件随细纲走」）：各条线与「未归属的伏笔」里这一章的
   * 计划事件整组删掉（{@link dropPlannedThreadEvents}，写之前存一版历史），实际事件、别的章、作者写的行不动。从前只删细纲，
   * 那一章的计划一直留在线里，重拆时被当成「原来的计划」交给模型，写前提醒也把它算成「安排过」。同一章还有另一份细纲
   * （作者手里两份同号的）时不删——计划还算那一份的。
   */
  async deletePlot(plotRelPath: string): Promise<boolean> {
    const plot = await this.project.readPlot(plotRelPath);
    if (!plot) {
      return false;
    }
    const dest = await trashPathFor(this.project, plotRelPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(this.project.pathOf(plotRelPath), dest);
    this.project.invalidate();
    if (!(await this.project.getPlot(plot.no))) {
      await this.dropPlannedThreadEvents(plot.no);
    }
    return true;
  }

  /**
   * 删掉各条线与「未归属的伏笔」里第 `no` 章的计划事件（删一章细纲时，见 {@link deletePlot}）：外科式（`replacePlannedEvents`），
   * 只动那几行，每份改了的先存一版历史。返回删掉了几条。
   */
  async dropPlannedThreadEvents(no: number): Promise<number> {
    const book = await this.project.readThreads();
    let removed = 0;
    for (const rel of [...book.threads.map((t) => t.relPath), book.unfiled.relPath]) {
      await this.updateThread(rel, (raw) => {
        if (!raw.trim()) {
          return undefined;
        }
        const r = replacePlannedEvents(raw, no, []);
        removed += r.removed;
        return r.removed > 0 ? r.text : undefined;
      });
    }
    if (removed > 0) {
      log.info(`第 ${no} 章的细纲删了：叙事线里那一章的 ${removed} 条计划一起删掉（旧版存进了历史版本）`);
    }
    return removed;
  }

  /**
   * 正文改了名，细纲里的标题跟着改：frontmatter 的 `title` 与 `# 第N章 标题` 那一行。返回改了（`retitled`）、
   * 没动作者起的标题（`kept`）、本来就一样（`same`）。
   *
   * 细纲文件已经由 `carryPlot` 跟着正文搬到了新镜像，可工程页那一行先认细纲的标题——不改的话文件名是新的、
   * 显示的还是旧名字。只在细纲的标题还是正文的旧名（或空着）时改：不一样说明作者在细纲上单独起过标题
   * （{@link writePlot} 有正文时改名只改标题），机器不动它。
   *
   * 只改那两行，其余一个字节不动（作者手加的小节、排版都留着），不整份重渲染；改之前存一版历史。标题不进内容指纹
   * （`plotContentHash`），改了不挂 ⟳。细纲没有 frontmatter 时标题本来就取文件名，不补 frontmatter（与
   * {@link recordWrittenFrom} 同一个规矩），只换标题行。
   */
  async retitlePlot(plotRelPath: string, from: string, to: string): Promise<'retitled' | 'kept' | 'same'> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    const old = from.trim();
    const title = to.trim();
    if (raw === undefined || !title) {
      return 'same';
    }
    const fmTitle = parseMarkdown(raw).frontmatter.title;
    const current = typeof fmTitle === 'string' ? fmTitle.trim() : '';
    if (current && current !== old) {
      return current === title ? 'same' : 'kept';
    }
    const fenced = current === title ? raw : (rewriteFrontmatter(raw, { title }) ?? raw);
    const next = fenced.replace(PLOT_TITLE_LINE, (line, head: string, sep: string, was: string) =>
      was.trim() === old ? `${head}${sep || ' '}${title}` : line
    );
    if (next === raw) {
      return 'same';
    }
    await snapshotBeforeWrite(this.project, plotRelPath, next);
    await writeText(abs, next);
    this.project.invalidate();
    return 'retitled';
  }

  /**
   * 在细纲上记下「正文据以写成的细纲指纹」（`writtenFrom`）。正文落盘那一步调它。
   *
   * 为什么记在细纲这一侧：章节是作者的文件，可以是 `.txt`、没有 frontmatter
   * （第 9 条），这条链只能从细纲指过去（见 model/plotFile.ts 的文件头）。
   * `rewriteFrontmatter` 只改 `---` 之间那一段，正文一个字节不动；细纲没有
   * frontmatter（作者手写的）就不补——那份细纲不在这条链上。
   *
   * 返回是否确实记上了。
   */
  async recordWrittenFrom(plotRelPath: string, plotHash: string): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || !plotHash) {
      return false;
    }
    const next = rewriteFrontmatter(raw, { writtenFrom: plotHash });
    if (next === undefined || next === raw) {
      return next !== undefined;
    }
    await fs.writeFile(abs, next, 'utf8');
    this.project.invalidate();
    return true;
  }

  /**
   * 一致性预检的永久放行（五期补遗 §2）：把「这几个人在这一章出场是刻意的安排」记进这一章细纲的
   * frontmatter（`preflightOk`，一行「名字：理由」）。同名的换成新理由，其余原样留着。
   *
   * 与 {@link recordWrittenFrom} 同一种写法：只改 `---` 之间那一段。细纲没有 frontmatter（作者
   * 手写的）就不补——补一段 frontmatter 等于把它拉进指纹链（handlers/plot.ts 的第 18a 条）。
   * 返回是否确实记上了。
   */
  async recordPreflightOk(plotRelPath: string, entries: readonly PreflightOk[]): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || entries.length === 0) {
      return false;
    }
    const current = parsePlotFile(raw, plotRelPath).preflightOk;
    const merged = [...current.filter((e) => !entries.some((n) => n.name === e.name)), ...entries];
    const next = rewriteFrontmatter(raw, { preflightOk: renderPreflightOk(merged) });
    if (next === undefined) {
      return false;
    }
    if (next !== raw) {
      await fs.writeFile(abs, next, 'utf8');
      this.project.invalidate();
    }
    return true;
  }

  /**
   * 全书替换收尾时给细纲的指纹链补账（`features/bookReplace.ts`，第 18 条）：只改 frontmatter 里给出的那几个
   * 指纹键——`upstreamHash` / `writtenFrom` / `sourceHash`，值为 undefined 就是删掉这个键——正文一个字节不动。
   * 与 {@link recordWrittenFrom} 同一种写法：只改 `---` 之间那一段、不存历史版本（不吞任何内容）、没有 frontmatter
   * 的手写细纲不补。不是细纲路径就不动。返回是否改了。
   */
  async restampPlotChain(
    plotRelPath: string,
    patch: { upstreamHash?: string; writtenFrom?: string; sourceHash?: string }
  ): Promise<boolean> {
    const rel = normalizeRel(plotRelPath);
    if (rel === undefined || kindOfPath(this.project, rel).kind !== 'plot') {
      return false;
    }
    const allowed: Record<string, string | undefined> = {};
    for (const key of ['upstreamHash', 'writtenFrom', 'sourceHash'] as const) {
      if (key in patch) {
        allowed[key] = patch[key] || undefined;
      }
    }
    const abs = this.project.pathOf(rel);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || Object.keys(allowed).length === 0) {
      return false;
    }
    const next = rewriteFrontmatter(raw, allowed);
    if (next === undefined || next === raw) {
      return false;
    }
    await fs.writeFile(abs, next, 'utf8');
    this.project.invalidate();
    return true;
  }

  /**
   * 单独记设定（设定名录）：只换掉这一章细纲的「设定」一节，没有就加在末尾，另外七节与 frontmatter
   * 一个字不动（`replaceSection`）。「设定」一节不进内容指纹，所以这样补记不会让正文挂 ⟳。返回是否写了。
   */
  async patchPlotLore(plotRelPath: string, lines: readonly LoreLine[]): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined) {
      return false;
    }
    const next = replaceSection(raw, PLOT_LORE_KEY, renderLoreLines(lines));
    if (next !== raw) {
      await fs.writeFile(abs, next, 'utf8');
      this.project.invalidate();
    }
    return true;
  }

  /**
   * 新建章节文件，返回工作区相对路径。
   *
   * `dir` 是工作区相对的落点目录（如 `chapters/第一卷`），缺省落在 chapters/ 根下。
   * `ext` 默认 `.md`：扫描时认任意扩展名，但插件自己建的东西仍然出 markdown。
   * 非 markdown 家族不写标题行。
   *
   * **`title` 留空是合法的**，落成纯序号名 `001.md`（细纲还没起标题的章就是
   * 这个样子，标题等作者自己改）。
   *
   * 标题行写的是**清洗后**的词干而不是原样 `title`：两者一致，改名时
   * `renamedBody` 才认得出「这个 H1 是跟着文件名走的」。无标题时干脆不写
   * 标题行——凭空塞一行 `# ` 是同一个毛病。
   */
  async createChapter(
    order: number,
    title: string,
    content = '',
    dir?: string,
    ext = '.md'
  ): Promise<string> {
    const { rel, text } = this.chapterFileOf(order, title, content, dir, ext);

    // 走 write：同名一律报错退出（第 3 条），manifest 由 chapter handler 同步。
    await this.write(rel, { text }, { mode: 'create' });
    return rel;
  }

  /**
   * 在给定路径新建一章，返回那个路径。正文照细纲写出来时用：落点由 views/pipeline.ts 的
   * `chapterTargetOf` 给（细纲所在的子目录）。标题行取文件名里的词干，与 {@link createChapter} 同一个规矩。
   *
   * `plotRelPath` 是这一章照着写的细纲。它的路径与新正文的镜像对不上（细纲是还没起名时建的
   * `030.md`，正文按标题落成了 `030-雪夜.md`）就把细纲改名过去——细纲镜像正文的路径，不改的话
   * 正文一落盘，这一章就「没有细纲」了。镜像位置已有别的文件时不动（不静默覆盖），记一条 warn。
   */
  async createChapterAt(rel: string, content = '', plotRelPath?: string): Promise<string> {
    const parsed = parseChapterFileName(path.posix.basename(rel));
    const stem = parsed?.stem.trim() ?? '';
    const text = parsed && isMarkdownExt(parsed.ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    await this.write(rel, { text }, { mode: 'create' });

    const mirror = this.project.plotMirrorOf(rel);
    if (plotRelPath && mirror && mirror !== plotRelPath) {
      try {
        await this.move(plotRelPath, mirror);
        log.info('细纲跟着新正文改名', `${plotRelPath} → ${mirror}`);
      } catch (err) {
        log.warn('细纲没能改名到新正文的镜像，这一章暂时认不出细纲', `${plotRelPath} → ${mirror}｜${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return rel;
  }

  /**
   * 一次新建好几章（导入原稿，features/importManuscript.ts）。每一章与 {@link createChapter} 走同一条
   * `write`（同名报错退出、大小上限一样不少），只是 manifest **最后同步一次**——chapter handler 每写一章
   * 就重扫全部章节，几百章逐章同步是 O(n²) 次读盘（三百章十几秒）。
   *
   * 一章写不进去就抛（前面写好的留着，manifest 照样同步）；`signal` 取消了就停在下一章前面。
   * `onEach` 每写好一章报一次。
   */
  async createChapters(
    items: readonly { order: number; title: string; content: string }[],
    opts: { signal?: AbortSignal; onEach?: (rel: string, index: number) => void } = {}
  ): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < items.length && !opts.signal?.aborted; i++) {
        const { rel, text } = this.chapterFileOf(items[i].order, items[i].title, items[i].content);
        await this.write(rel, { text }, { mode: 'create', deferAfter: true });
        out.push(rel);
        opts.onEach?.(rel, i);
      }
    } finally {
      if (out.length > 0) {
        await this.project.syncManifest();
      }
    }
    return out;
  }

  /** 新建章节的落点与内容（标题行规则见 {@link createChapter}）。 */
  private chapterFileOf(order: number, title: string, content: string, dir?: string, ext = '.md'): { rel: string; text: string } {
    const stem = safeStem(title);
    const fileName = stem ? `${pad3(order)}-${stem}${ext}` : `${pad3(order)}${ext}`;
    const parent = dir ? normalizeRel(dir) : this.project.relPath(this.project.chaptersDir);
    const rel = parent ? `${parent}/${fileName}` : fileName;
    const text = isMarkdownExt(ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    return { rel, text };
  }

  /**
   * 按需创建草稿，返回它的工作区相对路径。
   *
   * **已存在就原样返回，绝不覆盖**——第二次点「打开草稿」不能把上次写的
   * 东西抹掉。这是「不静默覆盖」在草稿上的落法。
   */
  async ensureDraft(chapter: Chapter): Promise<string> {
    const rel = this.project.draftRelPathFor(chapter.relPath);
    if (!rel) {
      throw new Error(
        `这一章不在 ${this.project.config.chaptersDir}/ 下，无法建草稿：${chapter.relPath}`
      );
    }
    const abs = this.project.pathOf(rel);
    if ((await readTextIfExists(abs)) === undefined) {
      // markdown 家族给一行标题好认；其余（.txt / 无扩展名 / .json）留空文件，
      // 往里塞 markdown 语法只会碍事。
      await writeText(abs, isMarkdownPath(rel) ? `# ${chapter.title} · 草稿\n\n` : '');
    }
    return rel;
  }

  /**
   * 定稿：把反向更新过的细纲写回**这一章正文镜像的那一份**（还没有就在镜像位置新建一份）。返回落点，
   * 以及旧版在回收站里的位置（原来没有细纲时没有）。
   *
   * 渲染规矩在 `handlers/plot.ts` 的 `renderFinalizedPlot`：七节整体替换，作者定的 frontmatter 留着，
   * `sourceHash` 记正文的 `contentHash`（指纹链的最后一环），`writtenFrom` 刷成更新之后的指纹。
   *
   * **旧版先复制一份进 `.trash/`**（保留原相对路径，同名加序号，与第 6 条同一个落点）：定稿按钮本身就是
   * 作者的确认，所以直接写；但改的是一份作者可能逐字推敲过的计划，旧的那一版要找得回来。
   */
  async finalizePlot(
    chapter: Chapter,
    sections: PlotSections,
    cast: SummaryCast[],
    lore?: LoreLine[]
  ): Promise<{ rel: string; trashed?: string }> {
    const current = await this.project.plotOfChapter(chapter);
    const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title;
    const rel = this.project.plotPathForChapter(chapter.relPath);
    const text = renderFinalizedPlot({
      rel,
      no: chapter.order,
      title,
      current,
      sections,
      cast,
      sourceHash: chapter.contentHash,
      lore,
    });

    let trashed: string | undefined;
    if (current) {
      const dest = await trashPathFor(this.project, current.relPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(this.project.pathOf(current.relPath), dest);
      trashed = this.project.relPath(dest);
    }
    // 回收站那一份照旧（永不裁剪，定稿完成提示里说的就是它）；历史版本里再存一版，编辑器的「历史」面板里
    // 找得到、对比得了——七节整体换掉，节流拦不住它。
    await snapshotBeforeWrite(this.project, rel, text);
    await writeText(this.project.pathOf(rel), text);
    this.project.invalidate();
    return { rel, trashed };
  }

  /**
   * 写一张角色卡。slug 可以带子目录前缀（如 `主角/林昭`），中间目录自动补齐。
   *
   * 角色卡**不在生产链上**：它是横切的记忆，被装配进 prompt，但不由某一层
   * 产物「生出来」，所以没有上游指纹要记。
   */
  async writeCharacter(card: WritableCharacterCard): Promise<string> {
    const rel = `${this.project.relPath(this.project.charactersDir)}/${card.slug}.md`;
    await this.overwrite(rel, renderCharacterCard(card));
    return rel;
  }

  /** 写一条设定。与角色卡同类：链外的横切知识，无上游指纹。 */
  async writeLore(entry: WritableLoreEntry): Promise<string> {
    const rel = `${this.project.relPath(this.project.loreDir)}/${entry.slug}.md`;
    await this.overwrite(rel, renderLoreEntry(entry));
    return rel;
  }

  /**
   * 在设定区里建分类目录（`宗门/正道` 这样的相对 `lore/` 的路径，可多层）。设定清单落盘时用：分类就是
   * 目录，空的也建，作者看得到这本书的分类表。已有的不动；每一段过一遍文件名清洗，`.` 开头的段不要，
   * 出不了 `lore/`（第 7 条）。返回新建了哪几个。
   */
  async ensureLoreFolders(categories: readonly string[]): Promise<string[]> {
    const root = this.project.loreDir;
    const created: string[] = [];
    for (const category of categories) {
      const parts = category
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('.'))
        .map(sanitizeFileName);
      const abs = path.join(root, ...parts);
      const inside = path.relative(root, abs);
      if (parts.length === 0 || !inside || inside.startsWith('..') || path.isAbsolute(inside) || (await exists(abs))) {
        continue;
      }
      await fs.mkdir(abs, { recursive: true });
      created.push(parts.join('/'));
    }
    if (created.length > 0) {
      this.project.invalidate();
    }
    return created;
  }

  /** 写文风指南。同样在链外——它约束怎么写，不由任何一层产物生出来。 */
  async writeStyleGuide(content: string): Promise<string> {
    const rel = this.project.relPath(this.project.stylePath);
    await this.overwrite(rel, `# 文风指南\n\n${content.trim()}\n`);
    return rel;
  }

  /**
   * 写全文大纲，并把水位线记进 manifest。
   *
   * 它的上游是全部定稿过的细纲，但那是一次显式的重建动作（`through` 水位线），
   * 不是 hash 传播——所以没有 `upstreamHash`。
   */
  async writeGlobalSummary(content: string, through: number): Promise<string> {
    const rel = this.project.relPath(this.project.globalSummaryPath);
    const fm = stringifyFrontmatter({ through, generatedBy: 'novel-forge' });
    await this.overwrite(rel, `${fm}\n\n# 全文大纲\n\n${content.trim()}\n`);
    const manifest = await this.project.readManifest();
    manifest.globalSummaryThrough = through;
    await this.project.writeManifest(manifest);
    return rel;
  }

  /**
   * 第 `no` 章的叙事线判过了（定稿第三步的认事件成了）：推 `project.json` 里的水位（叙事线重做四期，`advanceThreadsMark`）——
   * 正好是水位 + 1 就往后推、顺着后面已经判过的接着推；更靠后的记进 `threadsJudged`；水位以内的不动、不写盘。
   * 单章定稿、立即同步、写完即定稿与从已写正文补记都在判完一章之后调它（features/threads.ts 的 `noteThreadsJudged`）。
   * 同全文大纲的水位：manifest 是链外的索引，没有上游指纹。返回推过之后的样子。
   */
  async markThreadsJudged(no: number): Promise<ThreadsMark> {
    const manifest = await this.project.readManifest();
    const before = threadsMarkOf(manifest);
    const after = advanceThreadsMark(before, no);
    if (after === before) {
      return before;
    }
    manifest.threadsThrough = after.through;
    if (after.judged.length > 0) {
      manifest.threadsJudged = after.judged;
    } else {
      delete manifest.threadsJudged;
    }
    await this.project.writeManifest(manifest);
    return after;
  }

  /**
   * 新建一条叙事线（排线、定稿时从正文认出新线）：`threads/<线名>.md`。**同名跳过**——这个文件已经在了（作者建的、
   * 这几十秒里别处建的）就一个字节不动，返回 undefined（第 19 条：机器只追加，已有的线不改）。名字归一后撞上
   * 已有的线（「玉佩 的来历」与「玉佩的来历」）由调用方先判，这里只看文件名。链外文件，没有上游指纹。
   */
  async createThread(thread: NewThread): Promise<string | undefined> {
    const rel = `${this.project.relPath(this.project.threadsDir)}/${threadFileName(thread.name)}`;
    if (await exists(this.project.pathOf(rel))) {
      return undefined;
    }
    try {
      await this.write(rel, { text: renderThreadFile(thread) }, { mode: 'create' });
    } catch (err) {
      // 刚查过不在、写的时候却有了：与已有的一样，不动它。
      if (err instanceof WsError && (err.code === 'exists' || err.code === 'notFile')) {
        return undefined;
      }
      throw err;
    }
    return rel;
  }

  /**
   * 改写一份叙事线文件（一条线，或「未归属的伏笔」）：读**此刻**磁盘上的原文（还没有这份文件当空串）→ `edit`
   * 给出新原文 → 写回（覆盖之前存一版历史）。`edit` 返回 undefined 或原样返回就不写。
   *
   * 为什么不让调用方先读好再交一份全文进来：排线、定稿那一次调用要几十秒，这期间作者可能正在编辑器里改这份
   * 文件。在写之前那一刻重读、只在上面外科式地改（model/threadFile.ts），作者那几十秒里的改动才不会被一份
   * 旧的全文冲掉（第 3 条）。只认叙事线目录里的文件（种类不是 `threads` 的拒写）。
   */
  async updateThread(rel: string, edit: (raw: string) => string | undefined): Promise<string | undefined> {
    const normalized = normalizeRel(rel);
    if (normalized === undefined || kindOfPath(this.project, normalized).kind !== 'threads') {
      throw new WsError('protected', `「${rel}」不是叙事线目录里的文件`);
    }
    const raw = (await readTextIfExists(this.project.pathOf(normalized))) ?? '';
    const next = edit(raw);
    if (next === undefined || next === raw) {
      return undefined;
    }
    await this.overwrite(normalized, next);
    return normalized;
  }

  /**
   * 写技能的阶段绑定（`.novelforge/skills.json`）。链外的小文件，由设置页「技能」与
   * 外部 agent 的 `skills bind` 改写——两条路在动手前都已经问过作者，这里不再弹覆盖审阅：
   * 每换一次下拉框就弹一个 JSON 的 diff 只是噪声。内容由 `renderSkillBindings` 产出。
   */
  async writeSkillBindings(text: string): Promise<string> {
    const rel = this.project.relPath(this.project.skillBindingsPath);
    await this.overwrite(rel, text);
    return rel;
  }

  /**
   * 切换正文的分段格式（内置编辑器「编辑 → 段落格式」）：**只改 `config.md` frontmatter 的
   * `paragraphStyle` 这一行**，正文一个字节不动（`setConfigParagraphStyle`）。没有 `config.md` 时新建一份
   * 只有这一段 frontmatter 的——它没有任何小节，「小说配置」照旧算没填，主按钮不变。
   *
   * 走 `write` 这一条网关（越界、大小这些守卫照过），不弹覆盖审阅：改的只是作者自己在菜单里点的那一个键，
   * 没有内容会被吞掉。带上读到时的 hash 当乐观锁——读与写之间作者在编辑器里存过，就报冲突、不覆盖。
   * 返回写到的相对路径；已经是这个值时不写，返回 undefined。
   */
  async setParagraphStyle(style: ParagraphStyle): Promise<string | undefined> {
    const rel = this.project.relPath(this.project.configPath);
    // 读不到（不存在）当空串；权限之类的错误照常上抛——吞掉它会拿一份最小的配置盖掉作者那份。
    const raw = await readTextIfExists(this.project.configPath);
    const next = setConfigParagraphStyle(raw ?? '', style);
    if (raw !== undefined && next === raw) {
      return undefined;
    }
    await this.write(
      rel,
      { text: next },
      { mode: 'overwrite', review: false, baseHash: raw === undefined ? undefined : hash(raw) }
    );
    return rel;
  }

  // ---------------------------------------------------------------- 新工程

  /**
   * 初始化一个新工程（`actions.ts` 的 `initProjectFlow`：插件命令、网页按钮、CLI 共用）：固定目录 → 空模板 → manifest。
   * 返回新建了哪几份模板。
   *
   * **分层**：建固定目录、写 manifest 是元数据与脚手架，留在 `model/project.ts`（`scaffold` / `createManifest`，按设计不走
   * 网关）；几份模板的落点与内容也在那里定义（`newProjectTemplates`，纯数据）；**写模板经这里的 `write`**——`model/`
   * 不能反过来依赖网关。
   *
   * 每份模板 `mode: 'create'`，**落点上已经有东西（文件或目录）就一个字节不动**——与从前 `writeIfAbsent` 同一个口径：在一个
   * 已经写了一部分的文件夹里初始化，作者的配置、文风原样留着（情节大纲是各章细纲梗概的汇总，不建文件）。经网关不多出别的动作：
   *
   * - 不弹审阅（只有 `overwrite` 才问）、不存历史版本（没覆盖任何东西）；
   * - 不碰指纹链（第 18 条）：这几份的种类是 setting / style / globalSummary，它们的 handler 都不记账；没有一份
   *   细纲被写，已有的细纲不会被补上 `upstreamHash`，也就没有东西因此挂 ⟳；
   * - 不刷日志：`write` 只在有伴生时记一条 debug，这几种没有伴生。
   *
   * manifest 最后写：`isInitialized` 看的是它。模板写到一半失败（磁盘满、没权限）时工程不算建好，作者再点一次就补齐。
   */
  async initializeProject(meta: { title: string; author: string }): Promise<string[]> {
    await this.project.scaffold();
    const created: string[] = [];
    for (const { rel, text } of this.project.newProjectTemplates()) {
      if (await exists(this.project.pathOf(rel))) {
        continue;
      }
      try {
        await this.write(rel, { text }, { mode: 'create' });
        created.push(rel);
      } catch (err) {
        // 刚查过不在、写的时候却有了（别处刚建）：与已有的一样，不动它。
        if (err instanceof WsError && (err.code === 'exists' || err.code === 'notFile')) {
          continue;
        }
        throw err;
      }
    }
    await this.project.createManifest(meta);
    return created;
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 领域写入器的落盘：目标已有内容就先存一版历史（history.ts，绝不抛），再整份写下去。
   * 只改 frontmatter 一个键的记账（`recordWrittenFrom` / `recordPreflightOk`）不走这里——它们不吞任何内容。
   */
  private async overwrite(rel: string, text: string): Promise<void> {
    await snapshotBeforeWrite(this.project, rel, text);
    await writeText(this.project.pathOf(rel), text);
  }

  private ctxOf(rel: string): HandlerCtx {
    const path: PathKind = kindOfPath(this.project, rel);
    return { project: this.project, rel, path };
  }

  private async render(handler: Handler, ctx: HandlerCtx, artifact: Artifact): Promise<string> {
    if (!handler.render) {
      throw new Error(`「${ctx.rel}」不接结构化产物`);
    }
    return handler.render(ctx, artifact);
  }
}

/** 出现次数。用 split 而不是全局正则：`old` 是字面量，不该被当正则解释。 */
function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return text.split(needle).length - 1;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 30 ? `${one.slice(0, 30)}…` : one;
}

/**
 * 追加时拼出最终内容：接在已有内容后面空一行；文件还不存在就是这一段本身。
 *
 * 从前 handler 能给「首次追加带的头」与「两段之间的分隔符」——那是中转站正文用的
 * （拆章的 `---` 断点）。中转站删掉之后再没有种类要它们，钩子一并删了。
 *
 * **正文停在半句上时直接接上**：被截断的那一章「接着写」，新写的是那半句的后半截，中间空一行
 * 就把一句话断成两段（百章实验第 57 章）。只对章节这么做——别的文件结尾没有标点是常事。
 */
function appendText(guarded: { existed: boolean; current?: string }, text: string, prose = false): string {
  if (!guarded.existed) {
    return `${text.trim()}\n`;
  }
  const existing = (guarded.current ?? '').replace(/\s+$/, '');
  const glue = prose && endsMidSentence(existing) ? '' : '\n\n';
  return `${existing}${glue}${text.trim()}\n`;
}

/**
 * 垃圾箱落点：保留原相对路径，同名冲突时加序号，不覆盖之前删掉的东西。实现下沉在数据层（`model/project.ts`），
 * 会话删除（`model/session.ts`）也用这一份——`model/` 不能反过来依赖网关。这里重新导出，调用方不动。
 */
export { trashPathFor };

/** 章号列成「3、5–7、12」：连着的并成一段。 */
function nos(list: readonly number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
      j++;
    }
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join('、');
}

/**
 * 复制一个目录要建哪些目录、拷哪些文件（工作区相对路径，父目录在前）。符号链接不跟进去，记进 `skipped`；
 * 别的特殊文件（管道、套接字）不认，直接略过。
 */
async function copyPlanOf(
  project: NovelProject,
  fromRel: string,
  toRel: string
): Promise<{ dirs: string[]; files: { from: string; to: string }[]; skipped: string[] }> {
  const plan = { dirs: [toRel], files: [] as { from: string; to: string }[], skipped: [] as string[] };
  const walk = async (from: string, to: string): Promise<void> => {
    for (const dirent of await fs.readdir(project.pathOf(from), { withFileTypes: true })) {
      const childFrom = `${from}/${dirent.name}`;
      const childTo = `${to}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        plan.skipped.push(childFrom);
      } else if (dirent.isDirectory()) {
        plan.dirs.push(childTo);
        await walk(childFrom, childTo);
      } else if (dirent.isFile()) {
        plan.files.push({ from: childFrom, to: childTo });
      }
    }
  };
  await walk(fromRel, toRel);
  return plan;
}

async function wordsOf(abs: string): Promise<number | undefined> {
  try {
    return countWords(decodeFileText(await fs.readFile(abs)));
  } catch {
    // 二进制/权限问题：不给字数，也不因此让整次列举失败。
    return undefined;
  }
}

/**
 * 标题 → 文件名词干。**空标题给空串，不给「未命名」**。
 *
 * `sanitizeFileName` 的兜底名是「未命名」，那是给「作者输了一串全是非法
 * 字符的名字」用的。但细纲与场景都允许**没有标题**——流水线新建出来的章
 * 就是纯序号名 `030.md`（标题要等剧情排完才定得下来）。直接套 sanitize 会
 * 得到 `030-未命名.md`：那是个假标题，而且它会进文件名、进段落说法、进
 * 上下文，作者还得手动去掉。
 */
function safeStem(title: string): string {
  return title.trim() ? sanitizeFileName(title) : '';
}

/** 细纲的标题行 `# 第N章 标题`（`renderPlotFile` 写的样子，也认 `：` 分隔与没有标题的 `# 第N章`）。CRLF 的 `\r` 不吃进来。 */
const PLOT_TITLE_LINE = /^(#[ \t]+第[ \t]*\d+[ \t]*章)([：:][ \t]*|[ \t]+|)(.*?)[ \t]*(?=\r?$)/m;

export { WsError, WsConflictError, MAX_EDITABLE_BYTES } from './guard';
export type { WsErrorCode } from './guard';
export { kindOfPath, normalizeRel, pathOfTarget } from './kind';
export type { ArtifactKind, PathKind } from './kind';
// 检索既是 `Workspace` 上的一个方法，也直接导出：三期的 agent 工具手里只有
// 一个 `NovelProject`，不必为了搜一次而先造一个门面。
export { search } from './search';
export type { SearchHit, SearchOptions, SearchResult } from './search';
