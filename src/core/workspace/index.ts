/**
 * Workspace —— 工程的**唯一读写网关**。
 *
 * ## 为什么要有它
 *
 * 写盘从前散在六处（`model/project.ts`、`features/creation.ts` 的
 * `acceptArtifact`、`files/fileOps.ts`、`files/fileEditing.ts`、
 * `files/projectFiles.ts`、`features/splitChapter.ts`），**每处各带一部分
 * 保护，谁也不认识谁**。既有落盘路径背着一批不变量，绕过任何一条都会安静地
 * 损坏工程：
 *
 * - 细纲改名要连带搬走场景目录与中转站正文，当普通文件搬会把它们变成孤儿
 * - 场景文件名由「场号 + 标题」决定，改标题要清掉旧文件名
 * - 写正文要记 `beatsHash`，写细纲要记 `upstreamHash`，漏了新鲜度链就断
 * - 删除一律进 `.trash/`；同名目标一律报错退出
 *
 * 所以 `write` 不是「往这个路径写字节」，而是「按这个路径**应有的种类**写一份
 * 合法产物」——种类判定（`kind.ts`）、守卫（`guard.ts`）、渲染/记账/伴生
 * （`handlers/`）在这一层各做一次。
 *
 * ## 记账下沉
 *
 * `upstreamHash` / `beatsHash` 从前**只在采纳路径上记**。作者在内置编辑器里
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
import {
  countWords,
  hash,
  pad3,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from '../model/fs';
import {
  SUMMARY_SECTION_KEYS,
  Chapter,
  SummaryCast,
  SummarySections,
} from '../model/types';
import { stringifyFrontmatter, stringifySections } from '../model/markdown';
import { renderCastEntry } from '../model/castParse';
import { isMarkdownExt, isMarkdownPath, splitByMark } from '../model/chapterFile';
import {
  NovelProject,
  WritableCharacterCard,
  WritableLoreEntry,
  renderCharacterCard,
  renderLoreEntry,
} from '../model/project';
import { WritablePlot, renderPlotFile } from '../model/plotFile';
import { WritableVolume, renderVolumeFile } from '../model/volumeFile';
import { WritableScene, renderSceneFile } from '../model/sceneFile';
import { Artifact } from '../features/artifact';
import {
  ArtifactKind,
  PathKind,
  kindOfPath,
  normalizeRel,
  plotRelPathFor,
  volumeRelPathFor,
} from './kind';
import {
  MAX_EDITABLE_BYTES,
  WsError,
  guardMutate,
  guardRead,
  guardWrite,
  reviewOverwrite,
} from './guard';
import { Handler, HandlerCtx, handlerFor } from './handlers';
import { carryPlotCompanions, trashPlotCompanions, trashRel } from './handlers/plot';
import { carryVolumeCompanions, trashVolumeCompanions } from './handlers/volume';
import { sceneRelPathFor } from './handlers/scene';
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
    const full = await readText(abs);
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

    const text = artifact ? await this.render(handler, ctx, artifact) : (input as { text: string }).text;

    const guarded = await guardWrite(this.project, target, {
      mode,
      baseHash: opts.baseHash,
      text: mode === 'append' ? undefined : text,
    });

    // 步骤 4：覆盖前审阅。**append 不走这一条**——追加不覆盖任何东西。
    if (mode === 'overwrite' && guarded.existed && opts.review !== false) {
      const ok = await reviewOverwrite(opts.what ?? target, target, guarded.current ?? '', text);
      if (!ok) {
        return { rel: target, skipped: true, message: `没有改动 ${target}。` };
      }
    }

    const final = mode === 'append' ? await appendText(guarded, text, handler, ctx) : text;
    await writeText(guarded.abs, final);
    this.project.invalidate();

    const side = handler.after ? await handler.after(ctx, final) : [];
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
   * 伴生搬迁交给 handler：细纲带走场景目录与中转站正文，章节带走草稿。
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

    // 伴生先搬：细纲的场景目录与中转站正文得跟着进回收站，
    // 主文件删完再搬的话，中途失败会留下一堆孤儿。
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
  // 一场戏），因为它们的落点由内容决定：细纲的文件名是「章号 + 标题」，
  // 场景的是「场号 + 标题」，改标题就是改文件名。调用方手里只有对象，
  // 让它自己去拼路径等于把命名规则复制一份出去。
  //
  // 它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。

  /**
   * 写一卷的卷纲，返回工作区相对路径。
   *
   * 与 `writePlot` 同构：文件名由**卷号与标题**共同决定，所以改标题会改文件名。
   * 旧文件必须删掉并把三棵伴生目录（段、场景、中转站正文）搬过去，否则
   * `01-觉醒.md` 与 `01-觉醒之日.md` 并存会变成两卷，而其中一卷的段全成孤儿。
   *
   * @param fromRelPath 改卷号时传原卷纲路径；改标题或新建时不必传。
   */
  async writeVolume(volume: WritableVolume, fromRelPath?: string): Promise<string> {
    const rel = volumeRelPathFor(this.project, volume.no, safeStem(volume.title));
    const previous = fromRelPath
      ? await this.project.readVolume(fromRelPath)
      : (await this.project.listVolumes()).find((v) => v.no === volume.no);

    await writeText(this.project.pathOf(rel), renderVolumeFile(volume));

    if (previous && previous.relPath !== rel) {
      await carryVolumeCompanions(this.project, previous.relPath, rel);
      await fs.unlink(this.project.pathOf(previous.relPath)).catch(() => undefined);
    }
    this.project.invalidate();
    return rel;
  }

  /**
   * 删一卷的卷纲：连同它收纳的剧情段、那些段的场景与中转站正文一起搬进
   * `.trash/`，不真删（AGENTS 第 6 条）。返回是否确实删掉了。
   *
   * **不碰 `chapters/` 与摘要**：与 `deletePlot` 同一条理由——那是作者已经
   * 发布出去的成品，删一份规划稿不该顺手带走它。
   */
  async deleteVolume(volumeRelPath: string): Promise<boolean> {
    const volume = await this.project.readVolume(volumeRelPath);
    if (!volume) {
      return false;
    }
    await trashVolumeCompanions(this.project, volumeRelPath);
    await trashRel(this.project, volumeRelPath);
    this.project.invalidate();
    return true;
  }

  /**
   * 写一段的细纲，返回工作区相对路径。
   *
   * 文件名由**段号与标题**共同决定，所以改标题会改文件名，改段号也会。旧文件
   * 必须删掉并把伴生文件搬过去，否则 `007-入宗.md` 与 `007-入宗风波.md` 并存
   * 会变成两段。
   *
   * 「旧文件是哪一份」有两种问法：
   *
   * - **改标题**（段号没变）：按 `plot.no` 就找得到，这是绝大多数调用。
   * - **改段号**：新号上根本没有旧文件，必须由调用方把原路径经 `fromRelPath`
   *   传进来。不传的话旧文件会留在原地成为孤儿，而它的场景目录与中转站正文
   *   也不会跟着走。
   *
   * **`upstreamHash` 以调用方给的为准**，不在这里补：手工新建的段
   * （`actions.ts` 的 `newPlotFlow`）传的就是空串，它才永远不会挂 ⟳。
   *
   * **落在哪一卷**由 `dir` 说（`plots/01-觉醒之日`）；不给就落在 `plots/` 根下，
   * 那是「未分卷」。改标题时缺省沿用**磁盘上那份所在的目录**——不然给一段改个
   * 名字会把它从它那一卷里搬出来。
   *
   * @param fromRelPath 改段号时传原细纲路径；改标题或新建时不必传。
   * @param dir 落点目录（工作区相对）。不给则沿用旧文件所在目录，再退到 `plots/` 根。
   */
  async writePlot(plot: WritablePlot, fromRelPath?: string, dir?: string): Promise<string> {
    // 换号时新号上是空的，只有调用方知道原来那份在哪。
    const previous = fromRelPath
      ? await this.project.readPlot(fromRelPath)
      : await this.project.getPlot(plot.no);
    const parent = dir ?? (previous ? dirOf(previous.relPath) : undefined);
    const rel = plotRelPathFor(this.project, plot.no, safeStem(plot.title), parent);

    await writeText(this.project.pathOf(rel), renderPlotFile(plot));

    if (previous && previous.relPath !== rel) {
      await carryPlotCompanions(this.project, previous.relPath, rel);
      await fs.unlink(this.project.pathOf(previous.relPath)).catch(() => undefined);
    }
    // 细纲列表有缓存，写完不失效的话下一次读到的还是写之前那份——新建的章
    // 不出现在工程页上，改过标题的章还挂着旧名字。
    this.project.invalidate();
    return rel;
  }

  /**
   * 删一章的细纲：连同场景目录与中转站里的正文一起搬进 `.trash/`，不真删
   * （AGENTS 第 6 条）。返回是否确实删掉了。
   *
   * **不碰 `chapters/` 与摘要**：那两样描述的是已经发布的成品。删掉细纲
   * 只是放弃这一章的规划稿，不该顺手把作者已经拆出去的正文一起带走。
   */
  async deletePlot(plotRelPath: string): Promise<boolean> {
    const plot = await this.project.readPlot(plotRelPath);
    if (!plot) {
      return false;
    }
    await trashPlotCompanions(this.project, plotRelPath);
    await trashRel(this.project, plotRelPath);
    this.project.invalidate();
    return true;
  }

  /**
   * 写一场，返回工作区相对路径。
   *
   * 文件名由场景号与标题决定，所以**改标题会改文件名**：先按场景号找到旧
   * 文件，路径不同就删掉旧的，避免 `02-翻墙.md` 与 `02-翻越侧峰.md` 并存
   * 变成两场。这与章节改名走 `renameEntry` 是两回事——那边是作者在管文件，
   * 这边是产物按自己的命名规则落盘。
   */
  async writeScene(plotRelPath: string, scene: WritableScene): Promise<string> {
    const rel = sceneRelPathFor(this.project, plotRelPath, scene.no, scene.title);
    const previous = await this.project.readScene(plotRelPath, scene.no);
    await writeText(this.project.pathOf(rel), renderSceneFile(scene));
    if (previous && previous.relPath !== rel) {
      await fs.unlink(this.project.pathOf(previous.relPath)).catch(() => undefined);
    }
    return rel;
  }

  /** 删一场：搬进 `.trash/`，不真删。返回是否确实删掉了一场。 */
  async deleteScene(plotRelPath: string, sceneNo: number): Promise<boolean> {
    const scene = await this.project.readScene(plotRelPath, sceneNo);
    if (!scene) {
      return false;
    }
    await trashRel(this.project, scene.relPath);
    return true;
  }

  /**
   * 把文本追加到中转站里那一章的正文末尾，返回工作区相对路径。
   *
   * 正文是**追加**而不是覆盖：一章按场景分几次写，顺序拼起来才是完整的一章。
   * 这也是唯一一条不走覆盖审阅的落盘路径——追加不覆盖任何东西。
   *
   * 两次追加之间插一行 `---`：那是**默认的拆分候选点**（第 23 条）。模型按
   * 场景分几次写，场景边界正是最可能的章节边界；给一个能改的默认，比让作者
   * 从头自己标要好。他可以删掉、也可以另加——拆分只认这一行标记。
   *
   * 写完记 `beatsHash`（正文所依据的场景指纹）。少了这一步，这一章会永远
   * 显示「正文与场景对不上」或永远不显示，两种都是错的。
   */
  async appendToManuscript(plotRelPath: string, text: string): Promise<string> {
    const rel = this.project.manuscriptMirrorRelPath(plotRelPath);
    const r = await this.write(rel, { text }, { mode: 'append' });
    return r.rel;
  }

  /**
   * 把中转站里的一章正文按 `---` 拆成若干章，写进 `chapters/`，
   * 然后把中转站那份搬进回收站。返回建好的章节相对路径。
   *
   * `titles[i]` 对应第 i 片；给空串就落成纯序号名（`101.md`）。
   *
   * **章号从「现有最大章号 + 1」往后连排**，与这一段自己的段号无关：段号只是
   * `plots/` 里的排序键，一段可以拆成三章，两条轴各排各的（见 model/plotFile.ts
   * 的文件头）。从前是从段号起排，于是「一段拆成三章」必须把后面几十段整体
   * 改名让路——那次重命名风暴连带搬场景目录与中转站正文，一次失败就留下一地
   * 孤儿。现在两条轴不再撞号，那一步整个不需要了。
   *
   * 落盘之后把建好的章节路径记进这一段的 frontmatter（`chapters`）：这是
   * 「段 → 章」唯一的链，界面据此知道这一段已经交付，也据此从任一章回到
   * 它的规划稿。`chapters/` 下的文件是作者的东西，拆分之后一个字节都不改，
   * 所以这条链只能记在段这一侧。
   */
  async splitManuscript(plotRelPath: string, titles: string[]): Promise<string[]> {
    const manuscript = await this.project.readManuscript(plotRelPath);
    if (!manuscript) {
      throw new Error(`这一章还没有正文可拆：${plotRelPath}`);
    }
    const pieces = splitByMark(manuscript.text);
    if (pieces.length === 0) {
      throw new Error(`这一章的正文是空的，没有可拆的内容：${manuscript.relPath}`);
    }
    const startNo = (await this.project.nextChapterNo()) ?? 1;

    const created: string[] = [];
    for (const [i, piece] of pieces.entries()) {
      created.push(await this.createChapter(startNo + i, titles[i] ?? '', piece));
    }
    // 全部落盘成功才动原件。中途抛出的话中转站那份还在，作者可以重来。
    await trashRel(this.project, manuscript.relPath);
    this.project.invalidate();

    // 记下「这一段交付到了哪几章」。**追加而不是覆盖**：作者可能把一段的正文
    // 分两次拆（先拆前半段、又往中转站续写后半段再拆一次）。
    const plot = await this.project.readPlot(plotRelPath);
    if (plot) {
      await this.writePlot(
        { ...plot, chapters: [...plot.chapters, ...created.filter((c) => !plot.chapters.includes(c))] },
        plot.relPath
      );
    }
    await this.project.syncManifest();
    return created;
  }

  /**
   * 新建章节文件，返回工作区相对路径。
   *
   * `dir` 是工作区相对的落点目录（如 `chapters/第一卷`），缺省落在 chapters/ 根下。
   * `ext` 默认 `.md`：扫描时认任意扩展名，但插件自己建的东西仍然出 markdown。
   * 非 markdown 家族不写标题行。
   *
   * **`title` 留空是合法的**，落成纯序号名 `001.md`——拆分出来的第 2 章往后
   * 就是这个样子（标题等作者自己改）。
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
    const stem = safeStem(title);
    const fileName = stem ? `${pad3(order)}-${stem}${ext}` : `${pad3(order)}${ext}`;
    const parent = dir ? normalizeRel(dir) : this.project.relPath(this.project.chaptersDir);
    const rel = parent ? `${parent}/${fileName}` : fileName;
    const text = isMarkdownExt(ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;

    // 走 write：同名一律报错退出（第 3 条），manifest 由 chapter handler 同步。
    await this.write(rel, { text }, { mode: 'create' });
    return rel;
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
   * 写一章的摘要。落点镜像**章节**路径（`summaryPathForChapter`）。
   *
   * `sourceHash` 记的是**成品**的 `contentHash`——摘要描述的是已发布的那一章
   * （指纹链的最后一环）。
   *
   * 落盘仍是 Markdown（第 14 条：作者要手改），结构化的出场人物写进
   * frontmatter 的 `cast`。
   */
  async writeSummary(
    chapter: Chapter,
    sourceHash: string,
    sections: SummarySections,
    cast: SummaryCast[] = []
  ): Promise<string> {
    const rel = this.project.relPath(this.project.summaryPathForChapter(chapter.relPath));
    const fm = stringifyFrontmatter({
      chapter: chapter.order,
      title: chapter.title,
      sourceHash,
      // 机器可读的出场人物。别名跟在名字后的括号里：`林昭(阿昭)`——
      // frontmatter 解析器只认字符串数组，不要为此引入嵌套 YAML。
      cast: cast.map(renderCastEntry),
      generatedBy: 'novel-forge',
    });
    const body = stringifySections(
      sections as unknown as Record<string, string>,
      SUMMARY_SECTION_KEYS,
      { keepEmpty: true }
    );
    const text = `${fm}\n\n# 第${chapter.order}章${chapter.title ? ` ${chapter.title}` : ''} · 摘要\n\n${body}\n`;

    await writeText(this.project.pathOf(rel), text);
    await this.project.markSummarized(chapter.relPath, sourceHash);
    return rel;
  }

  /**
   * 写一张角色卡。slug 可以带子目录前缀（如 `主角/林昭`），中间目录自动补齐。
   *
   * 角色卡**不在生产链上**：它是横切的记忆，被装配进 prompt，但不由某一层
   * 产物「生出来」，所以没有上游指纹要记。
   */
  async writeCharacter(card: WritableCharacterCard): Promise<string> {
    const rel = `${this.project.relPath(this.project.charactersDir)}/${card.slug}.md`;
    await writeText(this.project.pathOf(rel), renderCharacterCard(card));
    return rel;
  }

  /** 写一条设定。与角色卡同类：链外的横切知识，无上游指纹。 */
  async writeLore(entry: WritableLoreEntry): Promise<string> {
    const rel = `${this.project.relPath(this.project.loreDir)}/${entry.slug}.md`;
    await writeText(this.project.pathOf(rel), renderLoreEntry(entry));
    return rel;
  }

  /** 写文风指南。同样在链外——它约束怎么写，不由任何一层产物生出来。 */
  async writeStyleGuide(content: string): Promise<string> {
    const rel = this.project.relPath(this.project.stylePath);
    await writeText(this.project.pathOf(rel), `# 文风指南\n\n${content.trim()}\n`);
    return rel;
  }

  /**
   * 写全书滚动摘要，并把水位线记进 manifest。
   *
   * 它的上游是全部单章摘要，但那是一次显式的重建动作（`through` 水位线），
   * 不是 hash 传播——所以没有 `upstreamHash`。
   */
  async writeGlobalSummary(content: string, through: number): Promise<string> {
    const rel = this.project.relPath(this.project.globalSummaryPath);
    const fm = stringifyFrontmatter({ through, generatedBy: 'novel-forge' });
    await writeText(
      this.project.pathOf(rel),
      `${fm}\n\n# 全书滚动摘要\n\n${content.trim()}\n`
    );
    const manifest = await this.project.readManifest();
    manifest.globalSummaryThrough = through;
    await this.project.writeManifest(manifest);
    return rel;
  }

  // ---------------------------------------------------------------- 内部

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
 * 追加时拼出最终内容。
 *
 * 首次写入带上 handler 给的头（正文是 frontmatter + `# 第N章… · 正文`），
 * 之后在两段之间插 handler 给的分隔符——正文那一行 `---` 是**默认的拆分
 * 候选点**（第 23 条），其余种类只空一行。
 */
async function appendText(
  guarded: { existed: boolean; current?: string },
  text: string,
  handler: Handler,
  ctx: HandlerCtx
): Promise<string> {
  if (!guarded.existed) {
    const head = handler.appendHead ? await handler.appendHead(ctx) : '';
    return `${head}${text.trim()}\n`;
  }
  const existing = (guarded.current ?? '').replace(/\s+$/, '');
  return `${existing}${handler.appendSeparator ?? '\n\n'}${text.trim()}\n`;
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
    return countWords(await fs.readFile(abs, 'utf8'));
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

/**
 * 一个工作区相对路径所在的目录（`plots/01-卷/003-x.md` → `plots/01-卷`）。
 * 根下的文件给空串——`plotRelPathFor` 收到空就落回 `plots/` 根。
 */
function dirOf(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? '' : rel.slice(0, slash);
}
