/**
 * `lore` 层（设定名录，2026-10-18）：几百条设定的书，先排序、再分两种形态装、按上下文详细度封顶。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 本章细纲「设定」一节点名的整条带，关键词命中的也整条带 | 写这一章最用得上的就是这几条 |
 * | 关键词命中按最长匹配：「圣地秘境」里的「秘境」不算 | 上位概念不挤掉具体那几条的整条名额 |
 * | 前几章定稿出现过的只带一句话 | 够提醒有这个东西，不挤预算 |
 * | 整条后面跟水位之后的新事实（只到本章之前） | 条目落后于正文时模型照样拿得到新的那几句 |
 * | 条目整合到本章或更晚时 note 提醒可能剧透 | 回头重写前面的章时，条目里有之后的事 |
 * | 整条超了上限降成一句话、一句话超了上限丢，都写原因 | 第 2 条：不静默截断 |
 * | 排细纲时其余条目列一览（近几章出现过的在前），超了的并成一条 | 规划时照抄已有的名字；写到后面开篇的高频词不霸屏；几百条不逐条刷明细 |
 * | 续写那几轮也带（只带点名与命中的） | 从前续写一条设定都不带 |
 * | 取消勾选的不占名额 | 作者排除一条，后面的补上来 |
 * | 整条的空行隔开，一句话的并成一张清单 | 消息里好读 |
 * | 架构层只有设定清单（分类表 + 已有条目一览，空目录也算）与世界观（点名的）带设定 | 清单要照用目录、照抄名字；配置、前提、角色图谱在设定之前 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const PLAN = { stage: 'plot', capability: 'generate' };

const config = (contextDetail = 3) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail,
});

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

function plotText(no, { finalized = true, events = '- 林昭往前走。', lore, facts } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(finalized ? [`sourceHash: h${no}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 连续性事实',
    '',
    facts ?? '（待补充）',
    ...(lore === undefined ? [] : ['', '## 设定', '', lore]),
    '',
  ].join('\n');
}

function entry(title, { keywords = [], brief = '', body = '', updatedThrough } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(updatedThrough !== undefined ? [`updatedThrough: ${updatedThrough}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'loreLayer', title: '设定测试' });
  for (let no = 1; no <= 4; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  t.write(
    '.novelforge/lore/地域/青崖镇.md',
    entry('青崖镇', { keywords: ['青崖'], brief: '偏僻小镇', body: '镇口设卡。', updatedThrough: 1 })
  );
  t.write('.novelforge/lore/信物/崖字令牌.md', entry('崖字令牌', { keywords: ['令牌'], body: '木牌，残缺的崖字。' }));
  t.write('.novelforge/lore/宗门/正道/青云宗.md', entry('青云宗', { brief: '正道第一宗', body: '剑修。' }));
  t.write('.novelforge/lore/地域/后山.md', entry('后山', { brief: '后山禁地', body: '有阵法。' }));
  t.write('.novelforge/lore/过所.md', entry('过所', { brief: '出入凭证', body: '镇口查验。' }));

  t.write(PLOT(1), plotText(1, { lore: '- 青崖镇〔地域〕：镇口查过所\n- 后山〔地域〕' }));
  t.write(
    PLOT(2),
    plotText(2, { lore: '- 青崖镇：七年前大火\n- 青云宗〔宗门/正道〕', facts: '- 青崖镇的城门被烧毁' })
  );
  t.write(PLOT(3), plotText(3, { lore: '- 后山' }));
  t.write(PLOT(4), plotText(4, { finalized: false, events: '- 林昭回到青崖，摸了摸怀里。', lore: '- 崖字令牌〔信物〕：不止一块' }));
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(no, extra = {}, detail = 3) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(no) }, ask: '', targetWords: 1200, ...extra },
    config(detail)
  );
}

const loreItems = (b) => b.items.filter((i) => i.kind === 'lore');
const byLabel = (b, title) => loreItems(b).find((i) => i.label === `设定 · ${title}`);
const userOf = (b) => b.messages[b.messages.length - 1].content;

describe('写第 4 章正文', () => {
  let b;
  before(async () => {
    b = await build(4);
  });

  test('本章细纲点名的、关键词命中的整条带；前两章定稿出现过的只带一句话；无关的不带', () => {
    assert.deepEqual(
      loreItems(b).map((i) => [i.label, i.status]),
      [
        ['设定 · 崖字令牌', 'included'],
        ['设定 · 青崖镇', 'included'],
        ['设定 · 后山', 'included'],
        ['设定 · 青云宗', 'included'],
      ]
    );
    assert.equal(byLabel(b, '崖字令牌').note, '本章细纲的设定里有「崖字令牌」');
    assert.equal(byLabel(b, '青崖镇').note, '上下文中出现「青崖」');
    assert.equal(byLabel(b, '后山').note, '第 3 章出现过');
    assert.equal(byLabel(b, '青云宗').note, '第 2 章出现过');
  });

  test('整条：一句话、分类、正文，后面跟水位之后、本章之前的新事实', () => {
    assert.equal(
      byLabel(b, '青崖镇').text,
      [
        '【青崖镇〔地域〕】偏僻小镇',
        '镇口设卡。',
        '第 1 章之后新出现的（还没整合进这一条）：',
        '- 第 2 章：七年前大火',
        '- 第 2 章：青崖镇的城门被烧毁',
      ].join('\n')
    );
    // 没写 brief 的不在标题行上重复正文第一句。
    assert.equal(byLabel(b, '崖字令牌').text, '【崖字令牌〔信物〕】\n木牌，残缺的崖字。');
  });

  test('一句话：名〔分类〕：一句话', () => {
    assert.equal(byLabel(b, '青云宗').text, '- 青云宗〔宗门/正道〕：正道第一宗');
  });

  test('本章细纲带着「设定」一节（计划引入什么），别的细纲不带', () => {
    const self = b.items.find((i) => i.id === `plot:${PLOT(4)}`);
    assert.ok(self.text.endsWith('## 设定\n\n- 崖字令牌〔信物〕：不止一块'), self.text);
    const others = b.items.filter((i) => i.kind === 'plotSummary' && i.text);
    assert.ok(others.every((i) => !i.text.includes('## 设定')), others.map((i) => i.text).join('\n---\n'));
  });

  test('消息里一节：整条的空行隔开，一句话的并成一张清单跟在后面', () => {
    const user = userOf(b);
    const at = user.indexOf('# 相关世界观设定');
    assert.ok(at > 0, user.slice(0, 1500));
    const section = user.slice(at, user.indexOf('\n---\n', at) > 0 ? user.indexOf('\n---\n', at) : undefined);
    assert.ok(section.includes('【崖字令牌〔信物〕】\n木牌，残缺的崖字。\n\n【青崖镇〔地域〕】'), section);
    assert.ok(
      section.includes(
        '其余相关设定（只列一句话；提到它们时沿用这些名字）：\n- 后山〔地域〕：后山禁地\n- 青云宗〔宗门/正道〕：正道第一宗'
      ),
      section
    );
  });
});

describe('回头重写第 1 章', () => {
  test('条目整合到本章或更晚：note 提醒可能含之后的事；尾巴只到本章之前', async () => {
    const b = await build(1);
    const qing = byLabel(b, '青崖镇');
    assert.equal(qing.status, 'included');
    assert.ok(qing.note.includes('条目整合到第 1 章，可能含第 1 章之后才发生的事'), qing.note);
    assert.ok(!qing.text.includes('第 2 章'), qing.text);
  });
});

describe('上限', () => {
  // 命中的先后：本章细纲点名的 → 作者这次说的 → 本章细纲里提到的。整条名额先给最确定要用的。
  test('精简：整条只带 2 条，其余降成一句话并写原因', async () => {
    const b = await build(4, { ask: '青云宗、后山与过所' }, 1);
    const full = loreItems(b).filter((i) => i.status === 'included' && i.text.startsWith('【'));
    assert.deepEqual(
      full.map((i) => i.label),
      ['设定 · 崖字令牌', '设定 · 后山']
    );
    const degraded = loreItems(b).filter((i) => i.status === 'degraded');
    assert.deepEqual(
      degraded.map((i) => i.label),
      ['设定 · 青云宗', '设定 · 过所', '设定 · 青崖镇']
    );
    assert.ok(degraded.every((i) => i.text.startsWith('- ')));
    assert.ok(degraded[0].note.includes('整条的已带满 2 条（上下文详细度「精简」），只带一句话'), degraded[0].note);
  });

  test('取消勾选的不占名额', async () => {
    const b = await build(4, { ask: '青云宗、后山与过所', excludedIds: ['lore:信物/崖字令牌'] }, 1);
    assert.equal(byLabel(b, '崖字令牌').status, 'excluded');
    const full = loreItems(b).filter((i) => i.status === 'included' && i.text.startsWith('【'));
    assert.deepEqual(
      full.map((i) => i.label),
      ['设定 · 后山', '设定 · 青云宗']
    );
  });
});

describe('排细纲', () => {
  before(() => {
    for (let i = 1; i <= 12; i++) {
      t.write(`.novelforge/lore/杂项/物件${i}.md`, entry(`物件${i}`, { brief: `第${i}件` }));
    }
    t.project.invalidate();
  });
  after(() => {
    t.remove('.novelforge/lore/杂项');
    t.project.invalidate();
  });

  test('其余条目按出现章数列一览；超了上限的并成一条写明', async () => {
    const b = await bundle.builder.buildContext(
      t.project,
      { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(5) }, ask: '' },
      config(1)
    );
    const items = loreItems(b);
    // 规划时先给分类表：分类就是目录、每本书自己的，新设定要从这里挑。
    const categories = items.find((i) => i.id === 'lore:categories');
    // 目录按拼音排（listFolders 的 zh-Hans-CN 排序）。
    assert.equal(categories.text, '本书的设定分类：地域、信物、杂项、宗门、宗门/正道（新设定的 category 从这里挑）。');
    // 精简：一句话最多 10 条。前两章（第 3、4 章只有第 3 章定稿）出现过的先占，
    // 其余近 10 章出现过的在前、按这几章里出现的章数降序：青崖镇 2 章、后山已带、青云宗 1 章……
    const lines = items.filter((i) => i.status === 'included' && i.id !== 'lore:categories');
    assert.equal(lines.length, 10, items.map((i) => `${i.label}:${i.status}`).join(' '));
    assert.equal(lines[0].label, '设定 · 后山');
    assert.equal(lines[1].label, '设定 · 青崖镇');
    assert.equal(lines[1].note, '已有设定（近 10 章出现 2 章，最近第 2 章）');
    const rest = items.find((i) => i.id === 'lore:catalog');
    assert.equal(rest.status, 'dropped');
    assert.equal(rest.label, '设定 · 其余 7 条');
    assert.ok(rest.note.includes('一句话的已带满 10 条'), rest.note);
  });
});

// 2026-10-25 外部报告：写到第 83 章排细纲，一览前几十条全是开篇几十章里的高频词——从前一律按全书出现章数排。
describe('排细纲 · 写到后面', () => {
  let late;
  before(async () => {
    late = await makeTempProject(bundle.project, { prefix: 'loreLayerLate', title: '后面' });
    const seen = { 湖泊: [1, 2, 3, 4, 5, 6, 7, 8], 街市: [1, 2, 3, 4, 5], 圣地: [22, 25], 戒律: [26], 暗号: [28] };
    for (const name of Object.keys(seen)) {
      late.write(`.novelforge/lore/${name}.md`, entry(name, { brief: name }));
    }
    for (const no of [...new Set(Object.values(seen).flat())]) {
      const names = Object.keys(seen).filter((name) => seen[name].includes(no));
      late.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n正文。\n`);
      late.write(PLOT(no), plotText(no, { lore: names.map((n) => `- ${n}`).join('\n') }));
    }
    late.project.invalidate();
  });
  after(() => {
    if (late) cleanup(late.dir);
  });

  const plan = (detail) =>
    bundle.builder.buildContext(late.project, { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(30) }, ask: '' }, config(detail));

  test('近几章（与角色图谱同一个数）出现过的在前，按这几章里出现的章数；更早的在后，按全书出现章数', async () => {
    const lines = loreItems(await plan(1)).filter((i) => i.id !== 'lore:categories');
    assert.deepEqual(
      lines.map((i) => [i.label, i.note]),
      [
        ['设定 · 暗号', '第 28 章出现过'],
        ['设定 · 圣地', '已有设定（近 10 章出现 2 章，最近第 25 章）'],
        ['设定 · 戒律', '已有设定（近 10 章出现 1 章，最近第 26 章）'],
        ['设定 · 湖泊', '已有设定（出现 8 章，近 10 章没出现）'],
        ['设定 · 街市', '已有设定（出现 5 章，近 10 章没出现）'],
      ]
    );
  });

  test('「完整」那一级不限近几章：照旧按全书出现章数', async () => {
    const lines = loreItems(await plan(4)).filter((i) => i.note?.startsWith('已有设定'));
    assert.deepEqual(
      lines.map((i) => [i.label, i.note]),
      [
        ['设定 · 湖泊', '已有设定（出现 8 章）'],
        ['设定 · 街市', '已有设定（出现 5 章）'],
      ]
    );
  });
});

// 2026-10-25 外部报告：「圣地秘境」一出现，汇总了各个秘境规则的「秘境」那一条就整条带进来，挤掉具体那几条。
describe('关键词命中 · 最长匹配', () => {
  let p;
  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'loreLayerLongest', title: '最长匹配' });
    p.write('.novelforge/lore/概念/秘境.md', entry('秘境', { brief: '各处秘境的统称', body: '幻池：水下不能开口。心枝：时间流速 22:90。' }));
    p.write('.novelforge/lore/秘境/圣地秘境.md', entry('圣地秘境', { brief: '教派的据点', body: '外人进不去。' }));
    p.project.invalidate();
  });
  after(() => {
    if (p) cleanup(p.dir);
  });

  const ask = (text) =>
    bundle.builder.buildContext(p.project, { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(1) }, ask: text }, config(3));
  const full = (b) => loreItems(b).filter((i) => i.text.startsWith('【')).map((i) => [i.label, i.note]);

  test('「圣地秘境」里的「秘境」不算提到上位概念；单独说「秘境」照样整条带', async () => {
    assert.deepEqual(full(await ask('这一章主角随教众潜入圣地秘境')), [['设定 · 圣地秘境', '上下文中出现「圣地秘境」']]);
    assert.deepEqual(full(await ask('圣地秘境也守秘境的规矩')), [
      ['设定 · 秘境', '上下文中出现「秘境」'],
      ['设定 · 圣地秘境', '上下文中出现「圣地秘境」'],
    ]);
  });
});

describe('续写那几轮', () => {
  test('只带点名的与命中的（含已写的末尾），前几章的不带', async () => {
    const b = await build(4, {
      step: { kind: 'continuation', tail: '他想起了过所的事。', written: 300, recovery: false },
    });
    assert.deepEqual(
      loreItems(b).map((i) => i.label),
      ['设定 · 崖字令牌', '设定 · 青崖镇', '设定 · 过所']
    );
  });
});

/*
 * 架构那一层（设定名录第四期）：只有设定清单与世界观两件用得上设定。清单当规划看——分类表 + 已有条目
 * 一行一条（照用目录、照抄名字）；世界观只带作者这次点名的；其余几件在设定之前，一条都不带。
 */
describe('架构那一层', () => {
  const setting = (doc, ask = '') =>
    bundle.builder.buildContext(
      t.project,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc }, ask },
      config(3)
    );

  test('设定清单：分类表 + 已有条目一行一条', async () => {
    const items = loreItems(await setting('lore'));
    assert.equal(items[0].id, 'lore:categories');
    assert.equal(items[0].text, '本书的设定分类：地域、信物、宗门、宗门/正道（新设定的 category 从这里挑）。');
    const lines = items.filter((i) => i.id !== 'lore:categories');
    assert.deepEqual(lines.map((i) => i.label).sort(), ['设定 · 后山', '设定 · 过所', '设定 · 青崖镇', '设定 · 青云宗', '设定 · 崖字令牌'].sort());
    assert.ok(lines.every((i) => i.text.startsWith('- ')), lines.map((i) => i.text).join('\n'));
  });

  // 世界观不当规划看：没有分类表、没有全部条目的一览；作者点名的整条带（近几章定稿里出现过的照常一句话）。
  test('世界观：作者点名的整条带，不列分类表与一览', async () => {
    const items = loreItems(await setting('world', '把青云宗的规矩写进去'));
    assert.deepEqual([items[0].label, items[0].note], ['设定 · 青云宗', '上下文中出现「青云宗」']);
    assert.ok(items[0].text.startsWith('【青云宗〔宗门/正道〕】'), items[0].text);
    assert.ok(!items.some((i) => i.id === 'lore:categories' || i.note?.startsWith('已有设定')), items.map((i) => `${i.label}:${i.note}`).join('\n'));
  });

  test('配置、前提、角色图谱：一条都不带', async () => {
    for (const doc of ['config', 'premise', 'characters']) {
      assert.deepEqual(loreItems(await setting(doc, '青云宗')), [], doc);
    }
  });

  test('设定清单：一条条目都没有也给分类表（空目录也算）', async () => {
    const empty = await makeTempProject(bundle.project, { prefix: 'loreLayerEmpty', title: '空' });
    try {
      empty.write('.novelforge/lore/宗门/.keep', '');
      empty.project.invalidate();
      const b = await bundle.builder.buildContext(
        empty.project,
        { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'lore' }, ask: '' },
        config(3)
      );
      assert.deepEqual(loreItems(b).map((i) => i.text), ['本书的设定分类：宗门（新设定的 category 从这里挑）。']);
    } finally {
      cleanup(empty.dir);
    }
  });
});
