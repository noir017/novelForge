import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../../core/host';
import { CancelledError } from '../../core/llm/provider';
import { CallAnswer, CallChoice, CallPrompt, describeCallChoice, TIERED_LABEL } from '../../core/model/callChoice';
import { CONTEXT_DETAIL_HINT, CONTEXT_DETAIL_LABEL, CONTEXT_DETAILS, ContextDetail } from '../../core/model/contextDetail';
import { NovelProject } from '../../core/model/project';
import { locateQuote } from '../../core/model/review';
import { Attachment } from '../../core/model/session';
import { watchGlobs } from '../../core/watchPolicy';
import { selectionAttachment } from './attachments';
import { isOutlinePath, outlineUri } from './outlineFs';

/**
 * 插件壳的 Host 实现：把 core 的窄接口一一接回 VS Code 原生 API，
 * 交互体验与改造前保持一致。
 */
/** 调模型之前的确认框上多的那一颗按钮（`confirmCall`）。 */
const ADJUST_CALL = '换模型 / 详细度…';

export class VsCodeHost implements Host {
  readonly name = 'vscode' as const;
  readonly supportsVscodeLm = true;

  constructor(public readonly config: import('../../core/config').ConfigStore) {}

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

  /**
   * 调模型之前的那一问。原生模态框放不了下拉框：多一颗「换模型 / 详细度…」，点了依次弹 QuickPick（模型；这一次看
   * 详细度时再选级别，Esc 是不改那一项），选完回到模态框。补充说明里写着「按分档」时各项活交给谁与「这一次：……」。
   */
  async confirmCall(message: string, actions: string[], opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined> {
    const { call } = opts;
    let choice: CallChoice = {
      ...(call.model ? { model: call.model } : {}),
      ...(call.contextDetail ? { contextDetail: call.contextDetail } : {}),
    };
    for (;;) {
      const detail = [opts.detail, choice.model ? '' : call.tiers.join('\n'), (call.fixed ?? []).join('\n'), `这一次：${describeCallChoice(choice)}`]
        .filter(Boolean)
        .join('\n\n');
      const picked = await vscode.window.showInformationMessage(
        `Novel Forge：${message}`,
        { modal: true, detail },
        ...actions,
        ADJUST_CALL
      );
      if (picked !== ADJUST_CALL) {
        return picked ? { action: picked, choice } : undefined;
      }
      choice = await this.adjustCall(call, choice);
    }
  }

  /** 「换模型 / 详细度…」：两个 QuickPick，当前选着的那一项标「当前」。 */
  private async adjustCall(call: CallPrompt, choice: CallChoice): Promise<CallChoice> {
    const current = (on: boolean) => (on ? '当前' : undefined);
    const model = await this.pick<string>(
      [
        { label: TIERED_LABEL, description: current(!choice.model), detail: '各项活按任务档位走，失败换同档其余模型', value: '' },
        ...call.models.map((m) => ({ label: m.ref, description: current(choice.model === m.ref), group: m.group, value: m.ref })),
      ],
      '这一次用哪个模型'
    );
    const next: CallChoice = { ...choice };
    if (model !== undefined) {
      delete next.model;
      if (model) {
        next.model = model;
      }
    }
    if (call.contextDetail) {
      const detail = await this.pick<ContextDetail>(
        CONTEXT_DETAILS.map((d) => ({
          label: `${d} · ${CONTEXT_DETAIL_LABEL[d]}`,
          description: current(next.contextDetail === d),
          detail: CONTEXT_DETAIL_HINT[d],
          value: d,
        })),
        '这一次带多少上下文'
      );
      if (detail !== undefined) {
        next.contextDetail = detail;
      }
    }
    return next;
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

  /** 机制是 VS Code 的 FileSystemWatcher；看哪些东西由 core 的 watchPolicy 说。 */
  watch(project: NovelProject, onChange: () => void): Disposable {
    const watchers = watchGlobs(readConfig()).map((p) =>
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
    await this.show(relPath, vscode.ViewColumn.One);
  }

  /**
   * 「在旁边打开」：草稿开在正文旁边一栏，两边同屏对照。
   *
   * `Beside` 是相对**当前活动编辑器**的。从侧边栏点过来时最后活动的文本
   * 编辑器通常就是正文（openFile 把它放在第一栏），草稿于是落到第二栏；
   * 若此刻活动的是对话面板那个 tab，草稿就开在它旁边。够用，不去纠正。
   */
  async openBeside(relPath: string): Promise<void> {
    await this.show(relPath, vscode.ViewColumn.Beside);
  }

  /**
   * 点审稿报告上的引文（五期）：打开那一章、选中那一句、滚到它。定位用 core 的 `locateQuote`——
   * 与引文校验同一个归一化，报告里说找得到的，这里就选得中。
   */
  async revealText(relPath: string, quote: string): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? path.join(root, relPath) : relPath;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const at = locateQuote(doc.getText(), quote);
    if (!at) {
      return false;
    }
    const range = new vscode.Range(doc.positionAt(at.start), doc.positionAt(at.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  private async show(relPath: string, viewColumn: vscode.ViewColumn): Promise<void> {
    // relPath 相对当前工作区根（与 currentProject() 的口径一致）。
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? path.join(root, relPath) : relPath;
    // 情节大纲没有文件（各章细纲梗概的汇总）：开在虚拟文件系统上（outlineFs.ts）。
    const uri = root && isOutlinePath(root, relPath) ? outlineUri(root) : vscode.Uri.file(abs);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
      { viewColumn, preview: false }
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

  async pickHostFile(opts: { title: string; extensions: string[]; startDir?: string }): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: opts.title,
      canSelectMany: false,
      defaultUri: opts.startDir ? vscode.Uri.file(opts.startDir) : undefined,
      filters: { 文本: opts.extensions },
      openLabel: '选这一本',
    });
    return uris?.[0]?.fsPath;
  }

  /**
   * `opts.merge` 在这里不认：VS Code 的 diff 编辑器本身就能看清改了什么，逐段挑是独立版合并视图
   * 的事（总计划 W11：VS Code 壳继续用 `vscode.diff`）。永远只答采纳 / 放弃。
   */
  async reviewReplace(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<'apply' | 'discard' | undefined> {
    void opts;
    // 保持原有 diff 体验：当前文件 ↔ 临时建议文件。untitled 文档不支持 diff 保存，
    // 故建议内容先写真实临时文件。
    void currentText; // 左侧用磁盘上的现有文件，无需内容
    // 临时文件名取落点的文件名：`name` 是给人看的称呼（「设定「…」」「第 12 章 · 剧情」），
    // 里面可能有斜杠。
    const stem = (relPath ? path.basename(relPath, path.extname(relPath)) : name).replace(/[\\/:*?"<>|]/g, '_');
    const previewAbs = path.join(os.tmpdir(), `novelforge-${Date.now()}-${stem}.proposed.md`);
    // 定位现有文件认 relPath；只有老调用方没给时才按名字找角色卡。从前一律按名字找，
    // 覆盖大纲、细纲时左侧是一片空白。
    const currentAbs = relPath ? this.absOf(relPath) : await this.findCharacterFile(name);
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

  /** 工程相对路径 → 绝对路径（diff 左侧）。没打开工作区返回 undefined。 */
  private absOf(relPath: string): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, relPath) : undefined;
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
