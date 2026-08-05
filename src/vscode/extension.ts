import * as vscode from 'vscode';
import { initProjectFlow, newChapterFlow } from '../core/actions';
import { ChatController } from '../core/controller';
import { updateSettings, setLegacyConfigReader } from '../core/config';
import { extractCharacters, newCharacter, newLore } from '../core/features/characters';
import { extractStyle } from '../core/features/style';
import { rebuildGlobalSummary, summarizeChapter, syncSummaries } from '../core/features/summarize';
import { getHost, initHost } from '../core/host';
import { clearApiKey, initSecrets, pickModelRef, promptForApiKey, registerProviderFactory } from '../core/llm/registry';
import { NovelProject } from '../core/model/project';
import { providerLabel } from '../core/model/providers';
import { Chapter } from '../core/model/types';
import { ChatPanel } from './chatPanel';
import { ChatViewProvider } from './chatViewProvider';
import { quickContinue } from './quickContinue';
import { legacySettingsReader, migrateVscodeSettings } from './migrate';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { VsCodeHost } from './vscodeHost';
import { VsCodeLmProvider } from './vscodeLmProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 老用户的 settings.json / SecretStorage 一次性搬到 ~/.novelforge/，之后双壳共用文件后端。
  await migrateVscodeSettings(context.secrets);
  initHost(new VsCodeHost(new FileConfigStore()));
  setLegacyConfigReader(legacySettingsReader);
  initSecrets(new FileSecretStore());
  registerProviderFactory((active) => new VsCodeLmProvider(active.model.name, providerLabel(active.profile)));

  const project = currentProject();
  if (project) {
    await offerMigration(project);
  }
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
  } else {
    // 没有工作区就没有 controller，但视图仍在活动栏里挂着。
    // 不注册 provider 的话它会一直空转，用户看不出是缺了什么。
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, {
        resolveWebviewView(view) {
          view.webview.html = NO_WORKSPACE_HTML;
        },
      })
    );
  }

  if (project) {
    await setInitializedContext(project);
    registerWatcher(context, project, chat);
  }

  const refresh = async () => {
    project?.invalidate();
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
    const target = await requireProject();
    if (!target) {
      return;
    }
    await initProjectFlow(target, workspaceName());
    await refresh();
  });

  register('novel.refresh', refresh);

  register('novel.openFile', async (relPath: string) => {
    const target = currentProject();
    if (!target || !relPath) {
      return;
    }
    const uri = vscode.Uri.file(target.pathOf(relPath));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  });

  register('novel.newChapter', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    await newChapterFlow(target);
    await refresh();
  });

  register('novel.newCharacter', async () => {
    const target = await requireProject();
    if (target) {
      await newCharacter(target);
      await refresh();
    }
  });

  register('novel.newLore', async () => {
    const target = await requireProject();
    if (target) {
      await newLore(target);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 模型

  register('novel.setApiKey', (providerId?: string) => promptForApiKey(providerId));
  register('novel.clearApiKey', (providerId?: string) => clearApiKey(providerId));

  register('novel.selectModel', async () => {
    const ref = await pickModelRef();
    if (!ref) {
      return;
    }
    await updateSettings({ model: ref });
    await chat?.pushState();
    getHost().toast(`已切换到 ${ref}`);
  });

  // ---------------------------------------------------------------- 续写

  register('novel.continue', async () => {
    const target = await requireProject();
    if (target) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  });

  register('novel.openChatInEditor', async () => {
    const target = await requireProject();
    if (target && chat) {
      ChatPanel.show(context.extensionUri, chat);
    }
  });

  register('novel.newSession', async () => {
    const target = await requireProject();
    if (target && chat) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await chat.newSessionFromCommand();
    }
  });

  register('novel.openSettings', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('settings');
  });

  register('novel.openProject', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('project');
  });

  register('novel.addSelectionToChat', async () => {
    const target = await requireProject();
    if (!target || !chat) {
      return;
    }
    if (!(await chat.addSelectionFromCommand())) {
      void vscode.window.showWarningMessage('Novel Forge：请先在编辑器里选中一段文字。');
    }
  });

  register('novel.continueFromChapter', async (node?: { chapterOrder?: number }) => {
    const target = await requireProject();
    if (!target || !chat) {
      return;
    }
    // 从某章右键进来时，默认写「下一章」。
    const order = node?.chapterOrder !== undefined ? node.chapterOrder + 1 : await target.nextChapterOrder();
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat.focusWithTarget(order);
  });

  register('novel.quickContinue', async () => {
    const target = await requireProject();
    if (target) {
      await quickContinue(target);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 总结

  register('novel.summarizeChapter', async (arg?: number | { chapterOrder?: number }) => {
    const target = await requireProject();
    if (!target) {
      return;
    }

    const order = typeof arg === 'number' ? arg : arg?.chapterOrder;
    const chapter = order !== undefined ? await target.getChapter(order) : await pickChapter(target);
    if (!chapter) {
      return;
    }

    await getHost().progress(`Novel Forge：总结第 ${chapter.order} 章`, async (signal) => {
      const ok = await summarizeChapter(target, chapter, undefined, signal);
      if (ok) {
        getHost().toast(`第 ${chapter.order} 章摘要已生成。`);
        await refresh();
      }
    });
  });

  register('novel.syncSummaries', async () => {
    const target = await requireProject();
    if (target) {
      await syncSummaries(target);
      await refresh();
    }
  });

  register('novel.rebuildGlobalSummary', async () => {
    const target = await requireProject();
    if (target) {
      await rebuildGlobalSummary(target);
      await refresh();
    }
  });

  register('novel.extractCharacters', async () => {
    const target = await requireProject();
    if (target) {
      await extractCharacters(target);
      await refresh();
    }
  });

  register('novel.extractStyle', async () => {
    const target = await requireProject();
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

/** 以当前工作区第一个文件夹为根打开工程实例；没有工作区则 undefined。 */
function currentProject(): NovelProject | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? NovelProject.open(folder.uri.fsPath) : undefined;
}

/** 需要工作区的命令用这个：缺工作区时提示一次。 */
async function requireProject(): Promise<NovelProject | undefined> {
  const project = currentProject();
  if (!project) {
    void vscode.window.showErrorMessage('Novel Forge：请先打开一个工作区文件夹。');
  }
  return project;
}

/** 无工作区时的占位页。不加载脚本，CSP 收到最紧。 */
const NO_WORKSPACE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-descriptionForeground); padding: 16px; line-height: 1.7; }
</style></head>
<body><p>请先打开一个文件夹作为工作区，Novel Forge 的所有数据都存在工作区里。</p></body></html>`;

/**
 * 0.1.x 把元数据放在 `.novel/`。检测到旧目录就问一次是否改名，
 * 不静默动用户的文件——那目录可能已经进了 Git。
 */
async function offerMigration(project: NovelProject): Promise<void> {
  if (!(await project.needsMigration())) {
    return;
  }
  const pick = await getHost().confirm(
    '检测到旧版数据目录 .novel/，新版已改名为 .novelforge/。要现在重命名吗？',
    ['重命名', '暂不']
  );
  if (pick !== '重命名') {
    return;
  }
  try {
    await project.migrateLegacyDir();
    getHost().toast('已重命名为 .novelforge/。若用 Git 管理，记得提交这次改名。');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getHost().toast(`重命名失败（${message}）。可手动把 .novel 改名为 .novelforge。`, 'error');
  }
}

/**
 * 监听章节与元数据变化，刷新面板。
 * 保存正文会改变 contentHash，从而让对应章节的摘要标记为过期。
 */
function registerWatcher(
  context: vscode.ExtensionContext,
  project: NovelProject,
  chat: ChatController | undefined
): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    // 连续保存时合并刷新，避免频繁重算全部章节 hash。
    timer = setTimeout(() => {
      project.invalidate();
      void chat?.pushState();
    }, 250);
  };

  context.subscriptions.push(getHost().watch(project, schedule));
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

async function pickChapter(project: NovelProject): Promise<Chapter | undefined> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    getHost().toast('还没有章节。');
    return undefined;
  }

  // 当前编辑器就是某一章时，直接用它。
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const rel = project.relPath(active.fsPath);
    const match = chapters.find((c) => c.relPath === rel);
    if (match) {
      return match;
    }
  }

  return getHost().pick(
    chapters.map((c) => ({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      value: c,
    })),
    '选择要总结的章节'
  );
}

function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '我的小说';
}
