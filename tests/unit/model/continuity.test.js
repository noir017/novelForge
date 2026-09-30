/**
 * 连续性事实（D18）：定稿时挂证据、写正文时定位原文，两头都不调模型。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 证据是正文里的原句 | 写正文时要拿它回到正文里逐字定位 |
 * | 事实里的人名不算命中 | 「林昭」两个字不该让任何一句提到林昭的话都当证据 |
 * | 找不到证据的事实丢掉 | 没有原文撑着的「事实」多半是模型编的（上游同） |
 * | 手改的写法都认 | 第 1 条：作者会手改 |
 * | 定位不到的那条报出来 | 第 2 条：调用方要把它降级并写进明细 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('src/core/model/continuity.ts');

const TEXT = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '青鳞从暗处扑出来，他侧身躲开，血顺着左臂往下淌，他把袖子扎紧了。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  '天亮时，林昭离开了青崖镇，往北去了。',
].join('\n\n');

describe('continuity.ts · 挂证据', () => {
  test('找到的是正文里的原句', () => {
    const { facts, dropped } = c.attachEvidence(['林昭左臂被青鳞划伤，血流不止'], TEXT, ['林昭', '沈氏']);
    assert.deepEqual(dropped, []);
    assert.equal(facts.length, 1);
    assert.ok(TEXT.includes(facts[0].evidence), facts[0].evidence);
    assert.match(facts[0].evidence, /左臂/);
  });

  // 人名出现一次之后正文多半换成「他」：只在含人名的句子里找，最该当证据的那句反而找不到。
  test('含人名的句子里没有，就在全部句子里按更严的门槛找', () => {
    const { facts } = c.attachEvidence(['沈氏把残令收进袖中'], TEXT, ['林昭', '沈氏']);
    assert.equal(facts[0].evidence, '她把那块残令收进了袖中。');
  });

  test('含人名的句子优先', () => {
    const text = '沈氏也离开了青崖镇。\n\n天亮时，林昭离开了青崖镇，往北去了。';
    const { facts } = c.attachEvidence(['林昭离开青崖镇'], text, ['林昭', '沈氏']);
    assert.match(facts[0].evidence, /林昭/);
  });

  test('只有人名对得上不算证据', () => {
    const { facts, dropped } = c.attachEvidence(['林昭学会了御剑飞行'], TEXT, ['林昭']);
    assert.deepEqual(facts, []);
    assert.deepEqual(dropped, ['林昭学会了御剑飞行']);
  });

  test('找不到证据的事实丢掉，报出来', () => {
    const { facts, dropped } = c.attachEvidence(['城主暗中投靠了魔教', '林昭离开青崖镇往北'], TEXT, ['林昭']);
    assert.equal(facts.length, 1);
    assert.deepEqual(dropped, ['城主暗中投靠了魔教']);
  });

  test('一章最多留 12 条，多出来的也报出来', () => {
    const many = Array.from({ length: 14 }, () => '林昭离开青崖镇往北');
    const { facts, dropped } = c.attachEvidence(many, TEXT, ['林昭']);
    assert.equal(facts.length, c.CONTINUITY_FACT_LIMIT);
    assert.equal(dropped.length, 2);
  });

  test('模型自己加的「- 」「1.」去掉', () => {
    const { facts } = c.attachEvidence(['- 林昭离开青崖镇往北', '2. 沈氏把残令收进袖中'], TEXT, ['林昭', '沈氏']);
    assert.deepEqual(facts.map((f) => f.statement), ['林昭离开青崖镇往北', '沈氏把残令收进袖中']);
  });
});

describe('continuity.ts · 渲染与读回', () => {
  test('往返', () => {
    const facts = [
      { statement: '林昭左臂受伤', evidence: '血顺着左臂往下淌，他把袖子扎紧了。' },
      { statement: '沈氏收起了残令' },
    ];
    const text = c.renderContinuityFacts(facts);
    assert.equal(text, '- 林昭左臂受伤 〔证据：「血顺着左臂往下淌，他把袖子扎紧了。」〕\n- 沈氏收起了残令');
    assert.deepEqual(c.parseContinuityFacts(text), facts);
  });

  test('手改的写法都认：半角括号、没有引号、没有「- 」', () => {
    const text = [
      '- 林昭左臂受伤 [证据: 血顺着左臂往下淌]',
      '沈氏收起了残令（证据：“她把那块残令收进了袖中”）',
      '',
      '（待补充）',
    ].join('\n');
    assert.deepEqual(c.parseContinuityFacts(text), [
      { statement: '林昭左臂受伤', evidence: '血顺着左臂往下淌' },
      { statement: '沈氏收起了残令', evidence: '她把那块残令收进了袖中' },
    ]);
  });

  test('证据里带引号的对白也读得回来', () => {
    const facts = [{ statement: '沈氏答应了', evidence: '她说：「好。」' }];
    assert.deepEqual(c.parseContinuityFacts(c.renderContinuityFacts(facts)), facts);
  });
});

describe('continuity.ts · 写正文时定位原文', () => {
  test('取命中那一段与前后各一段', () => {
    const { passages, hits } = c.locateEvidence(TEXT, ['她把那块残令收进了袖中']);
    assert.deepEqual(hits, [true]);
    assert.equal(passages.length, 1);
    assert.match(passages[0], /血顺着左臂/);
    assert.match(passages[0], /天亮时/);
    assert.doesNotMatch(passages[0], /雨下了一整夜/);
  });

  test('相邻的窗口合并成一段，不重复', () => {
    const { passages } = c.locateEvidence(TEXT, ['血顺着左臂往下淌', '她把那块残令收进了袖中']);
    assert.equal(passages.length, 1);
    assert.equal(passages[0], TEXT);
  });

  test('空白不计：正文换了行也认得', () => {
    const { hits } = c.locateEvidence(TEXT.replace('往下淌，', '往下淌，\n'), ['血顺着左臂往下淌，他把袖子扎紧了']);
    assert.deepEqual(hits, [true]);
  });

  test('作者改过正文：那一句报找不到', () => {
    const { passages, hits } = c.locateEvidence(TEXT, ['他拔出了剑', '天亮时，林昭离开了青崖镇']);
    assert.deepEqual(hits, [false, true]);
    assert.equal(passages.length, 1);
  });
});
