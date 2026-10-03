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
  return extractBody(standalonePage(), 'standalonePage');
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
 * @param {boolean} [opts.empty] 独立版空窗口（`no-workspace`）。默认按已打开工程挂，
 *   这样创作页 / 编辑器 / 资源管理器用例不必每条都先推一条 `workspaces`。
 */
function mount({
  body = 'webview',
  scripts = ['view.js'],
  shims = ['clipboard', 'scrollIntoView'],
  empty = false,
} = {}) {
  if (!hasJsdom) throw new Error('未安装 jsdom');

  // 独立版的 body 上带 class="workbench"，editor.js / explorer.js 认这个。
  const html =
    body === 'standalone'
      ? `<!DOCTYPE html><html><body class="workbench${empty ? ' no-workspace' : ''}">${standaloneBodyHtml()}</body></html>`
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
  // cancelable: true——真实的右键事件是可取消的，菜单引擎正是靠
  // preventDefault() 压住原生菜单，合成事件不带这个就测不到那件事。
  const rightClick = (node, x = 40, y = 60) => {
    node.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    );
    return doc.querySelector('.ctx-menu');
  };
  /** 触控板双指点击在部分环境里只发 auxclick（副键 = button 2）。 */
  const auxClick = (node, x = 40, y = 60) => {
    const ev = new window.MouseEvent('auxclick', {
      bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
    });
    node.dispatchEvent(ev);
    return ev;
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
    clickEl, rightClick, auxClick, itemsOf, pick, last, closeMenu,
  };
}

// ---------------------------------------------------------------- fixture

const turn = (id, role, content, extra) =>
  Object.assign({ id, role, content, at: new Date(0).toISOString() }, extra);

/**
 * 一轮里排下来的段（外部 agent 经 MCP 调工具、带工具条的回放）。形状与后端 `serializeTurn` 归一之后的一致——
 * **界面只认这一个字段**（`toolCalls` 是改成段之前的形状，后端读老会话时就归一
 * 掉了，前端不认它）。
 *
 * ```js
 * turn('a1', 'assistant', '排好了。', {
 *   segments: [toolSeg({ callId: 'c1', name: 'read', … }), textSeg('排好了。')],
 * })
 * ```
 */
const textSeg = (text) => ({ kind: 'text', text });
const toolSeg = (call) => ({ kind: 'tool', call });

/**
 * 一个空会话。形状与后端 `serializeSession` 一致——前端把会话当唯一真相
 * （面包屑、能力按钮、目标下拉全读它），缺字段会当场炸，而那正是我们要的：
 * 协议对不上就该早点发现。
 */
const emptySession = (extra) =>
  Object.assign(
    {
      id: 's',
      title: '',
      target: { kind: 'outline' },
      stage: 'outline',
      capability: 'discuss',
      // 思考深度也在会话上（后端 serializeSession 恒给，缺省 off）。
      thinking: 'off',
      turns: [],
    },
    extra
  );

/**
 * 一份单章流水线视图，字段与 `PlotPipelineView` 一致。
 *
 * 缺省是「细纲排好了、正文还没写」的第 12 章：细纲号 = 章号，所以一章只有
 * 细纲与正文两面（`plot` / `chapter`），没有卷、也没有中转站那一份。
 * `chapter` 整块换掉时记得带全五个字段——前端直接读 `chapter.upstreamStale`。
 */
const pipelineView = (extra) =>
  Object.assign(
    {
      plotRelPath: '.novelforge/plots/012-夜入青云.md',
      no: 12,
      title: '夜入青云',
      plot: {
        relPath: '.novelforge/plots/012-夜入青云.md',
        exists: true,
        filled: true,
        upstreamStale: false,
      },
      // 同号的正文。还没写时 relPath 是空串；目标字数取细纲的 targetWords。
      chapter: { exists: false, relPath: '', words: 0, targetWords: 3000, upstreamStale: false },
      summary: { exists: false, stale: true },
      stage: 'manuscript',
      progress: { plot: 1, manuscript: 0, summary: 0 },
    },
    extra
  );

/** 一份工作区卡视图，字段与 `WorkbenchView` 一致。缺省是第 12 章细纲那一层。 */
const workbenchView = (extra) =>
  Object.assign(
    {
      stage: 'plot',
      title: '细纲 · 第 12 章《夜入青云》',
      relPath: '.novelforge/plots/012-夜入青云.md',
      sections: [{ key: '本章目的', text: '林昭成功进入青云宗' }],
    },
    extra
  );

/** 一份 `ViewState`。只填必需字段，其余给能过渲染的最小值。 */
const viewState = (extra) =>
  Object.assign(
    {
      initialized: true,
      // 创作目标下拉的候选：**每个章号一行**，`{ no, label, title, wordCount, relPath }`，
      // 说法（label）由后端给。
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
 * 造一棵工程页快照：「故事架构」五行 + 一个章号一行的章节列表 + 角色树 + 空文件夹。
 *
 * 形状与后端 `buildProjectTree` 一致（`src/core/views/projectView.ts`）：细纲号 = 章号，
 * 所以细纲与正文是同一行的两面——`relPath` 是主路径（有正文就是正文，否则是细纲），
 * `plotPath` 是细纲**应在**的位置（`plotExists` 说它在不在），`chapterPath` 没有正文时是空串。
 *
 * 五种样本各一行，覆盖单章状态机的四档加「老工程里没有细纲的章」：
 *
 * | 章 | 细纲 | 正文 | 摘要 | stage |
 * |---|---|---|---|---|
 * | 1《楔子》 | 有 | 300 字，带草稿 | 新鲜 | done |
 * | 2《入镇》 | **没有**（老工程） | 2980 / 3000 | 过期 | finalize |
 * | 3《夜访》 | 有 | 300 字 | 新鲜 | done |
 * | 4《北行》 | 有，大纲那一节后来改过（⟳） | 没写 | — | manuscript |
 * | 5《赤星》 | 只有骨架 | 没写 | — | plot |
 *
 * `nextChapterNo` 是 4：从第 1 章起连续有正文的最大章号 + 1。**只有这一行**挂
 * 「去写这一章」。故事架构四件填了三件、外加大纲，所以组标题是 4/5。
 */
function sampleTree() {
  return {
    initialized: true, title: '测试', author: '甲',
    plotCount: 5, chapterCount: 3, totalWords: 3580, staleCount: 1,
    summarizedCount: 2, bookStage: 'writing', nextChapterNo: 4,
    // 一句话、拆细纲两个弹窗的默认值。第 1、3、4 章排过细纲，大纲覆盖到第 20 章。
    book: {
      idea: '一个从火里活下来的人回到起火的地方。', totalChapters: 30, wordsPerChapter: 400,
      configHasContent: true, outlineCoverage: 20, plotFilledNos: [1, 3, 4],
    },
    plotsRoot: '.novelforge/plots',
    chaptersRoot: 'chapters', charactersRoot: '.novelforge/characters', loreRoot: '.novelforge/lore',
    globalSummaryThrough: 2, styleGuidePath: '.novelforge/style.md',
    outlinePath: '.novelforge/outline.md', globalSummaryPath: '.novelforge/summaries/global.md',
    // 叙事线（七期）：排过 4 条，一条已收，一条过了回收章还开着。
    threadsPath: '.novelforge/threads.md',
    threads: { exists: true, total: 4, open: 3, closed: 1, overdue: 1 },
    // 故事架构：四件文档 + 情节大纲，顺序即生成顺序。世界观还没写。
    // 角色图谱没有自己的文件，relPath 给的是角色目录。
    architecture: [
      { key: 'config', label: '小说配置', relPath: '.novelforge/config.md', filled: true, detail: '' },
      { key: 'premise', label: '故事前提', relPath: '.novelforge/premise.md', filled: true, detail: '' },
      { key: 'characters', label: '角色图谱', relPath: '.novelforge/characters', filled: true, detail: '2 人' },
      { key: 'world', label: '世界观', relPath: '.novelforge/world.md', filled: false, detail: '待生成' },
      { key: 'outline', label: '情节大纲', relPath: '.novelforge/outline.md', filled: true, detail: '覆盖到第 20 章' },
    ],
    // 章节列表是扁平的，一个章号一行，升序。
    plots: [
      // 第 1 章：写完且定稿过，摘要新鲜，还带一份草稿。
      { no: 1, label: '第 1 章《楔子》', title: '楔子',
        relPath: 'chapters/001-楔子.md',
        plotPath: '.novelforge/plots/001-楔子.md', plotExists: true,
        chapterPath: 'chapters/001-楔子.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/001-楔子.md',
        stage: 'done', upstreamStale: false,
        draftPath: 'drafts/001-楔子.md', hasDraft: true,
        progress: { plot: 1, manuscript: 1, summary: 1 } },
      // 第 2 章：**老工程里的章**——只有正文、没有细纲（plotPath 是它应在的位置）。
      // 写够了目标字数、摘要过期 → 待定稿。
      { no: 2, label: '第 2 章《入镇》', title: '入镇',
        relPath: 'chapters/002-入镇.md',
        plotPath: '.novelforge/plots/002-入镇.md', plotExists: false,
        chapterPath: 'chapters/002-入镇.md',
        wordCount: 2980, targetWords: 3000, stale: true, summaryPath: '.novelforge/summaries/002-入镇.md',
        stage: 'finalize', upstreamStale: false,
        draftPath: 'drafts/002-入镇.md', hasDraft: false,
        progress: { plot: 0, manuscript: 1, summary: 0 } },
      // 第 3 章：写完且定稿过。
      { no: 3, label: '第 3 章《夜访》', title: '夜访',
        relPath: 'chapters/003-夜访.md',
        plotPath: '.novelforge/plots/003-夜访.md', plotExists: true,
        chapterPath: 'chapters/003-夜访.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/003-夜访.md',
        stage: 'done', upstreamStale: false,
        draftPath: '', hasDraft: false,
        progress: { plot: 1, manuscript: 1, summary: 1 } },
      // 第 4 章：细纲排好了、正文还没写（目标 3000 字）；情节大纲里覆盖它的那一节
      // 在细纲之后改过（⟳）。它就是 nextChapterNo——主路径因此是细纲。
      { no: 4, label: '第 4 章《北行》', title: '北行',
        relPath: '.novelforge/plots/004-北行.md',
        plotPath: '.novelforge/plots/004-北行.md', plotExists: true,
        chapterPath: '',
        wordCount: 0, targetWords: 3000, stale: false, summaryPath: '',
        stage: 'manuscript', upstreamStale: true,
        draftPath: '', hasDraft: false,
        progress: { plot: 1, manuscript: 0, summary: 0 } },
      // 第 5 章：细纲只有一个骨架（「关键事件」是空的）→ 待写细纲。
      { no: 5, label: '第 5 章《赤星》', title: '赤星',
        relPath: '.novelforge/plots/005-赤星.md',
        plotPath: '.novelforge/plots/005-赤星.md', plotExists: true,
        chapterPath: '',
        wordCount: 0, stale: false, summaryPath: '',
        stage: 'plot', upstreamStale: false,
        draftPath: '', hasDraft: false,
        progress: { plot: 0, manuscript: 0, summary: 0 } },
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
    castConflicts: [],
    // 林昭出场三章、上次只更新到第 1 章 → 待更新 2 章；李叔从没在摘要里出现。
    castByCard: {
      '.novelforge/characters/林昭.md': {
        plots: [1, 2, 3], detail: '第 1、2、3 章', updatedThrough: 1, pending: 2,
      },
      '.novelforge/characters/配角/李叔.md': {
        plots: [], detail: '未在摘要中出现', updatedThrough: 0, pending: 0,
      },
    },
    cast: [
      { name: '客栈掌柜', aliases: ['掌柜'], plots: [2, 3], detail: '第 2、3 章' },
      { name: '老周', aliases: [], plots: [3], detail: '第 3 章' },
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
  turn, textSeg, toolSeg, emptySession, pipelineView, workbenchView, viewState, sampleTree,
  file, listing,
};
