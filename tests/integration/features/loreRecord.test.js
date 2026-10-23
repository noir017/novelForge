/**
 * 记设定（设定名录，2026-10-18）：定稿时顺手记进细纲的「设定」一节，另外允许单独记一章、补记老章节。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 定稿那一次的提示里有本书的分类表与这一章提到的已有设定 | 分类每本书自己定；同一个东西照抄已有名字 |
 * | 定稿不多调：设定并进第一步 | 作者定案 1：并进定稿，+0 次 |
 * | 写进「设定」一节前校验：名字不在正文里的丢、人名丢、已有条目换成标题与目录、说明没依据的清空 | 「设定」一节是名录的唯一来源，模型编的名字会变成凭空的「未建条目」 |
 * | 「设定」一节不进内容指纹：定稿、补记之后正文都不挂 ⟳ | 补记老章节不能把它们全挂上 ⟳ |
 * | 单独记一章：先报 1 次、只换「设定」一节，另外七节一字不动 | 作者定案 1：允许单独调用；第 4 条 |
 * | 补记只挑定稿过、正文没再改过、还没记过的章，串行 | 第 4 条：没定稿的不偷偷补 |
 * | 没定稿的章不让单独记 | 「设定」一节是计划，记了也会被定稿冲掉 |
 * | 解析不出来：「设定」一节不动，挂黄 ❗ | 第 16 条 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

const TEXT = [
  '雨下了一整夜。林昭进了青崖镇，镇口的守卫查验过所。',
  '停舟客栈是镇上唯一的客栈，二层木楼，地板踩上去会响。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
].join('\n\n');

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/00${no}-第${no}章.md`;

/** 定稿那一次的回答（JSON）。 */
const SUMMARY = {
  梗概: '林昭进了青崖镇，住进停舟客栈。',
  出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
  时间地点: '青崖镇，夜。',
  关键事件: ['进镇', '住店'],
  状态变更: '',
  连续性事实: ['沈氏把残令收进袖中'],
  设定: [
    { name: '青崖', category: '地点', fact: '' },
    { name: '停舟客栈', category: '地域/青崖', fact: '镇上唯一的客栈，二层木楼' },
    { name: '过所', category: '制度', fact: '出入城镇要交十两银子' },
    { name: '黑市', category: '地点', fact: '' },
    { name: '林昭', category: '人物', fact: '' },
  ],
};

let recordReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify(SUMMARY);
  }
  if (system.includes('负责记下这一章正文里出现了哪些设定')) {
    return recordReply();
  }
  return '（认不出这一步）';
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    finalize: './src/core/features/finalize.ts',
    loreRecord: './src/core/features/loreRecord.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipeline: './src/core/views/pipeline.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: makeSettings({ contextWindow: 16000, maxOutputTokens: 1000 }) });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'loreRecord', title: '记设定测试' });
  project = t.project;
  for (const no of [1, 2, 3]) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
  t.write('.novelforge/lore/地域/青崖镇.md', '---\ntitle: 青崖镇\nkeywords: [青崖]\n---\n\n# 青崖镇\n\n偏僻小镇。\n');
  t.write('.novelforge/lore/信物/崖字令牌.md', '---\ntitle: 崖字令牌\nkeywords: [令牌]\n---\n\n# 崖字令牌\n\n木牌。\n');
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('定稿时顺手记', () => {
  let outcome;
  let plot;
  let user;

  before(async () => {
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    user = fake.calls[0][1].content;
    project.invalidate();
    plot = await project.getPlot(2);
  });

  // 记设定不另调：没有角色卡时只有更新细纲那 1 次，加叙事线认事件那 1 次（叙事线重做：每次定稿都认）。
  test('不多调：记设定并在更新细纲那一次里，没有角色卡时一共 2 次（细纲 + 认叙事线）', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(outcome.calls, 2);
  });

  test('提示里有本书的分类表，与这一章正文里提到的已有设定', () => {
    assert.ok(user.includes('本书的设定分类：地域、信物。'), user.slice(0, 600));
    assert.ok(user.includes('已有设定（本章正文里提到的；同一个东西请照抄这里的名字）：青崖镇〔地域〕（也叫 青崖）。'), user.slice(0, 600));
    assert.ok(!user.includes('崖字令牌'), '正文里没提到的不列');
  });

  test('「设定」一节：名字不在正文里的、人名丢掉；已有条目换成标题与实际目录；没依据的说明清空', () => {
    assert.deepEqual(plot.lore, [
      { name: '青崖镇', category: '地域', note: '' },
      { name: '停舟客栈', category: '地域/青崖', note: '镇上唯一的客栈，二层木楼' },
      { name: '过所', category: '制度', note: '' },
    ]);
  });

  test('「设定」一节不进内容指纹：定稿刚写完，正文不挂 ⟳', async () => {
    const row = (await bundle.pipeline.buildPipelineIndex(project)).rows.find((r) => r.no === 2);
    assert.equal(row.chapter.upstreamStale, false);
    assert.equal(row.summary.stale, false);
  });
});

describe('单独记一章', () => {
  let before2;
  before(async () => {
    before2 = t.read(PLOT(2));
    recordReply = () =>
      JSON.stringify({ 设定: [{ name: '崖字令牌', category: '信物', fact: '' }, { name: '残令', category: '信物', fact: '' }] });
    fake.reset();
    h.expect('开始记');
    await bundle.loreRecord.recordLore(project, CH(2));
  });

  test('先报次数：1 次，只换「设定」一节', () => {
    const c = h.confirms[0];
    assert.match(c.message, /读第 2 章正文，每章调用模型 1 次，共 1 次。只换掉这一章细纲的「设定」一节/);
    assert.equal(fake.callCount(), 1);
  });

  test('只换「设定」一节，另外七节与 frontmatter 一字不动', () => {
    const after2 = t.read(PLOT(2));
    const cut = (s) => s.slice(0, s.indexOf('## 设定'));
    assert.equal(cut(after2), cut(before2));
    // 令牌不在正文里（只有「残令」），丢掉。
    assert.match(after2, /## 设定\n\n- 残令〔信物〕\n?$/);
  });

  test('没定稿的章不让单独记', async () => {
    h.toasts.length = 0;
    fake.reset();
    await bundle.loreRecord.recordLore(project, CH(3));
    assert.equal(fake.callCount(), 0);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /第 3 章还没同步/);
  });
});

describe('补记', () => {
  before(async () => {
    // 第 1 章：功能上线之前定稿的（没有「设定」一节）；第 3 章：定稿过但正文后来又改了。
    const ch1 = await chapterNo(1);
    t.write(
      PLOT(1),
      `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch1.contentHash}\n---\n\n# 第1章 第1章\n\n## 关键事件\n\n- 进镇\n`
    );
    t.write(PLOT(3), '---\nno: 3\ntitle: 第3章\nsourceHash: 0000\n---\n\n# 第3章 第3章\n\n## 关键事件\n\n- 进镇\n');
    project.invalidate();
  });

  test('只挑定稿过、正文没再改过、还没记过的章；改过的说出来', async () => {
    recordReply = () => JSON.stringify({ 设定: [{ name: '停舟客栈', category: '地域', fact: '' }] });
    fake.reset();
    h.expect('开始记');
    await bundle.loreRecord.recordLore(project);
    const c = h.confirms[h.confirms.length - 1];
    assert.match(c.message, /读1 章正文，每章调用模型 1 次，共 1 次/);
    assert.match(c.detail, /另有 1 章同步之后正文又改过，这次不记/);
    assert.equal(fake.callCount(), 1);
    project.invalidate();
    assert.deepEqual((await project.getPlot(1)).lore, [{ name: '停舟客栈', category: '地域', note: '' }]);
    assert.equal((await project.getPlot(3)).lore, undefined);
  });

  test('解析不出来：「设定」一节不动，挂黄 ❗', async () => {
    t.write(PLOT(1), t.read(PLOT(1)).replace(/\n## 设定[\s\S]*$/, '\n'));
    project.invalidate();
    recordReply = () => '不是 JSON';
    fake.reset();
    h.expect('开始记');
    await bundle.loreRecord.recordLore(project);
    project.invalidate();
    assert.equal((await project.getPlot(1)).lore, undefined);
    const failures = (await bundle.errorLog.listActiveFailures(project))[CH(1)] ?? [];
    assert.ok(failures.some((f) => f.op === 'loreRecord' && f.severity === 'warn'), JSON.stringify(failures));
  });
});
