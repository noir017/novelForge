/**
 * 审稿报告（五期）：一次调用出一份逐条引证的报告，本章细纲冻结成目标清单逐项核对。
 *
 * **纯类型 + 纯函数，零 import**（与 pipeline.ts 同类）：前端要拿同一份定位函数去编辑器里
 * 选中引文（「点引文就在编辑器里定位到那句」），报告卡上的标签与默认勾选也得与后端同源。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 *
 * - JSON 合同与长度上限：`review-chapter.command.ts`（RV:36-119）、`consistency_check`
 *   模板的 systemSuffix（PT:917-970）；
 * - 目标冻结与逐项核对：`shared/chapter-goal-review.ts`（`freezeChapterGoals` /
 *   `normalizeChapterGoalReview`，:24-115）；
 * - 修稿清单：`shared/human-confirmed-review.ts` 的 `renderHumanConfirmedReviewBrief`（:202-252）。
 *
 * ## 与上游不同的两处（五期计划 §3 ⚑）
 *
 * 1. **引文归一化之后再找。** 上游只容忍多出一对引号——模型抄原文时改一个逗号、并一个空格，
 *    那一句就认不出了。这里 NFKC、去掉全部空白与标点符号之后比。归一后不到
 *    {@link MIN_QUOTE_CHARS} 个字的引文当「找不到」：两三个字到处都能命中，证明不了什么。
 * 2. **普通问题的引文找不到就丢掉。** 上游只校验目标核对的引文，普通问题原样留着。没有原文
 *    撑着的「问题」多半是模型编的——留着，作者会照着去改一段根本不存在的话。丢了哪几条
 *    留在报告里（`dropped`），卡片上折叠列出（第 2 条）。
 */

// ---------------------------------------------------------------- 类型

/** 可以修的两档。`pass`（这一维查过、没问题）不是问题，单独收着。 */
export type ReviewSeverity = 'error' | 'warning';

export const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  error: '严重',
  warning: '建议',
};

/** 一条问题。`quote` 是正文里找得到的那一句（模型给的原样，不是归一形）。 */
export interface ReviewIssue {
  id: string;
  category: string;
  severity: ReviewSeverity;
  quote: string;
  description: string;
}

/** 查过、没发现问题的一维。只展示，不能勾。 */
export interface ReviewPass {
  category: string;
  description: string;
}

/** 因为引文站不住而丢掉的问题。卡片上折叠列出——丢了什么要看得见。 */
export interface DroppedIssue {
  category: string;
  severity: ReviewSeverity;
  description: string;
  quote?: string;
  why: string;
}

/**
 * 目标核对的三种结论。**「没写到」只能是 `unknown`**：`unmet` 要有正文证据（明确的延期、
 * 拒绝或相反结果），拿不出证据的一律降成待核实（上游 `chapter-goal-review.ts:50-52`）。
 */
export type GoalStatus = 'completed' | 'unmet' | 'unknown';

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  completed: '已完成',
  unmet: '未完成',
  unknown: '待核实',
};

/**
 * 冻结的一项目标。`hook` 是章末钩子——D3 里它是必填的，执行卡也重列它，所以单列成
 * 最后一项（⚑ 上游只冻结 keyEvents）。
 */
export interface FrozenGoal {
  id: string;
  kind: 'event' | 'hook';
  text: string;
}

export interface ReviewGoal extends FrozenGoal {
  status: GoalStatus;
  /** 模型给的逐个子动作的判断；降级时换成一句「请人工核实」。 */
  judgment: string;
  /** 找得到的引文。降级时清空。 */
  quotes: string[];
}

/**
 * 目标核对完不完整：`complete` 每一项都有且只有一份判断；`partial` 有漏项、重复或认不出的 id；
 * `none` 本章细纲里没有可核对的关键事件。**完整不等于全部完成。**
 */
export type GoalCoverage = 'complete' | 'partial' | 'none';

export interface ReviewReport {
  chapterNo: number;
  chapterTitle?: string;
  /** 审的是哪一份正文。点引文要打开它，修稿要读它。 */
  chapterRelPath: string;
  /** 审稿那一刻正文的指纹。修稿时对不上就重新定位每一条勾选项（{@link relocatePicks}）。 */
  chapterHash: string;
  summary: string;
  issues: ReviewIssue[];
  passes: ReviewPass[];
  goals: ReviewGoal[];
  coverage: GoalCoverage;
  dropped: DroppedIssue[];
}

// ---------------------------------------------------------------- 长度上限

/** 上游 RV:36-38：总评、每条说明、每句引文的上限（按字符数，不按字节）。 */
export const REVIEW_SUMMARY_MAX = 120;
export const REVIEW_DESCRIPTION_MAX = 200;
export const REVIEW_QUOTE_MAX = 160;
/** 一份报告最多几条（上游 1–10 条，含通过项）。 */
export const REVIEW_ITEMS_MAX = 10;
/** 引文归一之后至少这么多字才认（见文件头）。 */
export const MIN_QUOTE_CHARS = 4;

// ---------------------------------------------------------------- 目标冻结

/**
 * 本章细纲冻结成目标清单。关键事件**只按显式的边界切**：换行与分号（`；` `;`），行首的
 * 列表记号去掉，不按句号切、不改写一个字（上游 `freezeChapterGoals` 同一条：
 * 「only explicit list boundaries are split; prose is not semantically rewritten」）。
 * 一整段写成的关键事件就是一项，模型在判断里逐个列子动作。
 *
 * id 从 `g1` 起按顺序编，章末钩子排最后。
 */
export function freezeGoals(keyEvents: string, hook: string): FrozenGoal[] {
  const events = (keyEvents ?? '')
    .split(/\r?\n|[；;]/u)
    .map((t) => t.replace(/^\s*(?:[-*•·]|\d+[.)、．])\s*/u, '').trim())
    .filter((t) => t && !isPlaceholder(t));
  const goals: FrozenGoal[] = events.map((text, i) => ({ id: `g${i + 1}`, kind: 'event', text }));
  const h = (hook ?? '').trim();
  if (h && !isPlaceholder(h)) {
    goals.push({ id: `g${goals.length + 1}`, kind: 'hook', text: h });
  }
  return goals;
}

function isPlaceholder(text: string): boolean {
  return /^[（(]待补充[）)]$/u.test(text.trim());
}

/** 交给模型的冻结清单（JSON）。章末钩子带上说法，模型才知道它要判的是「收在这里了没有」。 */
export function frozenGoalsJson(goals: readonly FrozenGoal[]): string {
  return JSON.stringify(goals.map((g) => ({ id: g.id, text: g.kind === 'hook' ? `章末钩子：${g.text}` : g.text })));
}

// ---------------------------------------------------------------- 引文

/**
 * 一个字符的归一形：NFKC、小写、去掉空白与标点符号。**逐个码点做**——定位时要把归一形里的
 * 位置映射回原文，整串 NFKC 之后就对不回去了。中文不受影响（NFKC 对汉字是恒等的）。
 */
function normChar(ch: string): string {
  return ch.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 一段文字的归一形（引文校验与定位共用这一个）。 */
export function normalizeQuote(text: string): string {
  let out = '';
  for (const ch of text ?? '') {
    out += normChar(ch);
  }
  return out;
}

/** 一份正文的归一形与「归一形第 k 个字在原文里从哪开始、到哪结束」。 */
export interface QuoteIndex {
  norm: string;
  starts: number[];
  ends: number[];
}

export function indexText(text: string): QuoteIndex {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text ?? '') {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    norm += n;
    i += ch.length;
  }
  return { norm, starts, ends };
}

/** 引文在这份正文里找不找得到（归一之后，至少 {@link MIN_QUOTE_CHARS} 个字）。 */
export function quoteFound(index: QuoteIndex, quote: string): boolean {
  const q = normalizeQuote(quote);
  return q.length >= MIN_QUOTE_CHARS && index.norm.includes(q);
}

/**
 * 引文在原文里的位置 `{ start, end }`（UTF-16 下标，`end` 不含）。找不到是 undefined。
 * 编辑器选中它、VS Code 的 `revealRange` 都用这一份——与校验同一个归一化，
 * 报告里说找得到的，点下去就一定定位得到。
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | undefined {
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return undefined;
  }
  const index = indexText(text);
  const at = index.norm.indexOf(q);
  if (at < 0) {
    return undefined;
  }
  return { start: index.starts[at], end: index.ends[at + q.length - 1] };
}

// ---------------------------------------------------------------- 解析

/** 模型交回来的一条，还没校验。 */
export interface RawReviewItem {
  category: string;
  severity: ReviewSeverity | 'pass';
  quote: string;
  description: string;
}

export interface RawGoalReview {
  id: string;
  status: string;
  description: string;
  quotes: string[];
}

export interface RawReview {
  summary: string;
  items: RawReviewItem[];
  /** 缺席 = 模型根本没交目标核对（与交了一个空数组不同：前者整张清单都待核实）。 */
  goalReviews?: RawGoalReview[];
  /** 解析时顺手做的修整：截断了几处、跳过了几条认不出的。 */
  warnings: string[];
}

/**
 * 读模型交回的审稿 JSON。**宽松**（第 1 条：模型不听话是常态）：认代码围栏、认前后多余的话
 * （取第一个 `{` 到最后一个 `}`）、`critical / severe` 当严重、`minor / warn` 当建议，
 * 单条坏了跳过那一条。只有「根本不是 JSON 对象」或「没有 items 数组」才算不合格——
 * 那时审稿链按合同重建一次（generation/review.ts）。
 */
export function parseReviewJson(raw: string): { ok: true; value: RawReview } | { ok: false; reason: string } {
  const text = (raw ?? '').trim().replace(/^```(?:json)?[ \t]*\r?\n?/iu, '').replace(/\r?\n?```\s*$/u, '');
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) {
    return { ok: false, reason: '输出里没有 JSON 对象' };
  }
  let root: unknown;
  try {
    root = JSON.parse(text.slice(from, to + 1));
  } catch {
    return { ok: false, reason: 'JSON 解析失败' };
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, reason: '根不是一个对象' };
  }
  const o = root as Record<string, unknown>;
  if (!Array.isArray(o.items)) {
    return { ok: false, reason: '缺少 items 数组' };
  }
  const warnings: string[] = [];
  let clipped = 0;
  const clip = (value: unknown, max: number): string => {
    const s = typeof value === 'string' ? value.trim() : '';
    const chars = Array.from(s);
    if (chars.length > max) {
      clipped++;
      return chars.slice(0, max).join('');
    }
    return s;
  };

  const items: RawReviewItem[] = [];
  let skipped = 0;
  for (const entry of o.items) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const severity = normalizeSeverity(e.severity);
    const description = clip(e.description, REVIEW_DESCRIPTION_MAX);
    if (!severity || !description) {
      skipped++;
      continue;
    }
    items.push({
      category: clip(e.category, 40) || '其他',
      severity,
      quote: clip(e.quote, REVIEW_QUOTE_MAX),
      description,
    });
  }
  if (skipped > 0) {
    warnings.push(`${skipped} 条认不出严重度或没有说明，已跳过`);
  }

  let goalReviews: RawGoalReview[] | undefined;
  if (Array.isArray(o.goalReviews)) {
    goalReviews = o.goalReviews.map((entry) => {
      const g = (entry ?? {}) as Record<string, unknown>;
      const evidence = Array.isArray(g.evidence) ? g.evidence : [];
      return {
        id: typeof g.id === 'string' ? g.id.trim() : String(g.id ?? ''),
        status: typeof g.status === 'string' ? g.status.trim().toLowerCase() : '',
        description: clip(g.description, REVIEW_DESCRIPTION_MAX * 2),
        quotes: evidence
          .map((x) => (typeof x === 'string' ? x : (x as { quote?: unknown } | null)?.quote))
          .map((q) => clip(q, REVIEW_QUOTE_MAX))
          .filter(Boolean),
      };
    });
  }
  const summary = clip(o.summary, REVIEW_SUMMARY_MAX);
  if (clipped > 0) {
    warnings.push(`${clipped} 处超长的总评、说明或引文已按上限截断`);
  }
  return { ok: true, value: { summary, items, ...(goalReviews ? { goalReviews } : {}), warnings } };
}

function normalizeSeverity(value: unknown): ReviewSeverity | 'pass' | undefined {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s === 'error' || s === 'critical' || s === 'severe' || s === '严重') {
    return 'error';
  }
  if (s === 'warning' || s === 'warn' || s === 'minor' || s === '建议') {
    return 'warning';
  }
  if (s === 'pass' || s === 'ok' || s === '通过') {
    return 'pass';
  }
  return undefined;
}

// ---------------------------------------------------------------- 校验

/** 降级时那一项的判断换成这一句（上游同一句的意思）。 */
export const GOAL_UNVERIFIED = '这一项缺少有效的逐项判断或可定位的正文证据，请人工核实。';

/**
 * 校验一份报告：普通问题的引文找不到就丢；目标逐项核对，站不住的降成待核实。返回报告与
 * 一路上的说明（进 Draft 的 notes，第 2 条）。
 *
 * 目标核对的规矩（上游 `normalizeChapterGoalReview`）：
 *
 * - 一项目标恰好一份判断才算数；漏了、重复了 → 这一项待核实，覆盖记 `partial`；
 * - 认不出的 id → 覆盖记 `partial`（不算进任何一项）；
 * - `completed` / `unmet` 必须至少有一句找得到的引文；**任何一句找不到**，整项降成待核实、
 *   引文清空、判断换成 {@link GOAL_UNVERIFIED}——剩下几句找得到的也救不回它（上游测试 :101）。
 */
export function verifyReview(
  raw: RawReview,
  ctx: { text: string; goals: readonly FrozenGoal[]; chapterNo: number; chapterTitle?: string; chapterRelPath: string; chapterHash: string }
): { report: ReviewReport; notes: string[] } {
  const notes = [...raw.warnings];
  const index = indexText(ctx.text);
  const issues: ReviewIssue[] = [];
  const passes: ReviewPass[] = [];
  const dropped: DroppedIssue[] = [];

  let over = 0;
  for (const item of raw.items) {
    if (issues.length + passes.length >= REVIEW_ITEMS_MAX) {
      over++;
      continue;
    }
    if (item.severity === 'pass') {
      passes.push({ category: item.category, description: item.description });
      continue;
    }
    const base = { category: item.category, severity: item.severity, description: item.description };
    if (!item.quote) {
      dropped.push({ ...base, why: '没有给引文' });
      continue;
    }
    if (!quoteFound(index, item.quote)) {
      dropped.push({
        ...base,
        quote: item.quote,
        why: normalizeQuote(item.quote).length < MIN_QUOTE_CHARS ? `引文太短（不到 ${MIN_QUOTE_CHARS} 个字），认不出是哪一句` : '引文在正文里找不到',
      });
      continue;
    }
    issues.push({ id: `i${issues.length + 1}`, ...base, quote: item.quote });
  }
  if (over > 0) {
    notes.push(`报告超过 ${REVIEW_ITEMS_MAX} 条，后面 ${over} 条没有收`);
  }
  if (dropped.length > 0) {
    notes.push(
      `丢掉 ${dropped.length} 条引文站不住的意见（${dropped.map((d) => `「${clipText(d.description, 24)}」${d.why}`).join('；')}）`
    );
  }

  const { goals, coverage, downgraded } = verifyGoals(raw.goalReviews, ctx.goals, index);
  if (coverage === 'none') {
    notes.push('本章细纲里没有可核对的关键事件，没有做目标核对');
  } else if (coverage === 'partial') {
    notes.push('目标核对不完整：模型漏了、重复了或写错了某几项的 id，那几项按待核实处理');
  }
  if (downgraded > 0) {
    notes.push(`${downgraded} 项目标的判断没有可定位的正文证据，降成待核实`);
  }

  return {
    report: {
      chapterNo: ctx.chapterNo,
      ...(ctx.chapterTitle ? { chapterTitle: ctx.chapterTitle } : {}),
      chapterRelPath: ctx.chapterRelPath,
      chapterHash: ctx.chapterHash,
      summary: raw.summary,
      issues,
      passes,
      goals,
      coverage,
      dropped,
    },
    notes,
  };
}

function verifyGoals(
  reviews: RawGoalReview[] | undefined,
  frozen: readonly FrozenGoal[],
  index: QuoteIndex
): { goals: ReviewGoal[]; coverage: GoalCoverage; downgraded: number } {
  if (frozen.length === 0) {
    return { goals: [], coverage: 'none', downgraded: 0 };
  }
  const candidates = reviews ?? [];
  let partial = !reviews || candidates.some((r) => !frozen.some((g) => g.id === r.id));
  let downgraded = 0;
  const goals = frozen.map((goal): ReviewGoal => {
    const matches = candidates.filter((r) => r.id === goal.id);
    const unverified: ReviewGoal = { ...goal, status: 'unknown', judgment: GOAL_UNVERIFIED, quotes: [] };
    if (matches.length !== 1) {
      partial = true;
      return unverified;
    }
    const m = matches[0];
    const status = m.status === 'completed' || m.status === 'unmet' || m.status === 'unknown' ? m.status : undefined;
    if (!status || !m.description) {
      partial = true;
      return unverified;
    }
    const allFound = m.quotes.every((q) => quoteFound(index, q));
    if (!allFound || (status !== 'unknown' && m.quotes.length === 0)) {
      if (status !== 'unknown') {
        downgraded++;
      }
      return unverified;
    }
    return { ...goal, status, judgment: m.description, quotes: m.quotes };
  });
  return { goals, coverage: partial ? 'partial' : 'complete', downgraded };
}

function clipText(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

// ---------------------------------------------------------------- 勾选

/**
 * 报告卡上默认勾哪几条：严重与建议全勾，**未完成**的目标也勾（它们要补的正是细纲里定下的事）；
 * 待核实默认不勾（证据不足不代表有问题，W10）；通过与已完成没有可勾的东西。
 *
 * ⚑ 上游连未完成的目标也默认不勾（ReviewReport.tsx:301-325）；总计划 W10 只说「待核实默认不勾」。
 */
export function defaultPicks(report: ReviewReport): string[] {
  return [...report.issues.map((i) => i.id), ...report.goals.filter((g) => g.status === 'unmet').map((g) => g.id)];
}

/** 能勾的条目：全部问题，加上未完成与待核实的目标。 */
export function pickableIds(report: ReviewReport): string[] {
  return [...report.issues.map((i) => i.id), ...report.goals.filter((g) => g.status !== 'completed').map((g) => g.id)];
}

/**
 * 修稿之前正文又被改过（指纹对不上）：逐条重新定位勾选的问题。找不到的那几条作废——
 * 拿一句已经不在正文里的原文去让模型「改这里」，它只能凭空编一处出来改。
 * 目标不受影响：它们来自细纲，不来自正文。
 */
export function relocatePicks(
  report: ReviewReport,
  picks: readonly string[],
  text: string
): { kept: string[]; lost: ReviewIssue[] } {
  const index = indexText(text);
  const kept: string[] = [];
  const lost: ReviewIssue[] = [];
  for (const id of picks) {
    const issue = report.issues.find((i) => i.id === id);
    if (issue && !quoteFound(index, issue.quote)) {
      lost.push(issue);
      continue;
    }
    if (issue || report.goals.some((g) => g.id === id && g.status !== 'completed')) {
      kept.push(id);
    }
  }
  return { kept, lost };
}

/**
 * 交给修稿那一次的清单：**只有勾选的**，按报告里的顺序。移植自
 * `renderHumanConfirmedReviewBrief`：原始报告与总评不发——作者没勾的那些不该出现在模型眼前。
 * 勾了待核实项时前面加上游那句边界，免得模型把「证据不足」当成「确认有错」去补一段前史。
 */
export function renderRevisionBrief(report: ReviewReport, picks: readonly string[]): string {
  const chosen = new Set(picks);
  const lines: string[] = [];
  let n = 0;
  for (const issue of report.issues) {
    if (chosen.has(issue.id)) {
      n++;
      lines.push(`${n}. [${issue.category} / ${SEVERITY_LABEL[issue.severity]}] ${issue.description}\n   相关原文：${issue.quote}`);
    }
  }
  for (const goal of report.goals) {
    if (chosen.has(goal.id) && goal.status !== 'completed') {
      n++;
      const head = goal.kind === 'hook' ? `章末钩子：${goal.text}` : `关键事件：${goal.text}`;
      const quote = goal.quotes.length > 0 ? `\n   相关原文：${goal.quotes.join(' / ')}` : '';
      lines.push(`${n}. [本章目标 / ${GOAL_STATUS_LABEL[goal.status]}] ${head}\n   判断：${goal.judgment}${quote}`);
    }
  }
  if (lines.length === 0) {
    return '';
  }
  const sections: string[] = [];
  if (report.goals.some((g) => chosen.has(g.id) && g.status === 'unknown')) {
    sections.push(
      '【待核实项处理边界】作者纳入待核实项不等于确认其为错误。不得据此编造缺失前史或事实；仅按作者已有指导及正文证据处理，证据不足时保留不确定性。'
    );
  }
  sections.push(['【已确认纳入本次修稿的审稿项】', ...lines].join('\n'));
  return sections.join('\n\n');
}

/** 用户气泡上那几行（`/按审稿修稿` 下面）：一条一行，不带引文。 */
export function describePicks(report: ReviewReport, picks: readonly string[]): string[] {
  const chosen = new Set(picks);
  return [
    ...report.issues.filter((i) => chosen.has(i.id)).map((i) => `[${SEVERITY_LABEL[i.severity]}] ${i.category}：${i.description}`),
    ...report.goals
      .filter((g) => chosen.has(g.id) && g.status !== 'completed')
      .map((g) => `[${GOAL_STATUS_LABEL[g.status]}] ${g.kind === 'hook' ? '章末钩子' : '关键事件'}：${g.text}`),
  ];
}

// ---------------------------------------------------------------- 渲染

/**
 * 给人读的一份（气泡正文、「复制」取它）。报告卡画的是结构，这一份是它的文字版——
 * 气泡里摆一段 JSON，作者复制出来也没法用。
 */
export function renderReport(report: ReviewReport): string {
  const head = `第 ${report.chapterNo} 章${report.chapterTitle ? `《${report.chapterTitle}》` : ''}审稿`;
  const lines: string[] = [`# ${head}`];
  if (report.summary) {
    lines.push('', report.summary);
  }
  for (const sev of ['error', 'warning'] as const) {
    const list = report.issues.filter((i) => i.severity === sev);
    if (list.length > 0) {
      lines.push('', `## ${SEVERITY_LABEL[sev]}（${list.length}）`);
      for (const i of list) {
        lines.push(`- [${i.category}] ${i.description}`, `  > ${i.quote}`);
      }
    }
  }
  if (report.goals.length > 0) {
    lines.push('', '## 本章目标');
    for (const g of report.goals) {
      lines.push(`- ${GOAL_STATUS_LABEL[g.status]}｜${g.kind === 'hook' ? '章末钩子' : '关键事件'}：${g.text}`, `  ${g.judgment}`);
      for (const q of g.quotes) {
        lines.push(`  > ${q}`);
      }
    }
  }
  if (report.passes.length > 0) {
    lines.push('', '## 通过');
    for (const p of report.passes) {
      lines.push(`- [${p.category}] ${p.description}`);
    }
  }
  if (report.dropped.length > 0) {
    lines.push('', `## 丢掉的意见（${report.dropped.length}，引文站不住）`);
    for (const d of report.dropped) {
      lines.push(`- [${d.category}] ${d.description}（${d.why}）`);
    }
  }
  return lines.join('\n');
}

/** 「2 严重 · 1 建议 · 目标 3/4 已完成」——报告卡顶上与日志里的那一句。 */
export function describeReport(report: ReviewReport): string {
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  const warnings = report.issues.length - errors;
  const parts = [`${errors} 严重`, `${warnings} 建议`];
  if (report.goals.length > 0) {
    const done = report.goals.filter((g) => g.status === 'completed').length;
    const pending = report.goals.filter((g) => g.status === 'unknown').length;
    parts.push(`目标 ${done}/${report.goals.length} 已完成${pending > 0 ? `（${pending} 项待核实）` : ''}`);
  }
  return parts.join(' · ');
}
