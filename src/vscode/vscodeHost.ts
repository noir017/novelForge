import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { CancelledError } from '../core/llm/provider';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { selectionAttachment } from './attachments';

/**
 * 插件壳的 Host 实现：把 core 的窄接口一一接回 VS Code 原生 API，
 * 交互体验与改造前保持一致。
 */
export class VsCodeHost implements Host {
  readonly name = 'vscode' as const;
  readonly supportsVscodeLm = true;

  constructor(public readonly config: import('../core/config').ConfigStore) {}

  async input(opts: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      value: opts.value,
      placeHolder: opts.placeHolder,
      password: opts.password,
      ignoreFocusOut: true,
      validateInput: opts.validate ? (v) => opts.validate!(v) : undefined,
    });
  }

  async confirm(
    message: string,
    actions: string[],
    opts?: { modal?: boolean; detail?: string }
  ): Promise<string | undefined> {
    return vscode.window.showInformationMessage(
      `Novel Forge：${message}`,
      { modal: opts?.modal ?? false, detail: opts?.detail },
      ...actions
    );
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const items: (vscode.QuickPickItem & { value: T })[] = [];
    let group = '';
    for (const c of choices) {
      // 同组只插一次分隔条，还原原 QuickPick 的分组观感。
      if (c.group && c.group !== group) {
        group = c.group;
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator, value: undefined as T });
      }
      items.push({ label: c.label, description: c.description, detail: c.detail, value: c.value });
    }
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDetail: true });
    return picked?.value;
  }

  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort(new CancelledError()));
        try {
          return await fn(abort.signal, (message) => progress.report({ message }));
        } finally {
          sub.dispose();
        }
      }
    );
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    const config = readConfig();
    const patterns = [
      `${config.chaptersDir}/**/*.md`,
      '.novelforge/**/*.md',
      '.novelforge/project.json',
    ];
    const watchers = patterns.map((p) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, p))
    );
    for (const w of watchers) {
      w.onDidChange(onChange);
      w.onDidCreate(onChange);
      w.onDidDelete(onChange);
    }
    return { dispose: () => watchers.forEach((w) => w.dispose()) };
  }

  async openFile(relPath: string): Promise<void> {
    // relPath 相对当前工作区根（与 currentProject() 的口径一致）。
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? path.join(root, relPath) : relPath;
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(abs)),
      { viewColumn: vscode.ViewColumn.One, preview: false }
    );
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    if (level === 'error') {
      void vscode.window.showErrorMessage(`Novel Forge：${message}`);
    } else {
      void vscode.window.showInformationMessage(`Novel Forge：${message}`);
    }
  }

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return selectionAttachment(project);
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: '选择要引用的文件',
      canSelectMany: false,
      defaultUri: vscode.Uri.file(project.root),
      openLabel: '引用',
    });
    const uri = uris?.[0];
    return uri ? project.relPath(uri.fsPath) : undefined;
  }

  async reviewReplace(
    name: string,
    currentText: string,
    proposedText: string
  ): Promise<'apply' | 'discard' | undefined> {
    // 保持原有 diff 体验：当前卡 ↔ 临时建议文件。untitled 文档不支持 diff 保存，
    // 故建议内容先写真实临时文件。
    void currentText; // 左侧用磁盘上的现有文件，无需内容
    const previewAbs = path.join(os.tmpdir(), `novelforge-${Date.now()}-${name}.proposed.md`);
    const currentAbs = await this.findCharacterFile(name);
    await fs.writeFile(previewAbs, proposedText, 'utf8');

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        currentAbs ? vscode.Uri.file(currentAbs) : vscode.Uri.parse('untitled:现有内容'),
        vscode.Uri.file(previewAbs),
        `${name}：现有 ↔ 建议`,
        { preview: true }
      );
      const pick = await vscode.window.showInformationMessage(
        `Novel Forge：是否采纳对「${name}」的更新？`,
        { modal: true },
        '采纳',
        '放弃'
      );
      return pick === '采纳' ? 'apply' : pick === '放弃' ? 'discard' : undefined;
    } finally {
      try {
        await fs.rm(previewAbs, { force: true });
      } catch {
        /* 临时文件删不掉不影响主流程 */
      }
    }
  }

  async openNativeSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'novel.');
  }

  /** 按角色名找到现有卡的绝对路径（diff 左侧）。找不到返回 undefined。 */
  private async findCharacterFile(name: string): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }
    const project = NovelProject.open(root);
    const cards = await project.listCharacters();
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    return card ? project.pathOf(card.relPath) : undefined;
  }
}
