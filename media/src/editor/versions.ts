/**
 * 侧栏「版本」页（独立版；DOM 在 `shells/shared/panes.ts` 的 `versionsPane`，插件形态不装配）：编辑区当前那份文件的
 * 时间线。点一行，编辑区里马上开对比标签（`versionDiff.ts`），不经预览、不弹窗。
 *
 * - **一条时间线，新的在前**：最上面「还没保存的改动」（编辑器里那份与磁盘上的不一样时才有，比的是磁盘上的 ↔ 编辑器里的）；
 *   然后是快照（网关在每次覆盖之前存的，`core/workspace/history.ts`）与这份文件在各存档点里的样子（◆ 手动、◇ 自动，带备注；
 *   内容一样的连着几个只列最早那一个）混排。每行「3 分钟前 · 14:32」、多少字、比现在多 / 少几个字。
 * - **单击 = 这一版 ↔ 现在**（现在 = 编辑器里那一份，没保存的也算）。右键：跟现在比、跟后一版比（那一次改了什么）、
 *   恢复整份到编辑区。对比标签开着时，它比的那一行标成选中。
 * - **跟着编辑区当前的文件走**：换了文件就换列表；对比标签、别的特殊标签显示着时（那一块没有当前文件）留在原来那份上；
 *   那份文件关掉了才清空。保存之后（`hash` 变了）重拉——网关可能刚存了一版（自动保存几秒一次时攒一攒，一秒最多一次）。
 *   这一页藏着时不拉，切过来时拉一次（存档点可能刚存过）。
 * - **入口**：活动栏「版本」；编辑区工具栏「历史」（每块编辑区一颗，第一次重画时插到「保存」前面，与 `layout.ts` 的「排版」
 *   同一个做法）与标题栏「文件 → 历史版本…」（`view/versionsMenu.ts`，经 `nf-versions-query` / `nf-versions-command`）切到
 *   这一页，窄屏上顺手把编辑区翻下去。没开文件、没打开工程、还不是小说工程、文件不是工程里的创作产物（`kind` 是 `other`）时
 *   那两处置灰，提示里说为什么——前端不拿路径猜，后端也会再判一次（`versions.unavailable`）。
 * - 「＋」（现在存一版）把**磁盘上当前**那一份存一个快照（不是编辑器里没保存的那份）。
 */
import { maybeById, el, setHidden } from '../dom';
import { onContextMenu, showVersionsTab } from '../globals';
import type { MenuItem } from '../globals';
import type { InMessage, OutMessage, VersionView } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { autoSaveEnabled, onPrefsChange } from './paragraphState';
import { revealEditor, revealSide } from './shell';
import { paneOwning } from './store';
import { currentDiff, installVersionDiff, onDiffChange, openDiff, restoreVersion } from './versionDiff';
import type { DiffRequest, VersionRef } from './versionDiff';
import { countWords } from './words';

type VersionsMessage = Extract<OutMessage, { type: 'versions' }>;

interface Side {
  root: HTMLElement;
  file: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  save: HTMLButtonElement;
  refresh: HTMLButtonElement;
}

let post: (msg: InMessage) => void = () => {};
let side: Side | undefined;
/** 列着哪份文件、拉列表时它的 hash（保存之后 hash 变了就重拉）。 */
let target: string | null = null;
let targetHash: string | null = null;
/** undefined = 载入中。 */
let entries: VersionView[] | undefined;
let unavailable: string | undefined;
const buttons = new Map<Pane, HTMLButtonElement>();
/** 后端说过「还不是小说工程」（`ViewState.initialized === false`）。没收到之前不拦，后端会再判一次。 */
let notProject = false;
let renderTimer: ReturnType<typeof setTimeout> | undefined;

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

/** 「比现在多 120 字」「比现在少 3 字」「与现在字数相同」。 */
export function describeDelta(words: number, current: number): string {
  const delta = words - current;
  return delta === 0 ? '与现在字数相同' : delta > 0 ? `比现在多 ${delta} 字` : `比现在少 ${-delta} 字`;
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

/** 一行在标题、对比标签上怎么称呼：「3 分钟前 · 14:32 的快照」「存档点「第一卷完」（10-20 22:30）」。 */
export function versionLabel(entry: VersionView, now = Date.now()): string {
  const when = describeWhen(entry.time, now);
  if (!entry.checkpoint) {
    return `${when} 的快照`;
  }
  const kind = entry.checkpoint.auto ? '自动存档点' : '存档点';
  return entry.checkpoint.note ? `${kind}「${entry.checkpoint.note}」（${when}）` : `${kind}（${when}）`;
}

// ---------------------------------------------------------------- 侧栏

/** 标签上的那个称呼（后端给的，章节去掉了扩展名）；没给就是文件名。 */
function nameOf(file: OpenFile): string {
  return file.label?.title ?? file.name;
}

const NOTE =
  '每次覆盖保存之前，磁盘上的旧内容先存成一版（10 分钟内的零星小改并成一版，每份文件留最近 50 版）；◆ ◇ 是存档点里的这一份。' +
  '点一行在编辑区对比；用回、恢复都只换编辑区里的内容，存不存由你。';
/** 自动保存开着时多说的那一句（`autosave.ts`：停笔 2 秒就存）。 */
const AUTOSAVE_NOTE = '自动保存开着：放回编辑区的内容停笔 2 秒就会写回磁盘——被它盖掉的那一版会先存进这里，可以再恢复回来。';

function visible(): boolean {
  return !!side && side.root.classList.contains('active');
}

/** 正看着的那份文件（在哪块编辑区里都行）。 */
function targetFile(): OpenFile | undefined {
  return target ? paneOwning(target)?.files.get(target) : undefined;
}

/** 按当前文件重拉列表（藏着就只记一笔）。 */
function load(): void {
  const file = targetFile();
  targetHash = file?.hash ?? null;
  unavailable = unavailableReason(file);
  // 藏着不拉：切过来时（MutationObserver）再拉。
  if (!visible()) {
    return;
  }
  entries = undefined;
  if (file && !unavailable) {
    post({ type: 'listVersions', path: file.path });
  }
  render();
}

/** 换看哪份文件：编辑区当前的那一份（没有当前文件时留在原来那份上，那份关掉了才清空）。 */
function follow(): void {
  const file = activeEditor()?.file;
  const next = file ? file.path : target && paneOwning(target) ? target : null;
  if (next !== target) {
    target = next;
    entries = undefined;
    load();
  } else if (file && file.hash !== targetHash && !unavailable) {
    // 保存过（或换了基线）：网关可能刚存了一版，重拉。
    targetHash = file.hash;
    relist();
  } else if (visible()) {
    render();
  }
}

function render(): void {
  if (!side) {
    return;
  }
  const file = targetFile();
  side.file.textContent = file ? nameOf(file) : '';
  side.file.title = file?.path ?? '';
  side.foot.textContent = autoSaveEnabled() ? `${NOTE}${AUTOSAVE_NOTE}` : NOTE;
  setHidden(side.foot, !file || !!unavailable);
  side.save.disabled = !file || !!unavailable;
  side.refresh.disabled = !file;
  side.body.replaceChildren();
  if (!file) {
    side.body.appendChild(el('p', 'vs-empty', '没有打开的文件。在编辑区打开一份稿子，这里列出它存下的各版。'));
    return;
  }
  if (unavailable) {
    side.body.appendChild(el('p', 'vs-empty', unavailable));
    return;
  }
  const shown = currentDiff();
  if (file.draft !== file.text) {
    side.body.appendChild(unsavedRow(file, shown));
  }
  if (!entries) {
    side.body.appendChild(el('p', 'vs-empty', '载入中…'));
    return;
  }
  if (entries.length === 0) {
    side.body.appendChild(
      el(
        'p',
        'vs-empty',
        '还没有存下的版本。第一次覆盖保存这份文件时（编辑器里保存、重写、修稿、同步……），磁盘上的旧内容会先存成一版；' +
          '也可以点上面的「＋」把磁盘上现在这一份先存下来。存档点里有它的话，也列在这里。'
      )
    );
    return;
  }
  const current = countWords(file.draft);
  const now = Date.now();
  entries.forEach((entry, i) => side!.body.appendChild(row(file, entry, i, current, now, shown)));
}

function unsavedRow(file: OpenFile, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', 'vs-row vs-unsaved');
  item.type = 'button';
  item.classList.toggle('selected', shown?.path === file.path && shown.left === 'disk');
  item.appendChild(el('span', 'vs-when', '● 还没保存的改动'));
  item.appendChild(el('span', 'vs-meta', describeDelta(countWords(file.draft), countWords(file.text)).replace('现在', '磁盘上')));
  item.title = '磁盘上的（上次保存的）↔ 编辑器里的';
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: 'disk', right: 'now' });
    revealEditor();
  });
  return item;
}

function row(file: OpenFile, entry: VersionView, index: number, current: number, now: number, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', entry.checkpoint ? 'vs-row vs-checkpoint' : 'vs-row');
  item.type = 'button';
  item.dataset.id = entry.id;
  const selected = shown?.path === file.path && typeof shown.left !== 'string' && shown.left.id === entry.id;
  item.classList.toggle('selected', selected);
  const when = el('span', 'vs-when', describeWhen(entry.time, now));
  if (entry.checkpoint) {
    when.prepend(el('span', 'vs-mark', entry.checkpoint.auto ? '◇ ' : '◆ '));
  }
  item.appendChild(when);
  item.appendChild(el('span', 'vs-meta', `${entry.words} 字 · ${describeDelta(entry.words, current)}`));
  if (entry.checkpoint) {
    item.appendChild(el('span', 'vs-note', entry.checkpoint.note || (entry.checkpoint.auto ? '自动存档点' : '存档点')));
  }
  item.title = entry.checkpoint
    ? `${versionLabel(entry, now)}里的这一份`
    : `这一版在 ${new Date(entry.time).toLocaleString()} 被覆盖掉之前在磁盘上`;
  const ref = (): VersionRef => ({ id: entry.id, label: versionLabel(entry, Date.now()) });
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
    revealEditor();
  });
  onContextMenu(item, () => rowMenu(file, index, ref));
  return item;
}

function rowMenu(file: OpenFile, index: number, ref: () => VersionRef): MenuItem[] {
  const newer = index > 0 ? entries?.[index - 1] : undefined;
  return [
    {
      label: '跟现在比',
      run: () => {
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
        revealEditor();
      },
    },
    {
      // 最新的那一版，后面一版就是现在。
      label: '跟后一版比（那一次改了什么）',
      run: () => {
        const right = newer ? { id: newer.id, label: versionLabel(newer) } : ('now' as const);
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right });
        revealEditor();
      },
    },
    { sep: true },
    { label: '恢复整份到编辑区', run: () => void restoreVersion(file.path, ref()) },
  ];
}

/** 保存之后重拉列表：离上一次不到一秒就挪到一秒之后（只发最后那一次）。 */
const RELIST_GAP_MS = 1000;
let relistLast = 0;
let relistTimer: ReturnType<typeof setTimeout> | undefined;

function relist(): void {
  clearTimeout(relistTimer);
  if (!visible()) {
    return;
  }
  const send = () => {
    relistTimer = undefined;
    relistLast = Date.now();
    if (target && !unavailable && visible()) {
      post({ type: 'listVersions', path: target });
    }
  };
  const wait = relistLast + RELIST_GAP_MS - Date.now();
  if (wait <= 0) {
    send();
  } else {
    relistTimer = setTimeout(send, wait);
  }
}

function onVersions(msg: VersionsMessage): void {
  if (msg.path !== target) {
    return;
  }
  entries = msg.entries;
  unavailable = msg.unavailable;
  render();
}

// ---------------------------------------------------------------- 工具栏「历史」

/** 切到「版本」页看这一块的那份文件（窄屏上顺手把编辑区翻下去）。 */
function showFor(pane: Pane | undefined): void {
  const file = pane?.activeFile();
  if (file && file.path !== target) {
    target = file.path;
    entries = undefined;
  }
  showVersionsTab();
  revealSide();
  load();
}

/** 每块编辑区一颗，第一次重画时插到「保存」前面。 */
function syncButton(pane: Pane): void {
  let btn = buttons.get(pane);
  if (!btn) {
    const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
    if (!toolbar) {
      return;
    }
    btn = el('button', 'chip-btn ed-versions-btn', '历史');
    btn.type = 'button';
    btn.addEventListener('click', () => showFor(pane));
    toolbar.insertBefore(btn, toolbar.querySelector('button.primary'));
    buttons.set(pane, btn);
  }
  const reason = unavailableReason(pane.activeFile());
  btn.disabled = !!reason;
  btn.title = reason ?? '历史版本：在侧栏「版本」页列出这份文件存下的各版，点一行在编辑区对比';
}

// ---------------------------------------------------------------- 装

export function installVersions(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  installVersionDiff(postMessage);

  const root = maybeById('pane-versions');
  if (root) {
    side = {
      root,
      file: maybeById('versionsFile')!,
      body: maybeById('versionsBody')!,
      foot: maybeById('versionsFoot')!,
      save: maybeById('versionsSave') as HTMLButtonElement,
      refresh: maybeById('versionsRefresh') as HTMLButtonElement,
    };
    side.save.addEventListener('click', () => {
      if (target) {
        post({ type: 'saveVersion', path: target });
      }
    });
    side.refresh.addEventListener('click', () => load());
    // 切到这一页（活动栏、工具栏「历史」）：拉一次——藏着时换过文件、保存过，存档点也可能刚存过。
    new MutationObserver(() => {
      if (visible()) {
        load();
      }
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    render();
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      syncButton(ev.pane);
      follow();
      return;
    }
    // 打字：「还没保存的改动」那一行有没有、「比现在多 / 少几个字」跟着变，攒一下再画。
    if (ev.file.path === target && visible()) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 300);
    }
  });
  onDiffChange(() => {
    if (visible()) {
      render();
    }
  });

  onMessage((msg) => {
    if (msg.type === 'versions') {
      onVersions(msg);
    } else if (msg.type === 'init' || msg.type === 'state') {
      const was = notProject;
      notProject = msg.state.initialized === false;
      if (was !== notProject) {
        for (const pane of [...buttons.keys()]) {
          syncButton(pane);
        }
        load();
      }
    }
  });

  // 「文件 → 自动保存」切了：底下那句说明跟着变。
  onPrefsChange(() => {
    if (visible()) {
      render();
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
      showFor(ed.pane);
    }
  });

  window.addEventListener('nf-workspace-reset', () => {
    target = null;
    targetHash = null;
    entries = undefined;
    unavailable = undefined;
    render();
  });
}
