/**
 * 码字统计面板（独立版内置编辑器）：点状态栏字数那一格弹出来的小面板——本章字数与目标、本次码字（字数、时长、
 * 速度）、今日码字、本次按文件的明细，以及「重新开始计时」。数据由 `stats.ts` 现算现给（`data()`），这里只管画、
 * 开、关。
 *
 * - **不是遮罩**：挂在 `body` 上、`position: fixed`，贴着点开它的那一格往上弹（状态栏在编辑区底边）。点面板外面
 *   （捕获阶段的 `mousedown`）、按 Esc、再点一下那一格都收起；正文照样能接着打字——开着时码字数跟着跳。
 * - **同一时刻只有一个**：从另一块编辑区的状态栏点开，换成那一块的当前文件。
 * - 用户内容（文件名、章节标题）一律 `textContent`，不拼 HTML。
 */
import { el, setHidden } from '../dom';
import type { FileTally, GoalProgress } from './writingStats';
import { IDLE_MS, formatDuration, signedWords, speedPerHour } from './writingStats';
import { groupDigits } from './words';

export interface StatsPanelData {
  /** 点开它的那一块编辑区的当前文件。没开文件时 undefined。 */
  file?: {
    title: string;
    path: string;
    words: number;
    chars: number;
    /** 是某一章的正文、且有目标字数。 */
    goal?: GoalProgress;
    /** 是某一章的正文、却没有目标时说一句为什么。 */
    goalNote?: string;
    /** 字数不算开头的 `# 标题` 那一行（章节，与工程页同一个数法）。 */
    headingExcluded: boolean;
  };
  session: { startedAt: number; words: number; ms: number; files: FileTally[] };
  today: { words: number; ms: number; persisted: boolean };
}

interface Open {
  panel: HTMLElement;
  anchor: HTMLElement;
  data: () => StatsPanelData;
  onRestart: () => void;
}

let open: Open | undefined;

/** 开着没有、是不是从这一格点开的。 */
export function statsPanelAnchor(): HTMLElement | undefined {
  return open?.anchor;
}

/** 点那一格：开着（且是这一格开的）就收起，否则开 / 换成这一格的。 */
export function toggleStatsPanel(anchor: HTMLElement, data: () => StatsPanelData, onRestart: () => void): void {
  if (open?.anchor === anchor) {
    closeStatsPanel();
    return;
  }
  closeStatsPanel();
  const panel = el('div', 'ed-stats-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '码字统计');
  document.body.appendChild(panel);
  open = { panel, anchor, data, onRestart };
  anchor.setAttribute('aria-expanded', 'true');
  render();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
}

export function closeStatsPanel(): void {
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

/** 数变了（打字、章节索引更新、别的窗口记了今日码字）：开着就重画。 */
export function refreshStatsPanel(): void {
  if (open) {
    render();
  }
}

function onOutside(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!open || (target && (open.panel.contains(target) || open.anchor.contains(target)))) {
    return;
  }
  closeStatsPanel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open) {
    e.stopPropagation();
    closeStatsPanel();
  }
}

function render(): void {
  if (!open) {
    return;
  }
  const d = open.data();
  const restart = el('button', 'chip-btn ed-stats-restart', '重新开始计时');
  restart.type = 'button';
  restart.title = '「本次码字」的字数与时长从现在起重新算；今日码字不受影响。';
  restart.addEventListener('click', () => open?.onRestart());

  const foot = el('div', 'ed-stats-foot');
  foot.append(
    el(
      'div',
      'ed-stats-rule',
      `只算亲手打的字（输入法上屏算，退格删掉的倒扣）；粘贴、一键排版、替换、合并、恢复历史版本、磁盘同步不算，` +
        `撤销 / 重做跟着那一步走。停笔超过 ${IDLE_MS / 60_000} 分钟的那段不计时。`
    ),
    restart
  );

  open.panel.replaceChildren(fileSection(d), sessionSection(d), todaySection(d), filesSection(d), foot);
  place();
}

function section(cls: string, head: string, aside?: string): HTMLElement {
  const sec = el('div', `ed-stats-sec ${cls}`);
  const h = el('div', 'ed-stats-head', head);
  if (aside) {
    h.appendChild(el('span', 'ed-stats-aside', aside));
  }
  sec.appendChild(h);
  return sec;
}

function fileSection(d: StatsPanelData): HTMLElement {
  const f = d.file;
  if (!f) {
    const sec = section('ed-stats-file', '当前文件');
    sec.appendChild(el('div', 'ed-stats-note', '没有打开的文件'));
    return sec;
  }
  const chapter = !!f.goal || !!f.goalNote;
  const sec = section('ed-stats-file', chapter ? '本章' : '当前文件');
  const title = el('div', 'ed-stats-title', f.title);
  title.title = f.path;
  sec.appendChild(title);
  sec.appendChild(el('div', 'ed-stats-big', f.goal ? `${f.goal.count}，${f.goal.rest}` : `${groupDigits(f.words)} 字`));
  const bar = el('div', 'ed-stats-bar');
  const fill = el('div', 'ed-stats-fill');
  bar.appendChild(fill);
  setHidden(bar, !f.goal);
  if (f.goal) {
    fill.style.width = `${Math.min(100, Math.round(f.goal.ratio * 100))}%`;
    bar.classList.toggle('enough', f.goal.enough);
    bar.classList.toggle('over', f.goal.over);
  }
  sec.appendChild(bar);
  const notes = [f.goalNote, `${groupDigits(f.chars)} 字符（含标点与空白）`];
  if (f.headingExcluded) {
    notes.push('开头的「# 标题」那一行不算字数，与工程页同一个数法');
  }
  for (const note of notes) {
    if (note) {
      sec.appendChild(el('div', 'ed-stats-note', note));
    }
  }
  return sec;
}

function sessionSection(d: StatsPanelData): HTMLElement {
  const s = d.session;
  const sec = section('ed-stats-session', '本次码字', `从 ${clock(s.startedAt)} 起`);
  sec.appendChild(el('div', 'ed-stats-big', `${signedWords(s.words)} 字`));
  sec.appendChild(el('div', 'ed-stats-line', `写了 ${formatDuration(s.ms)} · ${speedText(s.words, s.ms)}`));
  return sec;
}

function todaySection(d: StatsPanelData): HTMLElement {
  const t = d.today;
  const sec = section('ed-stats-today', '今日码字', t.persisted ? '这个工程，刷新、几个窗口都累计' : undefined);
  sec.appendChild(el('div', 'ed-stats-big', `${groupDigits(t.words)} 字`));
  sec.appendChild(el('div', 'ed-stats-line', `写了 ${formatDuration(t.ms)} · ${speedText(t.words, t.ms)}`));
  if (!t.persisted) {
    sec.appendChild(el('div', 'ed-stats-note', '这个浏览器记不下来（或者还没打开工程），只算这一页。'));
  }
  return sec;
}

function filesSection(d: StatsPanelData): HTMLElement {
  const sec = section('ed-stats-files', '本次按文件');
  const files = d.session.files;
  if (files.length === 0) {
    sec.appendChild(el('div', 'ed-stats-note', '还没有动笔。'));
    return sec;
  }
  const list = el('div', 'ed-stats-list');
  for (const f of files) {
    const row = el('div', 'ed-stats-row');
    row.title = f.path;
    row.append(
      el('span', 'ed-stats-row-name', f.title || f.path),
      el('span', 'ed-stats-row-words', `${signedWords(f.words)} 字`),
      el('span', 'ed-stats-row-time', formatDuration(f.ms))
    );
    list.appendChild(row);
  }
  sec.appendChild(list);
  return sec;
}

function speedText(words: number, ms: number): string {
  const speed = speedPerHour(words, ms);
  return speed === undefined ? '写够 1 分钟才算速度' : `每小时约 ${groupDigits(speed)} 字`;
}

/** 贴着那一格往上弹，左右夹进视口。 */
function place(): void {
  if (!open) {
    return;
  }
  const rect = open.anchor.getBoundingClientRect();
  const width = open.panel.offsetWidth || 320;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  open.panel.style.left = `${Math.round(left)}px`;
  open.panel.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 6))}px`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
