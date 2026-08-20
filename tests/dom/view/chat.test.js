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
const { mount, JSDOM_SKIP, turn, emptySession, viewState } = require('../../helpers/dom');

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
        draftId: 'd1',
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

  // 「复制」是常用动作，仍留在行内。写文件的按钮一个都没有——那一问在
  // 产出的当下就问过了（气泡里的权限卡片）。
  test('「复制」仍在行内', () => {
    assert.ok(linkTexts('a1').includes('复制'), JSON.stringify(linkTexts('a1')));
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
  const agentSends = () => ui.sent.filter((m) => m.type === 'sendAgent').length;
  /** 从 `/` 面板挑一个命令，挑完输入框是空的。 */
  const pickCommand = (label) => {
    const input = ui.doc.getElementById('input');
    input.value = '/';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.clickEl([...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes(label)));
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
  });

  // 直接发送走的是 agent，而 agent 的全部输入就是作者那句话——没有话就没得跑。
  test('直接发送仍然要求先输入', () => {
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends() + agentSends(), 0);
  });

  // 而 `/写剧情` 不需要作者再说什么——该说的都在大纲里了。
  test('生成类命令允许空输入', () => {
    pickCommand('写剧情');
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 1, String(sends()));
    assert.equal(ui.last('send').payload.capability, 'generate', JSON.stringify(ui.last('send').payload));
  });
});

describe('产物那一行', { skip: JSDOM_SKIP }, () => {
  let ui;
  /**
   * 气泡上**任何能写文件的按钮**。一个都不该有——写不写在产出的当下就问过了
   * （气泡里那张权限卡片，见 `view/gate.test.js`）。从前这里是「采纳写入 /
   * 覆盖并写入」：一颗可以永远不点的按钮，于是「产物落盘前必须过一遍人」
   * 成了一件可以无限拖延的事。
   */
  const writeBtn = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions button')].find((n) => /采纳|写入|覆盖/.test(n.textContent));
  const where = (id) => ui.bubble(id).querySelector('.artifact-where');

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
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '我建议把冲突提前。') });
    ui.post({
      type: 'turnDone',
      turn: turn('a2', 'assistant', '{"目标":"进宗门"}', {
        artifact: { where: '第 12 段《夜入青云》 · 剧情', summary: '剧情 · 4/4 节', overwrites: false },
      }),
    });
  });

  test('无产物时只有「复制」', () => {
    assert.ok(!writeBtn('a1'),
      [...ui.bubble('a1').querySelectorAll('.msg-actions button')].map((b) => b.textContent).join('|'));
    assert.ok([...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .some((b) => b.textContent === '复制'));
  });

  // 产出过什么仍然看得见：翻回来要认得出「这一轮产出过一份 4 场的场景清单」。
  test('产出过的说清落点与形状', () => {
    assert.ok(where('a2') && where('a2').textContent.includes('第 12 段'), where('a2')?.textContent);
    assert.ok(where('a2').textContent.includes('4/4 节'), where('a2').textContent);
  });

  // ★ 这条就是这次改动本身。
  test('有产物也没有任何写入按钮', () => {
    assert.ok(!writeBtn('a2'),
      [...ui.bubble('a2').querySelectorAll('.msg-actions button')].map((b) => b.textContent).join('|'));
  });

  test('作者当时没同意的标一句「未采纳」', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a3', 'assistant', '{"目标":"换一版"}', {
        artifact: { where: '第 12 段《夜入青云》 · 剧情', summary: '剧情 · 4/4 节', overwrites: true, declined: true },
      }),
    });
    assert.ok(where('a3').textContent.includes('未采纳'), where('a3').textContent);
    assert.ok(!writeBtn('a3'), '未采纳的那一轮更不该有写入按钮');
  });

  test('写进去了的说落点、给「打开」', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a4', 'assistant', 'x', {
        artifact: { where: 'y', summary: 'z', overwrites: false },
        acceptedTo: '.novelforge/plots/012-夜入青云.md',
      }),
    });
    assert.ok(ui.bubble('a4').querySelector('.accepted'));
    assert.ok([...ui.bubble('a4').querySelectorAll('.msg-actions button')].some((b) => b.textContent === '打开'));
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
        draftId: 'd1',
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

  // 最关键的一条：思考内容不是正文——落盘的、复制的都只该是正文。
  // 落盘那一份由后端从 draft 取（前端连文本都不发了），这里守住它的孪生兄弟：
  // 气泡正文里没有思考内容。
  test('气泡正文不含思考内容', () => {
    assert.ok(!ui.bodyOf('a1').textContent.includes('先确定场景'), ui.bodyOf('a1').textContent);
  });

  test('气泡正文就是正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '灯昏。');
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

/**
 * 流式输出时消息流会变高。只在原本贴着底时才跟着滚——翻上去看前面的
 * 气泡不该被每来一段的 delta 拽回底部。
 *
 * jsdom 没有布局，scrollHeight / clientHeight 恒为 0，要自己装一套尺寸。
 */
describe('流式输出时滚动跟随', { skip: JSDOM_SKIP }, () => {
  let ui;
  let box;
  const HEIGHT = 5000;
  const VIEW = 400;
  const BOTTOM = HEIGHT - VIEW;

  function layout(top) {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => VIEW });
    box.scrollTop = top;
  }

  function scrollTo(top) {
    box.scrollTop = top;
    box.dispatchEvent(new ui.window.Event('scroll'));
  }

  before(() => {
    ui = mount();
    box = ui.doc.getElementById('messages');
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    layout(BOTTOM);
  });

  test('贴着底时 delta 跟着滚到底', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('翻上去之后 delta 不再拽回来', () => {
    scrollTo(200);
    ui.post({ type: 'delta', turnId: 'a1', text: '第二段。' });
    assert.equal(box.scrollTop, 200);
  });

  test('思考增量也不拽回来', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '我在想。' });
    assert.equal(box.scrollTop, 200);
  });

  test('再贴回底之后继续跟随', () => {
    scrollTo(BOTTOM);
    ui.post({ type: 'delta', turnId: 'a1', text: '第三段。' });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('切会话即使翻上去也滚到底', () => {
    scrollTo(200);
    ui.post({
      type: 'session',
      session: emptySession({ turns: [turn('u2', 'user', '另一段')] }),
    });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('发送即使翻上去也滚到底', () => {
    ui.post({ type: 'busy', value: false });
    scrollTo(200);
    ui.doc.getElementById('input').value = '再说一句';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(box.scrollTop, HEIGHT);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度下拉框', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    // 档位选项在 renderState 里建（跟模型下拉同一处），所以要先来一条 state。
    ui.post({ type: 'init', state: viewState() });
    ui.post({ type: 'session', session: emptySession() });
  });

  test('五个档位都在，缺省停在「不思考」', () => {
    const select = ui.doc.getElementById('thinkSelect');
    assert.deepEqual(
      [...select.options].map((o) => o.value),
      ['off', 'low', 'medium', 'high', 'max']
    );
    assert.equal(select.value, 'off');
  });

  // 它是会话的属性，所以前端只发意图，值等后端那条 session 消息回填。
  test('换一档发 setThinking，不自己改状态', () => {
    const select = ui.doc.getElementById('thinkSelect');
    select.value = 'high';
    select.dispatchEvent(new ui.window.Event('change'));
    assert.equal(ui.last('setThinking').depth, 'high');
  });

  test('收到会话就回显它那一档（换会话不会串味）', () => {
    ui.post({ type: 'session', session: emptySession({ id: 's2', thinking: 'max' }) });
    assert.equal(ui.doc.getElementById('thinkSelect').value, 'max');
    ui.post({ type: 'session', session: emptySession({ id: 's3', thinking: 'off' }) });
    assert.equal(ui.doc.getElementById('thinkSelect').value, 'off');
  });
});
