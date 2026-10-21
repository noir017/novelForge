/**
 * 「暗设」写进提示词的几条规矩（完善设定，2026-10-19）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 细纲合同：不揭开就不写进梗概 / 关键事件 / 看点 / 第九节 note，要铺垫写成 threads 里的一条「埋」（叙事线二期，原来写进新增伏笔），揭开写明「揭开：……」 | 细纲进写正文的上下文，正文看不见暗设，揭开只能从细纲知道 |
 * | 写细纲、落定细纲、批量拆细纲是同一句 | 第 22 条：几条路输出一字不差 |
 * | 大纲合同同一个口径 | 大纲覆盖这一章的那几节也进写正文的上下文（正文配方的 `outlineSlice`） |
 * | 提示词指的标记与上下文里写的是同一个 | 两边各写一份，改一边就对不上 |
 * | 建条目 / 整合：暗设原样留作第四节、≤200 字、不算进 600；正文揭开的挪回明面；建条目不写暗设 | 第 27 条：条目不能无限膨胀，机器只并不删作者的字 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/context/prompts.ts');
const lp = loadModule('src/core/features/lorePrompt.ts');
const lf = loadModule('src/core/model/loreFile.ts');

const MARK = '「暗设（读者还不知道）」';

describe('细纲合同里的暗设', () => {
  const plot = (capability, facts) => p.buildOutputContract({ stage: 'plot', capability }, facts);

  test('不揭开就别写进去，要铺垫写成 threads 里的一条「埋」，揭开写明「揭开：……」', () => {
    const c = plot('generate', { no: 6 });
    assert.ok(c.includes('【暗设】'), c);
    // 角色卡的暗设（叙事线重做第 10 个提交）同一个标题、同一条规矩。
    assert.ok(c.includes(`上面「相关世界观设定」「相关角色设定」里标着${MARK}的，是读者还不知道的真相`), c);
    assert.match(c, /不打算在这一章揭开：别写进 synopsis、keyEvents、highlights，settings 的 note 也不写/);
    // 叙事线二期：伏笔并进了叙事线，铺垫的去向从细纲的「新增伏笔」换成叙事线计划里的一条「埋」。
    assert.match(c, /要铺垫，写成 threads 里的一条「埋」，what 只写读者看得到的那一面/);
    assert.ok(!c.includes('foreshadowing 是字符串数组'), c);
    assert.match(c, /keyEvents 里单列一条「揭开：……」/);
  });

  test('写细纲、落定细纲、批量拆细纲同一句（第 22 条）', () => {
    const single = plot('generate', { no: 6 });
    assert.equal(plot('settle', { no: 6 }), single);
    const rule = single.slice(single.indexOf('【暗设】')).split('\n\n')[0];
    assert.ok(plot('generate', { range: { from: 6, to: 10 } }).includes(rule));
  });

  test('标记与上下文里写的同一个', () => {
    assert.equal(`「${lf.LORE_HIDDEN_MARK}」`, MARK);
  });
});

describe('大纲合同里的暗设', () => {
  test('哪一节揭开写明「揭开：……」，之前只写读者看得到的那一面', () => {
    const c = p.buildOutputContract({ stage: 'outline', capability: 'generate' }, { range: { from: 1, to: 20 } });
    assert.ok(c.includes(`11. 上面「相关世界观设定」「相关角色设定」里标着${MARK}的是读者还不知道的真相`), c);
    assert.match(c, /打算在哪一节揭开，就在那一节写明「揭开：……」/);
    assert.match(c, /12\. 只输出情节大纲本身/);
  });
});

describe('建条目与整合的提示词', () => {
  const s = lp.LORE_ENTRY_SYSTEM;

  test('600 字只指明面三节', () => {
    assert.match(s, /这三节合计不超过 600 字/);
  });

  test('暗设原样留作第四节、200 字以内、不算进 600', () => {
    assert.match(s, /现有条目可能带第四节「## 暗设」/);
    assert.match(s, /原样保留为第四节（200 字以内，不算进上面的 600 字）/);
  });

  test('正文揭开的挪进前三节，没揭开的不改；建条目不写暗设；不进 brief 与 keywords', () => {
    assert.match(s, /记录表明正文已经揭开了其中某件事，就把它挪进前三节、从暗设里删掉/);
    assert.match(s, /没揭开的一个字不改/);
    assert.match(s, /没有现有条目、或现有条目没有这一节时，不写暗设/);
    assert.match(s, /暗设里的东西不写进 brief 与 keywords/);
  });
});
