/**
 * 叙事线的计划事件随细纲走（叙事线二期，设计见 docs/design/plans/2026-10-20-narrative-threads.md「二」与「谁能写什么」）：
 * 第 N 章的细纲写入时，各条线里第 N 章的计划事件**整组换掉**；埋了一条没见过的伏笔，在它挂的那条线（挂不上就是
 * 「未归属的伏笔」）的「伏笔」末尾加一行。细纲里不再有任何关于线的小节——计划只记在线里。
 *
 * - **写入卡片上先列出来**（{@link describeThreadPlan}，第 19 条的例外清单：与「细纲带出的新角色随细纲一起建卡」同一类）；
 *   批量拆细纲没有卡片，确认框就是那一问（同新角色建卡）。
 * - **只在细纲真的写进去之后才换**：作者在覆盖审阅里放弃了的、批量里跳过已有的，那一章的计划一条不动
 *   （generation/accept.ts 只把写进去的那几章交过来）。合同里没写 `threads`（老会话里的草稿、手写的 Markdown）也不动。
 * - **外科式**：都在写之前那一刻重读（`Workspace.updateThread`），只换那几章的计划事件、只在「伏笔」末尾加行
 *   （model/threadFile.ts 的 `replacePlannedEvents` / `appendForeshadowing`）；别的章、实际事件、作者写的行一个字不动，
 *   旧版由网关存历史。
 * - 认线、认伏笔在 model/threadFile.ts 的 `resolvePlanEvents`：线的事件认不出是哪条线就丢掉，伏笔的事件跟着伏笔走，没见过的
 *   伏笔被埋了就登记成新伏笔，没埋就「收」的丢掉。没写进去的在卡片与日志里说出来（第 2 条）。
 * - **到期却没安排的伏笔**（复跑之后，`unplannedDue`）：这几章里该埋、该收的伏笔，计划里既没安排、也没写推迟的，列在卡片
 *   与日志里（批量拆细纲没有卡片，完成提示说一句「见日志」）。不调模型，也不拦人。
 *
 * 零调用：计划是细纲合同里顺带的一个字段（设计稿「调用次数」：+0）。
 */
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { CreationTarget, plotOfTarget } from '../model/pipeline';
import { parsePlotFileName } from '../model/plotFile';
import {
  Foreshadowing,
  PlanEntry,
  PlannedChapter,
  ThreadEvent,
  UNFILED_NAME,
  UNFILED_TEMPLATE,
  appendForeshadowing,
  describeUnplannedDue,
  isForeshadowEvent,
  replacePlannedEvents,
  resolvePlanEvents,
  threadKey,
  unplannedDue,
} from '../model/threadFile';
import { Workspace } from '../workspace';
import type { Artifact } from './artifact';

const log = scoped('叙事线');

/** 一章要写进去的计划（细纲合同里那一章的 `threads`）。 */
export interface ChapterPlan {
  no: number;
  entries: readonly PlanEntry[];
}

/** {@link writePlannedThreads} 的结果。 */
export interface PlanWriteOutcome {
  /** 写进去的计划事件。 */
  written: number;
  /** 换掉的旧计划事件。 */
  removed: number;
  /** 新登记的伏笔。 */
  newForeshadowing: string[];
  /** 没写进去的（解码时就没收的、认不出是哪条线的、线的文件这几秒里没了的）。 */
  dropped: string[];
  /** 这几章里到期、却没安排的伏笔（复跑之后的程序检查，`unplannedDue`；不拦，只说出来）。 */
  unplanned: string[];
}

/** 落在哪条线上的键（缺席是「未归属的伏笔」，键是空串）。 */
const lineKey = (line: string | undefined): string => (line ? threadKey(line) : '');

/**
 * 把这几章的计划写进各条线：每一章整组换掉、新伏笔登记在线下。`notes` 是解码时就没收的那几条（一并记进结果与日志）。
 * 不弹框、不抛（写盘失败照常抛给调用方——细纲已经写进去了，由调用方说一句）。
 */
export async function writePlannedThreads(
  project: NovelProject,
  chapters: readonly ChapterPlan[],
  notes: readonly string[] = []
): Promise<PlanWriteOutcome> {
  const out: PlanWriteOutcome = { written: 0, removed: 0, newForeshadowing: [], dropped: [...notes], unplanned: [] };
  if (chapters.length > 0) {
    const book = await project.readThreads();
    const planned = resolvePlanEvents(book, chapters);
    out.dropped.push(...droppedOf(planned));
    out.unplanned = unplannedDue(book, chapters).map(describeUnplannedDue);
    const ws = new Workspace(project);
    const files: { rel: string; line?: string }[] = [
      ...book.threads.map((t) => ({ rel: t.relPath, line: t.name })),
      { rel: book.unfiled.relPath },
    ];
    for (const f of files) {
      const key = lineKey(f.line);
      const mine = (c: PlannedChapter): ThreadEvent[] => c.events.filter((e) => lineKey(e.line) === key).map((e) => e.event);
      const fores: Foreshadowing[] = planned.flatMap((c) =>
        c.newForeshadowing.filter((x) => lineKey(x.line) === key).map((x) => x.foreshadowing)
      );
      const fresh = planned.reduce((n, c) => n + mine(c).length, 0);
      let gone = false;
      let written = 0;
      let removed = 0;
      let added: Foreshadowing[] = [];
      await ws.updateThread(f.rel, (raw) => {
        const exists = !!raw.trim();
        if (!exists && (f.line || (fresh === 0 && fores.length === 0))) {
          // 线的文件这几秒里没了；「未归属的伏笔」没有、也没有要写的，就不建。
          gone = !!f.line && fresh + fores.length > 0;
          return undefined;
        }
        // 先登记伏笔再写事件：事件里出现过的名字会被当成已经有了（appendForeshadowing 的去重口径）。
        const withFore = appendForeshadowing(exists ? raw : UNFILED_TEMPLATE, fores);
        added = withFore.added;
        let text = withFore.text;
        for (const c of planned) {
          const events = mine(c).map(({ type, foreshadowing, what }) => ({ type, ...(foreshadowing ? { foreshadowing } : {}), what }));
          const r = replacePlannedEvents(text, c.no, events);
          text = r.text;
          removed += r.removed;
          written += events.length;
        }
        return text;
      });
      if (gone) {
        out.dropped.push(`${f.line} 上的 ${fresh + fores.length} 条（这条线的文件找不到了，改了名或删了）`);
      }
      out.written += written;
      out.removed += removed;
      out.newForeshadowing.push(...added.map((x) => x.name));
    }
  }
  const where = chapters.length === 1 ? `第 ${chapters[0].no} 章` : `${chapters.length} 章`;
  if (out.written + out.removed + out.newForeshadowing.length > 0) {
    log.info(
      `${where}的叙事线计划已写进各条线`,
      `写进 ${out.written} 条，换掉原来的 ${out.removed} 条${out.newForeshadowing.length > 0 ? `，新伏笔 ${out.newForeshadowing.join('、')}` : ''}`
    );
  }
  if (out.dropped.length > 0) {
    log.warn(`${where}的叙事线计划有 ${out.dropped.length} 条没写进去`, out.dropped.join('\n'));
  }
  if (out.unplanned.length > 0) {
    log.warn(`${where}里到期的伏笔有 ${out.unplanned.length} 条没安排（既没埋 / 收，也没写推迟）`, out.unplanned.join('\n'));
  }
  return out;
}

/** 写入之后 toast 里那半句：「，叙事线记下 5 条计划（换掉原来的 2 条），新伏笔：玉佩的来历；1 条没写进叙事线（见日志）」。 */
export function describePlanWrite(o: PlanWriteOutcome): string {
  const parts = [
    o.written > 0 || o.removed > 0 ? `叙事线记下 ${o.written} 条计划${o.removed > 0 ? `（换掉原来的 ${o.removed} 条）` : ''}` : '',
    o.newForeshadowing.length > 0 ? `新伏笔：${o.newForeshadowing.join('、')}` : '',
    o.dropped.length > 0 ? `${o.dropped.length} 条计划没写进叙事线（见日志）` : '',
    o.unplanned.length > 0 ? `${o.unplanned.length} 条到期的伏笔没安排（见日志）` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `，${parts.join('，')}` : '';
}

/** 没写进去的那几条：`第 13 章 某线 推进（认不出是哪一条线）`。 */
function droppedOf(planned: readonly PlannedChapter[]): string[] {
  return planned.flatMap((c) => c.dropped.map((d) => `第 ${c.no} 章 ${d.what}（${d.why}）`));
}

/**
 * 产物里要写进叙事线的计划：细纲批次是各章的 `threads`，单章细纲（生成、落定）是它那一份（章号按落点认，同
 * generation/accept.ts 的 `acceptPlot`）。合同里没写 `threads` 的章不算。别的产物没有。
 */
export async function planOfArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact
): Promise<{ chapters: ChapterPlan[]; notes: string[] } | undefined> {
  if (artifact.kind === 'plotBatch') {
    const chapters = artifact.items.flatMap((b) => (b.threads ? [{ no: b.no, entries: b.threads }] : []));
    return chapters.length > 0 ? { chapters, notes: [] } : undefined;
  }
  if (artifact.kind !== 'plot' || !artifact.threads) {
    return undefined;
  }
  const rel = plotOfTarget(target);
  const no = rel ? ((await project.resolvePlot(rel))?.no ?? parsePlotFileName(rel.split('/').pop() ?? '')?.no) : undefined;
  return no ? { chapters: [{ no, entries: artifact.threads }], notes: artifact.planNotes ?? [] } : undefined;
}

/**
 * 写入卡片上的那几行（第 19 条的例外：先列出来）。照此刻磁盘上的叙事线认一遍（与写入时同一个 `resolvePlanEvents`）：
 *
 * ```
 * 叙事线计划：林昭与沈青 推进；埋〈玉佩的来历〉（新伏笔，挂在「林昭与沈青」）（原来的 2 条整组换掉）
 * 没写进叙事线的：第 3 章 某线 推进（认不出是哪一条线）
 * 到期却没安排的伏笔：〈旧伤〉（第 5 章前收）——这一批既没安排、也没写推迟（照写不拦，写前检查还会提醒）
 * ```
 *
 * 一批几章时一章一行。合同里没写 `threads` 的产物没有这几行。最后一行是复跑之后加的程序检查（`unplannedDue`，不调模型、
 * 不拦人）：模型只排「推进」、到期该埋该收的伏笔没安排，作者在卡片上看得见，可以先改细纲再写入。
 */
export async function describeThreadPlan(project: NovelProject, target: CreationTarget, artifact: Artifact): Promise<string[]> {
  const plan = await planOfArtifact(project, target, artifact);
  if (!plan) {
    return [];
  }
  const book = await project.readThreads();
  const planned = resolvePlanEvents(book, plan.chapters);
  const single = planned.length === 1;
  const rows = planned
    .filter((c) => c.events.length > 0 || c.replaced > 0)
    .map((c) => {
      const body =
        c.events.length > 0
          ? `${chapterPlanText(c)}${c.replaced > 0 ? `（原来的 ${c.replaced} 条整组换掉）` : ''}`
          : `没有计划（原来的 ${c.replaced} 条删掉）`;
      return single ? body : `第 ${c.no} 章：${body}`;
    });
  const dropped = [...plan.notes, ...droppedOf(planned)];
  const unplanned = unplannedDue(book, plan.chapters).map(describeUnplannedDue);
  return [
    ...(rows.length > 0 ? [single ? `叙事线计划：${rows[0]}` : `叙事线计划：\n${rows.join('\n')}`] : []),
    ...(dropped.length > 0 ? [`没写进叙事线的：${dropped.join('；')}`] : []),
    ...(unplanned.length > 0
      ? [`到期却没安排的伏笔：${unplanned.join('、')}——${single ? '本章' : '这一批'}既没安排、也没写推迟（照写不拦，写前检查还会提醒）`]
      : []),
  ];
}

/** 一章的计划：`林昭与沈青 推进、关系；埋〈玉佩的来历〉（新伏笔，挂在「林昭与沈青」）；收〈旧伤〉`。 */
function chapterPlanText(c: PlannedChapter): string {
  const byLine = new Map<string, { line: string; types: string[] }>();
  const fores: string[] = [];
  const fresh = new Map(c.newForeshadowing.map((x) => [threadKey(x.foreshadowing.name), x.line]));
  for (const { line, event } of c.events) {
    if (isForeshadowEvent(event.type)) {
      const key = threadKey(event.foreshadowing ?? '');
      const note = fresh.has(key) ? `（新伏笔，${fresh.get(key) ? `挂在「${fresh.get(key)}」` : `进「${UNFILED_NAME}」`}）` : '';
      fores.push(`${event.type}〈${event.foreshadowing}〉${note}`);
      continue;
    }
    const entry = byLine.get(lineKey(line)) ?? { line: line ?? UNFILED_NAME, types: [] };
    if (!entry.types.includes(event.type)) {
      entry.types.push(event.type);
    }
    byLine.set(lineKey(line), entry);
  }
  return [...[...byLine.values()].map((x) => `${x.line} ${x.types.join('、')}`), ...fores].join('；');
}
