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

      <!-- 流水线条：这一章走到哪一步了。点任一段切到那一层。
           目标是全书大纲时只剩面包屑，四段隐藏。 -->
      <div class="pipeline" id="pipeline">
        <div class="pipeline-crumb" id="pipelineCrumb"></div>
        <div class="pipeline-stages" id="pipelineStages"></div>
        <div class="pipeline-scenes hidden" id="pipelineScenes"></div>
      </div>

      <div class="messages" id="messages">
        <!-- 工作区卡：当前这一层的产物本身。钉在消息流顶部，滚动时不滚出视野。 -->
        <div class="workbench hidden" id="workbench"></div>
        <div class="empty" id="emptyHint">
          <p><strong>先挑一章，从它当前该做的那一步接着做</strong></p>
          <p>在「工程」页点任意章节，或用下面的下拉框选一章——界面会自动落到它的当前阶段：还没细纲就去写细纲，细纲写好了就去拆场景。</p>
          <p>用 <kbd>@</kbd> 引用章节、角色卡或任意文件；输入框为空时按 <kbd>/</kbd> 可以挑其它命令。</p>
          <p>右侧是内置编辑器：在「工程」页点任意文件即可打开编辑，<kbd>Ctrl</kbd>+<kbd>S</kbd> 保存。</p>
        </div>
      </div>

      <!-- 下一步：状态机算出来的那一个动作。点了就跑，不必先输入什么。 -->
      <div class="nextstep hidden" id="nextStep">
        <div class="nextstep-text">
          <span class="nextstep-label" id="nextStepHint"></span>
        </div>
        <button class="primary nextstep-go" id="nextStepBtn"></button>
        <button class="chip-btn" id="cmdBtn" title="其它命令（输入框为空时按 / 也可以）">/ 命令</button>
      </div>

      <div class="composer">
        <div class="chips" id="chips"></div>
        <!-- 已挑好、待执行的命令。发送时用它，不用状态机那一个。 -->
        <div class="pending-cmd hidden" id="pendingCmd"></div>
        <textarea id="input" rows="3" placeholder="补充要求（可留空）…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="composer-bar">
          <button class="chip-btn" id="atBtn" title="引用文件或章节">@ 引用</button>
          <button class="chip-btn" id="selBtn" title="粘贴一段原文加入上下文">加入选区</button>
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
        <button class="chip-btn" id="logEarlierBtn" title="从工程数据库里读更早的日志（重启前的也在）">加载更早</button>
        <button class="chip-btn" id="logCopyBtn" title="复制当前筛选出的日志">复制</button>
        <button class="chip-btn" id="logClearBtn" title="清空日志缓冲">清空</button>
      </div>
      <div class="log-body" id="logBody"></div>
    </section>

    <!-- 设置 -->
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
