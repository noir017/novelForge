/**
 * 批量动作之前自动存一个存档点（`features/checkpoint.ts` 的 `checkpointBefore`，设计见
 * docs/design/plans/2026-10-20-checkpoints.md「自动存档点」）。真临时工程 + 假模型。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 与最近一个一模一样就不另存，改过一份就另存；还不是小说工程给 undefined、不抛 | 多挂几处没有代价（⚑10）；绝不挡批量动作 |
 * | 批量写章：作者点了「开始」才存，正好一个，备注说区间（写完即定稿另说），存的是动手之前的样子（新章不在里面、细纲还没记 `writtenFrom`） | 整本退得回批量之前 |
 * | 确认框取消、作者不点头：一个都不存 | 存的是「动手之前」，没动手就没有这个点 |
 * | 全书替换：有要换的才存，备注里的查找串与替换串截短；一份都没换成的不存 | 第 3 步之前、有要换的才存 |
 * | 按目录整理设定、导入原稿：点头之后、动手之前存 | 同上 |
 * | 从已写正文补齐：细纲那一步存过，其余几样不另存；细纲本来就齐的，其余几样那一步自己存 | 同一件事的两步，退回去就是整件事之前 |
 * | 补齐架构、批量拆细纲、批量展开设定、立即同步、从正文补记叙事线各存一个 | 十处批量动作都挂上了 |
 * | 存不下：照常跑 | ⚑11：存不下不挡批量动作 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir, makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
/** 这一次假模型该答什么。缺省答空（要调模型的那一步就此失败——存档点在那之前已经存了）。 */
let replyFn = () => '';
const made = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    plotFile: './src/core/model/plotFile.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    checkpoint: './src/core/features/checkpoint.ts',
    batch: './src/core/features/pipelineBatch.ts',
    bookFind: './src/core/views/bookFind.ts',
    bookReplace: './src/core/features/bookReplace.ts',
    lore: './src/core/features/lore.ts',
    importer: './src/core/features/importManuscript.ts',
    derive: './src/core/features/derive.ts',
    summarize: './src/core/features/summarize.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
      models: ['p/m'],
      concurrency: 1,
    }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages, i) => replyFn(messages, i) });
});

after(() => {
  for (const t of made) cleanup(t.dir, bundle.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix: `cpb-${prefix}`, title: '存档点' });
  made.push(t);
  fake.reset();
  replyFn = () => '';
  return t;
}

const list = (t) => bundle.checkpoints.listCheckpoints(t.project);
const bytesOf = (t, cp, rel) => bundle.checkpoints.readCheckpointBytes(t.project, cp, rel).then((b) => b.toString('utf8'));

/** 定稿第一步（照正文更新细纲）：有没有当前细纲，系统提示都以同一句开头。 */
const isSummary = (messages) => (messages[0]?.content ?? '').includes('建立可检索的章节档案');
const isState = (messages) => (messages[0]?.content ?? '').includes('依据本章正文更新角色的「当前状态」');
const summaryJson = (messages) => {
  const no = Number(/第\s*(\d+)\s*章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
  return JSON.stringify({ 梗概: `第 ${no} 章的事。`, 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [`第 ${no} 章查到一条线索`], 连续性事实: [] });
};

describe('checkpointBefore 本身', () => {
  test('与最近一个一模一样就不另存；改过一份就另存', async () => {
    const t = await fresh('dedupe');
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推开门。\n');
    const a = await bundle.checkpoint.checkpointBefore(t.project, '批量写章之前（第 1 章）');
    const b = await bundle.checkpoint.checkpointBefore(t.project, '全书替换之前');
    assert.ok(a);
    assert.equal(b, a);
    assert.equal((await list(t)).length, 1);
    assert.equal((await list(t))[0].note, '批量写章之前（第 1 章）');

    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推开门。\n');
    const c = await bundle.checkpoint.checkpointBefore(t.project, '全书替换之前');
    assert.notEqual(c, a);
    const all = await list(t);
    assert.deepEqual(all.map((x) => [x.note, x.auto]), [['全书替换之前', true], ['批量写章之前（第 1 章）', true]]);
  });

  test('还不是小说工程：给 undefined，不抛、不建目录', async () => {
    const d = makeTempDir('cpb-bare');
    made.push(d);
    d.write('chapters/001-雨夜.md', '# 雨夜\n');
    const project = bundle.project.NovelProject.open(d.dir);
    assert.equal(await bundle.checkpoint.checkpointBefore(project, '批量写章之前'), undefined);
    assert.equal(d.has('.novelforge'), false);
  });
});

// ---------------------------------------------------------------- 批量写章

const TITLES = ['停舟', '令牌', '夜访'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;

/** 排好前 3 章细纲（计划）的工程，还没有正文。 */
async function plotted(prefix) {
  const t = await fresh(prefix);
  t.write('.novelforge/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿\n\n## 当前状态\n\n（待补充）\n');
  const ws = new bundle.ws.Workspace(t.project);
  for (let no = 1; no <= TITLES.length; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: `第 ${no} 章的目的`,
        出场人物: '林昭',
        关键事件: `第 ${no} 章林昭查到一点东西。`,
        看点: `第 ${no} 章结尾：又一个人不见了。`,
      },
    });
  }
  t.project.invalidate();
  // 写正文一次写够；定稿两步各给一份。每一次调用的正文都不重样（重演检测按 n-gram 认）。
  replyFn = (messages, i) => {
    if (isSummary(messages)) return summaryJson(messages);
    if (isState(messages)) return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '往北去了' }] });
    return { text: filler(700, (i + 1) * 100), stop: 'end' };
  };
  return t;
}

describe('批量写章', () => {
  let t;
  let planBefore;
  before(async () => {
    t = await plotted('write');
    planBefore = t.read(PLOT(1));
  });

  test('确认框上取消：一个都不存', async () => {
    h.expect();
    assert.equal(await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 } }), 0);
    assert.deepEqual(await list(t), []);
  });

  test('点了「开始写章」：正好一个，备注说区间', async () => {
    h.expect('开始写章');
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 } });
    assert.equal(calls, 2);
    assert.ok(t.has(CH(1)) && t.has(CH(2)));
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '批量写章之前（第 1–2 章）');
    assert.equal(all[0].auto, true);
  });

  test('存的是动手之前的样子：新写的章不在里面，细纲还是没记 writtenFrom 的那一份', async () => {
    const [cp] = await list(t);
    assert.ok(!(CH(1) in cp.files) && !(CH(2) in cp.files), Object.keys(cp.files).join('\n'));
    assert.equal(await bytesOf(t, cp, PLOT(1)), planBefore);
    // 写完之后磁盘上那一份记了 writtenFrom：与存档点里的不一样了。
    assert.notEqual(t.read(PLOT(1)), planBefore);
  });

  test('写完即定稿：备注另说；前面写过的两章在这一个里面', async () => {
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 }, mode: 'finalize', call: {} });
    assert.ok(calls >= 2, `调用 ${calls} 次`);
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '批量写章（写完即同步）之前（第 3 章）');
    assert.ok(CH(1) in all[0].files && CH(2) in all[0].files);
    assert.ok(!(CH(3) in all[0].files));
  });
});

// ---------------------------------------------------------------- 全书替换

describe('全书替换', () => {
  let t;
  before(async () => {
    t = await fresh('replace');
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚推开山门。\n');
    t.write('chapters/002-下山.md', '# 下山\n\n林晚下山去了。\n');
    t.project.invalidate();
  });

  /** 预览一次，照预览拼请求（全勾）。 */
  async function request(query, replacement) {
    const q = { query, replacement, scopes: ['chapter'] };
    const preview = await bundle.bookFind.searchBook(t.project, q);
    const files = preview.files.map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.map((x) => ({ start: x.start, end: x.end })) }));
    return { ...q, files, dirty: [] };
  }

  test('有要换的：先存一个，存的是替换之前的那一份', async () => {
    const summary = await bundle.bookReplace.replaceInBook(t.project, await request('林晚', '林婉'));
    assert.equal(summary.files, 2);
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '全书替换之前（「林晚」→「林婉」，2 份）');
    assert.equal(await bytesOf(t, all[0], 'chapters/001-入宗.md'), '# 入宗\n\n林晚推开山门。\n');
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林婉推开山门。\n');
  });

  test('备注里的查找串、替换串截短', async () => {
    await bundle.bookReplace.replaceInBook(t.project, await request('林婉', '一个名字特别特别特别长的人物叫这个'));
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '全书替换之前（「林婉」→「一个名字特别特别特别长的…」，2 份）');
  });

  test('一处都没找到、或预览之后都改过（一份都换不成）：不存', async () => {
    const none = await bundle.bookReplace.replaceInBook(t.project, await request('不存在的词', '别的'));
    assert.equal(none.files, 0);
    const req = await request('名字', '称呼');
    t.write('chapters/001-入宗.md', '# 入宗\n\n别处改过了。\n');
    t.write('chapters/002-下山.md', '# 下山\n\n别处也改过了。\n');
    const stale = await bundle.bookReplace.replaceInBook(t.project, req);
    assert.equal(stale.files, 0);
    assert.equal(stale.skipped.length, 2);
    assert.equal((await list(t)).length, 2);
  });
});

// ---------------------------------------------------------------- 按目录整理设定

describe('按目录整理设定', () => {
  let t;
  before(async () => {
    t = await fresh('organize');
    t.write('.novelforge/lore/过所.md', '---\ntitle: 过所\nkeywords: [过所]\n---\n\n# 过所\n\n出入凭证。\n');
    t.project.invalidate();
  });

  test('作者没点「照这样整理」：不存', async () => {
    replyFn = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '过所', to: '制度' }] });
    h.expect('开始', undefined);
    await bundle.lore.organizeLore(t.project, 'unfiled');
    assert.ok(t.has('.novelforge/lore/过所.md'));
    assert.deepEqual(await list(t), []);
  });

  test('点了：搬之前存一个，里面是搬家之前的路径', async () => {
    replyFn = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '过所', to: '制度' }] });
    h.expect('开始', '照这样整理');
    await bundle.lore.organizeLore(t.project, 'unfiled');
    assert.ok(t.has('.novelforge/lore/制度/过所.md'));
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '按目录整理设定之前');
    assert.ok('.novelforge/lore/过所.md' in all[0].files);
    assert.ok(!('.novelforge/lore/制度/过所.md' in all[0].files));
  });
});

// ---------------------------------------------------------------- 导入原稿

describe('导入原稿', () => {
  const BOOK = ['第一章 入宗', '林昭站在山门前。', '第二章 雪夜', '雪下了一夜。'].join('\n');

  test('没点「导入」：不存', async () => {
    const t = await fresh('import-no');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.deepEqual(await list(t), []);
  });

  test('点了：导入之前存一个，里面还没有章节', async () => {
    const t = await fresh('import-ok');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', '导入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 2);
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '导入原稿之前');
    assert.deepEqual(Object.keys(all[0].files).filter((p) => p.startsWith('chapters/')), []);
  });
});

// ---------------------------------------------------------------- 从已写正文补齐

describe('从已写正文补齐', () => {
  let t;
  before(async () => {
    t = await fresh('derive');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 7)}\n`);
    t.project.invalidate();
  });

  // 细纲那一步照正文写细纲；其余几样（先是小说配置）答空，就此失败——存档点在那之前已经存了（或没存）。
  test('细纲那一步存过：其余几样接着做，不另存', async () => {
    replyFn = (messages) => (isSummary(messages) ? summaryJson(messages) : '');
    h.expect('先整理细纲', '10', '开始补齐');
    await bundle.derive.deriveFromText(t.project);
    assert.ok(t.has('.novelforge/summaries/001-入宗.md'));
    assert.ok(h.confirms.some((c) => c.actions.includes('开始补齐')), '其余几样那一步没走到');
    assert.ok(fake.calls.some((m) => !isSummary(m)), '其余几样没调到模型（没进任务）');
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '从已写正文补齐之前');
    assert.ok(!('.novelforge/summaries/001-入宗.md' in all[0].files));
  });

  test('细纲本来就齐：其余几样那一步自己存一个', async () => {
    h.expect('10', '开始补齐');
    await bundle.derive.deriveFromText(t.project);
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '从已写正文补齐之前');
    assert.ok('.novelforge/summaries/001-入宗.md' in all[0].files);
  });
});

// ---------------------------------------------------------------- 其余几处

describe('补齐架构、批量拆细纲、批量展开设定、立即同步、从正文补记叙事线', () => {
  test('补齐架构', async () => {
    const t = await fresh('settings');
    t.write('.novelforge/config.md', t.read('.novelforge/config.md').replace(/## 一句话\n\n（待补充）/, '## 一句话\n\n少年背着旧案入宗'));
    t.project.invalidate();
    h.expect('开始补齐');
    await bundle.batch.completeSettings(t.project);
    assert.deepEqual((await list(t)).map((x) => x.note), ['补齐架构之前']);
  });

  test('批量拆细纲', async () => {
    const t = await fresh('plots');
    writeOutline(t, outlineOf(5, { text: { 1: '林昭入宗查旧案。' } }));
    t.project.invalidate();
    h.expect('开始拆细纲');
    await bundle.batch.generatePlots(t.project, { range: { from: 1, to: 3 } });
    assert.deepEqual((await list(t)).map((x) => x.note), ['批量拆细纲之前（第 1–3 章）']);
  });

  test('批量展开设定', async () => {
    const t = await fresh('expand');
    t.write('.novelforge/lore/过所.md', '---\ntitle: 过所\nkeywords: [过所]\n---\n\n# 过所\n');
    t.project.invalidate();
    h.expect('开始展开');
    await bundle.lore.expandLoreEntries(t.project, ['.novelforge/lore/过所.md']);
    assert.ok(h.confirms.some((c) => c.actions.includes('开始展开')), '这一条不算能展开的');
    assert.deepEqual((await list(t)).map((x) => x.note), ['展开设定之前（1 条）']);
  });

  test('立即同步', async () => {
    const t = await fresh('sync');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 3)}\n`);
    t.write('chapters/002-雪夜.md', `# 雪夜\n\n${filler(300, 5)}\n`);
    t.project.invalidate();
    replyFn = (messages) => (isSummary(messages) ? summaryJson(messages) : '');
    h.expect('开始同步');
    await bundle.summarize.syncSummaries(t.project);
    assert.deepEqual((await list(t)).map((x) => x.note), ['同步章节细纲之前（2 章）']);
  });

  test('从正文补记叙事线（合并存档点时补上的第十处）', async () => {
    const t = await fresh('backfill');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 3)}\n`);
    t.write('chapters/002-雪夜.md', `# 雪夜\n\n${filler(300, 5)}\n`);
    t.write('.novelforge/threads/青崖旧案.md', '---\nkind: 主线\n---\n\n# 青崖旧案\n\n## 意图\n查清七年前那场火。\n');
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    for (const c of chapters) {
      const rel = `.novelforge/summaries/${c.relPath.replace(/^chapters\//, '')}`;
      t.write(rel, `---\nno: ${c.order}\ntitle: ${c.title}\nsourceHash: ${c.contentHash}\n---\n\n# ${c.title}\n\n## 梗概\n第 ${c.order} 章。\n`);
    }
    t.project.invalidate();
    h.expect('开始补记');
    await bundle.backfill.backfillThreads(t.project);
    const notes = (await list(t)).map((x) => x.note);
    assert.equal(notes.length, 1, '点了「开始补记」正好存一个（认事件答空、第 1 章就停，存档点在那之前已经存了）');
    assert.match(notes[0], /^从正文补记叙事线之前（.*第 1.*2 章.*）$/);
  });
});

// ---------------------------------------------------------------- 存不下

describe('存不下不挡批量动作（⚑11）', () => {
  test('存档点的目录被一份文件占着：照样替换', async () => {
    const t = await fresh('blocked');
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚推开山门。\n');
    fs.writeFileSync(t.rel('.novelforge/checkpoints'), '不是目录');
    t.project.invalidate();
    const q = { query: '林晚', replacement: '林婉', scopes: ['chapter'] };
    const preview = await bundle.bookFind.searchBook(t.project, q);
    const files = preview.files.map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.map((x) => ({ start: x.start, end: x.end })) }));
    const summary = await bundle.bookReplace.replaceInBook(t.project, { ...q, files, dirty: [] });
    assert.equal(summary.files, 1);
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林婉推开山门。\n');
    assert.deepEqual(await list(t), []);
  });
});
