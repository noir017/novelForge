/**
 * Draft store：未采纳的产物存哪里。
 *
 * 存在理由与从前 `ChatTurn.artifact` 存进会话是同一条：**刷新网页后采纳按钮
 * 还在**，不然刚生成的四个场景就只剩一段谁也用不上的 JSON。
 *
 * 所以这组用例钉三件事：内存里存得住、随会话文件往返一趟还认得出、
 * 会话文件被手改坏时**不抛**（第 1 条：容错优先）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let drafts;
let sessionMod;
let WORK;
let store;

/** 一份最小可用的 draft。 */
function makeDraft(over = {}) {
  return {
    id: 'd1',
    action: { stage: 'plot', capability: 'generate' },
    target: { kind: 'plot', plotRelPath: '.novelforge/plots/001-夜入青云.md' },
    raw: '{"剧情脉络":"进宗门"}',
    artifact: { kind: 'plot', sections: { 目标: '', 剧情脉络: '进宗门', 冲突与转折: '', 伏笔与回收: '' } },
    summary: '剧情 · 1/4 节',
    words: 3,
    createdAt: '2026-08-15T10:00:00.000Z',
    ...over,
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    session: './src/core/model/session.ts',
    drafts: './src/core/generation/drafts.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  drafts = bundle.drafts;
  sessionMod = bundle.session;
  ({ dir: WORK } = makeTempDir('drafts'));
  const project = bundle.project.NovelProject.open(WORK);
  store = new sessionMod.SessionStore(project);
});

after(() => {
  cleanup(WORK);
});

describe('DraftStore · 内存', () => {
  let s;

  before(() => {
    s = new drafts.DraftStore();
    s.put(makeDraft(), 'sess-a');
    s.put(makeDraft({ id: 'd2' }), 'sess-a');
    s.put(makeDraft({ id: 'd3' }), 'sess-b');
  });

  test('put 之后取得回来', () => {
    assert.equal(s.get('d1').raw, '{"剧情脉络":"进宗门"}');
  });

  test('取不认识的 id 给 undefined，不抛', () => {
    assert.equal(s.get('没有这个'), undefined);
  });

  test('bySession 只给那个会话的', () => {
    assert.deepEqual(s.bySession('sess-a').map((d) => d.id), ['d1', 'd2']);
  });

  test('另一个会话互不干扰', () => {
    assert.deepEqual(s.bySession('sess-b').map((d) => d.id), ['d3']);
  });

  // 会话切换/关闭时清掉那个会话的草稿：留着只会把内存撑成一本书。
  test('dropBySession 清掉那一个会话', () => {
    s.dropBySession('sess-a');
    assert.equal(s.get('d1'), undefined);
  });

  test('dropBySession 不动别的会话', () => {
    assert.equal(s.get('d3').id, 'd3');
  });

  test('drop 不存在的会话不抛', () => {
    s.dropBySession('从来没有过');
    assert.equal(s.get('d3').id, 'd3');
  });
});

describe('DraftStore · 一个会话留多少份', () => {
  let s;
  let kept;

  before(() => {
    s = new drafts.DraftStore();
    for (let i = 1; i <= drafts.MAX_DRAFTS_PER_SESSION + 5; i++) {
      s.put(makeDraft({ id: `d${i}` }), 'sess');
    }
    kept = s.bySession('sess');
  });

  // draft.raw 与 ChatTurn.content 是同一段文字，全留着等于把会话文件写两遍。
  test('超出上限就丢最老的', () => {
    assert.equal(kept.length, drafts.MAX_DRAFTS_PER_SESSION, String(kept.length));
  });

  test('留下的是最近的那些', () => {
    assert.equal(kept[kept.length - 1].id, `d${drafts.MAX_DRAFTS_PER_SESSION + 5}`);
  });

  test('被挤掉的取不到了', () => {
    assert.equal(s.get('d1'), undefined);
  });
});

describe('随会话往返一趟', () => {
  let reloaded;
  let s;

  before(async () => {
    const session = store.create();
    session.turns.push({
      id: 't1',
      role: 'assistant',
      content: '{"剧情脉络":"进宗门"}',
      at: '2026-08-15T10:00:00.000Z',
      draftId: 'd1',
      artifact: { where: '第 1 章 · 剧情', summary: '剧情 · 1/4 节', overwrites: false },
    });
    session.drafts = [makeDraft()];
    await store.write(session);
    reloaded = await store.read(session.id);
    s = new drafts.DraftStore();
    s.load(session.id, reloaded.drafts);
  });

  test('草稿跟着会话落了盘', () => {
    assert.equal(reloaded.drafts.length, 1, JSON.stringify(reloaded.drafts));
  });

  test('落点跟着一起回来了', () => {
    assert.equal(reloaded.drafts[0].target.plotRelPath, '.novelforge/plots/001-夜入青云.md');
  });

  test('动作跟着一起回来了', () => {
    assert.equal(reloaded.drafts[0].action.capability, 'generate');
  });

  test('原文跟着一起回来了', () => {
    assert.equal(reloaded.drafts[0].raw, '{"剧情脉络":"进宗门"}');
  });

  // 刷新网页后采纳按钮还在——这就是 draft 落盘的全部理由。
  test('气泡上的 draftId 还认得出', () => {
    assert.equal(reloaded.turns[0].draftId, 'd1');
  });

  test('展示快照也还在', () => {
    assert.equal(reloaded.turns[0].artifact.summary, '剧情 · 1/4 节');
  });

  test('装回内存后取得到', () => {
    assert.equal(s.get('d1').summary, '剧情 · 1/4 节');
  });
});

describe('会话文件被手改坏', () => {
  let session;
  let reloaded;

  before(async () => {
    session = store.create();
    session.turns.push({
      id: 't1', role: 'assistant', content: 'x', at: '2026-08-15T10:00:00.000Z',
      draftId: '这份草稿已经没了',
      artifact: { where: '第 1 章 · 剧情', summary: '剧情 · 1/4 节', overwrites: false },
    });
    session.turns.push({
      id: 't2', role: 'assistant', content: 'y', at: '2026-08-15T10:01:00.000Z', draftId: 'd1',
    });
    session.drafts = [
      makeDraft(),
      // 认不出的几种：不是对象、没有 id、target 是垃圾。
      null,
      { raw: '没有 id' },
      { id: 'd9', action: { stage: '瞎写' }, target: '不是对象', raw: 123 },
    ];
    await store.write(session);
    reloaded = await store.read(session.id);
  });

  test('读得出来，没抛', () => {
    assert.ok(reloaded, '会话读不出来了');
  });

  test('认得出的那份留下', () => {
    assert.ok(reloaded.drafts.some((d) => d.id === 'd1'), JSON.stringify(reloaded.drafts));
  });

  test('认不出的丢掉', () => {
    assert.equal(reloaded.drafts.length, 2, JSON.stringify(reloaded.drafts.map((d) => d.id)));
  });

  // 字段坏掉的那份不整体作废：id 在就还认得出是哪一轮产出的，
  // 其余字段按容错默认值补——归一化的 target 回落到全书大纲。
  test('坏字段按默认值补上', () => {
    const d9 = reloaded.drafts.find((d) => d.id === 'd9');
    assert.equal(d9.target.kind, 'outline', JSON.stringify(d9.target));
    assert.equal(d9.raw, '', JSON.stringify(d9.raw));
  });

  // 气泡上的展示快照留着——「这一轮产出过一份剧情」翻回来看得出来。
  // 草稿在不在已经与它无关了：写不写盘在产出的当下就问过了，气泡上没有
  // 任何能触发写入的按钮，也就没有「草稿过期了怎么办」这回事。
  test('展示快照留着', () => {
    assert.equal(reloaded.turns[0].artifact.summary, '剧情 · 1/4 节');
  });
});

describe('没有 drafts 字段的老会话', () => {
  let reloaded;

  before(async () => {
    const session = store.create();
    session.turns.push({ id: 't1', role: 'user', content: '你好', at: '2026-08-15T10:00:00.000Z' });
    await store.write(session);
    // 手工抹掉 drafts 键，模拟二期之前写下的会话文件。
    const file = path.join(WORK, '.novelforge', 'sessions', `${session.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.drafts;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    reloaded = await store.read(session.id);
  });

  test('读得出来', () => {
    assert.ok(reloaded);
  });

  test('drafts 退化成空数组', () => {
    assert.deepEqual(reloaded.drafts, []);
  });
});
