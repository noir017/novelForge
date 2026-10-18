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
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { decodeFileText } from '../model/importText';
import {
  countWords,
  hash,
  pad3,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from '../model/fs';
import { Chapter, SummaryCast } from '../model/types';
import { rewriteFrontmatter, stringifyFrontmatter } from '../model/markdown';
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
} from '../model/project';
import {
  PlotSections,
  PreflightOk,
  WritablePlot,
  parsePlotFile,
  plotFileName,
  renderPlotFile,
  renderPreflightOk,
} from '../model/plotFile';
import { Artifact } from '../features/artifact';
import {
  ArtifactKind,
  PathKind,
  kindOfPath,
  normalizeRel,
} from './kind';
import {
  MAX_EDITABLE_BYTES,
  WsError,
  guardMutate,
  guardRead,
  guardWrite,
  isInternalPath,
  reviewOverwrite,
} from './guard';
import { Handler, HandlerCtx, handlerFor } from './handlers';
import { renderFinalizedPlot } from './handlers/plot';
import { snapshotBeforeWrite } from './history';
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
   * （AGENTS 第 3 / 19 条）。留这个开关只给两种调用方：批量路径（它跳过已有
   * 产物，根本走不到覆盖）与内置编辑器（乐观锁已经是它自己那道闸）。
   */
  review?: boolean;
  /** 乐观锁基线。给了就比对，磁盘变过报冲突。 */
  baseHash?: string;
  /** 覆盖审阅框里显示的名字，如「第 12 章的细纲」。 */
  what?: string;
  /**
   * 不跑写后的记账与伴生（`handler.after`），由调用方在一批写完之后补上。**只给 {@link Workspace.createChapters}
   * 用**：章节的 after 只是重算 manifest，逐章重算是 O(n²) 次读盘；别的种类的 after 记的是指纹，不能延后。
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
    const abs = await guardRead(this.project, rel);
    const normalized = normalizeRel(rel)!;
    const full = decodeFileText(await fs.readFile(abs));
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
    const abs = await guardRead(this.project, rel);
    const normalized = normalizeRel(rel)!;
    let text = await readText(abs);
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
   */
  async move(from: string, to: string): Promise<WriteResult> {
    const fromAbs = await guardMutate(this.project, from);
    const fromRel = normalizeRel(from)!;
    const toRel = normalizeRel(to);
    if (toRel === undefined) {
      throw new WsError('outOfRoot', `路径超出工程目录：${to}`);
    }
    // 落点也要过保护与回收站两条：把一份细纲搬成 `.novelforge/plots` 本身，
    // 或者搬进回收站装作删掉，都不该放行。
    await guardWrite(this.project, toRel, { mode: 'create' });

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

    const side = handler.companions ? await handler.companions(ctx, fromRel, toRel) : [];
    if (side.length > 0) {
      log.info(`${fromRel} → ${toRel} 时连带`, side.join('｜'));
    }
    return { rel: toRel, message: `已移动到 ${toRel}`, side };
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
  // 上面六个方法收的是**路径**。下面这几个收的是**领域对象**（一份细纲、
  // 一章正文），因为它们的落点由内容决定：细纲的文件名是「章号 + 标题」，
  // 改标题就是改文件名。调用方手里只有对象，让它自己去拼路径等于把命名规则
  // 复制一份出去。
  //
  // 它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。

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
    return true;
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
   * 渲染规矩在 `handlers/plot.ts` 的 `renderFinalizedPlot`：八节整体替换，作者定的 frontmatter 留着，
   * `sourceHash` 记正文的 `contentHash`（指纹链的最后一环），`writtenFrom` 刷成更新之后的指纹。
   *
   * **旧版先复制一份进 `.trash/`**（保留原相对路径，同名加序号，与第 6 条同一个落点）：定稿按钮本身就是
   * 作者的确认，所以直接写；但改的是一份作者可能逐字推敲过的计划，旧的那一版要找得回来。
   */
  async finalizePlot(
    chapter: Chapter,
    sections: PlotSections,
    cast: SummaryCast[]
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
    });

    let trashed: string | undefined;
    if (current) {
      const dest = await trashPathFor(this.project, current.relPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(this.project.pathOf(current.relPath), dest);
      trashed = this.project.relPath(dest);
    }
    // 回收站那一份照旧（永不裁剪，定稿完成提示里说的就是它）；历史版本里再存一版，编辑器的「历史」面板里
    // 找得到、对比得了——八节整体换掉，节流拦不住它。
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

  /** 写文风指南。同样在链外——它约束怎么写，不由任何一层产物生出来。 */
  async writeStyleGuide(content: string): Promise<string> {
    const rel = this.project.relPath(this.project.stylePath);
    await this.overwrite(rel, `# 文风指南\n\n${content.trim()}\n`);
    return rel;
  }

  /**
   * 写全书滚动摘要，并把水位线记进 manifest。
   *
   * 它的上游是全部定稿过的细纲，但那是一次显式的重建动作（`through` 水位线），
   * 不是 hash 传播——所以没有 `upstreamHash`。
   */
  async writeGlobalSummary(content: string, through: number): Promise<string> {
    const rel = this.project.relPath(this.project.globalSummaryPath);
    const fm = stringifyFrontmatter({ through, generatedBy: 'novel-forge' });
    await this.overwrite(rel, `${fm}\n\n# 全书滚动摘要\n\n${content.trim()}\n`);
    const manifest = await this.project.readManifest();
    manifest.globalSummaryThrough = through;
    await this.project.writeManifest(manifest);
    return rel;
  }

  /**
   * 改写叙事线（七期）：读**此刻**磁盘上的原文 → `edit` 给出新原文 → 写回。`edit` 返回
   * undefined 或原样返回就不写。
   *
   * 为什么不让调用方先读好再交一份全文进来：排线、定稿那一次调用要几十秒，这期间作者可能
   * 正在编辑器里改这份文件。在写之前那一刻重读、只在上面追加，作者那几十秒里的改动才不会
   * 被一份旧的全文冲掉（第 3 条）。链外文件，没有上游指纹。
   */
  async updateThreads(edit: (raw: string) => string | undefined): Promise<string | undefined> {
    const rel = this.project.relPath(this.project.threadsPath);
    const raw = await this.project.readThreadsText();
    const next = edit(raw);
    if (next === undefined || next === raw) {
      return undefined;
    }
    await this.overwrite(rel, next);
    return rel;
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

/** 垃圾箱里保留原相对路径；同名冲突时加序号，不覆盖之前删掉的东西。 */
export async function trashPathFor(project: NovelProject, rel: string): Promise<string> {
  const base = path.join(project.trashDir, rel);
  if (!(await pathExists(base))) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
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

export { WsError, WsConflictError, MAX_EDITABLE_BYTES } from './guard';
export type { WsErrorCode } from './guard';
export { kindOfPath, pathOfTarget } from './kind';
export type { ArtifactKind, PathKind } from './kind';
// 检索既是 `Workspace` 上的一个方法，也直接导出：三期的 agent 工具手里只有
// 一个 `NovelProject`，不必为了搜一次而先造一个门面。
export { search } from './search';
export type { SearchHit, SearchOptions, SearchResult } from './search';
