/**
 * 设置页「技能」：阶段绑定、从 GitHub 检查与安装、技能库。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 切到这一页就重扫一次；「保存设置」藏起来 | 这一页改了当场生效 |
 * | 四个阶段各一个下拉框，只列兼容的 | 不兼容的绑不上 |
 * | 内置的只在所属阶段列（已绑的照列）；其余按建议阶段分两组 | 三份「去 AI 味」别挤在同一个下拉框里 |
 * | 绑着却找不到的照实显示 | 别让下拉框装作「不带」 |
 * | 没打开工程时下拉框不能动，说清为什么 | 绑定跟着工程走 |
 * | 检查结果带正文；装不了时「确认安装」按不下去 | 装之前看得到写了什么 |
 * | 装好之后检查卡收起 | 免得以为还要再点一次 |
 * | 只有我的技能库的能卸载，本工程的点得开 | 内置删不掉，本工程的作者自己删 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

/** jsdom 那一侧造的对象原型不同，deepEqual 前先转成本侧的普通对象。 */
const plain = (m) => (m === undefined ? m : JSON.parse(JSON.stringify(m)));

const row = (over) =>
  Object.assign(
    {
      id: 'builtin:a',
      source: 'builtin',
      name: 'a',
      label: '甲',
      description: '说明',
      suggestedStage: 'planning',
      compatible: true,
      reasons: [],
      bytes: 120,
      boundTo: [],
    },
    over
  );

const VIEW = {
  rows: [
    row({}),
    row({ id: 'user:b', source: 'user', name: 'b', label: '乙', boundTo: ['drafting'] }),
    row({ id: 'project:c', source: 'project', name: 'c', label: '丙', compatible: false, reasons: ['依赖脚本'], relPath: '.novelforge/skills/c/SKILL.md' }),
    row({ id: 'builtin:d', name: 'd', label: '丁', suggestedStage: 'drafting' }),
  ],
  bindings: { drafting: 'user:b', review: 'user:gone', refinement: 'builtin:a' },
  problems: [],
  userDir: '/home/x/.novelforge/skills',
};

describe('设置页：技能', { skip: JSDOM_SKIP }, () => {
  let ui;
  const $ = (sel) => ui.doc.querySelector(sel);
  const select = (stage) => $(`select[data-skill-stage="${stage}"]`);
  const lastSent = (type) => plain([...ui.sent].reverse().find((m) => m.type === type));

  before(() => {
    ui = mount();
    ui.post({ type: 'skills', view: VIEW });
  });

  test('切到「技能」：发一次重扫，「保存设置」藏起来', () => {
    $('#settingsTabSkills').click();
    assert.ok(lastSent('requestSkills'));
    assert.ok(!$('#settingsPanelSkills').hidden && $('#settingsSaveRow').hidden);
  });

  test('切回别的页，「保存设置」回来', () => {
    $('#settingsTabContext').click();
    assert.ok(!$('#settingsSaveRow').hidden);
    $('#settingsTabSkills').click();
  });

  test('四个阶段各一个下拉框', () => {
    assert.deepEqual(
      [...ui.doc.querySelectorAll('#skillBindings select')].map((s) => s.dataset.skillStage),
      ['planning', 'drafting', 'review', 'refinement']
    );
  });

  test('下拉框只列兼容的，回显当前绑定', () => {
    const s = select('planning');
    assert.deepEqual([...s.options].map((o) => o.value), ['', 'builtin:a', 'user:b']);
    assert.equal(select('drafting').value, 'user:b');
  });

  test('内置的只在所属阶段列；本阶段建议的与其他的分两组', () => {
    const s = select('drafting');
    assert.deepEqual(
      [...s.querySelectorAll('optgroup')].map((g) => [g.label, [...g.children].map((o) => o.value)]),
      [
        ['本阶段建议', ['builtin:d']],
        ['其他技能', ['user:b']],
      ]
    );
  });

  test('内置的绑在别的阶段上照列', () => {
    const s = select('refinement');
    assert.deepEqual([...s.options].map((o) => o.value), ['', 'builtin:a', 'user:b']);
    assert.equal(s.value, 'builtin:a');
  });

  test('绑着却找不到的照实显示', () => {
    const s = select('review');
    assert.equal(s.value, 'user:gone');
    assert.equal(s.selectedOptions[0].textContent, 'user:gone（找不到了，不会带）');
  });

  test('改下拉框当场发绑定；选「不带」发 null', () => {
    const s = select('planning');
    s.value = 'builtin:a';
    s.dispatchEvent(new ui.window.Event('change'));
    assert.deepEqual(lastSent('bindSkill'), { type: 'bindSkill', stage: 'planning', id: 'builtin:a' });
    s.value = '';
    s.dispatchEvent(new ui.window.Event('change'));
    assert.equal(lastSent('bindSkill').id, null);
  });

  test('技能库一份一行，不兼容的写原因', () => {
    const cards = [...ui.doc.querySelectorAll('#skillList .skill-card')];
    assert.equal(cards.length, 4);
    assert.ok(cards[2].textContent.includes('依赖脚本'), cards[2].textContent);
    assert.equal($('#skillCount').textContent, '4 份');
  });

  test('写明本工程绑在哪个阶段', () => {
    assert.ok($('[data-skill-id="user:b"]').textContent.includes('本工程绑在：写正文'));
  });

  test('只有我的技能库的能卸载', () => {
    const buttons = (id) => [...$(`[data-skill-id="${id}"]`).querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual([buttons('builtin:a'), buttons('user:b'), buttons('project:c')], [[], ['卸载'], ['打开']]);
  });

  test('点卸载发 uninstallSkill，点打开发 openFile', () => {
    $('[data-skill-id="user:b"] button').click();
    assert.deepEqual(lastSent('uninstallSkill'), { type: 'uninstallSkill', id: 'user:b' });
    $('[data-skill-id="project:c"] button').click();
    assert.deepEqual(lastSent('openFile'), { type: 'openFile', path: '.novelforge/skills/c/SKILL.md' });
  });

  test('技能库在哪写在提示里', () => {
    assert.ok($('#skillLibraryHint').textContent.includes('/home/x/.novelforge/skills'));
  });
});

describe('设置页：技能 · 检查与安装', { skip: JSDOM_SKIP }, () => {
  let ui;
  const $ = (sel) => ui.doc.querySelector(sel);
  const URL = 'https://github.com/o/r';
  const inspection = (over) =>
    Object.assign(
      {
        url: URL,
        resolvedUrl: 'https://raw.githubusercontent.com/o/r/main/SKILL.md',
        name: 'scene',
        label: '场面写法',
        description: '写场面',
        suggestedStage: 'drafting',
        bytes: 30,
        body: '每一场都要有一个选择。',
        blockers: [],
      },
      over
    );

  before(() => {
    ui = mount();
    ui.post({ type: 'skills', view: { ...VIEW, bindings: undefined } });
  });

  test('没打开工程：下拉框不能动，说清为什么', () => {
    assert.ok([...ui.doc.querySelectorAll('#skillBindings select')].every((s) => s.disabled));
    assert.ok($('#skillBindingHint').textContent.includes('先打开一个工程'));
  });

  test('点检查：发 inspectSkill，按钮变成「检查中…」', () => {
    $('#skillUrl').value = URL;
    $('#inspectSkillBtn').click();
    assert.deepEqual(plain([...ui.sent].reverse().find((m) => m.type === 'inspectSkill')), { type: 'inspectSkill', url: URL });
    assert.ok($('#inspectSkillBtn').disabled && $('#inspectSkillBtn').textContent === '检查中…');
  });

  test('检查结果带正文，按钮复原', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection() });
    assert.equal($('#skillInspection pre').textContent, '每一场都要有一个选择。');
    assert.ok(!$('#inspectSkillBtn').disabled);
  });

  test('可以装：点「确认安装」发 installSkill', () => {
    $('#installSkillBtn').click();
    assert.deepEqual(plain([...ui.sent].reverse().find((m) => m.type === 'installSkill')), { type: 'installSkill', url: URL });
  });

  test('装不了：写原因，「确认安装」按不下去', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection({ blockers: ['不是自包含的提示词（依赖脚本）'] }) });
    assert.ok($('#installSkillBtn').disabled);
    assert.ok($('#skillInspection').textContent.includes('依赖脚本'));
  });

  test('检查失败：说出原因', () => {
    ui.post({ type: 'skillInspection', url: URL, error: '查不到这个 GitHub 仓库（HTTP 404）' });
    assert.equal($('#skillInspection').textContent, '检查失败：查不到这个 GitHub 仓库（HTTP 404）');
  });

  test('装好之后：检查卡收起，地址框清空', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection() });
    ui.post({ type: 'skills', view: VIEW, installed: 'user:scene' });
    assert.deepEqual([$('#skillInspection').childElementCount, $('#skillUrl').value], [0, '']);
  });
});
