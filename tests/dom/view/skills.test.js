/**
 * 技能在界面上的两处：**设置页那张表**，与**输入框上方那几枚标签**。
 *
 * 跑的是构建产物 + 真实 DOM，因为这两处的活全在拼装与生命周期上：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 只有改过的档位进 `saveSettings` | 缺省不落盘，日后调缺省时没动过的跟着走 |
 * | 选回缺省 = 把那一项删掉 | 同上，反过来那条路 |
 * | 有未保存的编辑时新技能照旧出现 | 名单是后端重扫的事实，不是作者正在编辑的东西 |
 * | `/` 与那颗按钮都发 `pickSkill` | 两个入口一件事 |
 * | 标签上的 × 只发消息，不自己先摘 | 正文攒在后端，前端无状态 |
 * | 句子中间的 `/` 不弹选择器 | 路径、日期、「他/她」都要打得出来 |
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

describe('输入框：呼出与标签', { skip: JSDOM_SKIP }, () => {
  let ui;
  const chips = () => [...ui.doc.querySelectorAll('.chips .skill-chip')];
  const sentOf = (type) => ui.sent.filter((m) => m.type === type);

  before(() => {
    ui = mount();
  });

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

  test('那颗按钮发 pickSkill', () => {
    ui.doc.getElementById('skillBtn').click();
    assert.equal(sentOf('pickSkill').length, 1);
  });

  test('空输入框里打 / 也发 pickSkill', () => {
    const input = ui.doc.getElementById('input');
    input.value = '';
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(sentOf('pickSkill').length, 1);
  });

  // 句子中间的斜杠是普通字符：路径、日期、「他/她」都要打得出来。
  test('句子中间的 / 不弹选择器', () => {
    const input = ui.doc.getElementById('input');
    input.value = '看看 chapters/009';
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(sentOf('pickSkill').length, 0);
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
