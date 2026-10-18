/**
 * 历史版本面板（独立版的内置编辑器）。快照由网关在每次覆盖一份创作产物之前存（`core/workspace/history.ts`），
 * 这里只看、只换编辑区里的内容——**恢复从不直接写盘**（第 3 条）。
 *
 * - **入口**：工具栏「历史」按钮（每块编辑区一颗，第一次重画时插到「保存」前面，与 `layout.ts` 的「排版」同一个
 *   做法，`page.ts` / `createPaneElements` 里没有它）；标题栏「文件 → 历史版本…」（`view/versionsMenu.ts`，经
 *   `nf-versions-query` / `nf-versions-command`）。没开文件、没打开工程、还不是小说工程、文件不是工程里的
 *   创作产物（`kind` 是 `other`）时两处都置灰，提示里说为什么。
 * - **面板是编辑区右侧的抽屉**（`.ed-versions`，挂在 `.ed-stage` 里，开着时正文区让出那一截宽度）：编辑区同时
 *   看得见。跟着这块编辑区的当前文件走——换了文件就换成那一份的列表，保存之后（`hash` 变了）重新拉一次。
 * - **列表**：新的在前，「3 分钟前 · 14:32」、多少字、比编辑区里当前这份多 / 少几个字；没有快照时照实说，
 *   并说明什么时候会存。「现在存一版」把**磁盘上当前**那一份存一个快照（不是编辑器里没保存的那份）。
 * - **选中一个**：先要全文（`readVersion` → `versionText`）给一段预览，然后
 *   - 「对比…」：`compareVersion`，后端开合并视图（快照 ↔ 编辑器当前内容，逐处挑），采纳之后经 `editorReplace`
 *     换进编辑区（`replace.ts`：一步撤销，基线不变，成为未保存）；
 *   - 「恢复这一版」：`replaceInEditor` 直接把编辑区换成这个快照（一步撤销，成为未保存，存不存由作者）。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import type { InMessage, OutMessage, VersionView } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { claimRequest, newRequestId, replaceInEditor } from './replace';
import { countWords } from './words';

type VersionsMessage = Extract<OutMessage, { type: 'versions' }>;
type VersionTextMessage = Extract<OutMessage, { type: 'versionText' }>;

/** 一块编辑区的抽屉。 */
interface Drawer {
  pane: Pane;
  root: HTMLElement;
  file: HTMLElement;
  note: HTMLElement;
  saveNow: HTMLButtonElement;
  list: HTMLElement;
  open: boolean;
  /** 列表是哪份文件的、拉列表时它的 hash（保存之后 hash 变了就重拉）。 */
  path: string | null;
  hash: string | null;
  /** undefined = 载入中。 */
  entries?: VersionView[];
  unavailable?: string;
  selected?: string;
  preview?: { id: string; requestId: string; text?: string; error?: string };
}

const drawers = new Map<Pane, Drawer>();
const buttons = new Map<Pane, HTMLButtonElement>();
/** 后端说过「还不是小说工程」（`ViewState.initialized === false`）。没收到之前不拦，后端会再判一次。 */
let notProject = false;
let post: (msg: InMessage) => void = () => {};

// ---------------------------------------------------------------- 纯函数

const pad = (n: number) => String(n).padStart(2, '0');

/** 「3 分钟前 · 14:32」「昨天 · 10-17 21:05」「400 天前 · 2025-03-02 08:00」那种说法。 */
export function describeWhen(time: number, now = Date.now()): string {
  const d = new Date(time);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let rel: string;
  if (days <= 0) {
    rel = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
  } else {
    rel = days === 1 ? '昨天' : `${days} 天前`;
  }
  const abs = days <= 0 ? hm : d.getFullYear() === n.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
  return `${rel} · ${abs}`;
}

/** 「比当前多 120 字」「比当前少 3 字」「与当前字数相同」。 */
export function describeDelta(words: number, current: number): string {
  const delta = words - current;
  return delta === 0 ? '与当前字数相同' : delta > 0 ? `比当前多 ${delta} 字` : `比当前少 ${-delta} 字`;
}

/** 这份文件存不存历史版本；不存给原因。与后端 `historyUnavailable` 同一套说法（后端照样再判一次）。 */
export function unavailableReason(file: Pick<OpenFile, 'kind'> | undefined): string | undefined {
  if (!file) {
    return '没有打开的文件。';
  }
  if (file.kind === undefined) {
    return '没打开工程，不存历史版本。';
  }
  if (notProject) {
    return '这个目录还不是小说工程（没有 .novelforge/），不存历史版本。';
  }
  if (file.kind === 'other') {
    return '这份文件不是工程里的创作产物（章节、草稿、细纲、角色卡、设定、架构、大纲、文风、叙事线……），不存历史版本。';
  }
  return undefined;
}

// ---------------------------------------------------------------- 抽屉

const NOTE =
  '每次覆盖保存这份文件之前，磁盘上的旧内容会先存成一版（10 分钟内的零星小改并成一版，每份文件留最近 50 版）。' +
  '对比、恢复都只换编辑区里的内容，存不存由你。';

function drawerOf(pane: Pane): Drawer | undefined {
  const existing = drawers.get(pane);
  if (existing) {
    return existing;
  }
  const stage = pane.root.querySelector<HTMLElement>('.ed-stage');
  if (!stage) {
    return undefined;
  }
  const root = el('aside', 'ed-versions hidden');
  root.setAttribute('aria-label', '历史版本');
  const head = el('div', 'ed-versions-head');
  head.appendChild(el('span', 'ed-versions-title', '历史版本'));
  const close = el('button', 'icon-btn ed-versions-close', '×');
  close.type = 'button';
  close.title = '关闭';
  head.appendChild(close);
  const file = el('div', 'ed-versions-file');
  const note = el('p', 'hint ed-versions-note', NOTE);
  const saveNow = el('button', 'chip-btn ed-versions-save', '现在存一版');
  saveNow.type = 'button';
  saveNow.title = '把磁盘上当前这一份存成一版。编辑器里没保存的修改不算——要留住它们，先保存（保存时被覆盖的旧内容也会存一版）。';
  const list = el('div', 'ed-versions-list');
  root.append(head, file, note, saveNow, list);
  stage.appendChild(root);

  const drawer: Drawer = { pane, root, file, note, saveNow, list, open: false, path: null, hash: null };
  close.addEventListener('click', () => setOpen(drawer, false));
  saveNow.addEventListener('click', () => {
    if (drawer.path) {
      post({ type: 'saveVersion', path: drawer.path });
    }
  });
  drawers.set(pane, drawer);
  return drawer;
}

function setOpen(drawer: Drawer, open: boolean): void {
  drawer.open = open;
  setHidden(drawer.root, !open);
  drawer.root.parentElement?.classList.toggle('ed-stage-versions', open);
  buttons.get(drawer.pane)?.classList.toggle('active', open);
  if (open) {
    load(drawer);
  } else {
    drawer.path = null;
    drawer.hash = null;
  }
}

/** 按这块编辑区的当前文件重拉列表（选中与预览清掉）。 */
function load(drawer: Drawer): void {
  const file = drawer.pane.activeFile();
  drawer.path = file?.path ?? null;
  drawer.hash = file?.hash ?? null;
  drawer.entries = undefined;
  drawer.selected = undefined;
  drawer.preview = undefined;
  drawer.unavailable = unavailableReason(file);
  if (file && !drawer.unavailable) {
    post({ type: 'listVersions', path: file.path });
  }
  render(drawer);
}

function render(drawer: Drawer): void {
  const file = drawer.pane.activeFile();
  drawer.file.textContent = file ? file.name : '';
  drawer.file.title = file?.path ?? '';
  setHidden(drawer.note, !!drawer.unavailable);
  setHidden(drawer.saveNow, !!drawer.unavailable);
  drawer.list.replaceChildren();
  if (drawer.unavailable) {
    drawer.list.appendChild(el('p', 'ed-versions-empty', drawer.unavailable));
    return;
  }
  if (!drawer.entries) {
    drawer.list.appendChild(el('p', 'ed-versions-empty', '载入中…'));
    return;
  }
  if (drawer.entries.length === 0) {
    drawer.list.appendChild(
      el(
        'p',
        'ed-versions-empty',
        '还没有历史版本。第一次覆盖保存这份文件时（编辑器里保存、重写、修稿、定稿……），磁盘上的旧内容会先存成一版；' +
          '也可以点上面的「现在存一版」把磁盘上现在这一份先存下来。'
      )
    );
    return;
  }
  const current = countWords(file?.draft ?? '');
  const now = Date.now();
  for (const entry of drawer.entries) {
    drawer.list.appendChild(row(drawer, entry, current, now));
  }
}

function row(drawer: Drawer, entry: VersionView, current: number, now: number): HTMLElement {
  const selected = drawer.selected === entry.id;
  const item = el('div', selected ? 'ed-version selected' : 'ed-version');
  item.dataset.id = entry.id;
  const pick = el('button', 'ed-version-pick');
  pick.type = 'button';
  pick.appendChild(el('span', 'ed-version-when', describeWhen(entry.time, now)));
  pick.appendChild(el('span', 'ed-version-meta', `${entry.words} 字 · ${describeDelta(entry.words, current)} · ${formatBytes(entry.bytes)}`));
  pick.title = `这一版在 ${new Date(entry.time).toLocaleString()} 被覆盖掉之前在磁盘上`;
  pick.addEventListener('click', () => select(drawer, selected ? undefined : entry.id));
  item.appendChild(pick);
  if (!selected) {
    return item;
  }

  const preview = drawer.preview?.id === entry.id ? drawer.preview : undefined;
  const text = el('div', 'ed-version-preview');
  text.textContent = preview?.error ?? (preview?.text !== undefined ? excerpt(preview.text) : '载入中…');
  text.classList.toggle('error', !!preview?.error);
  item.appendChild(text);

  const actions = el('div', 'ed-version-actions');
  const compare = el('button', 'chip-btn ed-version-compare', '对比…');
  compare.type = 'button';
  compare.title = '左边这一版、右边编辑器里现在的，逐处挑；放回编辑器之后是未保存的';
  compare.addEventListener('click', () => {
    const f = drawer.pane.files.get(drawer.path ?? '');
    if (f) {
      post({ type: 'compareVersion', path: f.path, id: entry.id, text: f.draft, requestId: newRequestId('compare') });
    }
  });
  const restore = el('button', 'chip-btn ed-version-restore', '恢复这一版');
  restore.type = 'button';
  restore.title = '把编辑区换成这一版（一步撤销，不写盘，存不存由你）';
  restore.disabled = preview?.text === undefined;
  restore.addEventListener('click', () => {
    if (preview?.text !== undefined && drawer.path) {
      restoreVersion(drawer.path, preview.text, describeWhen(entry.time));
    }
  });
  actions.append(compare, restore);
  item.appendChild(actions);
  return item;
}

function select(drawer: Drawer, id: string | undefined): void {
  drawer.selected = id;
  drawer.preview = undefined;
  if (id && drawer.path) {
    const requestId = newRequestId('version');
    drawer.preview = { id, requestId };
    post({ type: 'readVersion', path: drawer.path, id, requestId });
  }
  render(drawer);
}

function restoreVersion(path: string, text: string, when: string): void {
  const result = replaceInEditor(path, text);
  if (result === 'closed') {
    toast('这份文件已经关掉了。', true);
  } else if (result === 'unchanged') {
    toast('编辑区里已经是这一版了。');
  } else {
    toast(`已把「${when}」那一版放进编辑区：还没保存，Ctrl+Z 可以退回。`);
  }
}

/** 预览：开头几行非空行，太长截断。 */
function excerpt(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== '---');
  const head = lines.slice(0, 4).join('\n');
  return head.length > 240 ? `${head.slice(0, 240)}…` : head || '（空文件）';
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------- 收消息

function onVersions(msg: VersionsMessage): void {
  for (const drawer of drawers.values()) {
    if (!drawer.open || drawer.path !== msg.path) {
      continue;
    }
    drawer.entries = msg.entries;
    drawer.unavailable = msg.unavailable;
    if (drawer.selected && !msg.entries.some((e) => e.id === drawer.selected)) {
      drawer.selected = undefined;
      drawer.preview = undefined;
    }
    render(drawer);
  }
}

function onVersionText(msg: VersionTextMessage): void {
  if (!claimRequest(msg.requestId)) {
    return;
  }
  for (const drawer of drawers.values()) {
    if (drawer.preview?.requestId === msg.requestId) {
      drawer.preview = { ...drawer.preview, text: msg.text, error: msg.error };
      render(drawer);
    }
  }
}

// ---------------------------------------------------------------- 装配

/** 工具栏「历史」按钮：每块编辑区一颗，第一次重画时插到「保存」前面。 */
function syncButton(pane: Pane): void {
  let btn = buttons.get(pane);
  if (!btn) {
    const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
    if (!toolbar) {
      return;
    }
    btn = el('button', 'chip-btn ed-versions-btn', '历史');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const drawer = drawerOf(pane);
      if (drawer) {
        setOpen(drawer, !drawer.open);
      }
    });
    toolbar.insertBefore(btn, toolbar.querySelector('button.primary'));
    buttons.set(pane, btn);
  }
  const reason = unavailableReason(pane.activeFile());
  btn.disabled = !!reason;
  btn.title = reason ?? '历史版本：每次覆盖保存之前存下的旧内容，可以对比、恢复到编辑区';
}

let renderTimer: ReturnType<typeof setTimeout> | undefined;

export function installVersions(postMessage: (msg: InMessage) => void): void {
  post = postMessage;

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      syncButton(ev.pane);
      const drawer = drawers.get(ev.pane);
      if (!drawer?.open) {
        return;
      }
      const file = ev.pane.activeFile();
      if (!file) {
        // 标签全关了：没有可看的，收起来（工具栏也藏了，「历史」按钮够不着）。
        setOpen(drawer, false);
      } else if (file.path !== drawer.path) {
        load(drawer);
      } else if (file.hash !== drawer.hash) {
        // 保存过（或换了基线）：网关可能刚存了一版，重拉。
        drawer.hash = file.hash;
        if (!drawer.unavailable) {
          post({ type: 'listVersions', path: file.path });
        }
      }
      return;
    }
    // 打字：「比当前多 / 少几个字」跟着变，攒一下再画。
    const drawer = drawers.get(ev.pane);
    if (drawer?.open && drawer.entries && ev.file.path === drawer.path) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => render(drawer), 300);
    }
  });

  onMessage((msg) => {
    if (msg.type === 'versions') {
      onVersions(msg);
    } else if (msg.type === 'versionText') {
      onVersionText(msg);
    } else if (msg.type === 'init' || msg.type === 'state') {
      const was = notProject;
      notProject = msg.state.initialized === false;
      if (was !== notProject) {
        for (const pane of [...buttons.keys()]) {
          syncButton(pane);
        }
      }
    }
  });

  window.addEventListener('nf-versions-query', (e) => {
    const reason = unavailableReason(activeEditor()?.file);
    e.detail.available = !reason;
    e.detail.reason = reason;
  });

  window.addEventListener('nf-versions-command', (e) => {
    const ed = activeEditor();
    if (e.detail.name === 'open' && ed && !unavailableReason(ed.file)) {
      const drawer = drawerOf(ed.pane);
      if (drawer && !drawer.open) {
        setOpen(drawer, true);
      }
    }
  });
}
