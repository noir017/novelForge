/**
 * 一块编辑区的类型，以及它那些 DOM 节点的引用。
 *
 * 两块编辑区（正文 / 草稿）是同一个 `createPane` 工厂的两个实例：主区绑页面上
 * 固定 id 的节点，草稿区在首次用到时克隆同样的结构现造。把「哪些节点」这件事
 * 收在这里，pane.ts 就只关心行为。
 */
import { byId, el, spacer } from '../dom';
import type { EditorPane } from '../protocol';

/** 一块编辑区里所有需要操作的节点。 */
export interface PaneRefs {
  root: HTMLElement;
  tabs: HTMLElement;
  toolbar: HTMLElement;
  path: HTMLElement;
  saveBtn: HTMLButtonElement;
  revertBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
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
  caret: number;
  scrollTop: number;
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
 */
export interface CarriedDraft {
  hash?: string;
  draft?: string;
  moved?: boolean;
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
  const draftBtn = el('button', 'chip-btn hidden', '草稿');
  const revertBtn = el('button', 'chip-btn', '还原');
  revertBtn.title = '放弃修改，重新从磁盘读取';
  const externalBtn = el('button', 'chip-btn', '外部打开');
  externalBtn.title = '用系统默认程序打开';
  const saveBtn = el('button', 'primary', '保存');
  saveBtn.title = '保存（Ctrl+S）';
  toolbar.append(path, previewBtn, draftBtn, revertBtn, externalBtn, saveBtn);

  const conflict = el('div', 'ed-conflict hidden');
  const conflictText = el('span', 'ed-conflict-text');
  const conflictTake = el('button', 'chip-btn', '用磁盘版本覆盖编辑器');
  const conflictForce = el('button', 'chip-btn', '用编辑器内容强制保存');
  conflict.append(conflictText, conflictTake, conflictForce);

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
    root, tabs, toolbar, path, saveBtn, revertBtn, previewBtn, draftBtn, externalBtn,
    area, preview, welcome, conflict, conflictText, conflictTake, conflictForce,
    statusWords, statusPos, statusSave, statusFile,
  };
}

/** pane 的 id 与协议里的 `EditorPane` 是同一套取值。 */
export type PaneId = EditorPane;
