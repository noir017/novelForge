import * as vscode from 'vscode';
import { makeNonce } from '../core/protocol';

/**
 * 两个 webview 宿主共用的 HTML。只加载本地资源，CSP 里不开任何外部来源。
 * bridge.js 在 view.js 之前加载：webview 里它检测到 acquireVsCodeApi 存在就直通。
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
  <button class="tab" data-tab="project">工程</button>
  <button class="tab" data-tab="history">历史</button>
  <button class="tab" data-tab="settings">设置</button>
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

<!-- ------------------------------------------------------------ 工程 -->
<section class="pane" id="pane-project">
  <div class="project-toolbar" id="projectToolbar">
    <button class="chip-btn" data-action="newChapter">＋ 新建章节</button>
    <button class="chip-btn" data-action="newCharacter">＋ 角色卡</button>
    <button class="chip-btn" data-action="newLore">＋ 设定</button>
    <button class="chip-btn" data-action="newFolder">＋ 文件夹</button>
    <span class="spacer"></span>
    <button class="icon-btn" data-action="refresh" title="刷新">⟳</button>
  </div>
  <div class="project-body" id="projectBody"></div>
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
  </div>

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
  <div class="hint" id="settingsStorageHint">设置写入工作区 settings.json；API Key 只存 SecretStorage，不落盘到配置文件。</div>
</section>

<div class="modal-overlay hidden" id="providerModal">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="providerModalTitle">配置</span>
      <button class="icon-btn" id="providerModalClose" title="关闭">×</button>
    </div>
    <div class="modal-body" id="providerModalBody"></div>
  </div>
</div>

<div class="toast hidden" id="toast"></div>
<script nonce="${nonce}" src="${asset('bridge.js')}"></script>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
