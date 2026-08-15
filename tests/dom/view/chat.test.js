/**
 * 对话气泡：流式输出、中断与报错、⋯ 菜单、空输入、产物采纳、思考过程。
 *
 * 迁自 scripts/smoke-view.js 的这几节：
 *   == 流式输出 ==（261）           == 中断与报错 ==（300）
 *   == 气泡右上角的 ... 菜单 ==（321） == 生成中的限制 ==（368）
 *   == 空输入 ==（686）             == 产物采纳卡片 ==（828）
 *   == 思考过程（推理模型）==（891）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

describe('流式输出', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    // 控制器的真实顺序：busy=true，然后插一条空回复挂流式内容。
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('先出现一个空的回复气泡', () => {
    assert.ok(ui.bodyOf('a1'), '没有 a1 气泡');
    assert.equal(ui.bodyOf('a1').textContent, '');
  });

  test('第一个 delta 立刻显示', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。', JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('后续 delta 逐段累加', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第二段。' });
    ui.post({ type: 'delta', turnId: 'a1', text: '第三段。' });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。第二段。第三段。',
      JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('流式时带 streaming 标记（显示光标）', () => {
    assert.ok(ui.bubble('a1').classList.contains('streaming'));
  });

  // 生成中不能改：contentEditable 会被后续 delta 冲掉光标，
  // 改到一半的内容也会被 turnDone 的整体重建覆盖。
  test('生成中不可编辑', () => {
    assert.notEqual(ui.bodyOf('a1').getAttribute('contenteditable'), 'true',
      String(ui.bodyOf('a1').getAttribute('contenteditable')));
  });

  test('结束后内容完整', () => {
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '第一段。第二段。第三段。') });
    ui.post({ type: 'busy', value: false });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。第二段。第三段。');
  });

  test('结束后不再显示流式光标', () => {
    assert.ok(!ui.bubble('a1').classList.contains('streaming'));
  });

  test('结束后可以就地编辑', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  // 上一轮的 streaming 状态不能粘在下一轮上。
  test('新一轮回复默认可编辑', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '另一条') });
    assert.equal(ui.bodyOf('a2').getAttribute('contenteditable'), 'true');
  });
});

describe('中断与报错', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'delta', turnId: 'a1', text: '写到一半' });
    // 用户点「停止」：控制器带 interrupted 收尾，busy 落回 false。
    ui.post({ type: 'busy', value: false });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '写到一半', { interrupted: true }) });
  });

  test('中断后保留已生成的内容', () => {
    assert.equal(ui.bodyOf('a1').textContent, '写到一半');
  });

  test('中断后可编辑', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  test('中断后不再显示流式光标', () => {
    assert.ok(!ui.bubble('a1').classList.contains('streaming'));
  });

  test('报错气泡显示错误文案', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '', { error: '连接失败' }) });
    assert.equal(ui.bodyOf('a2').textContent, '连接失败');
  });

  test('报错气泡不可编辑', () => {
    assert.notEqual(ui.bodyOf('a2').getAttribute('contenteditable'), 'true');
  });
});

describe('气泡右上角的 ... 菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  const menuBtn = (id) => ui.bubble(id).querySelector('.msg-menu-btn');
  const linkTexts = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions button')].map((b) => b.textContent);

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    // 带产物：没有 artifact 的回复**行内根本不该有采纳按钮**
    // （落点由后端算，前端猜不出这段话该写到哪一层）。
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '正文', {
        artifact: { where: '第 12 段《夜入青云》 · 正文', summary: '正文 · 1 场', overwrites: false },
      }),
    });
  });

  test('用户气泡有 ... 按钮', () => {
    assert.ok(menuBtn('u1'));
  });

  test('回复气泡有 ... 按钮', () => {
    assert.ok(menuBtn('a1'));
  });

  test('... 按钮在气泡头部（右上角）', () => {
    assert.notEqual(menuBtn('a1').closest('.msg-head'), null);
  });

  // 冗余的行内按钮应该没了。
  test('行内不再有「删除」', () => {
    assert.ok(!linkTexts('a1').includes('删除'), JSON.stringify(linkTexts('a1')));
  });

  test('行内不再有「重新生成」', () => {
    assert.ok(!linkTexts('u1').includes('重新生成'), JSON.stringify(linkTexts('u1')));
  });

  // 采纳/复制是常用动作，仍留在行内。
  test('「采纳写入」仍在行内', () => {
    assert.ok(linkTexts('a1').includes('采纳写入'), JSON.stringify(linkTexts('a1')));
  });

  test('菜单默认不显示', () => {
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });

  test('点击后弹出菜单', () => {
    ui.clickEl(menuBtn('u1'));
    assert.ok(ui.doc.querySelector('.msg-menu'));
  });

  test('用户消息菜单含「重新生成」与「删除」', () => {
    const menu = ui.doc.querySelector('.msg-menu');
    const items = [...menu.querySelectorAll('button')].map((b) => b.textContent);
    assert.ok(items.includes('重新生成') && items.includes('删除'), JSON.stringify(items));
  });

  // 原样保留：这一条靠 `button:last-child` 取「删除」项，而不是按文案找。
  // 它证明的是「菜单最后一项发出 deleteTurn」，**不是**「点『删除』发出
  // deleteTurn」——菜单末尾一加项就会点到别的按钮上去，届时这条要么错误地
  // 通过、要么以一个看不懂的理由失败。
  test('点删除发出 deleteTurn', () => {
    const menu = ui.doc.querySelector('.msg-menu');
    ui.clickEl(menu.querySelector('button:last-child'));
    const del = ui.sent.filter((m) => m.type === 'deleteTurn');
    assert.equal(del.length, 1, JSON.stringify(del));
    assert.equal(del[0].turnId, 'u1', JSON.stringify(del));
  });

  test('操作后菜单关闭', () => {
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });

  // 回复气泡的菜单里不该有「重新生成」（重来是从用户那条分叉的）。
  test('回复消息菜单只有「删除」', () => {
    ui.clickEl(menuBtn('a1'));
    const items2 = [...ui.doc.querySelectorAll('.msg-menu button')].map((b) => b.textContent);
    assert.deepEqual(items2, ['删除'], JSON.stringify(items2));
  });

  // 点别处要能关掉。
  test('点空白处关闭菜单', () => {
    ui.closeMenu();
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });
});

describe('生成中的限制', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'delta', turnId: 'a1', text: '生成中' });
  });

  // 原样保留原实现的空转风险：`regen` 找不到时整个点击被跳过，前后 retry 计数
  // 自然相等，用例照绿。所以这一条证明的是「生成中不会多出一个 retry」，
  // **不能**区分「按钮存在但正确地不响应」与「按钮/菜单压根没出现」。
  test('生成中点「重新生成」不会发起新请求', () => {
    ui.clickEl(ui.bubble('u1').querySelector('.msg-menu-btn'));
    const before = ui.sent.filter((m) => m.type === 'retry').length;
    const regen = [...ui.doc.querySelectorAll('.msg-menu button')]
      .find((b) => b.textContent === '重新生成');
    if (regen) ui.clickEl(regen);
    assert.equal(ui.sent.filter((m) => m.type === 'retry').length, before);
  });
});

describe('空输入', { skip: JSDOM_SKIP }, () => {
  let ui;
  const sends = () => ui.sent.filter((m) => m.type === 'send').length;

  before(() => {
    ui = mount();
  });

  // 讨论的全部内容就是作者那句话，没有话就没有讨论。
  test('讨论仍然要求先输入', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 0);
  });

  // 而「写剧情」不需要作者再说什么——该说的都在大纲里了。
  test('生成类命令允许空输入', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'generate',
      }),
    });
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 1, String(sends()));
  });
});

describe('产物采纳卡片', { skip: JSDOM_SKIP }, () => {
  let ui;
  let acceptSent;
  const acceptBtn = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions .chip-btn')].find((n) => /采纳|覆盖/.test(n.textContent));
  const where = () => ui.bubble('a2').querySelector('.artifact-where');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'generate',
      }),
    });
  });

  // 讨论型回复**不给采纳按钮**：落点由后端算（describeArtifactOf），
  // 前端猜不出这段话该写到哪一层。从前它会被追加进当前章节的正文，
  // 那是单一产物时代留下的入口。
  test('无产物时没有采纳按钮', () => {
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '我建议把冲突提前。') });
    assert.ok(!acceptBtn('a1'),
      [...ui.bubble('a1').querySelectorAll('.msg-actions button')].map((b) => b.textContent).join('|'));
  });

  test('无产物时仍能复制', () => {
    assert.ok([...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .some((b) => b.textContent === '复制'));
  });

  // 产物型回复：说清落点与形状。
  test('产物卡片说明落点', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a2', 'assistant', '{"目标":"进宗门"}', {
        artifact: { where: '第 12 段《夜入青云》 · 剧情', summary: '剧情 · 4/4 节', overwrites: false },
      }),
    });
    assert.ok(where() && where().textContent.includes('第 12 段'), where()?.textContent);
  });

  test('产物卡片说明形状', () => {
    assert.ok(where().textContent.includes('4/4 节'), where().textContent);
  });

  test('未覆盖时按钮是「采纳写入」', () => {
    assert.equal(acceptBtn('a2').textContent, '采纳写入');
  });

  test('采纳产物发 acceptArtifact', () => {
    ui.clickEl(acceptBtn('a2'));
    acceptSent = [...ui.sent].reverse().find((m) => m.type === 'acceptArtifact');
    assert.ok(acceptSent, JSON.stringify(ui.sent.slice(-1)));
  });

  test('带上当前目标', () => {
    assert.equal(acceptSent.target.kind, 'plot');
    assert.equal(acceptSent.target.plotRelPath, '.novelforge/plots/012-夜入青云.md');
  });

  test('带上气泡里的文本', () => {
    assert.equal(acceptSent.text, '{"目标":"进宗门"}', acceptSent.text);
  });

  // 会覆盖已有内容时按钮必须说出来——一个光秃秃的「采纳写入」在四层产物
  // 之下已经不够，用户得知道这一下会盖掉什么。
  test('会覆盖时按钮改文案', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a3', 'assistant', '{"目标":"换一版"}', {
        artifact: { where: '第 12 段《夜入青云》 · 剧情', summary: '剧情 · 4/4 节', overwrites: true },
      }),
    });
    assert.equal(acceptBtn('a3').textContent, '覆盖并写入', acceptBtn('a3').textContent);
  });

  test('会覆盖时按钮标红', () => {
    assert.ok(acceptBtn('a3').classList.contains('danger'));
  });

  // 已采纳过的那一轮不再给按钮，只给「打开」。
  test('已采纳的不再显示采纳按钮', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a4', 'assistant', 'x', {
        artifact: { where: 'y', summary: 'z', overwrites: false },
        acceptedTo: '.novelforge/plans/012-夜入青云.md',
      }),
    });
    assert.ok(!acceptBtn('a4'));
  });

  test('已采纳的显示落点', () => {
    assert.ok(ui.bubble('a4').querySelector('.accepted'));
  });
});

describe('思考过程（推理模型）', { skip: JSDOM_SKIP }, () => {
  let ui;
  let acceptSent;
  const det = () => ui.bubble('a1').querySelector('details.reasoning');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('还没思考时不显示折叠块', () => {
    assert.ok(!det());
  });

  // 推理模型常常先想几十秒才吐正文——这段时间界面必须有东西。
  test('收到思考后出现折叠块', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '先确定场景：' });
    assert.ok(det());
  });

  test('默认是折叠的', () => {
    assert.equal(det().open, false);
  });

  test('思考内容已写入', () => {
    assert.equal(det().querySelector('.reasoning-body').textContent, '先确定场景：');
  });

  test('折叠标题显示字数', () => {
    assert.match(det().querySelector('summary').textContent, /思考过程/);
  });

  test('思考不进正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '', JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('思考期间也显示流式光标', () => {
    assert.ok(ui.bubble('a1').classList.contains('streaming'));
  });

  test('思考增量累加', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '夜里的旧书店。' });
    assert.equal(det().querySelector('.reasoning-body').textContent, '先确定场景：夜里的旧书店。');
  });

  // 用户展开后，后续增量不能把它重新收起来。
  test('展开状态不被后续增量重置', () => {
    det().open = true;
    ui.post({ type: 'reasoning', turnId: 'a1', text: '再补细节。' });
    assert.equal(det().open, true);
  });

  // 正文开始后，思考块仍在，正文只含正文。
  test('正文开始后思考块仍保留', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '灯昏。' });
    assert.ok(det());
  });

  test('正文只含正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '灯昏。');
  });

  test('收尾后思考块还在（从 turn.reasoning 重建）', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '灯昏。', {
        reasoning: '先确定场景：夜里的旧书店。再补细节。',
        artifact: { where: '第 12 段《夜入青云》 · 正文', summary: '正文 · 1 场', overwrites: false },
      }),
    });
    ui.post({ type: 'busy', value: false });
    assert.ok(det());
  });

  test('收尾后默认仍是折叠的', () => {
    assert.equal(det().open, false);
  });

  test('收尾后正文可编辑', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  // 最关键的一条：采纳落盘时绝不能带上思考内容。
  test('采纳的文本不含思考内容', () => {
    const accept = [...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .find((b) => b.textContent === '采纳写入');
    ui.clickEl(accept);
    acceptSent = ui.sent.filter((m) => m.type === 'acceptArtifact').pop();
    assert.ok(acceptSent && !acceptSent.text.includes('先确定场景'),
      acceptSent ? JSON.stringify(acceptSent.text) : '没发出 acceptArtifact');
  });

  test('采纳的文本就是正文', () => {
    assert.ok(acceptSent, '没发出 acceptArtifact');
    assert.equal(acceptSent.text, '灯昏。');
  });

  // 复制同理。
  test('复制按钮存在（不含思考）', () => {
    const copy = [...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .find((b) => b.textContent === '复制');
    assert.ok(copy);
  });

  // 没有思考的普通模型不该多出一个空折叠块。
  test('无思考的回复不出现折叠块', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通输出') });
    assert.ok(!ui.bubble('a2').querySelector('details.reasoning'));
  });
});

describe('命令类消息的气泡', { skip: JSDOM_SKIP }, () => {
  let ui;
  const cmdTag = (id) => ui.bubble(id).querySelector('.msg-command');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plan', chapterRelPath: 'chapters/012-夜入青云.md' },
        stage: 'plan',
        capability: 'generate',
      }),
    });
  });

  // 「生成细纲」不需要作者说什么（该说的都在大纲里），于是 content 是空的。
  // 但气泡不能就这么空着——翻回去看时认不出刚才点的是哪一下。
  test('空输入的命令轮次显示命令名', () => {
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '', { command: '生成细纲' }) });
    assert.ok(cmdTag('u1'), '没有命令标签');
    assert.equal(cmdTag('u1').textContent, '/生成细纲', cmdTag('u1')?.textContent);
  });

  test('气泡不再是一片空白', () => {
    assert.ok(ui.bodyOf('u1').textContent.trim().length > 0, JSON.stringify(ui.bodyOf('u1').textContent));
  });

  // 有补充要求时两样都在：命令一枚标签，正文跟在后面。
  test('带补充要求时命令与正文都显示', () => {
    ui.post({ type: 'turnDone', turn: turn('u2', 'user', '这一章要慢一点', { command: '生成细纲' }) });
    assert.equal(cmdTag('u2').textContent, '/生成细纲');
    assert.equal(ui.bubble('u2').querySelector('.msg-text').textContent, '这一章要慢一点');
  });

  // 讨论是默认动作，后端不给 command——每条消息都挂一枚「/讨论」是纯噪声。
  test('讨论轮次不挂命令标签', () => {
    ui.post({ type: 'turnDone', turn: turn('u3', 'user', '这里冲突太弱') });
    assert.ok(!cmdTag('u3'));
    assert.equal(ui.bodyOf('u3').textContent, '这里冲突太弱');
  });

  // 旧会话里的空轮次（那时命令没被记下来）：留一句说明，别留一片空白。
  test('既无话也无命令时给一句说明', () => {
    ui.post({ type: 'turnDone', turn: turn('u4', 'user', '') });
    assert.ok(ui.bubble('u4').querySelector('.msg-text-empty'), ui.bodyOf('u4')?.textContent);
  });

  // 模型回复那一支必须保持成纯文本节点：流式增量走 textContent += delta，
  // 里面有子元素的话第一片增量就会把它们冲掉。
  test('模型回复里不插结构', () => {
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(ui.bodyOf('a1').children.length, 0, ui.bodyOf('a1').innerHTML);
    assert.equal(ui.bodyOf('a1').textContent, '第一段。');
    ui.post({ type: 'busy', value: false });
  });
});
