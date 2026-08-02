import * as vscode from 'vscode';
import { BuiltContext, ContextItem } from '../context/builder';
import { ContinueSession } from '../features/continueWriting';
import { NovelProject, readConfig } from '../model/project';

/** Webview → 扩展 */
type InMessage =
  | { type: 'ready' }
  | { type: 'preview'; payload: FormPayload }
  | { type: 'generate'; payload: FormPayload }
  | { type: 'stop' }
  | { type: 'accept'; draft: string; mode: 'append' | 'new'; order: number; title: string }
  | { type: 'openFile'; path: string }
  | { type: 'syncSummaries' }
  | { type: 'setApiKey' };

interface FormPayload {
  outline: string;
  targetOrder: number;
  targetWords: number;
  extraInstruction: string;
  excludedIds: string[];
  revisionFeedback?: string;
  previousDraft?: string;
}

/** 扩展 → Webview */
type OutMessage =
  | { type: 'init'; state: PanelState }
  | { type: 'state'; state: PanelState }
  | { type: 'context'; items: SerializedItem[]; usedTokens: number; budget: number; clamped: boolean }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'accepted'; path: string }
  | { type: 'busy'; value: boolean };

interface SerializedItem {
  id: string;
  label: string;
  kind: string;
  priority: number;
  tokens: number;
  status: string;
  note?: string;
  source?: string;
}

interface PanelState {
  chapters: { order: number; title: string; wordCount: number }[];
  nextOrder: number;
  defaultTargetOrder: number;
  staleCount: number;
  providerLabel: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export class ContinuePanel {
  private static instance: ContinuePanel | undefined;

  static async show(
    context: vscode.ExtensionContext,
    project: NovelProject,
    opts: { targetOrder?: number } = {}
  ): Promise<void> {
    if (ContinuePanel.instance) {
      ContinuePanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      if (opts.targetOrder !== undefined) {
        ContinuePanel.instance.pendingTargetOrder = opts.targetOrder;
        await ContinuePanel.instance.pushState();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'novelForge.continue',
      'Novel Forge · 续写',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    ContinuePanel.instance = new ContinuePanel(panel, context, project, opts.targetOrder);
  }

  static refreshIfOpen(): void {
    void ContinuePanel.instance?.pushState();
  }

  static disposeInstance(): void {
    ContinuePanel.instance?.panel.dispose();
  }

  private readonly session: ContinueSession;
  private pendingTargetOrder: number | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly project: NovelProject,
    targetOrder: number | undefined
  ) {
    this.session = new ContinueSession(project);
    this.pendingTargetOrder = targetOrder;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = this.render(context.extensionUri);

    this.panel.webview.onDidReceiveMessage((msg: InMessage) => void this.handle(msg));
    this.panel.onDidDispose(() => {
      this.session.dispose();
      ContinuePanel.instance = undefined;
    });
  }

  private post(message: OutMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async buildState(): Promise<PanelState> {
    const chapters = await this.project.listChapters();
    const nextOrder = await this.project.nextChapterOrder();
    const stale = await this.project.staleChapters();
    const config = readConfig();
    const providerLabel =
      config.provider === 'vscode-lm'
        ? `${config.vscodeLmFamily}（VS Code LM）`
        : config.provider === 'anthropic'
          ? config.anthropicModel
          : config.openaiModel;

    return {
      chapters: chapters.map((c) => ({ order: c.order, title: c.title, wordCount: c.wordCount })),
      nextOrder,
      defaultTargetOrder: this.pendingTargetOrder ?? nextOrder,
      staleCount: stale.length,
      providerLabel,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
    };
  }

  private async pushState(): Promise<void> {
    this.project.invalidate();
    this.post({ type: 'state', state: await this.buildState() });
  }

  private async handle(msg: InMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'init', state: await this.buildState() });
          return;

        case 'preview': {
          const built = await this.session.preview(toRequest(msg.payload));
          this.postContext(built);
          return;
        }

        case 'generate': {
          if (!msg.payload.outline.trim()) {
            this.post({ type: 'error', message: '请先填写剧情纲要。' });
            return;
          }
          this.post({ type: 'busy', value: true });
          const built = await this.session.generate(toRequest(msg.payload), {
            onDelta: (delta) => this.post({ type: 'delta', text: delta }),
            onDone: (full) => {
              this.post({ type: 'done', text: full });
              this.post({ type: 'busy', value: false });
            },
            onError: (message) => {
              this.post({ type: 'error', message });
              this.post({ type: 'busy', value: false });
            },
            onCancelled: () => {
              this.post({ type: 'cancelled' });
              this.post({ type: 'busy', value: false });
            },
          });
          if (built) {
            this.postContext(built);
          } else {
            this.post({ type: 'busy', value: false });
          }
          return;
        }

        case 'stop':
          this.session.stop();
          return;

        case 'accept': {
          if (!msg.draft.trim()) {
            this.post({ type: 'error', message: '草稿是空的。' });
            return;
          }
          const uri =
            msg.mode === 'append'
              ? await this.session.accept(msg.draft, { mode: 'append', order: msg.order })
              : await this.session.accept(msg.draft, {
                  mode: 'new',
                  order: msg.order,
                  title: msg.title.trim() || `第${msg.order}章`,
                });
          const rel = this.project.relPath(uri);
          this.post({ type: 'accepted', path: rel });
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
            viewColumn: vscode.ViewColumn.One,
          });
          void vscode.commands.executeCommand('novel.refresh');
          await this.pushState();
          return;
        }

        case 'openFile':
          await vscode.commands.executeCommand('novel.openFile', msg.path);
          return;

        case 'syncSummaries':
          await vscode.commands.executeCommand('novel.syncSummaries');
          await this.pushState();
          return;

        case 'setApiKey':
          await vscode.commands.executeCommand('novel.setApiKey');
          return;
      }
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.post({ type: 'busy', value: false });
    }
  }

  private postContext(built: BuiltContext): void {
    this.post({
      type: 'context',
      items: built.items.map(serializeItem),
      usedTokens: built.usedTokens,
      budget: built.budget,
      clamped: built.budgetClampedByProvider,
    });
  }

  private render(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link href="${styleUri}" rel="stylesheet">
<title>Novel Forge · 续写</title>
</head>
<body>
<div class="wrap">
  <header>
    <div class="title">续写</div>
    <div class="meta" id="providerMeta"></div>
  </header>

  <div class="banner hidden" id="staleBanner">
    <span id="staleText"></span>
    <button class="link" id="syncBtn">立即同步</button>
  </div>

  <section class="card">
    <div class="row">
      <label class="field">
        <span>写入位置</span>
        <select id="targetSelect"></select>
      </label>
      <label class="field small">
        <span>目标字数</span>
        <input type="number" id="targetWords" value="2000" min="0" step="100">
      </label>
    </div>

    <label class="field" id="titleField">
      <span>新章标题</span>
      <input type="text" id="newTitle" placeholder="留空则用纲要首句">
    </label>

    <label class="field">
      <span>剧情纲要 <em>必填 · 写清这一章要发生什么，模型负责扩充细节</em></span>
      <textarea id="outline" rows="7" placeholder="例：&#10;1. 林昭在城门口被守卫拦下，亮出旧令牌，守卫神色骤变。&#10;2. 他在客栈遇到自称货商的女子，对方话里有话地问起七年前的事。&#10;3. 深夜有人潜入他的房间，翻找那枚令牌，被他当场按住——是白天那个守卫。"></textarea>
    </label>

    <label class="field">
      <span>额外要求 <em>可选</em></span>
      <input type="text" id="extra" placeholder="例：多写对白，少写环境描写；结尾停在冲突爆发前">
    </label>

    <div class="actions">
      <button id="previewBtn" class="secondary">预览上下文</button>
      <button id="generateBtn" class="primary">生成</button>
      <button id="stopBtn" class="danger hidden">停止</button>
    </div>
  </section>

  <section class="card" id="contextCard">
    <div class="card-head">
      <span>上下文明细</span>
      <span class="meta" id="budgetMeta">尚未装配</span>
    </div>
    <div class="hint">取消勾选可临时排除某项。灰色划线表示因预算不足未能注入。</div>
    <ul class="items" id="itemList"></ul>
  </section>

  <section class="card" id="resultCard">
    <div class="card-head">
      <span>生成结果</span>
      <span class="meta">
        <button class="link hidden" id="prevVer">◀</button>
        <span id="verLabel"></span>
        <button class="link hidden" id="nextVer">▶</button>
        <span id="draftMeta"></span>
      </span>
    </div>
    <textarea id="draft" rows="18" placeholder="生成结果会出现在这里，可直接编辑后再采纳。"></textarea>
    <div class="actions">
      <button id="acceptBtn" class="primary" disabled>采纳并写入</button>
      <button id="rewriteBtn" class="secondary" disabled>带意见重写</button>
      <button id="discardBtn" class="secondary" disabled>丢弃</button>
    </div>
    <label class="field hidden" id="feedbackField">
      <span>修改意见</span>
      <textarea id="feedback" rows="3" placeholder="例：第二段的对白太文气了，改得口语一些；结尾不要收束，停在推门那一刻。"></textarea>
      <div class="actions">
        <button id="doRewriteBtn" class="primary">按意见重写</button>
        <button id="cancelRewriteBtn" class="secondary">取消</button>
      </div>
    </label>
  </section>

  <div class="toast hidden" id="toast"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function toRequest(payload: FormPayload) {
  return {
    targetOrder: payload.targetOrder,
    outline: payload.outline,
    targetWords: payload.targetWords > 0 ? payload.targetWords : undefined,
    extraInstruction: payload.extraInstruction,
    excludedIds: payload.excludedIds,
    revision:
      payload.revisionFeedback && payload.previousDraft
        ? { previousDraft: payload.previousDraft, feedback: payload.revisionFeedback }
        : undefined,
  };
}

function serializeItem(item: ContextItem): SerializedItem {
  return {
    id: item.id,
    label: item.label,
    kind: item.kind,
    priority: item.priority,
    tokens: item.tokens,
    status: item.status,
    note: item.note,
    source: item.source,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
