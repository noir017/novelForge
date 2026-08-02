import * as vscode from 'vscode';
import { extractCharacters, newCharacter, newLore } from './features/characters';
import { quickContinue } from './features/continueWriting';
import { extractStyle } from './features/style';
import { rebuildGlobalSummary, summarizeChapter, syncSummaries } from './features/summarize';
import { clearApiKey, initSecrets, promptForApiKey } from './llm/registry';
import { NovelProject, readConfig } from './model/project';
import { ChatController } from './ui/chatController';
import { ChatPanel } from './ui/chatPanel';
import { ChatViewProvider } from './ui/chatViewProvider';
import { NovelTreeProvider } from './ui/treeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initSecrets(context);

  const project = NovelProject.current();
  if (project) {
    await offerMigration(project);
  }
  const treeProvider = project ? new NovelTreeProvider(project) : undefined;
  const chat = project ? new ChatController(project) : undefined;

  if (chat) {
    const viewProvider = new ChatViewProvider(context.extensionUri, chat);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
        // 侧边栏被折叠时保留 webview 状态，否则草稿和流式内容会丢。
        webviewOptions: { retainContextWhenHidden: true },
      }),
      { dispose: () => chat.dispose() }
    );
  }

  if (treeProvider && project) {
    context.subscriptions.push(
      vscode.window.createTreeView('novelForge.explorer', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
      })
    );
    await setInitializedContext(project);
    registerWatcher(context, project, treeProvider, chat);
  }

  const refresh = async () => {
    project?.invalidate();
    treeProvider?.refresh();
    await chat?.pushState();
    if (project) {
      await setInitializedContext(project);
    }
  };

  const register = (command: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: any[]) => {
        try {
          await handler(...args);
        } catch (err) {
          if ((err as Error)?.name === 'CancelledError') {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Novel Forge：${message}`);
        }
      })
    );
  };

  // ---------------------------------------------------------------- 工程

  register('novel.initProject', async () => {
    const target = NovelProject.current();
    if (!target) {
      void vscode.window.showErrorMessage('Novel Forge：请先打开一个工作区文件夹。');
      return;
    }
    if (await target.isInitialized()) {
      void vscode.window.showInformationMessage('Novel Forge：当前工作区已经是小说工程。');
      return;
    }

    const title = await vscode.window.showInputBox({
      title: '初始化小说工程（1/2）',
      prompt: '作品名',
      value: workspaceName(),
      validateInput: (v) => (v.trim() ? undefined : '不能为空'),
    });
    if (!title) {
      return;
    }
    const author = await vscode.window.showInputBox({
      title: '初始化小说工程（2/2）',
      prompt: '作者名（可留空）',
      ignoreFocusOut: true,
    });

    await target.initialize({ title: title.trim(), author: (author ?? '').trim() });
    await refresh();

    const pick = await vscode.window.showInformationMessage(
      `Novel Forge：已初始化《${title.trim()}》。要现在新建第 1 章吗？`,
      '新建第 1 章',
      '稍后'
    );
    if (pick === '新建第 1 章') {
      await vscode.commands.executeCommand('novel.newChapter');
    }
  });

  register('novel.refresh', refresh);

  register('novel.openFile', async (relPath: string) => {
    const target = NovelProject.current();
    if (!target || !relPath) {
      return;
    }
    const uri = vscode.Uri.joinPath(target.root, relPath);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  });

  register('novel.newChapter', async () => {
    const target = await NovelProject.require();
    if (!target) {
      return;
    }
    const order = await target.nextChapterOrder();
    const title = await vscode.window.showInputBox({
      title: `新建第 ${order} 章`,
      prompt: '章节标题',
      value: `第${order}章`,
      validateInput: (v) => (v.trim() ? undefined : '不能为空'),
    });
    if (!title) {
      return;
    }
    const uri = await target.createChapter(order, title.trim());
    await refresh();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  });

  register('novel.newCharacter', async () => {
    const target = await NovelProject.require();
    if (target) {
      await newCharacter(target);
      await refresh();
    }
  });

  register('novel.newLore', async () => {
    const target = await NovelProject.require();
    if (target) {
      await newLore(target);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 模型

  register('novel.setApiKey', (provider?: 'openai' | 'anthropic') => promptForApiKey(provider));
  register('novel.clearApiKey', (provider?: 'openai' | 'anthropic') => clearApiKey(provider));

  // ---------------------------------------------------------------- 续写

  register('novel.continue', async () => {
    const target = await NovelProject.require();
    if (target) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  });

  register('novel.openChatInEditor', async () => {
    const target = await NovelProject.require();
    if (target && chat) {
      ChatPanel.show(context.extensionUri, chat);
    }
  });

  register('novel.newSession', async () => {
    const target = await NovelProject.require();
    if (target && chat) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await chat.newSessionFromCommand();
    }
  });

  register('novel.openSettings', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('settings');
  });

  register('novel.addSelectionToChat', async () => {
    const target = await NovelProject.require();
    if (!target || !chat) {
      return;
    }
    if (!chat.addSelectionFromCommand()) {
      void vscode.window.showWarningMessage('Novel Forge：请先在编辑器里选中一段文字。');
    }
  });

  register('novel.continueFromChapter', async (node?: { chapterOrder?: number }) => {
    const target = await NovelProject.require();
    if (!target || !chat) {
      return;
    }
    // 从某章右键进来时，默认写「下一章」。
    const order = node?.chapterOrder !== undefined ? node.chapterOrder + 1 : await target.nextChapterOrder();
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat.focusWithTarget(order);
  });

  register('novel.quickContinue', async () => {
    const target = await NovelProject.require();
    if (target) {
      await quickContinue(target);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 总结

  register('novel.summarizeChapter', async (arg?: number | { chapterOrder?: number }) => {
    const target = await NovelProject.require();
    if (!target) {
      return;
    }

    const order = typeof arg === 'number' ? arg : arg?.chapterOrder;
    const chapter = order !== undefined ? await target.getChapter(order) : await pickChapter(target);
    if (!chapter) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Novel Forge：总结第 ${chapter.order} 章`,
        cancellable: true,
      },
      async (_progress, token) => {
        const ok = await summarizeChapter(target, chapter, undefined, token);
        if (ok) {
          void vscode.window.showInformationMessage(`Novel Forge：第 ${chapter.order} 章摘要已生成。`);
          await refresh();
        }
      }
    );
  });

  register('novel.syncSummaries', async () => {
    const target = await NovelProject.require();
    if (target) {
      await syncSummaries(target);
      await refresh();
    }
  });

  register('novel.rebuildGlobalSummary', async () => {
    const target = await NovelProject.require();
    if (target) {
      await rebuildGlobalSummary(target);
      await refresh();
    }
  });

  register('novel.extractCharacters', async () => {
    const target = await NovelProject.require();
    if (target) {
      await extractCharacters(target);
      await refresh();
    }
  });

  register('novel.extractStyle', async () => {
    const target = await NovelProject.require();
    if (target) {
      await extractStyle(target);
      await refresh();
    }
  });
}

export function deactivate(): void {
  ChatPanel.disposeInstance();
}

// ---------------------------------------------------------------- 辅助

/**
 * 0.1.x 把元数据放在 `.novel/`。检测到旧目录就问一次是否改名，
 * 不静默动用户的文件——那目录可能已经进了 Git。
 */
async function offerMigration(project: NovelProject): Promise<void> {
  if (!(await project.needsMigration())) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    'Novel Forge：检测到旧版数据目录 .novel/，新版已改名为 .novelforge/。要现在重命名吗？',
    { modal: false },
    '重命名',
    '暂不'
  );
  if (pick !== '重命名') {
    return;
  }
  try {
    await project.migrateLegacyDir();
    void vscode.window.showInformationMessage(
      'Novel Forge：已重命名为 .novelforge/。若用 Git 管理，记得提交这次改名。'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Novel Forge：重命名失败（${message}）。可手动把 .novel 改名为 .novelforge。`);
  }
}

/**
 * 监听章节与元数据变化，刷新树与面板。
 * 保存正文会改变 contentHash，从而让对应章节的摘要标记为过期。
 */
function registerWatcher(
  context: vscode.ExtensionContext,
  project: NovelProject,
  tree: NovelTreeProvider,
  chat: ChatController | undefined
): void {
  const config = readConfig();
  const patterns = [
    `${config.chaptersDir}/**/*.md`,
    '.novelforge/**/*.md',
    '.novelforge/project.json',
  ];

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    // 连续保存时合并刷新，避免频繁重算全部章节 hash。
    timer = setTimeout(() => {
      project.invalidate();
      tree.refresh();
      void chat?.pushState();
    }, 250);
  };

  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(project.root, pattern)
    );
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('novel')) {
        schedule();
      }
    })
  );
}

async function setInitializedContext(project: NovelProject): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'novelForge.initialized',
    await project.isInitialized()
  );
}

async function pickChapter(project: NovelProject) {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    void vscode.window.showWarningMessage('Novel Forge：还没有章节。');
    return undefined;
  }

  // 当前编辑器就是某一章时，直接用它。
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const rel = project.relPath(active);
    const match = chapters.find((c) => c.relPath === rel);
    if (match) {
      return match;
    }
  }

  const picked = await vscode.window.showQuickPick(
    chapters.map((c) => ({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      chapter: c,
    })),
    { title: '选择要总结的章节' }
  );
  return picked?.chapter;
}

function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '我的小说';
}
