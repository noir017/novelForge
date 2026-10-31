/**
 * 一块编辑区的类型，以及它那些 DOM 节点的引用。
 *
 * 两块编辑区（正文 / 草稿）是同一个 `createPane` 工厂的两个实例：主区绑页面上
 * 固定 id 的节点，草稿区在首次用到时克隆同样的结构现造。把「哪些节点」这件事
 * 收在这里，pane.ts 就只关心行为。
 */
import { byId, el, spacer } from '../dom';
import type { ArtifactKind, EditorFileLabel, EditorPane } from '../protocol';
import type { EditHistory } from './history';

/** 一块编辑区里所有需要操作的节点。 */
export interface PaneRefs {
  root: HTMLElement;
  tabs: HTMLElement;
  toolbar: HTMLElement;
  path: HTMLElement;
  saveBtn: HTMLButtonElement;
  revertBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
  plotBtn: HTMLButtonElement;
  draftBtn: HTMLButtonElement;
  externalBtn: HTMLButtonElement;
  area: HTMLTextAreaElement;
  preview: HTMLElement;
  welcome: HTMLElement;
  conflict: HTMLElement;
  conflictText: HTMLElement;
  conflictTake: HTMLButtonElement;
  conflictForce: HTMLButtonElement;
  statusWords: HTMLElement;
  statusPos: HTMLElement;
  statusSave: HTMLElement;
  statusFile: HTMLElement;
}

/**
 * 编辑器里的一份文件。
 *
 * `text` 是磁盘基线，`draft` 是编辑器里的当前内容，两者不等即为脏；
 * `hash` 是保存时的乐观锁基线，磁盘上变了就报冲突而不是覆盖。
 */
export interface OpenFile {
  path: string;
  name: string;
  text: string;
  hash: string;
  draft: string;
  /** 这份文件是某章正文时，它草稿的路径（后端给，前端不自己判断什么算章节）。 */
  draftPath?: string;
  /**
   * 这份文件在工程里是什么（后端 `kindOfPath` 给的）。`chapter` / `draft` 是正文（`api.ts` 的
   * `isProse`），其余是角色卡、细纲、设定等。后端没给（没打开工程、旧数据）时当非正文。
   */
  kind?: ArtifactKind;
  /**
   * 标签与工具栏上怎么称呼它（后端 `views/editorLabel.ts` 算的：类型短标记、去掉扩展名的名字、面包屑）。
   * 没给（没打开工程）时标签写文件名、工具栏写原始路径。
   */
  label?: EditorFileLabel;
  /**
   * 临时标签（单击打开的，名字斜体）：每块编辑区最多一个，下一次单击打开别的文件时它的位置被换掉。
   * 编辑、保存、双击标签、在工程页 / 文件页双击那一行、「固定」，或被别的路子正常打开一次，就转正。
   * **有未保存修改的标签永远不是临时的**（一改就转正），所以换掉它从来不会丢字。
   */
  preview?: boolean;
  /**
   * 这一份此刻在 Markdown 预览里（不是在编辑）。**每个标签各记各的**：切走再切回来照旧，搬到另一块、改名搬家、刷新恢复
   * 都跟着（⚑ 刷新也记）。只对 `.md` / `.markdown` 有意义。别和上面的 `preview`（临时标签）混了。
   */
  markdownPreview?: boolean;
  /** 在预览里时切走那一刻预览的滚动位置，切回来放回去。 */
  previewScrollTop?: number;
  caret: number;
  scrollTop: number;
  /**
   * 这份文件自己的撤销历史（`history.ts`）。切标签不丢，关标签随文件一起丢，刷新不恢复；
   * 搬到另一块编辑区 / 改名时跟着搬（见 `CarriedDraft`）。
   */
  history: EditHistory;
  /**
   * 磁盘上已经没有这份了（被删、被改名；`editorDiskGone`）。编辑器里的内容还在；保存时先问要不要在原路径
   * 重建，自动保存跳过它；磁盘上又出现了（核对磁盘时）就清掉。
   */
  gone?: boolean;
}

/** 冲突时暂存的磁盘版本，供「用磁盘版本覆盖」使用。 */
export interface Conflict {
  text: string;
  hash: string;
}

/**
 * 从另一块编辑区（或刷新前的 localStorage）带过来的未保存内容。
 *
 * `moved` 表示文件刚改名/搬家——那时 hash 基线必然变了，草稿照贴；
 * 其余情况（刷新恢复）仍要求磁盘没变过，否则拿旧内容盖新内容就是
 * 另一种静默覆盖。
 *
 * `history` / `historyText`：搬家时连撤销历史一起带上（刷新恢复没有）。只有接上之后的内容与
 * 搬走时（`historyText`）一字不差才接——否则那份差异对不上位置。
 *
 * `preview`：搬走时是不是临时标签（刷新恢复、改名搬家时照旧）。`markdownPreview`：搬走时是不是在 Markdown 预览里（同样照旧）。
 *
 * `local`：标签右键「移到另一侧」——就在页面里从一块搬到另一块，接手的那一块收到的文件就是搬走时的
 * 基线（不经后端重读），所以连冲突条、见过的磁盘新版、「磁盘上没了」与光标位置一起接上。
 */
export interface CarriedDraft {
  hash?: string;
  draft?: string;
  moved?: boolean;
  history?: EditHistory;
  historyText?: string;
  preview?: boolean;
  markdownPreview?: boolean;
  local?: boolean;
  gone?: boolean;
  conflict?: { text: string; hash: string; reopen?: boolean };
  diskSeen?: string;
  caret?: number;
  scrollTop?: number;
}

/** 从页面上固定的 id 收集主区的节点引用。 */
export function mainRefs(root: HTMLElement): PaneRefs {
  return {
    root,
    tabs: byId('edTabs'),
    toolbar: byId('edToolbar'),
    path: byId('edPath'),
    saveBtn: byId('edSaveBtn'),
    revertBtn: byId('edRevertBtn'),
    previewBtn: byId('edPreviewBtn'),
    plotBtn: byId('edPlotBtn'),
    draftBtn: byId('edDraftBtn'),
    externalBtn: byId('edExternalBtn'),
    area: byId('edArea'),
    preview: byId('edPreview'),
    welcome: byId('edWelcome'),
    conflict: byId('edConflict'),
    conflictText: byId('edConflictText'),
    conflictTake: byId('edConflictTake'),
    conflictForce: byId('edConflictForce'),
    statusWords: byId('edStatusWords'),
    statusPos: byId('edStatusPos'),
    statusSave: byId('edStatusSave'),
    statusFile: byId('edStatusFile'),
  };
}

/**
 * 现造一块编辑区的 DOM，结构与 html.ts 里的主区一致。
 *
 * 草稿区的结构不写进 html.ts：同一套四十行的 DOM 要在两个地方对齐，
 * 迟早会分叉。这里克隆一份，引用直接握在手里——**不给 id**，省得与主区撞车。
 */
export function createPaneElements(welcomeText: string): PaneRefs {
  const root = el('section', 'wb-editor wb-editor-draft');
  const tabs = el('div', 'ed-tabs');

  const toolbar = el('div', 'ed-toolbar hidden');
  const path = el('span', 'ed-path');
  const previewBtn = el('button', 'chip-btn', '预览');
  previewBtn.title = '预览 Markdown';
  const plotBtn = el('button', 'chip-btn hidden', '细纲');
  plotBtn.title = '打开这一章的细纲（并排；还没有就按模板建一份）';
  const draftBtn = el('button', 'chip-btn hidden', '草稿');
  const revertBtn = el('button', 'chip-btn', '还原');
  revertBtn.title = '放弃修改，重新从磁盘读取';
  const externalBtn = el('button', 'chip-btn ed-external-btn', '外部打开');
  externalBtn.title = '用系统默认程序打开';
  const saveBtn = el('button', 'primary', '保存');
  saveBtn.title = '保存（Ctrl+S）';
  toolbar.append(path, previewBtn, plotBtn, draftBtn, revertBtn, externalBtn, saveBtn);

  const conflict = el('div', 'ed-conflict hidden');
  const conflictText = el('span', 'ed-conflict-text');
  const conflictTake = el('button', 'chip-btn', '用磁盘版本覆盖编辑器');
  const conflictForce = el('button', 'chip-btn', '用编辑器内容强制保存');
  conflict.append(conflictText, conflictTake, conflictForce);

  // 查找替换条不在这里：两块编辑区都由 find.ts 第一次用到时现造（DOM 只在那里生成一份）。
  const stage = el('div', 'ed-stage');
  const welcome = el('div', 'ed-welcome');
  welcome.appendChild(el('h2', undefined, welcomeText));
  const area = el('textarea', 'ed-area hidden');
  area.spellcheck = false;
  area.wrap = 'soft';
  const preview = el('div', 'ed-preview hidden');
  stage.append(welcome, area, preview);

  const status = el('div', 'ed-status');
  const statusFile = el('span');
  const statusWords = el('span');
  const statusPos = el('span');
  const statusSave = el('span', 'ed-save-state');
  status.append(statusFile, statusWords, spacer(), statusPos, statusSave);

  root.append(tabs, toolbar, conflict, stage, status);

  return {
    root, tabs, toolbar, path, saveBtn, revertBtn, previewBtn, plotBtn, draftBtn, externalBtn,
    area, preview, welcome, conflict, conflictText, conflictTake, conflictForce,
    statusWords, statusPos, statusSave, statusFile,
  };
}

/** pane 的 id 与协议里的 `EditorPane` 是同一套取值。 */
export type PaneId = EditorPane;
