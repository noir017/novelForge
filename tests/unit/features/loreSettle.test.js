/**
 * 落定设定（完善设定二期）的解码、截断、过滤、认已有条目与气泡往返（features/loreSettle.ts），它在产物层
 * （features/artifact.ts）与提示词（context/loreSettlePrompt.ts、prompts.ts）里的样子。全部是纯函数。生成链与落盘在
 * tests/integration/generation/loreSettle.test.js。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 解码 | 一批条目各自截（明面合计 600、暗设 200、一句话 40），截了说是哪一条；没名字、重名、人名、明面一节都没有的丢掉并说出来；最多 12 条；不是 JSON 的解析不了（不做全文兜底）；裸数组也认 |
 * | 认已有条目 | 路径 → 同名（同名不同分类的按分类挑）→ 关键词；认出来的换成那一条的标题、分类、路径；同一条被认两次只留第一次 |
 * | 关键词 | 不收人名、别的条目的标题（已有的、这一批里别的）、名录里另记着的；最多 8 个 |
 * | 往返 | 渲染进气泡的文本解析回来一字不差，改已有的带 `relPath`；一条都没定下来时是一段人话 |
 * | 产物 | 架构那一层的 settle 解析成带 `settle` 的 `loreEntries`，排在设定清单之前；展开、设定清单不受影响 |
 * | 提示词 | 任务与原则是落定设定那一份（不说「这一章」，没定的进 questions 字段）；合同带上限；落定细纲不受影响 |
 * | 配方 | 历史照落定细纲抬到 P0、封顶 60%；`lore` 提到历史后面（P1），不让角色卡先拿预算；生成设定清单的配方不动 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const S = loadModule('src/core/features/loreSettle.ts');
const A = loadModule('src/core/features/artifact.ts');
const P = loadModule('src/core/context/prompts.ts');
const R = loadModule('src/core/context/recipes.ts');
const LP = loadModule('src/core/context/loreSettlePrompt.ts');

const entry = (title, keywords = [], over = {}) => ({
  slug: title,
  relPath: `.novelforge/lore/${over.category ? `${over.category}/` : ''}${title}.md`,
  title,
  keywords,
  brief: '',
  category: '',
  body: '',
  ...over,
});
const TJG = entry('天机阁', ['阁里'], { category: '宗门' });
const KNOWN = {
  entries: [TJG, entry('青云宗', ['青云门'], { category: '宗门' }), entry('后山', [], { category: '地域' }), entry('后山', [], { category: '青云宗' })],
  people: ['林昭', '阿昭'],
  recorded: ['寒冰锁'],
};
const row = (title, over = {}) => ({
  title,
  category: '地域',
  keywords: [],
  brief: `${title}的一句话`,
  body: { 概要: `${title}是什么。`, 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' },
  ...over,
});
const settle = (entries, questions = []) => JSON.stringify({ entries, questions });

describe('解码', () => {
  test('一批条目：四节、一句话、关键词收下；问题收下', () => {
    const d = S.decodeLoreSettle(
      settle([row('鬼市', { keywords: ['夜市'], body: { 概要: '城下的夜市。', 规则与边界: '子时开张。', 现状: '（未交代）', 暗设: '鬼市主人是天机阁二当家。' } })], ['鬼市在哪座城下？']),
      KNOWN
    );
    assert.ok(d.ok, d.message);
    assert.equal(d.value.entries.length, 1);
    const [e] = d.value.entries;
    assert.equal(e.title, '鬼市');
    assert.equal(e.category, '地域');
    assert.equal(e.relPath, undefined);
    assert.deepEqual(e.keywords, ['夜市']);
    assert.equal(e.brief, '鬼市的一句话');
    assert.equal(e.body, '## 概要\n城下的夜市。\n\n## 规则与边界\n子时开张。\n\n## 现状\n（未交代）\n\n## 暗设\n鬼市主人是天机阁二当家。');
    assert.deepEqual(d.value.questions, ['鬼市在哪座城下？']);
  });

  test('截长：每一条按上限截，说清是哪一条', () => {
    const long = '长'.repeat(400);
    const d = S.decodeLoreSettle(settle([row('鬼市', { brief: '短'.repeat(50), body: { 概要: long, 规则与边界: long, 现状: long, 暗设: '暗'.repeat(300) } })]), KNOWN);
    assert.ok(d.ok);
    const { body, brief } = d.value.entries[0];
    assert.equal(Array.from(brief).length, 40);
    const visible = body.split('## 暗设')[0].replace(/## \S+\n/g, '').replace(/\s/g, '');
    assert.ok(Array.from(visible).length <= 600, String(Array.from(visible).length));
    assert.equal(body.split('## 暗设\n')[1].length, 200);
    assert.ok(d.warnings.some((w) => w.startsWith('「鬼市」正文超长')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.startsWith('「鬼市」暗设超过 200 字')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('「鬼市」的一句话超过 40 字')), d.warnings.join('|'));
  });

  test('没名字、重名、人名、明面一节都没有的丢掉，并说出来', () => {
    const d = S.decodeLoreSettle(
      settle([
        row(''),
        row('鬼市'),
        row('鬼 市'),
        row('阿昭'),
        row('黑水渡', { body: { 概要: '', 规则与边界: '', 现状: '', 暗设: '只有暗设。' } }),
      ]),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['鬼市']);
    const w = d.warnings.join('|');
    assert.ok(w.includes('有一条没写名字'), w);
    assert.ok(w.includes('「鬼 市」在这一批里重复了'), w);
    assert.ok(w.includes('「阿昭」是角色卡上的人'), w);
    assert.ok(w.includes('「黑水渡」正文三节一节内容都没有'), w);
  });

  test(`最多 12 条，多出来的说出来`, () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`地名${i + 1}`));
    const d = S.decodeLoreSettle(settle(rows), KNOWN);
    assert.equal(d.value.entries.length, 12);
    assert.ok(d.warnings.some((w) => w.includes('一次最多落定 12 条，「地名13」及之后的没收')), d.warnings.join('|'));
  });

  test('不是 JSON 的解析不了；裸数组也认；一条都没有也算解析成功', () => {
    assert.equal(S.decodeLoreSettle('讨论里定下了鬼市。').ok, false);
    assert.equal(S.decodeLoreSettle('{"questions":["a"]}').ok, false);
    const bare = S.decodeLoreSettle(JSON.stringify([row('鬼市')]));
    assert.ok(bare.ok);
    assert.equal(bare.value.entries[0].title, '鬼市');
    const none = S.decodeLoreSettle(settle([], ['鬼市在哪？']));
    assert.ok(none.ok);
    assert.deepEqual(none.value.entries, []);
    assert.deepEqual(none.value.questions, ['鬼市在哪？']);
  });
});

describe('认已有条目', () => {
  test('同名：换成那一条的标题、分类、路径（模型写错分类也认）', () => {
    const d = S.decodeLoreSettle(settle([row('天机阁', { category: '地域' })]), KNOWN);
    const [e] = d.value.entries;
    assert.equal(e.relPath, TJG.relPath);
    assert.equal(e.category, '宗门');
    assert.equal(e.title, '天机阁');
  });

  test('关键词：认成那一条，说出来', () => {
    const d = S.decodeLoreSettle(settle([row('青云门')]), KNOWN);
    const [e] = d.value.entries;
    assert.equal(e.title, '青云宗');
    assert.equal(e.relPath, '.novelforge/lore/宗门/青云宗.md');
    assert.ok(d.warnings.some((w) => w.includes('「青云门」认成了已有条目「青云宗」')), d.warnings.join('|'));
  });

  test('同名不同分类：按分类挑，挑不出取第一条', () => {
    const pick = (category) => S.findSettledEntry(KNOWN.entries, { title: '后山', category });
    assert.equal(pick('青云宗').relPath, '.novelforge/lore/青云宗/后山.md');
    assert.equal(pick('地域').relPath, '.novelforge/lore/地域/后山.md');
    assert.equal(pick('别处').relPath, '.novelforge/lore/地域/后山.md');
  });

  test('给了路径且那条还在：按路径认（作者改了名也认得出）', () => {
    const renamed = { ...TJG, title: '天机楼阁' };
    assert.equal(S.findSettledEntry([renamed], { relPath: TJG.relPath, title: '天机阁', category: '' }).title, '天机楼阁');
    assert.equal(S.findSettledEntry([renamed], { relPath: '.novelforge/lore/没了.md', title: '鬼市', category: '' }), undefined);
  });

  // 真跑：讨论只提到、没改的条目，模型照抄正文、顺手改了一句话或关键词——一次落定弹了三张没意思的对比。
  test('认出是已有条目、正文和原来一字不差：丢掉，说出来', () => {
    const known = { ...KNOWN, entries: [{ ...TJG, body: '## 概要\n一座卖消息的楼。\n\n## 规则与边界\n（未交代）\n\n## 现状\n（未交代）' }, ...KNOWN.entries.slice(1)] };
    const same = row('天机阁', { brief: '换了一句话', keywords: ['天机楼'], body: { 概要: '一座卖消息的楼。', 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' } });
    const d = S.decodeLoreSettle(settle([same, row('鬼市')]), known);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['鬼市']);
    assert.ok(d.warnings.some((w) => w.includes('「天机阁」的正文和原来一样')), d.warnings.join('|'));
  });

  // 真跑：模型照抄上下文里一行带的样子，把「土地庙〔地点/青羊镇域〕」整个写进 title，另建了一份。
  test('名字后面夹带的〔分类〕剥掉，里面的当分类；照样认得出已有条目', () => {
    const d = S.decodeLoreSettle(settle([row('天机阁〔宗门〕', { category: '' }), row('鬼市【地域/城下】', { category: '' })]), KNOWN);
    assert.deepEqual(d.value.entries.map((e) => [e.title, e.category, e.relPath]), [
      ['天机阁', '宗门', TJG.relPath],
      ['鬼市', '地域/城下', undefined],
    ]);
    const plain = S.decodeLoreSettle(settle([row('〔无名〕')]), KNOWN);
    assert.equal(plain.value.entries[0].title, '〔无名〕');
  });

  test('同一条被认两次：只留第一次', () => {
    const d = S.decodeLoreSettle(settle([row('天机阁'), row('阁里')]), KNOWN);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['天机阁']);
    assert.ok(d.warnings.some((w) => w.includes('「阁里」认成了已有条目「天机阁」，前面已经有一条改它了')), d.warnings.join('|'));
  });
});

describe('关键词', () => {
  test('不收人名、别的条目的标题、这一批里别的、名录里另记着的；最多 8 个', () => {
    const d = S.decodeLoreSettle(
      settle([
        row('鬼市', { keywords: ['夜市', '林昭', '青云宗', '黑水渡', '寒冰锁', '鬼市', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] }),
        row('黑水渡'),
      ]),
      KNOWN
    );
    const kw = d.value.entries[0].keywords;
    for (const bad of ['林昭', '青云宗', '黑水渡', '寒冰锁', '鬼市']) {
      assert.ok(!kw.includes(bad), `${bad} ∈ ${kw.join(',')}`);
    }
    assert.equal(kw[0], '夜市');
    assert.equal(kw.length, 8);
  });
});

describe('往返', () => {
  test('渲染进气泡的文本解析回来一字不差；改已有的带 relPath', () => {
    const d = S.decodeLoreSettle(settle([row('天机阁'), row('鬼市', { keywords: ['夜市'] })], ['问一句？']), KNOWN);
    const raw = S.renderLoreSettle(d.value);
    assert.ok(raw.includes(`"relPath": "${TJG.relPath}"`), raw);
    assert.deepEqual(S.parseLoreSettle(raw), d.value);
  });

  test('一条都没定下来：一段人话，列出还没定的；它解析不出条目', () => {
    const text = S.renderNothingSettled(['鬼市在哪？', '谁开的？']);
    assert.ok(text.startsWith('讨论里还没有定下来的设定'), text);
    assert.ok(text.includes('1. 鬼市在哪？') && text.includes('2. 谁开的？'), text);
    assert.deepEqual(S.parseLoreSettle(text), { entries: [], questions: [] });
  });
});

describe('产物', () => {
  const action = { stage: 'setting', capability: 'settle' };
  const LORE_DIR = { kind: 'setting', doc: 'lore' };

  test('架构那一层的 settle → 带 settle 的 loreEntries，不是设定清单', () => {
    const art = A.parseArtifact(action, settle([row('鬼市'), { ...row('天机阁'), relPath: TJG.relPath }], ['问？']), LORE_DIR);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.settle, true);
    assert.deepEqual(art.entries.map((e) => e.title), ['鬼市', '天机阁']);
    assert.equal(art.entries[1].relPath, TJG.relPath);
    assert.equal(A.describeArtifact(art), '落定设定 · 2 条（改已有的 1 条） · 还没定的 1 问');
  });

  test('解析不了 / 一条都没有：空产物（没有落盘卡片）', () => {
    assert.ok(A.isArtifactEmpty(A.parseArtifact(action, '我觉得鬼市应该……', LORE_DIR)));
    assert.ok(A.isArtifactEmpty(A.parseArtifact(action, S.renderNothingSettled(['问？']), LORE_DIR)));
  });

  test('设定清单、展开不受影响', () => {
    const list = A.parseArtifact({ stage: 'setting', capability: 'generate' }, '{"categories":["地域"],"entries":[{"title":"鬼市","category":"地域","keywords":[],"brief":"夜市"}]}', LORE_DIR);
    assert.equal(list.kind, 'loreList');
    const expand = A.parseArtifact(
      { stage: 'setting', capability: 'generate' },
      JSON.stringify({ brief: '楼', keywords: [], body: { 概要: '楼。' }, children: [], questions: [] }),
      { kind: 'lore', relPath: TJG.relPath }
    );
    assert.equal(expand.kind, 'loreEntries');
    assert.equal(expand.settle, undefined);
  });
});

describe('提示词', () => {
  const config = { model: 'p/m', contextWindow: 100000, maxOutputTokens: 4096 };
  const sys = (action, target) => P.buildSystemPrompt(action, config, { target });
  const LORE_DIR = { kind: 'setting', doc: 'lore' };

  test('系统提示：落定设定的原则与任务，不说「这一章」，没定的进「还没定的问题」', () => {
    const s = sys({ stage: 'setting', capability: 'settle' }, LORE_DIR);
    assert.ok(s.includes('这一次只把讨论里已经定下来的设定落成条目'), s.slice(0, 400));
    assert.ok(s.includes('已经定下来的设定**整理成一批设定条目'), s);
    assert.ok(s.includes('写进最后「还没定的问题」一节'), s);
    // 真跑：「残米」只差来源没定，模型整条没写。
    assert.ok(s.includes('不要因为有一处没定就整条不写'), s);
    assert.ok(!s.includes('你和作者刚讨论完这一章'), s);
    assert.ok(!s.includes('在产物之外用一两句话说明'), s);
  });

  test('落定细纲不受影响', () => {
    const s = sys({ stage: 'plot', capability: 'settle' }, { kind: 'plot', plotRelPath: 'x' });
    assert.ok(s.includes('你和作者刚讨论完这一章'), s);
  });

  test('合同：落定设定那一份，带上限；不是设定清单', () => {
    const c = P.buildOutputContract({ stage: 'setting', capability: 'settle' }, { target: LORE_DIR });
    // 2026-10-25 起按小标题写，JSON 合同挪给转写那一步。
    assert.ok(c.includes('【落定格式】') && c.includes('## 还没定的问题') && !c.includes('{"entries"'), c);
    assert.ok(c.includes('最多 12 条'), c);
    assert.ok(c.includes('三节合计 ≤ 600 字') && c.includes('暗设 ≤ 200 字'), c);
    assert.ok(c.includes('**人不是设定**'), c);
    assert.ok(c.includes('讨论没碰的部分照抄原文，一处都不许丢'), c);
    assert.ok(c.includes('「暗设（读者还不知道）」'), c);
    // 真跑（gemini-3-flash-lite）：模型把「法器」「防线」「硬通货」写成关键词，正文一提就整条带进来。
    assert.ok(c.includes('不放别的东西也叫得上的泛称'), c);
    // 真跑：讨论只提到的已有条目也被列进来；一个没想好的问题被写成了暗设。
    assert.ok(c.includes('讨论里只是提到、没有改动的已有条目不要列'), c);
    assert.ok(c.includes('不是还没想好的事'), c);
    assert.ok(!c.includes('【设定清单格式】'), c);
  });

  test('转写合同：形状是解码认的那一份，文字一律照抄', () => {
    const j = LP.loreSettleJsonContract();
    assert.ok(j.includes('【落定设定 JSON 合同】') && j.includes('{"entries":[{"title"') && j.includes('"questions"'), j);
    assert.ok(j.includes('原文只有「还没定的问题」一节时 entries 给 []'), j);
    assert.ok(j.includes('文字一律从原文照抄'), j);
  });
});

describe('配方', () => {
  test('历史抬到 P0、封顶 60%；lore 紧跟历史、P1；设定清单不动', () => {
    const r = R.recipeFor('setting', 'settle');
    const at = (layer) => r.findIndex((x) => x.layer === layer);
    const history = r[at('history')];
    assert.equal(history.priority, 0);
    assert.equal(history.cap, 0.6);
    assert.equal(at('lore'), at('history') + 1);
    assert.equal(r[at('lore')].priority, 1);
    assert.ok(at('lore') < at('characters'));
    const plain = R.recipeFor('setting', 'generate');
    assert.equal(plain.at(-1).layer, 'lore');
    assert.equal(plain.at(-1).priority, 2);
    const plot = R.recipeFor('plot', 'settle');
    assert.equal(plot.find((x) => x.layer === 'history').cap, 0.6);
    assert.equal(plot.find((x) => x.layer === 'lore').priority, 2);
  });
});
