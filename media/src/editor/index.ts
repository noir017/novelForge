/**
 * 独立版的内置文件编辑器。只在独立版加载（插件形态由 VS Code 自己的编辑器
 * 负责），因此这里可以自由使用 localStorage、beforeunload 等 webview 里
 * 不该用的能力。
 *
 * 与 view 完全解耦：各自监听 window 的 message 事件、各自 postMessage，
 * 互不调用。唯一的交集是共用 #toast 与右键菜单引擎（见 src/globals.ts）。
 *
 * **两块编辑区**：主区放正文，草稿区（`pane: 'draft'`）放草稿，左右并列。
 * **一个路径同一时刻只属于一块**——editorSaved / editorConflict / editorError
 * 都只带 path，靠这条不变量才认得出该送给谁（`paneOwning`）。破坏它会导致
 * 从错的那块保存时用错 baseHash，触发假冲突。
 *
 * 协议：
 *   发 openEditor{path,pane} / openDraft{path} / saveFile / reloadFile / openExternal
 *   收 editorOpen{file,pane} / editorSaved / editorConflict / editorError
 */
import { maybeById } from '../dom';
import { acquireApi, onMessage } from '../vscodeApi';
import { toast } from '../globals';
import { createPane } from './pane';
import { createPaneElements, mainRefs } from './paneElements';
import type { CarriedDraft } from './paneElements';
import {
  collectShell,
  initNarrowToggle,
  initResizers,
  initTheme,
  revealEditor,
} from './shell';
import {
  activePane,
  bindStore,
  paneOwning,
  panes,
  pendingActive,
  pendingDrafts,
  registerPane,
  rekeyStorage,
  restore,
  setActivePane,
  syncDraftVisibility,
} from './store';
import type { Pane } from './store';

const stage = maybeById('wbEditor');
// 插件形态没有这块 DOM，直接退出。
if (stage) {
  start(stage);
}

function start(stage: HTMLElement): void {
  const vscode = acquireApi();
  const post = vscode.postMessage.bind(vscode);
  const shell = collectShell();
  bindStore({ post, draftResizer: shell.draftResizer });

  setActivePane(registerPane(createPane('main', mainRefs(stage), post)));

  /** 草稿区惰性创建：没用过草稿的人不该多出一块空编辑区。 */
  function ensureDraftPane(): Pane {
    if (!panes.draft) {
      const refs = createPaneElements('这一块用来放草稿');
      shell.editors.appendChild(refs.root);
      registerPane(createPane('draft', refs, post));
    }
    syncDraftVisibility();
    return panes.draft!;
  }

  // ---------------------------------------------------------------- 全局快捷键

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 's') {
      // 浏览器的「保存网页」在这里毫无意义，一律拦掉。
      e.preventDefault();
      if (activePane.activeFile()) {
        activePane.save(false);
      }
    } else if (key === 'w' && activePane.activeFile()) {
      // Chrome 不允许拦 Ctrl+W，能拦到就顺手关标签页。
      e.preventDefault();
      activePane.closeFile(activePane.activePath!);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    // 带未保存内容离开页面要先问一句。两块都扫。
    if (Object.values(panes).some((p) => p.hasDirty())) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------------------------------------------------------- 标签搬家

  /**
   * explorer 在 rename/move 成功后广播的搬家事件：把旧标签连同未保存草稿
   * 整体挪到新路径。
   *
   * 走 `moved` 标记绕开 hash 相等检查——改名后文件的 hash 基线必然变化，
   * 但草稿本身没有理由丢。
   */
  window.addEventListener('nf-files-moved', (event) => {
    const { from, to } = event.detail;
    if (!from || !to) {
      return;
    }
    const pane = paneOwning(from);
    const file = pane?.files.get(from);
    if (!pane || !file) {
      return;
    }
    const carry: CarriedDraft | undefined =
      file.draft !== file.text ? { hash: file.hash, draft: file.draft, moved: true } : undefined;
    pane.closeSilently(from);
    rekeyStorage(from, to);
    if (carry) {
      pendingDrafts.set(to, carry);
    }
    pendingActive.set(pane.id, to);
    post({ type: 'openEditor', path: to, pane: pane.id });
  });

  // ---------------------------------------------------------------- 收消息

  onMessage((msg) => {
    switch (msg.type) {
      case 'editorOpen': {
        const target = msg.pane === 'draft' ? ensureDraftPane() : panes.main!;
        // 一个路径同一时刻只属于一块编辑区。已经开在另一块里的，连同未保存的
        // 内容一起搬过来，不留两份各自漂移的副本。
        let carried: CarriedDraft | undefined;
        for (const pane of Object.values(panes)) {
          if (pane !== target) {
            const moved = pane.closeSilently(msg.file.path);
            if (moved && moved !== true) {
              carried = moved;
            }
          }
        }
        // 先认下当前这一块，再收文件：upsertFile 末尾会广播「正在编辑哪个
        // 文件」，那句读的是 activePane，顺序反了会报出上一块的文件。
        setActivePane(target);
        target.upsertFile(msg.file, carried);
        syncDraftVisibility();
        revealEditor();
        break;
      }

      case 'editorSaved':
        (paneOwning(msg.file.path) ?? panes.main!).applySaved(msg.file);
        break;

      case 'editorConflict':
        paneOwning(msg.path)?.applyConflict(msg.path, msg.diskText, msg.diskHash);
        break;

      case 'editorError':
        toast(msg.message, true);
        // 恢复时文件可能已被删/改名，别让它卡在待恢复列表里。
        pendingDrafts.delete(msg.path);
        break;
    }
  });

  // ---------------------------------------------------------------- 启动

  initTheme(shell);
  initResizers(shell);
  initNarrowToggle(shell);
  syncDraftVisibility();
  restore();
}
