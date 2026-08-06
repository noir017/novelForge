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
  const src = fs.readFileSync(path.join(ROOT, 'src/vscode/webviewHtml.ts'), 'utf8');
  const start = src.indexOf('<body>');
  const end = src.indexOf('</body>');
  if (start === -1 || end === -1) {
    throw new Error('webviewHtml.ts 里找不到 <body>，测试需要同步更新');
  }
  return src
    .slice(start + 6, end)
    // 去掉两个 <script src>（模板串里是 ${asset(...)}），脚本我们手动注入。
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

// ---------------------------------------------------------------- 工程页目录树

/** 造一棵三层深的树，覆盖目录 / 章节 / 角色 / 空文件夹四种节点。 */
function sampleTree() {
  return {
    initialized: true, title: '测试', author: '甲', chapterCount: 3, totalWords: 900, staleCount: 1,
    chaptersRoot: 'chapters', charactersRoot: '.novelforge/characters', loreRoot: '.novelforge/lore',
    globalSummaryThrough: 2, styleGuidePath: '.novelforge/style.md',
    outlinePath: '.novelforge/outline.md', globalSummaryPath: '.novelforge/summaries/global.md',
    chapters: [
      { kind: 'dir', label: '第一卷', relPath: 'chapters/第一卷', fileCount: 2, children: [
        { kind: 'dir', label: '深处', relPath: 'chapters/第一卷/深处', fileCount: 1, children: [
          { kind: 'chapter', order: 3, title: '夜访', relPath: 'chapters/第一卷/深处/003-夜访.md',
            wordCount: 300, stale: true, summaryPath: '' },
        ] },
        { kind: 'chapter', order: 2, title: '入镇', relPath: 'chapters/第一卷/002-入镇.md',
          wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/002.md' },
      ] },
      { kind: 'dir', label: '第二卷', relPath: 'chapters/第二卷', fileCount: 0, children: [] },
      { kind: 'chapter', order: 1, title: '楔子', relPath: 'chapters/001-楔子.md',
        wordCount: 300, stale: false, summaryPath: '.novelforge/summaries/001.md' },
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

console.log('\n== 工程页的行内操作 ==');
{
  const ui = mount();
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const icons = (title) => [...ui.doc.querySelectorAll(`#projectBody [title="${title}"]`)];
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  ui.post({ type: 'project', tree: sampleTree() });

  clickEl(icons('重命名')[0]);
  const ren = last('fileAction');
  check('重命名发 fileAction',
    ren && ren.action === 'rename' && ren.relPath.startsWith('chapters/'), JSON.stringify(ren));

  clickEl(icons('移动到…')[0]);
  check('移动发 fileAction', last('fileAction').action === 'move');

  clickEl(icons('删除（移到回收站）')[0]);
  check('删除发 fileAction', last('fileAction').action === 'delete');

  // 文件夹行上的「＋」必须带落点目录，否则会建到区根目录去。
  clickEl(icons('在此新建')[0]);
  const add = last('projectAction');
  check('文件夹上的「＋」带 dir',
    add && add.action === 'newChapter' && add.dir === 'chapters/第一卷', JSON.stringify(add));

  clickEl(icons('新建子文件夹')[0]);
  const mk = last('projectAction');
  check('新建子文件夹带 dir',
    mk && mk.action === 'newFolder' && mk.dir === 'chapters/第一卷', JSON.stringify(mk));

  // 分组标题栏上的按钮，落点是该区根目录。
  const groupAdd = ui.doc.querySelector('#projectBody .group-head [title="新建角色卡"]');
  clickEl(groupAdd);
  const rootAdd = last('projectAction');
  check('分组标题栏的「＋」落点为区根目录',
    rootAdd.action === 'newCharacter' && rootAdd.dir === '.novelforge/characters', JSON.stringify(rootAdd));

  // 点文件名走 openPath：这里挂的是插件的 body（没有 #wbEditor），应当发 openFile。
  const lin = [...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '林昭');
  clickEl(lin);
  const open = last('openFile');
  check('点角色名发 openFile（插件壳无内置编辑器）',
    open && open.path === '.novelforge/characters/林昭.md', JSON.stringify(open));

  // 「文风与摘要」那几行是工程固定文件，不该挂重命名/删除。
  const metaRow = [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes('全书大纲'));
  check('固定元数据行没有重命名/删除',
    metaRow && !metaRow.querySelector('[title="重命名"]') &&
    !metaRow.querySelector('[title="删除（移到回收站）"]'));
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
