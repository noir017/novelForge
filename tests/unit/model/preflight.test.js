/**
 * 一致性预检（五期）：细纲把角色卡上已经死了的人排进本章，写之前先说一声。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 句首是终态说法才算 | 「险些丧命」「为已死的师父报仇」不是这个人死了 |
 * | 带主语、「已 / 于第 k 章 / 被……」前缀的照认 | 卡上的状态是各种写法 |
 * | 按名字与别名认卡 | 细纲里写的可能是别名 |
 * | 状态写到本章或更晚的不判 | 重写早前的章时，那个「已死亡」说的可能正是本章以后的事 |
 * | 没记过写到第几章的手写卡照判 | 宁可误报一条让作者点一下，也别漏报 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/model/preflight.ts');

describe('preflight.ts · 终态判定', () => {
  const dead = [
    '已死亡',
    '已死亡（第 5 章被沈秋刺杀）',
    '身亡',
    '于第五章中身亡',
    '第3章末战死',
    '被沈秋一剑刺死，尸体留在渡口',
    '已被处决',
    '早已死去多年',
    '他已经死了',
    '重伤不治，已于第 4 章去世',
    '死于青崖镇的大火',
    '确认死亡',
  ];
  for (const s of dead) {
    test(`算：${s}`, () => assert.ok(p.terminalClause(s)));
  }

  const alive = [
    '左臂重伤，被关押在地牢',
    '险些丧命，被沈氏救下',
    '假死脱身，藏在城西',
    '为已死的师父报仇，一路北上',
    '生死未卜',
    '疑似身亡，下落不明',
    '死守城门三日',
    '传言已死，其实在京城',
    '濒临死亡，昏迷不醒',
  ];
  for (const s of alive) {
    test(`不算：${s}`, () => assert.equal(p.terminalClause(s), undefined));
  }

  test('以自己的名字开头也认', () => {
    assert.equal(p.terminalClause('沈秋已于第五章身亡', ['沈秋']), '沈秋已于第五章身亡');
  });

  test('判出来的是那一句，不是整段', () => {
    assert.equal(p.terminalClause('左臂重伤；已死亡，尸体未寻回'), '已死亡');
  });
});

describe('preflight.ts · 找风险', () => {
  const cards = [
    { name: '沈秋', aliases: ['阿秋'], state: '已死亡（第 2 章被刺杀）', stateThrough: 2, relPath: 'c/沈秋.md' },
    { name: '林昭', aliases: [], state: '左臂受伤，往北去了', stateThrough: 2 },
    { name: '老周', aliases: [], state: '病逝' },
  ];

  test('细纲里排着的死人：一条', () => {
    const risks = p.findPreflightRisks({ no: 3, planned: ['林昭', '阿秋'], cards });
    assert.equal(risks.length, 1);
    assert.equal(risks[0].name, '沈秋');
    assert.equal(risks[0].through, 2);
    assert.equal(risks[0].relPath, 'c/沈秋.md');
    assert.equal(p.describeRisk(risks[0]), '沈秋的当前状态（截至第 2 章）写着「已死亡」，本章细纲仍安排这个人出场');
  });

  test('状态已经写到本章或更晚：不判', () => {
    assert.deepEqual(p.findPreflightRisks({ no: 2, planned: ['沈秋'], cards }), []);
    assert.deepEqual(p.findPreflightRisks({ no: 1, planned: ['沈秋'], cards }), []);
  });

  test('没记过写到第几章的手写卡照判', () => {
    const risks = p.findPreflightRisks({ no: 1, planned: ['老周'], cards });
    assert.equal(risks.length, 1);
    assert.match(p.describeRisk(risks[0]), /^老周的当前状态写着「病逝」/);
  });

  test('没有卡的人不查；同一个人名字与别名都排了只报一次', () => {
    assert.deepEqual(p.findPreflightRisks({ no: 5, planned: ['路人甲'], cards }), []);
    assert.equal(p.findPreflightRisks({ no: 5, planned: ['沈秋', '阿秋'], cards }).length, 1);
  });

  test('开篇状态的说法', () => {
    const risks = p.findPreflightRisks({ no: 1, planned: ['甲'], cards: [{ name: '甲', aliases: [], state: '身亡', stateThrough: 0 }] });
    assert.match(p.describeRisk(risks[0]), /（开篇状态）/);
  });
});

// 五期补遗 §2：永久放行记在细纲 frontmatter 的 `preflightOk` 里，一行「名字：理由」。
describe('preflight.ts · 永久放行', () => {
  const plotFile = loadModule('src/core/model/plotFile.ts');
  const risks = p.findPreflightRisks({
    no: 8,
    planned: ['沈秋', '李叔'],
    cards: [
      { name: '沈秋', aliases: [], state: '已死亡', stateThrough: 5 },
      { name: '李叔', aliases: [], state: '已于第 6 章病逝', stateThrough: 6 },
    ],
  });

  test('记过的人分出去，带着理由；没记过的照旧是风险', () => {
    const r = p.splitExempt(risks, [{ name: '沈秋', reason: '回忆里的一场' }]);
    assert.deepEqual(r.risks.map((x) => x.name), ['李叔']);
    assert.equal(r.exempted.length, 1);
    assert.equal(r.exempted[0].risk.name, '沈秋');
    assert.match(p.describeExempted(r.exempted[0]), /沈秋按你记下的安排放行（回忆里的一场）。要撤销，删掉这一章细纲 preflightOk 里那一行/);
  });

  test('没写理由也算放行', () => {
    const r = p.splitExempt(risks, [{ name: '李叔', reason: '' }]);
    assert.deepEqual(r.risks.map((x) => x.name), ['沈秋']);
    assert.match(p.describeExempted(r.exempted[0]), /（没写理由）/);
  });

  test('「名字：理由」解析：全角半角冒号都认，没冒号整行是名字，同名只留第一条', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(plotFile.parsePreflightOk(['沈秋：回忆', '李叔:托梦', '王五', '沈秋：又一条', '  ']))), [
      { name: '沈秋', reason: '回忆' },
      { name: '李叔', reason: '托梦' },
      { name: '王五', reason: '' },
    ]);
    assert.deepEqual(plotFile.renderPreflightOk([{ name: '沈秋', reason: '回忆' }, { name: '王五', reason: '' }]), ['沈秋：回忆', '王五']);
  });

  test('细纲读回来带着它；渲染时给了才写', () => {
    const empty = plotFile.emptyPlotSections();
    const base = { no: 8, title: '渡口', role: '', characters: ['沈秋'], upstreamHash: '', done: false, sections: { ...empty, 关键事件: '事' } };
    const withOk = plotFile.renderPlotFile({ ...base, preflightOk: [{ name: '沈秋', reason: '回忆' }] });
    assert.match(withOk, /preflightOk: \[沈秋：回忆\]/);
    assert.deepEqual(JSON.parse(JSON.stringify(plotFile.parsePlotFile(withOk, '.novelforge/plots/008-渡口.md').preflightOk)), [{ name: '沈秋', reason: '回忆' }]);
    assert.doesNotMatch(plotFile.renderPlotFile(base), /preflightOk/);
  });
});
