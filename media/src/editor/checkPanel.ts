/**
 * 写作体检面板（独立版内置编辑器）：点状态栏「体检」那一格弹出来的小面板——按类别列出命中的词与次数，点一个词依次跳到
 * 它在正文里的位置并选中；敏感词写了替换词的给「替换本处」「本文件全部替换」；底下是「编辑敏感词表…」。数据由 `check.ts`
 * 现算现给（`data()`），动作也交回它，这里只管画、开、关。
 *
 * 开合照码字统计面板（`statsPanel.ts`）的样子：
 *
 * - **不是遮罩**：挂在 `body` 上、`position: fixed`，贴着点开它的那一格往上弹。点面板外面（捕获阶段的 `mousedown`）、
 *   按 Esc、再点一下那一格都收起；正文照样能接着打字——开着时数字跟着变。
 * - **同一时刻只有一个**：从另一块编辑区的状态栏点开，换成那一块的当前文件。
 * - 面板上的按钮按下鼠标不夺焦点（跳过去之后焦点在正文里，选区看得见）。
 * - 用户内容（词、替换词）一律 `textContent`，不拼 HTML。
 */
import { el } from '../dom';
import { CHECK_CATEGORIES, CHECK_LABEL } from './checkCore';
import type { CheckCategory, CheckEntry, CheckResult } from './checkCore';
import { HIGHLIGHT_LIMIT } from './highlight';

export interface CheckPanelData {
  /** 点开它的那一块编辑区当前开着的是正文（章节或草稿）。 */
  prose: boolean;
  result?: CheckResult;
  /** 正文超过高亮上限（30 万字）：不画高亮，面板照样数。 */
  tooLarge?: boolean;
  /** 体检高亮开着没有。 */
  highlight: boolean;
  /** 面板上点过的那个词跳到了第几处。 */
  cursor?: { category: CheckCategory; term: string; index: number };
  sensitivePath: string;
  sensitiveExists: boolean;
  sensitiveBad: { line: number; reason: string }[];
  /** 收到过后端的词表没有（没有时禁用词与敏感词还没法查）。 */
  received: boolean;
}

export interface CheckPanelActions {
  jump(entry: CheckEntry): void;
  replaceOne(entry: CheckEntry): void;
  replaceAll(entry: CheckEntry): void;
  editList(): void;
}

interface Open {
  panel: HTMLElement;
  anchor: HTMLElement;
  data: () => CheckPanelData;
  actions: CheckPanelActions;
}

let open: Open | undefined;

/** 开着没有、是从哪一格点开的。 */
export function checkPanelAnchor(): HTMLElement | undefined {
  return open?.anchor;
}

/** 点那一格：开着（且是这一格开的）就收起，否则开 / 换成这一格的。 */
export function toggleCheckPanel(anchor: HTMLElement, data: () => CheckPanelData, actions: CheckPanelActions): void {
  if (open?.anchor === anchor) {
    closeCheckPanel();
    return;
  }
  closeCheckPanel();
  const panel = el('div', 'ed-check-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '写作体检');
  // 面板上的按钮按下鼠标不夺焦点：跳过去之后焦点在正文里，选区看得见；接着点「替换本处」时选区还在。
  panel.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement | null)?.closest('button')) {
      e.preventDefault();
    }
  });
  document.body.appendChild(panel);
  open = { panel, anchor, data, actions };
  anchor.setAttribute('aria-expanded', 'true');
  render();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
}

export function closeCheckPanel(): void {
  if (!open) {
    return;
  }
  open.panel.remove();
  open.anchor.setAttribute('aria-expanded', 'false');
  open = undefined;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
}

/** 结果变了（打字、词表更新、跳了一处）：开着就重画。 */
export function refreshCheckPanel(): void {
  if (open) {
    render();
  }
}

function onOutside(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!open || (target && (open.panel.contains(target) || open.anchor.contains(target)))) {
    return;
  }
  closeCheckPanel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open) {
    e.stopPropagation();
    closeCheckPanel();
  }
}

function button(cls: string, text: string, title: string, run: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** 每一类的标题后面那一句：词从哪来、算几个问题。 */
function sectionNote(category: CheckCategory, d: CheckPanelData, r: CheckResult): string {
  switch (category) {
    case 'sensitive':
      return `来自敏感词表（${d.sensitivePath}），英文不分大小写`;
    case 'banned':
      return '文风指南的禁用词表、小说配置「全局要求」里禁止的词、古代题材的现代说法——与写正文时写完数的是同一份';
    case 'simile':
      return `全章 ${r.similes.total} 次，超出上限 ${r.similes.over} 次（上限 ${r.similes.limit} 次）`;
    case 'acronym':
      return '故事的年代用不上这种说法的话，改成那个年代的人会说的话（都市、科幻里的 CEO、AI 是正常的）';
  }
}

function render(): void {
  if (!open) {
    return;
  }
  const d = open.data();
  const actions = open.actions;
  const parts: HTMLElement[] = [];

  const head = el('div', 'ed-check-head');
  head.appendChild(el('span', 'ed-check-title', '写作体检'));
  const r = d.result;
  head.appendChild(
    el('span', 'ed-check-aside', !d.prose ? '' : r && r.total > 0 ? `${r.total} 个问题` : '没有发现问题')
  );
  parts.push(head);

  if (!d.prose || !r) {
    parts.push(el('div', 'ed-check-note', '体检只看正文（章节与草稿）。当前标签不是正文。'));
  } else {
    for (const category of CHECK_CATEGORIES) {
      const entries = r.entries.filter((e) => e.category === category);
      if (entries.length === 0) {
        continue;
      }
      const sec = el('div', `ed-check-sec ed-check-sec-${category}`);
      const h = el('div', 'ed-check-sec-head');
      h.appendChild(el('span', `ed-check-swatch ed-check-swatch-${category}`));
      h.appendChild(el('span', 'ed-check-sec-label', CHECK_LABEL[category]));
      const count = category === 'simile' ? `超出 ${r.counts.simile}` : `${r.counts[category]} 处`;
      h.appendChild(el('span', 'ed-check-sec-count', count));
      sec.appendChild(h);
      sec.appendChild(el('div', 'ed-check-note', sectionNote(category, d, r)));
      const list = el('div', 'ed-check-list');
      for (const entry of entries) {
        list.appendChild(row(entry, d, actions));
      }
      sec.appendChild(list);
      parts.push(sec);
    }
    if (r.total === 0) {
      parts.push(el('div', 'ed-check-note', '没有敏感词、禁用词、英文缩写，比喻词也没超过上限。'));
    }
    // 比喻词没超：不高亮、不算问题，但说一句用了几次，免得人以为没数。
    if (r.similes.over === 0 && r.similes.total > 0) {
      parts.push(el('div', 'ed-check-note', `比喻词全章 ${r.similes.total} 次，没超过上限 ${r.similes.limit} 次（超过了才标出来）。`));
    }
    if (d.tooLarge) {
      parts.push(el('div', 'ed-check-note', `这份正文超过 ${HIGHLIGHT_LIMIT / 10000} 万字，正文里不画高亮（这里照样数，点词照样跳）。`));
    } else if (!d.highlight) {
      parts.push(el('div', 'ed-check-note', '正文里的体检高亮关着（「视图 → 体检高亮」打开）。'));
    }
  }

  // 敏感词表那几句 + 「编辑敏感词表…」。
  const foot = el('div', 'ed-check-foot');
  const notes = el('div', 'ed-check-rule');
  if (!d.received) {
    notes.appendChild(el('div', undefined, '还没收到这本书的禁用词与敏感词表（没打开工程，或者还在读）。'));
  } else if (!d.sensitiveExists) {
    notes.appendChild(el('div', undefined, '还没有敏感词表：点「编辑敏感词表…」建一份（一行一个词，「词 => 替换词」给出替换）。'));
  }
  if (d.sensitiveBad.length > 0) {
    const lines = d.sensitiveBad.map((b) => b.line);
    const shown = lines.slice(0, 8).join('、') + (lines.length > 8 ? ` 等 ${lines.length} 行` : '');
    const bad = el('div', 'ed-check-bad', `敏感词表第 ${shown} 行没看懂，已跳过。`);
    bad.title = d.sensitiveBad.map((b) => `第 ${b.line} 行：${b.reason}`).join('\n');
    notes.appendChild(bad);
  }
  notes.appendChild(el('div', undefined, '体检不调模型，只是按词表在正文里找字；不会替你改字。'));
  foot.append(
    notes,
    button('chip-btn ed-check-edit', '编辑敏感词表…', `打开 ${d.sensitivePath}（没有就新建一份带说明的模板）`, () => actions.editList())
  );
  parts.push(foot);

  open.panel.replaceChildren(...parts);
  place();
}

function row(entry: CheckEntry, d: CheckPanelData, actions: CheckPanelActions): HTMLElement {
  const line = el('div', 'ed-check-row');
  const n = entry.offsets.length;
  const at = d.cursor && d.cursor.category === entry.category && d.cursor.term === entry.term ? d.cursor.index : -1;
  const word = button(
    'ed-check-word',
    '',
    n > 1 ? `跳到下一处并选中（一共 ${n} 处，到底了从头再来）` : '跳到这一处并选中',
    () => actions.jump(entry)
  );
  word.append(el('span', 'ed-check-term', entry.term), el('span', 'ed-check-times', at >= 0 ? `${at + 1}/${n}` : `×${n}`));
  line.appendChild(word);
  if (entry.replacement) {
    line.appendChild(el('span', 'ed-check-arrow', '→'));
    line.appendChild(el('span', 'ed-check-replacement', entry.replacement));
    line.appendChild(
      button(
        'chip-btn ed-check-replace-one',
        '替换本处',
        '选中的正是这个词的某一处时换掉它（一步撤销），接着选中下一处；没选中时先跳过去选中',
        () => actions.replaceOne(entry)
      )
    );
    line.appendChild(
      button(
        'chip-btn ed-check-replace-all',
        '全部替换',
        `把这份文件里的 ${n} 处都换掉（只记一步撤销，Ctrl+Z 一下退回）。不动别的文件`,
        () => actions.replaceAll(entry)
      )
    );
  }
  return line;
}

/** 贴着那一格往上弹，左右夹进视口。 */
function place(): void {
  if (!open) {
    return;
  }
  const rect = open.anchor.getBoundingClientRect();
  const width = open.panel.offsetWidth || 360;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  open.panel.style.left = `${Math.round(left)}px`;
  open.panel.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 6))}px`;
}
