/**
 * 用真实 DOM（jsdom）跑真正的 media/view.js，验证对话气泡的行为：
 * 流式过程中逐段显示、生成中不可编辑、结束后可编辑，以及 ... 菜单。
 *
 * 这是唯一能覆盖 view.js 的测试——它是纯浏览器脚本，其他 smoke 都碰不到。
 *
 * 用法：node scripts/smoke-view.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

  window.eval(fs.readFileSync(path.join(ROOT, 'media/view.js'), 'utf8'));

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

  window.eval(fs.readFileSync(path.join(ROOT, 'media/editor.js'), 'utf8'));

  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  const file = (p, text, extra) =>
    Object.assign({ path: p, name: p.split('/').pop(), text, hash: `h-${p}`, bytes: text.length }, extra);
  /** 页面上的两块编辑区（主区固定 id，草稿区靠 class 找）。 */
  const panes = () => [...window.document.querySelectorAll('.wb-editor')];
  return { window, doc: window.document, sent, post, file, panes };
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
  const groupHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.textContent.includes('角色'));
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
  /** 移开鼠标：悬停到分组标题栏（不是章节行）即可收起。 */
  const moveAway = () => hover(ui.doc.querySelector('#projectBody .group-head'));
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

  // ---- 移开就收
  moveAway();
  check('移到非章节行收起浮窗', !tip());

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
  moveAway();

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
  moveAway();

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
  moveAway();
}

summaryTipTests().then(() => {
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
});