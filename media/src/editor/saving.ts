/**
 * 保存这件事本身：一份文件同一时刻只有一个保存在路上、回执回来之前状态栏说什么、存完要不要再存一次、
 * 磁盘上没了的文件怎么问、自动保存什么时候不该动手。`pane.ts` 的「保存」、关标签时的「保存」、
 * 自动保存都经 {@link requestSave}。
 *
 * - **同一份同一时刻只有一个保存在路上**。回执（`editorSaved` / `editorConflict` / `editorDiskGone` /
 *   `editorError`）回来之前又要存（又按了 Ctrl+S、自动保存又到点了），只记一笔；回执是「存成了」而那一份
 *   还有没存上的修改，再存一次。撞上冲突、出错就不再接着存。
 * - **状态栏那一格**（{@link renderSaveState}）：「● 未保存」→ 发出去「保存中…」→ 回执到了「已保存 14:32」
 *   （本次会话里最后一次存成的时刻；这次会话还没存过就只写「已保存」）；发出去 {@link SLOW_SAVE_MS} 还没回音，
 *   说一句（断线时消息在 bridge 的 outbox 里排着，连上才发）。**存成了不弹 toast**；冲突、出错照样弹（pane 弹）。
 *   自动保存开着时旁边挂一枚「自动保存」。
 * - **磁盘上没了的文件**（`OpenFile.gone`）：手动保存先问一句要不要在原路径重建（{@link askDialog}），
 *   答应了才带 `recreate`；绝不静默在原路径重建。自动保存跳过它。
 * - **自动保存的闸**（{@link autoSaveAllowed}）：撞过冲突（或核对磁盘时发现磁盘变了、而编辑器里有修改）的那一份
 *   记下当时的基线，基线没动之前（作者还没在冲突条上选）不碰它；「还原」正等着磁盘版回来的那一份不碰；
 *   有对话框开着不碰。
 *
 * **回执谁来结**：pane 收到回执时调 {@link settleSave}——它得先看「这条是不是我要的」（别的窗口存了同一份，
 * 那条 `editorSaved` 也会广播过来，那是磁盘变了，不是这边存成了，见 `pane.applySaved`）。回执落到一份已经不开着
 * 的文件上、没有 pane 接的，这里兜底结掉，免得它从此永远「保存中」、后面的保存全排在它后头。
 */
import { el } from '../dom';
import { onMessage } from '../vscodeApi';
import { askDialog, isDialogOpen } from './dialog';
import type { OpenFile } from './paneElements';
import { autoSaveEnabled } from './paragraphState';
import { paneOwning, postToHost } from './store';
import type { Pane } from './store';

/** 发出去多久没回音就在状态栏说一句。 */
export const SLOW_SAVE_MS = 10_000;
/** 状态栏上那句临时的话（「磁盘上有新版本，已载入」）留多久。 */
export const NOTE_MS = 4_000;

export type SaveOutcome = 'saved' | 'conflict' | 'gone' | 'error' | 'skipped';

export interface SaveRequest {
  /** 「用编辑器内容强制保存」：不带 baseHash。 */
  force?: boolean;
  /** 磁盘上没了，作者答应在原路径重建。 */
  recreate?: boolean;
  /** 自动保存发起的：过 {@link autoSaveAllowed} 那道闸，撞上冲突不切标签。 */
  auto?: boolean;
}

interface Flight {
  auto: boolean;
  slow: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Track {
  flight?: Flight;
  /** 在路上时又要存：回执是「存成了」再存一次。 */
  again?: SaveRequest;
  savedAt?: Date;
  note?: string;
  noteTimer?: ReturnType<typeof setTimeout>;
  /** 等这一份存完（含跟在后面的那一次）的人：关标签。 */
  waiters: ((outcome: SaveOutcome) => void)[];
}

const tracks = new Map<string, Track>();
/** 撞过冲突的那几份 → 当时的基线 hash。基线变了（作者在冲突条上选过了）就自动失效。 */
const blocked = new Map<string, string>();
/** 「还原」等着磁盘版回来的那几份：自动保存别抢在前面把要丢掉的修改存下去。 */
const held = new Set<string>();
/** 正在问「要不要在原路径重建」的那几份：别叠第二个对话框。 */
const asking = new Set<string>();

function track(path: string): Track {
  let t = tracks.get(path);
  if (!t) {
    t = { waiters: [] };
    tracks.set(path, t);
  }
  return t;
}

/** 这一份有一个保存在路上（还没收到回执）。 */
export function isSaving(path: string): boolean {
  return !!tracks.get(path)?.flight;
}

/** 在路上的那一次是自动保存发起的。 */
export function isAutoSaving(path: string): boolean {
  return !!tracks.get(path)?.flight?.auto;
}

/**
 * 存这一份。回一个在**这一份存完**时兑现的结果（在路上时又要存的，等跟在后面的那一次也完）：
 * `skipped` 是没有要存的（没改过、自动保存的闸没开、作者在「要不要重建」上点了取消）。
 */
export function requestSave(pane: Pane, path: string, req: SaveRequest = {}): Promise<SaveOutcome> {
  const file = pane.files.get(path);
  if (!file) {
    return Promise.resolve('skipped');
  }
  if (req.auto && !autoSaveAllowed(file)) {
    return Promise.resolve('skipped');
  }
  const dirty = file.draft !== file.text;
  if (file.gone && !req.recreate) {
    // 没改过的不问（「全部保存」扫到它时别弹框）；冲突条上点「强制保存」（force）是明说要存编辑器里这一份，照问。
    if (!dirty && !req.force) {
      return Promise.resolve('skipped');
    }
    return confirmRecreate(file).then((ok) => (ok ? requestSave(pane, path, { ...req, recreate: true }) : 'skipped'));
  }
  if (!dirty && !req.force && !req.recreate) {
    return Promise.resolve('skipped');
  }
  const t = track(path);
  const settled = new Promise<SaveOutcome>((resolve) => t.waiters.push(resolve));
  if (t.flight) {
    t.again = {
      force: !!(t.again?.force || req.force),
      recreate: !!(t.again?.recreate || req.recreate),
      auto: (t.again ? !!t.again.auto : true) && !!req.auto,
    };
  } else {
    send(file, t, req);
    pane.refresh();
  }
  return settled;
}

function send(file: OpenFile, t: Track, req: SaveRequest): void {
  const flight: Flight = {
    auto: !!req.auto,
    slow: false,
    timer: setTimeout(() => {
      flight.slow = true;
      paneOwning(file.path)?.refresh();
    }, SLOW_SAVE_MS),
  };
  t.flight = flight;
  clearNote(t);
  postToHost({
    type: 'saveFile',
    path: file.path,
    text: file.draft,
    // 重建一律带着基线：期间原路径又有人放了一份的话，乐观锁照样拦下来。
    baseHash: req.force && !req.recreate ? undefined : file.hash,
    ...(req.recreate ? { recreate: true } : {}),
  });
}

/**
 * 这一份的保存有了回执。pane 收到回执、认定是这边那一次的之后调；不在路上就什么都不做。
 * 存成了而在路上时又改过（或又点过保存），接着再存一次——等着的人等到那一次完。
 */
export function settleSave(path: string, outcome: Exclude<SaveOutcome, 'skipped'>): void {
  const t = tracks.get(path);
  if (!t?.flight) {
    return;
  }
  clearTimeout(t.flight.timer);
  t.flight = undefined;
  const again = t.again;
  t.again = undefined;
  const pane = paneOwning(path);
  const file = pane?.files.get(path);
  if (outcome === 'saved') {
    t.savedAt = new Date();
    if (again && pane && file && (file.draft !== file.text || again.force) && !(again.auto && !autoSaveAllowed(file))) {
      send(file, t, again);
      pane.refresh();
      return;
    }
  }
  for (const resolve of t.waiters.splice(0)) {
    resolve(outcome);
  }
  pane?.refresh();
}

// ---------------------------------------------------------------- 自动保存的闸

/** 撞上冲突（或磁盘变了而编辑器里有修改）：基线还是 `baseHash` 的时候，自动保存不碰这一份。 */
export function blockAutoSave(path: string, baseHash: string): void {
  blocked.set(path, baseHash);
}

/**
 * 冲突解决了（冲突条上「对比合并…」放回编辑器，`Pane.rebase`）：这一份的自动保存放开。基线换了本来也会让
 * {@link autoSaveAllowed} 自己失效，但磁盘那份正好又变回了撞冲突时的基线的话，hash 一样，闸就一直关着。
 */
export function unblockAutoSave(path: string): void {
  blocked.delete(path);
}

/** 这一份的自动保存停着（磁盘上没了，或撞过冲突还没选）。状态栏据此写「自动保存已暂停」。 */
export function autoSavePaused(file: OpenFile): boolean {
  return !!file.gone || blocked.get(file.path) === file.hash;
}

/** 「还原」发出去了：磁盘版回来之前别自动保存它。 */
export function holdSave(path: string): void {
  held.add(path);
}

export function releaseSave(path: string): void {
  held.delete(path);
}

/** 自动保存现在能不能动这一份：开着、有修改、没被闸住、没有对话框开着。 */
export function autoSaveAllowed(file: OpenFile): boolean {
  if (!autoSaveEnabled() || file.gone || held.has(file.path) || isDialogOpen()) {
    return false;
  }
  const base = blocked.get(file.path);
  if (base !== undefined) {
    if (base === file.hash) {
      return false;
    }
    blocked.delete(file.path);
  }
  return file.draft !== file.text;
}

// ---------------------------------------------------------------- 状态栏

/** 状态栏那一格临时说一句（「磁盘上有新版本，已载入」），{@link NOTE_MS} 后退回保存状态。调用方自己 refresh。 */
export function noteStatus(path: string, text: string): void {
  const t = track(path);
  clearNote(t);
  t.note = text;
  t.noteTimer = setTimeout(() => {
    t.note = undefined;
    t.noteTimer = undefined;
    paneOwning(path)?.refresh();
  }, NOTE_MS);
}

function clearNote(t: Track): void {
  clearTimeout(t.noteTimer);
  t.note = undefined;
  t.noteTimer = undefined;
}

/**
 * 画状态栏的保存状态那一格（`cell` 是 `.ed-save-state`），自动保存开着时在它前面挂一枚 `.ed-autosave`。
 * 没开文件时传 undefined：清空。
 */
export function renderSaveState(cell: HTMLElement, file: OpenFile | undefined): void {
  const t = file && tracks.get(file.path);
  let text = '';
  let tone: '' | 'dirty' | 'busy' | 'slow' = '';
  let title = '';
  if (file) {
    if (t?.flight?.slow) {
      text = '还没收到回音，连上后会自动发出';
      tone = 'slow';
      title =
        `保存请求发出 ${SLOW_SAVE_MS / 1000} 秒还没有回执。连接断了的话，它在页面里排着队，连上之后自动发出；` +
        '编辑器里的内容一直都在。';
    } else if (t?.flight) {
      text = '保存中…';
      tone = 'busy';
    } else if (t?.note) {
      text = t.note;
    } else if (file.draft !== file.text) {
      text = '● 未保存（Ctrl+S）';
      tone = 'dirty';
    } else {
      text = t?.savedAt ? `已保存 ${clock(t.savedAt)}` : '已保存';
    }
  }
  cell.textContent = text;
  cell.title = title;
  cell.classList.toggle('dirty', tone === 'dirty');
  cell.classList.toggle('busy', tone === 'busy');
  cell.classList.toggle('slow', tone === 'slow');
  renderAutoFlag(cell, file);
}

function renderAutoFlag(cell: HTMLElement, file: OpenFile | undefined): void {
  let flag = cell.parentElement?.querySelector<HTMLElement>('.ed-autosave') ?? null;
  if (!file || !autoSaveEnabled()) {
    flag?.remove();
    return;
  }
  if (!flag) {
    flag = el('span', 'ed-autosave');
    cell.before(flag);
  }
  const paused = autoSavePaused(file);
  flag.textContent = paused ? '自动保存已暂停' : '自动保存';
  flag.classList.toggle('paused', paused);
  flag.title = !paused
    ? '自动保存开着：停笔 2 秒、切换标签、切走窗口时保存。在「文件」菜单里关掉。'
    : file.gone
      ? '磁盘上已经没有这个文件，自动保存不会替你在原路径重建。要保存就按 Ctrl+S，会先问你。'
      : '这一份在磁盘上被别处改过，自动保存先停下。在冲突条上选一个（冲突条收起了就按 Ctrl+S 再看），之后接着自动保存。';
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 磁盘上没了

async function confirmRecreate(file: OpenFile): Promise<boolean> {
  if (asking.has(file.path)) {
    return false;
  }
  asking.add(file.path);
  try {
    const answer = await askDialog({
      title: '磁盘上已经没有这个文件',
      message: `「${file.name}」在磁盘上已经没有了（被删了，或者改了名）。要把编辑器里的内容在原路径重新存一份吗？`,
      detail: `原路径：${file.path}。如果是在别处改了名，新名字那边已经有一份，在这里重建会多出一份。`,
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'recreate', label: '在原路径重建', primary: true },
      ],
      cancel: 'cancel',
    });
    return answer === 'recreate';
  } finally {
    asking.delete(file.path);
  }
}

// ---------------------------------------------------------------- 兜底

/**
 * 启动时装一次。回执落到一份已经不开着的文件上（没有 pane 接）时在这里结掉；`editorError` 一律在这里结
 * （pane 不接它：index.ts 弹 toast），顺带放开「还原」的那道闸（磁盘版回不来了）。
 */
export function installSaving(): void {
  onMessage((msg) => {
    if (msg.type === 'editorError') {
      releaseSave(msg.path);
      settleSave(msg.path, 'error');
      return;
    }
    const path =
      msg.type === 'editorSaved'
        ? msg.file.path
        : msg.type === 'editorConflict' || msg.type === 'editorDiskGone'
          ? msg.path
          : undefined;
    if (path !== undefined && !paneOwning(path)) {
      settleSave(path, msg.type === 'editorSaved' ? 'saved' : msg.type === 'editorConflict' ? 'conflict' : 'gone');
    }
  });

  // 换了工程（或关掉了）：上一个工程那边还在路上的保存，回执永远到不了这个窗口了。不清掉的话，新工程里
  // 同名的那一份会一直排在它后头、状态栏一直「保存中」。
  window.addEventListener('nf-workspace-reset', () => {
    for (const t of tracks.values()) {
      if (t.flight) {
        clearTimeout(t.flight.timer);
      }
      clearNote(t);
      for (const resolve of t.waiters.splice(0)) {
        resolve('error');
      }
    }
    tracks.clear();
    blocked.clear();
    held.clear();
  });
}
