/**
 * 用真实 DOM（jsdom）跑真正的前端代码，验证对话气泡、工程页、右键菜单、
 * 摘要浮窗、内置编辑器与资源管理器的行为。
 *
 * 这是唯一能覆盖前端的测试——它们是纯浏览器脚本，其他 smoke 都碰不到。
 *
 * **跑的是构建产物**（`dist/media/view.js` 等，classic script，jsdom 的
 * `window.eval` 只吃得下这种），源码在 `media/src/`。`npm run smoke` 的
 * presmoke 会先构建；单独跑本文件前请先 `npm run media`，否则测的是
 * 上一次的产物。
 *
 * 用法：node scripts/smoke-view.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** 前端构建产物目录。与 scripts/build-media.js 的 outdir 同一处。 */
const MEDIA = path.join(ROOT, 'dist', 'media');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('  · 跳过：未安装 jsdom（npm i -D jsdom）');
  process.exit(0);
}

/** 从 webviewHtml.ts 里抠出 body，保证测试用的结构与真实渲染的一致。 */
function bodyHtml() {
  return extractBody(path.join(ROOT, 'src/vscode/webviewHtml.ts'));
}

/** 独立版的 body（含 #wbEditor 等工作台结构），给 editor.js 用。 */
function standaloneBodyHtml() {
  // html.ts 里有 ${LOGO_SVG} / ${escapeHtml(...)} 之类的插值，测试只关心
  // 结构与 id，把插值统统抹平即可。
  return extractBody(path.join(ROOT, 'src/standalone/html.ts')).replace(/\$\{[^}]*\}/g, '');
}

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

/** 起一个装好 view.js 的 webview 环境，返回操作句柄。 */
function mount() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml()}</body></html>`, {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  // view.js 里用到但 jsdom 没有的零碎。
  window.navigator.clipboard = { writeText: () => Promise.resolve() };
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.eval(fs.readFileSync(path.join(MEDIA, 'view.js'), 'utf8'));

  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  const bubble = (id) => window.document.querySelector(`[data-turn="${id}"]`);
  const bodyOf = (id) => {
    const node = bubble(id);
    return node ? node.querySelector('.msg-body') : null;
  };
  return { window, doc: window.document, sent, post, bubble, bodyOf };
}

const turn = (id, role, content, extra) =>
  Object.assign({ id, role, content, at: new Date(0).toISOString() }, extra);

/**
 * 起一个装好 editor.js 的独立版环境。
 *
 * 与 mount() 分开：editor.js 只在有 `#wbEditor` 时才跑，插件形态的 body 里
 * 没有那块 DOM，它会直接退出——所以覆盖它必须用 html.ts 的结构。
 */
function mountEditor() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body class="workbench">${standaloneBodyHtml()}</body></html>`, {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  // jsdom 没有 localStorage 之外的这些零碎。
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.confirm = () => true;

  window.eval(fs.readFileSync(path.join(MEDIA, 'editor.js'), 'utf8'));

  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  const file = (p, text, extra) =>
    Object.assign({ path: p, name: p.split('/').pop(), text, hash: `h-${p}`, bytes: text.length }, extra);
  /** 页面上的两块编辑区（主区固定 id，草稿区靠 class 找）。 */
  const panes = () => [...window.document.querySelectorAll('.wb-editor')];
  return { window, doc: window.document, sent, post, file, panes };
}

/**
 * 起一个装好 explorer.js 的独立版环境（资源管理器）。
 *
 * 与 mountEditor 同理：explorer.js 只在有 `#filesBody` 时才跑。
 * view.js 也一起装上——右键菜单引擎在那边，`window.__nfContextMenu`
 * 是两个文件之间的唯一接口，测试要覆盖到它真的被接上了。
 */
function mountExplorer() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body class="workbench">${standaloneBodyHtml()}</body></html>`, {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.navigator.clipboard = { writeText: () => Promise.resolve() };
  window.confirm = () => true;

  window.eval(fs.readFileSync(path.join(MEDIA, 'view.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(MEDIA, 'editor.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(MEDIA, 'explorer.js'), 'utf8'));

  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  const rows = () => [...window.document.querySelectorAll('#filesBody .fx-row')];
  /** 每行的名字（跳过图标与大小两列，它们各有各的断言）。 */
  const names = () =>
    rows().map((r) => {
      const name = r.querySelector('.fx-name');
      return (name ? name.textContent : r.textContent).trim();
    });
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
  const click = (row) => row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return { window, doc: window.document, sent, post, rows, names, listing, click };
}

/** 收起当前打开的菜单（点一下 body），免得它挂在那儿影响后续断言。 */
function closeAnyMenu(ui) {
  ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
}

// ---------------------------------------------------------------- 流式输出

console.log('\n== 流式输出 ==');
{
  const ui = mount();
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
  // 控制器的真实顺序：busy=true，然后插一条空回复挂流式内容。
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });

  check('先出现一个空的回复气泡', ui.bodyOf('a1') && ui.bodyOf('a1').textContent === '');

  ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
  check('第一个 delta 立刻显示', ui.bodyOf('a1').textContent === '第一段。',
    JSON.stringify(ui.bodyOf('a1').textContent));

  ui.post({ type: 'delta', turnId: 'a1', text: '第二段。' });
  ui.post({ type: 'delta', turnId: 'a1', text: '第三段。' });
  check('后续 delta 逐段累加', ui.bodyOf('a1').textContent === '第一段。第二段。第三段。',
    JSON.stringify(ui.bodyOf('a1').textContent));
  check('流式时带 streaming 标记（显示光标）', ui.bubble('a1').classList.contains('streaming'));

  // 生成中不能改：contentEditable 会被后续 delta 冲掉光标，
  // 改到一半的内容也会被 turnDone 的整体重建覆盖。
  check('生成中不可编辑', ui.bodyOf('a1').getAttribute('contenteditable') !== 'true',
    String(ui.bodyOf('a1').getAttribute('contenteditable')));

  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '第一段。第二段。第三段。') });
  ui.post({ type: 'busy', value: false });
  check('结束后内容完整', ui.bodyOf('a1').textContent === '第一段。第二段。第三段。');
  check('结束后不再显示流式光标', !ui.bubble('a1').classList.contains('streaming'));
  check('结束后可以就地编辑', ui.bodyOf('a1').getAttribute('contenteditable') === 'true');

  // 上一轮的 streaming 状态不能粘在下一轮上。
  ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '另一条') });
  check('新一轮回复默认可编辑', ui.bodyOf('a2').getAttribute('contenteditable') === 'true');
}

// ---------------------------------------------------------------- 中断与报错

console.log('\n== 中断与报错 ==');
{
  const ui = mount();
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  ui.post({ type: 'delta', turnId: 'a1', text: '写到一半' });
  // 用户点「停止」：控制器带 interrupted 收尾，busy 落回 false。
  ui.post({ type: 'busy', value: false });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '写到一半', { interrupted: true }) });
  check('中断后保留已生成的内容', ui.bodyOf('a1').textContent === '写到一半');
  check('中断后可编辑', ui.bodyOf('a1').getAttribute('contenteditable') === 'true');
  check('中断后不再显示流式光标', !ui.bubble('a1').classList.contains('streaming'));

  ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '', { error: '连接失败' }) });
  check('报错气泡显示错误文案', ui.bodyOf('a2').textContent === '连接失败');
  check('报错气泡不可编辑', ui.bodyOf('a2').getAttribute('contenteditable') !== 'true');
}

// ---------------------------------------------------------------- ... 菜单

console.log('\n== 气泡右上角的 ... 菜单 ==');
{
  const ui = mount();
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '正文') });

  const menuBtn = (id) => ui.bubble(id).querySelector('.msg-menu-btn');
  check('用户气泡有 ... 按钮', !!menuBtn('u1'));
  check('回复气泡有 ... 按钮', !!menuBtn('a1'));
  check('... 按钮在气泡头部（右上角）',
    menuBtn('a1').closest('.msg-head') !== null);

  // 冗余的行内按钮应该没了。
  const linkTexts = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions button')].map((b) => b.textContent);
  check('行内不再有「删除」', !linkTexts('a1').includes('删除'), JSON.stringify(linkTexts('a1')));
  check('行内不再有「重新生成」', !linkTexts('u1').includes('重新生成'), JSON.stringify(linkTexts('u1')));
  // 采纳/复制是常用动作，仍留在行内。
  check('「采纳写入」仍在行内', linkTexts('a1').includes('采纳写入'), JSON.stringify(linkTexts('a1')));

  check('菜单默认不显示', !ui.doc.querySelector('.msg-menu'));
  menuBtn('u1').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const menu = ui.doc.querySelector('.msg-menu');
  check('点击后弹出菜单', !!menu);
  const items = menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent) : [];
  check('用户消息菜单含「重新生成」与「删除」',
    items.includes('重新生成') && items.includes('删除'), JSON.stringify(items));

  // 点「删除」应发出 deleteTurn。
  menu.querySelector('button:last-child').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const del = ui.sent.filter((m) => m.type === 'deleteTurn');
  check('点删除发出 deleteTurn', del.length === 1 && del[0].turnId === 'u1', JSON.stringify(del));
  check('操作后菜单关闭', !ui.doc.querySelector('.msg-menu'));

  // 回复气泡的菜单里不该有「重新生成」（重来是从用户那条分叉的）。
  menuBtn('a1').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const items2 = [...ui.doc.querySelectorAll('.msg-menu button')].map((b) => b.textContent);
  check('回复消息菜单只有「删除」', items2.length === 1 && items2[0] === '删除', JSON.stringify(items2));

  // 点别处要能关掉。
  ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('点空白处关闭菜单', !ui.doc.querySelector('.msg-menu'));
}

// ---------------------------------------------------------------- 生成中的菜单

console.log('\n== 生成中的限制 ==');
{
  const ui = mount();
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'delta', turnId: 'a1', text: '生成中' });

  ui.bubble('u1').querySelector('.msg-menu-btn')
    .dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const before = ui.sent.filter((m) => m.type === 'retry').length;
  const regen = [...ui.doc.querySelectorAll('.msg-menu button')]
    .find((b) => b.textContent === '重新生成');
  if (regen) regen.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('生成中点「重新生成」不会发起新请求',
    ui.sent.filter((m) => m.type === 'retry').length === before);
}

// ---------------------------------------------------------------- 思考过程

console.log('\n== 思考过程（推理模型）==');
{
  const ui = mount();
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });

  const det = () => ui.bubble('a1').querySelector('details.reasoning');
  check('还没思考时不显示折叠块', !det());

  // 推理模型常常先想几十秒才吐正文——这段时间界面必须有东西。
  ui.post({ type: 'reasoning', turnId: 'a1', text: '先确定场景：' });
  check('收到思考后出现折叠块', !!det());
  check('默认是折叠的', det().open === false);
  check('思考内容已写入', det().querySelector('.reasoning-body').textContent === '先确定场景：');
  check('折叠标题显示字数', /思考过程/.test(det().querySelector('summary').textContent),
    det().querySelector('summary').textContent);
  check('思考不进正文', ui.bodyOf('a1').textContent === '',
    JSON.stringify(ui.bodyOf('a1').textContent));
  check('思考期间也显示流式光标', ui.bubble('a1').classList.contains('streaming'));

  ui.post({ type: 'reasoning', turnId: 'a1', text: '夜里的旧书店。' });
  check('思考增量累加',
    det().querySelector('.reasoning-body').textContent === '先确定场景：夜里的旧书店。');

  // 用户展开后，后续增量不能把它重新收起来。
  det().open = true;
  ui.post({ type: 'reasoning', turnId: 'a1', text: '再补细节。' });
  check('展开状态不被后续增量重置', det().open === true);

  // 正文开始后，思考块仍在，正文只含正文。
  ui.post({ type: 'delta', turnId: 'a1', text: '灯昏。' });
  check('正文开始后思考块仍保留', !!det());
  check('正文只含正文', ui.bodyOf('a1').textContent === '灯昏。');

  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '灯昏。', { reasoning: '先确定场景：夜里的旧书店。再补细节。' }) });
  ui.post({ type: 'busy', value: false });
  check('收尾后思考块还在（从 turn.reasoning 重建）', !!det());
  check('收尾后默认仍是折叠的', det().open === false);
  check('收尾后正文可编辑', ui.bodyOf('a1').getAttribute('contenteditable') === 'true');

  // 最关键的一条：采纳写入章节时绝不能带上思考内容。
  const accept = [...ui.bubble('a1').querySelectorAll('.msg-actions button')]
    .find((b) => b.textContent === '采纳写入');
  accept.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const sent = ui.sent.filter((m) => m.type === 'accept').pop();
  check('采纳的文本不含思考内容', !!sent && !sent.text.includes('先确定场景'),
    sent ? JSON.stringify(sent.text) : '没发出 accept');
  check('采纳的文本就是正文', !!sent && sent.text === '灯昏。',
    sent ? JSON.stringify(sent.text) : '');

  // 复制同理。
  const copy = [...ui.bubble('a1').querySelectorAll('.msg-actions button')]
    .find((b) => b.textContent === '复制');
  check('复制按钮存在（不含思考）', !!copy);

  // 没有思考的普通模型不该多出一个空折叠块。
  ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通输出') });
  check('无思考的回复不出现折叠块',
    !ui.bubble('a2').querySelector('details.reasoning'));
}

// ---------------------------------------------------------------- 工程页目录树

/** 造一棵三层深的树，覆盖目录 / 章节 / 角色 / 空文件夹四种节点。 */
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
            draftPath: 'drafts/第一卷/深处/003-夜访.md', hasDraft: false },
        ] },
        { kind: 'chapter', order: 2, title: '入镇', relPath: 'chapters/第一卷/002-入镇.md',
          wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/002.md',
          draftPath: 'drafts/第一卷/002-入镇.md', hasDraft: false },
      ] },
      { kind: 'dir', label: '第二卷', relPath: 'chapters/第二卷', fileCount: 0, children: [] },
      { kind: 'chapter', order: 1, title: '楔子', relPath: 'chapters/001-楔子.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/001.md',
        draftPath: 'drafts/001-楔子.md', hasDraft: true },
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

console.log('\n== 工程页目录树 ==');
{
  const ui = mount();
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const labels = () =>
    [...ui.doc.querySelectorAll('#projectBody .row-label')].map((n) => n.textContent);
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  ui.post({ type: 'project', tree: sampleTree() });

  check('顶层三个节点都在',
    labels().some((l) => l.includes('第一卷')) &&
    labels().some((l) => l.includes('第二卷')) &&
    labels().some((l) => l.includes('楔子')), labels().join(' | '));
  check('文件夹默认折叠，不渲染子节点',
    !labels().some((l) => l.includes('入镇')), labels().join(' | '));
  check('折叠时用闭合文件夹图标', labels().some((l) => l.startsWith('📁 第一卷')));

  clickEl(dirLabel('第一卷'));
  check('展开后出现子章节', labels().some((l) => l.includes('入镇')), labels().join(' | '));
  check('只展开一层，第三层仍折叠', !labels().some((l) => l.includes('夜访')));
  check('展开时用打开文件夹图标', labels().some((l) => l.startsWith('📂 第一卷')));

  clickEl(dirLabel('深处'));
  check('第三层展开后出现最深的章节', labels().some((l) => l.includes('夜访')));

  // 层级靠 paddingLeft 表达（DOM 是扁平的），每层 14px。
  const padOf = (text) => {
    const row = [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
    return row ? parseInt(row.style.paddingLeft, 10) : -1;
  };
  check('第 0 层缩进 16px', padOf('楔子') === 16, String(padOf('楔子')));
  check('第 1 层缩进 30px', padOf('入镇') === 30, String(padOf('入镇')));
  check('第 2 层缩进 44px', padOf('夜访') === 44, String(padOf('夜访')));

  clickEl(dirLabel('第二卷'));
  check('展开空文件夹给出提示',
    [...ui.doc.querySelectorAll('#projectBody .row-empty')].some((n) => n.textContent.includes('空文件夹')));

  // 折叠状态是前端自己的，全量推送不该把它重置掉。
  ui.post({ type: 'project', tree: sampleTree() });
  check('重推数据后保持展开状态', labels().some((l) => l.includes('夜访')), labels().join(' | '));
}

console.log('\n== 工程页的右键菜单 ==');
{
  const ui = mount();
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  /** 在某个元素上右键，返回弹出的菜单。 */
  const rightClick = (node) => {
    node.dispatchEvent(
      new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 })
    );
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const pick = (menu, label) =>
    clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent === label));
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  ui.post({ type: 'project', tree: sampleTree() });

  // 页面整洁：章节/角色/设定三个区的行不再挂任何行内按钮。
  // （「文风与摘要」不是文件管理区，它的「重建」「从正文提取」链接照旧留在行内。）
  const treeRows = [...ui.doc.querySelectorAll('#projectBody .group')]
    .slice(0, 3)
    .flatMap((g) => [...g.querySelectorAll('.row')]);
  check('树上的行不再有行内操作按钮',
    treeRows.length > 0 && treeRows.every((r) => !r.querySelector('.row-actions')),
    `${treeRows.length} 行`);
  check('分组标题栏不再有「＋」按钮',
    !ui.doc.querySelector('#projectBody .group-head .row-actions'));

  // ---- 章节行
  const chapterMenu = rightClick(rowWith('楔子'));
  check('右键章节行弹出菜单', !!chapterMenu);
  const chapterItems = itemsOf(chapterMenu);
  for (const label of ['打开', '在此续写', '重新总结', '看摘要', '重命名', '移动到…', '删除（移到回收站）']) {
    check(`章节菜单含「${label}」`, chapterItems.includes(label), JSON.stringify(chapterItems));
  }
  check('已有草稿的章节显示「打开草稿」', chapterItems.includes('打开草稿'), JSON.stringify(chapterItems));
  check('已有草稿的章节不显示「新建草稿」', !chapterItems.includes('新建草稿'), JSON.stringify(chapterItems));
  check('菜单有分隔线', chapterMenu.querySelectorAll('.menu-sep').length >= 1);

  check('有草稿的章节行带标记', rowWith('楔子').textContent.includes('· 草稿'), rowWith('楔子').textContent);

  pick(rightClick(rowWith('楔子')), '打开草稿');
  const draftMsg = last('openDraft');
  check('点「打开草稿」发 openDraft，带的是章节路径',
    draftMsg && draftMsg.path === 'chapters/001-楔子.md', JSON.stringify(draftMsg));

  pick(chapterMenu, '删除（移到回收站）');
  const del = last('fileAction');
  check('点删除发 fileAction',
    del && del.action === 'delete' && del.relPath === 'chapters/001-楔子.md', JSON.stringify(del));
  check('点完菜单关闭', !ui.doc.querySelector('.ctx-menu'));

  pick(rightClick(rowWith('楔子')), '在此续写');
  const cont = last('projectAction');
  check('「在此续写」带章节序号',
    cont && cont.action === 'continueFrom' && cont.order === 1, JSON.stringify(cont));

  pick(rightClick(rowWith('楔子')), '重命名');
  check('「重命名」发 fileAction', last('fileAction').action === 'rename');

  pick(rightClick(rowWith('楔子')), '移动到…');
  check('「移动到…」发 fileAction', last('fileAction').action === 'move');

  // 没生成过摘要的章节不该出现「看摘要」。夜访在第三层，先展开两级。
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));
  clickEl(dirLabel('第一卷'));
  clickEl(dirLabel('深处'));
  const staleItems = itemsOf(rightClick(rowWith('夜访')));
  check('未生成摘要的章节没有「看摘要」', !staleItems.includes('看摘要'), JSON.stringify(staleItems));
  check('未生成摘要的章节显示「总结本章」', staleItems.includes('总结本章'), JSON.stringify(staleItems));
  check('没有草稿的章节显示「新建草稿」', staleItems.includes('新建草稿'), JSON.stringify(staleItems));
  check('没有草稿的章节行不带标记', !rowWith('夜访').textContent.includes('· 草稿'));
  closeAnyMenu(ui);

  // ---- 文件夹行：「在此新建」的落点必须是这个文件夹，不是区根目录。
  const folderMenu = rightClick(rowWith('第一卷'));
  const folderItems = itemsOf(folderMenu);
  check('文件夹菜单含「在此新建章节」', folderItems.includes('在此新建章节'), JSON.stringify(folderItems));
  check('文件夹菜单含折叠项', folderItems.includes('折叠'), JSON.stringify(folderItems));
  pick(folderMenu, '在此新建章节');
  const add = last('projectAction');
  check('文件夹的「在此新建章节」带 dir',
    add && add.action === 'newChapter' && add.dir === 'chapters/第一卷', JSON.stringify(add));

  pick(rightClick(rowWith('第一卷')), '在此新建文件夹');
  const mk = last('projectAction');
  check('「在此新建文件夹」带 dir',
    mk && mk.action === 'newFolder' && mk.dir === 'chapters/第一卷', JSON.stringify(mk));

  // ---- 角色文件行
  const linRow = rowWith('林昭');
  const fileItems = itemsOf(rightClick(linRow));
  check('角色行菜单含打开与三个类文件操作',
    ['打开', '重命名', '移动到…', '删除（移到回收站）'].every((l) => fileItems.includes(l)),
    JSON.stringify(fileItems));
  check('角色行菜单没有「在此新建」', !fileItems.some((l) => l.startsWith('在此新建')));
  closeAnyMenu(ui);

  // 点文件名仍走 openPath：插件的 body 没有 #wbEditor，应当发 openFile。
  clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '林昭'));
  const open = last('openFile');
  check('点角色名发 openFile（插件壳无内置编辑器）',
    open && open.path === '.novelforge/characters/林昭.md', JSON.stringify(open));

  // ---- 分组标题栏：落点是该区根目录。
  // 注意用精确匹配取分组名：「出场人物 · 未建卡」也含「角色」二字之外的字样，
  // 而角色区标题就是「角色」，includes 在两组都在时会撞上第一个。
  const groupHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent === '角色');
  pick(rightClick(groupHead), '在此新建角色卡');
  const rootAdd = last('projectAction');
  check('分组标题栏的新建落点为区根目录',
    rootAdd.action === 'newCharacter' && rootAdd.dir === '.novelforge/characters', JSON.stringify(rootAdd));

  // ---- 「文风与摘要」是工程固定文件，不能重命名/删除。
  const metaItems = itemsOf(rightClick(rowWith('全书大纲')));
  check('固定元数据行的菜单没有重命名/删除',
    !metaItems.includes('重命名') && !metaItems.includes('删除（移到回收站）'), JSON.stringify(metaItems));
  check('固定元数据行的菜单有打开与刷新',
    metaItems.includes('打开') && metaItems.includes('刷新'), JSON.stringify(metaItems));

  // ---- 角色分组：批量更新/重建。
  const charItems = itemsOf(rightClick(groupHead));
  check('角色分组菜单含批量项',
    charItems.includes('更新所有角色卡') && charItems.includes('从头重建所有角色卡'),
    JSON.stringify(charItems));
  check('角色分组菜单仍含新建项', charItems.includes('在此新建角色卡'), JSON.stringify(charItems));
  pick(rightClick(groupHead), '更新所有角色卡');
  const upAll = last('characterAction');
  check('「更新所有角色卡」发 updateAllCards',
    upAll && upAll.action === 'updateAllCards', JSON.stringify(upAll));
  pick(rightClick(groupHead), '从头重建所有角色卡');
  const reAll = last('characterAction');
  check('「从头重建」发 rebuildAllCards',
    reAll && reAll.action === 'rebuildAllCards', JSON.stringify(reAll));
  closeAnyMenu(ui);

  // ---- 设定分组：全书自动生成入口与手动新建并存。
  const loreHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent === '设定');
  const loreItems = itemsOf(rightClick(loreHead));
  check('设定分组菜单含自动生成入口',
    loreItems.includes('从全部章节生成/更新设定'), JSON.stringify(loreItems));
  check('设定分组菜单仍含手动新建', loreItems.includes('在此新建设定'), JSON.stringify(loreItems));
  pick(rightClick(loreHead), '从全部章节生成/更新设定');
  const generateLore = last('projectAction');
  check('自动生成设定发 generateLore',
    generateLore && generateLore.action === 'generateLore', JSON.stringify(generateLore));
  closeAnyMenu(ui);
}

console.log('\n== 角色的出场统计与更新菜单 ==');
{
  const ui = mount();
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const pick = (menu, label) =>
    clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent === label));
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  ui.post({ type: 'project', tree: sampleTree() });

  // ---- 已建卡的角色行：出场章数进副标题，待更新章数单独标记。
  const linRow = rowWith('林昭');
  check('角色行显示出场章数', linRow.textContent.includes('出场 3 章'), linRow.textContent);
  check('角色行保留原有副标题（标签）', linRow.textContent.includes('主角'), linRow.textContent);
  check('待更新章数有标记', linRow.textContent.includes('＋2'), linRow.textContent);
  check('标记带解释性 title',
    linRow.querySelector('.cast-pending').title.includes('第 1 章'),
    linRow.querySelector('.cast-pending').title);

  const linItems = itemsOf(rightClick(linRow));
  check('菜单含带章数的「更新角色卡」',
    linItems.includes('更新角色卡（新增 2 章）'), JSON.stringify(linItems));
  check('菜单含「重新通读全部」',
    linItems.includes('重新通读全部 3 章'), JSON.stringify(linItems));
  check('菜单里能看到出场章节', linItems.includes('出场：第 1、2、3 章'), JSON.stringify(linItems));
  check('角色行仍有类文件操作',
    ['重命名', '移动到…', '删除（移到回收站）'].every((l) => linItems.includes(l)), JSON.stringify(linItems));
  closeAnyMenu(ui);

  // 增量走 updateCard，全量走 rebuildCard——两个动作不能混。
  pick(rightClick(rowWith('林昭')), '更新角色卡（新增 2 章）');
  const inc = last('characterAction');
  check('「更新角色卡」发 updateCard 并带卡路径',
    inc && inc.action === 'updateCard' && inc.name === '林昭' &&
    inc.relPath === '.novelforge/characters/林昭.md', JSON.stringify(inc));

  pick(rightClick(rowWith('林昭')), '重新通读全部 3 章');
  const full = last('characterAction');
  check('「重新通读」发 rebuildCard', full && full.action === 'rebuildCard', JSON.stringify(full));

  // ---- 摘要里没出现过的角色：不给更新入口，说明为什么。
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));
  clickEl(dirLabel('配角'));
  const liRow = rowWith('李叔');
  check('未出场的角色行不显示出场章数', !liRow.textContent.includes('出场'), liRow.textContent);
  check('未出场的角色行没有待更新标记', !liRow.querySelector('.cast-pending'));
  const liItems = itemsOf(rightClick(liRow));
  check('未出场的角色没有「更新角色卡」',
    !liItems.some((l) => l.startsWith('更新角色卡')), JSON.stringify(liItems));
  check('未出场的角色说明原因',
    liItems.includes('未在摘要中出现，无法自动更新'), JSON.stringify(liItems));
  closeAnyMenu(ui);

  // ---- 未建卡的出场人物：单独一组，只有「建卡」一个动作。
  const castGroup = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent.includes('未建卡'));
  check('有「出场人物 · 未建卡」分组', !!castGroup);
  check('分组副标题给出人数', castGroup.textContent.includes('2 人'), castGroup.textContent);

  const castRow = rowWith('客栈掌柜');
  check('未建卡的人也列出出场章节', castRow.textContent.includes('第 2、3 章'), castRow.textContent);
  check('未建卡的行有独立样式', castRow.classList.contains('row-cast'));
  check('别名进 title', castRow.querySelector('.row-label').title.includes('掌柜'));

  const castItems = itemsOf(rightClick(castRow));
  check('未建卡的菜单只给建卡',
    castItems.includes('创建角色卡（通读出场章节）'), JSON.stringify(castItems));
  // 这些人还没有文件，类文件操作无从谈起。
  check('未建卡的菜单没有类文件操作',
    !castItems.includes('重命名') && !castItems.includes('删除（移到回收站）'), JSON.stringify(castItems));
  pick(rightClick(castRow), '创建角色卡（通读出场章节）');
  const create = last('characterAction');
  check('建卡发 createCard 且不带 relPath',
    create && create.action === 'createCard' && create.name === '客栈掌柜' && !create.relPath,
    JSON.stringify(create));

  // 点名字也是建卡（最常用的动作放在最省事的位置）。
  clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '老周'));
  check('点未建卡的名字直接建卡',
    last('characterAction').name === '老周', JSON.stringify(last('characterAction')));

  // 没有未建卡的人时，整组不出现——不该留一个空分组占地方。
  ui.post({ type: 'project', tree: { ...sampleTree(), cast: [] } });
  check('没有未建卡的人则不显示该分组',
    ![...ui.doc.querySelectorAll('#projectBody .group-name')]
      .some((n) => n.textContent.includes('未建卡')));

  // 旧后端（还没有 cast 字段）推来的树不能让前端崩。
  const legacy = sampleTree();
  delete legacy.cast;
  delete legacy.castByCard;
  ui.post({ type: 'project', tree: legacy });
  check('缺 cast 字段时仍能渲染', !!rowWith('林昭'));
  check('缺 castByCard 时角色行不显示出场', !rowWith('林昭').textContent.includes('出场'));
  const legacyItems = itemsOf(rightClick(rowWith('林昭')));
  check('缺 castByCard 时不给更新入口',
    !legacyItems.some((l) => l.startsWith('更新角色卡')), JSON.stringify(legacyItems));
  closeAnyMenu(ui);
}

console.log('\n== 右键菜单的通用行为 ==');
{
  const ui = mount();
  const rightClick = (node, x, y) => {
    node.dispatchEvent(
      new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: x ?? 40, clientY: y ?? 60 })
    );
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  // 其它页面只要基础刷新。
  const historyMenu = rightClick(ui.doc.getElementById('pane-history'));
  check('历史页右键弹出菜单', !!historyMenu);
  check('历史页菜单只有「刷新」',
    itemsOf(historyMenu).length === 1 && itemsOf(historyMenu)[0] === '刷新',
    JSON.stringify(itemsOf(historyMenu)));

  historyMenu.querySelector('button').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const refresh = last('projectAction');
  check('点「刷新」发 projectAction refresh',
    refresh && refresh.action === 'refresh', JSON.stringify(refresh));

  check('设置页右键也给刷新',
    itemsOf(rightClick(ui.doc.getElementById('pane-settings'))).includes('刷新'));

  // 同时只允许一个菜单。
  rightClick(ui.doc.getElementById('pane-chat'));
  check('同时只存在一个菜单', ui.doc.querySelectorAll('.ctx-menu').length === 1);

  // 用绝对定位挂在 body 上，不会被内部滚动容器裁掉。
  check('菜单挂在 body 上', ui.doc.querySelector('.ctx-menu').parentElement === ui.doc.body);

  ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('点空白处关闭菜单', !ui.doc.querySelector('.ctx-menu'));

  rightClick(ui.doc.getElementById('pane-history'));
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('按 Esc 关闭菜单', !ui.doc.querySelector('.ctx-menu'));

  // 气泡的 ⋯ 菜单与右键菜单是两个类名，互不干扰。
  ui.post({ type: 'session', session: { id: 's', title: '', turns: [] } });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
  ui.bubble('u1').querySelector('.msg-menu-btn')
    .dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('⋯ 菜单仍用 .msg-menu 且贴在气泡里',
    !!ui.doc.querySelector('.msg-menu') && !ui.doc.querySelector('.ctx-menu'));

  // ⋯ 菜单挂在气泡里、跟着一起滚，不该被滚动关掉——否则流式输出时
  // 每来一段都 scrollToBottom()，菜单刚点开就没了。
  ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
  check('滚动不关闭 ⋯ 菜单', !!ui.doc.querySelector('.msg-menu'));

  rightClick(ui.doc.getElementById('pane-history'));
  check('右键会顶掉已打开的 ⋯ 菜单',
    !ui.doc.querySelector('.msg-menu') && !!ui.doc.querySelector('.ctx-menu'));

  // 右键菜单是 fixed 的，一滚就和目标行脱节，必须关掉。
  ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
  check('滚动关闭右键菜单', !ui.doc.querySelector('.ctx-menu'));
  closeAnyMenu(ui);
}

// ---------------------------------------------------------------- 内置编辑器（独立版）

console.log('\n== 内置编辑器：两块编辑区 ==');
{
  const ui = mountEditor();
  const tabsOf = (pane) => [...pane.querySelectorAll('.ed-tab-name')].map((n) => n.textContent);
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  check('一开始只有主区一块', ui.panes().length === 1, `${ui.panes().length} 块`);
  check('草稿分隔条藏着', ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));

  // ---- 主区打开正文
  ui.post({ type: 'editorOpen', file: ui.file('chapters/001-楔子.md', '# 楔子\n\n正文', { draftPath: 'drafts/001-楔子.md' }) });
  check('正文开在主区', tabsOf(ui.panes()[0]).join(',') === '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  check('是章节时显示「草稿」按钮', !ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));

  ui.doc.getElementById('edDraftBtn').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const req = last('openDraft');
  check('点「草稿」发 openDraft，带的是章节路径',
    req && req.path === 'chapters/001-楔子.md', JSON.stringify(req));

  // ---- 后端回一份草稿，开在第二块
  ui.post({
    type: 'editorOpen',
    pane: 'draft',
    file: ui.file('drafts/001-楔子.md', '# 楔子 · 草稿\n\n'),
  });
  check('草稿区被创建出来', ui.panes().length === 2, `${ui.panes().length} 块`);
  check('第二块带 wb-editor-draft', ui.panes()[1].classList.contains('wb-editor-draft'));
  check('草稿分隔条露出来', !ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  check('正文仍在主区', tabsOf(ui.panes()[0]).join(',') === '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  check('草稿在草稿区', tabsOf(ui.panes()[1]).join(',') === '001-楔子.md', tabsOf(ui.panes()[1]).join(','));

  // ---- 保存回执按 path 找对应的那一块，别把 draftPath 冲掉
  ui.post({ type: 'editorSaved', file: ui.file('chapters/001-楔子.md', '# 楔子\n\n改过了', { draftPath: 'drafts/001-楔子.md' }) });
  check('保存后「草稿」按钮还在', !ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));

  // ---- 非章节文件不显示「草稿」按钮
  ui.post({ type: 'editorOpen', file: ui.file('.novelforge/style.md', '# 文风指南') });
  check('非章节不显示「草稿」按钮', ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));

  // ---- 一个路径只属于一块：把主区的正文改开到草稿区
  ui.post({ type: 'editorOpen', pane: 'draft', file: ui.file('chapters/001-楔子.md', '# 楔子\n\n改过了') });
  check('主区交出了这个路径，只剩另一份文件',
    tabsOf(ui.panes()[0]).join(',') === 'style.md', tabsOf(ui.panes()[0]).join(','));
  check('草稿区现在有两个标签', ui.panes()[1].querySelectorAll('.ed-tab').length === 2,
    tabsOf(ui.panes()[1]).join(','));
}

console.log('\n== 摘要进度显示 ==');
{
  const ui = mount();
  const banner = () => ui.doc.querySelector('#projectBody .banner-summary');
  const groupMeta = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((h) => h.textContent.includes(name))
      ?.querySelector('.meta')?.textContent ?? '';

  ui.post({ type: 'project', tree: sampleTree() });

  check('有过期摘要时出现进度横幅', !!banner());
  check('横幅说明有几章过期', banner().textContent.includes('1 章摘要缺失或已过期'), banner().textContent);
  check('横幅给出已完成／总数', banner().textContent.includes('已总结 2 / 3 章'), banner().textContent);
  check('横幅给出百分比', banner().textContent.includes('67%'), banner().textContent);
  check('横幅有进度条', !!banner().querySelector('.sum-fill'));
  check('进度条按比例填充',
    banner().querySelector('.sum-fill').style.width === '67%',
    banner().querySelector('.sum-fill').style.width);
  check('没有任务时仍能点「立即同步」',
    [...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));
  check('分组副标题带进度',
    groupMeta('文风与摘要').includes('已总结 2/3 章'), groupMeta('文风与摘要'));

  // 同步跑起来后，重复点只会撞上「已有任务」，所以按钮撤掉。
  ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '同步章节摘要', message: '第 3 章', current: 0, total: 1, elapsedMs: 0 }] });
  ui.post({ type: 'project', tree: sampleTree() });
  check('同步进行中不再显示「立即同步」',
    ![...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));

  // 全部同步完就不该再有横幅。
  ui.post({ type: 'tasks', tasks: [] });
  ui.post({ type: 'project', tree: { ...sampleTree(), staleCount: 0, summarizedCount: 3 } });
  check('全部同步后横幅消失', !banner());
  check('分组副标题改为已同步',
    groupMeta('文风与摘要').includes('已全部同步'), groupMeta('文风与摘要'));
}

console.log('\n== 长任务进度条 ==');
{
  const ui = mount();
  const taskList = () => ui.doc.getElementById('taskList');
  const rows = () => [...taskList().querySelectorAll('.task')];
  const textOf = (i) => rows()[i].textContent;

  check('没有任务时整块隐藏', taskList().classList.contains('hidden'));

  ui.post({
    type: 'tasks',
    tasks: [{ id: 't1', title: '同步章节摘要', message: '第 12 章《夜访》', current: 11, total: 76, elapsedMs: 65000 }],
  });
  check('有任务时露出来', !taskList().classList.contains('hidden'));
  check('渲染出一行', rows().length === 1, `${rows().length}`);
  check('显示标题', textOf(0).includes('同步章节摘要'), textOf(0));
  check('显示当前在做什么', textOf(0).includes('第 12 章《夜访》'), textOf(0));
  check('显示 n/N 与百分比', textOf(0).includes('11/76') && textOf(0).includes('14%'), textOf(0));
  check('显示已用时（分:秒）', textOf(0).includes('1:05'), textOf(0));
  check('进度条按比例填充',
    rows()[0].querySelector('.task-fill').style.width === '14%',
    rows()[0].querySelector('.task-fill').style.width);

  // 点「停止」要把任务 id 发回后端。
  ui.sent.length = 0;
  [...rows()[0].querySelectorAll('button')].find((b) => b.textContent === '停止')
    .dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('点停止发出 cancelTask',
    ui.sent.some((m) => m.type === 'cancelTask' && m.id === 't1'), JSON.stringify(ui.sent));

  // 不知道总量时走不定量条，不显示假的百分比。
  ui.post({ type: 'tasks', tasks: [{ id: 't2', title: '提取文风指南', message: '分析中', elapsedMs: 3000 }] });
  check('无 total 时用不定量条', rows()[0].querySelector('.task-bar').classList.contains('indeterminate'));
  check('无 total 时不显示百分比', !textOf(0).includes('%'), textOf(0));

  // 多个任务并存。
  ui.post({
    type: 'tasks',
    tasks: [
      { id: 't3', title: '甲', message: '一', current: 1, total: 2, elapsedMs: 0 },
      { id: 't4', title: '乙', message: '二', current: 0, total: 5, elapsedMs: 0 },
    ],
  });
  check('两个任务都渲染', rows().length === 2, `${rows().length}`);

  ui.post({ type: 'tasks', tasks: [] });
  check('任务结束后整块收起', taskList().classList.contains('hidden'));
  check('任务结束后行清空', rows().length === 0, `${rows().length}`);
}

console.log('\n== 日志页 ==');
{
  const ui = mount();
  const rows = () => [...ui.doc.querySelectorAll('#logBody .log-row')];
  const texts = () => rows().map((n) => n.textContent);
  const entry = (seq, level, scope, message, detail) => ({
    seq, level, scope, message, detail, at: new Date(2026, 0, 1, 12, 3, 41).toISOString(),
  });

  ui.post({
    type: 'logs',
    entries: [
      entry(1, 'debug', '摘要', '第 1 章请求模型'),
      entry(2, 'info', '摘要', '第 1 章摘要已写入', '耗时 3.2s'),
      entry(3, 'warn', '摘要', '第 2 章是空的'),
      entry(4, 'error', '模型', '连接失败'),
    ],
  });

  // 默认「信息及以上」：debug 那条不显示。
  check('默认过滤掉 debug', rows().length === 3, `${rows().length}`);
  check('显示时间', texts()[0].includes('12:03:41'), texts()[0]);
  check('显示来源', texts()[0].includes('摘要'), texts()[0]);
  check('显示消息', texts()[0].includes('第 1 章摘要已写入'), texts()[0]);
  check('警告行带级别样式', rows()[1].classList.contains('log-warn'));
  check('错误行带级别样式', rows()[2].classList.contains('log-error'));
  check('detail 折叠在 details 里', !!rows()[0].querySelector('details.log-detail'));
  check('detail 默认收起', !rows()[0].querySelector('details.log-detail').open);
  check('计数显示筛选比例', ui.doc.getElementById('logMeta').textContent === '3 / 4 条',
    ui.doc.getElementById('logMeta').textContent);

  // 调到「全部」应当把 debug 放出来。
  const setLevel = (v) => {
    ui.doc.getElementById('logLevel').value = v;
    ui.doc.getElementById('logLevel').dispatchEvent(new ui.window.Event('change'));
  };
  setLevel('debug');
  check('切到全部后 debug 出现', rows().length === 4, `${rows().length}`);
  check('全部显示时计数不带比例', ui.doc.getElementById('logMeta').textContent === '4 条',
    ui.doc.getElementById('logMeta').textContent);

  setLevel('error');
  check('切到仅错误只剩一条', rows().length === 1, `${rows().length}`);
  check('剩下的就是那条错误', texts()[0].includes('连接失败'), texts()[0]);
  setLevel('info');

  // 关键字过滤。
  const filter = ui.doc.getElementById('logFilter');
  filter.value = '模型';
  filter.dispatchEvent(new ui.window.Event('input'));
  check('关键字过滤生效', rows().length === 1 && texts()[0].includes('连接失败'), texts().join(' | '));
  filter.value = '';
  filter.dispatchEvent(new ui.window.Event('input'));
  check('清空过滤后恢复', rows().length === 3, `${rows().length}`);

  // 增量追加。
  ui.post({ type: 'log', entry: entry(5, 'info', '摘要', '第 3 章摘要已写入') });
  check('增量追加一条', rows().length === 4, `${rows().length}`);
  check('追加在末尾', texts().at(-1).includes('第 3 章摘要已写入'), texts().at(-1));

  // 被过滤掉的级别，增量也不该冒出来。
  ui.post({ type: 'log', entry: entry(6, 'debug', '摘要', '不该显示的调试') });
  check('增量也走过滤', !texts().some((t) => t.includes('不该显示的调试')), texts().join(' | '));

  // 清空按钮把请求发回后端，前端不自己清（后端要留一条痕迹）。
  ui.sent.length = 0;
  ui.doc.getElementById('logClearBtn').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  check('点清空发出 clearLogs', ui.sent.some((m) => m.type === 'clearLogs'), JSON.stringify(ui.sent));

  ui.post({ type: 'logs', entries: [entry(7, 'info', '日志', '日志已清空')] });
  check('清空后只剩痕迹那条', rows().length === 1 && texts()[0].includes('日志已清空'), texts().join(' | '));

  // ---- 「加载更早」：内存缓冲只有几百条且随进程消失，更早的存在工程库里。
  // 默认路径（切到日志页）仍然只看缓冲，一次查询都不做，所以这里要验的是
  // 「只有点了按钮才发消息」。
  ui.post({
    type: 'logs',
    entries: [entry(20, 'info', '摘要', '本次会话的一条')],
  });
  ui.sent.length = 0;
  check('切到日志页不主动要历史', !ui.sent.some((m) => m.type === 'requestLogHistory'));

  const earlierBtn = ui.doc.getElementById('logEarlierBtn');
  check('日志页有「加载更早」按钮', !!earlierBtn);
  earlierBtn.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const ask = ui.sent.find((m) => m.type === 'requestLogHistory');
  check('点按钮发 requestLogHistory', !!ask, JSON.stringify(ui.sent));
  // before 是已显示的最早那条的时间戳，据它继续往前翻。
  check('带上已显示的最早时间戳', ask && typeof ask.before === 'string', JSON.stringify(ask));

  // 历史接在最前面（seq 取负，与实时序号不会撞）。
  ui.post({
    type: 'logHistory',
    entries: [
      { seq: -2, level: 'error', scope: '角色卡', message: '上次会话的失败', at: new Date(2026, 0, 1, 9, 0, 0).toISOString() },
      { seq: -1, level: 'info', scope: '摘要', message: '上次会话的一条', at: new Date(2026, 0, 1, 9, 0, 1).toISOString() },
    ],
    exhausted: false,
  });
  check('历史接在最前面', texts()[0].includes('上次会话的失败'), texts().join(' | '));
  check('本次会话的日志还在', texts().some((t) => t.includes('本次会话的一条')), texts().join(' | '));

  // 再往前没有了：按钮禁用并改文案，别让用户一直点一个没反应的按钮。
  ui.post({ type: 'logHistory', entries: [], exhausted: true });
  check('没有更早时按钮禁用', ui.doc.getElementById('logEarlierBtn').disabled);
  check('没有更早时改文案',
    ui.doc.getElementById('logEarlierBtn').textContent.includes('没有更早'),
    ui.doc.getElementById('logEarlierBtn').textContent);

  // 切筛选条件不该把加载进来的历史丢掉（那以前会走 renderLogs 重置状态）。
  setLevel('debug');
  check('切筛选后历史仍在', texts().some((t) => t.includes('上次会话的失败')), texts().join(' | '));
}

// ---------------------------------------------------------------- 资源管理器
console.log('\n== 资源管理器（独立版「文件」页）==');
{
  const ui = mountExplorer();
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  // 挂载即要一份工程根：切到「文件」页时树已经在了，不必等一次往返。
  const first = last('listDir');
  check('挂载后请求工程根', first && first.dirs.includes(''), JSON.stringify(first));

  ui.post({
    type: 'dirListings',
    listings: [ui.listing('', { '.novelforge': 'dir', chapters: 'dir', 'README.md': 'file' })],
  });
  // 这一条是这个功能存在的理由：工程页永远看不见 .novelforge。
  check('点开头的文件夹列得出来', ui.names().includes('.novelforge'), ui.names().join(','));
  check('点开头的行压暗显示',
    ui.rows().some((r) => r.textContent.includes('.novelforge') && r.classList.contains('fx-dotted')));
  check('目录在文件之前', ui.names().join(',') === '.novelforge,chapters,README.md', ui.names().join(','));

  // ---- 展开一个目录：懒加载，展开哪个才要哪个
  ui.sent.length = 0;
  ui.click(ui.rows().find((r) => r.textContent.includes('.novelforge')));
  const expanded = last('listDir');
  check('展开后请求那个目录', expanded && expanded.dirs.includes('.novelforge'), JSON.stringify(expanded));
  check('请求带的是全量展开集合', expanded && expanded.dirs.includes(''), JSON.stringify(expanded));
  check('还没回数据时显示载入中', ui.names().some((n) => n === '载入中…'), ui.names().join(','));

  ui.post({
    type: 'dirListings',
    listings: [ui.listing('.novelforge', { summaries: 'dir', 'project.json': 'file' })],
  });
  check('子项挂在父目录下', ui.names().join(',') === '.novelforge,summaries,project.json,chapters,README.md',
    ui.names().join(','));
  check('子项有缩进', ui.rows()[1].style.paddingLeft !== ui.rows()[0].style.paddingLeft,
    `${ui.rows()[0].style.paddingLeft} vs ${ui.rows()[1].style.paddingLeft}`);

  // ---- 折叠：子目录一并收起，再展开时不该凭空还开着
  ui.sent.length = 0;
  ui.click(ui.rows().find((r) => r.textContent.includes('summaries')));
  ui.click(ui.rows().find((r) => r.textContent.includes('.novelforge')));
  const collapsed = last('listDir');
  check('折叠后不再关注该目录', collapsed && !collapsed.dirs.includes('.novelforge'), JSON.stringify(collapsed));
  check('子目录跟着一起收起', collapsed && !collapsed.dirs.includes('.novelforge/summaries'),
    JSON.stringify(collapsed));

  // ---- 点文件：可编辑的进内置编辑器
  ui.sent.length = 0;
  ui.click(ui.rows().find((r) => r.textContent.includes('README.md')));
  check('点文本文件发 openEditor',
    last('openEditor') && last('openEditor').path === 'README.md', JSON.stringify(ui.sent));

  // ---- 二进制文件：不撞一个必然失败的 openEditor，直接交系统程序
  ui.post({
    type: 'dirListings',
    listings: [
      Object.assign(ui.listing('', { '封面.png': 'file' }), {
        entries: [{ kind: 'file', name: '封面.png', relPath: '封面.png', editable: false, bytes: 9, modified: 0 }],
      }),
    ],
  });
  ui.sent.length = 0;
  ui.click(ui.rows()[0]);
  check('点不可编辑的文件走 openExternal',
    last('openExternal') && last('openExternal').path === '封面.png', JSON.stringify(ui.sent));
  check('不可编辑的行置灰', ui.rows()[0].classList.contains('fx-binary'));

  // ---- 高亮跟着编辑器走（点章节、采纳写入也会开文件，不只这棵树）
  ui.post({ type: 'dirListings', listings: [ui.listing('', { 'a.md': 'file', 'b.md': 'file' })] });
  ui.post({ type: 'editorOpen', file: { path: 'b.md', name: 'b.md', text: '', hash: 'h', bytes: 0 } });
  check('编辑器打开谁就高亮谁',
    ui.rows().filter((r) => r.classList.contains('active')).map((r) => r.textContent.trim()).join(',').includes('b.md'),
    ui.names().join(','));

  // ---- 不静默截断
  ui.post({
    type: 'dirListings',
    listings: [Object.assign(ui.listing('', { 'a.md': 'file' }), { truncated: 3000 })],
  });
  check('截断时如实告知', ui.names().some((n) => n.includes('未列出')), ui.names().join(','));

  // ---- 读不动的目录降级成一行提示，不炸整页
  ui.post({
    type: 'dirListings',
    listings: [{ relPath: '', entries: [], truncated: 0, error: '目录不存在（可能刚被删除或改名）' }],
  });
  check('读失败显示原因', ui.names().some((n) => n.includes('目录不存在')), ui.names().join(','));
  check('读失败不抛异常把树清空', ui.rows().length === 1, `${ui.rows().length}`);

  // ---- 右键复用 view.js 的菜单引擎（另起一套会两层菜单一起弹）
  ui.post({ type: 'dirListings', listings: [ui.listing('', { 'a.md': 'file' })] });
  ui.rows()[0].dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true }));
  const menu = ui.doc.querySelector('.ctx-menu');
  check('右键弹出菜单', !!menu);
  check('菜单里有「打开」', menu && [...menu.querySelectorAll('button')].some((b) => b.textContent === '打开'),
    menu && [...menu.querySelectorAll('button')].map((b) => b.textContent).join(','));
  closeAnyMenu(ui);
}

// ---------------------------------------------------------------- 摘要悬停浮窗

/**
 * 这一块必须放在最后：浮窗有半秒悬停延迟，只能等真定时器，
 * 于是整块是异步的，收尾与 process.exit 都挪进它里面。
 */
async function summaryTipTests() {
  console.log('\n== 章节摘要的悬停浮窗 ==');
  const ui = mount();
  const tip = () => ui.doc.querySelector('.summary-tip');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);
  /** 等过悬停延迟（view.js 里是 450ms）。 */
  const settle = () => new Promise((r) => setTimeout(r, 600));
  /** 等过收起的宽限期（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => new Promise((r) => setTimeout(r, 320));
  /** 鼠标进/出浮窗。这两个事件不冒泡，得直接派到浮窗上。 */
  const enterTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  const leaveTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  /** 移开鼠标并等过宽限期：悬停到分组标题栏（不是章节行）即可。 */
  const moveAway = async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
  };

  // jsdom 里所有尺寸都是 0，定位逻辑会全程退化成「贴光标」，量不出东西来。
  // 给浮窗与章节行装上可控的几何，才验得了「不许跑到窗口外面去」。
  const VIEWPORT = { w: 800, h: 600 };
  /** 浮窗的自然高度（不受行内 maxHeight 限制时的高度）。 */
  let tipNaturalHeight = 200;
  /** 目标行在视口里的位置。 */
  let rowRect = { top: 100, bottom: 120, left: 20 };
  const isTip = (node) => node.classList && node.classList.contains('summary-tip');
  Object.defineProperty(ui.window, 'innerWidth', { get: () => VIEWPORT.w, configurable: true });
  Object.defineProperty(ui.window, 'innerHeight', { get: () => VIEWPORT.h, configurable: true });
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return isTip(this) ? 340 : 0; },
  });
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if (!isTip(this)) return 0;
      // 行内 maxHeight 是 placeSummaryTip 压上去的，这里要如实反映它的效果，
      // 否则「压过高度后再量」那一步测不出来。
      const cap = parseFloat(this.style.maxHeight);
      return Number.isFinite(cap) && cap > 0 ? Math.min(tipNaturalHeight, cap) : tipNaturalHeight;
    },
  });
  ui.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('row-chapter')) {
      return {
        top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left,
        right: rowRect.left + 200, width: 200, height: rowRect.bottom - rowRect.top,
      };
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  };
  /** 浮窗当前占据的矩形（按行内样式算），用来断言它有没有跑出窗口。 */
  const tipBox = () => {
    const box = tip();
    const top = parseFloat(box.style.top);
    const left = parseFloat(box.style.left);
    return { top, left, bottom: top + box.offsetHeight, right: left + box.offsetWidth };
  };

  const summaryOf = (extra) =>
    Object.assign(
      {
        order: 1, title: '楔子', exists: true, stale: false,
        relPath: '.novelforge/summaries/001.md',
        sections: [
          { name: '梗概', text: '雨下了三天，林昭进入青崖镇。' },
          { name: '关键事件', text: '- 以旧牌子代替过所\n- 李叔放行' },
        ],
      },
      extra
    );

  ui.post({ type: 'project', tree: sampleTree() });

  check('默认不显示浮窗', !tip());

  // 只有章节行有浮窗，角色行没有。
  hover(rowWith('林昭'));
  await settle();
  check('角色行不弹浮窗', !tip());

  // ---- 悬停在章节行上
  ui.sent.length = 0;
  hover(rowWith('楔子'));
  check('悬停后不立刻弹出（有延迟，免得划过时闪）', !tip());
  check('延迟未到时不发请求', !last('requestSummary'));

  // 光标在行上微动（mouseover 从子元素冒泡上来）不该重置延迟，
  // 否则手一抖浮窗就永远弹不出来。等一半再抖一下，总时长仍应触发。
  await new Promise((r) => setTimeout(r, 300));
  hover(rowWith('楔子').querySelector('.row-label'));
  await new Promise((r) => setTimeout(r, 300));

  check('行内微动不重置延迟，浮窗照常弹出', !!tip());
  check('数据没到时先显示读取中', tip().textContent.includes('读取摘要'), tip().textContent);
  const req = last('requestSummary');
  check('向后端要这一章的摘要', req && req.order === 1, JSON.stringify(req));
  check('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）',
    tip().parentElement === ui.doc.body);

  // ---- 摘要到了
  ui.post({ type: 'summary', summary: summaryOf() });
  check('摘要到达后换掉内容', !tip().textContent.includes('读取摘要'), tip().textContent);
  check('浮窗带章号与标题', tip().textContent.includes('第 1 章 楔子'), tip().textContent);
  check('显示小节名', tip().textContent.includes('梗概') && tip().textContent.includes('关键事件'),
    tip().textContent);
  check('显示小节正文', tip().textContent.includes('雨下了三天'), tip().textContent);
  check('新鲜的摘要不打过期标', !tip().querySelector('.summary-tip-stale'));

  // ---- 鼠标移到浮窗上：一直留着，能滚、能选中复制
  //
  // 从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上。
  // 所以收起有宽限期，中途进了浮窗就撤销。
  hover(ui.doc.querySelector('#projectBody .group-head'));
  check('刚移开时浮窗还在（有宽限期，够鼠标挪过去）', !!tip());
  enterTip();
  await grace();
  check('鼠标停在浮窗上就一直显示', !!tip());
  await grace();
  check('停久了也不会自己消失', !!tip());

  // 浮窗自己内部的滚动不能把它收掉——摘要有六个小节，滚动条是给人用的。
  tip().dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
  check('浮窗内部滚动不收起浮窗', !!tip());

  // 移出浮窗才收。
  leaveTip();
  check('刚离开浮窗时还在（同样有宽限期）', !!tip());
  await grace();
  check('离开浮窗后收起', !tip());

  // ---- 移开就收（没进浮窗的情况）
  ui.sent.length = 0;
  hover(rowWith('楔子'));
  await settle();
  check('再次悬停弹出浮窗', !!tip());
  await moveAway();
  check('移到非章节行、且没进浮窗时收起', !tip());

  // ---- 缓存：同一章再悬停不再发请求
  ui.sent.length = 0;
  hover(rowWith('楔子'));
  await settle();
  check('命中缓存时直接显示，不再请求', !!tip() && !last('requestSummary'), JSON.stringify(ui.sent));
  check('缓存命中时不经过「读取中」', !tip().textContent.includes('读取摘要'), tip().textContent);

  // ---- 滚动 / Esc / 右键都要收（浮窗是 fixed 的，会和目标行脱节）
  ui.doc.getElementById('projectBody').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
  check('滚动收起浮窗', !tip());

  hover(rowWith('楔子'));
  await settle();
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('按 Esc 收起浮窗', !tip());

  hover(rowWith('楔子'));
  await settle();
  rowWith('楔子').dispatchEvent(
    new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 })
  );
  check('右键弹菜单时浮窗让路', !tip());
  closeAnyMenu(ui);

  // ---- 后端重推树 = 磁盘变过，缓存必须作废
  ui.post({ type: 'project', tree: sampleTree() });
  ui.sent.length = 0;
  hover(rowWith('楔子'));
  await settle();
  check('重推树后缓存作废、重新请求', !!last('requestSummary'), JSON.stringify(ui.sent));

  // ---- 过期的摘要必须标出来（照着旧摘要做判断比没摘要更糟）
  ui.post({ type: 'summary', summary: summaryOf({ stale: true }) });
  check('过期的摘要打标', !!tip().querySelector('.summary-tip-stale'));
  check('过期标写着「已过期」',
    tip().querySelector('.summary-tip-stale').textContent === '已过期');
  await moveAway();

  // ---- 没生成过摘要的章节：说清楚，不给空浮窗
  hover(rowWith('楔子'));
  await settle();
  ui.post({
    type: 'summary',
    summary: { order: 1, title: '楔子', exists: false, stale: true, relPath: '', sections: [] },
  });
  check('未总结时给出说明而非空白', tip().textContent.includes('还没有摘要'), tip().textContent);
  check('未总结时不打「已过期」标（说「还没有」就够了）',
    !tip().querySelector('.summary-tip-stale'));
  await moveAway();

  // ---- 摘要是模型写的，一律走 textContent，绝不拼 HTML
  ui.post({ type: 'project', tree: sampleTree() });
  hover(rowWith('楔子'));
  await settle();
  ui.post({
    type: 'summary',
    summary: summaryOf({ sections: [{ name: '梗概', text: '<img src=x onerror=alert(1)>' }] }),
  });
  check('摘要正文不当 HTML 解析', !tip().querySelector('img'), tip().innerHTML);
  check('摘要正文原样显示为文字',
    tip().textContent.includes('<img src=x onerror=alert(1)>'), tip().textContent);
  await moveAway();

  // ---- 定位：浮窗任何时候都不许有一部分落到窗口外面
  //
  // 视口 800×600（上面用 defineProperty 钉住的）。浮窗宽 340，
  // 高度由 tipNaturalHeight 控制，行的位置由 rowRect 控制。
  const showTip = async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({ type: 'summary', summary: summaryOf() });
  };
  /** 浮窗完整落在视口内（留 8px 边距，view.js 的 TIP_MARGIN）。 */
  const insideViewport = () => {
    const b = tipBox();
    return b.top >= 0 && b.left >= 0 && b.bottom <= VIEWPORT.h && b.right <= VIEWPORT.w;
  };

  // ① 常规位置：行在上半屏，浮窗放在行下方
  rowRect = { top: 100, bottom: 120, left: 20 };
  tipNaturalHeight = 200;
  ui.post({ type: 'project', tree: sampleTree() });
  await showTip();
  check('空间够时放在行的下方', tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  check('常规位置整个在视口内', insideViewport(), JSON.stringify(tipBox()));
  await moveAway();

  // ② 行贴近底部：下方放不下 → 翻到上方
  rowRect = { top: 540, bottom: 560, left: 20 };
  tipNaturalHeight = 200;
  ui.post({ type: 'project', tree: sampleTree() });
  await showTip();
  check('行贴底时翻到行的上方', tipBox().bottom <= rowRect.top, JSON.stringify(tipBox()));
  check('翻转后整个在视口内', insideViewport(), JSON.stringify(tipBox()));
  await moveAway();

  // ③ 行贴右边缘：横向往左收，不许右边溢出
  rowRect = { top: 100, bottom: 120, left: 700 };
  tipNaturalHeight = 200;
  ui.post({ type: 'project', tree: sampleTree() });
  await showTip();
  check('贴右边缘时向左收', tipBox().right <= VIEWPORT.w, JSON.stringify(tipBox()));
  check('向左收后仍不越过左边缘', tipBox().left >= 0, JSON.stringify(tipBox()));
  await moveAway();

  // ④ 摘要很长、上下都放不下：压高度进可用空间，靠滚动看剩下的。
  //    只翻转不压高度的话，长摘要在矮窗口里会有一截永远够不到。
  rowRect = { top: 280, bottom: 300, left: 20 };
  tipNaturalHeight = 2000;
  ui.post({ type: 'project', tree: sampleTree() });
  await showTip();
  check('超长摘要被压进可用空间', tipBox().bottom <= VIEWPORT.h, JSON.stringify(tipBox()));
  check('超长摘要不越过顶边', tipBox().top >= 0, JSON.stringify(tipBox()));
  check('压高度靠的是 maxHeight（内容仍可滚动，不是被截掉）',
    parseFloat(tip().style.maxHeight) > 0, tip().style.maxHeight);
  await moveAway();

  // ⑤ 内容后到达导致高度变化时，也要重新收进视口
  rowRect = { top: 500, bottom: 520, left: 20 };
  tipNaturalHeight = 60;
  ui.post({ type: 'project', tree: sampleTree() });
  hover(rowWith('楔子'));
  await settle();
  check('「读取中」的小浮窗放在下方', tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  // 摘要到了，内容一下子撑高——不能就这么支棱到窗口外面去。
  tipNaturalHeight = 400;
  ui.post({ type: 'summary', summary: summaryOf() });
  check('内容到达撑高后重新定位，仍在视口内', insideViewport(), JSON.stringify(tipBox()));
  await moveAway();
}

/**
 * 行内副标题（别名等）的悬停浮窗。同样有悬停延迟，只能等真定时器，
 * 与 summaryTipTests 同列，都归进最后的异步收尾。
 */
async function detailTipTests() {
  console.log('\n== 行内副标题（别名）的悬停浮窗 ==');
  const ui = mount();
  const tip = () => ui.doc.querySelector('.detail-tip');
  const detailOf = (row) => row.querySelector('.row-detail');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等过悬停延迟（detailTip.ts 里是 350ms）。 */
  const settle = () => new Promise((r) => setTimeout(r, 600));
  /** 等过收起的宽限（CLOSE_DELAY_MS 是 150ms）。 */
  const grace = () => new Promise((r) => setTimeout(r, 250));

  // jsdom 里 scrollWidth/clientWidth 恒为 0，截断与否只能靠覆写 getter。
  // 带 data-truncated 的副标题按「内容 300px、可见 50px」算，其余不算截断。
  Object.defineProperty(ui.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.dataset && this.dataset.truncated ? 50 : 0; },
  });
  Object.defineProperty(ui.window.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() { return this.dataset && this.dataset.truncated ? 300 : 0; },
  });

  // 别名多到一行放不下的角色。detail 是「标签 · 别名 …」的完整串，
  // 浮窗要原样端出这一整段。
  const LONG_DETAIL = '反派 · 别名 四娘/老板娘/四姐/沈掌柜/黑心店主/前朝遗孀';
  const tree = sampleTree();
  tree.characters.push({
    kind: 'file', label: '沈四娘',
    relPath: '.novelforge/characters/沈四娘.md', detail: LONG_DETAIL,
  });
  ui.post({ type: 'project', tree });

  check('默认不显示浮窗', !tip());

  // ---- 截断的副标题：悬停后浮窗显示完整别名
  const detail = detailOf(rowWith('沈四娘'));
  detail.dataset.truncated = '1';
  hover(detail);
  check('悬停后不立刻弹出（有延迟，免得划过时闪）', !tip());
  await settle();

  const box = tip();
  check('截断的别名行悬停后弹出浮窗', !!box);
  if (box) {
    check('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）',
      box.parentElement === ui.doc.body);
    check('浮窗显示完整副标题（含全部别名）',
      box.textContent === LONG_DETAIL, box.textContent);
    check('浮窗带独立样式类（只读展示，不吃鼠标）',
      box.classList.contains('detail-tip'), box.className);
  }

  // 光标在副标题上微动（mouseover 冒泡）不该重置延迟导致弹不出来。
  hover(detail);
  await grace();
  check('微动后浮窗仍在', tip() === box);

  // ---- 移开：宽限后收起
  hover(ui.doc.querySelector('#projectBody .group-head'));
  await grace();
  check('移开后浮窗收起', !tip());

  // ---- 全文可见（未截断）的副标题：不弹浮窗
  const liDetail = detailOf(rowWith('林昭'));
  delete liDetail.dataset.truncated;
  hover(liDetail);
  await settle();
  check('未截断的副标题不弹浮窗', !tip());

  // ---- 重渲染把行换掉后，开着的浮窗必须清掉
  liDetail.dataset.truncated = '1';
  hover(liDetail);
  await settle();
  check('截断后又能弹出', !!tip());
  ui.post({ type: 'project', tree });
  check('重渲染后浮窗随之收起', !tip());
}

/**
 * 失败标记（红色感叹号）与它的悬停浮窗。
 *
 * 这是「解析失败只有日志、用户看不到」那个 bug 的界面出口：卡一字未改，
 * 而树上那一行此前与更新成功的一模一样。所以要验的是**看得见**与**说得清**。
 *
 * 与 detailTip 一样有悬停延迟（errorTip.ts 里是 300ms），只能等真定时器，
 * 所以整块是异步的，排在末尾。
 */
async function failureTipTests() {
  console.log('\n== 失败标记与悬停浮窗 ==');
  const ui = mount();
  const tip = () => ui.doc.querySelector('.failure-tip');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const markIn = (text) => {
    const row = rowWith(text);
    return row ? row.querySelector('.row-failure') : null;
  };
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等过悬停延迟（HOVER_DELAY_MS 是 300ms）。 */
  const settle = () => new Promise((r) => setTimeout(r, 550));
  /** 等过收起的宽限（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => new Promise((r) => setTimeout(r, 320));

  const CARD = '.novelforge/characters/林昭.md';
  const CHAPTER = 'chapters/001-楔子.md';

  // ---- 没有失败记录时，树上不该多出任何东西
  ui.post({ type: 'project', tree: sampleTree() });
  check('没有失败记录时不显示感叹号', !markIn('林昭'));
  check('没有失败记录时没有浮窗', !tip());

  // 旧后端推来的树没有 failures 字段，前端不能因此崩。
  const legacy = sampleTree();
  delete legacy.failures;
  let threw = false;
  try {
    ui.post({ type: 'project', tree: legacy });
  } catch {
    threw = true;
  }
  check('缺 failures 字段时不崩', !threw && !!rowWith('林昭'));

  // ---- 有失败记录：对应行挂上感叹号
  const tree = sampleTree();
  tree.failures = {
    [CARD]: [
      {
        at: '2026-08-10T11:31:40.000Z',
        severity: 'error',
        message: '1 批全部解析失败，角色卡未改动',
        detail: '模型没有按要求返回 JSON。换个模型或稍后重试。',
      },
    ],
    [CHAPTER]: [
      { at: '2026-08-10T11:20:00.000Z', severity: 'warn', message: '3 章解析失败，「已读到」只推进到第 2 章' },
    ],
  };
  ui.post({ type: 'project', tree });

  const cardMark = markIn('林昭');
  check('出错的角色行挂上感叹号', !!cardMark);
  check('没出错的角色行没有感叹号', !markIn('李叔'));
  if (cardMark) {
    check('整体失败标红', cardMark.classList.contains('is-error'), cardMark.className);
    // 浮窗要等 300ms，原生 title 作兜底，鼠标一停就有提示。
    check('感叹号带 title 兜底', cardMark.title.includes('未改动'), cardMark.title);
  }
  const chapterMark = markIn('楔子');
  check('出错的章节行也挂上感叹号', !!chapterMark);
  check('部分完成标黄而非标红',
    chapterMark && chapterMark.classList.contains('is-warn'), chapterMark && chapterMark.className);

  // ---- 悬停：延迟后弹浮窗，说清「改没改」与原因
  hover(cardMark);
  check('悬停后不立刻弹出（有延迟，免得划过时闪）', !tip());
  await settle();

  const box = tip();
  check('悬停感叹号后弹出浮窗', !!box);
  if (box) {
    check('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）',
      box.parentElement === ui.doc.body);
    check('浮窗给出失败原因', box.textContent.includes('1 批全部解析失败'), box.textContent);
    check('浮窗给出补充说明', box.textContent.includes('换个模型'), box.textContent);
    // 用户最想知道的一件事：磁盘上的东西动没动。
    check('浮窗点明「未改动」', box.textContent.includes('未改动'), box.textContent);
    check('浮窗告知标记会自动消失', box.textContent.includes('自动消失'), box.textContent);
  }

  // ---- 可进入：详情有好几行、常含模型返回的片段，用户要能选中复制
  box.dispatchEvent(new ui.window.MouseEvent('mouseleave', { bubbles: false }));
  box.dispatchEvent(new ui.window.MouseEvent('mouseenter', { bubbles: false }));
  await grace();
  check('鼠标停在浮窗上时不收起', tip() === box);

  // ---- 移开：宽限后收起
  hover(ui.doc.querySelector('#projectBody .group-head'));
  await grace();
  check('移开后浮窗收起', !tip());

  // ---- 同一目标挂多条：分条画，不是挤成一段
  const multi = sampleTree();
  multi.failures = {
    [CARD]: [
      { at: '2026-08-10T11:31:40.000Z', severity: 'error', message: '角色卡失败' },
      { at: '2026-08-10T10:00:00.000Z', severity: 'warn', message: '摘要也失败了' },
    ],
  };
  ui.post({ type: 'project', tree: multi });
  hover(markIn('林昭'));
  await settle();
  const multiBox = tip();
  check('同一目标的多条各占一块',
    multiBox && multiBox.querySelectorAll('.failure-tip-item').length === 2,
    multiBox && String(multiBox.querySelectorAll('.failure-tip-item').length));
  // 有一条是 error 就按红色算——那比「部分完成」严重，不能被黄色盖过去。
  check('混合严重度时按最严重的标色',
    markIn('林昭').classList.contains('is-error'), markIn('林昭').className);

  // ---- 重渲染把行换掉后，开着的浮窗必须清掉（指向的是已丢弃的节点）
  ui.post({ type: 'project', tree: multi });
  check('重渲染后浮窗随之收起', !tip());

  // ---- 修好之后：后端不再推这条记录，感叹号就该没了
  ui.post({ type: 'project', tree: sampleTree() });
  check('后端不再推记录时感叹号消失', !markIn('林昭'));
}

console.log('\n== 文件页：剪贴板与右键菜单 ==');
{
  const ui = mountExplorer();
  const written = [];
  ui.window.navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
  ui.doc.getElementById('pane-files').classList.add('active');
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);
  // render() 会整批重建行，每次操作后都要重新按名字找行。
  const fileRowOf = (name) => ui.rows().find((r) => r.textContent.includes(name));

  ui.post({ type: 'dirListings', listings: [ui.listing('', { '子目录': 'dir', 'a.md': 'file' })] });

  const fileItems = itemsOf(rightClick(fileRowOf('a.md')));
  check('文件行菜单含剪切/复制/粘贴/重命名',
    ['剪切', '复制', '粘贴', '重命名'].every((l) => fileItems.includes(l)), JSON.stringify(fileItems));
  check('没有剪贴板时粘贴置灰', btn(rightClick(fileRowOf('a.md')), '粘贴').disabled);
  closeAnyMenu(ui);

  // 复制：内部登记 + 路径外送系统剪贴板。
  clickEl(btn(rightClick(fileRowOf('a.md')), '复制'));
  check('复制把路径写进系统剪贴板', written.includes('a.md'), JSON.stringify(written));
  check('粘贴变为可用', !btn(rightClick(fileRowOf('a.md')), '粘贴').disabled);
  closeAnyMenu(ui);

  // 在文件夹行上粘贴：落点是该文件夹。
  clickEl(btn(rightClick(fileRowOf('子目录')), '粘贴'));
  const pasteMsg = last('fileAction');
  check('粘贴发 fileAction',
    pasteMsg && pasteMsg.action === 'paste' && pasteMsg.op === 'copy' &&
    pasteMsg.relPaths.join(',') === 'a.md' && pasteMsg.targetDir === '子目录',
    JSON.stringify(pasteMsg));

  // 复制态在粘贴后保留（可再粘）；重命名走 renameAny。
  check('复制态粘贴后保留', !btn(rightClick(fileRowOf('子目录')), '粘贴').disabled);
  closeAnyMenu(ui);
  clickEl(btn(rightClick(fileRowOf('a.md')), '重命名'));
  const ren = last('fileAction');
  check('重命名发 renameAny', ren && ren.action === 'renameAny' && ren.relPath === 'a.md', JSON.stringify(ren));

  // 剪切 + move 完成后清除剪切态。
  clickEl(btn(rightClick(fileRowOf('a.md')), '剪切'));
  check('剪切后行带 fx-cut 标记',
    ui.rows().some((r) => r.classList.contains('fx-cut')));
  ui.post({ type: 'filesOpDone', op: 'move', results: [{ from: 'a.md', to: '子目录/a.md', ok: true }] });
  check('move 完成后剪切态清除', btn(rightClick(fileRowOf('子目录')), '粘贴').disabled);
  closeAnyMenu(ui);

  // 快捷键：焦点行上 Ctrl+C。
  ui.post({ type: 'dirListings', listings: [ui.listing('', { 'b.md': 'file' })] });
  const bRow = fileRowOf('b.md');
  bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
  check('Ctrl+C 复制焦点行', written.includes('b.md'), JSON.stringify(written));
}

console.log('\n== 内置编辑器：右键菜单与标签搬家 ==');
{
  const ui = mountExplorer();
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];
  /** mountExplorer 不带 file 助手（那是 mountEditor 的），这里就地造一个。 */
  const file = (p, text, extra) =>
    Object.assign({ path: p, name: p.split('/').pop(), text, hash: `h-${p}`, bytes: text.length }, extra);

  ui.post({ type: 'editorOpen', file: file('a.md', '甲的内容') });
  ui.post({ type: 'editorOpen', file: file('b.md', '乙的内容') });
  check('打开了两个标签', tabs().length === 2, String(tabs().length));

  // ---- 标签菜单
  const tabItems = itemsOf(rightClick(tabs()[0]));
  check('标签菜单含关闭/关闭右侧/关闭其它',
    tabItems.includes('关闭') &&
    tabItems.some((l) => l.startsWith('关闭右侧')) &&
    tabItems.some((l) => l.startsWith('关闭其它')),
    JSON.stringify(tabItems));
  clickEl(btn(rightClick(tabs()[0]), tabItems.find((l) => l.startsWith('关闭其它'))));
  check('关闭其它后只剩一个标签', tabs().length === 1, String(tabs().length));
  closeAnyMenu(ui);

  // ---- 正文区菜单
  const area = ui.doc.getElementById('edArea');
  const areaMenu = rightClick(area);
  check('正文区菜单含剪切/复制/粘贴/全选',
    ['剪切', '复制', '粘贴', '全选'].every((l) => itemsOf(areaMenu).includes(l)),
    JSON.stringify(itemsOf(areaMenu)));
  check('无选中时剪切/复制置灰',
    btn(areaMenu, '剪切').disabled && btn(areaMenu, '复制').disabled);
  closeAnyMenu(ui);
  clickEl(btn(rightClick(area), '全选'));
  check('全选选中全文', area.selectionStart === 0 && area.selectionEnd === area.value.length,
    `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
  closeAnyMenu(ui);

  // ---- 标签搬家：未保存草稿原样带走
  area.value = '甲的内容，改了一半';
  area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.window.dispatchEvent(new ui.window.CustomEvent('nf-files-moved', { detail: { from: 'a.md', to: 'sub/a.md' } }));
  const reopen = [...ui.sent].reverse().find((m) => m.type === 'openEditor' && m.path === 'sub/a.md');
  check('搬家后请求打开新路径', !!reopen && reopen.pane === 'main', JSON.stringify(reopen));
  // hash 变了也没关系：moved 标记豁免基线检查。
  ui.post({ type: 'editorOpen', file: Object.assign(file('sub/a.md', '甲的内容'), { hash: 'h-other' }) });
  check('搬家后只剩一个标签且是新路径', tabs().length === 1 && tabs()[0].textContent.includes('a'),
    tabs().map((t) => t.textContent).join(','));
  check('未保存草稿跟着搬', ui.doc.getElementById('edArea').value === '甲的内容，改了一半',
    ui.doc.getElementById('edArea').value);
  check('草稿仍是脏标记', tabs()[0].classList.contains('dirty'));
}

summaryTipTests()
  .then(detailTipTests)
  .then(failureTipTests)
  .then(() => {
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
});
