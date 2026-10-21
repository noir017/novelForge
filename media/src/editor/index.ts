/**
 * 独立版的内置文件编辑器。只在独立版加载（插件形态由 VS Code 自己的编辑器
 * 负责），因此这里可以自由使用 localStorage、beforeunload 等 webview 里
 * 不该用的能力。
 *
 * 与 view 完全解耦：各自监听 window 的 message 事件、各自 postMessage，
 * 互不调用。唯一的交集是共用 #toast 与右键菜单引擎（见 src/globals.ts）。
 *
 * **两块编辑区**：主区放正文，第二块（`pane: 'draft'`）放草稿或并排打开的细纲，左右并列。
 * **一个路径同一时刻只属于一块**——editorSaved / editorConflict / editorError
 * 都只带 path，靠这条不变量才认得出该送给谁（`paneOwning`）。破坏它会导致
 * 从错的那块保存时用错 baseHash，触发假冲突。
 *
 * 协议：
 *   发 openEditor{path,pane,preview?,replace?} / openDraft{path} / saveFile / reloadFile / openExternal / checkEditorFiles
 *   收 editorOpen{file,pane,preview?,replace?} / editorSaved / editorConflict / editorError / editorDiskChanged / editorDiskGone
 *   / chapterIndex（章节索引，chapterIndex.ts）/ checkTerms（写作体检的词表，check.ts）
 *   （核对磁盘那三条——checkEditorFiles / editorDiskChanged / editorDiskGone——由 diskSync.ts 收发）
 */
import { maybeById } from '../dom';
import { acquireApi, onMessage } from '../vscodeApi';
import { toast } from '../globals';
import { isImeComposing, paneForShortcut } from './api';
import { createPane } from './pane';
import { installBookFind } from './bookFind';
import { installChapterBar } from './chapterBar';
import { installCheck } from './check';
import { installChapterIndex } from './chapterIndex';
import { installChapterNav, takeQuietOpen } from './chapterNav';
import { installConflictMerge } from './conflictMerge';
import { installFind } from './find';
import { installFocus } from './focus';
import { installLook } from './look';
import { installNameMarks } from './nameMarks';
import { installNames } from './names';
import { installParagraphTools } from './paragraph';
import { installQuickOpen } from './quickOpen';
import { installEditorReplace } from './replace';
import { installSaveSafety } from './safety';
import { matchesShortcut } from './shortcuts';
import { installShortcutsPanel } from './shortcutsPanel';
import { installThreadsOverview } from './threadsOverview';
import { installWritingStats } from './stats';
import { installVersions } from './versions';
import { installViewPrefs } from './viewPrefs';
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
  announceActive,
  bindStore,
  cancelScheduledPersist,
  clearClosed,
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
  // ensurePane：「移到另一侧」往第二块搬东西时，它还没造出来就现造。
  bindStore({ post, draftResizer: shell.draftResizer, ensurePane: (id) => (id === 'draft' ? ensureDraftPane() : panes.main!) });
  // 名词补全（Alt+/ 与边打边弹，names.ts）。要在段落工具之前装：候选框开着时回车 / Tab 先归它，按键处理按挂的先后跑。
  installNames(post);
  // 回车、成对符号、段落快捷键、一键排版。要在造编辑区之前装：「排版」按钮挂在第一次重画上。
  installParagraphTools();
  // 不丢稿：磁盘改动同步到已开的标签、保存状态、自动保存（safety.ts）。
  installSaveSafety();
  // 不丢稿：冲突条的「对比合并…」、工具栏「历史」与历史版本面板、两者共用的 editorReplace。同样挂在第一次重画上。
  installEditorReplace();
  installConflictMerge(post);
  installVersions(post);

  setActivePane(registerPane(createPane('main', mainRefs(stage), post)));
  // 章节索引（后端 chapterIndex，哪个页签都推）→ 章节条与上一章 / 下一章（Alt+PageUp / Alt+PageDown）。
  installChapterIndex();
  installChapterNav(post);
  // 正开着某一章的正文或细纲时，主区顶上那一条（W6 章节工作台）。
  installChapterBar(stage, post);
  // 标题栏「视图」菜单的编辑器那一半（单击打开为临时标签）。
  installViewPrefs();
  // 码字统计：状态栏字数那一格（选中、距目标、本次 / 今日码字）与它的面板、「视图 → 统计」。
  installWritingStats();
  // 查找替换（Ctrl+F / Ctrl+H / F3、「编辑」菜单的查找 / 替换）。
  installFind();
  // 写作体检：正文里的 check 图层、状态栏「体检」那一格与它的面板、「视图 → 体检」、「编辑敏感词表…」。
  installCheck(post);
  // 名词高亮：names 图层、悬停浮窗、Ctrl+点击打开卡或条目、「视图 → 名词高亮」。名词表的收发归 installNames。
  installNameMarks(post);

  /**
   * 第二块编辑区惰性创建：没用过的人不该多出一块空编辑区。它放草稿，也放点开一章时
   * 并排打开的那一份细纲（W6）。
   */
  function ensureDraftPane(): Pane {
    if (!panes.draft) {
      const refs = createPaneElements('这一块放草稿或细纲');
      shell.editors.appendChild(refs.root);
      registerPane(createPane('draft', refs, post));
    }
    syncDraftVisibility();
    return panes.draft!;
  }

  // ---------------------------------------------------------------- 全局快捷键

  // 键都登记在 shortcuts.ts（新增快捷键先登记在那张表里，tests/dom/standalone/shortcuts.test.js 两头核对）。
  document.addEventListener('keydown', (e) => {
    // 输入法组字中途的 Ctrl 组合键是输入法的，放行。
    if (isImeComposing(e)) {
      return;
    }
    if (matchesShortcut(e, 'save')) {
      // 浏览器的「保存网页」在这里毫无意义，一律拦掉。
      e.preventDefault();
      if (activePane.activeFile()) {
        activePane.save(false);
      }
    } else if (matchesShortcut(e, 'closeTab') && (activePane.activeFile() || activePane.activeSpecial())) {
      // Chrome 不允许拦 Ctrl+W（表里那一条写着），能拦到（桌面版）就顺手关标签页。正显示着特殊标签（叙事线总览）时关它。
      e.preventDefault();
      closeCurrentTab();
    } else if (matchesShortcut(e, 'preview')) {
      // 预览 / 编辑（⚑ Ctrl+Shift+V，与 VS Code 的「打开预览」同一个键）：只对 Markdown 文件拦，
      // 别的文件（.txt 章节之类）照常是浏览器的「粘贴为纯文本」；焦点在对话输入框里不拦。
      const pane = paneForShortcut(e);
      if (pane?.canPreview()) {
        e.preventDefault();
        pane.setPreviewing(!pane.isPreviewing());
      }
    }
  });

  window.addEventListener('nf-editor-query', (e) => {
    const file = activePane?.activeFile();
    e.detail.hasFile = !!file;
    e.detail.dirtyCurrent = !!file && file.draft !== file.text;
    e.detail.dirtyAny = Object.values(panes).some((p) => p.hasDirty());
    e.detail.path = file?.path ?? null;
    e.detail.text = file?.draft ?? '';
    // 焦点在哪块编辑区的正文区里：标题栏「编辑 → 撤销 / 重做」据此交给编辑器自己的历史。
    e.detail.areaFocused = Object.values(panes).some((p) => p.area === document.activeElement);
  });

  // 对话页「加入选区」：当前那块编辑区里选中的文字。预览里的 textarea 藏着，它的选区作者看不见，不算。
  window.addEventListener('nf-selection-query', (e) => {
    const file = activePane?.activeFile();
    if (!file || activePane.isPreviewing()) {
      return;
    }
    const { value, selectionStart, selectionEnd } = activePane.area;
    const raw = value.slice(selectionStart, selectionEnd);
    const text = raw.trim();
    if (!text) {
      return;
    }
    // 行号按去掉首尾空白之后的那一段算：多选了一个换行不该让范围多出一行。
    const from = selectionStart + (raw.length - raw.trimStart().length);
    const last = selectionEnd - (raw.length - raw.trimEnd().length) - 1;
    const lineOf = (offset: number) => value.slice(0, offset).split('\n').length;
    e.detail.relPath = file.path;
    e.detail.text = text;
    e.detail.start = lineOf(from);
    e.detail.end = lineOf(last);
  });

  window.addEventListener('nf-editor-command', (e) => {
    const name = e.detail.name;
    if (name === 'save') {
      activePane.save(false);
    } else if (name === 'saveAll') {
      for (const pane of Object.values(panes)) {
        for (const file of pane.files.values()) {
          pane.savePath(file.path, false);
        }
      }
    } else if (name === 'close') {
      closeCurrentTab();
    } else if (name === 'undo') {
      activePane.undo();
    } else if (name === 'redo') {
      activePane.redo();
    }
  });

  /** 关当前这一块正显示着的标签：一份文件（先问保存），或一个特殊标签（叙事线总览）。 */
  function closeCurrentTab(): void {
    const special = activePane.activeSpecial();
    if (special) {
      activePane.closeSpecial(special);
    } else if (activePane.activePath) {
      activePane.closeFile(activePane.activePath);
    }
  }

  window.addEventListener('nf-workspace-reset', () => {
    // 不写 localStorage：标签页按工程分开记（projectStorageKey），上一个工程的那份留着下次回来用，
    // 而此刻网址已经换成了新工程，这里写下去会把新工程那份冲成空的。
    cancelScheduledPersist();
    pendingDrafts.clear();
    pendingActive.clear();
    clearClosed();
    for (const pane of Object.values(panes)) {
      // 特殊标签（叙事线总览）画的是上一个工程的东西，一并关掉（不写 localStorage）。
      for (const id of [...pane.specials]) {
        pane.closeSpecial(id, { quiet: true });
      }
      for (const path of [...pane.files.keys()]) {
        pane.closeSilently(path);
      }
    }
    announceActive();
    syncDraftVisibility();
    // 换来的那个工程上次开着的标签页接着开。关掉工程时 restore 自己会跳过。
    restore();
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
    // 临时标签改了名还是临时的（单击打开、没动过它）。
    const carry: CarriedDraft = {
      history: file.history,
      historyText: file.draft,
      preview: !!file.preview,
      markdownPreview: !!file.markdownPreview,
    };
    if (file.draft !== file.text) {
      Object.assign(carry, { hash: file.hash, draft: file.draft, moved: true });
    }
    pane.closeSilently(from);
    rekeyStorage(from, to);
    // 撤销历史也跟着搬：新路径的那份文件到了、内容对得上就接上。
    pendingDrafts.set(to, carry);
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
            if (moved) {
              carried = moved;
            }
          }
        }
        // 先认下当前这一块，再收文件：upsertFile 末尾会广播「正在编辑哪个
        // 文件」，那句读的是 activePane，顺序反了会报出上一块的文件。上一章 / 下一章时另一块里配对的
        // 那一份不认（不抢焦点）。
        if (!takeQuietOpen(target.id, msg.file.path)) {
          setActivePane(target);
        }
        // 临时标签 / 原位换掉：打开请求上带的标记，后端原样带回。
        target.upsertFile(msg.file, carried, { preview: msg.preview, replace: msg.replace });
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

      // 点审稿报告上的引文（五期）：后端先推了那一份的 editorOpen，这里选中那一句。
      case 'editorReveal': {
        const pane = paneOwning(msg.path);
        if (pane) {
          setActivePane(pane);
          if (!pane.reveal(msg.path, msg.quote)) {
            toast('这一句在编辑区里找不到了（可能有没保存的修改）。', true);
          }
        }
        break;
      }

      case 'editorError':
        toast(msg.message, true);
        // 恢复时文件可能已被删/改名，别让它卡在待恢复列表里。
        pendingDrafts.delete(msg.path);
        break;
    }
  });

  // 「转到…」（Ctrl+P）。要在上面那个 onMessage 之后装：editorOpen 先让编辑区收下文件，它才找得到该把焦点放进哪一块。
  installQuickOpen(post);
  // 全书查找替换（Ctrl+Shift+F、「编辑 → 全书查找替换…」）。同一个理由：点了一处要等那份文件的 editorOpen 先进编辑区。
  installBookFind(post);
  // 「视图」菜单的「外观」与「专注」两组（look.ts / focus.ts）。专注要在查找之后装：编辑区里的 Esc 先收查找条，
  // 查找条关着时才退出专注模式（document 上的 keydown 按挂的先后跑，它看 defaultPrevented）。
  installLook();
  installFocus();
  // 「帮助 → 快捷键一览」与 Ctrl+/（⚑）：按分组列出 shortcuts.ts 那张表、可以筛选。
  installShortcutsPanel();
  // 「叙事线总览」特殊标签（叙事线重做三期）：要在 restore() 之前登记，刷新时才认得出存下来的那个标签。
  installThreadsOverview(post);

  // ---------------------------------------------------------------- 启动

  initTheme(shell);
  initResizers(shell);
  initNarrowToggle(shell);
  syncDraftVisibility();
  restore();
}
