/**
 * 设定条目的三件维护（features/lore.ts，设定名录第三期）：建条目、整合、按目录整理。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 建条目只读定稿细纲里提到它的那几行，不重读正文；先报次数 | 从前每跑一次都从第 1 章扫起；第 4 条 |
 * | 「全部建条目」只建出现 ≥2 章的；建在它的分类目录里，记水位与正文指纹 | 长尾不值得一条一次；分类就是目录 |
 * | 整合只并水位之后、第一处没定稿的章之前的新事实 | 否则那一章日后定稿，它的事实永远进不了条目 |
 * | 机器写的可以直接采纳；作者改过的一律先对比 | 第 3 条：不静默覆盖 |
 * | 关键词只增不减，水位推到能推的地方 | 作者写的关键词不能被模型拿掉 |
 * | 整理：搬家清单先校验（认不出的条目、没建的目录、太深的目录不收），作者点头才搬，内容一字不改 | 作者定案：只搬不改 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

function plotText(no, hash, { lore = '', facts = '', events = '- 有事发生' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(hash ? [`sourceHash: ${hash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 连续性事实',
    '',
    facts || '（待补充）',
    '',
    '## 设定',
    '',
    lore || '（无）',
    '',
  ].join('\n');
}

/** 模型这一次该答什么，按 system 认。 */
let entryReply;
let organizeReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('把定稿细纲里关于一个设定的记录整理成一条设定条目')) {
    return entryReply(messages);
  }
  if (system.includes('负责把设定条目归进合适的目录')) {
    return organizeReply(messages);
  }
  return '（认不出这一步）';
}

const ENTRY = (brief, body, keywords = []) => JSON.stringify({ brief, keywords, body });

async function finalizeAll(nos) {
  project.invalidate();
  const chapters = await project.listChapters();
  for (const [no, opts] of nos) {
    const ch = chapters.find((c) => c.order === no);
    t.write(PLOT(no), plotText(no, opts.stale ? 'stale' : ch.contentHash, opts));
  }
  project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    lore: './src/core/features/lore.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: makeSettings({ concurrency: 1 }) });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'loreMaintain', title: '设定维护' });
  project = t.project;
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  // 第 1–3 章定稿；第 4 章定稿之后正文又改过（整合停在它前面）；第 5 章定稿。
  await finalizeAll([
    [1, { lore: '- 停舟客栈〔地域/青崖〕：镇上唯一的客栈\n- 后山〔地域〕', events: '- 林昭住进停舟客栈。' }],
    [2, { lore: '- 停舟客栈〔地域〕\n- 青崖镇〔地域〕：镇口设卡', facts: '- 停舟客栈的二楼被烧了' }],
    [3, { lore: '- 青崖镇：七年前大火' }],
    [4, { lore: '- 青崖镇：城门重修', stale: true }],
    [5, { lore: '- 青崖镇：新来了守军' }],
  ]);
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('建条目', () => {
  before(async () => {
    entryReply = (messages) => {
      const user = messages[1].content;
      return user.includes('设定：停舟客栈')
        ? ENTRY('镇上唯一的客栈', '## 概要\n\n镇上唯一的客栈。\n\n## 规则与边界\n\n（未交代）\n\n## 现状\n\n二楼被烧了。', ['停舟'])
        : ENTRY('镇外的后山', '## 概要\n\n镇外的后山。');
    };
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project);
  });

  // 出现 2 章以上、还没建条目的：停舟客栈（第 1、2 章）与青崖镇（第 2–5 章）；后山只出现过一章，不建。
  test('先报次数：只建出现 2 章以上的，每条 1 次', () => {
    const c = h.confirms[h.confirms.length - 1];
    assert.match(c.message, /^建 2 条设定：每条调用模型 1 次，共 2 次。只读定稿过的细纲里提到它们的那几行，不重读正文。/);
    assert.match(c.detail, /要建的：青崖镇、停舟客栈/);
    assert.equal(fake.callCount(), 2);
  });

  test('原料是定稿细纲里的记录：第九节那一句、连续性事实、提到它的句子，带章号', () => {
    const user = fake.calls.map((c) => c[1].content).find((u) => u.includes('设定：停舟客栈'));
    assert.ok(user.includes('设定：停舟客栈\n分类：地域/青崖'), user);
    assert.ok(user.includes('- 第 1 章：镇上唯一的客栈'), user);
    assert.ok(user.includes('- 第 1 章：林昭住进停舟客栈。'), user);
    assert.ok(user.includes('- 第 2 章：停舟客栈的二楼被烧了'), user);
    assert.ok(!user.includes('第1章的正文'), '不读正文');
  });

  test('建在它的分类目录里，带一句话、关键词、水位与正文指纹', async () => {
    project.invalidate();
    const inn = (await project.listLore()).find((e) => e.title === '停舟客栈');
    assert.equal(inn.relPath, '.novelforge/lore/地域/青崖/停舟客栈.md');
    assert.equal(inn.brief, '镇上唯一的客栈');
    assert.deepEqual(inn.keywords, ['停舟客栈', '停舟']);
    // 第 4 章定稿之后正文又改过：水位停在第 3 章。
    assert.equal(inn.updatedThrough, 3);
    assert.ok(bundle.lore.loreOwnedByMachine(inn));
  });

  test('给了名字就只建那一条，哪怕只出现过一章', async () => {
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['后山']);
    project.invalidate();
    assert.ok((await project.listLore()).some((e) => e.relPath === '.novelforge/lore/地域/后山.md'));
    assert.equal(fake.callCount(), 1);
  });
});

describe('整合', () => {
  before(async () => {
    t.write(
      '.novelforge/lore/地域/青崖镇.md',
      '---\ntitle: 青崖镇\nkeywords: [青崖]\nupdatedThrough: 2\n---\n\n# 青崖镇\n\n作者写的：偏僻小镇。\n'
    );
    project.invalidate();
  });

  test('作者改过的条目：只能逐条确认；新事实只到第一处没定稿的章之前', async () => {
    entryReply = () => ENTRY('偏僻小镇', '## 概要\n\n偏僻小镇。\n\n## 现状\n\n七年前遭过大火。', ['青崖镇', '镇子']);
    fake.reset();
    h.expect('逐条确认后开始');
    await bundle.lore.integrateLore(project, ['.novelforge/lore/地域/青崖镇.md']);
    const c = h.confirms[h.confirms.length - 1];
    assert.deepEqual(c.actions, ['逐条确认后开始']);
    assert.match(c.detail, /其中 1 条你改过/);
    assert.equal(h.reviewed.length, 1, '作者改过的先给对比');
    const user = fake.calls[0][1].content;
    assert.ok(user.includes('作者写的：偏僻小镇。'), user);
    assert.ok(user.includes('- 第 3 章：七年前大火'), user);
    assert.ok(!user.includes('城门重修') && !user.includes('新来了守军'), '第 4 章没定稿，它和它之后的都不并');
  });

  test('采纳后：关键词只增不减，水位到第 3 章，正文换成机器写的并盖上指纹', async () => {
    project.invalidate();
    const town = (await project.listLore()).find((e) => e.title === '青崖镇');
    assert.deepEqual(town.keywords, ['青崖', '青崖镇', '镇子']);
    assert.equal(town.updatedThrough, 3);
    assert.ok(town.body.includes('七年前遭过大火'));
    assert.ok(bundle.lore.loreOwnedByMachine(town));
  });

  test('没有新内容可并时说清楚停在哪一章', async () => {
    fake.reset();
    h.toasts.length = 0;
    await bundle.lore.integrateLore(project, ['.novelforge/lore/地域/青崖镇.md']);
    assert.equal(fake.callCount(), 0);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /第 4 章还没定稿/);
  });
});

describe('按目录整理', () => {
  test('校验搬家清单：认不出的条目、没建的目录、太深的目录不收，位置没变的去掉', () => {
    const batch = [
      { slug: '过所', relPath: '.novelforge/lore/过所.md', title: '过所', category: '' },
      { slug: '地域/后山', relPath: '.novelforge/lore/地域/后山.md', title: '后山', category: '地域' },
    ];
    const plan = bundle.lore.checkOrganizePlan(
      JSON.stringify({
        folders: ['制度', 'a/b/c/d'],
        moves: [
          { from: '过所', to: '制度' },
          { from: '后山', to: '地域' },
          { from: '不存在的', to: '制度' },
          { from: '.novelforge/lore/地域/后山.md', to: '地点' },
        ],
      }),
      batch,
      ['地域']
    );
    assert.deepEqual(plan.folders, ['制度']);
    assert.deepEqual(plan.moves, [{ from: '.novelforge/lore/过所.md', category: '', to: '制度', title: '过所' }]);
    assert.equal(plan.dropped.length, 3, plan.dropped.join('\n'));
  });

  test('先报次数，出清单给作者看，点头了才搬；只搬文件，内容一字不改', async () => {
    t.write('.novelforge/lore/过所.md', '---\ntitle: 过所\nkeywords: [过所]\n---\n\n# 过所\n\n出入凭证。\n');
    project.invalidate();
    const before = fs.readFileSync(t.rel('.novelforge/lore/过所.md'), 'utf8');
    organizeReply = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '过所', to: '制度' }] });
    fake.reset();
    h.expect('开始', '照这样整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    const [go, plan] = h.confirms.slice(-2);
    assert.match(go.message, /整理 1 条设定：分 1 批，调用模型 1 次/);
    assert.match(plan.message, /搬 1 条设定，新建 1 个目录。只搬文件，条目内容一个字不改。/);
    assert.match(plan.detail, /过所：未分类 → 制度/);
    assert.ok(!t.has('.novelforge/lore/过所.md'));
    assert.equal(fs.readFileSync(t.rel('.novelforge/lore/制度/过所.md'), 'utf8'), before);
  });

  test('作者没点头就一个都不搬', async () => {
    t.write('.novelforge/lore/黑市.md', '---\ntitle: 黑市\nkeywords: []\n---\n\n# 黑市\n\n地下交易。\n');
    project.invalidate();
    organizeReply = () => JSON.stringify({ folders: [], moves: [{ from: '黑市', to: '地域' }] });
    fake.reset();
    h.expect('开始', undefined);
    await bundle.lore.organizeLore(project, 'unfiled');
    assert.ok(t.has('.novelforge/lore/黑市.md'));
  });
});
