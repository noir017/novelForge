/**
 * 角色卡「当前状态」归谁（D15）与只动那一节的写法。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 空的、指纹对得上 → 机器的 | 批量串行写十章，不能每章弹一次 diff |
 * | 改过、没记过指纹的非空内容 → 作者的 | 第 3 条：不静默覆盖（上游同一口径） |
 * | 只换那一节 | 整卡重渲染会抹掉作者自加的小节 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const state = loadModule('src/core/model/characterState.ts');
const md = loadModule('src/core/model/markdown.ts');

const card = (当前状态, stateHash) => ({ sections: { 当前状态 }, stateHash });

describe('characterState.ts · 归属', () => {
  test('空的一节归机器', () => {
    assert.ok(state.stateOwnedByMachine(card('', undefined)));
    assert.ok(state.stateOwnedByMachine(card('  \n', 'whatever')));
  });

  test('机器盖过章、没人动过 → 机器的', () => {
    const stamped = state.stampState(card('在青崖镇的客栈养伤'), 3);
    assert.equal(stamped.stateThrough, 3);
    assert.ok(state.stateOwnedByMachine(stamped));
  });

  test('首尾空白不算改过', () => {
    const stamped = state.stampState(card('在青崖镇的客栈养伤'), 3);
    assert.ok(state.stateOwnedByMachine({ ...stamped, sections: { 当前状态: '\n在青崖镇的客栈养伤  \n' } }));
  });

  test('作者改过一个字 → 作者的', () => {
    const stamped = state.stampState(card('在青崖镇的客栈养伤'), 3);
    assert.ok(!state.stateOwnedByMachine({ ...stamped, sections: { 当前状态: '在青崖镇的客栈养伤，伤口化脓' } }));
  });

  test('从没记过指纹、却有内容 → 作者的（手写的卡、换轴之前的卡）', () => {
    assert.ok(!state.stateOwnedByMachine(card('在青崖镇', undefined)));
  });

  test('「状态截至第 K 章」的说法', () => {
    assert.equal(state.describeStateThrough(3), '状态截至第 3 章');
    assert.equal(state.describeStateThrough(0), '开篇状态');
    assert.equal(state.describeStateThrough(undefined), '');
  });
});

describe('markdown.ts · replaceSection', () => {
  const CARD = [
    '---',
    'name: 林昭',
    '---',
    '',
    '# 林昭',
    '',
    '## 身份',
    '',
    '孤儿',
    '',
    '## 当前状态',
    '',
    '在客栈',
    '### 细节',
    '左臂有伤',
    '',
    '## 我的笔记',
    '',
    '作者自己加的一节',
    '',
  ].join('\n');

  test('只换那一节（连同它下面的三级标题），其余原样', () => {
    const out = md.replaceSection(CARD, '当前状态', '离开了青崖镇，往北去');
    assert.match(out, /## 当前状态\n\n离开了青崖镇，往北去\n\n## 我的笔记/);
    assert.match(out, /## 身份\n\n孤儿/);
    assert.match(out, /作者自己加的一节/);
    assert.doesNotMatch(out, /左臂有伤/);
  });

  test('最后一节也换得了，结尾只留一个换行', () => {
    const text = '# 林昭\n\n## 当前状态\n\n在客栈\n\n\n';
    assert.equal(md.replaceSection(text, '当前状态', '往北去'), '# 林昭\n\n## 当前状态\n\n往北去\n');
  });

  test('没有这一节就追加在末尾', () => {
    assert.equal(md.replaceSection('# 林昭\n\n## 身份\n\n孤儿\n', '当前状态', '往北去'), '# 林昭\n\n## 身份\n\n孤儿\n\n## 当前状态\n\n往北去\n');
  });

  test('小节名按宽松规则认；CRLF 原样保留', () => {
    const text = '# 林昭\r\n\r\n## 当前 状态：\r\n\r\n在客栈\r\n';
    assert.equal(md.replaceSection(text, '当前状态', '往北去'), '# 林昭\r\n\r\n## 当前 状态：\r\n\r\n往北去\r\n');
  });

  test('空值写占位文字，结构不塌', () => {
    assert.match(md.replaceSection(CARD, '当前状态', ''), /## 当前状态\n\n（待补充）\n\n## 我的笔记/);
  });
});
