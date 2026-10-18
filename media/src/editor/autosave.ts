/**
 * 自动保存。**缺省关**：标题栏「文件 → 自动保存」（紧跟在「全部保存」后面，开着打 ✓），记在 localStorage
 * `novelforge.editor.prefs`（按浏览器记，不进工程；`paragraphState.ts`）。开着时状态栏挂一枚「自动保存」。
 *
 * 开着时三个时机，一律经 `saving.requestSave(…, { auto: true })`：
 *
 * - **停笔 {@link AUTOSAVE_IDLE_MS}**：存那一份。输入法组字中途不算停笔（拼音还没上屏），上屏之后重新计时。
 * - **切走一个标签**：存刚离开的那一份。
 * - **窗口失去焦点 / 页面藏起来**：存全部。
 *
 * 照样带 `baseHash` 乐观锁。撞上冲突的那一份**停止自动保存**，直到冲突解决（作者在冲突条上选了，基线换了），
 * 绝不强制保存；磁盘上没了的不存；同一份同一时刻只有一个保存在路上，期间又改了就等回执后再存一次；
 * 有对话框开着时先不动（作者正在决定，比如点了「还原」）。这几道闸在 `saving.autoSaveAllowed`。
 *
 * 注意：正文一保存，已经定稿的章就回到「待定稿」——自动保存会让这件事在停笔两秒后就发生（README 写着）。
 */
import { onEditorChange } from './api';
import { isDialogOpen } from './dialog';
import { autoSaveEnabled, onPrefsChange, setAutoSave } from './paragraphState';
import { requestSave } from './saving';
import { paneOwning, panes } from './store';

/** 停笔多久算停。 */
export const AUTOSAVE_IDLE_MS = 2000;

export function installAutoSave(): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在组字的编辑区（compositionstart 到 compositionend 之间）。 */
  const composing = new Set<EventTarget>();
  /** 每块编辑区上一次重画时的当前文件：变了就是切走了。 */
  const lastActive = new Map<string, string | null>();

  const cancel = (path: string): void => {
    clearTimeout(timers.get(path));
    timers.delete(path);
  };
  const schedule = (path: string): void => {
    cancel(path);
    timers.set(
      path,
      setTimeout(() => fire(path), AUTOSAVE_IDLE_MS)
    );
  };
  const fire = (path: string): void => {
    timers.delete(path);
    if (!autoSaveEnabled()) {
      return;
    }
    // 还在组字、或者有对话框开着：不算停笔，再等一轮。
    if (composing.size > 0 || isDialogOpen()) {
      schedule(path);
      return;
    }
    const pane = paneOwning(path);
    if (pane) {
      void requestSave(pane, path, { auto: true });
    }
  };
  // 停笔的计时不在这里作废：这一下要是被闸住了（有对话框开着），到点时还得再试一次；
  // 没被闸住的存过之后就没有修改了，到点时自然跳过。
  const saveAll = (): void => {
    if (!autoSaveEnabled()) {
      return;
    }
    for (const pane of Object.values(panes)) {
      for (const path of [...pane.files.keys()]) {
        void requestSave(pane, path, { auto: true });
      }
    }
  };

  const isEditorArea = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement && t.classList.contains('ed-area');
  document.addEventListener(
    'compositionstart',
    (e) => {
      if (isEditorArea(e.target)) {
        composing.add(e.target);
      }
    },
    true
  );
  document.addEventListener(
    'compositionend',
    (e) => {
      if (e.target) {
        composing.delete(e.target);
      }
    },
    true
  );

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      const prev = lastActive.get(ev.pane.id);
      const now = ev.pane.activePath;
      lastActive.set(ev.pane.id, now);
      if (prev && prev !== now && autoSaveEnabled() && ev.pane.files.has(prev)) {
        void requestSave(ev.pane, prev, { auto: true });
      }
      return;
    }
    if (!autoSaveEnabled()) {
      return;
    }
    // 组字中途（拼音还没上屏）那几下不带 change：还没停笔，计时作废，上屏那一下重新计。
    if (ev.source === 'composition' && !ev.change) {
      cancel(ev.file.path);
      return;
    }
    schedule(ev.file.path);
  });

  window.addEventListener('blur', saveAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveAll();
    }
  });

  // 标题栏「文件 → 自动保存」：问状态、切开关（菜单在 view.js 里，经 nf-editor-query / nf-editor-command）。
  window.addEventListener('nf-editor-query', (e) => {
    e.detail.autoSave = autoSaveEnabled();
  });
  window.addEventListener('nf-editor-command', (e) => {
    if (e.detail.name === 'toggleAutoSave') {
      setAutoSave(!autoSaveEnabled());
    }
  });
  onPrefsChange(() => {
    if (!autoSaveEnabled()) {
      for (const path of [...timers.keys()]) {
        cancel(path);
      }
    }
    for (const pane of Object.values(panes)) {
      pane.refresh();
    }
  });
}
