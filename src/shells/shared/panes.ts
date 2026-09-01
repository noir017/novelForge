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
      <!-- 给当前这一段起名 / 改名。新建出来的段是纯序号名（标题要等剧情
           写完才定得下来），所以命名是主流程的一步，得有个常驻入口。
           目标是全书大纲时前端把它藏起来。 -->
      <button class="pipeline-new hidden" id="renamePlotBtn" title="重命名当前章节" aria-label="重命名当前章节">✎</button>
      <button class="pipeline-new" id="newSessionBtn" title="开始新对话" aria-label="开始新对话">＋</button>
    </div>
    <!-- 卷纲 / 剧情 / 正文 三个状态点。内容由 view/pipeline.ts 画。 -->
    <div class="pipeline-stages" id="pipelineStages"></div>
    <!-- 「当前产物」的入口：一行标题。悬停浮出这一层的产物，点击钉住。
         从前它是消息流顶部一张 sticky 卡片——关不掉、藏不起来，还长期占着
         半屏对话。现在与工程页那三只浮窗同一套路子。 -->
    <button class="wb-entry hidden" id="workbench"></button>
  </div>

  <div class="messages" id="messages">
    <div class="empty" id="emptyHint">
      <p><strong>先挑一章剧情，从它当前该做的那一步接着做</strong></p>
      <p>在「工程」页点任意章节，或用下面的下拉框选一章——界面会落到它当前停在的那一层。</p>
      <p>然后直接说你要做什么：查一句设定、排这一段的剧情、写正文，都是同一个输入框。用 <kbd>@</kbd> 引用正文、角色卡或任意文件，用 <kbd>/</kbd> 呼出一份技能。</p>${editorHint}
    </div>
  </div>

  <!-- 输入区。 -->
  <div class="composer" id="composer">
    <!-- 动手之前那一句问。**固定在输入框上方**，不跟着消息流滚：循环正卡在这里
         等回答，一张会滚出视野的卡片等于没人看见（Cursor 那一套）。答完卡片就
         走，只在消息流里留一行「已跳过/已允许」当记录。 -->
    <div class="gate-dock hidden" id="gateDock"></div>
    <div class="chips" id="chips"></div>
    <div class="composer-input" id="composerInput">
      <textarea id="input" rows="3" placeholder="要它做什么？（Enter 发送，Shift+Enter 换行）"></textarea>
    </div>
    <div class="composer-bar">
      <button class="composer-tool" id="atBtn" title="引用文件或正文"><span class="tool-key">@</span>引用</button>
      <button class="composer-tool" id="skillBtn" title="呼出一份技能：这类事该怎么做的工作流说明（在输入框里打 / 也行）"><span class="tool-key">/</span>技能</button>
      <button class="composer-tool" id="selBtn" title="${selTitle}">加入选区</button>
      <select id="modelSelect" title="使用哪个模型"></select>
      <!-- 思考深度：跟着**会话**走，不是设置项（见 core/model/session.ts）。 -->
      <select id="thinkSelect" title="让模型想多深"></select>
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

/**
 * 生成页：**手动调一次 `generate` 工具**。
 *
 * 九块自上而下，与那个工具的参数一一对应：产出什么（job）/ 落在哪（target）/
 * 补充要求（ask）/ 目标字数 / skills / 用哪个模型 / 动作条 / 输出 / 采纳栏。
 *
 * 三件在这里就定死的事：
 *
 * 1. **落点是下拉框，不是让人填路径。** 工具收裸路径是因为模型手上只有路径，
 *    而作者手上是「第 12 章」「第二卷」。候选由后端按层给（`genTargets`），
 *    候选里没有的（老工程、拆段那种还不存在的落点）走「手填路径」。
 * 2. **目标字数只在 job=manuscript 时渲染**，其余时候整块不在 DOM 里——不是
 *    渲染出来再禁用。一个灰着的输入框只会让人想知道怎么点亮它，而答案是
 *    「这个 job 下它没有意义」。
 * 3. **skills 一份都不写死**：`<div id="genSkills">` 是空的，名单由后端的
 *    `skillList` 填（`listGenerateSkills` 的结果）。
 *
 * 采纳栏钉在底部、不随表单滚：生成完的东西不该因为上面表单长就滚出视野。
 */
export function generatePane(): string {
  return `<section class="pane" id="pane-generate">
  <div class="gen-body">

    <!-- ① 产出什么。选项与提示语由前端从后端那份常量填（JOB_LABEL / JOB_HINT），
         这里不写死六个 option——两处各写一遍，改文案时必然对不上。 -->
    <div class="gen-step">
      <div class="pane-head"><span>① 产出什么</span></div>
      <select id="genJob"></select>
      <div class="hint" id="genJobHint"></div>
    </div>

    <!-- ② 落在哪 -->
    <div class="gen-step">
      <div class="pane-head"><span>② 落在哪</span><span class="meta" id="genStageBadge"></span></div>
      <select id="genTarget"></select>
      <button class="composer-tool gen-manual" id="genManualBtn"><span class="caret">▸</span>手填路径</button>
      <input type="text" id="genManualPath" class="hidden" placeholder="工程内相对路径，如 .novelforge/plots/01-开端/05-新的一段.md">
      <div class="gen-check" id="genCheck"></div>
    </div>

    <!-- ③ 补充要求 -->
    <div class="gen-step">
      <div class="pane-head"><span>③ 补充要求</span><span class="meta">可留空</span></div>
      <textarea id="genAsk" rows="3" placeholder="留空就按上一层的产物照常生成。"></textarea>
    </div>

    <!-- ④ 目标字数：只对 job=manuscript 有意义，其余时候前端把整块摘掉。 -->
    <div class="gen-step hidden" id="genWordsStep">
      <div class="pane-head"><span>④ 目标字数</span><span class="meta">0 为不限</span></div>
      <div class="grid">
        <label class="field"><span>目标字数</span><input type="number" id="genWords" value="2000" min="0" step="100"></label>
      </div>
    </div>

    <!-- ⑤ skills。名单来自后端，前端一个名字都不写死。 -->
    <div class="gen-step">
      <div class="pane-head"><span>⑤ skills</span><span class="meta" id="genSkillCount"></span></div>
      <div class="hint">
        能交给创作模型的那些（工程里 <code>audience: generate</code> 且没被禁用的技能）。
        勾中的会整份进创作模型的上下文，也会占掉这一次的预算。
      </div>
      <div class="gen-skills" id="genSkills"></div>
    </div>

    <!-- ⑥ 用哪个模型 -->
    <div class="gen-step">
      <div class="pane-head"><span>⑥ 用哪个模型</span></div>
      <div class="grid">
        <label class="field"><span>模型</span><select id="genModel"></select></label>
        <label class="field"><span>思考深度</span><select id="genThinking"></select></label>
      </div>
      <!-- 实际解析到的那一个。不写清算到了谁，等于让作者在不知道用哪个模型的
           情况下按下花钱的按钮。 -->
      <div class="gen-resolved" id="genResolved"></div>
    </div>

    <!-- ⑦ 动作条 -->
    <div class="gen-run">
      <button class="primary" id="genRunBtn">生成</button>
      <button class="danger hidden" id="genStopBtn">停止</button>
      <span class="spacer"></span>
      <span class="meta" id="genCost">这一次会调一次模型</span>
    </div>

    <!-- ⑧ 输出 -->
    <div class="gen-out hidden" id="genOut">
      <div class="gen-out-head">
        <span class="gen-status" id="genStatus"><span class="dot"></span><span id="genStatusText"></span></span>
        <span class="spacer"></span>
        <button class="chip-btn" id="genCopyBtn">复制</button>
      </div>
      <details class="gen-fold hidden" id="genReasonFold">
        <summary id="genReasonSummary">思考过程</summary>
        <div class="gen-fold-body" id="genReasonBody"></div>
      </details>
      <details class="gen-fold hidden" id="genLayersFold">
        <summary id="genLayersSummary">装配明细</summary>
        <div class="gen-fold-body"><div class="gen-layers" id="genLayers"></div></div>
      </details>
      <!-- 可编辑：采纳前作者能改，采纳时按框里当下的文本重新解析。 -->
      <textarea class="gen-text" id="genText" spellcheck="false"></textarea>
      <div class="gen-shape" id="genShape"></div>
    </div>

    <div class="gen-out" id="genOutEmpty">
      <div class="gen-empty hint">
        填好上面几项，点「生成」。<br>
        产出会流在这里，<b>不会自动落盘</b>——写不写、写到哪，下面那一条你说了算。
      </div>
    </div>

  </div>

  <!-- ⑨ 采纳栏。有产出时才出现，钉在底部。 -->
  <div class="gen-adopt hidden" id="genAdopt">
    <div class="gen-adopt-where" id="genAdoptWhere"></div>
    <div class="actions">
      <button class="primary" id="genAdoptBtn">采纳并写入</button>
      <button class="secondary" id="genDiscardBtn">不采纳</button>
      <button class="chip-btn" id="genRerunBtn">用同样的参数重来</button>
    </div>
  </div>
</section>`;
}

/** 工程页：工具栏 + 长任务进度条 + 目录树。 */
export function projectPane(): string {
  return `<section class="pane" id="pane-project">
  <div class="project-toolbar" id="projectToolbar">
    <button class="chip-btn" data-action="newVolume">＋ 新建卷</button>
    <button class="chip-btn" data-action="newPlot">＋ 新建剧情段</button>
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
 * 设置页：服务商与模型、默认模型、高级设置（分档 / 任务档位 / 请求调度）、技能、上下文管理。
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
    <button class="settings-subtab" id="settingsTabSkills" data-settings-tab="skills" role="tab" aria-selected="false" aria-controls="settingsPanelSkills">技能</button>
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

    <div class="pane-head"><span>Agent</span></div>
    <div class="hint">
      对话页直接说话就是 Agent：它自己查资料、分几步做完一件事（在输入框里打 <b>/</b> 可以指定它按哪份技能做）。
      下面这一项只管 <b>它动手之前要不要先问你一句</b>——<b>覆盖已有内容永远会先让你逐行过目</b>，
      批量动作永远会先告诉你要调几次模型，三种模式完全一样，关不掉。
    </div>
    <div class="grid">
      <label class="field"><span>确认策略</span>
        <select id="setAgentPolicy">
          <option value="careful">谨慎 · 每次调模型、每次落盘都先问你一句</option>
          <option value="default">默认 · 查资料与生成自动跑，落盘前问你一句</option>
          <option value="bold">放手 · 除了覆盖已有内容，都不打断你</option>
        </select>
      </label>
    </div>

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
      <div class="hint">并发与重试只作用于工程页批量任务；对话页续写始终单请求、严格使用当前选中的模型。超时按「多久没收到数据」计，流式输出期间不会触发。</div>
      <div class="grid">
        <label class="field"><span>温度</span><input type="number" id="setTemperature" min="0" max="2" step="0.1"></label>
        <label class="field"><span>请求超时（毫秒）</span><input type="number" id="setRequestTimeoutMs" min="10000" step="10000"></label>
        <label class="field"><span>并发请求数</span><input type="number" id="setConcurrency" min="1" max="16"></label>
        <label class="field"><span>换模型重试次数</span><input type="number" id="setFallbackAttempts" min="0" max="5"></label>
      </div>

      <div class="pane-head"><span>调试</span></div>
      <div class="hint">
        出问题要提 issue、或者想弄清「它到底看到了什么」时才开。开着的时候，<b>每一次调模型的完整上下文</b>
        会原样存进 <code>.novelforge/sessions/&lt;会话 id&gt;.debug/</code>，日志里给出可复制的路径；
        会话文件里那些为了不撑爆而截短的字段（工具参数、返回、产出正文）也按更宽的上限保留。
        <b>这些文件里有你的正文与设定</b>，贴出去之前请自己看一眼。删除对话时它们会一起进回收站。
      </div>
      <div class="grid">
        <label class="field checkbox"><input type="checkbox" id="setDebug"><span>开启调试模式（会在工程里留下完整上下文文件）</span></label>
      </div>
    </div>
  </div>

  <div class="settings-panel" id="settingsPanelSkills" data-settings-panel="skills" role="tabpanel" aria-labelledby="settingsTabSkills">
    <div class="pane-head"><span>技能</span></div>
    <div class="hint">
      技能是「这类事该怎么做」的工作流说明——内置几份，也可以在工程的
      <code>.novelforge/skills/&lt;名字&gt;/SKILL.md</code> 里自己写。
      下面这一列管的是 <b>每一份让 agent 每轮看到多少</b>：
      <b>仅用户</b>（缺省）它看不见，你在输入框里打 <kbd>/</kbd> 呼出时整份正文才进那一轮；
      <b>仅标题</b> / <b>完整</b> 让它每轮看到名字（或名字加一句描述），自己判断要不要读——
      更容易选对，代价是那几行每一轮都要发一遍。<b>禁用</b> 两边都看不到。
    </div>
    <div id="skillList"></div>
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
