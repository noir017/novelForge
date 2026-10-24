/**
 * 单条设定这个生成目标（完善设定，2026-10-19，设计稿 §1「生成目标」方案 A）：`{ kind: 'lore', relPath }`。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 目标 | 阶段是架构（`setting`）；key、描述、取路径各认它；与整批设定清单不是同一个目标 |
 * | 归一 | 能存能读回；缺路径回落到大纲，**不落到设定清单**（随会话存下的草稿重开后不能被当成整批清单采纳） |
 * | 说法 | 生成在这个目标上叫「展开这条设定」（`/展开`），设定清单、世界观等几件的说法不动；调用次数 1 次、最多 2 次 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');

const L = { kind: 'lore', relPath: '.novelforge/lore/宗门/天机阁.md' };

describe('单条设定目标', () => {
  test('阶段是架构，取得到路径，不归属任何一章', () => {
    assert.equal(pipeline.stageOfTarget(L), 'setting');
    assert.equal(pipeline.loreOfTarget(L), L.relPath);
    assert.equal(pipeline.plotOfTarget(L), undefined);
    assert.equal(pipeline.settingOfTarget(L), undefined);
    assert.equal(pipeline.loreOfTarget({ kind: 'setting', doc: 'lore' }), undefined);
  });

  test('key 带路径，与设定清单、别的条目都不同', () => {
    assert.equal(pipeline.targetKey(L), `lore:${L.relPath}`);
    assert.notEqual(pipeline.targetKey(L), pipeline.targetKey({ kind: 'setting', doc: 'lore' }));
    assert.equal(pipeline.isSameTarget(L, { kind: 'lore', relPath: L.relPath }), true);
    assert.equal(pipeline.isSameTarget(L, { kind: 'lore', relPath: '.novelforge/lore/宗门/青云宗.md' }), false);
  });

  // 名字：调用方读得到条目时给标题，没给取文件名。
  test('描述：给了标题用标题，没给取文件名', () => {
    assert.equal(pipeline.describeTarget(L), '设定 · 天机阁');
    assert.equal(pipeline.describeTarget(L, { title: '天机阁（旧称）' }), '设定 · 天机阁（旧称）');
    assert.equal(pipeline.describeTarget({ kind: 'lore', relPath: '.novelforge/lore/九层楼.markdown' }), '设定 · 九层楼');
  });
});

describe('单条设定目标 · 归一', () => {
  test('能读回，路径去掉首尾空白', () => {
    assert.deepEqual(pipeline.normalizeTarget(L), L);
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: `  ${L.relPath}  ` }), L);
    assert.deepEqual(pipeline.normalizeTarget(JSON.parse(JSON.stringify(L))), L);
  });

  test('缺路径回落到大纲，不落到设定清单', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: '   ' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: 3 }), { kind: 'outline' });
  });
});

describe('单条设定目标 · 说法与调用次数', () => {
  test('生成叫「展开这条设定」，/展开 认得出；能力按阶段与目标算（讨论 + 生成，单条设定上没有落定）', () => {
    const cmds = pipeline.commandsFor('setting', L);
    // 末尾那两条 `/续写大纲`、`/落定设定` 是哪一层都有的（完善设定二期、2026-10-24），不是这一条自己的。
    assert.deepEqual(cmds.map((c) => c.label), ['展开这条设定', '续写大纲', '落定设定']);
    assert.deepEqual(pipeline.capabilitiesOn('setting', L), ['discuss', 'generate']);
    assert.ok(cmds[0].keys.includes('expand') && cmds[0].keys.includes('zk'), cmds[0].keys.join(','));
    assert.ok(cmds[0].keys.includes('generate'));
    assert.equal(pipeline.labelOf('setting', 'generate', L), '展开这条设定');
    assert.equal(pipeline.commandOf('setting', 'generate', L).label, '展开这条设定');
    assert.equal(pipeline.commandOf('setting', 'settle', L), undefined);
  });

  test('设定清单、世界观等几件的说法不动', () => {
    assert.equal(pipeline.labelOf('setting', 'generate'), '生成这份架构文档');
    assert.equal(pipeline.labelOf('setting', 'generate', { kind: 'setting', doc: 'lore' }), '生成这份架构文档');
    assert.deepEqual(pipeline.commandsFor('setting').map((c) => c.label), ['生成这份架构文档', '续写大纲', '落定设定']);
    assert.ok(!pipeline.commandsFor('setting').some((c) => c.keys.includes('expand')));
    assert.deepEqual(pipeline.commandsFor('plot', { kind: 'plot', plotRelPath: 'x' }).map((c) => c.label), ['落定细纲', '写细纲', '续写大纲', '落定设定']);
  });

  test('展开预计 1 次，最多 2 次（语法坏了修一次）', () => {
    const c = pipeline.LORE_EXPAND_CALLS;
    assert.deepEqual([c.low, c.high, c.max], [1, 1, 2]);
    assert.ok(pipeline.describeCalls(c).startsWith('预计 1 次调用，最多 2 次'), pipeline.describeCalls(c));
  });
});
