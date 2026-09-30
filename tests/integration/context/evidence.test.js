/**
 * 正文层的 `evidence` 层（四期，D18）：写正文时不拿摘要当事实，拿连续性事实的证据原句回到
 * 前面各章的正文里，带那几段原文。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 前 5 章的事实全取，更早的只取涉及本章角色的 | D18：近的都相关，远的只有与本章的人有关的才相关 |
 * | 带的是证据所在的那一段与前后各一段 | 原文才是作者认可的那一版 |
 * | 正文改过、定位不到的换成事实原句，标 degraded | 第 2 条：不静默截断 |
 * | 整章正文已经进来的章不再单独带片段 | 同一段原文带两遍只是贵 |
 * | 上一章没定稿，明细里说清 | D23：不挡路，但不静默 |
 * | 一共 6000 字、最多 12 章，放不下的写原因 | 上游 MATERIAL_BUDGET_CHARS；第 2 条 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  recentChaptersFullText: 2,
  prevChapterTailChars: 1500,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;

function chapterText(no, extra = '') {
  return [
    `# 第${no}章`,
    '',
    `第${no}章开头，雨还在下。`,
    '',
    `林昭在第${no}章把第${no}块令牌塞进怀里。${extra}`,
    '',
    `沈氏在第${no}章锁上了第${no}道门。`,
    '',
    `第${no}章结尾，风停了。`,
    '',
  ].join('\n');
}

function plotText(no) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'characters: [林昭]',
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 本章目的',
    '',
    '往下查。',
    '',
    '## 关键事件',
    '',
    '林昭去井边。',
    '',
    '## 章末钩子',
    '',
    '井底有人。',
    '',
  ].join('\n');
}

let bundle;
before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
});

/** 建工程：第 1..n 章正文，`summarized` 里的章写摘要（sourceHash 对得上），第 n+1 章排好细纲。 */
async function setup(prefix, n, summarized, opts = {}) {
  const t = await makeTempProject(bundle.project, { prefix, title: '证据测试' });
  for (let no = 1; no <= n; no++) {
    t.write(CH(no), opts.text ? opts.text(no) : chapterText(no));
  }
  t.write(`.novelforge/plots/${pad3(n + 1)}-第${n + 1}章.md`, plotText(n + 1));
  t.write(
    '.novelforge/characters/林昭.md',
    `---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nstateThrough: ${opts.stateThrough ?? 6}\n---\n\n# 林昭\n\n## 身份\n\n孤儿\n`
  );
  t.project.invalidate();
  const chapters = await t.project.listChapters();
  for (const no of summarized) {
    const ch = chapters.find((c) => c.order === no);
    const facts = opts.facts
      ? opts.facts(no)
      : [
          `- 林昭收起第${no}块令牌 〔证据：「林昭在第${no}章把第${no}块令牌塞进怀里。」〕`,
          `- 沈氏锁上第${no}道门 〔证据：「沈氏在第${no}章锁上了第${no}道门。」〕`,
        ];
    t.write(
      `.novelforge/summaries/${pad3(no)}-第${no}章.md`,
      `---\nchapter: ${no}\nsourceHash: ${ch.contentHash}\ncast: [林昭, 沈氏]\n---\n\n# 第${no}章 · 摘要\n\n## 梗概\n\n第${no}章的事。\n\n## 出场人物\n\n林昭、沈氏\n\n## 连续性事实\n\n${facts.join('\n')}\n`
    );
  }
  t.project.invalidate();
  return t;
}

async function build(t, no, extra) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: `.novelforge/plots/${pad3(no)}-第${no}章.md` }, ask: '', targetWords: 1200 },
    config(extra)
  );
}

describe('evidence · 写第 9 章（前 8 章写过，第 8 章还没定稿）', () => {
  let t;
  let b;
  let byId;

  before(async () => {
    t = await setup('evidence', 8, [1, 2, 3, 4, 5, 6, 7]);
    // 第 6 章定稿之后作者改了一句：摘要里的证据原句找不到了。
    t.write(CH(6), chapterText(6).replace('塞进怀里', '揣进了怀里'));
    t.project.invalidate();
    b = await build(t, 9);
    byId = new Map(b.items.filter((i) => i.kind === 'evidence').map((i) => [i.id, i]));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('前 5 章里定过稿的都带了；更早的也带了（涉及本章角色林昭）', () => {
    for (const no of [1, 2, 3, 4, 5, 6]) {
      assert.ok(['included', 'degraded'].includes(byId.get(`evidence:${no}`)?.status), `第 ${no} 章：${JSON.stringify(byId.get(`evidence:${no}`))}`);
    }
    assert.match(byId.get('evidence:5').note, /^2 条连续性事实/);
    assert.match(byId.get('evidence:3').note, /^1 条涉及本章角色的连续性事实/);
  });

  test('带的是证据所在那一段与前后各一段', () => {
    const text = byId.get('evidence:4').text;
    assert.match(text, /林昭在第4章把第4块令牌塞进怀里/);
    assert.match(text, /第4章开头/);
    assert.match(text, /第4章结尾/);
  });

  test('正文改过、定位不到的那条换成事实原句，标 degraded 并写明', () => {
    const e = byId.get('evidence:6');
    assert.equal(e.status, 'degraded');
    assert.match(e.note, /1 条证据在正文里找不到（正文改过），换成事实原句/);
    assert.match(e.note, /摘要已过期/);
    assert.match(e.text, /- 林昭收起第6块令牌/);
    assert.match(e.text, /沈氏在第6章锁上了第6道门/);
  });

  test('第 7 章的整章正文进来了：它的片段不再单独带', () => {
    const e = byId.get('evidence:7');
    assert.equal(e.status, 'dropped');
    assert.match(e.note, /整章正文已完整注入/);
    assert.ok(b.items.some((i) => i.id === 'manuscriptFull:7' && i.status === 'included'));
  });

  test('D23：第 8 章还没定稿，明细里写明，角色状态截至第几章', () => {
    const e = byId.get('evidence:8');
    assert.equal(e.status, 'dropped');
    assert.equal(e.note, '第 8 章还没定稿：没有连续性事实，角色状态截至第 6 章');
  });

  test('角色卡的说明带「状态截至第 K 章」', () => {
    const card = b.items.find((i) => i.id === 'character:林昭');
    assert.match(card.note, /状态截至第 6 章/);
  });

  test('消息里一节，按章号正序', () => {
    const user = b.messages[b.messages.length - 1].content;
    const at = user.indexOf('# 定稿原文片段');
    assert.ok(at > 0);
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('【第 1 章') < section.indexOf('【第 5 章'), section.slice(0, 400));
  });

  test('续写那几轮不带这一层', async () => {
    const c = await bundle.builder.buildContext(
      t.project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/009-第9章.md' },
        ask: '',
        targetWords: 1200,
        step: { kind: 'continuation', tail: '已写的末尾', written: 600, remaining: 600, recovery: false },
      },
      config()
    );
    assert.ok(!c.items.some((i) => i.kind === 'evidence'));
  });
});

describe('evidence · 更早的章只取涉及本章角色的事实', () => {
  let t;
  let b;
  before(async () => {
    t = await setup('evidence-names', 8, [1, 2, 3, 4, 5, 6, 7, 8], {
      facts: (no) => (no <= 3 ? [`- 沈氏锁上第${no}道门 〔证据：「沈氏在第${no}章锁上了第${no}道门。」〕`] : [`- 林昭收起第${no}块令牌 〔证据：「林昭在第${no}章把第${no}块令牌塞进怀里。」〕`]),
    });
    b = await build(t, 9, { recentChaptersFullText: 0 });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1–3 章的事实只关于沈氏：不带；第 4–8 章全带', () => {
    const nos = b.items.filter((i) => i.kind === 'evidence' && i.status === 'included').map((i) => Number(i.id.split(':')[1]));
    assert.deepEqual(nos.sort((x, y) => x - y), [4, 5, 6, 7, 8]);
  });

  // 顺手修掉的老问题：`slice(-0)` 等于 `slice(0)`，设成 0 反而把前面每一章都整章塞进来。
  test('「注入完整原文章数」设成 0：一章全文都不带', () => {
    assert.deepEqual(b.items.filter((i) => i.kind === 'manuscriptFull'), []);
  });
});

describe('evidence · 一共 6000 字、最多 12 章', () => {
  test('放不下的章 dropped，写明是封顶了', async () => {
    const long = '长'.repeat(700);
    const t = await setup('evidence-cap', 8, [1, 2, 3, 4, 5, 6, 7, 8], {
      text: (no) => chapterText(no).replace('开头，雨还在下。', `开头，${long}`).replace('结尾，风停了。', `结尾，${long}`),
    });
    const b = await build(t, 9, { recentChaptersFullText: 0 });
    const ev = b.items.filter((i) => i.kind === 'evidence');
    const kept = ev.filter((i) => i.status === 'included');
    assert.ok(kept.length >= 2 && kept.length < 8, JSON.stringify(ev.map((i) => [i.id, i.status])));
    assert.ok(kept.reduce((sum, i) => sum + i.text.length, 0) <= 6000);
    const dropped = ev.filter((i) => i.status === 'dropped');
    assert.ok(dropped.length > 0);
    assert.match(dropped[0].note, /一共只带 6000 字/);
    cleanup(t.dir, bundle.db);
  });

  test('最多从 12 章里取', async () => {
    const t = await setup('evidence-twelve', 19, Array.from({ length: 19 }, (_, i) => i + 1));
    const b = await build(t, 20, { recentChaptersFullText: 0 });
    const nos = b.items.filter((i) => i.kind === 'evidence' && i.status === 'included').map((i) => Number(i.id.split(':')[1]));
    assert.equal(nos.length, 12);
    assert.equal(Math.min(...nos), 8);
    cleanup(t.dir, bundle.db);
  });
});
