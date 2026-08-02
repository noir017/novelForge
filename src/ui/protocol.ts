import * as vscode from 'vscode';

/** Webview ↔ 扩展 的消息协议。两个宿主（侧边栏 / 编辑器面板）共用。 */

export type Tab = 'chat' | 'history' | 'settings';

export interface SendPayload {
  text: string;
  mode: 'write' | 'discuss';
  targetOrder: number;
  targetWords: number;
  attachments: SerializedAttachment[];
  excludedIds: string[];
}

export interface SerializedAttachment {
  id: string;
  kind: string;
  label: string;
  relPath?: string;
  range?: { start: number; end: number };
  text?: string;
}

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  | { type: 'accept'; turnId: string; mode: 'append' | 'new'; order: number; title: string; text: string }
  | { type: 'editTurn'; turnId: string; text: string }
  | { type: 'deleteTurn'; turnId: string }
  | { type: 'newSession' }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  | { type: 'openInEditor' }
  | { type: 'syncSummaries' }
  | { type: 'selectModel'; ref: string }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  | { type: 'testConnection'; ref?: string }
  | { type: 'openNativeSettings' };

/** 设置页提交的全部内容。服务商列表整体替换。 */
export interface SettingsPayload {
  providers: SerializedProvider[];
  /** 当前模型引用，形如 `glm/glm-4-plus`。 */
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  recentChaptersFullText: number;
  prevChapterTailChars: number;
  summaryBatchSize: number;
  requestTimeoutMs: number;
}

export interface SerializedProvider {
  id: string;
  label?: string;
  kind: 'openai' | 'anthropic' | 'vscode-lm';
  baseUrl?: string;
  models: SerializedModel[];
}

export interface SerializedModel {
  name: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 扩展 → Webview */
export type OutMessage =
  | { type: 'init'; state: ViewState }
  | { type: 'state'; state: ViewState }
  | { type: 'tab'; tab: Tab }
  | { type: 'session'; session: SerializedSession }
  | { type: 'sessions'; list: SessionListItem[] }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  /**
   * `ack` 标明这次推送是不是某次保存的回执：
   * `saved` 表示已落盘（前端可放心以磁盘为准），`rejected` 表示被拒
   * （前端必须保住用户的编辑）。普通刷新不带 ack。
   */
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  | { type: 'toast'; message: string; level: 'info' | 'error' };

export interface ViewState {
  initialized: boolean;
  chapters: { order: number; title: string; wordCount: number }[];
  nextOrder: number;
  staleCount: number;
  /** 当前模型引用；未配置好时为空串。 */
  model: string;
  /** 当前模型的展示名，如「智谱 GLM · glm-4-plus」。 */
  modelLabel: string;
  /** 模型引用无效时的说明，直接显示在输入框下方。 */
  modelIssue?: string;
  /** 下拉框用的全部可选模型。 */
  models: { ref: string; label: string; group: string }[];
  contextWindow: number;
  maxOutputTokens: number;
  /** 宿主是侧边栏还是编辑器面板——侧边栏才显示「在编辑器中打开」。 */
  host: 'sidebar' | 'editor';
}

export interface SerializedSession {
  id: string;
  title: string;
  targetOrder?: number;
  targetWords?: number;
  turns: SerializedTurn[];
}

export interface SerializedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  attachments?: SerializedAttachment[];
  context?: SerializedDigest;
  acceptedTo?: string;
  interrupted?: boolean;
  error?: string;
}

export interface SerializedDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  items: {
    id: string;
    label: string;
    kind: string;
    priority: number;
    tokens: number;
    status: string;
    note?: string;
    source?: string;
  }[];
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
  active: boolean;
}

/** CSP 用的一次性 nonce。 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * 两个宿主共用的 HTML。
 * 只加载本地资源，CSP 里不开任何外部来源。
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};">
<link href="${asset('view.css')}" rel="stylesheet">
<title>Novel Forge</title>
</head>
<body>
<nav class="tabbar" id="tabbar">
  <button class="tab active" data-tab="chat">对话</button>
  <button class="tab" data-tab="history">历史</button>
  <button class="tab" data-tab="settings">设置</button>
  <span class="tabbar-spacer"></span>
  <button class="icon-btn" id="newSessionBtn" title="新建对话">＋</button>
  <button class="icon-btn hidden" id="openInEditorBtn" title="在编辑器中打开">⧉</button>
</nav>

<!-- ------------------------------------------------------------ 对话 -->
<section class="pane active" id="pane-chat">
  <div class="banner hidden" id="staleBanner">
    <span id="staleText"></span>
    <button class="link" id="syncBtn">立即同步</button>
  </div>

  <div class="messages" id="messages">
    <div class="empty" id="emptyHint">
      <p><strong>描述接下来要写什么</strong></p>
      <p>比如：「林昭在城门口被守卫拦下，亮出旧令牌，守卫神色骤变。」</p>
      <p>用 <kbd>@</kbd> 引用章节、角色卡或任意文件；也可以在编辑器里选中一段文字，点下面的「加入选区」。</p>
    </div>
  </div>

  <div class="composer">
    <div class="chips" id="chips"></div>
    <textarea id="input" rows="3" placeholder="描述要续写或修改的剧情…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="composer-bar">
      <button class="chip-btn" id="atBtn" title="引用文件或章节">@ 引用</button>
      <button class="chip-btn" id="selBtn" title="把编辑器中选中的文字加入上下文">加入选区</button>
      <select id="modelSelect" title="使用哪个模型"></select>
      <select id="modeSelect" title="写作模式">
        <option value="write">续写正文</option>
        <option value="discuss">讨论/建议</option>
      </select>
      <select id="targetSelect" title="采纳时写入哪里"></select>
      <input type="number" id="targetWords" value="2000" min="0" step="100" title="目标字数（0 为不限）">
      <span class="spacer"></span>
      <button class="primary" id="sendBtn">发送</button>
      <button class="danger hidden" id="stopBtn">停止</button>
    </div>
    <div class="composer-meta" id="providerMeta"></div>
  </div>
</section>

<!-- ------------------------------------------------------------ 历史 -->
<section class="pane" id="pane-history">
  <div class="pane-head">
    <span>对话历史</span>
    <span class="meta" id="historyMeta"></span>
  </div>
  <div class="hint">会话保存在 <code>.novelforge/sessions/</code>，可随工程一起提交。</div>
  <ul class="sessions" id="sessionList"></ul>
</section>

<!-- ------------------------------------------------------------ 设置 -->
<section class="pane" id="pane-settings">
  <div class="pane-head">
    <span>服务商与模型</span>
    <span class="meta" id="providerCount"></span>
  </div>
  <div class="hint">
    模型用「前缀/模型名」引用，前缀是服务商 id。同一个模型走不同渠道就是两条：
    <code>glm/glm-4-plus</code> 与 <code>openrouter/z-ai/glm-4.6</code>。
    模型名本身可以带斜杠，只在第一个斜杠处切分。
  </div>

  <div id="providerList"></div>

  <div class="actions">
    <button class="secondary" id="addProviderBtn">＋ 添加服务商</button>
    <span class="meta">或从预设添加：</span>
  </div>
  <div class="presets" id="presets"></div>

  <div class="pane-head"><span>默认预算</span></div>
  <div class="hint">未给模型单独设置窗口时用这里的值。</div>
  <div class="grid">
    <label class="field"><span>上下文窗口</span><input type="number" id="setContextWindow" min="4000" step="1000"></label>
    <label class="field"><span>最大输出 token</span><input type="number" id="setMaxOutputTokens" min="256" step="256"></label>
    <label class="field"><span>温度</span><input type="number" id="setTemperature" min="0" max="2" step="0.1"></label>
    <label class="field"><span>注入完整原文章数</span><input type="number" id="setRecentChaptersFullText" min="0" max="10"></label>
    <label class="field"><span>上一章结尾字数</span><input type="number" id="setPrevChapterTailChars" min="0" step="100"></label>
    <label class="field"><span>全书摘要批大小</span><input type="number" id="setSummaryBatchSize" min="3"></label>
    <label class="field"><span>请求超时（毫秒）</span><input type="number" id="setRequestTimeoutMs" min="10000" step="10000"></label>
  </div>

  <div class="actions">
    <button class="primary" id="saveSettingsBtn">保存设置</button>
    <button class="link" id="nativeSettingsBtn">在 VS Code 设置中打开</button>
  </div>
  <div class="hint">设置写入工作区 settings.json；API Key 只存 SecretStorage，不落盘到配置文件。</div>
</section>

<div class="toast hidden" id="toast"></div>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
