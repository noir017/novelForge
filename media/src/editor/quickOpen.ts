/**
 * 「转到…」：`Ctrl+P`（Mac 上 `Cmd+P`）或标题栏「文件 → 转到…」，页面顶部居中一个输入框 + 候选列表，
 * 按章号、标题、角色名 / 别名、设定标题、路径找一章或一个文件打开。只在独立版（editor.js 只在那儿加载，
 * `editor/index.ts` 探测不到 `#wbEditor` 就整个不装）。
 *
 * ## 数据
 *
 * 打开时发 `requestQuickOpen`（带 requestId），后端回 `quickOpenIndex`（`core/views/quickOpen.ts`）。**按需要**，
 * 不常驻推送；面板开着时工程变了不刷新，下次打开再要。上一次的索引留着：再打开时先拿它画（几百章也是当场出），
 * 新的一到就换掉。匹配与排序全在零 DOM 的 `quickOpenCore.ts`。
 *
 * ## 键盘（照 `/` 命令面板的教训）
 *
 * - 过滤串**从输入框的值算**，重算挂在 `input` 事件上（组字中途的不算，`compositionend` 再算一次），不在 keydown
 *   里攒字——输入法打的中文、退格、粘贴全都自动对。
 * - 输入框只接管 ↑↓ / Enter / Ctrl+Enter / Esc（Tab 留在面板里）；组字中途一个都不拦（`isImeComposing`）。
 * - `Ctrl+P` 在焦点落在编辑区之外的输入框 / 文本框（左侧对话输入框之类）时照样能用——这个键在那些地方没有别的用处；
 *   Chrome 允许页面拦下「打印」。没开工程时不开面板，只说一句（也不弹打印）。页内对话框、弹窗开着时不开。
 *
 * ## 打开什么
 *
 * - 章节：Enter 与工程页点章节行**同一个动作**（`openChapter`：正文进主区，有细纲时并排开细纲；没有正文开细纲）；
 *   Ctrl+Enter 把正文（没有正文时是细纲）开在第二块编辑区。
 * - 角色卡、设定、架构几件、草稿：打开那个文件（Ctrl+Enter 开在第二块）。
 * - 打开后焦点进编辑区：等那份文件的 `editorOpen` 到了，把焦点放进拥有它的那一块（章节并排的细纲随后才到，
 *   到了也把焦点留在正文那一块）。
 *
 * ## 最近打开的
 *
 * 编辑器里每激活一份文件（`nf-editor-active`，不论从哪打开的）记一笔，按工程记在 localStorage
 * （`novelforge.quickopen.recent@<工程>`），记不进去就算了。空输入时列出来（按路径认回条目：同一章的正文与细纲
 * 算一条，删了的、不在索引里的跳过），后面接前几章。
 */
import { clear, el } from '../dom';
import { projectStorageKey, toast } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isImeComposing } from './api';
import { isDialogOpen } from './dialog';
import {
  QUICK_OPEN_LIMIT,
  RECENT_KEPT,
  buildCatalog,
  highlightSegments,
  pushRecent,
  searchQuickOpen,
} from './quickOpenCore';
import type { QuickOpenCatalog, QuickOpenEntry, QuickOpenHit } from './quickOpenCore';
import { claimRequest, newRequestId } from './replace';
import { shortcutLabel } from './shortcuts';
import { announceActive, paneOwning, setActivePane } from './store';

const RECENT_KEY = 'novelforge.quickopen.recent';
/** 打开之后等那份文件的 `editorOpen` 多久（之后到的不再抢焦点）。 */
const FOCUS_WAIT_MS = 3000;
const NO_WORKSPACE = '先打开一个工程，才能转到章节或文件。';

interface PanelDom {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  note: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let panel: PanelDom | null = null;
/** 最近一份索引（切好的）。换工程时作废。 */
let catalog: QuickOpenCatalog | null = null;
/** 正在等的那一次请求。 */
let waiting: string | null = null;
let hits: QuickOpenHit[] = [];
let active = 0;
/** 打开面板之前焦点在哪（Esc 关掉时还回去）。 */
let returnFocus: HTMLElement | null = null;
/** 打开之后焦点要落进哪份文件所在的那一块，以及还在等哪几份的 `editorOpen`。 */
let focusAfter: { path: string; expect: Set<string>; until: number } | null = null;

// ---------------------------------------------------------------- 最近打开的

function loadRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(projectStorageKey(RECENT_KEY)) || '[]');
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string').slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

function rememberOpened(path: string): void {
  try {
    const list = loadRecent();
    if (list[0] === path) {
      return;
    }
    localStorage.setItem(projectStorageKey(RECENT_KEY), JSON.stringify(pushRecent(list, path)));
  } catch {
    /* 隐私模式下写不进去：没有「最近打开的」，别的照常 */
  }
}

// ---------------------------------------------------------------- 开关

function workspaceOpen(): boolean {
  return !document.body.classList.contains('no-workspace');
}

/** 页内对话框、弹窗（表单、合并视图、目录选择器）开着时不开面板——那时作者在答别的问题。 */
function blocked(): boolean {
  return isDialogOpen() || !!document.querySelector('.modal-overlay:not(.hidden)');
}

/** 打开「转到」面板。已经开着就把输入框里的字全选上。 */
export function openQuickOpen(): void {
  if (panel) {
    panel.input.focus();
    panel.input.select();
    return;
  }
  if (!workspaceOpen()) {
    toast(NO_WORKSPACE);
    return;
  }
  if (blocked()) {
    return;
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel = buildPanel();
  document.body.appendChild(panel.root);
  document.addEventListener('mousedown', onOutside, true);
  panel.input.focus();
  waiting = newRequestId('quickopen');
  post({ type: 'requestQuickOpen', requestId: waiting });
  render();
}

/** 关掉面板。`restoreFocus`：焦点还回打开之前的地方（Esc）；打开了某一项时不还（焦点要进编辑区）。 */
export function closeQuickOpen(restoreFocus = false): void {
  if (!panel) {
    return;
  }
  document.removeEventListener('mousedown', onOutside, true);
  const hadFocus = panel.root.contains(document.activeElement);
  panel.root.remove();
  panel = null;
  hits = [];
  if (restoreFocus && hadFocus && returnFocus?.isConnected) {
    returnFocus.focus();
  }
  returnFocus = null;
}

/** 点在面板外面：关掉（不还焦点——点到哪儿焦点就该去哪儿）。 */
function onOutside(e: MouseEvent): void {
  if (panel && !panel.root.contains(e.target as Node)) {
    closeQuickOpen(false);
  }
}

// ---------------------------------------------------------------- DOM

function buildPanel(): PanelDom {
  const root = el('div', 'qo-panel');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '转到');
  const input = el('input', 'qo-input');
  input.type = 'text';
  input.placeholder = '转到：章号（12、第十二章）、标题、角色名、设定或路径';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  const list = el('div', 'qo-list');
  list.setAttribute('role', 'listbox');
  list.id = 'qoList';
  input.setAttribute('aria-controls', list.id);
  const note = el('div', 'qo-note hidden');
  note.setAttribute('aria-live', 'polite');
  const foot = el('div', 'qo-foot', `↑↓ 选择 · Enter 打开 · ${shortcutLabel('quickOpenBeside')} 开在另一块编辑区 · Esc 关闭`);
  root.append(input, list, note, foot);

  input.addEventListener('input', (e) => {
    // 组字中途（拼音还没上屏）不重算：compositionend 之后那一下再算。
    if ((e as InputEvent).isComposing) {
      return;
    }
    render();
  });
  input.addEventListener('compositionend', () => render());
  input.addEventListener('keydown', onKey);
  return { root, input, list, note };
}

function onKey(e: KeyboardEvent): void {
  if (isImeComposing(e)) {
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      if (hits.length > 0) {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + hits.length) % hits.length;
        markActive();
      }
      return;
    }
    case 'Enter': {
      e.preventDefault();
      const hit = hits[active];
      if (hit) {
        openEntry(hit.entry, e.ctrlKey || e.metaKey);
      }
      return;
    }
    case 'Escape':
      e.preventDefault();
      // 别让标题栏、查找条那几个 document 上的 Esc 再处理一遍。
      e.stopPropagation();
      closeQuickOpen(true);
      return;
    case 'Tab':
      // 焦点留在面板里：Tab 出去等于面板还开着、键盘却不归它了。
      e.preventDefault();
      return;
  }
}

/**
 * 按输入框的值重算、重画。输入变了选中回到第一条；`keepActive`（新索引到了、输入没变）时尽量停在原来那一条上。
 */
function render(keepActive = false): void {
  if (!panel) {
    return;
  }
  const query = panel.input.value;
  const activeKey = keepActive ? hits[active]?.entry.key : undefined;
  const result = catalog ? searchQuickOpen(catalog, query, { limit: QUICK_OPEN_LIMIT, recent: loadRecent() }) : { hits: [], total: 0 };
  hits = result.hits;
  const kept = activeKey ? hits.findIndex((h) => h.entry.key === activeKey) : -1;
  active = kept >= 0 ? kept : 0;

  clear(panel.list);
  let group: QuickOpenHit['group'];
  hits.forEach((hit, i) => {
    if (hit.group && hit.group !== group) {
      group = hit.group;
      panel!.list.appendChild(el('div', 'qo-section', group === 'recent' ? '最近打开的' : '章节'));
    }
    panel!.list.appendChild(buildRow(hit, i));
  });
  setNote(noteFor(query, result.total));
  markActive();
}

function noteFor(query: string, total: number): string {
  if (!catalog) {
    return '正在读取这本书的章节与文件…';
  }
  if (!catalog.initialized) {
    return '这个文件夹还不是小说工程，没有可转到的章节。';
  }
  if (query.trim() === '') {
    return hits.length === 0 ? '还没有章节，也没有最近打开过的文件。' : '';
  }
  if (total === 0) {
    return '没有匹配的章节、角色、设定或文件。';
  }
  if (total > hits.length) {
    return `只列出前 ${hits.length} 条（一共 ${total} 条），多打几个字缩小范围。`;
  }
  return '';
}

function setNote(text: string): void {
  if (!panel) {
    return;
  }
  panel.note.textContent = text;
  panel.note.classList.toggle('hidden', text === '');
}

function buildRow(hit: QuickOpenHit, i: number): HTMLElement {
  const { entry } = hit;
  const row = el('div', `qo-item qo-${entry.kind}`);
  row.setAttribute('role', 'option');
  row.id = `qoItem${i}`;
  row.dataset.key = entry.key;
  row.title = entry.path;

  row.appendChild(el('span', `qo-badge qo-badge-${entry.kind}`, entry.badge));
  const text = el('span', 'qo-text');
  text.appendChild(highlighted('qo-name', entry.name, hit.nameHits));
  text.appendChild(highlighted('qo-detail', hit.detail, hit.detailHits));
  row.appendChild(text);

  // 点一下不该把焦点从输入框拿走（拿走了 ↑↓ 就不归面板了）。
  row.addEventListener('mousedown', (e) => e.preventDefault());
  row.addEventListener('click', (e) => openEntry(entry, e.ctrlKey || e.metaKey));
  return row;
}

/** 一段字，命中的字包进 `<mark>`。不拼 HTML：一截一截 textContent。 */
function highlighted(cls: string, text: string, hitsAt: readonly number[]): HTMLElement {
  const node = el('span', cls);
  for (const seg of highlightSegments(text, hitsAt)) {
    node.appendChild(seg.hit ? el('mark', undefined, seg.text) : document.createTextNode(seg.text));
  }
  return node;
}

function markActive(): void {
  if (!panel) {
    return;
  }
  const rows = panel.list.querySelectorAll<HTMLElement>('.qo-item');
  rows.forEach((row, i) => {
    const on = i === active;
    row.classList.toggle('active', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const current = rows[active];
  if (current) {
    panel.input.setAttribute('aria-activedescendant', current.id);
    if (typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest' });
    }
  } else {
    panel.input.removeAttribute('aria-activedescendant');
  }
}

// ---------------------------------------------------------------- 打开

/**
 * 打开一条。`other`：开在第二块编辑区（Ctrl+Enter / Ctrl+点击）。
 *
 * 不带「临时标签」那一类标记：从这里打开是作者明确要去的地方，开成正常的标签。
 */
function openEntry(entry: QuickOpenEntry, other: boolean): void {
  closeQuickOpen(false);
  let expect: string[];
  if (entry.kind === 'chapter' && !other) {
    // 与工程页点章节行同一个动作：后端按宿主能力开正文与并排的细纲。
    post({ type: 'openChapter', plotRelPath: entry.path });
    expect = [entry.chapterPath, entry.plotPath].filter((p): p is string => !!p);
  } else {
    post({ type: 'openEditor', path: entry.path, pane: other ? 'draft' : 'main' });
    expect = [entry.path];
  }
  focusAfter = { path: entry.path, expect: new Set(expect), until: Date.now() + FOCUS_WAIT_MS };
}

/** 打开的那份文件到了：焦点放进拥有它的那一块。章节并排的细纲随后才到，到了也把焦点留在正文那一块。 */
function settleFocus(path: string): void {
  if (!focusAfter) {
    return;
  }
  if (Date.now() > focusAfter.until) {
    focusAfter = null;
    return;
  }
  if (!focusAfter.expect.delete(path)) {
    return;
  }
  const pane = paneOwning(focusAfter.path);
  if (pane) {
    setActivePane(pane);
    announceActive();
    pane.area.focus();
  }
  if (focusAfter.expect.size === 0) {
    focusAfter = null;
  }
}

// ---------------------------------------------------------------- 装配

function onIndex(msg: Extract<OutMessage, { type: 'quickOpenIndex' }>): void {
  if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
    return;
  }
  waiting = null;
  catalog = buildCatalog(msg.index);
  render(true);
}

let installed = false;

/**
 * 装上 Ctrl+P、「文件 → 转到…」、索引与 `editorOpen` 的接收、最近打开的记录。`editor/index.ts` 调一次，
 * **要在它自己的 `onMessage` 之后**：`editorOpen` 先让编辑区收下文件，这里才找得到拥有它的那一块。
 */
export function installQuickOpen(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
      return;
    }
    if (e.key !== 'p' && e.key !== 'P' && e.code !== 'KeyP') {
      return;
    }
    // 浏览器的「打印」在这里没有用处（Chrome 允许页面拦下它）。
    e.preventDefault();
    openQuickOpen();
  });

  window.addEventListener('nf-quickopen-query', (e) => {
    e.detail.available = workspaceOpen();
    e.detail.reason = e.detail.available ? undefined : NO_WORKSPACE;
  });
  window.addEventListener('nf-quickopen-command', (e) => {
    if (e.detail.name === 'open') {
      openQuickOpen();
    }
  });

  window.addEventListener('nf-editor-active', (e) => {
    if (e.detail.path && workspaceOpen()) {
      rememberOpened(e.detail.path);
    }
  });

  window.addEventListener('nf-workspace-reset', () => {
    closeQuickOpen(false);
    catalog = null;
    waiting = null;
    focusAfter = null;
  });

  onMessage((msg) => {
    if (msg.type === 'quickOpenIndex') {
      onIndex(msg);
    } else if (msg.type === 'editorOpen') {
      settleFocus(msg.file.path);
    }
  });
}
