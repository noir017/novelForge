/**
 * 对话页的运行时状态，以及输入框草稿的存取。
 *
 * **前端无状态**是这套界面的基本盘：一切数据来自 `ViewState` / `ProjectTree`
 * 的全量推送，webview 销毁重建后一条 `ready` 就能完整恢复。这里留下的只是
 * 纯 UI 的东西——没发出去的草稿、正在流式接收的是哪一条。
 */
import type { SerializedAttachment, SerializedSession, ViewState } from '../protocol';
import { acquireApi } from '../vscodeApi';
import { el } from './refs';

/** 侧边栏折叠再展开时不丢草稿，网页刷新同理（独立版落 localStorage）。 */
interface PersistedDraft {
  draft: string;
  targetWords: string;
}

export const vscode = acquireApi<PersistedDraft>();

export const store: {
  state: ViewState | null;
  session: SerializedSession;
  attachments: SerializedAttachment[];
  busy: boolean;
  /** 正在流式接收的那条消息 id。 */
  streamingId: string | null;
  /** turnId -> 该轮被取消勾选的上下文条目 id 集合。 */
  excluded: Set<string>;
} = {
  state: null,
  // 会话的初值与后端 `SessionStore.create()` 对齐：全书大纲 · 讨论。
  // 它一定会被第一条 `session` 消息覆盖，这里只是让首帧有东西可画。
  session: { id: '', title: '', target: { kind: 'outline' }, stage: 'outline', capability: 'discuss', turns: [] },
  attachments: [],
  busy: false,
  streamingId: null,
  excluded: new Set(),
};

export function restoreDraft(): void {
  const saved = vscode.getState();
  if (!saved) {
    return;
  }
  el.input.value = saved.draft || '';
  if (saved.targetWords) {
    el.targetWords.value = saved.targetWords;
  }
}

export function persistDraft(): void {
  vscode.setState({
    draft: el.input.value,
    targetWords: el.targetWords.value,
  });
}

/**
 * 「打开某个文件」。独立版有内置编辑器，走 openEditor 在右侧开标签页；
 * 插件里没有这块 DOM，仍走 openFile 开 VS Code 的编辑器 tab。
 *
 * 用能力探测而不是判断环境字符串——`#wbEditor` 在不在，就是唯一的判据。
 */
const hasBuiltInEditor = !!document.getElementById('wbEditor');

export function openPath(path: string): void {
  if (path) {
    vscode.postMessage({ type: hasBuiltInEditor ? 'openEditor' : 'openFile', path });
  }
}
