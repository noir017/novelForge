/**
 * 覆盖审阅的段级 diff / 合并视图（五期 W11，仅独立版）。
 *
 * 后端（`FileHost.reviewReplace`）推一条 `prompt kind: 'merge'`：两个版本、能不能合并。
 * 这里按段对齐（model/paragraphDiff.ts 的 LCS），相同的段一行带过，每一处改动画成：
 *
 * ```
 * ┌ 原文 ──────────────┐ ┌ 新版 ──────────────┐
 * │ 她把那块残令收进袖中 │ │ 她看了一眼他空着的手 │
 * └────────────────────┘ └────────────────────┘
 * ┌ 结果（可以手改）──────────────────────────┐
 * │ 她看了一眼他空着的手                       │
 * └──────────────────────────────────────────┘
 * [保留原文] [采用新版]                   已采用新版
 * ```
 *
 * ## 手改过的那一格谁都不动
 *
 * AI-Novel-Writer 的 `ThreeWayMerge` 点「采用」就把那一格换成原稿或修稿的原样文字，作者刚手改的
 * 内容一声不响就没了（`toggleHunk`，ThreeWayMerge.tsx:336-347）。这里一格被手改过，它的两颗按钮
 * 与顶上的「全部采用新版 / 全部保留原文」都**不碰它**；要重来先点「撤销手改」（第 3 条：不静默覆盖）。
 *
 * ## 缺省是新版
 *
 * 作者是发起了一次生成（重写、修稿）才走到这里的，结果格一开始放的是新版——什么都不动直接点
 * 「写入」就等于从前的「覆盖」。一处都没动过（或者全部采用新版、没有手改）时交回 `apply`，
 * 原样用新版，不经段拼接：拼接会把段间空行规范成一个，作者没挑什么，就不该让文件里的排版变样。
 *
 * ## 只读模式
 *
 * 没请求合并的调用方（角色卡、设定条目那几处）收不下一份作者拼出来的文字：只画两栏 diff，
 * 底部是「采纳 / 放弃」。
 */
import { el as mk, maybeById, setHidden } from '../dom';
import type { MergeSegment, OutMessage } from '../protocol';
import { changeCount, diffParagraphs, joinMerge, sideText } from '../protocol';
import { vscode } from './store';

type PromptMessage = Extract<OutMessage, { type: 'prompt' }>;
type Change = Extract<MergeSegment, { kind: 'change' }>;

/** 一处改动的状态：挑了哪一边（还没挑是 undefined）、手改过没有。 */
interface HunkState {
  choice?: 'new' | 'old';
  edited: boolean;
  area?: HTMLTextAreaElement;
  refresh?: () => void;
}

/** 相同的段连着超过这么多段就折起来，只露头尾。 */
const SAME_FOLD = 3;

export function renderMerge(msg: PromptMessage): void {
  // 这一块只有独立版的页面上有（插件用 VS Code 自己的 diff 编辑器）：能力探测，不判断是哪个壳。
  const modal = maybeById('mergeModal');
  if (!modal) {
    // 没有合并视图的页面收到了一条合并询问：当取消，别让后端死等。
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value: undefined });
    return;
  }
  const mergeable = !!msg.mergeable;
  const segments = diffParagraphs(msg.current ?? '', msg.proposed ?? '');
  const total = changeCount(segments);
  const states = new Map<number, HunkState>();

  const title = maybeById('mergeTitle')!;
  const path = maybeById('mergePath')!;
  const body = maybeById('mergeBody')!;
  const progress = maybeById('mergeProgress')!;
  const hint = maybeById('mergeHint')!;
  const allNew = maybeById<HTMLButtonElement>('mergeAllNew')!;
  const allOld = maybeById<HTMLButtonElement>('mergeAllOld')!;
  const apply = maybeById<HTMLButtonElement>('mergeApply')!;
  const discard = maybeById<HTMLButtonElement>('mergeDiscard')!;

  title.textContent = msg.title;
  path.textContent = msg.message ?? '';
  body.replaceChildren();
  modal.classList.toggle('merge-readonly', !mergeable);
  setHidden(allNew, !mergeable || total === 0);
  setHidden(allOld, !mergeable || total === 0);
  apply.textContent = mergeable ? '写入合并结果' : '采纳';
  hint.textContent = mergeable
    ? '结果格可以手改；手改过的那一格，「采用」与「全部采用」都不会动它。'
    : '只能整份采纳或放弃。';

  const syncProgress = () => {
    const done = [...states.values()].filter((s) => s.choice || s.edited).length;
    progress.textContent = total === 0 ? '两个版本没有不同的段' : mergeable ? `已处理 ${done} / ${total} 处` : `${total} 处改动`;
  };

  segments.forEach((seg, k) => {
    if (seg.kind === 'same') {
      body.appendChild(sameBlock(seg.paragraphs));
      return;
    }
    const state: HunkState = { edited: false };
    states.set(k, state);
    body.appendChild(hunkBlock(seg, k, state, mergeable, syncProgress));
  });
  syncProgress();

  const setAll = (side: 'new' | 'old') => {
    for (const state of states.values()) {
      if (!state.edited) {
        state.choice = side;
        state.refresh?.();
      }
    }
    syncProgress();
  };
  allNew.onclick = () => setAll('new');
  allOld.onclick = () => setAll('old');

  const close = (value: string) => {
    setHidden(modal, true);
    body.replaceChildren();
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  };
  discard.onclick = () => close(JSON.stringify({ verdict: 'discard' }));
  apply.onclick = () => {
    if (!mergeable) {
      close(JSON.stringify({ verdict: 'apply' }));
      return;
    }
    const untouched = [...states.values()].every((s) => !s.edited && (s.choice === undefined || s.choice === 'new'));
    if (untouched) {
      close(JSON.stringify({ verdict: 'apply' }));
      return;
    }
    const results: Record<number, string> = {};
    segments.forEach((seg, k) => {
      const state = states.get(k);
      if (seg.kind === 'change' && state?.area) {
        results[k] = state.area.value;
      }
    });
    close(JSON.stringify({ verdict: 'apply', merged: joinMerge(segments, results) }));
  };

  setHidden(modal, false);
}

function sameBlock(paragraphs: string[]): HTMLElement {
  const block = mk('div', 'merge-same');
  if (paragraphs.length <= SAME_FOLD) {
    paragraphs.forEach((p) => block.appendChild(mk('p', undefined, p)));
    return block;
  }
  block.appendChild(mk('p', undefined, paragraphs[0]));
  const det = mk('details', 'merge-same-fold');
  det.appendChild(mk('summary', undefined, `相同的 ${paragraphs.length - 2} 段`));
  paragraphs.slice(1, -1).forEach((p) => det.appendChild(mk('p', undefined, p)));
  block.appendChild(det);
  block.appendChild(mk('p', undefined, paragraphs[paragraphs.length - 1]));
  return block;
}

function hunkBlock(seg: Change, k: number, state: HunkState, mergeable: boolean, onChange: () => void): HTMLElement {
  const block = mk('div', 'merge-hunk');
  block.dataset.hunk = String(k);

  const sides = mk('div', 'merge-sides');
  sides.appendChild(side('原文', seg.old, 'merge-old'));
  sides.appendChild(side('新版', seg.new, 'merge-new'));
  block.appendChild(sides);
  if (!mergeable) {
    return block;
  }

  const area = mk('textarea', 'merge-result');
  area.value = sideText(seg, 'new');
  area.rows = Math.min(12, Math.max(2, area.value.split('\n').length + 1));
  area.setAttribute('aria-label', '合并结果（可以手改）');
  state.area = area;
  block.appendChild(area);

  const actions = mk('div', 'merge-actions');
  const takeNew = mk('button', 'secondary small merge-take-new', '采用新版');
  const takeOld = mk('button', 'secondary small merge-take-old', '保留原文');
  const undo = mk('button', 'link merge-undo', '撤销手改');
  const label = mk('span', 'merge-state');
  actions.append(takeOld, takeNew, undo, label);
  block.appendChild(actions);

  const current = () => sideText(seg, state.choice ?? 'new');
  state.refresh = () => {
    if (!state.edited) {
      area.value = current();
    }
    takeNew.disabled = state.edited;
    takeOld.disabled = state.edited;
    const lock = state.edited ? '这一处你手改过，不会被「采用」冲掉；要重来先点「撤销手改」' : '';
    takeNew.title = lock;
    takeOld.title = lock;
    setHidden(undo, !state.edited);
    block.classList.toggle('edited', state.edited);
    block.classList.toggle('took-old', !state.edited && state.choice === 'old');
    label.textContent = state.edited
      ? '已手改'
      : state.choice === 'old'
        ? '已保留原文'
        : state.choice === 'new'
          ? '已采用新版'
          : '未处理（缺省是新版）';
  };
  takeNew.addEventListener('click', () => {
    if (!state.edited) {
      state.choice = 'new';
      state.refresh!();
      onChange();
    }
  });
  takeOld.addEventListener('click', () => {
    if (!state.edited) {
      state.choice = 'old';
      state.refresh!();
      onChange();
    }
  });
  undo.addEventListener('click', () => {
    state.edited = false;
    state.refresh!();
    onChange();
  });
  area.addEventListener('input', () => {
    const edited = area.value !== current();
    if (edited !== state.edited) {
      state.edited = edited;
      state.refresh!();
      onChange();
    }
  });
  state.refresh();
  return block;
}

function side(label: string, paragraphs: string[], className: string): HTMLElement {
  const col = mk('div', `merge-side ${className}`);
  col.appendChild(mk('div', 'merge-side-label', label));
  if (paragraphs.length === 0) {
    col.appendChild(mk('p', 'merge-none', '（无）'));
  }
  paragraphs.forEach((p) => col.appendChild(mk('p', undefined, p)));
  return col;
}
