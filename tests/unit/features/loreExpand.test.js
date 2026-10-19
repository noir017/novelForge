/**
 * 展开一条设定（完善设定，2026-10-19）的解码、截断、过滤与气泡往返（features/loreExpand.ts），以及它在产物层
 * （features/artifact.ts）的样子；单章细纲第九节里 `isNew` 的那几行（§3）。全部是纯函数。生成链与落盘在
 * tests/integration/generation/loreExpand.test.js。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 解码 | 四节按上限截（明面合计 600、暗设 200）、一句话截 40，截了都说出来；Markdown 写的正文按「暗设」标题切；明面三节空的、不是 JSON 的都解析不了（不做全文兜底）；`]` 前多出来的逗号自己修 |
 * | 过滤 | 关键词不收人名、别的条目的标题、名录里另记着的、拆出去的子条目；子条目丢掉已有的、人名、重名、与本条同名的，最多 3 条；问题最多 5 条、每条 60 字 |
 * | 往返 | 渲染进气泡的文本解析回来一字不差，`questions` 也在 |
 * | 产物 | 单条设定目标上解析成 `loreEntries`（第一项按路径认，其余是子条目）；解析不了是空的；设定清单那一支不受影响 |
 * | 单章细纲 | `settings` 里 `isNew` 的另记一份 `newLore`，不进第九节以外的地方 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const E = loadModule('src/core/features/loreExpand.ts');
const A = loadModule('src/core/features/artifact.ts');
const F = loadModule('src/core/model/loreFile.ts');

const REL = '.novelforge/lore/宗门/天机阁.md';
const entry = (title, keywords = [], over = {}) => ({
  slug: title,
  relPath: `.novelforge/lore/${title}.md`,
  title,
  keywords,
  brief: '',
  category: '',
  body: '',
  ...over,
});
const KNOWN = {
  title: '天机阁',
  entries: [entry('天机阁', ['阁里']), entry('青云宗', ['青云门']), entry('九层楼')],
  people: ['林昭', '阿昭'],
  recorded: ['寒冰锁'],
};
const good = (over = {}) =>
  JSON.stringify({
    brief: '江湖上卖消息的楼阁',
    keywords: ['天机楼', '阁中'],
    body: { 概要: '一座卖消息的楼。', 规则与边界: '一问一价，不问来者。', 现状: '阁主闭关。', 暗设: '阁主是前朝太子。' },
    children: [{ name: '阁规', category: '制度', brief: '天机阁的十条规矩' }],
    questions: ['阁规是成文的还是口传的？', '阁主闭关多久了？'],
    ...over,
  });

describe('解码', () => {
  test('四节、一句话、关键词、子条目、问题都收下', () => {
    const d = E.decodeLoreExpansion(good(), KNOWN);
    assert.ok(d.ok, d.message);
    assert.equal(d.value.brief, '江湖上卖消息的楼阁');
    assert.equal(
      d.value.body,
      '## 概要\n一座卖消息的楼。\n\n## 规则与边界\n一问一价，不问来者。\n\n## 现状\n阁主闭关。\n\n## 暗设\n阁主是前朝太子。'
    );
    assert.deepEqual(d.value.keywords, ['天机楼', '阁中']);
    assert.deepEqual(d.value.children, [{ name: '阁规', category: '制度', brief: '天机阁的十条规矩' }]);
    assert.deepEqual(d.value.questions, ['阁规是成文的还是口传的？', '阁主闭关多久了？']);
    assert.deepEqual(d.warnings, []);
  });

  // 第 27 条：明面三节合计 600（每节 150 / 250 / 150），暗设另算 200；一句话 40。
  test('超长按上限截，截了都说出来', () => {
    const d = E.decodeLoreExpansion(
      good({
        brief: '长'.repeat(50),
        body: { 概要: '甲'.repeat(200), 规则与边界: '乙'.repeat(300), 现状: '丙'.repeat(200), 暗设: '丁'.repeat(260) },
      }),
      KNOWN
    );
    assert.ok(d.ok);
    const { visible, hidden } = F.splitLoreHidden(d.value.body);
    assert.ok(visible.includes(`## 概要\n${'甲'.repeat(150)}\n`), visible.slice(0, 200));
    assert.ok(visible.includes(`## 规则与边界\n${'乙'.repeat(250)}\n`));
    assert.ok(visible.includes(`## 现状\n${'丙'.repeat(150)}`));
    assert.equal(hidden, '丁'.repeat(200));
    assert.equal(Array.from(d.value.brief).length, 40);
    assert.ok(d.warnings.some((w) => w.includes('正文超长')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('暗设超过 200 字')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('一句话超过 40 字')), d.warnings.join('|'));
  });

  test('正文写成 Markdown 也认，暗设按「暗设」开头的标题切；没写到的节是「（未交代）」', () => {
    const d = E.decodeLoreExpansion(
      JSON.stringify({ brief: 'b', keywords: [], body: '## 概要\n一座楼。\n\n## 暗设（未揭示）\n楼下有密道。\n\n## 现状\n还开着。' })
    );
    assert.ok(d.ok, d.message);
    assert.equal(d.value.body, '## 概要\n一座楼。\n\n## 规则与边界\n（未交代）\n\n## 现状\n还开着。\n\n## 暗设\n楼下有密道。');
  });

  test('暗设写「无」「（未交代）」或空着都当没有', () => {
    for (const none of ['', '无', '（未交代）', '（待补充）']) {
      const d = E.decodeLoreExpansion(good({ body: { 概要: '一座楼。', 规则与边界: '', 现状: '', 暗设: none } }));
      assert.ok(d.ok);
      assert.ok(!d.value.body.includes('暗设'), `${none} → ${d.value.body}`);
    }
  });

  // 不做全文兜底：一段没解析开的原文盖掉条目，比没写更糟。
  test('明面三节一节都没有、不是 JSON 的，都解析不了', () => {
    assert.equal(E.decodeLoreExpansion(good({ body: { 暗设: '只有暗设' } })).ok, false);
    assert.equal(E.decodeLoreExpansion('我觉得天机阁应该是一座楼。').ok, false);
    assert.equal(E.decodeLoreExpansion('{"brief":"一座楼","body":{"概要":"一座楼。"').ok, false);
  });

  test('`}` 前多出来的逗号自己修，不调模型', () => {
    const d = E.decodeLoreExpansion('```json\n{"brief":"一座楼","keywords":["楼",],"body":{"概要":"一座楼。",},}\n```');
    assert.ok(d.ok, d.message);
    assert.equal(d.value.brief, '一座楼');
  });

  test('模型没包一层 body、把几节写在顶层也认', () => {
    const d = E.decodeLoreExpansion(JSON.stringify({ brief: 'b', 概要: '一座楼。', 暗设: '楼下有密道。' }));
    assert.ok(d.ok, d.message);
    assert.ok(d.value.body.startsWith('## 概要\n一座楼。') && d.value.body.endsWith('## 暗设\n楼下有密道。'), d.value.body);
  });
});

describe('过滤', () => {
  test('关键词：人名、别的条目的标题、名录里另记着的、拆出去的子条目、与本条同名的都不要，最多 8 个', () => {
    const d = E.decodeLoreExpansion(
      good({
        keywords: ['天机阁', '林昭', '青云宗', '寒冰锁', '阁规', '天机楼', '天机楼', '机', '阁中', ...Array.from({ length: 10 }, (_, i) => `别称${i}`)],
      }),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.keywords, ['天机楼', '阁中', '别称0', '别称1', '别称2', '别称3', '别称4', '别称5']);
  });

  test('子条目：已有条目的（标题或关键词）、人名、重名、与本条同名的丢掉并说明；最多 3 条；分类规范成目录', () => {
    const d = E.decodeLoreExpansion(
      good({
        children: [
          { name: '青云门', category: '宗门', brief: '已有条目的关键词' },
          { name: '阿昭', category: '', brief: '人' },
          { name: '天机阁', category: '', brief: '本条' },
          { name: '阁规', category: '制度/门规', brief: '十条规矩' },
          { name: '阁规', category: '', brief: '重名' },
          { name: '暗桩', category: '／势力 ', brief: '安插在各地的眼线' },
          '密道',
          { name: '信鸽', category: '物品', brief: '传信' },
        ],
      }),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.children, [
      { name: '阁规', category: '制度/门规', brief: '十条规矩' },
      { name: '暗桩', category: '势力', brief: '安插在各地的眼线' },
      { name: '密道', category: '', brief: '' },
    ]);
    assert.ok(d.warnings.some((w) => w.includes('「青云门」已经有条目了（青云宗）')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('「阿昭」是角色卡上的人')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('超过 3 条') && w.includes('信鸽')), d.warnings.join('|'));
  });

  test('问题：去重、每条截 60 字、最多 5 条；写成一段字按换行拆（问题里常有逗号）', () => {
    const many = E.decodeLoreExpansion(
      good({ questions: ['一？', '二？', '一？', '三？', '四？', '五？', '六？', '长'.repeat(80)] })
    );
    assert.deepEqual(many.value.questions, ['一？', '二？', '三？', '四？', '五？']);
    assert.ok(many.warnings.some((w) => w.includes('只留前 5 条')));
    const long = E.decodeLoreExpansion(good({ questions: ['长'.repeat(80)] }));
    assert.equal(Array.from(long.value.questions[0]).length, 60);
    const text = E.decodeLoreExpansion(good({ questions: '1. 阁规是成文的，还是口传的？\n- 阁主闭关多久了？' }));
    assert.deepEqual(text.value.questions, ['阁规是成文的，还是口传的？', '阁主闭关多久了？']);
  });
});

describe('气泡往返', () => {
  test('渲染进气泡的文本解析回来一字不差（questions 也在）', () => {
    const d = E.decodeLoreExpansion(
      good({ body: { 概要: '一座楼。', 规则与边界: '', 现状: '阁主闭关。', 暗设: '阁主是前朝太子。' } }),
      KNOWN
    );
    const text = E.renderLoreExpansion(d.value);
    const back = E.decodeLoreExpansion(text);
    assert.ok(back.ok, back.message);
    assert.deepEqual(back.value, d.value);
    assert.deepEqual(back.warnings, []);
    assert.equal(E.renderLoreExpansion(back.value), text);
    assert.deepEqual(JSON.parse(text).questions, ['阁规是成文的还是口传的？', '阁主闭关多久了？']);
  });

  test('没有暗设的往返不凭空多出一节', () => {
    const d = E.decodeLoreExpansion(good({ body: { 概要: '一座楼。' } }));
    const back = E.decodeLoreExpansion(E.renderLoreExpansion(d.value));
    assert.equal(back.value.body, d.value.body);
    assert.ok(!back.value.body.includes('暗设'));
  });

  test('解析成落盘的样子：第一项是目标条目（按路径认、标题取文件名），其余是子条目（空正文）', () => {
    const { entries, questions } = E.parseLoreExpansion(good(), REL);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].relPath, REL);
    assert.equal(entries[0].title, '天机阁');
    assert.ok(entries[0].body.includes('## 暗设\n阁主是前朝太子。'));
    assert.deepEqual(entries[1], { title: '阁规', category: '制度', keywords: ['阁规'], brief: '天机阁的十条规矩', body: '' });
    assert.equal(questions.length, 2);
    assert.deepEqual(E.parseLoreExpansion('不是 JSON', REL), { entries: [], questions: [] });
  });
});

describe('产物', () => {
  const action = { stage: 'setting', capability: 'generate' };
  const target = { kind: 'lore', relPath: REL };

  test('单条设定目标上解析成 loreEntries，描述说得出几节、拆出几条、几问', () => {
    const art = A.parseArtifact(action, good(), target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.entries[0].relPath, REL);
    assert.equal(A.isArtifactEmpty(art), false);
    assert.equal(A.describeArtifact(art), '设定 · 天机阁 · 展开 3/3 节 + 暗设 · 拆出 1 条 · 还没定的 2 问');
  });

  test('写成「（未交代）」的节不算展开了', () => {
    const art = A.parseArtifact(action, good({ body: { 概要: '一座楼。', 现状: '（未交代）' }, children: [], questions: [] }), target);
    assert.equal(A.describeArtifact(art), '设定 · 天机阁 · 展开 1/3 节');
  });

  test('解析不了就是空的（没有落盘卡片），不做全文兜底', () => {
    const art = A.parseArtifact(action, '天机阁是一座楼，卖消息。', target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(A.isArtifactEmpty(art), true);
  });

  test('设定清单那一支不受影响', () => {
    const art = A.parseArtifact(action, JSON.stringify({ categories: ['宗门'], entries: [{ title: '天机阁', category: '宗门' }] }), {
      kind: 'setting',
      doc: 'lore',
    });
    assert.equal(art.kind, 'loreList');
  });
});

describe('单章细纲 · 新设定（完善设定 §3）', () => {
  const action = { stage: 'plot', capability: 'generate' };
  const blueprint = (settings) =>
    JSON.stringify({
      blueprints: [{ chapterNumber: 3, title: '夜访', synopsis: '林昭夜访天机阁。', keyEvents: ['林昭入阁'], settings }],
    });

  test('isNew 的另记一份 newLore，第九节照旧全收', () => {
    const art = A.parseArtifact(
      action,
      blueprint([
        { name: '天机阁', category: '宗门', isNew: false, note: '' },
        { name: '九层楼', category: '地域', isNew: true, note: '天机阁的藏书楼' },
        { name: '暗河', category: '地域', isNew: 'true', note: '城下的河' },
      ])
    );
    assert.equal(art.kind, 'plot');
    assert.deepEqual(art.lore.map((l) => l.name), ['天机阁', '九层楼', '暗河']);
    assert.deepEqual(art.newLore, [
      { name: '九层楼', category: '地域', note: '天机阁的藏书楼' },
      { name: '暗河', category: '地域', note: '城下的河' },
    ]);
  });

  test('没有新设定就不带这个字段', () => {
    const art = A.parseArtifact(action, blueprint([{ name: '天机阁', category: '宗门', isNew: false, note: '' }]));
    assert.equal(art.newLore, undefined);
  });
});
