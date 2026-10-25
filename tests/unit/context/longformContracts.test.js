/**
 * 百章实验复盘写进提示词的几条约束：大纲一章一条、终局级事件只发生一次、境界有变化写明；细纲以既成事实为准；
 * 摘要记境界变化与毁掉的东西；正文以定稿事实为准。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/context/prompts.ts');
const sp = loadModule('src/core/features/summarizePrompt.ts');

describe('长篇约束 · 提示词', () => {
  test('大纲：一章一条、终局级事件只发生一次、境界有变化的那一章写明', () => {
    const c = p.buildOutputContract({ stage: 'outline', capability: 'generate' }, { range: { from: 1, to: 20 } });
    assert.match(c, /严格使用「## 第N章：标题」的格式/);
    assert.match(c, /不要写成「## 第a–b章」把几章合成一节/);
    assert.match(c, /这几章一章一条，一条都不能少/);
    assert.match(c, /终局级事件.*全书只发生一次：写明发生在哪一章/);
    assert.match(c, /主角境界或关键资源有变化的那一章写明变成什么/);
  });

  test('细纲（非开篇）：前面定稿的事实是既成历史，终局级事件不再排', () => {
    const c = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 6, to: 10 } });
    assert.match(c, /既成历史/);
    assert.match(c, /不得再排一次/);
    const first = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 1, to: 5 } });
    assert.doesNotMatch(first, /既成历史/);
  });

  test('摘要：境界变化、毁掉的东西都记进连续性事实', () => {
    assert.match(sp.SUMMARY_SYSTEM, /境界、等级或能力在本章有变化/);
    assert.match(sp.SUMMARY_SYSTEM, /已经毁掉的地方、阵法、法宝也要记/);
  });
});

describe('长篇约束 · 本章边界里的禁用词', () => {
  test('第一次调用：点名不许用的词', () => {
    const c = p.buildOutputContract({ stage: 'manuscript', capability: 'generate' }, { banned: ['能量', '神经'] });
    assert.match(c, /- 禁用词：「能量」「神经」一个都不用/);
  });

  test('续写那一轮：说清已经用了哪几个、几次', () => {
    const step = { kind: 'continuation', tail: '……', written: 700, recovery: false, banned: [{ term: '能量', count: 2 }] };
    const c = p.buildOutputContract({ stage: 'manuscript', capability: 'generate' }, { banned: ['能量'], step });
    assert.match(c, /- 禁用词：已写部分用了「能量」2 次，续写部分不许再用/);
  });

  test('比喻词上限把「如同」也算进去', () => {
    assert.ok(p.ANTI_AI_RULES.some((r) => r.includes('「如同」') && r.includes('全章合计不超过 3 次')));
  });
});

// 叙事线二期（设计稿「二」）：细纲照着线排，计划写进每章的叙事线那一节（转写成 threads）；原来那句「伏笔强制回收与释放」并进这一条。
describe('长篇约束 · 细纲合同里的叙事线', () => {
  const plot = (capability, facts) => p.buildOutputContract({ stage: 'plot', capability }, facts);

  test('批次：照着「叙事线」排，标着「本批要收」/「已过第 N 章」的必须在本批收，收不了写明推迟到第几章', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.ok(c.includes('【叙事线】'), c);
    assert.match(c, /标着「本批要收」或「已过第 N 章，还没收」的伏笔，必须安排在本批某一章「收」/);
    assert.match(c, /写明「〈伏笔名〉推迟到第 N 章收」和为什么/);
    assert.match(c, /前面章节留下的危机，这里该引爆或解决的要引爆或解决/);
    assert.doesNotMatch(c, /伏笔强制回收/);
  });

  // 复跑之后：模型只排「推进」，到期该埋的三条一条也没排；给没到期的伏笔写了「推迟」；另起了一条换了名字的新伏笔。
  test('批次：标着「本批要埋」/「还没埋」的必须在本批埋；收只能排在埋之后；推迟只给要埋、要收的用；已有的伏笔不另起', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.match(c, /标着「本批要埋」或「还没埋」的伏笔，必须安排在本批某一章「埋」/);
    assert.match(c, /写明「〈伏笔名〉推迟到第 N 章埋」和为什么/);
    assert.match(c, /「收」只能排在「埋」之后/);
    assert.match(c, /「推迟到第 N 章」只给上面标着要埋、要收的伏笔用；没标的伏笔不写推迟/);
    assert.match(c, /上面已经有的伏笔不要换个名字再起一条新的/);
    assert.match(plot('generate', { no: 6 }), /标着「本章要埋」或「还没埋」的伏笔，必须安排在本章「埋」/);
  });

  test('单章与落定说「本章」，一字不差（第 22 条）', () => {
    const single = plot('generate', { no: 6 });
    assert.match(single, /标着「本章要收」或「已过第 N 章，还没收」的伏笔，必须安排在本章「收」/);
    assert.match(single, /照着排，并把本章在线上计划发生的事写在「### 叙事线」小标题下：/);
    assert.equal(plot('settle', { no: 6 }), single);
  });

  // 细纲试点（2026-10-25）：写细纲的模型按小标题写，不写 JSON；JSON 合同挪给转写那一步。
  test('输出格式：九个小标题，叙事线五种类型、一章最多 6 条，埋新伏笔写明第几章前收；不写 JSON', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.match(c, /每章下面依次是这九个小标题，一个都不能少，哪一节没有内容就写「无」：梗概、出场人物、时间地点、关键事件、看点、状态变更、叙事线、新角色、设定。/);
    assert.match(c, /- 叙事线：本章在叙事线上的计划，一条一行、行首写「- 」，最多 6 条。每条写清：哪条线（照抄线名）；是推进、关系、收束（这条线走完了）、埋、收哪一种/);
    assert.match(c, /埋一条新伏笔再写明计划第几章前收/);
    assert.match(c, /不写 JSON。/);
    assert.doesNotMatch(c, /\{"blueprints"/);
  });

  test('转写合同：threads 五种类型，foreshadowing 只在埋、收时给，resolve 只在原文写了时给；文字一律照抄', () => {
    const c = p.blueprintJsonContract({ from: 6, to: 10 });
    assert.match(c, /threads：「叙事线」一节，一条一项 \{"line":"线名","type":"推进\|关系\|收束\|埋\|收","foreshadowing":"伏笔名","what":"这一章在这条线上发生什么","resolve":N\}/);
    assert.match(c, /foreshadowing 只在埋、收时给；resolve 只在原文写了第几章前收时给/);
    assert.match(c, /文字一律从原文照抄：不改写、不总结、不润色/);
    assert.match(c, /原文写的是第 6–10 章，一章一项/);
  });
});
