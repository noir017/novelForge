/**
 * 设定名录（views/lore.ts）：从定稿过的细纲「设定」一节聚合出「哪个东西在哪几章、有没有条目、落后几章」。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只认定稿过的细纲 | 没定稿的「设定」一节是计划，混进来会污染统计（第 14 条同理） |
 * | 标题先于关键词认条目 | 关键词抢不走别人的标题 |
 * | 水位之后的「设定」一节说明与连续性事实才算待整合 | 整合过的不再催；状态的变化记在连续性事实里 |
 * | 连续性事实认条目按最长匹配：落在别人更长的名字里的不算 | 上位概念不再把各个具体东西的事并进自己 |
 * | 人名不是设定 | 模型偶尔把人列进「设定」一节 |
 * | 未建条目按出现章数降序，分类取多数票 | 作者要建的多半是出现得多的 |
 * | 没有「设定」一节的定稿章计入「还没记过」 | 老工程上线后要补记的就是这几章 |
 * | 分类就是目录，可以嵌套 | 每本书的分类不一样（作者定案） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let index;

function plot(no, title, { finalized = true, lore, facts = '' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    ...(finalized ? ['sourceHash: h' + no] : []),
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 关键事件',
    '',
    '- 有事发生',
    '',
    '## 连续性事实',
    '',
    facts || '（待补充）',
    ...(lore === undefined ? [] : ['', '## 设定', '', lore]),
    '',
  ].join('\n');
}

before(async () => {
  bundle = loadBundle({
    project: './src/core/model/project.ts',
    lore: './src/core/views/lore.ts',
  });
  t = await makeTempProject(bundle.project, { prefix: 'loreindex' });
  t.write(
    '.novelforge/lore/地域/青崖/青崖镇.md',
    '---\ntitle: 青崖镇\nkeywords: [青崖]\nbrief: 偏僻小镇\nupdatedThrough: 2\n---\n\n# 青崖镇\n\n镇口设卡。\n'
  );
  t.write('.novelforge/lore/信物/崖字令牌.md', '---\ntitle: 崖字令牌\nkeywords: [令牌]\n---\n\n# 崖字令牌\n\n木牌。\n');
  t.write('.novelforge/lore/过所.md', '---\ntitle: 过所\nkeywords: []\n---\n\n# 过所\n\n出入凭证。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n');

  t.write('.novelforge/summaries/001-雨夜.md', plot(1, '雨夜', { lore: '- 青崖镇〔地域〕：镇口查过所\n- 后山〔地域〕' }));
  t.write(
    '.novelforge/summaries/002-客栈.md',
    plot(2, '客栈', { lore: '- 青崖〔地域〕\n- 停舟客栈〔地域/青崖〕：唯一的客栈\n- 林昭〔人物〕' })
  );
  t.write(
    '.novelforge/summaries/003-夜访.md',
    plot(3, '夜访', {
      lore: '- 青崖镇：七年前大火\n- 令牌〔信物〕\n- 停舟客栈〔地域〕\n- 后山',
      facts: '- 林昭的令牌被年轻守卫看见 〔证据：「牌子」〕\n- 青崖镇的城门被烧毁',
    })
  );
  // 第 4 章定稿过、但还没有「设定」一节；第 5 章是计划，「设定」一节不算。
  t.write('.novelforge/summaries/004-空匣.md', plot(4, '空匣'));
  t.write('.novelforge/summaries/005-计划.md', plot(5, '计划', { finalized: false, lore: '- 后山〔地域〕\n- 黑市〔地域〕' }));

  index = await bundle.lore.buildLoreIndex(t.project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('已建条目', () => {
  const record = (title) => index.known.find((r) => r.entry.title === title);

  test('每条都在，分类就是目录（可以嵌套），根目录下是未分类', () => {
    assert.deepEqual(
      index.known.map((r) => [r.entry.title, r.entry.category]).sort(),
      [
        ['崖字令牌', '信物'],
        ['过所', ''],
        ['青崖镇', '地域/青崖'],
      ].sort()
    );
  });

  test('出现章：只认定稿过的「设定」一节，标题与关键词都认', () => {
    assert.deepEqual(record('青崖镇').chapters, [1, 2, 3]);
    assert.deepEqual(record('崖字令牌').chapters, [3]);
    assert.deepEqual(record('过所').chapters, []);
  });

  test('待整合：水位之后的「设定」一节说明与提到它的连续性事实', () => {
    assert.deepEqual(record('青崖镇').pending, [
      { no: 3, text: '七年前大火', source: 'lore' },
      { no: 3, text: '青崖镇的城门被烧毁', source: 'fact' },
    ]);
    assert.equal(bundle.lore.pendingChapters(record('青崖镇')), 1);
    // 没整合过（没有水位）的条目，从第 1 章算起。
    assert.deepEqual(record('崖字令牌').pending, [{ no: 3, text: '林昭的令牌被年轻守卫看见', source: 'fact' }]);
  });
});

// 2026-10-25 外部报告：「秘境」那一条整合成了各个秘境的汇总——带这两个字的连续性事实从前都挂到它名下。
describe('待整合 · 最长匹配', () => {
  let p;
  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'loreindexLongest' });
    p.write('.novelforge/lore/概念/秘境.md', '---\ntitle: 秘境\nkeywords: []\n---\n\n# 秘境\n\n各处秘境。\n');
    p.write('.novelforge/lore/秘境/心枝.md', '---\ntitle: 心枝\nkeywords: [心枝秘境]\nupdatedThrough: 1\n---\n\n# 心枝\n\n时间流速不同。\n');
    p.write(
      '.novelforge/summaries/001-入池.md',
      plot(1, '入池', { lore: '- 幻池秘境〔秘境〕：水下不能开口', facts: '- 幻池秘境里水下不能开口\n- 心枝秘境与外界时间流速 22:90' })
    );
    p.write('.novelforge/summaries/002-湖底.md', plot(2, '湖底', { lore: '- 秘境', facts: '- 秘境的入口都在湖底\n- 心枝秘境的时间又变快了' }));
  });
  after(() => {
    if (p) cleanup(p.dir);
  });

  test('落在别的条目、名录里另记着的名字里的不算；水位之内的条目照样算别人的名字，只是不收', async () => {
    const idx = await bundle.lore.buildLoreIndex(p.project);
    const pending = (title) => idx.known.find((r) => r.entry.title === title).pending.map((f) => `${f.no}:${f.text}`);
    // 「幻池秘境」还没建条目（名录里记着），「心枝秘境」是「心枝」的关键词——这两句都不归「秘境」。
    assert.deepEqual(pending('秘境'), ['2:秘境的入口都在湖底']);
    assert.deepEqual(pending('心枝'), ['2:心枝秘境的时间又变快了']);
  });
});

describe('未建条目', () => {
  test('定稿里出现、没有条目的名字；人名不算；计划里的不算', () => {
    // 两个都出现了 2 章，同样多的按第一次出现的章号：后山第 1 章、停舟客栈第 2 章。
    assert.deepEqual(
      index.unknown.map((u) => u.name),
      ['后山', '停舟客栈']
    );
  });

  test('按出现章数降序，分类取多数票，说明按章收着', () => {
    const inn = index.unknown.find((u) => u.name === '停舟客栈');
    assert.deepEqual(inn.chapters, [2, 3]);
    assert.ok(['地域/青崖', '地域'].includes(inn.category));
    assert.deepEqual(inn.notes, [{ no: 2, text: '唯一的客栈', source: 'lore' }]);
    const hill = index.unknown.find((u) => u.name === '后山');
    assert.deepEqual(hill.chapters, [1, 3]);
    assert.equal(hill.category, '地域');
  });
});

describe('还没记过设定的定稿章', () => {
  test('定稿过、没有「设定」一节的章', () => {
    assert.deepEqual(index.unrecorded, [4]);
    assert.equal(index.finalizedCount, 4);
  });
});

describe('describeSpan', () => {
  test('首尾与章数', () => {
    assert.equal(bundle.lore.describeSpan([]), '');
    assert.equal(bundle.lore.describeSpan([7]), '第 7 章');
    assert.equal(bundle.lore.describeSpan([3, 9, 57]), '第 3–57 章 · 3 章');
  });
});
