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
 * 从模板 .ts 里抠出 body，保证测试用的结构与真实渲染的一致。
 *
 * 找不到 <body> 就当场抛——模板形状变了必须早点发现，这正是它存在的意义。
 */
function extractBody(file) {
  const src = fs.readFileSync(file, 'utf8');
  // <body> 上带着 data-vscode-context / class 属性，不能按字面量找。
  const open = /<body[^>]*>/.exec(src);
  const end = src.indexOf('</body>');
  if (!open || end === -1) {
    throw new Error(`${path.basename(file)} 里找不到 <body>，测试需要同步更新`);
  }
  return src
    .slice(open.index + open[0].length, end)
    // 去掉 <script src>（模板串里是 ${asset(...)}），脚本我们手动注入。
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

/** 插件 webview 的 body。 */
function bodyHtml() {
  return extractBody(path.join(ROOT, 'src/shells/vscode/webviewHtml.ts'));
}

/** 独立版的 body（含 #wbEditor 等工作台结构）。 */
function standaloneBodyHtml() {
  // html.ts 里有 ${LOGO_SVG} / ${escapeHtml(...)} 之类的插值，测试只关心
  // 结构与 id，把插值统统抹平即可。
  return extractBody(path.join(ROOT, 'src/shells/standalone/html.ts')).replace(/\$\{[^}]*\}/g, '');
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

/** 一份章节流水线视图，字段与 `ChapterPipelineView` 一致。 */
const pipelineView = (extra) =>
  Object.assign(
    {
      chapterRelPath: 'chapters/012-夜入青云.md',
      order: 12,
      title: '夜入青云',
      plan: { relPath: '.novelforge/plans/012-夜入青云.md', filled: true, upstreamStale: false },
      scenes: [],
      manuscript: { words: 0, beatsStale: false },
      summary: { exists: false, stale: true },
      stage: 'scene',
      progress: { plan: 1, scene: 0, manuscript: 0, summary: 0 },
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
      stage: 'plan',
      title: '细纲 · 第 12 章《夜入青云》',
      relPath: '.novelforge/plans/012-夜入青云.md',
      sections: [{ key: '本章目标', text: '林昭成功进入青云宗' }],
    },
    extra
  );

/** 一份 `ViewState`。只填必需字段，其余给能过渲染的最小值。 */
const viewState = (extra) =>
  Object.assign(
    {
      initialized: true,
      chapters: [],
      nextOrder: 1,
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
 * 造一棵三层深的树，覆盖目录 / 章节 / 角色 / 空文件夹四种节点。
 *
 * 原脚本里是个函数声明（957 行），靠提升在 753 行先用后定义；拆开成多个文件后
 * 只能走共享 helper——它被 5 个目标文件的 20 处用到。
 */
function sampleTree() {
  return {
    initialized: true, title: '测试', author: '甲', chapterCount: 3, totalWords: 900, staleCount: 1,
    summarizedCount: 2,
    chaptersRoot: 'chapters', charactersRoot: '.novelforge/characters', loreRoot: '.novelforge/lore',
    globalSummaryThrough: 2, styleGuidePath: '.novelforge/style.md',
    outlinePath: '.novelforge/outline.md', globalSummaryPath: '.novelforge/summaries/global.md',
    chapters: [
      { kind: 'dir', label: '第一卷', relPath: 'chapters/第一卷', fileCount: 2, children: [
        { kind: 'dir', label: '深处', relPath: 'chapters/第一卷/深处', fileCount: 1, children: [
          { kind: 'chapter', order: 3, title: '夜访', relPath: 'chapters/第一卷/深处/003-夜访.md',
            wordCount: 300, stale: true, summaryPath: '',
            draftPath: 'drafts/第一卷/深处/003-夜访.md', hasDraft: false,
            // 细纲拆了场景、正文写了，但摘要还没跟上 → 待审阅。
            stage: 'review', upstreamStale: false,
            progress: { plan: 1, scene: 1, manuscript: 1, summary: 0 } },
        ] },
        { kind: 'chapter', order: 2, title: '入镇', relPath: 'chapters/第一卷/002-入镇.md',
          wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/002.md',
          draftPath: 'drafts/第一卷/002-入镇.md', hasDraft: false,
          // 场景拆了一半，且细纲的上游（全书大纲）改过。
          stage: 'scene', upstreamStale: true,
          progress: { plan: 1, scene: 0.5, manuscript: 0, summary: 1 } },
      ] },
      { kind: 'dir', label: '第二卷', relPath: 'chapters/第二卷', fileCount: 0, children: [] },
      { kind: 'chapter', order: 1, title: '楔子', relPath: 'chapters/001-楔子.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/001.md',
        draftPath: 'drafts/001-楔子.md', hasDraft: true,
        stage: 'done', upstreamStale: false,
        progress: { plan: 1, scene: 1, manuscript: 1, summary: 1 } },
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
    // 林昭出场三章、上次只更新到第 1 章 → 待更新 2 章；李叔从没在摘要里出现。
    castByCard: {
      '.novelforge/characters/林昭.md': {
        chapters: [1, 2, 3], detail: '第 1、2、3 章', updatedThrough: 1, pending: 2,
      },
      '.novelforge/characters/配角/李叔.md': {
        chapters: [], detail: '未在摘要中出现', updatedThrough: 0, pending: 0,
      },
    },
    cast: [
      { name: '客栈掌柜', aliases: ['掌柜'], chapters: [2, 3], detail: '第 2、3 章' },
      { name: '老周', aliases: [], chapters: [3], detail: '第 3 章' },
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
