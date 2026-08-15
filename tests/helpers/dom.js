/**
 * jsdom 测试台：把**构建产物**（`dist/media/*.js`）跑在真实 DOM 上。
 *
 * 迁自 `scripts/smoke-view.js` 的 19-235 行。只有 `tests/dom/` 下的用例用它。
 *
 * 跑的是产物而不是源码：产物是 IIFE 格式的 classic script，jsdom 的
 * `window.eval` 只吃得下这种。跑之前必须先 `node scripts/build-media.js`。
 *
 * 与原脚本的两处**有意不同**：
 * 1. 缺 jsdom 时不再 `process.exit(0)` 静默全绿，而是导出 `hasJsdom`，
 *    让各文件走 `describe(..., { skip: JSDOM_SKIP }, ...)`——跳过会出现在
 *    node:test 的 skipped 汇总里，看得见。
 * 2. 产物不存在时给一句人话，而不是让 ENOENT 的调用栈盖住真正的原因。
 */
const fs = require('fs');
const path = require('path');
const { loadModule } = require('./load');

const ROOT = path.join(__dirname, '..', '..');
/** 前端构建产物目录。与 scripts/build-media.js 的 outdir 同一处。 */
const MEDIA = path.join(ROOT, 'dist', 'media');

let JSDOM;
let hasJsdom = true;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  hasJsdom = false;
}

/** 传给 `describe` 的 skip 选项：缺 jsdom 时是一句说明，否则 false。 */
const JSDOM_SKIP = hasJsdom ? false : '未安装 jsdom（npm i -D jsdom）';

// ---------------------------------------------------------------- body 模板

/**
 * 从**渲染出来的**整页 HTML 里抠出 body。
 *
 * 从前这里是拿正则去模板源码里抠的，页面骨架收进 `src/shells/shared/panes.ts`
 * 之后那条路就断了：模板源码里剩下的是 `${chatPane(...)}` 这样的插值，
 * 抹掉插值等于抹掉整个页面。现在改成**执行模板函数**，测试因此比从前更严——
 * 跑的是壳真正会发给浏览器的那份 HTML。
 *
 * 找不到 <body> 就当场抛——模板形状变了必须早点发现，这正是它存在的意义。
 */
function extractBody(html, what) {
  // <body> 上带着 data-vscode-context / class 属性，不能按字面量找。
  const open = /<body[^>]*>/.exec(html);
  const end = html.indexOf('</body>');
  if (!open || end === -1) {
    throw new Error(`${what} 渲染出来的 HTML 里找不到 <body>，测试需要同步更新`);
  }
  return (
    html
      .slice(open.index + open[0].length, end)
      // 去掉 <script src>，脚本我们手动注入（跑的是 dist/media/ 的产物）。
      .replace(/<script[\s\S]*?<\/script>/g, '')
  );
}

/** 插件 webview 的 body。 */
function bodyHtml() {
  const { renderHtml } = loadModule('src/shells/vscode/webviewHtml.ts');
  // asset / cspSource 由宿主注入（真实实现在 shells/vscode/webview.ts），
  // 这里给个假的就够——脚本与样式都不从这条路加载。
  const html = renderHtml({ asset: (name) => `/${name}`, cspSource: 'test:' });
  return extractBody(html, 'webviewHtml.renderHtml');
}

/** 独立版的 body（含 #wbEditor 等工作台结构）。 */
function standaloneBodyHtml() {
  const { standalonePage } = loadModule('src/shells/standalone/page.ts');
  return extractBody(standalonePage('/tmp/示例工程'), 'standalonePage');
}

// ---------------------------------------------------------------- 挂载

/** jsdom 缺的那些零碎，按名字取用。 */
const SHIMS = {
  clipboard(window) {
    window.navigator.clipboard = { writeText: () => Promise.resolve() };
  },
  scrollIntoView(window) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  },
  pointerCapture(window) {
    window.HTMLElement.prototype.setPointerCapture = () => {};
    window.HTMLElement.prototype.releasePointerCapture = () => {};
  },
  confirm(window) {
    window.confirm = () => true;
  },
};

function readArtifact(name) {
  const file = path.join(MEDIA, name);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少构建产物 ${path.relative(ROOT, file)}，先跑 node scripts/build-media.js`);
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * 起一个装好前端产物的环境，返回操作句柄。
 *
 * 合并了原脚本的四个近乎重复的挂载函数（mount / mountEditor / mountExplorer
 * 与 772 行的行内变体）。它们的差别只有三处：body 模板、注入哪些 js、
 * 补哪些 jsdom 缺的 API；`acquireVsCodeApi` 桩与 post() 消息泵四份完全一样。
 *
 * @param {object} [opts]
 * @param {'webview'|'standalone'} [opts.body] 用哪份 body 模板
 * @param {string[]} [opts.scripts] 注入哪些产物（按顺序 eval）
 * @param {Array<keyof SHIMS>} [opts.shims] 补哪些 jsdom 缺的 API
 */
function mount({ body = 'webview', scripts = ['view.js'], shims = ['clipboard', 'scrollIntoView'] } = {}) {
  if (!hasJsdom) throw new Error('未安装 jsdom');

  // 独立版的 body 上带 class="workbench"，editor.js / explorer.js 认这个。
  const html =
    body === 'standalone'
      ? `<!DOCTYPE html><html><body class="workbench">${standaloneBodyHtml()}</body></html>`
      : `<!DOCTYPE html><html><body>${bodyHtml()}</body></html>`;

  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });

  for (const name of shims) SHIMS[name](window);
  for (const name of scripts) window.eval(readArtifact(name));

  const doc = window.document;
  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));

  // ---- 对话气泡（view.js）
  const bubble = (id) => doc.querySelector(`[data-turn="${id}"]`);
  const bodyOf = (id) => {
    const node = bubble(id);
    return node ? node.querySelector('.msg-body') : null;
  };

  // ---- 内置编辑器（editor.js）：页面上的两块编辑区
  const panes = () => [...doc.querySelectorAll('.wb-editor')];

  // ---- 资源管理器（explorer.js）
  const rows = () => [...doc.querySelectorAll('#filesBody .fx-row')];
  /** 每行的名字（跳过图标与大小两列，它们各有各的断言）。 */
  const names = () =>
    rows().map((r) => {
      const name = r.querySelector('.fx-name');
      return (name ? name.textContent : r.textContent).trim();
    });
  const click = (row) => row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- 原脚本里每个小节各抄一遍的小工具
  const clickEl = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const rightClick = (node, x = 40, y = 60) => {
    node.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
    return doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const pick = (menu, label) =>
    clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent === label));
  const last = (type) => [...sent].reverse().find((m) => m.type === type);
  /** 收起当前打开的菜单（点一下 body），免得它挂在那儿影响后续断言。 */
  const closeMenu = () => doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  return {
    window, doc, sent, post,
    bubble, bodyOf,
    panes,
    rows, names, click,
    clickEl, rightClick, itemsOf, pick, last, closeMenu,
  };
}

// ---------------------------------------------------------------- fixture

const turn = (id, role, content, extra) =>
  Object.assign({ id, role, content, at: new Date(0).toISOString() }, extra);

/**
 * 一个空会话。形状与后端 `serializeSession` 一致——前端把会话当唯一真相
 * （面包屑、能力按钮、目标下拉全读它），缺字段会当场炸，而那正是我们要的：
 * 协议对不上就该早点发现。
 */
const emptySession = (extra) =>
  Object.assign(
    { id: 's', title: '', target: { kind: 'outline' }, stage: 'outline', capability: 'discuss', turns: [] },
    extra
  );

/** 一份剧情段流水线视图，字段与 `PlotPipelineView` 一致。 */
const pipelineView = (extra) =>
  Object.assign(
    {
      plotRelPath: '.novelforge/plots/012-夜入青云.md',
      no: 12,
      title: '夜入青云',
      plot: { relPath: '.novelforge/plots/012-夜入青云.md', filled: true, upstreamStale: false },
      scenes: [],
      manuscript: { relPath: '.novelforge/manuscripts/012-夜入青云.md', words: 0, beatsStale: false },
      summary: { exists: false, stale: true },
      stage: 'scene',
      progress: { plot: 1, scene: 0, manuscript: 0, summary: 0 },
    },
    extra
  );

const sceneView = (no, title, extra) =>
  Object.assign(
    {
      no,
      title,
      relPath: `.novelforge/scenes/012-夜入青云/0${no}-${title}.md`,
      detail: `${no}. ${title}`,
      status: 'ready',
      ready: true,
      upstreamStale: false,
    },
    extra
  );

/** 一份工作区卡视图，字段与 `WorkbenchView` 一致。 */
const workbenchView = (extra) =>
  Object.assign(
    {
      stage: 'plot',
      title: '剧情 · 第 12 段《夜入青云》',
      relPath: '.novelforge/plots/012-夜入青云.md',
      sections: [{ key: '目标', text: '林昭成功进入青云宗' }],
    },
    extra
  );

/** 一份 `ViewState`。只填必需字段，其余给能过渲染的最小值。 */
const viewState = (extra) =>
  Object.assign(
    {
      initialized: true,
      // 创作目标下拉列的是**剧情段**，不是 chapters/ 里的发布章节。
      plots: [],
      nextNo: 1,
      staleCount: 0,
      model: 'glm/glm-4-plus',
      modelLabel: '智谱 GLM · glm-4-plus',
      models: [{ ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: '智谱 GLM' }],
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    extra
  );

/**
 * 造一棵工程页快照：扁平的剧情组 + 三层深的章节树 + 角色 + 空文件夹。
 *
 * **两组两种职责**：剧情是流水线的落点（徽章、进度、⟳ 都在那一组），
 * 章节是作者切好的发布区（纯文件列表，工具不分析它的内容）。
 * 它被 5 个目标文件的 20 处用到。
 */
function sampleTree() {
  return {
    initialized: true, title: '测试', author: '甲',
    plotCount: 3, chapterCount: 3, totalWords: 900, staleCount: 1,
    summarizedCount: 2, bookStage: 'working',
    plotsRoot: '.novelforge/plots',
    chaptersRoot: 'chapters', charactersRoot: '.novelforge/characters', loreRoot: '.novelforge/lore',
    globalSummaryThrough: 2, styleGuidePath: '.novelforge/style.md',
    outlinePath: '.novelforge/outline.md', globalSummaryPath: '.novelforge/summaries/global.md',
    // 剧情组是扁平的：`plots/` 本身扁平，顺序即写作顺序。
    plots: [
      { no: 1, title: '楔子', relPath: '.novelforge/plots/001-楔子.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/001-楔子.md',
        manuscriptPath: '.novelforge/manuscripts/001-楔子.md',
        stage: 'done', upstreamStale: false,
        progress: { plot: 1, scene: 1, manuscript: 1, summary: 1 } },
      { no: 2, title: '入镇', relPath: '.novelforge/plots/002-入镇.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/002-入镇.md',
        manuscriptPath: '.novelforge/manuscripts/002-入镇.md',
        // 场景拆了一半，且剧情的上游（全书大纲）改过。
        stage: 'scene', upstreamStale: true,
        progress: { plot: 1, scene: 0.5, manuscript: 0, summary: 1 } },
      { no: 3, title: '夜访', relPath: '.novelforge/plots/003-夜访.md',
        wordCount: 300, stale: true, summaryPath: '',
        manuscriptPath: '.novelforge/manuscripts/003-夜访.md',
        // 场景拆了、正文写了，但摘要还没跟上 → 待审阅。
        stage: 'review', upstreamStale: false,
        progress: { plot: 1, scene: 1, manuscript: 1, summary: 0 } },
    ],
    // 章节区是**纯文件**：没有 stage / progress / upstreamStale / stale / summaryPath。
    // 仍保留三层深度——分卷收纳是作者常用的整理方式，缩进与折叠要测得到。
    chapters: [
      { kind: 'dir', label: '第一卷', relPath: 'chapters/第一卷', fileCount: 2, children: [
        { kind: 'dir', label: '深处', relPath: 'chapters/第一卷/深处', fileCount: 1, children: [
          { kind: 'chapter', order: 3, title: '夜访', relPath: 'chapters/第一卷/深处/003-夜访.md',
            wordCount: 300, draftPath: 'drafts/第一卷/深处/003-夜访.md', hasDraft: false },
        ] },
        { kind: 'chapter', order: 2, title: '入镇', relPath: 'chapters/第一卷/002-入镇.md',
          wordCount: 300, draftPath: 'drafts/第一卷/002-入镇.md', hasDraft: false },
      ] },
      { kind: 'dir', label: '第二卷', relPath: 'chapters/第二卷', fileCount: 0, children: [] },
      { kind: 'chapter', order: 1, title: '楔子', relPath: 'chapters/001-楔子.md',
        wordCount: 300, draftPath: 'drafts/001-楔子.md', hasDraft: true },
    ],
    characters: [
      { kind: 'dir', label: '配角', relPath: '.novelforge/characters/配角', fileCount: 1, children: [
        { kind: 'file', label: '李叔', relPath: '.novelforge/characters/配角/李叔.md', detail: '' },
      ] },
      { kind: 'file', label: '林昭', relPath: '.novelforge/characters/林昭.md', detail: '主角' },
    ],
    lore: [],
    summaryCount: 3,
    // 正常工程这里是空对象——只有出错的目标才有记录。
    failures: {},
    // 林昭出场三段、上次只更新到第 1 段 → 待更新 2 段；李叔从没在摘要里出现。
    castByCard: {
      '.novelforge/characters/林昭.md': {
        plots: [1, 2, 3], detail: '第 1、2、3 段', updatedThrough: 1, pending: 2,
      },
      '.novelforge/characters/配角/李叔.md': {
        plots: [], detail: '未在摘要中出现', updatedThrough: 0, pending: 0,
      },
    },
    cast: [
      { name: '客栈掌柜', aliases: ['掌柜'], plots: [2, 3], detail: '第 2、3 段' },
      { name: '老周', aliases: [], plots: [3], detail: '第 3 段' },
    ],
  };
}

/** 一份编辑器文件负载。 */
const file = (p, text, extra) =>
  Object.assign({ path: p, name: p.split('/').pop(), text, hash: `h-${p}`, bytes: text.length }, extra);

/** 造一份 DirListing。`spec` 形如 { 'a': 'dir', 'b.md': 'file' }。 */
const listing = (relPath, spec, extra) =>
  Object.assign(
    {
      relPath,
      truncated: 0,
      entries: Object.entries(spec).map(([name, kind]) => ({
        kind: kind === 'dir' ? 'dir' : 'file',
        name,
        relPath: relPath ? `${relPath}/${name}` : name,
        editable: kind === 'file',
        bytes: kind === 'dir' ? 0 : 100,
        modified: 0,
      })),
    },
    extra
  );

module.exports = {
  ROOT, MEDIA,
  hasJsdom, JSDOM_SKIP,
  extractBody, bodyHtml, standaloneBodyHtml,
  mount,
  turn, emptySession, pipelineView, sceneView, workbenchView, viewState, sampleTree,
  file, listing,
};
