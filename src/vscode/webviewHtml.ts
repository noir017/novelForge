import * as vscode from 'vscode';
import { makeNonce } from '../core/protocol';

/**
 * 两个 webview 宿主共用的 HTML。只加载本地资源，CSP 里不开任何外部来源。
 * bridge.js 在 view.js 之前加载：webview 里它检测到 acquireVsCodeApi 存在就直通。
 *
 * 脚本与样式取自 `dist/media/`（`media/src/` 的构建产物，不入库），
 * 所以两个宿主的 `localResourceRoots` 都要带上 `dist`——F5 调试前必须跑过
 * `npm run compile`，否则这里 404 一片白。
 *
 * body 上的 `data-vscode-context` 关掉 VS Code 给 webview 右键菜单加的
 * 复制/粘贴项：右键全部由 view.js 自己接管（见 media/README.md），
 * 不关掉的话点一下会同时冒出两层菜单——JS 的 preventDefault 压不住那一层。
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', name));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};">
<link href="${asset('view.css')}" rel="stylesheet">
<title>Novel Forge</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<nav class="tabbar" id="tabbar">
  <button class="tab active" data-tab="chat">对话</button>
  <button class="tab" data-tab="project">工程</button>
  <button class="tab" data-tab="history">历史</button>
  <button class="tab" data-tab="logs">日志</button>
  <button class="tab" data-tab="settings">设置</button>
</nav>

<!-- ------------------------------------------------------------ 对话 -->
<section class="pane active" id="pane-chat">
  <div class="banner hidden" id="staleBanner">
    <span id="staleText"></span>
    <button class="link" id="syncBtn">立即同步</button>
  </div>

  <!-- 流水线条：这一章走到哪一步了。点任一段切到那一层。
       目标是全书大纲时只剩面包屑，四段隐藏。 -->
  <div class="pipeline" id="pipeline">
    <div class="pipeline-crumb" id="pipelineCrumb"></div>
    <div class="pipeline-stages" id="pipelineStages"></div>
    <div class="pipeline-scenes hidden" id="pipelineScenes"></div>
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
    <!-- 能力按钮组。可用的能力随阶段变，由前端读 STAGE_CAPABILITIES 渲染。 -->
    <div class="capabilities" id="capabilities"></div>
    <textarea id="input" rows="3" placeholder="描述要续写或修改的剧情…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="composer-bar">
      <button class="chip-btn" id="atBtn" title="引用文件或章节">@ 引用</button>
      <button class="chip-btn" id="selBtn" title="把编辑器中选中的文字加入上下文">加入选区</button>
      <select id="modelSelect" title="使用哪个模型"></select>
      <select id="targetSelect" title="当前创作目标"></select>
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
  <!-- 正在跑的长任务（同步摘要等）。没有任务时整块隐藏。 -->
  <div class="tasks hidden" id="taskList"></div>
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

<!-- ------------------------------------------------------------ 日志 -->
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
    <button class="chip-btn" id="logEarlierBtn" title="从工程数据库里读更早的日志（重启前的也在）">加载更早</button>
    <button class="chip-btn" id="logCopyBtn" title="复制当前筛选出的日志">复制</button>
    <button class="chip-btn" id="logClearBtn" title="清空日志缓冲">清空</button>
  </div>
  <div class="log-body" id="logBody"></div>
</section>

<!-- ------------------------------------------------------------ 设置 -->
<section class="pane" id="pane-settings">
  <div class="settings-subtabs" role="tablist" aria-label="设置分类">
    <button class="settings-subtab active" id="settingsTabModels" data-settings-tab="models" role="tab" aria-selected="true" aria-controls="settingsPanelModels">模型配置</button>
    <button class="settings-subtab" id="settingsTabContext" data-settings-tab="context" role="tab" aria-selected="false" aria-controls="settingsPanelContext">上下文管理</button>
  </div>

  <div class="settings-panel active" id="settingsPanelModels" data-settings-panel="models" role="tabpanel" aria-labelledby="settingsTabModels">
    <div class="pane-head">
      <span>服务商与模型</span>
      <span class="meta" id="providerCount"></span>
    </div>
    <div class="hint">
      模型用「前缀/模型名」引用，前缀是服务商 id。同一个模型走不同渠道就是两条：
      <code>glm/glm-4-plus</code> 与 <code>openrouter/z-ai/glm-4.6</code>。
      模型名本身可以带斜杠，只在第一个斜杠处切分。窗口与输出上限在每个模型里单独配置。
    </div>

    <div id="providerList"></div>

    <div class="actions">
      <button class="secondary" id="addProviderBtn">＋ 添加服务商</button>
    </div>

    <div class="pane-head"><span>默认模型</span></div>
    <div class="hint">
      工程页的总结摘要、提取角色卡、生成设定、提取文风等操作用这份列表：<b>串行时用第一个</b>，失败会自动换用后面的重试；
      <b>并发时在列表里轮转</b>做负载均衡。对话页随时可在输入框旁的下拉框里切换——切换等于把那个模型提到列表首位。
    </div>
    <div id="defaultModelList"></div>

    <button type="button" class="settings-advanced-toggle" id="settingsAdvancedToggle" aria-expanded="false" aria-controls="settingsAdvanced">
      <span class="caret">▸</span>
      <span class="settings-advanced-title">高级设置</span>
      <span class="meta">模型分档 · 任务档位 · 请求与调度</span>
    </button>
    <div id="settingsAdvanced" hidden>
      <div class="pane-head"><span>模型分档</span></div>
      <div class="hint">
        简单大量的活交给便宜模型，困难的活交给聪明模型。<b>每档留空就沿用上面的「默认模型」</b>——
        三档都不配，行为和不分档时完全一样。每档也是一份有序清单：串行用第一个，失败自动换用<b>同档</b>其余模型，
        并发时在档内轮转。<b>换人只在档内发生</b>，快速档失败不会偷偷升级到精标档去烧贵 token。
        对话页续写不受分档影响，始终用你在输入框旁选的那个模型。
      </div>
      <div class="tier-grid">
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">快速档</span><span class="tier-hint">便宜、快，用于量大而单次简单的活</span></div>
          <div id="tierModelList-fast"></div>
        </div>
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">均衡档</span><span class="tier-hint">折中，用于量不小但质量也要紧的活</span></div>
          <div id="tierModelList-balanced"></div>
        </div>
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">精标档</span><span class="tier-hint">最聪明的模型，用于一次定调、错了代价大的活</span></div>
          <div id="tierModelList-quality"></div>
        </div>
      </div>

      <div class="pane-head"><span>任务档位</span></div>
      <div class="hint">每项工程页任务归在哪一档。标「默认」的是内置推荐值，按调用次数与单次难度定的。</div>
      <div id="taskTierTable"></div>

      <div class="pane-head"><span>请求与调度</span></div>
      <div class="hint">并发与重试只作用于工程页批量任务；对话页续写始终单请求、严格使用当前选中的模型。</div>
      <div class="grid">
        <label class="field"><span>温度</span><input type="number" id="setTemperature" min="0" max="2" step="0.1"></label>
        <label class="field"><span>请求超时（毫秒）</span><input type="number" id="setRequestTimeoutMs" min="10000" step="10000"></label>
        <label class="field"><span>并发请求数</span><input type="number" id="setConcurrency" min="1" max="16"></label>
        <label class="field"><span>换模型重试次数</span><input type="number" id="setFallbackAttempts" min="0" max="5"></label>
      </div>
    </div>
  </div>

  <div class="settings-panel" id="settingsPanelContext" data-settings-panel="context" role="tabpanel" aria-labelledby="settingsTabContext">
    <div class="pane-head"><span>续写上下文</span></div>
    <div class="hint">控制续写时自动装配的近期原文。预算不足时，完整原文仍会按明细中说明的顺序降级为摘要或省略。</div>
    <div class="grid">
      <label class="field"><span>注入完整原文章数</span><input type="number" id="setRecentChaptersFullText" min="0" max="10"></label>
      <label class="field"><span>上一章结尾字数</span><input type="number" id="setPrevChapterTailChars" min="0" step="100"></label>
    </div>

    <div class="pane-head"><span>全书摘要</span></div>
    <div class="hint">重建全书摘要时，单章摘要先按此数量分批汇总，再合并成全书摘要。</div>
    <div class="grid">
      <label class="field"><span>每批章节数</span><input type="number" id="setSummaryBatchSize" min="3"></label>
    </div>
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
