/**
 * 审稿报告卡（五期 W10）：审稿那一轮画这一张，不画那段可就地编辑的正文。
 *
 * ```
 * ┌ 审稿 · 第 2 章《客栈》 ─────────── 1 严重 · 1 建议 · 目标 1/3 已完成 ┐
 * │ 整体顺畅，一处硬伤                                                  │
 * │ 本章目标（覆盖完整不代表全部完成）                                   │
 * │  ☐ 未完成｜关键事件：林昭当晚离开青崖镇   判断……   「天一亮就走」     │
 * │ 严重（1）                                                           │
 * │  ☑ [剧情合理性] 残令前文已经交出去了        「她把那块残令收进了袖中」 │
 * │ ▸ 通过（1）  ▸ 丢掉的意见（1，引文站不住）  ▸ 说明（2）               │
 * │                                         [按勾选的 2 条修稿]         │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * - **点引文就在编辑器里定位到那一句**（发 `revealQuote`）：作者要判断的是「这一句是不是真有问题」，
 *   那一句前后是怎么写的就在正文里。
 * - **缺省勾选**来自后端（`review.picks`，model/review.ts 的 `defaultPicks`）：严重与建议全勾，
 *   未完成的目标也勾，待核实不勾——证据不足不代表有问题。通过与已完成没有可勾的东西。
 * - 勾选状态是**界面状态**，留在前端（按 turnId 记着）：气泡随 `turnDone` 整体重建时不丢。
 * - 底部按钮写勾了几条、会调几次模型（第 4 条）；一条都没勾、正在生成时禁用。
 *
 * ## 编辑模式（五期补遗 §3）
 *
 * 底部「编辑问题」把问题那几组换成一张可改的表：分类、严重度、说明、引文；「新增问题」加一条作者
 * 自己写的（引文可以空着）。作者加的可以删，**模型给的不能删**——不想修就别勾。目标核对来自细纲，
 * 不在表里。「保存」把整张表发给后端（`editReview`），后端校验引文、接着编号，推回新的报告；编辑
 * 期间不能修稿。正在编辑的表按 turnId 记在前端，气泡重建时照着它画，不丢作者刚敲的字。
 */
import { el as mk, spacer } from '../dom';
import type { ReviewGoal, ReviewIssue, ReviewIssueEdit, SerializedTurn } from '../protocol';
import {
  AUTHOR_CATEGORY,
  GOAL_STATUS_LABEL,
  REVISE_CALLS,
  SEVERITY_LABEL,
  describeCalls,
  describeReport,
  pickableIds,
} from '../protocol';
import { store, vscode } from './store';

type ReviewView = NonNullable<SerializedTurn['review']>;

/** 每一轮的勾选状态。没记过的用后端给的缺省。 */
const picked = new Map<string, Set<string>>();
/** 每一轮上一次见过哪些可勾的条目：编辑之后冒出来的新条目按后端的缺省勾上。 */
const known = new Map<string, Set<string>>();
/** 正在编辑的那几张：turnId → 编辑中的问题表。 */
const editing = new Map<string, EditRow[]>();

interface EditRow extends ReviewIssueEdit {
  origin?: 'author';
}

function picksOf(turnId: string, review: ReviewView): Set<string> {
  const allowed = new Set(pickableIds(review.report));
  let set = picked.get(turnId);
  if (!set) {
    set = new Set(review.picks.filter((id) => allowed.has(id)));
    picked.set(turnId, set);
  } else {
    const seen = known.get(turnId) ?? new Set<string>();
    for (const id of review.picks) {
      if (allowed.has(id) && !seen.has(id)) {
        set.add(id);
      }
    }
    for (const id of [...set]) {
      if (!allowed.has(id)) {
        set.delete(id);
      }
    }
  }
  known.set(turnId, allowed);
  return set;
}

export function buildReviewCard(turn: SerializedTurn): HTMLElement {
  const review = turn.review!;
  const report = review.report;
  const picks = picksOf(turn.id, review);
  const rows = editing.get(turn.id);
  const card = mk('div', `review-card${rows ? ' editing' : ''}`);
  card.dataset.review = turn.id;
  const redraw = () => card.replaceWith(buildReviewCard(turn));

  const head = mk('div', 'review-head');
  const where = `第 ${report.chapterNo} 章${report.chapterTitle ? `《${report.chapterTitle}》` : ''}`;
  head.appendChild(mk('span', 'review-title', `审稿 · ${where}`));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'review-counts', describeReport(report)));
  card.appendChild(head);

  if (report.summary) {
    card.appendChild(mk('div', 'review-summary', report.summary));
  }

  const submit = mk('button', 'primary review-submit');
  const refresh = () => {
    const n = picks.size;
    submit.textContent = n > 0 ? `按勾选的 ${n} 条修稿` : '勾选要修的条目';
    submit.disabled = n === 0 || store.busy || !!rows;
    submit.title = `${describeCalls(REVISE_CALLS)}。只把勾选的条目连同整章原文交给模型，要求最小改动；写入前会让你先对比。`;
  };
  const toggle = (id: string, on: boolean) => {
    if (on) {
      picks.add(id);
    } else {
      picks.delete(id);
    }
    refresh();
  };
  const quote = (text: string) => {
    const q = mk('button', 'review-quote', `「${text}」`);
    q.title = '在编辑器里定位到这一句';
    q.addEventListener('click', () => vscode.postMessage({ type: 'revealQuote', relPath: report.chapterRelPath, quote: text }));
    return q;
  };

  // 目标核对排最前：它回答的是「细纲定下的事写到了没有」，比挑错更先要知道。
  if (report.goals.length > 0 || report.coverage === 'none') {
    const section = mk('div', 'review-section review-goals');
    section.appendChild(mk('div', 'review-section-title', `本章目标${coverageNote(report.coverage)}`));
    for (const goal of report.goals) {
      section.appendChild(goalRow(goal, picks.has(goal.id), toggle, quote));
    }
    card.appendChild(section);
  }

  if (rows) {
    card.appendChild(editor(rows, redraw));
  } else {
    for (const sev of ['error', 'warning'] as const) {
      const list = report.issues.filter((i) => i.severity === sev);
      if (list.length === 0) {
        continue;
      }
      const section = mk('div', `review-section review-${sev}`);
      section.appendChild(mk('div', 'review-section-title', `${SEVERITY_LABEL[sev]}（${list.length}）`));
      for (const issue of list) {
        section.appendChild(issueRow(issue, picks.has(issue.id), toggle, quote));
      }
      card.appendChild(section);
    }
    if (report.issues.length === 0) {
      card.appendChild(mk('div', 'review-empty', '没有找到有正文证据的问题。'));
    }
  }

  if (report.passes.length > 0) {
    card.appendChild(
      folded(`通过（${report.passes.length}）`, report.passes.map((p) => `[${p.category}] ${p.description}`))
    );
  }
  if (report.dropped.length > 0) {
    card.appendChild(
      folded(
        `丢掉的意见（${report.dropped.length}，引文站不住）`,
        report.dropped.map((d) => `[${d.category}] ${d.description}（${d.why}${d.quote ? `：「${d.quote}」` : ''}）`)
      )
    );
  }
  if (review.notes?.length) {
    card.appendChild(folded(`说明（${review.notes.length}）`, review.notes));
  }

  const foot = mk('div', 'review-foot');
  if (rows) {
    // 编辑模式：新增 / 取消 / 保存。修稿那一颗收起来——表还没存，按它修的是哪一版说不清。
    foot.appendChild(
      footBtn('新增问题', 'secondary review-edit-add', () => {
        rows.push({ category: AUTHOR_CATEGORY, severity: 'warning', description: '', quote: '', origin: 'author' });
        redraw();
      })
    );
    foot.appendChild(spacer());
    foot.appendChild(
      footBtn('取消', 'secondary review-edit-cancel', () => {
        editing.delete(turn.id);
        redraw();
      })
    );
    foot.appendChild(
      footBtn('保存', 'primary review-edit-save', () => {
        const issues: ReviewIssueEdit[] = rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          category: r.category,
          severity: r.severity,
          description: r.description,
          quote: r.quote ?? '',
        }));
        editing.delete(turn.id);
        vscode.postMessage({ type: 'editReview', turnId: turn.id, issues });
        redraw();
      })
    );
    card.appendChild(foot);
    return card;
  }
  foot.appendChild(
    footBtn('编辑问题', 'secondary review-edit', () => {
      editing.set(
        turn.id,
        report.issues.map((i) => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          description: i.description,
          quote: i.quote,
          ...(i.origin ? { origin: i.origin } : {}),
        }))
      );
      redraw();
    })
  );
  foot.appendChild(mk('span', 'review-hint', `${describeCalls(REVISE_CALLS)}，写入前会让你先对比`));
  foot.appendChild(spacer());
  submit.addEventListener('click', () => {
    if (picks.size === 0 || store.busy) {
      return;
    }
    vscode.postMessage({ type: 'reviseChapter', turnId: turn.id, picks: [...picks] });
  });
  foot.appendChild(submit);
  card.appendChild(foot);
  refresh();
  return card;
}

function coverageNote(coverage: ReviewView['report']['coverage']): string {
  if (coverage === 'none') {
    return '（本章细纲没有可核对的关键事件）';
  }
  return coverage === 'partial' ? '（核对不完整：有几项按待核实处理）' : '（逐项核对过；完整不代表全部完成）';
}

type Toggle = (id: string, on: boolean) => void;
type QuoteBtn = (text: string) => HTMLElement;

function checkbox(id: string, checked: boolean, toggle: Toggle): HTMLInputElement {
  const box = mk('input', 'review-pick');
  box.type = 'checkbox';
  box.checked = checked;
  box.dataset.pick = id;
  box.addEventListener('change', () => toggle(id, box.checked));
  return box;
}

function issueRow(issue: ReviewIssue, checked: boolean, toggle: Toggle, quote: QuoteBtn): HTMLElement {
  const row = mk('div', 'review-item');
  row.dataset.item = issue.id;
  row.appendChild(checkbox(issue.id, checked, toggle));
  const body = mk('div', 'review-item-body');
  const line = mk('div', 'review-item-line');
  line.appendChild(mk('span', 'review-category', `[${issue.category}]`));
  line.appendChild(mk('span', 'review-desc', issue.description));
  if (issue.origin === 'author') {
    line.appendChild(mk('span', 'review-tag', '作者补充'));
  } else if (issue.edited) {
    line.appendChild(mk('span', 'review-tag', '已改'));
  }
  body.appendChild(line);
  // 作者加的可以没有引文：没有就不画那一行（点下去也定位不到什么）。
  if (issue.quote) {
    body.appendChild(quote(issue.quote));
  }
  row.appendChild(body);
  return row;
}

/**
 * 编辑模式下的问题表：一条一行，分类、严重度、说明、引文都能改；作者加的那几条多一颗「删除」。
 * 改动直接写进 `rows`（那就是 `editing` 里记着的那一份），重建时不丢。
 */
function editor(rows: EditRow[], redraw: () => void): HTMLElement {
  const box = mk('div', 'review-section review-editor');
  box.appendChild(
    mk('div', 'review-section-title', '编辑问题（模型给的不能删，不想修就别勾；引文要逐字抄正文里的一句，可以空着）')
  );
  rows.forEach((r, i) => {
    const row = mk('div', `review-edit-row${r.origin === 'author' ? ' author' : ''}`);
    row.dataset.edit = String(i);
    const top = mk('div', 'review-edit-top');
    const severity = mk('select', 'review-edit-severity');
    for (const sev of ['error', 'warning'] as const) {
      const opt = mk('option', undefined, SEVERITY_LABEL[sev]);
      opt.value = sev;
      opt.selected = r.severity === sev;
      severity.appendChild(opt);
    }
    severity.addEventListener('change', () => {
      r.severity = severity.value === 'error' ? 'error' : 'warning';
    });
    const category = mk('input', 'review-edit-category');
    category.type = 'text';
    category.value = r.category;
    category.placeholder = '分类';
    category.addEventListener('input', () => {
      r.category = category.value;
    });
    top.appendChild(severity);
    top.appendChild(category);
    if (r.origin === 'author') {
      top.appendChild(mk('span', 'review-tag', '作者补充'));
      top.appendChild(spacer());
      top.appendChild(
        footBtn('删除', 'secondary review-edit-remove', () => {
          rows.splice(i, 1);
          redraw();
        })
      );
    }
    row.appendChild(top);
    const desc = mk('textarea', 'review-edit-desc');
    desc.rows = 2;
    desc.value = r.description;
    desc.placeholder = '具体是什么问题、要怎么改';
    desc.addEventListener('input', () => {
      r.description = desc.value;
    });
    row.appendChild(desc);
    const q = mk('input', 'review-edit-quote');
    q.type = 'text';
    q.value = r.quote ?? '';
    q.placeholder = '相关原文（可选）';
    q.addEventListener('input', () => {
      r.quote = q.value;
    });
    row.appendChild(q);
    box.appendChild(row);
  });
  if (rows.length === 0) {
    box.appendChild(mk('div', 'review-empty', '还没有问题。点「新增问题」加一条。'));
  }
  return box;
}

function footBtn(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', className, text);
  b.addEventListener('click', onClick);
  return b;
}

function goalRow(goal: ReviewGoal, checked: boolean, toggle: Toggle, quote: QuoteBtn): HTMLElement {
  const row = mk('div', `review-item review-goal status-${goal.status}`);
  row.dataset.item = goal.id;
  if (goal.status === 'completed') {
    row.appendChild(mk('span', 'review-pick-placeholder', '✓'));
  } else {
    row.appendChild(checkbox(goal.id, checked, toggle));
  }
  const body = mk('div', 'review-item-body');
  const line = mk('div', 'review-item-line');
  line.appendChild(mk('span', `review-status status-${goal.status}`, GOAL_STATUS_LABEL[goal.status]));
  line.appendChild(mk('span', 'review-desc', `${goal.kind === 'hook' ? '章末钩子' : '关键事件'}：${goal.text}`));
  body.appendChild(line);
  if (goal.judgment) {
    body.appendChild(mk('div', 'review-judgment', goal.judgment));
  }
  for (const q of goal.quotes) {
    body.appendChild(quote(q));
  }
  row.appendChild(body);
  return row;
}

function folded(title: string, lines: string[]): HTMLElement {
  const det = mk('details', 'review-folded');
  det.appendChild(mk('summary', undefined, title));
  const list = mk('ul');
  for (const text of lines) {
    list.appendChild(mk('li', undefined, text));
  }
  det.appendChild(list);
  return det;
}

/** 正在生成时底部按钮要禁用：busy 变了就把画着的几张卡的按钮刷一遍。 */
export function syncReviewCards(): void {
  document.querySelectorAll<HTMLElement>('.review-card').forEach((card) => {
    const btn = card.querySelector<HTMLButtonElement>('.review-submit');
    const turnId = card.dataset.review;
    if (btn && turnId) {
      btn.disabled = store.busy || editing.has(turnId) || (picked.get(turnId)?.size ?? 0) === 0;
    }
  });
}
