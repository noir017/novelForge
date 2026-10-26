/**
 * 工程页「存档点…」弹窗的后端一半（`controller/checkpoints.ts`）：五条消息走一遍。存储与退回的细节在
 * tests/integration/workspace/checkpoints.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 列表：还不是工程时说为什么；存一个之后 toast 说存了几份、列表重推，带正文章数与字数 | 面板上看得出每个点有多大 |
 * | 跟现在比：三类 + `hashNow`；存档点不在了回 `error` | 面板要据此画、退回时原样带回来 |
 * | 退回：toast 汇总、`pushState`、重推列表（多了「退回之前」）与这个存档点的比较（变成一模一样） | 作者看得到退回了什么、还能退回来 |
 * | 有任务在跑：拒绝，什么都不动 | 一边写一边退，谁也说不清 |
 * | 写备注：自动的留住 | 不被自动裁掉 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CHAPTER = 'chapters/001-雨夜.md';
const ORIGINAL = '# 雨夜\n\n他推开门。\n\n雨下了三天。\n';
const CHANGED = '# 雨夜\n\n他慢慢推开门。\n\n雨下了三天。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];

const ofType = (type) => posted.filter((m) => m.type === type);
const toasts = () => ofType('toast').map((m) => `${m.level}: ${m.message}`).join('\n');

async function send(msg) {
  posted = [];
  await controller.handle(msg);
}

/** 面板上点「整本退回」会发的那一份请求（从最近一次 `checkpointDiff` 里拼）。 */
function wholeRequest(diff) {
  const expect = {};
  for (const e of diff.entries) expect[e.path] = e.hashNow ?? null;
  return { id: diff.id, paths: diff.entries.filter((e) => e.status !== 'added').map((e) => e.path), trash: [], expect, dirty: [] };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    progress: './src/core/runtime/progress.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'checkpoints-ctl', title: '青云剑录' });
  t.write(CHAPTER, ORIGINAL);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('列表与存', () => {
  test('一个都没有时列表是空的', async () => {
    await send({ type: 'listCheckpoints' });
    assert.deepEqual(ofType('checkpoints')[0], { type: 'checkpoints', entries: [] });
  });

  test('存一个：toast 说存了几份，列表重推，带正文章数与字数', async () => {
    await send({ type: 'createCheckpoint', note: '开头' });
    assert.match(toasts(), /^info: 已存一个存档点：\d+ 份文件/);
    const [entry] = ofType('checkpoints')[0].entries;
    assert.equal(entry.note, '开头');
    assert.equal(entry.auto, false);
    assert.equal(entry.chapters, 1);
    assert.ok(entry.chapterWords > 0);
    assert.ok(entry.files > 1);
    assert.deepEqual(entry.skipped, []);
  });

  test('还不是小说工程：列表带上原因，存的时候说一句', async () => {
    const dir = makeTempDir('checkpoints-ctl-empty');
    const other = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    const got = [];
    other.attach({ kind: 'sidebar', post: (m) => got.push(m), reveal() {} });
    try {
      await other.handle({ type: 'listCheckpoints' });
      await other.handle({ type: 'createCheckpoint', note: '' });
      const list = got.find((m) => m.type === 'checkpoints');
      assert.match(list.unavailable, /还不是小说工程/);
      assert.ok(got.some((m) => m.type === 'toast' && m.level === 'error' && /还不是小说工程/.test(m.message)));
      assert.equal(fs.existsSync(`${dir.dir}/.novelforge`), false);
    } finally {
      other.dispose();
      cleanup(dir.dir);
    }
  });
});

describe('跟现在比与退回', () => {
  let id;
  let diff;

  before(async () => {
    await send({ type: 'listCheckpoints' });
    id = ofType('checkpoints')[0].entries[0].id;
    t.write(CHAPTER, CHANGED);
    await send({ type: 'checkpointDiff', id });
    diff = ofType('checkpointDiff')[0].diff;
  });

  test('跟现在比：改过的那一章，带 hashNow', () => {
    assert.equal(diff.id, id);
    assert.deepEqual(
      diff.entries.map((e) => [e.path, e.status, e.kind]),
      [[CHAPTER, 'changed', 'chapter']]
    );
    assert.ok(diff.entries[0].hashNow);
    assert.ok(diff.unchanged > 0);
  });

  test('存档点不在了：回 error', async () => {
    await send({ type: 'checkpointDiff', id: '2020-01-01_00-00-00+0800' });
    const reply = ofType('checkpointDiff')[0];
    assert.equal(reply.diff, undefined);
    assert.match(reply.error, /找不到这个存档点/);
  });

  test('有任务在跑：拒绝，什么都不动', async () => {
    let release;
    const running = bundle.progress.runTask('批量写章', () => new Promise((r) => (release = r)));
    try {
      await send({ type: 'restoreCheckpoint', request: wholeRequest(diff) });
      assert.match(toasts(), /^error: 有任务在跑/);
      assert.equal(t.read(CHAPTER), CHANGED);
    } finally {
      release();
      await running;
    }
  });

  test('退回：toast 汇总，pushState，列表多了「退回之前」，这个存档点跟现在一模一样了', async () => {
    await send({ type: 'restoreCheckpoint', request: wholeRequest(diff) });
    assert.equal(t.read(CHAPTER), ORIGINAL);
    assert.match(toasts(), /^info: 已退回 1 份。退回之前的样子存成了一个存档点/);
    assert.ok(posted.some((m) => m.type === 'state'), '退回之后要 pushState');
    const list = ofType('checkpoints')[0].entries;
    assert.equal(list.length, 2);
    assert.equal(list[0].auto, true);
    assert.match(list[0].note, /^退回到.*「开头」之前$/);
    const again = ofType('checkpointDiff')[0];
    assert.equal(again.id, id);
    assert.deepEqual(again.diff.entries, []);
  });

  test('写备注：自动的「退回之前」就此留住', async () => {
    await send({ type: 'listCheckpoints' });
    const auto = ofType('checkpoints')[0].entries.find((e) => e.auto);
    await send({ type: 'noteCheckpoint', id: auto.id, note: '改坏之前' });
    const after = ofType('checkpoints')[0].entries.find((e) => e.id === auto.id);
    assert.equal(after.auto, false);
    assert.equal(after.note, '改坏之前');
    assert.match(toasts(), /会一直留着/);
  });
});
