import * as path from 'node:path';
import { MEDIA_ASSETS } from './mediaAssets';

const LOGO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19v18H6.5A2.5 2.5 0 0 0 4 22z"/>' +
  '<path d="M8 6.5h7M8 10h7M8 13.5h4"/></svg>';

/**
 * 独立版的页面 HTML。
 *
 * 与插件的 webviewHtml.ts 共用 view.css / view.js 与四个 pane 的 DOM，
 * 但外壳是一套 VS Code 式工作台：标题栏 + 活动栏 + 侧栏 + 内置编辑器。
 * 差异集中在这里与 standalone.css / editor.js 三个独立版专属文件，
 * 插件形态一行不受影响。
 */
export function standalonePage(root?: string): string {
  const projectName = root ? path.basename(path.resolve(root)) || root : '';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="/media/view.css" rel="stylesheet">
<link href="/media/standalone.css" rel="stylesheet">
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<title>Novel Forge${projectName ? ` — ${escapeHtml(projectName)}` : ''}</title>
</head>
<body class="workbench">

<!-- ------------------------------------------------------------ 标题栏 -->
<header class="wb-title">
  <span class="wb-logo">${LOGO_SVG}</span>
  <span class="wb-name">Novel Forge</span>
  <span class="wb-project meta" id="wbProject" title="${escapeHtml(root ?? '')}">${escapeHtml(projectName)}</span>
  <span class="spacer"></span>
  <button class="icon-btn" id="wbEditorToggle" title="显示/隐藏编辑器">▤</button>
  <button class="icon-btn" id="wbThemeBtn" title="切换主题">☀</button>
</header>

<div class="wb-main">

  <!-- ---------------------------------------------------------- 活动栏 -->
  <nav class="tabbar" id="tabbar">
    <button class="tab active" data-tab="chat"><span class="tab-icon">✎</span><span>对话</span></button>
    <button class="tab" data-tab="project"><span class="tab-icon">❐</span><span>工程</span><span class="tab-dot hidden" id="projectStaleDot"></span></button>
    <button class="tab" data-tab="files"><span class="tab-icon">🗀</span><span>文件</span></button>
    <button class="tab" data-tab="history"><span class="tab-icon">◷</span><span>历史</span></button>
    <button class="tab" data-tab="logs"><span class="tab-icon">☰</span><span>日志</span><span class="tab-dot err hidden" id="logsErrorDot"></span></button>
    <button class="tab" data-tab="settings"><span class="tab-icon">⚙</span><span>设置</span></button>
  </nav>

  <!-- ---------------------------------------------------------- 侧栏 -->
  <div class="wb-side" id="wbSide">

    <!-- 对话 -->
    <section class="pane active" id="pane-chat">
      <div class="banner hidden" id="staleBanner">
        <span id="staleText"></span>
        <button class="link" id="syncBtn">立即同步</button>
      </div>

      <div class="messages" id="messages">
        <div class="empty" id="emptyHint">
          <p><strong>描述接下来要写什么</strong></p>
          <p>比如：「林昭在城门口被守卫拦下，亮出旧令牌，守卫神色骤变。」</p>
          <p>用 <kbd>@</kbd> 引用章节、角色卡或任意文件；「加入选区」可粘贴一段原文。</p>
          <p>右侧是内置编辑器：在「工程」页点任意文件即可打开编辑，<kbd>Ctrl</kbd>+<kbd>S</kbd> 保存。</p>
        </div>
      </div>

      <div class="composer">
        <div class="chips" id="chips"></div>
        <textarea id="input" rows="3" placeholder="描述要续写或修改的剧情…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="composer-bar">
          <button class="chip-btn" id="atBtn" title="引用文件或章节">@ 引用</button>
          <button class="chip-btn" id="selBtn" title="粘贴一段原文加入上下文">加入选区</button>
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

    <!-- 工程 -->
    <section class="pane" id="pane-project">
      <div class="project-toolbar" id="projectToolbar">
        <button class="chip-btn" data-action="newChapter">＋ 新建章节</button>
        <button class="chip-btn" data-action="newCharacter">＋ 角色卡</button>
        <button class="chip-btn" data-action="newLore">＋ 设定</button>
        <button class="chip-btn" data-action="newFolder">＋ 文件夹</button>
        <span class="spacer"></span>
        <button class="icon-btn" data-action="refresh" title="刷新">⟳</button>
      </div>
      <!-- 正在跑的长任务（同步摘要等）。没有任务时整块隐藏。 -->
      <div class="tasks hidden" id="taskList"></div>
      <div class="project-body" id="projectBody"></div>
    </section>

    <!-- 文件（仅独立版）：磁盘上真实的目录树，点开头的目录也列出来。
         插件形态由 VS Code 自己的资源管理器承担，webviewHtml.ts 里没有这一段。 -->
    <section class="pane" id="pane-files">
      <div class="fx-toolbar">
        <span class="fx-title">资源管理器</span>
        <span class="spacer"></span>
        <button class="icon-btn" id="filesReveal" title="定位编辑器里当前的文件">◎</button>
        <button class="icon-btn" id="filesCollapse" title="全部折叠">⌃</button>
        <button class="icon-btn" id="filesRefresh" title="刷新">⟳</button>
      </div>
      <div class="fx-body" id="filesBody"></div>
      <div class="hint fx-foot">这里是工程目录的原样结构，含 <code>.novelforge/</code> 等点开头的文件夹。文本文件在右侧编辑器打开，其余交系统程序。</div>
    </section>

    <!-- 历史 -->
    <section class="pane" id="pane-history">
      <div class="pane-head">
        <span>对话历史</span>
        <span class="meta" id="historyMeta"></span>
      </div>
      <div class="hint">会话保存在 <code>.novelforge/sessions/</code>，可随工程一起提交。</div>
      <ul class="sessions" id="sessionList"></ul>
    </section>

    <!-- 日志 -->
    <section class="pane" id="pane-logs">
      <div class="log-toolbar">
        <select id="logLevel" title="只显示这一级别以上的日志">
          <option value="debug">全部（含调试）</option>
          <option value="info" selected>信息及以上</option>
          <option value="warn">警告及以上</option>
          <option value="error">仅错误</option>
        </select>
        <input type="search" id="logFilter" placeholder="过滤关键字…">
        <label class="log-follow"><input type="checkbox" id="logFollow" checked>自动滚动</label>
        <span class="spacer"></span>
        <span class="meta" id="logMeta"></span>
        <button class="chip-btn" id="logCopyBtn" title="复制当前筛选出的日志">复制</button>
        <button class="chip-btn" id="logClearBtn" title="清空日志缓冲">清空</button>
      </div>
      <div class="log-body" id="logBody"></div>
    </section>

    <!-- 设置 -->
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
  </div>

  <div class="wb-resizer" id="wbResizer" title="拖动调整宽度，双击复位"></div>

  <!-- ---------------------------------------------------------- 编辑器 -->
  <!-- 两块编辑区并列：主区放正文，草稿区按需出现。草稿区的 DOM 由
       editor.js 克隆主区结构生成，这里只留容器与那条分隔条。 -->
  <div class="wb-editors" id="wbEditors">
  <section class="wb-editor" id="wbEditor">
    <div class="ed-tabs" id="edTabs"></div>

    <div class="ed-toolbar hidden" id="edToolbar">
      <span class="ed-path" id="edPath"></span>
      <button class="chip-btn" id="edPreviewBtn" title="预览 Markdown">预览</button>
      <button class="chip-btn hidden" id="edDraftBtn" title="打开这一章的草稿（并排）">草稿</button>
      <button class="chip-btn" id="edRevertBtn" title="放弃修改，重新从磁盘读取">还原</button>
      <button class="chip-btn" id="edExternalBtn" title="用系统默认程序打开">外部打开</button>
      <button class="primary" id="edSaveBtn" title="保存（Ctrl+S）">保存</button>
    </div>

    <div class="ed-conflict hidden" id="edConflict">
      <span class="ed-conflict-text" id="edConflictText"></span>
      <button class="chip-btn" id="edConflictTake">用磁盘版本覆盖编辑器</button>
      <button class="chip-btn" id="edConflictForce">用编辑器内容强制保存</button>
    </div>

    <div class="ed-stage">
      <div class="ed-welcome" id="edWelcome">
        <span class="ed-welcome-logo">${LOGO_SVG}</span>
        <h2>还没有打开文件</h2>
        <p>在左侧「工程」页点章节、角色卡或设定条目即可在这里编辑；模型采纳写入后也会自动打开。</p>
        <dl>
          <dt><kbd>Ctrl</kbd>+<kbd>S</kbd></dt><dd>保存当前文件</dd>
          <dt><kbd>Enter</kbd></dt><dd>在左侧发送消息</dd>
          <dt><kbd>@</kbd></dt><dd>引用章节 / 角色 / 设定</dd>
        </dl>
      </div>
      <textarea class="ed-area hidden" id="edArea" spellcheck="false" wrap="soft"></textarea>
      <div class="ed-preview hidden" id="edPreview"></div>
    </div>

    <div class="ed-status">
      <span id="edStatusFile"></span>
      <span id="edStatusWords"></span>
      <span class="spacer"></span>
      <span id="edStatusPos"></span>
      <span class="ed-save-state" id="edStatusSave"></span>
    </div>
  </section>

  <div class="wb-resizer wb-draft-resizer hidden" id="wbDraftResizer" title="拖动调整草稿栏宽度，双击复位"></div>
  </div>
</div>

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
<script src="/media/bridge.js"></script>
<script src="/media/view.js"></script>
<script src="/media/editor.js"></script>
<script src="/media/explorer.js"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 从内嵌资源表取字节，供 /media/* 路由直出。 */
export function assetBytes(name: string): { mime: string; bytes: Uint8Array } | undefined {
  const asset = MEDIA_ASSETS[name];
  if (!asset) {
    return undefined;
  }
  return { mime: asset.mime, bytes: Uint8Array.from(Buffer.from(asset.base64, 'base64')) };
}
