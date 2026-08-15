/**
 * 页面骨架：**所有 pane 的 DOM 只在这里定义一次**。
 *
 * 从前插件壳的 webviewHtml.ts 与独立版的 html.ts 各存了一份，约 200 行逐字
 * 重复，AGENTS.md 里还专门立过一条「加按钮要同时改两处」的规矩——那是给重复
 * 打的补丁。现在两个壳都从这里取，各自只保留布局外壳与 head/CSP/资源 URL。
 *
 * 三条约束（见 ../README.md 的壳契约）：
 * - **零 import**：不碰 `vscode`、不碰 `node:`、不碰 `bun:`。任何壳都要能用它，
 *   包括将来跑在别的运行时里的壳。由 tests/contract/shellPurity.test.js 守着。
 * - **差异用选项表达，不判断「我是哪个壳」**：宿主有没有某个能力，就传不传那个选项。
 * - **只有一个壳用到的 pane 也放这里**（`filesPane`），这样第四个壳想装配它时
 *   不必去另一个壳里抄。
 *
 * 缩进在这里是统一的一套，与两个壳原来各自的缩进无关——jsdom 只认结构与 id。
 */

export interface PaneOptions {
  /**
   * 宿主自带内置编辑器（独立版的工作台右半边）。
   * 影响的只是空状态里多给一句「右侧是内置编辑器」的指路。
   */
  builtinEditor?: boolean;
  /**
   * 宿主能取到**原生编辑器的选区**（插件壳）。取不到的宿主（独立版）
   * 那颗按钮是「粘贴一段原文」，title 因此不同。
   */
  selectionFromEditor?: boolean;
  /**
   * 宿主有原生设置界面可跳（只有 VS Code 有）。
   * 没有这个能力时按钮**根本不渲染**——不是渲染出来再让前端 hidden 掉。
   */
  nativeSettings?: boolean;
}

/** 活动栏/标签栏的一项。 */
export interface TabItem {
  /** `data-tab` 的值，前端按它切页。 */
  tab: string;
  label: string;
  /** 活动栏形态的图标字符；插件的横向标签栏不带图标。 */
  icon?: string;
  /** 右上角小圆点的 id（如 `projectStaleDot`）。 */
  dotId?: string;
  /** 圆点的额外 class（如 `err`）。 */
  dotClass?: string;
}

export function escapeHtml(text: string): string {
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

/**
 * 标签栏 / 活动栏。第一项默认选中。
 *
 * 两个壳的观感差别（横向文字标签 vs 纵向图标）全在 CSS 里，这里只管
 * `data-tab` 与圆点——前端认的就是这些。
 */
export function tabbar(items: TabItem[]): string {
  const buttons = items
    .map((item, i) => {
      const icon = item.icon ? `<span class="tab-icon">${item.icon}</span>` : '';
      const label = item.icon ? `<span>${item.label}</span>` : item.label;
      const dot = item.dotId
        ? `<span class="tab-dot${item.dotClass ? ` ${item.dotClass}` : ''} hidden" id="${item.dotId}"></span>`
        : '';
      return `  <button class="tab${i === 0 ? ' active' : ''}" data-tab="${item.tab}">${icon}${label}${dot}</button>`;
    })
    .join('\n');
  return `<nav class="tabbar" id="tabbar">\n${buttons}\n</nav>`;
}

/** 对话页：流水线条 + 消息流 + 下一步 + 输入区。 */
export function chatPane(opts: PaneOptions = {}): string {
  const editorHint = opts.builtinEditor
    ? '\n      <p>右侧是内置编辑器：在「工程」页点任意文件即可打开编辑，<kbd>Ctrl</kbd>+<kbd>S</kbd> 保存。</p>'
    : '';
  const selTitle = opts.selectionFromEditor ? '把编辑器中选中的文字加入上下文' : '粘贴一段原文加入上下文';
  return `<section class="pane active" id="pane-chat">
  <!-- 过期摘要的横幅只长在工程页（那边还带进度条与分母）。对话页从前也挂着
       一份纯文字版，说的是同一句话，却常年占着本就不宽裕的消息流；这里要提示
       的那件事本身也只能在工程页上处理。活动栏「工程」上的小圆点负责在别的
       页面上留个记号。 -->

  <!-- 流水线条：这一章走到哪一步了。点任一层切到那一层。
       目标是全书大纲时只剩面包屑，四段隐藏。 -->
  <div class="pipeline" id="pipeline">
    <div class="pipeline-top" id="pipelineTop">
      <div class="pipeline-crumb" id="pipelineCrumb"></div>
      <!-- 给当前这一章起名 / 改名。新建出来的章是纯序号名（标题要等剧情
           写完才定得下来），所以命名是主流程的一步，得有个常驻入口。
           目标是全书大纲时前端把它藏起来。 -->
      <button class="pipeline-new hidden" id="renamePlotBtn" title="重命名当前章节" aria-label="重命名当前章节">✎</button>
      <button class="pipeline-new" id="newSessionBtn" title="开始新对话" aria-label="开始新对话">＋</button>
    </div>
    <div class="pipeline-stages" id="pipelineStages"></div>
    <div class="pipeline-scenes hidden" id="pipelineScenes"></div>
    <!-- 「当前产物」的入口：一行标题。悬停浮出这一层的产物，点击钉住。
         从前它是消息流顶部一张 sticky 卡片——关不掉、藏不起来，还长期占着
         半屏对话。现在与工程页那三只浮窗同一套路子。 -->
    <button class="wb-entry hidden" id="workbench"></button>
  </div>

  <div class="messages" id="messages">
    <div class="empty" id="emptyHint">
      <p><strong>先挑一章剧情，从它当前该做的那一步接着做</strong></p>
      <p>在「工程」页点任意章节，或用下面的下拉框选一章——界面会自动落到它的当前阶段：还没排剧情就去写剧情，剧情排好了就去拆场景。</p>
      <p>用 <kbd>@</kbd> 引用正文、角色卡或任意文件；在输入框里打 <kbd>/</kbd> 可以挑其它命令。</p>${editorHint}
    </div>
  </div>

  <!-- 下一步：状态机算出来的那一个动作。点了就跑，不必先输入什么。 -->
  <div class="nextstep hidden" id="nextStep">
    <div class="nextstep-text">
      <span class="nextstep-label" id="nextStepHint"></span>
    </div>
    <button class="primary nextstep-go" id="nextStepBtn"></button>
  </div>

  <!-- 输入区。「/」命令面板由前端挂进 #composerInput（它是 position: relative），
       从输入框上沿浮出来——命令本身留在输入框里当普通文字，与 Cursor 一致。 -->
  <div class="composer" id="composer">
    <div class="chips" id="chips"></div>
    <div class="composer-input" id="composerInput">
      <!-- 已挑好、待执行的命令。它长在输入框**里面**，发送时用它，不用状态机那一个。 -->
      <div class="pending-cmd hidden" id="pendingCmd"></div>
      <textarea id="input" rows="3" placeholder="补充要求（可留空）…（Enter 发送，Shift+Enter 换行）"></textarea>
    </div>
    <div class="composer-bar">
      <button class="composer-tool" id="atBtn" title="引用文件或正文"><span class="tool-key">@</span>引用</button>
      <button class="composer-tool" id="selBtn" title="${selTitle}">加入选区</button>
      <button class="composer-tool" id="cmdBtn" title="其它命令（在输入框里直接打 / 也一样）"><span class="tool-key">/</span>命令</button>
      <select id="modelSelect" title="使用哪个模型"></select>
      <select id="targetSelect" title="当前创作目标"></select>
      <input type="number" id="targetWords" value="2000" min="0" step="100" title="目标字数（0 为不限）">
      <span class="spacer"></span>
      <button class="primary" id="sendBtn">发送</button>
      <button class="danger hidden" id="stopBtn">停止</button>
    </div>
    <div class="composer-meta" id="providerMeta"></div>
  </div>
</section>`;
}

/** 工程页：工具栏 + 长任务进度条 + 目录树。 */
export function projectPane(): string {
  return `<section class="pane" id="pane-project">
  <div class="project-toolbar" id="projectToolbar">
    <button class="chip-btn" data-action="newPlot">＋ 新建章节</button>
    <button class="chip-btn" data-action="newCharacter">＋ 角色卡</button>
    <button class="chip-btn" data-action="newLore">＋ 设定</button>
    <button class="chip-btn" data-action="newFolder">＋ 文件夹</button>
    <span class="spacer"></span>
    <button class="icon-btn" data-action="refresh" title="刷新">⟳</button>
  </div>
  <!-- 正在跑的长任务（同步摘要等）。没有任务时整块隐藏。 -->
  <div class="tasks hidden" id="taskList"></div>
  <div class="project-body" id="projectBody"></div>
</section>`;
}

/**
 * 文件页：磁盘上真实的目录结构，含 `.novelforge/` 等点开头的文件夹。
 *
 * 目前只有独立版装配它——插件形态由 VS Code 自己的资源管理器承担这件事。
 * 放在这里而不是放进独立版壳，是为了第四个壳想要它时直接装配，不必去抄。
 */
export function filesPane(): string {
  return `<section class="pane" id="pane-files">
  <div class="fx-toolbar">
    <span class="fx-title">资源管理器</span>
    <span class="spacer"></span>
    <button class="icon-btn" id="filesReveal" title="定位编辑器里当前的文件">◎</button>
    <button class="icon-btn" id="filesCollapse" title="全部折叠">⌃</button>
    <button class="icon-btn" id="filesRefresh" title="刷新">⟳</button>
  </div>
  <div class="fx-body" id="filesBody"></div>
  <div class="hint fx-foot">这里是工程目录的原样结构，含 <code>.novelforge/</code> 等点开头的文件夹。文本文件在右侧编辑器打开，其余交系统程序。</div>
</section>`;
}

/** 历史页：会话列表。 */
export function historyPane(): string {
  return `<section class="pane" id="pane-history">
  <div class="pane-head">
    <span>对话历史</span>
    <span class="meta" id="historyMeta"></span>
  </div>
  <div class="hint">会话保存在 <code>.novelforge/sessions/</code>，可随工程一起提交。</div>
  <ul class="sessions" id="sessionList"></ul>
</section>`;
}

/** 日志页：过滤工具栏 + 日志体。 */
export function logsPane(): string {
  return `<section class="pane" id="pane-logs">
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
</section>`;
}

/**
 * 设置页：服务商与模型、默认模型、高级设置（分档 / 任务档位 / 请求调度）、上下文管理。
 *
 * 存储说明对两个壳是同一句话——插件壳在迁移之后也用 `FileConfigStore`
 * （`~/.novelforge/config.json`）。这里**不再按壳分叉**：从前那句「设置写入工作区
 * settings.json」只在独立版才被前端改掉，于是插件形态长期显示着一句不成立的话。
 */
export function settingsPane(opts: PaneOptions = {}): string {
  const nativeBtn = opts.nativeSettings
    ? '\n    <button class="link" id="nativeSettingsBtn">在 VS Code 设置中打开</button>'
    : '';
  return `<section class="pane" id="pane-settings">
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
    <div class="hint">控制写正文时自动装配的近期原文。预算不足时，完整原文仍会按明细中说明的顺序降级为摘要或省略。</div>
    <div class="grid">
      <label class="field"><span>注入完整原文章数</span><input type="number" id="setRecentChaptersFullText" min="0" max="10"></label>
      <label class="field"><span>上一章结尾字数</span><input type="number" id="setPrevChapterTailChars" min="0" step="100"></label>
    </div>

    <div class="pane-head"><span>全书摘要</span></div>
    <div class="hint">重建全书摘要时，单章摘要先按此数量分批汇总，再合并成全书摘要。</div>
    <div class="grid">
      <label class="field"><span>每批章数</span><input type="number" id="setSummaryBatchSize" min="3"></label>
    </div>
  </div>

  <div class="actions">
    <button class="primary" id="saveSettingsBtn">保存设置</button>${nativeBtn}
  </div>
  <div class="hint" id="settingsStorageHint">设置写入 <code>~/.novelforge/config.json</code>；API Key 存在 <code>~/.novelforge/secrets.json</code>，不进配置文件。</div>
</section>`;
}

/** 服务商配置的模态框（设置页用）。 */
export function providerModal(): string {
  return `<div class="modal-overlay hidden" id="providerModal">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="providerModalTitle">配置</span>
      <button class="icon-btn" id="providerModalClose" title="关闭">×</button>
    </div>
    <div class="modal-body" id="providerModalBody"></div>
  </div>
</div>`;
}

/** toast 的落点。前端往里填内容。 */
export function toastSlot(): string {
  return '<div class="toast hidden" id="toast"></div>';
}
