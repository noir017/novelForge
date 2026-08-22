/**
 * 技能在界面上的两处：**设置页那张表**，与**输入框那一套**（`/` 面板 + 标签）。
 *
 * 跑的是构建产物 + 真实 DOM，因为这两处的活全在拼装与生命周期上：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 只有改过的档位进 `saveSettings` | 缺省不落盘，日后调缺省时没动过的跟着走 |
 * | 选回缺省 = 把那一项删掉 | 同上，反过来那条路 |
 * | 有未保存的编辑时新技能照旧出现 | 名单是后端重扫的事实，不是作者正在编辑的东西 |
 * | `/` 就地浮出面板，不发 `pickSkill` | 光标不离开正在写的句子 |
 * | 过滤串从输入框的值算 | 输入法打的中文收得到（那一版命令面板的坑） |
 * | 句子中间的 `/` 不弹面板 | 路径、日期、「他/她」都要打得出来 |
 * | 面板开着时 Enter 不发消息 | 挑技能与发送是两件事 |
 * | 标签上的 × 只发消息，不自己先摘 | 正文攒在后端，前端无状态 |
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const settings = (extra) =>
  Object.assign(
    {
      providers: [{ id: 'p', kind: 'openai', models: [{ name: 'cheap' }] }],
      models: ['p/cheap'],
      tierModels: { fast: [], balanced: [], quality: [] },
      taskTiers: {},
      temperature: 0.8,
      recentChaptersFullText: 2,
      prevChapterTailChars: 1500,
      summaryBatchSize: 15,
      requestTimeoutMs: 300000,
      concurrency: 3,
      fallbackAttempts: 2,
      skillModes: {},
    },
    extra
  );

const SKILLS = [
  {
    name: 'builtin:foreshadowing-audit',
    source: 'builtin',
    stem: 'foreshadowing-audit',
    description: '跨章核对伏笔与连续性',
    mode: 'user',
  },
  {
    name: 'project:我的审章流程',
    source: 'project',
    stem: '我的审章流程',
    description: '',
    mode: 'user',
  },
];

describe('设置页：技能那张表', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rows = () => [...ui.doc.querySelectorAll('.skill-row')];
  const nameOf = (i) => rows()[i].querySelector('.skill-name').textContent;
  const selOf = (i) => rows()[i].querySelector('select');
  const save = () => {
    ui.doc.getElementById('saveSettingsBtn').click();
    return [...ui.sent].reverse().find((m) => m.type === 'saveSettings');
  };

  beforeEach(() => {
    ui = mount();
    ui.post({ type: 'settings', settings: settings(), keys: {}, skills: SKILLS });
  });

  test('一份技能一行，显示不带前缀的名字', () => {
    assert.equal(rows().length, 2);
    assert.equal(nameOf(0), 'foreshadowing-audit');
    assert.equal(nameOf(1), '我的审章流程');
  });

  // 同名的两份（内置一份、工程一份）靠这个徽章分得清哪行是哪份。
  test('标出来源', () => {
    assert.equal(rows()[0].querySelector('.skill-source').textContent, '内置');
    assert.equal(rows()[1].querySelector('.skill-source').textContent, '这个工程');
  });

  test('有描述才画那一行', () => {
    assert.ok(rows()[0].querySelector('.skill-desc'));
    assert.equal(rows()[1].querySelector('.skill-desc'), null, '没写描述就不该占一行');
  });

  test('四个档位，缺省那个标着「缺省」', () => {
    const opts = [...selOf(0).options].map((o) => o.value);
    assert.deepEqual(opts, ['user', 'title', 'full', 'off']);
    assert.match([...selOf(0).options].find((o) => o.value === 'user').textContent, /缺省/);
  });

  test('回显后端给的档位', () => {
    ui.post({
      type: 'settings',
      settings: settings({ skillModes: { 'project:我的审章流程': 'full' } }),
      keys: {},
      skills: [SKILLS[0], { ...SKILLS[1], mode: 'full' }],
    });
    assert.equal(selOf(1).value, 'full');
  });

  // 缺省不落盘：日后调整缺省值时，作者没动过的技能跟着新缺省走，
  // 而不是被一份「当年抄下来的缺省」钉死。
  test('只有改过的档位进 saveSettings', () => {
    selOf(1).value = 'title';
    selOf(1).dispatchEvent(new ui.window.Event('change'));
    // 比 entries 而不是整个对象：那份 payload 来自 jsdom 那个 realm，
    // 它的 Object 与这里的不是同一个，deepEqual 会以「结构相同但不同源」报错。
    assert.deepEqual(Object.entries(save().settings.skillModes), [['project:我的审章流程', 'title']]);
  });

  test('选回缺省就把那一项删掉', () => {
    selOf(1).value = 'full';
    selOf(1).dispatchEvent(new ui.window.Event('change'));
    selOf(1).value = 'user';
    selOf(1).dispatchEvent(new ui.window.Event('change'));
    assert.deepEqual(Object.entries(save().settings.skillModes), []);
  });

  // 名单是后端重扫出来的**事实**（作者刚在 .novelforge/skills/ 下加了一份），
  // 不是作者正在编辑的东西——所以它不受 dirty 保护，而他改过的档位不会被冲掉。
  test('有未保存的编辑时，新技能照旧出现，已改的档位不丢', () => {
    selOf(0).value = 'title';
    selOf(0).dispatchEvent(new ui.window.Event('change'));
    ui.post({
      type: 'settings',
      settings: settings(),
      keys: {},
      skills: [...SKILLS, { name: 'project:新写的', source: 'project', stem: '新写的', description: '', mode: 'user' }],
    });
    assert.equal(rows().length, 3);
    assert.equal(nameOf(2), '新写的');
    assert.equal(selOf(0).value, 'title', '未保存的改动被磁盘上的值冲掉了');
  });

  test('一份技能都没有时说句话，不摆一块空白', () => {
    ui.post({ type: 'settings', settings: settings(), keys: {}, skills: [] });
    assert.equal(rows().length, 0);
    assert.match(ui.doc.getElementById('skillList').textContent, /SKILL\.md/);
  });
});

describe('/ 面板', { skip: JSDOM_SKIP }, () => {
  let ui;
  let input;
  const panel = () => ui.doc.querySelector('.skill-panel');
  const rows = () => [...ui.doc.querySelectorAll('.skill-item')];
  const labels = () => rows().map((n) => n.querySelector('.skill-item-label').textContent);
  const activeLabel = () =>
    ui.doc.querySelector('.skill-item.active .skill-item-label')?.textContent;
  const sentOf = (type) => ui.sent.filter((m) => m.type === type);

  /** 打字：改值再发 input 事件，与真实输入一致（面板由 input 驱动）。 */
  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const key = (k) => input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

  beforeEach(() => {
    ui = mount();
    input = ui.doc.getElementById('input');
    ui.post({ type: 'skillList', items: SKILLS });
  });

  // 面板贴在输入框那一格里往上浮：候选与正在打字的地方之间不隔东西。
  // 早一版走宿主的选择器（居中模态框 / QuickPick），那会把光标拽走一次。
  test('空输入框里打 / 就地浮出面板，不发 pickSkill', () => {
    type('/');
    assert.ok(panel(), '面板没出来');
    assert.equal(panel().parentElement.id, 'composerInput');
    assert.equal(sentOf('pickSkill').length, 0, '不该再走宿主的选择器');
  });

  test('打开时重扫一遍名单', () => {
    type('/');
    assert.equal(sentOf('requestSkills').length, 1);
  });

  test('候选带前缀斜杠，显示不带来源前缀那一半', () => {
    type('/');
    assert.deepEqual(labels(), ['/foreshadowing-audit', '/我的审章流程']);
    // 全名（配置里的键、agent 照抄的那一行）在 tooltip 上。
    assert.equal(rows()[0].querySelector('.skill-item-label').title, 'builtin:foreshadowing-audit');
  });

  test('标出来源', () => {
    type('/');
    assert.equal(rows()[0].querySelector('.skill-item-src').textContent, '内置');
    assert.equal(rows()[1].querySelector('.skill-item-src').textContent, '本工程');
  });

  test('有描述才画那一行', () => {
    type('/');
    assert.equal(rows()[0].querySelector('.skill-item-hint').textContent, '跨章核对伏笔与连续性');
    assert.equal(rows()[1].querySelector('.skill-item-hint'), null, '没写描述就不该占一行');
  });

  // 「仅用户」之外的档位 agent 每轮也看得见。作者在设置页改过之后，该在这里认得出来。
  test('开到别的档位时那一行说清 agent 也看得见', () => {
    ui.post({ type: 'skillList', items: [{ ...SKILLS[1], mode: 'title' }] });
    type('/');
    assert.match(rows()[0].querySelector('.skill-item-hint').textContent, /agent 每轮可见（仅标题）/);
  });

  // 过滤串**从输入框的值算出来**，不自己攒——那一版命令面板攒在模块变量里，
  // 于是输入法打的中文一个都收不到（composition 期间不发可打印键的 keydown）。
  test('往后打字就过滤，中文也认', () => {
    type('/审章');
    assert.deepEqual(labels(), ['/我的审章流程']);
  });

  test('描述也参与匹配', () => {
    type('/伏笔');
    assert.deepEqual(labels(), ['/foreshadowing-audit']);
  });

  test('一个都没匹配上时说清楚，不摆一块空白', () => {
    type('/zzz');
    assert.equal(rows().length, 0);
    assert.match(panel().textContent, /没有匹配「zzz」/);
  });

  test('删掉 / 面板就关', () => {
    type('/');
    type('');
    assert.equal(panel(), null);
  });

  // `/` 在中文正文里是普通字符：路径、日期、「他/她」都要打得出来。
  test('句子中间的 / 不弹面板', () => {
    type('看看 chapters/009');
    assert.equal(panel(), null);
  });

  test('/ 后面跟了空格就不再是在挑技能', () => {
    type('/ 这是一句话');
    assert.equal(panel(), null);
  });

  test('↑↓ 移动选中项', () => {
    type('/');
    assert.equal(activeLabel(), '/foreshadowing-audit');
    key('ArrowDown');
    assert.equal(activeLabel(), '/我的审章流程');
    // 到底了绕回第一项——候选很少，绕回比停住更省一次按键。
    key('ArrowDown');
    assert.equal(activeLabel(), '/foreshadowing-audit');
    key('ArrowUp');
    assert.equal(activeLabel(), '/我的审章流程');
  });

  test('Enter 挑中当前项：发 useSkill，只带名字', () => {
    type('/审章');
    key('Enter');
    assert.equal(sentOf('useSkill').length, 1);
    assert.equal(sentOf('useSkill')[0].name, 'project:我的审章流程');
    // 正文攒在后端，前端只递名字。
    assert.deepEqual(Object.keys(sentOf('useSkill')[0]).sort(), ['name', 'type']);
  });

  // 面板开着时 Enter 是「挑这一项」，不是「把 /审章 当成一句话发出去」。
  test('面板开着时 Enter 不发消息', () => {
    type('/审章');
    key('Enter');
    assert.equal(sentOf('sendAgent').length, 0);
  });

  test('挑完那几个字从输入框里收走', () => {
    type('/审章');
    key('Enter');
    assert.equal(input.value, '');
    assert.equal(panel(), null);
  });

  test('点一项也挑得中', () => {
    type('/');
    rows()[1].click();
    assert.equal(sentOf('useSkill')[0].name, 'project:我的审章流程');
  });

  test('Esc 关掉面板，输入框里那个 / 留着', () => {
    type('/审章');
    key('Escape');
    assert.equal(panel(), null);
    assert.equal(input.value, '/审章', '那是作者的字，不替他删');
  });

  // 输入框里那个 `/` 还在，而面板由输入框的值驱动——不记一笔「关过了」，
  // 下一次按键又会把它弹出来。
  test('Esc 关过之后再打字不会自己弹回来', () => {
    type('/审');
    key('Escape');
    type('/审章');
    assert.equal(panel(), null);
  });

  test('删掉 / 之后那一笔清掉，还能再弹', () => {
    type('/审');
    key('Escape');
    type('');
    type('/');
    assert.ok(panel());
  });

  // 按钮与键盘走同一条路：界面上不该有「点按钮弹出来的」和「打 / 弹出来的」两种东西。
  test('那颗按钮把 / 打进空输入框并开面板', () => {
    ui.doc.getElementById('skillBtn').click();
    assert.equal(input.value, '/');
    assert.ok(panel());
  });

  test('按钮再点一次收起', () => {
    ui.doc.getElementById('skillBtn').click();
    ui.doc.getElementById('skillBtn').click();
    assert.equal(panel(), null);
  });

  // 输入框里已经有他正写着的要求时，一个字都不动。
  test('输入框里有别的字时按钮不改那些字', () => {
    input.value = '帮我核一下第 9 章';
    ui.doc.getElementById('skillBtn').click();
    assert.equal(input.value, '帮我核一下第 9 章');
    assert.ok(panel());
  });

  // 面板浮起来正好盖住输入框上方那几枚标签。不标一下的话作者只会再挑一次，
  // 然后收到一句「已经呼出这一份了」。
  test('已经呼出的那一份标出来', () => {
    ui.post({
      type: 'pendingSkills',
      items: [{ name: 'project:我的审章流程', stem: '我的审章流程', source: 'project', chars: 12 }],
    });
    type('/');
    assert.equal(rows()[0].querySelector('.skill-item-held'), null);
    assert.equal(rows()[1].querySelector('.skill-item-held').textContent, '已呼出');
  });

  test('一份能用的技能都没有时说清去哪儿写', () => {
    ui.post({ type: 'skillList', items: [] });
    type('/');
    assert.equal(rows().length, 0);
    assert.match(panel().textContent, /SKILL\.md/);
  });

  // 第一次打 `/` 时名单必然是空的（那一份不在 ready 那一套里），照着「空」画
  // 就会闪一句「一份能用的技能都没有」——那不是缺信息，是给了一句错的。
  test('名单还没到时说的是「正在读取」，不是「一份都没有」', () => {
    const fresh = mount();
    const input2 = fresh.doc.getElementById('input');
    input2.value = '/';
    input2.dispatchEvent(new fresh.window.Event('input', { bubbles: true }));
    const box = fresh.doc.querySelector('.skill-panel');
    assert.match(box.textContent, /正在读取/);
    assert.equal(/SKILL\.md/.test(box.textContent), false);
  });

  // 技能是给**下一句话**用的，生成期间挑一份没有落点。
  test('生成期间那颗按钮停手，开着的面板就地收掉', () => {
    type('/');
    ui.post({ type: 'busy', value: true });
    assert.equal(panel(), null);
    assert.equal(ui.doc.getElementById('skillBtn').disabled, true);
  });
});

describe('输入框上方那几枚标签', { skip: JSDOM_SKIP }, () => {
  let ui;
  const chips = () => [...ui.doc.querySelectorAll('.chips .skill-chip')];
  const sentOf = (type) => ui.sent.filter((m) => m.type === type);

  beforeEach(() => {
    ui = mount();
    ui.post({
      type: 'pendingSkills',
      items: [{ name: 'project:我的审章流程', stem: '我的审章流程', source: 'project', chars: 1234 }],
    });
  });

  test('推来的技能画成标签，字数写在 tooltip 上', () => {
    assert.equal(chips().length, 1);
    const label = chips()[0].querySelector('.chip-label');
    assert.match(label.textContent, /我的审章流程/);
    assert.match(label.title, /1234 字/);
  });

  // 正文攒在后端，前端手上只有名字——所以摘的那一下必须由后端说了算，
  // 前端先摘自己那一份就会与后端分叉（前端无状态那条基本盘）。
  test('× 只发 dropSkill，不自己先摘掉', () => {
    chips()[0].querySelector('.chip-x').click();
    assert.equal(sentOf('dropSkill').length, 1);
    assert.equal(sentOf('dropSkill')[0].name, 'project:我的审章流程');
    assert.equal(chips().length, 1, '前端不该抢在后端前面把标签摘了');
  });

  test('后端推空表才真的没了', () => {
    ui.post({ type: 'pendingSkills', items: [] });
    assert.equal(chips().length, 0);
  });
});

describe('气泡上留下的记录', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'turnDone',
      turn: {
        id: 'u1',
        role: 'user',
        content: '帮我核一下第 9 章',
        at: '2026-08-22T10:00:00.000Z',
        skills: ['project:我的审章流程', 'builtin:foreshadowing-audit'],
      },
    });
  });

  // 作者要看得出「这一轮我让它按哪套方法做的」——那是他判断结果好坏的前提。
  test('这一轮呼出过的技能留成几枚标签', () => {
    const chips = [...ui.doc.querySelectorAll('[data-turn="u1"] .skill-chip')];
    assert.equal(chips.length, 2);
    assert.match(chips[0].textContent, /我的审章流程/);
    // 显示不带前缀那一半；全名在 tooltip 上。
    assert.equal(chips[1].querySelector('.chip-label').title, 'builtin:foreshadowing-audit');
    assert.match(chips[1].textContent, /foreshadowing-audit/);
  });
});
