/**
 * 三个前端产物之间的全部交集。
 *
 * view / editor / explorer 各自独立打包、各自监听 message、各自 postMessage，
 * 唯一互通的就是这里的东西。**别让 explorer 直接去读 editor 的内部状态**
 * （那会把编辑器的私事变成两个文件之间的契约，而资源管理器在插件形态里
 * 根本不存在）。
 *
 * - `__nfToast`：view 出，editor / explorer 用。共用一条提示条，免得两套互相盖住。
 * - `__nfContextMenu`：view 出的右键菜单登记函数。全局 `contextmenu` 监听只在
 *   view 里有一份，另起一套会两层菜单一起弹。
 * - 自定义事件：`nf-editor-active`、`nf-files-moved`，以及标题栏（view.js）
 *   与编辑器（editor.js）之间的 `nf-editor-query` / `nf-editor-command` /
 *   `nf-workspace-reset`，「编辑」菜单段落那几项的 `nf-paragraph-query` / `nf-paragraph-command`，
 *   「文件 → 历史版本…」的 `nf-versions-query` / `nf-versions-command`，「文件 → 转到…」的
 *   `nf-quickopen-query` / `nf-quickopen-command`，「编辑 → 全书查找替换…」的 `nf-bookfind-query` / `nf-bookfind-command`，
 *   「视图」菜单的 `nf-view-query` / `nf-view-command`，「帮助 → 快捷键一览」的 `nf-shortcuts-query` / `nf-shortcuts-command`，
 *   「视图 → 统计」那一组的 `nf-stats-query` / `nf-stats-command`，「视图 → 体检」那一组的 `nf-check-query` /
 *   `nf-check-command`，「视图 → 补全」那一组的 `nf-names-query` / `nf-names-command`，
 *   以及 `nf-reveal-in-files`（editor → explorer + view：在「文件」页定位到某个文件或目录）、`nf-show-versions`
 *   （editor → view：切到侧栏「版本」页）、存档点弹窗「对比」在编辑区开对比标签的 `nf-version-diff-query` /
 *   `nf-version-diff-command`，
 *   对话页「加入选区」问内置编辑器选区的 `nf-selection-query`，工程页「叙事线」页签打开编辑区「叙事线总览」的
 *   `nf-threads-query` / `nf-threads-command`（工程页「时间线」组打开「时间线总览」的 `nf-timeline-query` / `nf-timeline-command` 同样），工程页「存档点…」退回时问内置编辑器哪几份没保存的
 *   `nf-dirty-query`。
 *   `nf-pick-folder` 给目录选择器拦欢迎页的占位 prompt。
 * - `__nfShowMenu`：view 出的「在某处弹一个菜单」（编辑器标签条末尾的「▾」用），与右键菜单是同一个引擎。
 */

/** 菜单项。`{ sep: true }` 是分隔线，其余是可点的一条。 */
export type MenuItem = { sep: true } | MenuAction;

export interface MenuAction {
  sep?: false;
  label: string;
  /** 置灰的项（如「出场：第 1、2、3 章」那种纯说明）可以不给。 */
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 右键（触屏上是长按）那一下：按在哪个元素上、视口坐标、是不是手指长按（`touch.ts` 认的）。菜单项多半用不着它，
 * 要按「按在哪个字上」给项的（编辑区里的名字、叙事线总览的格子）才看。
 */
export interface MenuContext {
  target: Element | null;
  x: number;
  y: number;
  touch: boolean;
}

/** 「这个元素上右键给什么菜单」的登记函数。`provide` 在右键那一刻才调用。 */
export type ContextMenuRegistrar = <T extends Element>(node: T, provide: (at: MenuContext) => MenuItem[]) => T;

/** 标题栏问编辑器「现在开着什么、脏不脏」。没人听时全是空值。 */
export interface EditorStatus {
  hasFile: boolean;
  dirtyCurrent: boolean;
  dirtyAny: boolean;
  path: string | null;
  text: string;
  /** 焦点在内置编辑器的正文区里。「编辑 → 撤销 / 重做」这时交给编辑器自己的历史。 */
  areaFocused: boolean;
  /** 自动保存开着没有（按浏览器记，缺省关）。「文件 → 自动保存」据此打 ✓。 */
  autoSave: boolean;
}

/**
 * `undo` / `redo` 作用于当前那块编辑区的当前文件（编辑器自己记的历史，不是浏览器原生的）；
 * `find` / `replace` 打开那一块的查找条（`replace` 连替换行一起展开）；`toggleAutoSave` 开关自动保存。
 */
export type EditorCommandName = 'save' | 'saveAll' | 'close' | 'find' | 'replace' | 'undo' | 'redo' | 'toggleAutoSave';

declare global {
  interface Window {
    __nfToast?: (message: string, isError?: boolean) => void;
    __nfContextMenu?: ContextMenuRegistrar;
    __nfShowMenu?: (items: MenuItem[], x: number, y: number) => HTMLElement | undefined;
  }

  interface WindowEventMap {
    'nf-editor-active': CustomEvent<{ path: string | null }>;
    'nf-files-moved': CustomEvent<{ from: string; to: string }>;
    'nf-pick-folder': CustomEvent<{ intent: 'open' | 'file' }>;
    'nf-editor-query': CustomEvent<EditorStatus>;
    'nf-editor-command': CustomEvent<{ name: EditorCommandName }>;
    'nf-workspace-reset': Event;
    'nf-paragraph-query': CustomEvent<ParagraphStatus>;
    'nf-paragraph-command': CustomEvent<{ name: ParagraphCommandName }>;
    'nf-versions-query': CustomEvent<VersionsStatus>;
    'nf-versions-command': CustomEvent<{ name: 'open' }>;
    'nf-quickopen-query': CustomEvent<QuickOpenStatus>;
    'nf-quickopen-command': CustomEvent<{ name: 'open' }>;
    'nf-bookfind-query': CustomEvent<BookFindStatus>;
    'nf-bookfind-command': CustomEvent<{ name: BookFindCommandName }>;
    'nf-view-query': CustomEvent<ViewPrefsStatus>;
    'nf-view-command': CustomEvent<{ name: ViewCommandName }>;
    'nf-stats-query': CustomEvent<StatsStatus>;
    'nf-stats-command': CustomEvent<{ name: StatsCommandName }>;
    'nf-check-query': CustomEvent<CheckStatus>;
    'nf-check-command': CustomEvent<{ name: CheckCommandName }>;
    'nf-names-query': CustomEvent<NamesStatus>;
    'nf-names-command': CustomEvent<{ name: NamesCommandName }>;
    'nf-shortcuts-query': CustomEvent<{ available: boolean }>;
    'nf-shortcuts-command': Event;
    'nf-reveal-in-files': CustomEvent<{ path: string; dir: boolean }>;
    'nf-show-versions': Event;
    'nf-version-diff-query': CustomEvent<{ available: boolean }>;
    'nf-version-diff-command': CustomEvent<CheckpointFileDiffCommand>;
    'nf-selection-query': CustomEvent<EditorSelection>;
    'nf-threads-query': CustomEvent<{ available: boolean }>;
    'nf-threads-command': CustomEvent<ThreadsOverviewCommand>;
    'nf-timeline-query': CustomEvent<{ available: boolean }>;
    'nf-timeline-command': CustomEvent<TimelineOverviewCommand>;
    'nf-dirty-query': CustomEvent<{ paths: string[] }>;
  }
}

/**
 * 提示条。view 还没加载（或根本没有）时静默丢掉——
 * 提示不出来不该连带把编辑器的主流程搞崩。
 */
export function toast(message: string, isError?: boolean): void {
  window.__nfToast?.(message, isError);
}

/**
 * 右键菜单登记。取不到 view 的登记表时退化成「这个元素没有菜单」，
 * 全局监听会给它兜底的「刷新」。
 */
export const onContextMenu: ContextMenuRegistrar = (node, provide) =>
  (window.__nfContextMenu ?? ((n) => n))(node, provide);

/** 广播「编辑器里现在开着哪个文件」。没人听时白发一趟，代价可以忽略。 */
export function announceEditorActive(path: string | null): void {
  window.dispatchEvent(new CustomEvent('nf-editor-active', { detail: { path } }));
}

/** 广播「某个文件改名/搬家了」，编辑器据此把标签连同未保存草稿挪过去。 */
export function announceFileMoved(from: string, to: string): void {
  window.dispatchEvent(new CustomEvent('nf-files-moved', { detail: { from, to } }));
}

/** 问编辑器当前状态。editor.js 没装时返回全空。 */
export function queryEditor(): EditorStatus {
  const status: EditorStatus = {
    hasFile: false,
    dirtyCurrent: false,
    dirtyAny: false,
    path: null,
    text: '',
    areaFocused: false,
    autoSave: false,
  };
  window.dispatchEvent(new CustomEvent('nf-editor-query', { detail: status }));
  return status;
}

export function commandEditor(name: EditorCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-editor-command', { detail: { name } }));
}

/** 打开/关闭文件夹前：有脏标签就问一句。不确定则不往下走。 */
export function confirmProceedIfDirty(message = '有未保存的修改，仍要继续吗？'): boolean {
  if (!queryEditor().dirtyAny) {
    return true;
  }
  return window.confirm(message);
}

/** 工作区换了或关掉：编辑器丢掉全部标签。 */
export function resetEditor(): void {
  window.dispatchEvent(new Event('nf-workspace-reset'));
}

/** 这个窗口开的是哪个工程：独立版网址上的 `?project=`。插件与空窗口没有。 */
export function windowProject(): string | null {
  try {
    return new URLSearchParams(location.search).get('project') || null;
  } catch {
    return null;
  }
}

/**
 * localStorage 的键按工程分开：独立版几个窗口各开一个工程时，标签页、展开的目录、
 * 没发出去的草稿不互相顶掉。没有工程时就是原来那个键。
 */
export function projectStorageKey(base: string): string {
  const project = windowProject();
  return project ? `${base}@${project}` : base;
}

// ---------------------------------------------------------------- 「编辑」菜单段落那几项

/**
 * 标题栏「编辑」菜单段落那几项问编辑器的状态（`editor/paragraph.ts` 回答）。与 `EditorStatus` 分开一份：
 * 那是保存 / 撤销那一组的，这一组只管正文排版。分段格式本身不在这里——它是工程的设置，菜单从
 * `ViewState.paragraphStyle` 读。
 */
export interface ParagraphStatus {
  /** 当前那块编辑区开着的是正文（章节或草稿）。「一键排版」「半角标点转全角」只对正文亮。 */
  prose: boolean;
  /** 成对符号自动补全开着没有（按浏览器记，缺省开）。 */
  autoPair: boolean;
}

/** `toggleAutoPair` 开关成对符号；另两个作用于当前那块编辑区的当前文件（有选区只改选中的那几行）。 */
export type ParagraphCommandName = 'toggleAutoPair' | 'formatProse' | 'fullWidthPunct';

/** 问编辑器段落那几项的状态。editor.js 没装时全是关的（自动补全按缺省算开）。 */
export function queryParagraph(): ParagraphStatus {
  const status: ParagraphStatus = { prose: false, autoPair: true };
  window.dispatchEvent(new CustomEvent('nf-paragraph-query', { detail: status }));
  return status;
}

export function commandParagraph(name: ParagraphCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-paragraph-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「文件」菜单「历史版本…」

/**
 * 标题栏「文件 → 历史版本…」问编辑器的状态（`editor/versions.ts` 回答）：当前那块编辑区开着的文件存不存
 * 历史版本，不存的话为什么（菜单项置灰时挂在提示上）。点了切到侧栏「版本」页（经 `nf-versions-command`）。
 */
export interface VersionsStatus {
  available: boolean;
  /** 不能用的原因（没开文件、没打开工程、不是创作产物……）。 */
  reason?: string;
}

/** 问编辑器「历史版本」能不能用。editor.js 没装时不能用。 */
export function queryVersions(): VersionsStatus {
  const status: VersionsStatus = { available: false, reason: '没有打开的文件' };
  window.dispatchEvent(new CustomEvent('nf-versions-query', { detail: status }));
  return status;
}

/** 看当前那块编辑区那份文件的历史版本：切到侧栏「版本」页。 */
export function commandVersions(name: 'open'): void {
  window.dispatchEvent(new CustomEvent('nf-versions-command', { detail: { name } }));
}

/** 存档点弹窗里「对比」一份：那个存档点里的这一份 ↔ 现在，在编辑区的对比标签里看（`editor/versions.ts` 接）。 */
export interface CheckpointFileDiffCommand {
  path: string;
  /** 同 `CheckpointFileStatus`：改过的、之后删掉的、之后新建的。 */
  status: 'changed' | 'deleted' | 'added';
  checkpoint: { id: string; time: number; note: string; auto: boolean };
}

/** 有没有人画得了对比标签（只有装了内置编辑器的独立版、桌面版回答）。 */
export function queryVersionDiff(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-version-diff-query', { detail: status }));
  return status.available;
}

export function commandVersionDiff(cmd: CheckpointFileDiffCommand): void {
  window.dispatchEvent(new CustomEvent('nf-version-diff-command', { detail: cmd }));
}

/** 切到侧栏「版本」页（editor.js 发，view.js 的 `tabs.ts` 切；插件形态没有这一页）。 */
export function showVersionsTab(): void {
  window.dispatchEvent(new Event('nf-show-versions'));
}

// ---------------------------------------------------------------- 「文件」菜单「转到…」

/**
 * 标题栏「文件 → 转到…」问编辑器「转到」面板能不能开（`editor/quickOpen.ts` 回答）：没打开工程时不能，
 * 原因挂在菜单项的提示上。editor.js 没装（插件形态，也就没有标题栏）时没人回答，当不能用。
 */
export interface QuickOpenStatus {
  available: boolean;
  reason?: string;
}

export function queryQuickOpen(): QuickOpenStatus {
  const status: QuickOpenStatus = { available: false, reason: '没有内置编辑器' };
  window.dispatchEvent(new CustomEvent('nf-quickopen-query', { detail: status }));
  return status;
}

/** 打开「转到」面板（与 Ctrl+P 同一件事）。 */
export function commandQuickOpen(name: 'open'): void {
  window.dispatchEvent(new CustomEvent('nf-quickopen-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「编辑」菜单「全书查找替换…」

/**
 * 标题栏「编辑 → 全书查找替换…」问编辑器那块面板能不能开（`editor/bookFind.ts` 回答）：没打开工程时不能，原因挂在
 * 菜单项的提示上。editor.js 没装（插件形态，也就没有标题栏）时没人回答，当不能用。
 */
export interface BookFindStatus {
  available: boolean;
  reason?: string;
}

/** `open` 打开面板、焦点进查找框；`openReplace` 打开面板、焦点进替换框。 */
export type BookFindCommandName = 'open' | 'openReplace';

export function queryBookFind(): BookFindStatus {
  const status: BookFindStatus = { available: false, reason: '没有内置编辑器' };
  window.dispatchEvent(new CustomEvent('nf-bookfind-query', { detail: status }));
  return status;
}

/** 打开全书查找替换面板（与 Ctrl+Shift+F / Ctrl+Shift+H 同一件事）。 */
export function commandBookFind(name: BookFindCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-bookfind-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「视图」菜单

/**
 * 标题栏「视图」菜单问编辑器的状态（`editor/viewPrefs.ts` 回答）。之后的阶段往「视图」里加的项各自往这里
 * 加一个字段、往 `ViewCommandName` 加一个名字即可（菜单那一半在 `view/viewMenu.ts`，一组一个函数）。
 */
export interface ViewPrefsStatus {
  /** 编辑器装上了（插件与空窗口没有，那时这几项置灰）。 */
  available: boolean;
  /** 单击打开为临时标签（按浏览器记，缺省开）。 */
  previewTabs: boolean;
  /** 「外观」那一组（`editor/look.ts` 回答；没人回答就是 undefined，那组置灰）。 */
  look?: LookStatus;
  /** 「专注」那一组（`editor/focus.ts` 回答；没人回答就是 undefined，那组置灰）。 */
  focus?: FocusStatus;
}

export type ViewCommandName = 'togglePreviewTabs' | LookCommandName | FocusCommandName;

/** 问编辑器「视图」那几项的状态。editor.js 没装时不可用（开关按缺省算）。 */
export function queryViewPrefs(): ViewPrefsStatus {
  const status: ViewPrefsStatus = { available: false, previewTabs: true };
  window.dispatchEvent(new CustomEvent('nf-view-query', { detail: status }));
  return status;
}

export function commandViewPrefs(name: ViewCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-view-command', { detail: { name } }));
}

/** 「视图 → 外观」：正文字号（另几项在外观面板里）。 */
export interface LookStatus {
  /** 当前字号（px）与缺省字号。 */
  fontSize: number;
  defaultFontSize: number;
  /** 到上限 / 下限了没有（「放大 / 缩小字号」据此置灰）。 */
  canZoomIn: boolean;
  canZoomOut: boolean;
}

/** `zoomIn` / `zoomOut` / `zoomReset` 字号放大、缩小、还原；`openLook` 打开外观面板。 */
export type LookCommandName = 'zoomIn' | 'zoomOut' | 'zoomReset' | 'openLook';

/** 「视图 → 专注」：三个开关（记在 `novelforge.editor.prefs`）与全屏（不记）。 */
export interface FocusStatus {
  focusMode: boolean;
  typewriter: boolean;
  paragraphFocus: boolean;
  fullscreen: boolean;
  /** 页面能不能全屏（Fullscreen API 的能力探测；不能就置灰）。 */
  fullscreenSupported: boolean;
}

export type FocusCommandName = 'toggleFocusMode' | 'toggleFullscreen' | 'toggleTypewriter' | 'toggleParagraphFocus';

// ---------------------------------------------------------------- 「视图 → 统计」

/**
 * 「视图」菜单「统计」那一组问编辑器的状态（`editor/stats.ts` 回答）：状态栏字数那一格除了全文 / 选中，还显示
 * 哪几项（按浏览器记在 `novelforge.editor.prefs` 的 `stats` 里）。与 `ViewPrefsStatus` 分开一份：那是别的组的。
 */
export interface StatsStatus {
  /** 编辑器装上了（插件没有，那时这一组置灰）。 */
  available: boolean;
  /** 正文显示本章字数与目标的进度（缺省开）。 */
  goal: boolean;
  /** 显示本次码字（缺省关）。 */
  session: boolean;
  /** 显示今日码字（缺省关）。 */
  today: boolean;
}

/** 三个开关，外加「重新开始计时」（本次码字从现在起重新算）。 */
export type StatsCommandName = 'toggleGoal' | 'toggleSession' | 'toggleToday' | 'restart';

export function queryStats(): StatsStatus {
  const status: StatsStatus = { available: false, goal: true, session: false, today: false };
  window.dispatchEvent(new CustomEvent('nf-stats-query', { detail: status }));
  return status;
}

export function commandStats(name: StatsCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-stats-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「视图 → 体检」

/**
 * 「视图」菜单「体检」那一组问编辑器的状态（`editor/check.ts` 回答）：正文里画不画体检高亮、状态栏显示不显示「体检」
 * 那一格（按浏览器记在 `novelforge.editor.prefs` 的 `check` 里），以及「编辑敏感词表…」能不能点（没打开工程不能）。
 */
export interface CheckStatus {
  /** 编辑器装上了（插件没有，那时这一组置灰）。 */
  available: boolean;
  /** 体检高亮（缺省开）。 */
  highlight: boolean;
  /** 状态栏「体检」那一格（缺省开）。 */
  status: boolean;
  /** 打开着工程（「编辑敏感词表…」要它）。 */
  canEditList: boolean;
}

/** 两个开关，外加「编辑敏感词表…」（没有就新建一份模板，然后在编辑器里打开）。 */
export type CheckCommandName = 'toggleHighlight' | 'toggleStatus' | 'editList';

export function queryCheck(): CheckStatus {
  const status: CheckStatus = { available: false, highlight: true, status: true, canEditList: false };
  window.dispatchEvent(new CustomEvent('nf-check-query', { detail: status }));
  return status;
}

export function commandCheck(name: CheckCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-check-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「视图 → 补全」

/**
 * 「视图」菜单「补全」那一组问编辑器的状态（`editor/names.ts` 回答）：边打边弹开着没有（按浏览器记在
 * `novelforge.editor.prefs` 的 `nameAutoPopup`），当前那块编辑区里的文件能不能补全。与 `ViewPrefsStatus` 分开一份。
 */
export interface NamesStatus {
  /** 编辑器装上了（插件没有，那时这一组置灰）。 */
  available: boolean;
  /** 边打边弹名词补全（缺省关）。 */
  auto: boolean;
  /** 名词高亮（缺省开，`editor/nameMarks.ts` 回答）。 */
  highlight: boolean;
  /** 当前那块编辑区开着的文件能补全（正文、细纲、角色卡、设定……看后端给的 kind）。 */
  canTrigger: boolean;
  /** 不能补全的原因（菜单项置灰时挂在提示上）。 */
  reason?: string;
}

/**
 * `toggleAuto` 开关边打边弹；`trigger` 在当前那块编辑区的光标处弹出名词补全（与快捷键同一件事）；`toggleHighlight`
 * 开关名词高亮（`editor/nameMarks.ts` 接）。
 */
export type NamesCommandName = 'toggleAuto' | 'trigger' | 'toggleHighlight';

export function queryNames(): NamesStatus {
  const status: NamesStatus = { available: false, auto: false, highlight: false, canTrigger: false, reason: '没有内置编辑器' };
  window.dispatchEvent(new CustomEvent('nf-names-query', { detail: status }));
  return status;
}

export function commandNames(name: NamesCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-names-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「帮助 → 快捷键一览」

/** 快捷键一览面板能不能开（`editor/shortcutsPanel.ts` 回答）。editor.js 没装（插件形态，也就没有标题栏）时不能。 */
export function queryShortcuts(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-shortcuts-query', { detail: status }));
  return status.available;
}

/** 打开快捷键一览面板（与 `Ctrl+/` 同一件事；开着时再来一下就收起）。 */
export function commandShortcuts(): void {
  window.dispatchEvent(new Event('nf-shortcuts-command'));
}

// ---------------------------------------------------------------- 在「文件」页定位

/**
 * 在「文件」页定位到某个文件或目录（编辑器的面包屑目录段、标签右键「在文件页中定位」）。资源管理器展开到它、
 * 高亮那一行；view 切到「文件」页。编辑器不碰资源管理器的状态，资源管理器也不读编辑器的。
 */
export function revealInFiles(path: string, dir = false): void {
  window.dispatchEvent(new CustomEvent('nf-reveal-in-files', { detail: { path, dir } }));
}

// ---------------------------------------------------------------- 在某处弹一个菜单

/**
 * 在视口坐标 (x, y) 弹一个菜单（与右键菜单同一个引擎、同一种样子，同时只有一个；点别处 / Esc 收起）。
 * 返回菜单节点，view 没装时返回 undefined。**调用方要 `stopPropagation()` 那一下点击**，否则它冒到
 * document 上就把刚弹出来的菜单收掉了。
 */
export function showMenuAt(items: MenuItem[], x: number, y: number): HTMLElement | undefined {
  return window.__nfShowMenu?.(items, x, y);
}

// ---------------------------------------------------------------- 对话页「加入选区」

/**
 * 内置编辑器当前那块编辑区里选中的文字（`editor/index.ts` 回答）。`relPath` 是工作区相对路径，`start` / `end` 是
 * 1-based 闭区间的行号，`text` 已去掉首尾空白。
 */
export interface EditorSelection {
  relPath: string;
  text: string;
  start: number;
  end: number;
}

/**
 * 问内置编辑器的选区。没选中、在 Markdown 预览里、或者根本没有内置编辑器（插件形态，editor.js 没装）时返回
 * undefined——对话页就照旧发不带选区的 `addSelection`，交给宿主（插件读 VS Code 编辑器的选区，独立版弹粘贴框）。
 */
export function querySelection(): EditorSelection | undefined {
  const sel: EditorSelection = { relPath: '', text: '', start: 0, end: 0 };
  window.dispatchEvent(new CustomEvent('nf-selection-query', { detail: sel }));
  return sel.relPath && sel.text ? sel : undefined;
}

// ---------------------------------------------------------------- 叙事线总览（叙事线重做三期）

/**
 * 工程页「叙事线」页签打开编辑区里的「叙事线总览」（`editor/threadsOverview.ts`）。`focus`：打开后定位到哪一行——一条线的
 * 文件路径，或「未归属的伏笔」那份文件的路径（右键「在总览里看」）。
 */
export interface ThreadsOverviewCommand {
  name: 'open';
  focus?: string;
}

/**
 * 有没有地方画叙事线总览。**能力探测**：editor.js 装上了才有人回答（它探测到 `#wbEditor` 才装）；插件形态没有内置编辑器，
 * 没人回答就是 false，工程页上的「总览」按钮与「在总览里看」都不画（AGENTS 架构要点：不判断是哪个壳）。
 */
export function queryThreadsOverview(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-threads-query', { detail: status }));
  return status.available;
}

export function commandThreadsOverview(focus?: string): void {
  const detail: ThreadsOverviewCommand = { name: 'open', ...(focus ? { focus } : {}) };
  window.dispatchEvent(new CustomEvent('nf-threads-command', { detail }));
}

// ---------------------------------------------------------------- 时间线总览（2026-10-24）

/**
 * 工程页「时间线」组打开编辑区里的「时间线总览」（`editor/timelineOverview.ts`）。`chapter`：打开后展开哪一章、滚过去（点一章、
 * 点一条带章号的 ⚠）。
 */
export interface TimelineOverviewCommand {
  name: 'open';
  chapter?: number;
}

/** 有没有地方画时间线总览。**能力探测**（同 {@link queryThreadsOverview}）：插件形态没有内置编辑器，没人回答就是 false。 */
export function queryTimelineOverview(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-timeline-query', { detail: status }));
  return status.available;
}

export function commandTimelineOverview(chapter?: number): void {
  const detail: TimelineOverviewCommand = { name: 'open', ...(chapter !== undefined ? { chapter } : {}) };
  window.dispatchEvent(new CustomEvent('nf-timeline-command', { detail }));
}

// ---------------------------------------------------------------- 工程页「存档点…」

/**
 * 内置编辑器里开着、有未保存修改的文件（`editor/index.ts` 回答，与全书替换跳过的是同一批）。存档点退回时随请求带上，
 * 后端跳过它们——不拿存档点里的旧稿去盖编辑器里还没存下的字。没有内置编辑器（插件形态，editor.js 没装）时没人回答，
 * 是空的：VS Code 自己的编辑器有它自己那一套。
 */
export function queryDirtyPaths(): string[] {
  const detail = { paths: [] as string[] };
  window.dispatchEvent(new CustomEvent('nf-dirty-query', { detail }));
  return detail.paths;
}
