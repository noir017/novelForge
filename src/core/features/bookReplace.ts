/**
 * 全书替换（独立版「编辑 → 全书查找替换…」→「预览替换」→「替换所选」）：把预览里勾着的那几处，经网关逐份写下去。
 * 查找与预览在 `views/bookFind.ts`（只读），这里只写。
 *
 * ## 一份文件怎么写（顺序不能换）
 *
 * 1. **编辑器里有未保存修改的跳过**（前端随请求带来 `dirty`）：拿磁盘上的内容替换完写下去，编辑区那份未保存的修改要么
 *    被冲突条拦住、要么被作者一保存就盖掉替换——两头都不对。让作者先保存或放弃，再换一次。
 * 2. **乐观锁**：读磁盘上此刻那一份，hash 与预览时读到的（`file.hash`）对不上就跳过——预览之后它被改过，不拿预览时的
 *    内容替换完盖上去（第 3 条）。写的时候再带一次基线（`baseHash`），读与写之间又被改过，网关照样拒。
 * 3. **勾着的那几处在磁盘上那一份里逐处核对**（与预览同一个口径：`model/bookFind.ts` 的 `fileHits`，护住的字不算），
 *    再用 `textFind.replaceSelectedIn` 只换这几处——`$1` 在原文里逐处展开。
 * 4. **先强制存一版历史**（`snapshotNow`，跳过节流，与「恢复历史版本前强制存一版」同一个做法）：存档点（见下）存不下不挡替换，
 *    兜底的退路是每份文件在「历史」里的替换前那一版。存不下（还不是小说工程、超过 2 MB、出错）就**不换这一份**，说出来。
 * 5. **经网关写**：`workspace.write`，`mode: 'overwrite'`、`review: false`（预览本身就是审阅，第 19 条：落盘前人看过了，
 *    网关不再弹第二次覆盖审阅）、带 `baseHash`。守卫照过、种类的记账照做（细纲照常记 `upstreamHash`）、覆盖前的那一版
 *    网关自己也会再试着存（与刚存的一样，不重复存）。章节的写后记账（重算 manifest）延到最后做一次（`deferAfter`）。
 *
 * 写的顺序按范围：其他创作文件（情节大纲在里面）→ 细纲 → 正文 → 草稿 → 角色卡 → 设定。大纲排在细纲之前：细纲写下去时
 * 网关记的是大纲**此刻**那一条的指纹，大纲先换完，同一次里一起换了的细纲才对得上换过的大纲。
 *
 * 逐份写之前（有要换的才）先存一个存档点（`features/checkpoint.ts`）：整本退得回替换之前。
 *
 * ## 指纹链（第 18 条，⚑）
 *
 * 替换只是换字，**不该改变任何一章的新鲜度判断**——除了一种情况：同一次替换里，一章的细纲与正文**都**改了（「把林晚全书
 * 改成林婉」），改之前这一环对得上，那么改之后它们仍是同一次替换的两头，指纹跟着刷新：
 *
 * - `writtenFrom`（正文据以写成的细纲指纹）刷成替换之后的细纲指纹——不然几百章的正文一起挂 ⟳，全是误报；
 * - 定稿过的章，`sourceHash`（定稿时正文的指纹）刷成替换之后的正文指纹——不然几百章一起退回「待定稿」，主按钮推着作者
 *   把整本书重新定稿一遍（第 4、20 条）。
 *
 * 其余照常、而且照实说出来（汇总里列章）：**只改了细纲**、正文没跟着改（正文不在范围里、没有这个词、被勾掉、未保存跳过了）——
 * 正文挂 ⟳，那是对的：计划变了，正文可能跟不上；**只改了正文**、细纲没跟着改的定稿过的章——回到「待定稿」，定稿那份
 * 细纲还说着旧的；**只改了情节大纲**、细纲没跟着改——那几章的细纲挂 ⟳。改之前就已经对不上的（本来就挂着 ⟳、本来就
 * 待定稿）不刷——那不是这次替换造成的。
 *
 * 细纲自己的上游（`upstreamHash`，大纲里这一章那一条）同一个原则：网关写细纲时总是记下大纲此刻的指纹（「谁写都记」），
 * 这里把它退回替换之前的判断——本来挂着 ⟳ 的照旧挂（恢复原来那个指纹），本来没记过的照旧不记（第 18a 条：手写的不进链）；
 * 本来对得上的，就是网关刚记的那一个（大纲与细纲在这一次里一起换了的，正好对上）。
 *
 * 角色卡「当前状态」的 `stateHash`、设定条目的 `bodyHash` **不刷**（⚑）：替换就是作者的改动，下次定稿 / 整合时机器照规矩
 * 把它们当作「作者改过」——不直接覆盖、先对比（第 19、27 条）。
 *
 * ## 不做的事
 *
 * 不改文件名、不搬文件（角色卡的名字换了，`林晚.md` 还叫 `林晚.md`——认人看的是卡里的名字与别名，汇总里提一句）；
 * 跨文件的一步撤销不在这里（整本退回走存档点，每份文件的历史版本兜底）；派生数据（工程树、出场索引、设定名录）
 * 不在这里算——它们都从磁盘现算，控制器替换完照常 `pushState`。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { asArray, asString, extractH1, parseMarkdown } from '../model/markdown';
import { NovelProject } from '../model/project';
import { Plot, parsePlotFile, plotContentHash } from '../model/plotFile';
import { isOutlineUpstreamStale } from '../model/outlineFile';
import { BookFindScope, isBookFindScope } from '../model/bookFindScope';
import { fileHits } from '../model/bookFind';
import { compileSearch, replaceSelectedIn } from '../model/textFind';
import { Workspace, kindOfPath, normalizeRel } from '../workspace';
import type { ArtifactKind } from '../workspace';
import { WsConflictError, WsError, guardRead } from '../workspace/guard';
import { snapshotNow } from '../workspace/history';
import { bookFileLabel, clip, scopeOfKind } from '../views/bookFind';
import { checkpointBefore } from './checkpoint';
import type {
  BookReplaceDone,
  BookReplaceRenamedCard,
  BookReplaceRequest,
  BookReplaceSkipReason,
  BookReplaceSkipped,
  BookReplaceSummary,
} from '../protocol';

const log = scoped('全书替换');

/** 核对过、算好了新内容、等着写的一份。 */
interface Prepared {
  rel: string;
  label: string;
  kind: ArtifactKind;
  scope: BookFindScope;
  text: string;
  next: string;
  /** 网关乐观锁的基线：与 `guardWrite` 同一个读法（按 UTF-8 读出来的那一份）。 */
  lockHash: string;
  count: number;
}

/** 一份细纲在替换之前的指纹链判断（第 18 条）。 */
interface ChainBefore {
  plot: Plot;
  /** 镜像它的那一章正文（有正文才有）。 */
  chapterRel?: string;
  chapterLabel?: string;
  /** 大纲 → 细纲：没记过 / 对得上 / 对不上，以及原来记的那个。 */
  upstream: 'none' | 'fresh' | 'stale';
  /** 细纲 → 正文（`writtenFrom`）：有正文、记过、对得上。 */
  writtenFresh: boolean;
  /** 正文 → 定稿（`sourceHash`）：有正文、定稿过、对得上。 */
  sourceFresh: boolean;
}

const MESSAGE: Record<Exclude<BookReplaceSkipReason, 'noHistory' | 'error'>, string> = {
  dirty: '编辑器里有未保存的修改：先保存（或放弃修改），再替换一次。',
  changed: '预览之后这份文件改过了（编辑器里存过、或别处改过）：没有拿预览时的内容盖上去，重新预览一次。',
  gone: '磁盘上已经没有这份文件了（被删或改了名）。',
  mismatch: '勾着的那几处在这份文件里对不上了：重新预览一次。',
  unchanged: '换完与原来一字不差，没有写。',
  outOfScope: '不在这次全书替换勾着的范围里，没有动。',
};

export async function replaceInBook(project: NovelProject, req: BookReplaceRequest): Promise<BookReplaceSummary> {
  const summary: BookReplaceSummary = {
    files: 0,
    hits: 0,
    replaced: [],
    skipped: [],
    chainKept: [],
    plotOnly: [],
    bodyOnly: [],
    outlineOnly: [],
    renamedCards: [],
  };
  const query = typeof req.query === 'string' ? req.query : '';
  const replacement = typeof req.replacement === 'string' ? req.replacement : '';
  const opts = { caseSensitive: req.caseSensitive === true, regex: req.regex === true };
  const compiled = compileSearch(query, opts);
  if (!compiled) {
    return { ...summary, error: '查找的内容是空的，没有替换。' };
  }
  if (!compiled.ok) {
    return { ...summary, error: `正则写错了，没有替换（${compiled.error}）。` };
  }
  const scopes = new Set((Array.isArray(req.scopes) ? req.scopes : []).filter(isBookFindScope));
  const dirty = new Set(
    (Array.isArray(req.dirty) ? req.dirty : []).map((p) => (typeof p === 'string' ? normalizeRel(p) : undefined)).filter(Boolean)
  );
  const skip = (rel: string, reason: BookReplaceSkipReason, message?: string) => {
    const s: BookReplaceSkipped = {
      path: rel,
      label: bookFileLabel(project, rel),
      reason,
      message: message ?? MESSAGE[reason as keyof typeof MESSAGE] ?? '',
    };
    summary.skipped.push(s);
  };

  // ---- 1. 逐份核对、算好新内容（只读）
  project.invalidate();
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(req.files) ? req.files : []) {
    const rel = typeof file?.path === 'string' ? normalizeRel(file.path) : undefined;
    if (!rel || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const picks = (Array.isArray(file.hits) ? file.hits : []).filter(
      (h) => Number.isInteger(h?.start) && Number.isInteger(h?.end) && h.end > h.start
    );
    if (picks.length === 0) {
      continue;
    }
    const kind = kindOfPath(project, rel).kind;
    const scope = scopeOfKind(kind);
    if (!scope || !scopes.has(scope)) {
      skip(rel, 'outOfScope');
      continue;
    }
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(await guardRead(project, rel));
    } catch (err) {
      if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        skip(rel, 'gone');
      } else {
        skip(rel, 'error', `读不了：${describe(err)}`);
      }
      continue;
    }
    const text = decodeFileText(bytes);
    if (hash(text) !== file.hash) {
      skip(rel, 'changed');
      continue;
    }
    const open = new Set(fileHits(text, kind, query, opts).matches.map((m) => `${m.start}:${m.end}`));
    if (!picks.every((h) => open.has(`${h.start}:${h.end}`))) {
      skip(rel, 'mismatch');
      continue;
    }
    const plan = replaceSelectedIn(text, picks, query, replacement, opts);
    if (!plan || plan.missed.length > 0) {
      skip(rel, 'mismatch');
      continue;
    }
    if (plan.text === text) {
      skip(rel, 'unchanged');
      continue;
    }
    prepared.push({
      rel,
      label: bookFileLabel(project, rel),
      kind,
      scope,
      text,
      next: plan.text,
      lockHash: hash(bytes.toString('utf8')),
      count: plan.replaced.length,
    });
  }

  // ---- 2. 替换之前的指纹链判断（第 18 条）
  const chapters = await project.listChapters();
  const chapterByPlot = new Map<string, { rel: string; contentHash: string }>();
  for (const c of chapters) {
    const mirror = project.plotMirrorOf(c.relPath);
    if (mirror && !chapterByPlot.has(mirror)) {
      chapterByPlot.set(mirror, { rel: c.relPath, contentHash: c.contentHash });
    }
  }
  const outline = await project.readOutline();
  const chainBefore = new Map<string, ChainBefore>();
  for (const p of prepared.filter((x) => x.kind === 'plot')) {
    const plot = parsePlotFile(p.text, p.rel);
    const chapter = chapterByPlot.get(p.rel);
    chainBefore.set(p.rel, {
      plot,
      chapterRel: chapter?.rel,
      chapterLabel: chapter ? bookFileLabel(project, chapter.rel) : undefined,
      upstream: !plot.upstreamHash ? 'none' : isOutlineUpstreamStale(plot.upstreamHash, outline, plot.no) ? 'stale' : 'fresh',
      writtenFresh: !!chapter && !!plot.writtenFrom && plot.writtenFrom === plotContentHash(plot),
      sourceFresh: !!chapter && !!plot.sourceHash && plot.sourceHash === chapter.contentHash,
    });
  }
  // 要换的正文：替换之前它镜像的那份细纲定稿过、对得上它没有（细纲也在这一次里的，上面已经算过；没在的这里读一次）。
  // 写完之后正文换了、细纲没换（不在这一次里，或者在、却被跳过了）的，就是「只改了正文」。
  const contentHashOf = new Map(chapters.map((c) => [c.relPath, c.contentHash]));
  const finalizedBodies = new Map<string, { mirror: string; fresh: boolean }>();
  for (const p of prepared.filter((x) => x.kind === 'chapter')) {
    const mirror = project.plotMirrorOf(p.rel);
    if (!mirror) {
      continue;
    }
    const known = chainBefore.get(mirror);
    if (known) {
      finalizedBodies.set(p.rel, { mirror, fresh: known.sourceFresh });
      continue;
    }
    const plot = await project.readPlot(mirror);
    const bodyHash = contentHashOf.get(p.rel);
    finalizedBodies.set(p.rel, { mirror, fresh: !!plot?.sourceHash && !!bodyHash && plot.sourceHash === bodyHash });
  }

  // ---- 3. 逐份存一版历史、经网关写
  if (prepared.length > 0) {
    // 先存一个存档点（features/checkpoint.ts）：一次改很多份，整本退得回去（每份的历史版本照存）。
    await checkpointBefore(project, `全书替换之前（「${clip(query, 12)}」→「${clip(replacement, 12)}」，${prepared.length} 份）`);
  }
  const ws = new Workspace(project);
  const written = new Set<string>();
  let wroteChapter = false;
  for (const p of [...prepared].sort((a, b) => WRITE_RANK[a.scope] - WRITE_RANK[b.scope])) {
    const snap = await snapshotNow(project, p.rel);
    if (!snap.saved && snap.skipped !== 'same') {
      if (snap.skipped === 'missing') {
        skip(p.rel, 'gone');
      } else {
        skip(p.rel, 'noHistory', noHistoryMessage(snap.skipped, snap.error));
      }
      continue;
    }
    try {
      await ws.write(p.rel, { text: p.next }, {
        mode: 'overwrite',
        review: false,
        baseHash: p.lockHash,
        deferAfter: p.kind === 'chapter',
      });
    } catch (err) {
      if (err instanceof WsConflictError) {
        skip(p.rel, 'changed');
      } else if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        skip(p.rel, 'gone');
      } else {
        skip(p.rel, 'error', `没写成：${describe(err)}`);
      }
      continue;
    }
    written.add(p.rel);
    wroteChapter ||= p.kind === 'chapter';
    const done: BookReplaceDone = { path: p.rel, label: p.label, count: p.count };
    summary.replaced.push(done);
    summary.files++;
    summary.hits += p.count;
    if (p.kind === 'character') {
      const renamed = renamedCard(p);
      if (renamed) {
        summary.renamedCards.push(renamed);
      }
    }
  }
  if (wroteChapter) {
    // 章节的写后记账（重算 manifest）延到这里做一次：逐章做是 O(n²) 次读盘。
    await project.syncManifest();
  }

  // ---- 4. 指纹链收尾（第 18 条）
  project.invalidate();
  const chaptersAfter = new Map((await project.listChapters()).map((c) => [c.relPath, c.contentHash]));
  for (const [plotRel, before] of chainBefore) {
    if (!written.has(plotRel)) {
      continue;
    }
    const after = await project.readPlot(plotRel);
    if (!after) {
      continue;
    }
    const patch: { upstreamHash?: string; writtenFrom?: string; sourceHash?: string } = {};
    // 大纲 → 细纲：退回替换之前的判断（网关写细纲时总是记下大纲此刻的指纹）。
    if (before.upstream === 'stale' && after.upstreamHash !== before.plot.upstreamHash) {
      patch.upstreamHash = before.plot.upstreamHash;
    } else if (before.upstream === 'none' && after.upstreamHash) {
      patch.upstreamHash = undefined;
    }
    if (before.chapterRel && written.has(before.chapterRel)) {
      // 细纲与正文这一次都改了：原本对得上的那一环刷成替换之后的。
      let kept = false;
      if (before.writtenFresh) {
        patch.writtenFrom = plotContentHash(after);
        kept = true;
      }
      const bodyHash = chaptersAfter.get(before.chapterRel);
      if (before.sourceFresh && bodyHash) {
        patch.sourceHash = bodyHash;
        kept = true;
      }
      if (kept && before.chapterLabel) {
        summary.chainKept.push(before.chapterLabel);
      }
    } else if (before.chapterRel && before.writtenFresh && before.chapterLabel) {
      summary.plotOnly.push(before.chapterLabel);
    }
    if (Object.keys(patch).length > 0) {
      await ws.restampPlotChain(plotRel, patch);
    }
  }
  for (const [chapterRel, { mirror, fresh }] of finalizedBodies) {
    if (fresh && written.has(chapterRel) && !written.has(mirror)) {
      summary.bodyOnly.push(bookFileLabel(project, chapterRel));
    }
  }
  // 改了情节大纲：哪几章那一条变了、那几章的细纲这一次没跟着改——它们挂 ⟳，说出来。
  const outlineRel = project.relPath(project.outlinePath);
  if (written.has(outlineRel)) {
    const outlineAfter = await project.readOutline();
    for (const plot of await project.listPlots()) {
      if (written.has(plot.relPath) || !plot.upstreamHash) {
        continue;
      }
      if (!isOutlineUpstreamStale(plot.upstreamHash, outline, plot.no) && isOutlineUpstreamStale(plot.upstreamHash, outlineAfter, plot.no)) {
        summary.outlineOnly.push(bookFileLabel(project, plot.relPath));
      }
    }
  }

  log.info(
    `全书替换「${clip(query)}」→「${clip(replacement)}」`,
    [
      `${summary.files} 个文件 ${summary.hits} 处`,
      summary.skipped.length ? `跳过 ${summary.skipped.length} 份：${summary.skipped.map((s) => `${s.path}（${s.reason}）`).join('、')}` : '',
      summary.chainKept.length ? `细纲与正文一起改了、指纹跟着刷新：${summary.chainKept.join('、')}` : '',
      summary.plotOnly.length ? `只改了细纲（正文挂 ⟳）：${summary.plotOnly.join('、')}` : '',
      summary.bodyOnly.length ? `只改了正文（回到待定稿）：${summary.bodyOnly.join('、')}` : '',
      summary.outlineOnly.length ? `只改了大纲（细纲挂 ⟳）：${summary.outlineOnly.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜')
  );
  return summary;
}

/** 写的顺序：其他创作文件（大纲）在细纲之前，见文件头。按范围写成一张表——加了新范围忘了排，编译不过。 */
const WRITE_RANK: Record<BookFindScope, number> = { doc: 0, plot: 1, chapter: 2, draft: 3, character: 4, lore: 5 };

function noHistoryMessage(reason: string | undefined, error: string | undefined): string {
  if (reason === 'notTracked') {
    return '这个目录还不是小说工程（没有 .novelforge/），存不了历史版本——这次替换的退路就是历史版本，所以没有替换。';
  }
  if (reason === 'tooLarge') {
    return '超过 2 MB，存不了历史版本——没有替换。';
  }
  return `没能先存一版历史（${error ?? '原因不明'}）——这次替换的退路就是历史版本，所以没有替换。`;
}

/** 角色卡认人用的名字（与 `NovelProject.listCharacters` 同一个取法）与别名。 */
function cardIdentity(text: string, rel: string): { name: string; aliases: string[] } {
  const { frontmatter, body } = parseMarkdown(text);
  return {
    name: asString(frontmatter.name) || extractH1(body) || path.posix.basename(rel).replace(/\.md$/i, ''),
    aliases: asArray(frontmatter.aliases),
  };
}

/** 角色卡的名字或别名换了：汇总里提一句文件名没跟着改。 */
function renamedCard(p: Prepared): BookReplaceRenamedCard | undefined {
  const before = cardIdentity(p.text, p.rel);
  const after = cardIdentity(p.next, p.rel);
  const nameChanged = before.name !== after.name;
  if (!nameChanged && before.aliases.join('\n') === after.aliases.join('\n')) {
    return undefined;
  }
  return { path: p.rel, label: p.label, name: after.name, nameChanged };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
