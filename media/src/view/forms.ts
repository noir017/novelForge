/**
 * 三个具体的弹窗：一句话（W4）、拆细纲（W5）与批量写章（W9）。表单本身在 form.ts。
 *
 * 它们的「预计调用几次」都来自 core 的纯函数（`describeCalls` / `planPlotBatches` /
 * `planWriteBatch`），与后端确认框同源——弹窗写着 3 次、实际调了 4 次，正是第 4 条要防的事。
 */
import {
  CONFIG_CALLS,
  PLOT_BATCH,
  WRITE_BATCH_DEFAULT,
  WRITE_BATCH_MAX,
  describeCalls,
  planPlotBatches,
  planWriteBatch,
} from '../protocol';
import type { WriteBatchMode } from '../protocol';
import type { IdeaDefaults, ProjectTree } from '../protocol';
import { openForm } from './form';
import type { FormValues } from './form';
import { setBusy } from './state';
import { store, vscode } from './store';
import { showTab } from './tabs';

/** 一句话弹窗的默认规模（与后端「补齐设定」没写规模时的默认一致）。 */
const DEFAULT_TOTAL = 100;
const DEFAULT_WORDS = 3000;

/** 「30 万字」「4.5 万字」「8000 字」。 */
function totalWords(n: number): string {
  return n >= 10000 ? `${Number((n / 10000).toFixed(1))} 万字` : `${n} 字`;
}

/**
 * 「从一句话生成小说配置」。
 *
 * 提交就是一次普通的创作发送（架构层 · 生成 · 小说配置），外加 `setup`：规模以这里为准，
 * 作者这句话写进「一句话」那一节。`config.md` 已经写过东西时明说「保留原文，追加生成」
 * ——后端就是这么合的（generation/structured.ts 的 `completeConfig`）。
 */
export function openIdeaForm(defaults?: IdeaDefaults): void {
  openForm({
    title: '从一句话生成小说配置',
    lead: defaults?.configHasContent
      ? '小说配置里已经写了东西：保留原文，生成的追加在后；你选过的类型、结构、视角不改。'
      : '写下你的脑洞，AI 把它展开成一份小说配置：类型、卖点、主角、金手指、跨章的全局要求。',
    fields: [
      {
        kind: 'textarea',
        key: 'idea',
        label: '一句话 / 脑洞',
        value: defaults?.idea ?? '',
        rows: 5,
        required: true,
        placeholder: '比如：一个从火里活下来的人回到起火的地方，发现幸存者不止他一个。',
      },
      { kind: 'number', key: 'totalChapters', label: '总章数', value: defaults?.totalChapters ?? DEFAULT_TOTAL, min: 1, max: 5000 },
      {
        kind: 'number',
        key: 'wordsPerChapter',
        label: '每章字数',
        value: defaults?.wordsPerChapter ?? DEFAULT_WORDS,
        min: 200,
        max: 30000,
        step: 100,
      },
    ],
    note: (v) => ({
      text: `全书约 ${totalWords(Number(v.totalChapters) * Number(v.wordsPerChapter))} · ${describeCalls(CONFIG_CALLS)} · Ctrl+Enter 提交`,
    }),
    submitLabel: '生成小说配置',
    onSubmit: (v) => {
      if (store.busy) {
        return;
      }
      showTab('chat');
      vscode.postMessage({ type: 'switchTab', tab: 'chat' });
      setBusy(true);
      vscode.postMessage({
        type: 'send',
        payload: {
          text: String(v.idea),
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: Number(v.totalChapters), wordsPerChapter: Number(v.wordsPerChapter) },
          attachments: [],
          excludedIds: [],
        },
      });
    },
  });
}

/**
 * 「批量拆细纲」：选一段章号，已有细纲的章跳过。
 *
 * 缺省是下一可写章起 {@link PLOT_BATCH} 章，不越过大纲的覆盖与总章数。实时说明写出
 * 这一段要拆几章、跳过几章、分几批、预计与最多调用几次——提交时带上 `confirmed`，
 * 后端不再弹第二个确认框（不叠弹窗）。
 */
export function openPlotBatchForm(tree: ProjectTree): void {
  const { book } = tree;
  const outlineFilled = tree.architecture.some((a) => a.key === 'outline' && a.filled);
  const cap = Math.min(book.outlineCoverage ?? Infinity, book.totalChapters ?? Infinity);
  const from = tree.nextChapterNo;
  const to = Math.max(from, Math.min(from + PLOT_BATCH - 1, cap));
  openForm({
    title: '批量拆细纲',
    lead: '从情节大纲里把这一段章节拆成一章一份的细纲。已经排过细纲的章跳过，不会被改动；每批写完就落盘，一批失败就停。',
    fields: [
      { kind: 'number', key: 'from', label: '从第几章', value: from, min: 1, max: 99999 },
      { kind: 'number', key: 'to', label: '到第几章', value: to, min: 1, max: 99999 },
    ],
    note: (v) => {
      const a = Number(v.from);
      const b = Number(v.to);
      if (!outlineFilled) {
        return { text: '情节大纲还没写。先生成大纲，细纲才有依据。', ok: false };
      }
      if (b < a) {
        return { text: '区间写反了。', ok: false };
      }
      if (b > cap) {
        return {
          text: Number.isFinite(book.outlineCoverage ?? Infinity) && b > (book.outlineCoverage ?? Infinity)
            ? `情节大纲只覆盖到第 ${book.outlineCoverage} 章，先续写大纲。`
            : `全书只有 ${book.totalChapters} 章。`,
          ok: false,
        };
      }
      const plan = planPlotBatches({ from: a, to: b, filledNos: book.plotFilledNos });
      if (plan.batches.length === 0) {
        return { text: '这一段都已经排过细纲了。', ok: false };
      }
      return {
        text:
          `要拆 ${plan.chapters.length} 章，分 ${plan.batches.length} 批（每批最多 ${PLOT_BATCH} 章）` +
          `${plan.skipped.length > 0 ? `，跳过已有细纲的 ${plan.skipped.length} 章` : ''}。` +
          `${describeCalls(plan.calls)}（输出被截断或格式不对时自动拆小重试）。`,
      };
    },
    submitLabel: '开始拆细纲',
    onSubmit: (v) => {
      vscode.postMessage({
        type: 'projectAction',
        action: 'generatePlots',
        range: { from: Number(v.from), to: Number(v.to) },
        confirmed: true,
      });
    },
  });
}

/** 「第 3 章」或「第 3–7 章」。 */
function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 「批量写章」（W9）：选一段章号与模式，一章一章串行写。
 *
 * 缺省从下一可写章起 {@link WRITE_BATCH_DEFAULT} 章，一次最多 {@link WRITE_BATCH_MAX} 章。实时说明
 * 写出这一段要写几章、跳过几章、在哪收住、调用次数上限——提交时带上 `confirmed`，后端不再弹
 * 第二个确认框。「写完即定稿」会自动多花定稿那几次调用（D17），提交键要点两下。
 */
export function openWriteBatchForm(tree: ProjectTree): void {
  const writtenNos = tree.plots.filter((p) => p.chapterPath && p.wordCount > 0).map((p) => p.no);
  const plotFilledNos = tree.book.plotFilledNos;
  const from = tree.nextChapterNo;
  const plan = (v: FormValues) =>
    planWriteBatch({
      from: Number(v.from),
      to: Number(v.to),
      mode: v.mode === 'finalize' ? 'finalize' : 'draft',
      writtenNos,
      plotFilledNos,
    });
  openForm({
    title: '批量写章',
    lead:
      '从这一章起一章一章写正文，后一章接着前一章的结尾写。已经有正文的章跳过，不会被改动；' +
      '一章写不出来就停；写出来但开头重演了上一章、或没写够八成，也写进去然后停下，等你看过再继续。',
    fields: [
      { kind: 'number', key: 'from', label: '从第几章', value: from, min: 1, max: 99999 },
      { kind: 'number', key: 'to', label: '到第几章', value: from + WRITE_BATCH_DEFAULT - 1, min: 1, max: 99999 },
      {
        kind: 'select',
        key: 'mode',
        label: '模式',
        value: 'draft',
        options: [
          { value: 'draft', label: '只写正文' },
          { value: 'finalize', label: '写完即定稿（每写完一章就定稿）' },
        ],
      },
    ],
    note: (v) => {
      const a = Number(v.from);
      const b = Number(v.to);
      if (b < a) {
        return { text: '区间写反了。', ok: false };
      }
      if (b - a + 1 > WRITE_BATCH_MAX) {
        return { text: `一次最多写 ${WRITE_BATCH_MAX} 章。`, ok: false };
      }
      const p = plan(v);
      if (p.chapters.length === 0) {
        return {
          text: p.stopAt !== undefined ? `第 ${p.stopAt} 章还没有细纲。先拆细纲，再写正文。` : '这一段都已经写过正文了。',
          ok: false,
        };
      }
      const first = p.chapters[0];
      const last = p.chapters[p.chapters.length - 1];
      return {
        text:
          `要写 ${p.chapters.length} 章（${span(first, last)}）` +
          `${p.skipped.length > 0 ? `，跳过已有正文的 ${p.skipped.length} 章` : ''}` +
          `${p.stopAt !== undefined ? `；第 ${p.stopAt} 章还没有细纲，写到它前面为止` : ''}。` +
          `${describeCalls(p.calls)}（没写够时自动续写，算在上限里）。` +
          (p.mode === 'finalize' ? '每写完一章就定稿：摘要与连续性事实，再更新出场角色的当前状态。' : '只写正文，之后在主按钮上逐章定稿。'),
      };
    },
    submitLabel: '开始写章',
    confirm: (v) => {
      const p = plan(v);
      return p.mode === 'finalize' ? `再点一下：写完即定稿 ${p.chapters.length} 章` : undefined;
    },
    onSubmit: (v) => {
      const mode: WriteBatchMode = v.mode === 'finalize' ? 'finalize' : 'draft';
      vscode.postMessage({
        type: 'projectAction',
        action: 'writeManuscripts',
        range: { from: Number(v.from), to: Number(v.to) },
        mode,
        confirmed: true,
      });
    },
  });
}
