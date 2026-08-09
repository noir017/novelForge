/**
 * 三个前端产物之间的全部交集。
 *
 * view / editor / explorer 各自独立打包、各自监听 message、各自 postMessage，
 * 唯一互通的就是这里的东西。**别再加第四样**——尤其别让 explorer 直接去读
 * editor 的内部状态（那会把编辑器的私事变成两个文件之间的契约，而资源管理器
 * 在插件形态里根本不存在）。
 *
 * 三样东西：
 * - `__nfToast`：view 出，editor / explorer 用。共用一条提示条，免得两套互相盖住。
 * - `__nfContextMenu`：view 出的右键菜单登记函数。全局 `contextmenu` 监听只在
 *   view 里有一份，另起一套会两层菜单一起弹。
 * - 两个自定义事件：`nf-editor-active`（editor → explorer，高亮当前文件）与
 *   `nf-files-moved`（explorer → editor，改名/搬家后把标签挪过去）。
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

/** 「这个元素上右键给什么菜单」的登记函数。`provide` 在右键那一刻才调用。 */
export type ContextMenuRegistrar = <T extends Element>(node: T, provide: () => MenuItem[]) => T;

declare global {
  interface Window {
    __nfToast?: (message: string, isError?: boolean) => void;
    __nfContextMenu?: ContextMenuRegistrar;
  }

  interface WindowEventMap {
    'nf-editor-active': CustomEvent<{ path: string | null }>;
    'nf-files-moved': CustomEvent<{ from: string; to: string }>;
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
