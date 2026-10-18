/**
 * 全书查找替换：`Ctrl+Shift+F`（替换框 `Ctrl+Shift+H`，Mac 上 `Cmd`）或标题栏「编辑 → 全书查找替换…」。只在独立版
 * （editor.js 只在那儿加载，`editor/index.ts` 探测不到 `#wbEditor` 就整个不装）。
 *
 * ## 放在哪（⚑）
 *
 * **压在侧栏上**，与 VS Code 的「搜索」视图一样：面板挂进 `#wbSide`、侧栏挂 `bf-open`，原来那几页（对话、工程……）先藏起来，
 * 页头的任务条照常；编辑区一点都不挡——点一处、右边编辑区跳过去，左边的结果列表还在，对照着往下看。点活动栏上任一页签、
 * 面板上的 ×、Esc 收起（结果留着，再打开还在）。不做成浮层：浮层要么挡正文，要么挡结果。
 *
 * ## 查找
 *
 * 查找框里打字，**停顿 300ms** 才发（组字中途不发，`compositionend` 再算）；新的一次发出去之前先 `cancelBookFind` 上一次。
 * 区分大小写、正则两颗开关与查找条同一套语义（匹配口径是 core 的 `model/textFind.ts`，后端用的就是它）。范围六个勾选框，
 * 缺省只勾正文。结果按范围分组、按文件列：文件的称呼（与编辑器标签同一套）、一共几处、每一处一行上下文（命中的字高亮）。
 * **搜的是磁盘上的内容**（⚑）：编辑器里开着、有未保存修改的文件在结果上标「未保存」（列的是磁盘上那一份，替换时跳过）。
 *
 * 点某一处：那份文件已经开着就切过去，没开着就开成正常标签（不带临时标签的标记）；然后借查找条的定位（`find.ts` 的
 * `revealFindMatch`：换成同一个查找串与开关、按后端给的「行 + 列」认回编辑区里的位置、选中离它最近的那一处、滚过去）。
 *
 * ## 替换
 *
 * 填好替换框 →「预览替换」→ 每一处画成「旧字划掉 + 新字」，每一处、每个文件都有勾选框（缺省全勾；未保存的那几份勾不了）→
 * 「替换所选」（两段式：第一下只把字换成「再点一下：替换 N 个文件 M 处」，第二下才发，⚑）→ 汇总（替换了几个文件几处、
 * 每份都在「历史」里留着替换前那一版、跨文件没有一步撤销、指纹链怎么处理的、角色卡改名、跳过了哪些与为什么）。替换完自动
 * 再搜一次，列出还剩下的。写盘在后端（`features/bookReplace.ts`，经网关）；已开着的没改过的标签靠磁盘同步（`diskSync.ts`）
 * 就地换成新内容，改过的挂冲突条——这里什么都不用做。
 */
import { clear, el } from '../dom';
import { toast } from '../globals';
import {
  BOOK_FIND_SCOPES,
  BOOK_FIND_SCOPE_HINT,
  BOOK_FIND_SCOPE_LABEL,
  DEFAULT_BOOK_FIND_SCOPES,
} from '../protocol';
import type {
  BookFindFile,
  BookFindHit,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookReplaceSummary,
  InMessage,
  OutMessage,
} from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, isImeComposing, onEditorChange } from './api';
import {
  buildReplaceRequest,
  fileCheck,
  groupByScope,
  hitKey,
  offsetAt,
  pickedCount,
  pruneExcluded,
  resultNotes,
  resultStatus,
  sameQuery,
  summaryLines,
} from './bookFindCore';
import { isDialogOpen } from './dialog';
import { revealFindMatch } from './find';
import { seedFromSelection } from './findCore';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { allOpenFiles, announceActive, paneOwning, setActivePane } from './store';

/** 停顿多久才搜。 */
export const BOOK_FIND_DEBOUNCE_MS = 300;
/** 「替换所选」第一下之后，多久没点第二下就退回去。 */
const CONFIRM_MS = 4000;
/** 点了一处、那份文件还没开着：等它的 `editorOpen` 多久。 */
const JUMP_WAIT_MS = 3000;
const NO_WORKSPACE = '先打开一个工程，才能全书查找。';

interface PanelDom {
  root: HTMLElement;
  close: HTMLButtonElement;
  query: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  replace: HTMLInputElement;
  preview: HTMLButtonElement;
  scopes: Map<BookFindScope, HTMLInputElement>;
  status: HTMLElement;
  stop: HTMLButtonElement;
  notes: HTMLElement;
  summary: HTMLElement;
  actions: HTMLElement;
  replaceSelected: HTMLButtonElement;
  exitPreview: HTMLButtonElement;
  results: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let panel: PanelDom | null = null;

const opts = { caseSensitive: false, regex: false };
let mode: 'find' | 'preview' = 'find';
/** 正在等的那一次查找，与它的条件。 */
let waiting: string | null = null;
let waitingQuery: BookFindQuery | null = null;
/** 画着的结果，与它是按什么条件搜出来的（点一处时按它定位、替换时按它拼请求）。 */
let result: BookFindResult | null = null;
let resultQuery: BookFindQuery | null = null;
/** 预览里勾掉的那几处（`hitKey`）。 */
let excluded = new Set<string>();
/** 收起来的文件。 */
const collapsed = new Set<string>();
let replacing: string | null = null;
let summary: BookReplaceSummary | null = null;
let armed = false;
let armTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
/** 打开面板之前焦点在哪（Esc 收起时还回去）。 */
let returnFocus: HTMLElement | null = null;
/** 点了一处、那份文件还没开着：等它到了再定位。 */
let pendingJump: { path: string; hit: BookFindHit; query: BookFindQuery; until: number } | null = null;

// ---------------------------------------------------------------- 开关

function workspaceOpen(): boolean {
  return !document.body.classList.contains('no-workspace');
}

/** 页内对话框、弹窗开着时不开——那时作者在答别的问题。 */
function blocked(): boolean {
  return isDialogOpen() || !!document.querySelector('.modal-overlay:not(.hidden)');
}

function side(): HTMLElement | null {
  return document.getElementById('wbSide');
}

export function isBookFindOpen(): boolean {
  return !!panel && !panel.root.classList.contains('hidden');
}

/** 打开面板（已经开着就把焦点放回查找框）。`replace`：焦点进替换框（查找框还空着时仍进查找框）。 */
export function openBookFind(o: { replace?: boolean } = {}): void {
  if (!workspaceOpen()) {
    toast(NO_WORKSPACE);
    return;
  }
  if (blocked()) {
    return;
  }
  const p = ensurePanel();
  if (!isBookFindOpen()) {
    returnFocus = document.activeElement instanceof HTMLElement && !p.root.contains(document.activeElement) ? document.activeElement : null;
    p.root.classList.remove('hidden');
    side()?.classList.add('bf-open');
  }
  // 编辑区里选着一行之内的几个字：预填进查找框，当场搜。
  const ed = activeEditor();
  const seed = ed && !p.root.contains(document.activeElement)
    ? seedFromSelection(ed.area.value, ed.area.selectionStart, ed.area.selectionEnd)
    : undefined;
  if (seed !== undefined && seed !== p.query.value) {
    p.query.value = seed;
    inputsChanged(true);
  }
  const target = o.replace && p.query.value ? p.replace : p.query;
  target.focus();
  target.select();
}

/** 收起面板（结果留着，再打开还在）。`restoreFocus`：焦点还回打开之前的地方（Esc、×）。 */
export function closeBookFind(restoreFocus = false): void {
  if (!panel || !isBookFindOpen()) {
    return;
  }
  const hadFocus = panel.root.contains(document.activeElement);
  panel.root.classList.add('hidden');
  side()?.classList.remove('bf-open');
  disarm();
  if (restoreFocus && hadFocus && returnFocus?.isConnected) {
    returnFocus.focus();
  }
  returnFocus = null;
}

// ---------------------------------------------------------------- DOM

function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  return b;
}

function textInput(cls: string, placeholder: string): HTMLInputElement {
  const input = el('input', cls);
  // 不用 type="search"：Chrome 里在 search 框按 Esc 是清空文字，与「Esc 收起面板」打架（同查找条）。
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function ensurePanel(): PanelDom {
  if (panel) {
    return panel;
  }
  const root = el('section', 'bf-panel hidden');
  root.setAttribute('role', 'search');
  root.setAttribute('aria-label', '全书查找替换');

  const head = el('div', 'bf-head');
  const close = button('icon-btn bf-close', '×', '收起（Esc）');
  head.append(el('span', 'bf-title', '全书查找替换'), close);

  const findRow = el('div', 'bf-row');
  const query = textInput('bf-query', '全书查找');
  const caseBtn = button('ed-find-opt bf-case', 'Aa', '区分大小写');
  const regexBtn = button('ed-find-opt bf-regex', '.*', '正则表达式（与查找条同一套：替换里可以用 $1 引用分组）');
  for (const b of [caseBtn, regexBtn]) {
    b.setAttribute('aria-pressed', 'false');
  }
  findRow.append(query, caseBtn, regexBtn);

  const replaceRow = el('div', 'bf-row');
  const replace = textInput('bf-replace', '替换为');
  const preview = button('chip-btn bf-preview', '预览替换', '先列出每一处换成什么，看过、勾过再替换（Enter）');
  replaceRow.append(replace, preview);

  const scopeRow = el('div', 'bf-scopes');
  const scopes = new Map<BookFindScope, HTMLInputElement>();
  for (const scope of BOOK_FIND_SCOPES) {
    const label = el('label', 'bf-scope');
    label.title = BOOK_FIND_SCOPE_HINT[scope];
    const box = el('input');
    box.type = 'checkbox';
    box.dataset.scope = scope;
    box.checked = DEFAULT_BOOK_FIND_SCOPES.includes(scope);
    label.append(box, el('span', undefined, BOOK_FIND_SCOPE_LABEL[scope]));
    scopes.set(scope, box);
    scopeRow.appendChild(label);
  }

  const statusRow = el('div', 'bf-statusbar');
  const status = el('span', 'bf-status');
  status.setAttribute('aria-live', 'polite');
  const stop = button('chip-btn bf-stop hidden', '停止', '不搜了');
  statusRow.append(status, stop);

  const notes = el('div', 'bf-notes hidden');
  const summaryBox = el('div', 'bf-summary hidden');
  summaryBox.setAttribute('aria-live', 'polite');

  const actions = el('div', 'bf-actions hidden');
  const replaceSelected = button('primary bf-replace-selected', '替换所选', '');
  const exitPreview = button('secondary bf-exit-preview', '退出预览', '回到只查找');
  actions.append(replaceSelected, exitPreview);

  const results = el('div', 'bf-results');
  root.append(head, findRow, replaceRow, scopeRow, statusRow, notes, summaryBox, actions, results);

  panel = {
    root, close, query, caseBtn, regexBtn, replace, preview, scopes, status, stop,
    notes, summary: summaryBox, actions, replaceSelected, exitPreview, results,
  };
  wire(panel);
  (side() ?? document.body).appendChild(root);
  return panel;
}

function wire(p: PanelDom): void {
  p.query.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      inputsChanged();
    }
  });
  p.query.addEventListener('compositionend', () => inputsChanged());
  p.replace.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      replacementChanged();
    }
  });
  p.replace.addEventListener('compositionend', () => replacementChanged());
  p.query.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  p.replace.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      startPreview();
    }
  });
  // 面板里任何一处按 Esc 都是收起（组字中途的 Esc 是输入法的）。
  p.root.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBookFind(true);
    }
  });
  p.close.addEventListener('click', () => closeBookFind(true));
  p.caseBtn.addEventListener('click', () => toggleOption(p.caseBtn, 'caseSensitive'));
  p.regexBtn.addEventListener('click', () => toggleOption(p.regexBtn, 'regex'));
  for (const box of p.scopes.values()) {
    box.addEventListener('change', () => inputsChanged(true));
  }
  p.preview.addEventListener('click', startPreview);
  p.exitPreview.addEventListener('click', () => {
    mode = 'find';
    excluded.clear();
    runSearch();
  });
  p.replaceSelected.addEventListener('click', replaceSelected);
  p.stop.addEventListener('click', stopSearch);
}

function toggleOption(btn: HTMLButtonElement, key: 'caseSensitive' | 'regex'): void {
  opts[key] = !opts[key];
  btn.classList.toggle('on', opts[key]);
  btn.setAttribute('aria-pressed', String(opts[key]));
  inputsChanged(true);
}

// ---------------------------------------------------------------- 查找

/** 面板上此刻的查找条件。预览时带替换框里的字。 */
function currentQuery(): BookFindQuery {
  const p = panel!;
  return {
    query: p.query.value,
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    scopes: BOOK_FIND_SCOPES.filter((s) => p.scopes.get(s)?.checked),
    ...(mode === 'preview' ? { replacement: p.replace.value } : {}),
  };
}

/** 查找框、开关、范围变了：汇总收起、两段式退回，停顿之后再搜（`now`：开关、范围这种一下就定的，当场搜）。 */
function inputsChanged(now = false): void {
  summary = null;
  disarm();
  if (now) {
    runSearch();
  } else {
    scheduleSearch();
  }
}

/** 替换框变了：预览时停顿之后重新预览；只查找时不用搜。 */
function replacementChanged(): void {
  summary = null;
  disarm();
  if (mode === 'preview') {
    scheduleSearch();
  } else {
    render();
  }
}

function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, BOOK_FIND_DEBOUNCE_MS);
  render();
}

/** 叫停还在路上的那一次（不回话，前端也不再等它）。 */
function cancelWaiting(): void {
  if (waiting) {
    post({ type: 'cancelBookFind', requestId: waiting });
    claimRequest(waiting);
    waiting = null;
    waitingQuery = null;
  }
}

/** 照面板上此刻的条件搜一次（预览时就是预览）。查找框空着、一个范围都没勾：清掉结果，不发。 */
function runSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  if (!panel) {
    return;
  }
  cancelWaiting();
  const q = currentQuery();
  if (!q.query || q.scopes.length === 0) {
    result = null;
    resultQuery = null;
    render();
    return;
  }
  waiting = newRequestId('bookfind');
  waitingQuery = q;
  post({ type: 'bookFind', requestId: waiting, query: q });
  render();
}

function stopSearch(): void {
  cancelWaiting();
  render();
  setStatus('已停止');
}

function startPreview(): void {
  if (!panel || !panel.query.value) {
    panel?.query.focus();
    return;
  }
  mode = 'preview';
  summary = null;
  disarm();
  runSearch();
}

function onResult(msg: Extract<OutMessage, { type: 'bookFindResult' }>): void {
  if (msg.requestId !== waiting || !claimRequest(msg.requestId)) {
    return;
  }
  result = msg.result;
  resultQuery = waitingQuery;
  waiting = null;
  waitingQuery = null;
  excluded = pruneExcluded(excluded, result.files);
  render();
}

// ---------------------------------------------------------------- 替换

/** 编辑器里开着、有未保存修改的文件（替换时跳过）。 */
function dirtyPaths(): string[] {
  return allOpenFiles()
    .filter((f) => f.draft !== f.text)
    .map((f) => f.path);
}

/** 画着的是不是一份预览，而且条件与面板上此刻的一样（预览之后又改了输入框，就得等新的预览回来）。 */
function previewReady(): boolean {
  return !!result && !!resultQuery && resultQuery.replacement !== undefined && !waiting && !searchTimer && sameQuery(resultQuery, currentQuery());
}

function disarm(): void {
  clearTimeout(armTimer);
  armTimer = undefined;
  if (armed) {
    armed = false;
    renderActions();
  }
}

function replaceSelected(): void {
  if (!panel || !result || !resultQuery || replacing || !previewReady()) {
    return;
  }
  const dirty = dirtyPaths();
  const picked = pickedCount(result.files, excluded, new Set(dirty));
  if (picked.hits === 0) {
    return;
  }
  if (!armed) {
    // 两段式：第一下只换字，第二下才发（改了任何一处勾选、输入框，退回第一段）。
    armed = true;
    armTimer = setTimeout(disarm, CONFIRM_MS);
    renderActions();
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  replacing = newRequestId('bookreplace');
  post({ type: 'bookReplace', requestId: replacing, request: buildReplaceRequest(resultQuery, result, excluded, dirty) });
  render();
}

function onReplaced(msg: Extract<OutMessage, { type: 'bookReplaceDone' }>): void {
  if (msg.requestId !== replacing || !claimRequest(msg.requestId)) {
    return;
  }
  replacing = null;
  summary = msg.summary;
  if (msg.summary.error && msg.summary.files === 0) {
    // 什么都没做（上一次还没换完、正则写错）：预览留着。
    render();
    return;
  }
  // 换过了：预览作废（磁盘上的 hash 都变了），回到只查找、再搜一次——列出来的是还剩下的。
  mode = 'find';
  excluded.clear();
  result = null;
  resultQuery = null;
  runSearch();
}

// ---------------------------------------------------------------- 点一处

function jumpTo(file: BookFindFile, hit: BookFindHit): void {
  const query = resultQuery;
  if (!query) {
    return;
  }
  if (paneOwning(file.path)) {
    revealHit(file.path, hit, query);
    return;
  }
  // 开成正常标签（不带临时标签的标记）：从结果里点过去的是作者明确要看的那一份。
  pendingJump = { path: file.path, hit, query, until: Date.now() + JUMP_WAIT_MS };
  post({ type: 'openEditor', path: file.path, pane: 'main' });
}

function revealHit(path: string, hit: BookFindHit, query: BookFindQuery): void {
  const pane = paneOwning(path);
  if (!pane) {
    return;
  }
  if (pane.activePath !== path) {
    pane.activate(path);
  } else {
    setActivePane(pane);
    announceActive();
  }
  pane.setPreviewing(false);
  revealEditor();
  const offset = offsetAt(pane.area.value, hit.line, hit.col);
  if (!revealFindMatch(pane, query.query, { caseSensitive: query.caseSensitive, regex: query.regex }, offset)) {
    toast('这一处在编辑区里找不到了（可能有没保存的修改）。', true);
  }
}

function settleJump(path: string): void {
  if (!pendingJump) {
    return;
  }
  if (Date.now() > pendingJump.until) {
    pendingJump = null;
    return;
  }
  if (pendingJump.path === path) {
    const { hit, query } = pendingJump;
    pendingJump = null;
    revealHit(path, hit, query);
  }
}

// ---------------------------------------------------------------- 画

function setStatus(text: string): void {
  if (panel) {
    panel.status.textContent = text;
  }
}

function render(): void {
  if (!panel) {
    return;
  }
  renderStatus();
  renderSummary();
  renderResults();
  renderActions();
}

function renderStatus(): void {
  const p = panel!;
  const q = currentQuery();
  p.stop.classList.toggle('hidden', !waiting);
  p.query.classList.toggle('invalid', !!result?.error && !waiting);
  p.preview.disabled = !q.query || q.scopes.length === 0;
  const notes = result && !waiting ? resultNotes(result) : [];
  p.notes.textContent = '';
  for (const n of notes) {
    p.notes.appendChild(el('div', 'bf-note', n));
  }
  p.notes.classList.toggle('hidden', notes.length === 0);
  if (replacing) {
    setStatus('正在替换…');
  } else if (waiting) {
    setStatus(mode === 'preview' ? '正在预览…' : '正在搜…');
  } else if (!q.query) {
    setStatus('输入要找的字，停一下就开始搜。');
  } else if (q.scopes.length === 0) {
    setStatus('至少勾一个范围。');
  } else if (searchTimer) {
    setStatus('');
  } else if (result) {
    const dirty = new Set(dirtyPaths());
    const blockedFiles = result.files.filter((f) => dirty.has(f.path)).length;
    const isPreview = resultQuery?.replacement !== undefined;
    setStatus(resultStatus(result, isPreview ? pickedCount(result.files, excluded, dirty) : undefined, isPreview ? blockedFiles : 0));
  } else {
    setStatus('');
  }
  // 正则写错时，浏览器给的原因放在提示里。
  p.status.title = result?.error && !waiting ? result.error : '';
}

function renderSummary(): void {
  const box = panel!.summary;
  clear(box);
  box.classList.toggle('hidden', !summary);
  if (!summary) {
    return;
  }
  for (const line of summaryLines(summary)) {
    box.appendChild(el('div', `bf-summary-line${line.tone ? ` ${line.tone}` : ''}`, line.text));
  }
  const dismiss = button('icon-btn bf-summary-close', '×', '收起汇总');
  dismiss.addEventListener('click', () => {
    summary = null;
    renderSummary();
  });
  box.appendChild(dismiss);
}

function renderActions(): void {
  if (!panel) {
    return;
  }
  const p = panel;
  const isPreview = !!resultQuery && resultQuery.replacement !== undefined && !!result && result.files.length > 0;
  p.actions.classList.toggle('hidden', mode !== 'preview');
  p.exitPreview.disabled = !!replacing;
  if (!isPreview || !result) {
    p.replaceSelected.disabled = true;
    p.replaceSelected.textContent = '替换所选';
    p.replaceSelected.classList.remove('confirm');
    return;
  }
  const picked = pickedCount(result.files, excluded, new Set(dirtyPaths()));
  p.replaceSelected.disabled = picked.hits === 0 || !!replacing || !previewReady();
  p.replaceSelected.classList.toggle('confirm', armed);
  p.replaceSelected.textContent = armed
    ? `再点一下：替换 ${picked.files} 个文件 ${picked.hits} 处`
    : `替换所选（${picked.files} 个文件 ${picked.hits} 处）`;
  p.replaceSelected.title = armed
    ? '经网关逐份写；每份先在「历史」里存一版替换前的，跨文件没有一步撤销'
    : '先点一下，按钮上写明替换几个文件几处，再点一下才替换';
}

function renderResults(): void {
  const box = panel!.results;
  const top = box.scrollTop;
  clear(box);
  if (!result || result.files.length === 0) {
    return;
  }
  const isPreview = resultQuery?.replacement !== undefined;
  const dirty = new Set(dirtyPaths());
  for (const group of groupByScope(result.files)) {
    box.appendChild(el('div', 'bf-group', `${group.label} · ${group.files.length} 个文件 ${group.hits} 处`));
    for (const file of group.files) {
      box.appendChild(fileBlock(file, isPreview, dirty.has(file.path)));
    }
  }
  box.scrollTop = top;
}

function fileBlock(file: BookFindFile, isPreview: boolean, dirty: boolean): HTMLElement {
  const block = el('div', `bf-file${dirty ? ' dirty' : ''}${collapsed.has(file.path) ? ' collapsed' : ''}`);
  block.dataset.path = file.path;

  const head = el('div', 'bf-file-head');
  head.appendChild(el('span', 'bf-twisty', collapsed.has(file.path) ? '▸' : '▾'));
  if (isPreview) {
    const box = el('input', 'bf-file-check');
    box.type = 'checkbox';
    const state = dirty ? 'none' : fileCheck(file, excluded);
    box.checked = state === 'all';
    box.indeterminate = state === 'some';
    box.disabled = dirty;
    box.title = dirty ? '编辑器里有未保存的修改：替换时跳过' : '这份文件里的每一处';
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      for (const hit of file.hits) {
        const key = hitKey(file.path, hit);
        if (box.checked) {
          excluded.delete(key);
        } else {
          excluded.add(key);
        }
      }
      selectionChanged();
    });
    head.appendChild(box);
  }
  const label = el('span', 'bf-file-label', file.label);
  label.title = file.path;
  head.appendChild(label);
  head.appendChild(el('span', 'bf-file-count', file.count > file.hits.length ? `${file.hits.length}/${file.count}` : String(file.count)));
  if (dirty) {
    const badge = el('span', 'bf-dirty', '未保存');
    badge.title = '编辑器里有未保存的修改：这里列的是磁盘上的内容，替换时会跳过它——先保存或放弃修改';
    head.appendChild(badge);
  }
  head.addEventListener('click', () => {
    if (collapsed.has(file.path)) {
      collapsed.delete(file.path);
    } else {
      collapsed.add(file.path);
    }
    block.classList.toggle('collapsed', collapsed.has(file.path));
    head.querySelector('.bf-twisty')!.textContent = collapsed.has(file.path) ? '▸' : '▾';
  });
  block.appendChild(head);

  const hits = el('div', 'bf-hits');
  for (const hit of file.hits) {
    hits.appendChild(hitRow(file, hit, isPreview, dirty));
  }
  block.appendChild(hits);
  return block;
}

function hitRow(file: BookFindFile, hit: BookFindHit, isPreview: boolean, dirty: boolean): HTMLElement {
  const key = hitKey(file.path, hit);
  const row = el('div', 'bf-hit');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.start = String(hit.start);
  row.title = `${file.label} · 第 ${hit.line} 行`;
  if (isPreview) {
    const box = el('input', 'bf-hit-check');
    box.type = 'checkbox';
    box.checked = !dirty && !excluded.has(key);
    box.disabled = dirty;
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      if (box.checked) {
        excluded.delete(key);
      } else {
        excluded.add(key);
      }
      selectionChanged();
    });
    row.appendChild(box);
  }
  row.appendChild(el('span', 'bf-line', String(hit.line)));
  const ctx = el('span', 'bf-ctx');
  ctx.appendChild(document.createTextNode(hit.before));
  if (isPreview && hit.replacement !== undefined) {
    ctx.appendChild(el('del', 'bf-old', hit.text));
    const ins = el('ins', 'bf-new', hit.replacement.replace(/\r?\n/g, '↵'));
    if (!hit.replacement) {
      ins.title = '换成空的（删掉）';
    }
    ctx.appendChild(ins);
  } else {
    ctx.appendChild(el('mark', 'bf-mark', hit.text));
  }
  ctx.appendChild(document.createTextNode(hit.after));
  row.appendChild(ctx);
  row.addEventListener('click', () => jumpTo(file, hit));
  row.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      jumpTo(file, hit);
    }
  });
  return row;
}

/** 勾选变了：文件那一格的三态、状态行、按钮上的数跟着改（不整个重画，滚动位置不动）。 */
function selectionChanged(): void {
  disarm();
  if (!panel || !result) {
    return;
  }
  for (const block of panel.results.querySelectorAll<HTMLElement>('.bf-file')) {
    const file = result.files.find((f) => f.path === block.dataset.path);
    const box = block.querySelector<HTMLInputElement>('.bf-file-check');
    if (file && box && !box.disabled) {
      const state = fileCheck(file, excluded);
      box.checked = state === 'all';
      box.indeterminate = state === 'some';
      block.querySelectorAll<HTMLInputElement>('.bf-hit-check').forEach((hb, i) => {
        hb.checked = !excluded.has(hitKey(file.path, file.hits[i]));
      });
    }
  }
  renderStatus();
  renderActions();
}

/** 编辑器里改了 / 存了：「未保存」的标记与勾选、计数跟着变（停一下再画）。 */
function scheduleDirtyRefresh(): void {
  if (!isBookFindOpen() || !result) {
    return;
  }
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = undefined;
    if (isBookFindOpen() && result) {
      renderStatus();
      renderResults();
      renderActions();
    }
  }, 250);
}

// ---------------------------------------------------------------- 装配

function resetAll(): void {
  closeBookFind(false);
  cancelWaiting();
  clearTimeout(searchTimer);
  searchTimer = undefined;
  result = null;
  resultQuery = null;
  replacing = null;
  summary = null;
  excluded = new Set();
  collapsed.clear();
  pendingJump = null;
  mode = 'find';
  disarm();
  if (panel) {
    panel.query.value = '';
    panel.replace.value = '';
    render();
  }
}

let installed = false;

/**
 * 装上 Ctrl+Shift+F / Ctrl+Shift+H、「编辑 → 全书查找替换…」、结果与汇总的接收。`editor/index.ts` 调一次，**要在它自己的
 * `onMessage` 之后**：点了一处、那份文件的 `editorOpen` 先让编辑区收下，这里才找得到拥有它的那一块。
 */
export function installBookFind(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) {
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const isF = key === 'f' || e.code === 'KeyF';
    const isH = key === 'h' || e.code === 'KeyH';
    if (!isF && !isH) {
      return;
    }
    e.preventDefault();
    openBookFind({ replace: isH });
  });

  window.addEventListener('nf-bookfind-query', (e) => {
    e.detail.available = workspaceOpen();
    e.detail.reason = e.detail.available ? undefined : NO_WORKSPACE;
  });
  window.addEventListener('nf-bookfind-command', (e) => {
    openBookFind({ replace: e.detail.name === 'openReplace' });
  });

  // 点活动栏上任一页签：收起面板，让那一页露出来（结果留着）。
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('.tabbar .tab')) {
      closeBookFind(false);
    }
  });

  window.addEventListener('nf-workspace-reset', resetAll);

  onEditorChange((ev) => {
    if (ev.type === 'edit' || ev.type === 'render') {
      scheduleDirtyRefresh();
    }
  });

  onMessage((msg) => {
    if (msg.type === 'bookFindResult') {
      onResult(msg);
    } else if (msg.type === 'bookReplaceDone') {
      onReplaced(msg);
    } else if (msg.type === 'editorOpen') {
      settleJump(msg.file.path);
    } else if (msg.type === 'editorSaved') {
      scheduleDirtyRefresh();
    }
  });
}
