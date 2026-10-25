/**
 * 设定条目的三件维护（features/lore.ts，设定名录第三期）：建条目、整合、按目录整理。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 建条目只读定稿细纲里提到它的那几行，不重读正文；先报次数 | 从前每跑一次都从第 1 章扫起；第 4 条 |
 * | 「全部建条目」建出现过的全部；建在它的分类目录里，记水位与正文指纹 | 出现过就值得建一条 |
 * | 整合只并水位之后、第一处没定稿的章之前的新事实 | 否则那一章日后定稿，它的事实永远进不了条目 |
 * | 机器写的可以直接采纳；作者改过的一律先对比 | 第 3 条：不静默覆盖 |
 * | 原来有暗设、整合完没了的，机器写的也先对比 | 分不清是正文揭开了还是模型漏了（完善设定，第 27 条） |
 * | 关键词只增不减，水位推到能推的地方 | 作者写的关键词不能被模型拿掉 |
 * | 建条目、整合新收的关键词不收名录里另记着的名字 | 收了那个名字就再也建不出自己的条目（旧的整本重扫把几十个法术并进了「魔法体系」） |
 * | 交回来的解析不了就这一条重来一次，还不行算失败、名字留在未建条目里；次数按上限报 | 旧的整本重扫解析不了的直接丢；第 4 条 |
 * | 整理：搬家清单先校验（认不出的条目、没建的目录、太深的目录不收），作者点头才搬，内容一字不改 | 作者定案：只搬不改 |
 */
const { describe, test, before, beforeEach, after } = require('node:test');
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
    loreIndex: './src/core/views/lore.ts',
    db: './src/core/runtime/db.ts',
    fs: './src/core/model/fs.ts',
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
    [5, { lore: '- 青崖镇：新来了守军\n- 城隍庙〔地域〕：镇北的庙' }],
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
        ? ENTRY('镇上唯一的客栈', '## 概要\n\n镇上唯一的客栈。\n\n## 规则与边界\n\n（未交代）\n\n## 现状\n\n二楼被烧了。', ['停舟', '青崖镇', '后山'])
        : ENTRY('镇外的后山', '## 概要\n\n镇外的后山。');
    };
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project);
  });

  // 出现过、还没建条目的：停舟客栈（第 1、2 章）、青崖镇（第 2–5 章）、后山（第 1 章）、城隍庙（第 5 章），全建。
  // 2026-10-25 起改成转写：每条写 1 次、转写 1 次，转写不合格重转 1 次，还整理不出来重写一次——一条最多 6 次。
  // 假模型直接给 JSON，不转写，实际一条 1 次。
  test('先报次数：出现过的全部建，每条写 1 次、转写 1 次，整理不出来的重写一次', () => {
    const c = h.confirms[h.confirms.length - 1];
    assert.match(
      c.message,
      /^建 4 条设定：预计 8 次调用，最多 24 次（写 1 次、转写模型照抄成 JSON 1 次；转写不合格重转 1 次，还整理不出来这一条重写 1 次、再转）。只读同步过的细纲里提到它们的那几行，不重读正文。/
    );
    assert.match(c.detail, /要建的：/);
    assert.equal(fake.callCount(), 4);
  });

  test('原料是定稿细纲里的记录：「设定」一节那一句、连续性事实、提到它的句子，带章号', () => {
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
    // 模型把同一批建的「青崖镇」也写成了关键词：别的条目的标题不收（会把那一条的命中抢过来）。
    // 「后山」也在同一批：名录里另记着的名字不收关键词（recorded），否则它永远建不出自己的条目。
    assert.deepEqual(inn.keywords, ['停舟客栈', '停舟']);
    // 第 4 章定稿之后正文又改过：水位停在第 3 章。
    assert.equal(inn.updatedThrough, 3);
    assert.ok(bundle.lore.loreOwnedByMachine(inn));
  });

  test('给了名字就只建那一条', async () => {
    // 批量建完后追加一章定稿细纲，让名录里出现一个新的未建条目。
    project.invalidate();
    const ch6hash = (await project.listChapters()).find((c) => c.order === 5)?.contentHash ?? 'x';
    t.write(CH(6), `# 第6章\n\n第6章的正文。\n`);
    project.invalidate();
    const ch6 = (await project.listChapters()).find((c) => c.order === 6);
    t.write(PLOT(6), plotText(6, ch6.contentHash, { lore: '- 铁匠铺〔地域〕：镇西的铺子' }));
    project.invalidate();
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['铁匠铺']);
    project.invalidate();
    assert.ok((await project.listLore()).some((e) => e.title === '铁匠铺'));
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
    entryReply = () =>
      ENTRY('偏僻小镇', '## 概要\n\n偏僻小镇。\n\n## 现状\n\n七年前遭过大火。', ['青崖镇', '镇子', '城隍庙']);
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
    assert.ok(!user.includes('城门重修') && !user.includes('新来了守军'), '第 4 章没同步，它和它之后的都不并');
  });

  test('采纳后：关键词只增不减，水位到第 3 章，正文换成机器写的并盖上指纹', async () => {
    project.invalidate();
    const town = (await project.listLore()).find((e) => e.title === '青崖镇');
    // 作者写的「青崖」原样留着；模型给的「青崖镇」就是标题（匹配时本来就认标题），不重复收；
    // 「城隍庙」是第 5 章单独记下、还没建条目的名字，不收。
    assert.deepEqual(town.keywords, ['青崖', '镇子']);
    assert.equal(town.updatedThrough, 3);
    assert.ok(town.body.includes('七年前遭过大火'));
    assert.ok(bundle.lore.loreOwnedByMachine(town));
  });

  test('没有新内容可并时说清楚停在哪一章', async () => {
    fake.reset();
    h.toasts.length = 0;
    await bundle.lore.integrateLore(project, ['.novelforge/lore/地域/青崖镇.md']);
    assert.equal(fake.callCount(), 0);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /第 4 章还没同步/);
  });

  // 完善设定（2026-10-19）：分不清是正文全揭开了还是模型漏了，暗设不能悄悄没了。
  describe('原来有暗设的机器写条目', () => {
    const INN = '.novelforge/lore/地域/青崖/停舟客栈.md';
    const BODY = '## 概要\n\n镇上唯一的客栈。\n\n## 暗设\n\n掌柜是前朝暗卫。';
    beforeEach(() => {
      t.write(
        INN,
        `---\ntitle: 停舟客栈\nkeywords: [停舟]\nupdatedThrough: 0\nbodyHash: ${bundle.fs.hash(BODY)}\n---\n\n# 停舟客栈\n\n${BODY}\n`
      );
      project.invalidate();
    });

    test('整合完暗设一句都没了：选了直接采纳也先给对比', async () => {
      entryReply = () => ENTRY('镇上唯一的客栈', '## 概要\n\n镇上唯一的客栈。\n\n## 现状\n\n二楼被烧了。');
      fake.reset();
      h.expect('机器写的直接采纳并开始');
      await bundle.lore.integrateLore(project, [INN]);
      assert.equal(h.reviewed.length, 1, '暗设没了，先对比');
    });

    test('暗设还在：照作者选的直接采纳', async () => {
      entryReply = () =>
        ENTRY('镇上唯一的客栈', '## 概要\n\n镇上唯一的客栈。\n\n## 现状\n\n二楼被烧了。\n\n## 暗设\n\n掌柜是前朝暗卫。');
      fake.reset();
      h.expect('机器写的直接采纳并开始');
      await bundle.lore.integrateLore(project, [INN]);
      assert.equal(h.reviewed.length, 0);
      project.invalidate();
      const inn = (await project.listLore()).find((e) => e.relPath === INN);
      assert.ok(inn.body.includes('掌柜是前朝暗卫'));
    });
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
    assert.match(go.message, /整理 1 条设定：分 1 批，预计 2 次调用，最多 3 次（写 1 次、转写模型照抄成 JSON 1 次/);
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

  // 从前搬家之前先直接 `fs.mkdir` 建出清单上的新目录（绕过网关，第 7 条）；`ws.move` 落盘前本来就会补齐父目录，
  // 那一步唯一的效果是：搬不成的时候留下一个空目录。现在新目录只在真有条目搬进去时由网关建出来。
  test('搬不成就不留下空目录：新目录由搬家时经网关补齐，不先建', async () => {
    t.write('.novelforge/lore/令牌.md', '---\ntitle: 令牌\nkeywords: []\n---\n\n# 令牌\n\n出入用。\n');
    project.invalidate();
    // 模型答完清单、作者点头之前，这一条被作者在别处删了：搬家必然失败。
    organizeReply = () => {
      fs.rmSync(t.rel('.novelforge/lore/令牌.md'));
      return JSON.stringify({ folders: ['信物'], moves: [{ from: '令牌', to: '信物' }] });
    };
    fake.reset();
    h.expect('开始', '照这样整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    const plan = h.confirms.at(-1);
    assert.match(plan.message, /新建 1 个目录/);
    assert.equal(t.has('.novelforge/lore/信物'), false);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /1 条没搬/);
  });
});

describe('模型返回解析不了', () => {
  before(async () => {
    t.write(CH(6), '# 第6章\n\n第6章的正文。\n');
    await finalizeAll([[6, { lore: '- 黑水渡〔地域〕：镇外的渡口\n- 鬼市〔地域〕：夜里才开' }]]);
  });

  // 没照格式写的（连「概要」都没有）不花转写那一次，直接重写。
  test('这一条重写一次，第二次解得出来就照常建', async () => {
    let n = 0;
    entryReply = () => (++n === 1 ? '这不是 JSON' : ENTRY('镇外的渡口', '## 概要\n\n镇外的渡口。'));
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['黑水渡']);
    assert.match(h.confirms[h.confirms.length - 1].message, /^建 1 条设定：预计 2 次调用，最多 6 次/);
    assert.equal(fake.callCount(), 2);
    project.invalidate();
    assert.ok((await project.listLore()).some((e) => e.title === '黑水渡'));
  });

  test('重来还不行才算失败：不建，名字留在「出现过 · 未建条目」里，下次还能建', async () => {
    entryReply = () => '还是不是 JSON';
    fake.reset();
    h.toasts.length = 0;
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['鬼市']);
    assert.equal(fake.callCount(), 2, '写两轮，没照格式写的不转写');
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /新建 0 条设定，失败 1 条/);
    project.invalidate();
    assert.ok(!(await project.listLore()).some((e) => e.title === '鬼市'));
    assert.ok((await bundle.loreIndex.buildLoreIndex(project)).unknown.some((u) => u.name === '鬼市'));
  });
});
