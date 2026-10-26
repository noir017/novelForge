/**
 * 工程页「存档点…」弹窗（2026-10-20，设计见 `docs/design/plans/2026-10-20-checkpoints.md`）：整本书存一版、看某个
 * 存档点之后改了哪几份、单份对比、整本或单份退回。后端一半在 `core/controller/checkpoints.ts`。
 *
 * 复用 `providerModal` 那一层遮罩（同 `form.ts`：插件与独立版都装配了它），里面两页：
 *
 * - **列表**：打开就发 `listCheckpoints`，收 `checkpoints` 画（新的在前）。顶上一格备注 +「存一个存档点」（发
 *   `createCheckpoint`）；自动存的那几行多一颗「留住…」，摊开一格备注发 `noteCheckpoint`（写了备注就不会被自动裁掉）。
 * - **跟现在比**：一行的「跟现在比」发 `checkpointDiff`，收同一个 id 的 `checkpointDiff` 画三组（改过的 / 之后删掉的 /
 *   之后新建的）。「对比」关掉弹窗、经 `nf-version-diff-command` 在编辑区开「版本」的对比标签，只在内置编辑器回答了
 *   `nf-version-diff-query` 时给（插件形态没有 editor.js），能力探测、不判断是哪个壳。「退回这一份」「整本退回」点两下才发 `restoreCheckpoint`：乐观锁是这一次
 *   比较里每份的 `hashNow`（当时磁盘上没有的给 `null`），编辑器里没保存的那几份经 `nf-dirty-query` 问内置编辑器
 *   （插件形态没人回答，是空的）。退回之后后端重推 `checkpoints` 与这个存档点的 `checkpointDiff`，停在这一页重画。
 *
 * 前端只发消息、什么都不写；关掉（× / Esc）就丢掉面板上的一切，下次打开重新要。
 *
 * **谁占着这一层遮罩**：与表单、独立版 prompt、服务商弹窗一样各自判断「是不是我开的」——这里认的是面板的根节点还在
 * 不在 `providerModalBody` 里。别人中途占了这一层（比如后端推来一条 prompt），根节点就被换掉了，面板当自己已经关了：
 * 之后到的 `checkpoints` / `checkpointDiff` 不再往这一层上画，× / Esc 也不去藏别人的弹窗。
 */
import { clear, el as mk, maybeById, setHidden } from '../dom';
import { commandVersionDiff, queryDirtyPaths, queryVersionDiff } from '../globals';
import { KIND_LABEL } from '../editor/artifactKinds';
import type {
  CheckpointDiffEntry,
  CheckpointDiffView,
  CheckpointFileStatus,
  CheckpointView,
  OutMessage,
  RestoreCheckpointRequest,
} from '../protocol';
import { primaryBtn, secondaryBtn } from './buttons';
import { closeForm } from './form';
import { formatWords } from './format';
import { el } from './refs';
import { vscode } from './store';

type CheckpointsMessage = Extract<OutMessage, { type: 'checkpoints' }>;
type CheckpointDiffMessage = Extract<OutMessage, { type: 'checkpointDiff' }>;

const EMPTY_TEXT = '还没有存档点。批量写章、全书替换这类批量动作之前会自动存一个；也可以现在存一个。';
const RESTORE_HINT = '退回之前会先自动存一个存档点，退回也能撤回；编辑器里没保存的文件会跳过。';

/** 三组的先后与叫法。 */
const GROUPS: ReadonlyArray<[CheckpointFileStatus, string]> = [
  ['changed', '改过的'],
  ['deleted', '之后删掉的'],
  ['added', '之后新建的'],
];

interface Panel {
  root: HTMLElement;
  listView: HTMLElement;
  diffView: HTMLElement;
  note: HTMLInputElement;
  save: HTMLButtonElement;
  status: HTMLElement;
  list: HTMLElement;
  /** 列表；null 是还在读。 */
  entries: CheckpointView[] | null;
  unavailable?: string;
  /** 发了 `createCheckpoint`、列表还没回来。 */
  saving: boolean;
  /** 哪一个自动存档点的「留住」那一格摊开着，与里面写到一半的字（列表重画时放回去）。 */
  keeping: { id: string; text: string } | null;
  /** 正在看的那一个存档点（跟现在比）；null 是在列表上。 */
  diffId: string | null;
  /** 比较结果；null 且没有 `diffError` 是还在比。 */
  diff: CheckpointDiffView | null;
  diffError?: string;
  /** 发了 `restoreCheckpoint`、比较还没重推回来。 */
  restoring: boolean;
  /** 「也把存档点之后新建的 N 份搬进回收站」勾着没有（缺省不勾）。 */
  trashAdded: boolean;
}

let panel: Panel | null = null;

/** 点了一下、等第二下的那颗按钮（两段式，同全书替换）。点别处、重画都退回第一段。 */
let armed: { key: string; btn: HTMLButtonElement; label: string } | null = null;

// ---------------------------------------------------------------- 开、关

/** 工程页工具栏「存档点…」。 */
export function openCheckpoints(): void {
  if (owns()) {
    panel!.note.focus();
    return;
  }
  // 表单开着（不该有：遮罩盖着工具栏）就先关，不叠两份。
  closeForm();
  panel = null;
  armed = null;
  const p = buildPanel();
  el.providerModalTitle.textContent = '存档点';
  clear(el.providerModalBody);
  el.providerModalBody.appendChild(p.root);
  panel = p;
  renderList();
  setHidden(el.providerModal, false);
  p.note.focus();
  vscode.postMessage({ type: 'listCheckpoints' });
}

/** × / Esc：丢掉面板上的一切。这一层已经被别人占了的话只丢自己的状态，不去藏别人的弹窗。 */
export function closeCheckpoints(): void {
  if (!panel) {
    return;
  }
  const mine = owns();
  panel = null;
  armed = null;
  if (mine) {
    setHidden(el.providerModal, true);
    clear(el.providerModalBody);
  }
}

/** 遮罩还是不是这块面板的（见文件头「谁占着这一层遮罩」）。 */
function owns(): boolean {
  return (
    !!panel &&
    panel.root.isConnected &&
    el.providerModalBody.contains(panel.root) &&
    !el.providerModal.classList.contains('hidden')
  );
}

/**
 * 遮罩上的 × 与 Esc（点空白不关，同表单）。合并视图（`#mergeModal`，后端推来的覆盖审阅）盖在上面时 Esc 不归这里——那一层自己没有 Esc，
 * 这一下关掉的会是底下的面板。输入法组字时的 Esc 是输入法的。
 */
export function installCheckpoints(): void {
  el.providerModalClose.addEventListener('click', () => closeCheckpoints());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel || e.isComposing || e.keyCode === 229) {
      return;
    }
    const merge = maybeById('mergeModal');
    if (merge && !merge.classList.contains('hidden')) {
      return;
    }
    closeCheckpoints();
  });
  // 两段式按钮：点在别处（哪儿都算）就退回第一段。捕获阶段，半路被 stopPropagation 的点击也算。
  document.addEventListener(
    'click',
    (e) => {
      if (armed && !(e.target instanceof Node && armed.btn.contains(e.target))) {
        disarm();
      }
    },
    true
  );
}

// ---------------------------------------------------------------- 收消息

/** 收 `checkpoints`：列表（存一个、写备注、退回之后后端都重推它）。 */
export function renderCheckpoints(msg: CheckpointsMessage): void {
  if (!owns()) {
    panel = null;
    return;
  }
  const p = panel!;
  p.entries = msg.entries;
  p.unavailable = msg.unavailable;
  p.saving = false;
  if (p.keeping && !msg.entries.some((cp) => cp.id === p.keeping!.id && cp.auto)) {
    p.keeping = null;
  }
  renderList();
  if (p.diffId) {
    // 停在「跟现在比」那一页：只换标题上的备注（写备注之后它变了），比较结果等 `checkpointDiff`。
    const title = p.diffView.querySelector<HTMLElement>('.cp-diff-title');
    if (title) {
      title.textContent = diffTitle(p);
      title.title = title.textContent;
    }
  }
}

/** 收 `checkpointDiff`：只认正在看的那一个（返回列表之后才到的、另一个窗口要的都不认）。 */
export function renderCheckpointDiff(msg: CheckpointDiffMessage): void {
  if (!owns()) {
    panel = null;
    return;
  }
  const p = panel!;
  if (p.diffId !== msg.id) {
    return;
  }
  p.diff = msg.diff ?? null;
  p.diffError = msg.diff ? undefined : (msg.error ?? '没比出来。');
  // 退回之后重推回来的：勾选框回到缺省（不勾）——搬进回收站的那一下不该留到下一次。
  if (p.restoring) {
    p.trashAdded = false;
  }
  p.restoring = false;
  renderDiff();
}

// ---------------------------------------------------------------- 列表

function buildPanel(): Panel {
  const root = mk('div', 'cp-panel');
  const listView = mk('div', 'cp-list-view');
  const newRow = mk('div', 'cp-new');
  const note = mk('input', 'cp-note-input');
  note.type = 'text';
  note.placeholder = '备注（可以空着），比如：第一卷写完';
  const save = primaryBtn('存一个存档点', () => createOne());
  save.classList.add('cp-save');
  save.title = '把整本书现在的样子存一份（章节、细纲、角色卡、设定、架构、草稿……）；同样的内容只存一份，不占多少地方';
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      createOne();
    }
  });
  newRow.append(note, save);
  const status = mk('p', 'hint cp-status');
  const list = mk('div', 'cp-list');
  listView.append(newRow, status, list);
  const diffView = mk('div', 'cp-diff-view hidden');
  root.append(listView, diffView);
  return {
    root,
    listView,
    diffView,
    note,
    save,
    status,
    list,
    entries: null,
    saving: false,
    keeping: null,
    diffId: null,
    diff: null,
    restoring: false,
    trashAdded: false,
  };
}

function createOne(): void {
  const p = panel;
  if (!p || !owns() || p.saving || p.unavailable) {
    return;
  }
  p.saving = true;
  vscode.postMessage({ type: 'createCheckpoint', note: p.note.value.trim() });
  p.note.value = '';
  renderList();
}

function renderList(): void {
  const p = panel!;
  disarm();
  p.note.disabled = !!p.unavailable;
  p.save.disabled = !!p.unavailable || p.saving;
  const status = p.entries === null ? '正在读…' : p.unavailable ? p.unavailable : p.saving ? '正在存…' : '';
  p.status.textContent = status;
  setHidden(p.status, !status);

  // 推来的列表可能正赶上作者在「留住」那一格里打字：重画之后焦点放回去。
  const active = document.activeElement;
  const keepFocused = active instanceof HTMLInputElement && active.classList.contains('cp-keep-input') && p.list.contains(active);
  clear(p.list);
  if (p.entries === null || p.unavailable) {
    return;
  }
  if (p.entries.length === 0) {
    p.list.appendChild(mk('p', 'hint cp-empty', EMPTY_TEXT));
    return;
  }
  for (const cp of p.entries) {
    p.list.appendChild(buildRow(p, cp));
  }
  if (keepFocused) {
    const input = p.list.querySelector<HTMLInputElement>('.cp-keep-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function buildRow(p: Panel, cp: CheckpointView): HTMLElement {
  const row = mk('div', `cp-row${cp.auto ? ' is-auto' : ''}`);
  row.dataset.id = cp.id;

  const main = mk('div', 'cp-row-main');
  const head = mk('div', 'cp-row-head');
  const note = mk('span', `cp-note${cp.note ? '' : ' is-empty'}`, cp.note || '（没写备注）');
  note.title = cp.note;
  head.append(
    mk('span', 'cp-time', whenText(cp.time)),
    mk('span', `cp-badge ${cp.auto ? 'is-auto' : 'is-manual'}`, cp.auto ? '自动' : '手动'),
    note
  );
  const meta = mk('div', 'hint cp-row-meta', `正文 ${cp.chapters} 章 · ${formatWords(cp.chapterWords)} · ${cp.files} 份文件`);
  if (cp.skipped.length > 0) {
    // 第 2 条：没存进去的说出来。路径挂在提示上。
    const skipped = mk('span', 'cp-skipped', `${cp.skipped.length} 份超过 2 MB 没存`);
    skipped.title = cp.skipped.join('\n');
    meta.append(' · ', skipped);
  }
  main.append(head, meta);

  const actions = mk('div', 'cp-row-actions');
  const compare = secondaryBtn('跟现在比', () => openDiff(cp.id));
  compare.title = '看这个存档点之后改了哪几份、字数差多少；可以单份对比、退回';
  actions.appendChild(compare);
  if (cp.auto) {
    const keep = secondaryBtn('留住…', () => toggleKeep(cp));
    keep.title = '写一句备注把它留住：写了备注就不会被自动裁掉（自动存的只留最近 30 个）';
    actions.appendChild(keep);
  }
  row.append(main, actions);
  if (cp.auto && p.keeping?.id === cp.id) {
    row.appendChild(buildKeep(p, cp.id));
  }
  return row;
}

/** 「留住…」：摊开 / 收起那一格。缺省填着原来那句备注（自动存的都有一句「批量写章之前（第 12–20 章）」）。 */
function toggleKeep(cp: CheckpointView): void {
  const p = panel;
  if (!p) {
    return;
  }
  p.keeping = p.keeping?.id === cp.id ? null : { id: cp.id, text: cp.note };
  renderList();
  const input = p.list.querySelector<HTMLInputElement>('.cp-keep-input');
  input?.focus();
  input?.select();
}

function buildKeep(p: Panel, id: string): HTMLElement {
  const box = mk('div', 'cp-keep');
  const input = mk('input', 'cp-keep-input');
  input.type = 'text';
  input.placeholder = '写一句备注（空着就留原来那句）';
  input.value = p.keeping?.text ?? '';
  input.addEventListener('input', () => {
    if (p.keeping?.id === id) {
      p.keeping.text = input.value;
    }
  });
  const submit = () => {
    if (panel !== p || !owns()) {
      return;
    }
    vscode.postMessage({ type: 'noteCheckpoint', id, note: input.value.trim() });
    p.keeping = null;
    renderList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  const ok = primaryBtn('留住', submit);
  ok.title = '写了备注就不会被自动裁掉';
  box.append(input, ok);
  return box;
}

// ---------------------------------------------------------------- 跟现在比

function openDiff(id: string): void {
  const p = panel;
  if (!p || !owns()) {
    return;
  }
  p.diffId = id;
  p.diff = null;
  p.diffError = undefined;
  p.restoring = false;
  p.trashAdded = false;
  setHidden(p.listView, true);
  setHidden(p.diffView, false);
  renderDiff();
  vscode.postMessage({ type: 'checkpointDiff', id });
}

function backToList(): void {
  const p = panel;
  if (!p) {
    return;
  }
  disarm();
  p.diffId = null;
  p.diff = null;
  p.diffError = undefined;
  p.restoring = false;
  clear(p.diffView);
  setHidden(p.diffView, true);
  setHidden(p.listView, false);
}

/** 「10-20 22:30「第一卷写完」 ↔ 现在」：说法同后端的 `describeCheckpoint`（toast 里也这么写）。 */
function diffTitle(p: Panel): string {
  const cp = p.entries?.find((x) => x.id === p.diffId);
  const label = cp ? `${whenText(cp.time)}${cp.note ? `「${cp.note}」` : ''}` : (p.diffId ?? '');
  return `${label} ↔ 现在`;
}

function renderDiff(): void {
  const p = panel!;
  const view = p.diffView;
  disarm();
  clear(view);

  const head = mk('div', 'cp-diff-head');
  const back = secondaryBtn('← 返回列表', backToList);
  const title = mk('span', 'cp-diff-title', diffTitle(p));
  title.title = title.textContent ?? '';
  head.append(back, title);
  view.appendChild(head);

  if (p.diffError) {
    view.appendChild(mk('p', 'hint cp-status is-error', p.diffError));
    return;
  }
  const d = p.diff;
  if (!d) {
    view.appendChild(mk('p', 'hint cp-status', '正在比…'));
    return;
  }
  if (d.entries.length === 0) {
    view.appendChild(mk('p', 'hint cp-same', `跟现在一模一样（${d.unchanged} 份），没有可退回的。`));
    return;
  }
  if (p.restoring) {
    view.appendChild(mk('p', 'hint cp-status', '正在退回…'));
  }

  const byStatus = (s: CheckpointFileStatus) => d.entries.filter((e) => e.status === s);
  // 宿主有没有合并视图：只有独立版的页面放 `#mergeModal`（插件用不上它，后端也没有 `mergeTexts`）。
  const canCompare = queryVersionDiff();
  for (const [status, label] of GROUPS) {
    const files = byStatus(status);
    if (files.length === 0) {
      continue;
    }
    const group = mk('div', `cp-group is-${status}`);
    group.dataset.status = status;
    group.appendChild(mk('div', 'cp-group-head', `${label} · ${files.length} 份`));
    for (const entry of files) {
      group.appendChild(buildFile(p, d.id, entry, canCompare));
    }
    view.appendChild(group);
  }
  if (d.unchanged > 0) {
    view.appendChild(mk('p', 'hint cp-unchanged', `另有 ${d.unchanged} 份跟现在一模一样，不列。`));
  }
  view.appendChild(buildFoot(p, d));
}

function buildFile(p: Panel, id: string, entry: CheckpointDiffEntry, canCompare: boolean): HTMLElement {
  const row = mk('div', 'cp-file');
  row.dataset.path = entry.path;
  const path = mk('span', 'cp-path', entry.path);
  path.title = entry.path;
  const actions = mk('span', 'cp-file-actions');
  if (entry.status !== 'added') {
    if (canCompare) {
      const compare = secondaryBtn('对比', () => {
        const cp = p.entries?.find((c) => c.id === id);
        if (owns() && cp) {
          // 关掉弹窗、在编辑区开对比标签：用回一处、恢复整份都只进编辑区，存不存由作者。
          closeCheckpoints();
          commandVersionDiff({ path: entry.path, status: entry.status, checkpoint: { id, time: cp.time, note: cp.note, auto: cp.auto } });
        }
      });
      compare.classList.add('cp-compare');
      compare.title = '关掉这里，在编辑区开对比标签：存档点里的那一份 ↔ 现在这份；可以一处一处用回（只进编辑区，不写盘）';
      compare.disabled = p.restoring;
      actions.appendChild(compare);
    }
    const restore = armable(
      `file:${entry.path}`,
      '退回这一份',
      () => '确定退回这一份？',
      () => restoreFiles([entry.path], []),
      'secondary cp-restore'
    );
    restore.title =
      entry.status === 'deleted'
        ? '点两下：照存档点里的样子把这一份建回来'
        : '点两下：把这一份换回存档点里的样子（被盖掉的这一份先存一版历史）';
    restore.disabled = p.restoring;
    actions.appendChild(restore);
  }
  row.append(path, mk('span', 'cp-kind', KIND_LABEL[entry.kind] ?? KIND_LABEL.other), mk('span', 'cp-words', wordsText(entry)), actions);
  return row;
}

function buildFoot(p: Panel, d: CheckpointDiffView): HTMLElement {
  const back = d.entries.filter((e) => e.status !== 'added').map((e) => e.path);
  const added = d.entries.filter((e) => e.status === 'added').map((e) => e.path);
  const count = () => back.length + (p.trashAdded ? added.length : 0);

  const foot = mk('div', 'cp-foot');
  const row = mk('div', 'cp-foot-row');
  if (added.length > 0) {
    const label = mk('label', 'cp-trash');
    const box = mk('input');
    box.type = 'checkbox';
    box.checked = p.trashAdded;
    box.addEventListener('change', () => {
      p.trashAdded = box.checked;
      sync();
    });
    label.title = '缺省不动它们；勾上才搬（搬进 .novelforge/.trash/，不真删）';
    label.append(box, `也把存档点之后新建的 ${added.length} 份搬进回收站`);
    row.appendChild(label);
  }
  const whole = armable(
    'all',
    '整本退回',
    () => `确定整本退回（${count()} 份）`,
    () => restoreFiles(back, p.trashAdded ? added : []),
    'primary cp-restore-all'
  );
  whole.title = '点两下：改过的、之后删掉的都换回存档点里的样子';
  const sync = () => {
    whole.disabled = p.restoring || count() === 0;
  };
  sync();
  row.appendChild(whole);
  foot.append(row, mk('p', 'hint cp-foot-hint', RESTORE_HINT));
  return foot;
}

/** 退回：乐观锁是这一次比较里每份的 `hashNow`，当时磁盘上没有的给 `null`。 */
function restoreFiles(paths: string[], trash: string[]): void {
  const p = panel;
  if (!p || !owns() || !p.diff || !p.diffId || p.restoring || paths.length + trash.length === 0) {
    return;
  }
  const byPath = new Map(p.diff.entries.map((e) => [e.path, e]));
  const expect: Record<string, string | null> = {};
  for (const path of [...paths, ...trash]) {
    expect[path] = byPath.get(path)?.hashNow ?? null;
  }
  const request: RestoreCheckpointRequest = { id: p.diffId, paths, trash, expect, dirty: queryDirtyPaths() };
  p.restoring = true;
  renderDiff();
  vscode.postMessage({ type: 'restoreCheckpoint', request });
}

// ---------------------------------------------------------------- 两段式按钮

/** 第一下只换字（`is-armed`，同表单的两段式提交），第二下才 `run`。 */
function armable(
  key: string,
  label: string,
  armedLabel: () => string,
  run: () => void,
  className: string
): HTMLButtonElement {
  const btn = mk('button', className, label);
  btn.addEventListener('click', () => {
    if (armed?.btn === btn && armed.key === key) {
      disarm();
      run();
      return;
    }
    disarm();
    armed = { key, btn, label };
    btn.textContent = armedLabel();
    btn.classList.add('is-armed');
  });
  return btn;
}

function disarm(): void {
  if (armed) {
    armed.btn.textContent = armed.label;
    armed.btn.classList.remove('is-armed');
    armed = null;
  }
}

// ---------------------------------------------------------------- 说法

const pad = (n: number) => String(n).padStart(2, '0');

/** 存档点的时刻：「10-20 22:30」，不是今年的带上年份。 */
function whenText(time: number): string {
  const d = new Date(time);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 「3,011」：一份文件的字数，千位加逗号（不折成万字——两个数要对得出差了多少）。 */
function digits(n: number | undefined): string {
  return String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function wordsText(entry: CheckpointDiffEntry): string {
  if (entry.status === 'changed') {
    return `${digits(entry.wordsThen)} → ${digits(entry.wordsNow)} 字`;
  }
  return entry.status === 'deleted' ? `当时 ${digits(entry.wordsThen)} 字` : `现在 ${digits(entry.wordsNow)} 字`;
}
