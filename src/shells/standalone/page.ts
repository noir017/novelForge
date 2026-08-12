import * as path from 'node:path';
import {
  chatPane,
  escapeHtml,
  filesPane,
  historyPane,
  logsPane,
  projectPane,
  providerModal,
  settingsPane,
  tabbar,
  toastSlot,
} from '../shared/panes';

/**
 * 独立版的页面。
 *
 * pane 的 DOM 全部来自 [../shared/panes.ts](../shared/panes.ts)，与插件壳同一份；
 * 这里只剩**布局**——一套 VS Code 式工作台：标题栏 + 活动栏 + 侧栏 + 内置编辑器。
 * 布局本来就该按宿主分叉，内容不该。
 *
 * 这个模块刻意不牵进内嵌资源表（那在 [assets.ts](assets.ts)）：页面拼装是纯字符串
 * 活儿，不该因为要渲染一段 HTML 就依赖一个几十 MB 的生成文件。
 */

const LOGO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19v18H6.5A2.5 2.5 0 0 0 4 22z"/>' +
  '<path d="M8 6.5h7M8 10h7M8 13.5h4"/></svg>';

export function standalonePage(root?: string): string {
  const projectName = root ? path.basename(path.resolve(root)) || root : '';
  // 有内置编辑器、但取不到原生编辑器选区（「加入选区」在这里是粘贴框），
  // 也没有原生设置界面可跳——三个能力位就是这个壳与插件壳的全部界面差异。
  const caps = { builtinEditor: true, selectionFromEditor: false, nativeSettings: false };
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
${tabbar([
  { tab: 'chat', label: '对话', icon: '✎' },
  { tab: 'project', label: '工程', icon: '❐', dotId: 'projectStaleDot' },
  { tab: 'files', label: '文件', icon: '🗀' },
  { tab: 'history', label: '历史', icon: '◷' },
  { tab: 'logs', label: '日志', icon: '☰', dotId: 'logsErrorDot', dotClass: 'err' },
  { tab: 'settings', label: '设置', icon: '⚙' },
])}

  <!-- ---------------------------------------------------------- 侧栏 -->
  <div class="wb-side" id="wbSide">

${chatPane(caps)}

${projectPane()}

<!-- 文件页：插件形态由 VS Code 自己的资源管理器承担，那边不装配这一块。 -->
${filesPane()}

${historyPane()}

${logsPane()}

${settingsPane(caps)}
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

${providerModal()}

${toastSlot()}
<script src="/media/bridge.js"></script>
<script src="/media/view.js"></script>
<script src="/media/editor.js"></script>
<script src="/media/explorer.js"></script>
</body>
</html>`;
}
