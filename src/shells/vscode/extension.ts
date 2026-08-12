import * as vscode from 'vscode';
import { initProjectFlow, newChapterFlow } from '../../core/actions';
import { ChatController } from '../../core/controller';
import { promoteModel, setLegacyConfigReader } from '../../core/config';
import { extractCharacters, newCharacter, newLore } from '../../core/features/characters';
import { updateCharacterCard } from '../../core/features/characterCard';
import { generateLore } from '../../core/features/lore';
import { appearancesOf, buildCastIndex, describeChapters } from '../../core/cast';
import { newFolder, sectionRoots } from '../../core/fileOps';
import { extractStyle } from '../../core/features/style';
import { rebuildGlobalSummary, summarizeChapter, syncSummaries } from '../../core/features/summarize';
import { getHost, initHost } from '../../core/host';
import { addLogSink, describeError, formatLogEntry, recentLogs, scoped } from '../../core/logger';
import { runTask } from '../../core/progress';
import { clearApiKey, initSecrets, pickModelRef, promptForApiKey, registerProviderFactory } from '../../core/llm/registry';
import { NovelProject } from '../../core/model/project';
import { providerLabel } from '../../core/model/providers';
import { Chapter } from '../../core/model/types';
import { ChatPanel } from './chatPanel';
import { ChatViewProvider } from './chatViewProvider';
import { quickContinue } from './quickContinue';
import { legacySettingsReader, migrateVscodeSettings } from './migrate';
import { FileConfigStore, FileSecretStore } from '../../core/stores';
import { VsCodeHost } from './vscodeHost';
import { VsCodeLmProvider } from './vscodeLmProvider';

const log = scoped('插件');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 输出面板要最先建：激活途中（迁移、offerMigration）就已经在打日志了，
  // 晚注册的话那几条只进缓冲、不进面板。缓冲里的先补一遍即可。
  registerOutputChannel(context);

  // 老用户的 settings.json / SecretStorage 一次性搬到 ~/.novelforge/，之后双壳共用文件后端。
  await migrateVscodeSettings(context.secrets);
  initHost(new VsCodeHost(new FileConfigStore()));
  setLegacyConfigReader(legacySettingsReader);
  initSecrets(new FileSecretStore());
  registerProviderFactory((active) => new VsCodeLmProvider(active.model.name, providerLabel(active.profile)));

  const project = currentProject();
  log.info(
    `插件已激活${project ? '' : '（无工作区）'}`,
    project ? `工程根 ${project.root}` : '打开一个文件夹后功能才可用'
  );
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
          // 命令是最外层：到这里还没被接住的异常，除了弹窗还要留在日志里。
          log.error(`命令 ${command} 执行失败：${describeError(err)}`, err);
          void vscode.window.showErrorMessage(`Novel Forge：${describeError(err)}`);
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

  register('novel.newFolder', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    // 命令面板没有落点，先问建到哪个区——与工程页工具栏上的按钮同一条路径。
    const section = await getHost().pick(
      sectionRoots(target).map((s) => ({ label: s.label, detail: `${s.root}/`, value: s.section })),
      '在哪个区新建文件夹？'
    );
    if (section) {
      await newFolder(target, section);
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
    await promoteModel(ref);
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

  register('novel.openLogs', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('logs');
  });

  register('novel.showOutputChannel', () => {
    // 面板里的日志与网页里的是同一份，只是这条走 VS Code 原生输出面板，
    // 可以跟其他扩展的日志并排看，也能整段复制。
    outputChannel?.show(true);
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

    await runTask(
      `总结第 ${chapter.order} 章`,
      async ({ signal, report }) => {
        report({ message: `《${chapter.title}》`, current: 0, total: 1 });
        const ok = await summarizeChapter(target, chapter, undefined, signal);
        report({ message: ok ? '完成' : '未生成', current: 1, total: 1 });
        if (ok) {
          getHost().toast(`第 ${chapter.order} 章摘要已生成。`);
          await refresh();
        }
      },
      { scope: '摘要' }
    );
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

  register('novel.generateLore', async () => {
    const target = await requireProject();
    if (target) {
      await generateLore(target);
      await refresh();
    }
  });

  /**
   * 更新单个角色的档案。命令面板入口——工程页的角色行右键走的是同一条
   * core 流程（controller 的 characterAction），两处行为不会分叉。
   *
   * 出场章节由摘要自动关联，所以这里只需要问「更新谁」。
   */
  register('novel.updateCharacterCard', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    const cards = await target.listCharacters();
    if (cards.length === 0) {
      vscode.window.showInformationMessage('还没有角色卡。可先运行「Novel: 提取/更新角色卡」。');
      return;
    }
    const index = await buildCastIndex(target);
    const picked = await vscode.window.showQuickPick(
      cards.map((card) => {
        const chapters = appearancesOf(index, card);
        const pending = chapters.filter((o) => o > (card.updatedThrough ?? 0)).length;
        return {
          label: card.name,
          description: pending > 0 ? `＋${pending} 章待读` : undefined,
          detail: describeChapters(chapters),
          card,
        };
      }),
      { title: '更新哪个角色的档案？', placeHolder: '出场章节由摘要自动关联' }
    );
    if (picked) {
      await updateCharacterCard(target, picked.card.relPath);
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

// ---------------------------------------------------------------- 日志

/** 「Novel Forge」输出面板。整个插件生命周期内只有一个。 */
let outputChannel: vscode.OutputChannel | undefined;

/**
 * 把 core 的日志接到 VS Code 的输出面板上。
 *
 * 缓冲里已有的先补一遍：这个函数在 activate 最开头调用，但迁移、
 * 配置读取等模块在 import 期就可能打过日志了。
 */
function registerOutputChannel(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Novel Forge');
  outputChannel = channel;
  for (const entry of recentLogs()) {
    channel.appendLine(formatLogEntry(entry));
  }
  context.subscriptions.push(
    channel,
    addLogSink((entry) => channel.appendLine(formatLogEntry(entry)))
  );
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
  log.warn('检测到 0.1.x 的 .novel/ 目录', `工程根 ${project.root}`);
  const pick = await getHost().confirm(
    '检测到旧版数据目录 .novel/，新版已改名为 .novelforge/。要现在重命名吗？',
    ['重命名', '暂不']
  );
  if (pick !== '重命名') {
    log.info('用户选择暂不迁移目录');
    return;
  }
  try {
    await project.migrateLegacyDir();
    log.info('.novel/ 已重命名为 .novelforge/');
    getHost().toast('已重命名为 .novelforge/。若用 Git 管理，记得提交这次改名。');
  } catch (err) {
    log.error(`目录重命名失败：${describeError(err)}`, err);
    getHost().toast(`重命名失败（${describeError(err)}）。可手动把 .novel 改名为 .novelforge。`, 'error');
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
