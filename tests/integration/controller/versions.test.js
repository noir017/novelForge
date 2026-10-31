/**
 * 内置编辑器「不丢稿」的后端一半（`controller/versions.ts`）：冲突时的对比合并，与「版本」侧栏的列、读、现在存一版。
 * 合并视图用假宿主的 `mergeTexts` 代替（记下两边与称呼，按排好的回答交回）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 对比合并：左边磁盘上此刻的、右边编辑器里的，称呼说得清哪边是哪边 | 作者要看懂自己在挑什么 |
 * | 采纳之后回 `editorReplace`，带磁盘那份的 `base`（hash 对得上）、同一个 `requestId` | 前端据此换内容、换乐观锁基线，之后照常保存，不必强制保存 |
 * | 放弃 / 关掉：什么都不回；**任何一条路都不写盘** | 第 3 条：放回编辑区之后存不存由作者 |
 * | 没有 `mergeTexts` 的宿主：说一句，不抛 | 插件壳不用内置编辑器，但要防住 |
 * | 历史版本：列出来新的在前、读得回全文 | 侧栏的时间线与对比标签左边那一栏 |
 * | 存档点里的样子混进同一条时间线：`cp:` 开头、带备注；内容一样的连着几个只留最早那一个；读得回全文；改了备注重列跟上 | 一行说的是「到这个存档点它变成了这样」，三十个自动存档点里没动过的不刷三十行 |
 * | 现在存一版：存的是磁盘上的那一份，与最新一版一样时不重复存，之后重推列表 | 界面上说的「不是编辑器里没保存的那份」要成立 |
 * | 对比合并放回之前、前端放回一版（一处）之前发的 `saveVersion quiet`：磁盘上那一份先强制存一版，**节流拦不住** | 放回去的内容一存盘（开着自动保存时停笔两秒）就盖掉它；按节流它可能因为「改动小」不存 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CHAPTER = 'chapters/001-雨夜.md';
const DISK = '# 雨夜\n\n他推开门。\n\n雨下了三天。\n';
const EDITOR = '# 雨夜\n\n他慢慢推开门。\n\n雨下了三天。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];
/** 每一次 mergeTexts 的参数；`answers` 是接下来要交回的结论（没排就当关掉了）。 */
const merges = [];
const answers = [];

const ofType = (type) => posted.filter((m) => m.type === type);
/** 这一轮推给前端的提示（controller.toast 走的是 `toast` 消息）。 */
const toasts = () => ofType('toast').map((m) => `${m.level}: ${m.message}`).join('\n');

async function send(msg) {
  posted = [];
  await controller.handle(msg);
}

function snapNames(rel) {
  const dir = t.rel('.novelforge/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsx: './src/core/model/fs.ts',
    history: './src/core/workspace/history.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({
    name: 'standalone',
    settings: () => settings,
    overrides: {
      mergeTexts: async (title, before, after, opts) => {
        merges.push({ title, before, after, opts });
        const a = answers.shift();
        return typeof a === 'function' ? a({ before, after }) : a;
      },
    },
  });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'versions-ctl', title: '青云剑录' });
  t.write(CHAPTER, DISK);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('mergeWithDisk：冲突时对比合并', () => {
  let call;
  let reply;

  before(async () => {
    answers.push({ merged: '# 雨夜\n\n他慢慢推开门，雨还在下。\n\n雨下了三天。\n' });
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-1' });
    call = merges.at(-1);
    reply = ofType('editorReplace')[0];
  });

  test('左边是磁盘上此刻的那份，右边是编辑器里的', () => {
    assert.equal(call.before, DISK);
    assert.equal(call.after, EDITOR);
  });

  test('两栏的称呼说清哪边是哪边，采纳按钮是「放回编辑器」', () => {
    assert.deepEqual(call.opts.sides, { before: '磁盘上的', after: '编辑器里的' });
    assert.equal(call.opts.applyLabel, '放回编辑器');
    assert.ok(call.title.includes('磁盘上的') && call.title.includes('编辑器里的'), call.title);
    assert.ok(call.opts.message.includes(CHAPTER), call.opts.message);
  });

  test('采纳之后回 editorReplace：挑过的那份、同一个 requestId', () => {
    assert.equal(reply.requestId, 'r-merge-1');
    assert.equal(reply.path, CHAPTER);
    assert.equal(reply.text, '# 雨夜\n\n他慢慢推开门，雨还在下。\n\n雨下了三天。\n');
  });

  test('带上磁盘那一份当新的乐观锁基线（hash 与磁盘对得上）', () => {
    assert.equal(reply.base.text, DISK);
    assert.equal(reply.base.hash, bundle.fsx.hash(DISK));
  });

  test('不写盘', () => {
    assert.equal(t.read(CHAPTER), DISK);
  });

  test('放回之前把磁盘上那一份（别处改过的）先存进历史：合并结果一存盘就盖掉它', () => {
    const names = snapNames(CHAPTER);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(t.rel('.novelforge/history', CHAPTER, names[0]), 'utf8'), DISK);
  });

  test('原样采纳（一处没动）：放回的就是编辑器里那份，照样换基线', async () => {
    answers.push('apply');
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-2' });
    const r = ofType('editorReplace')[0];
    assert.equal(r.text, EDITOR);
    assert.equal(r.base.hash, bundle.fsx.hash(DISK));
  });

  test('放弃或关掉合并视图：什么都不回', async () => {
    answers.push('discard');
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-3' });
    assert.equal(ofType('editorReplace').length, 0);
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-4' });
    assert.equal(ofType('editorReplace').length, 0);
    assert.equal(t.read(CHAPTER), DISK);
  });

  test('磁盘上已经没有这份了：说一句，不开合并视图', async () => {
    const n = merges.length;
    await send({ type: 'mergeWithDisk', path: 'chapters/099-不存在.md', text: EDITOR, requestId: 'r-merge-5' });
    assert.equal(merges.length, n);
    assert.match(toasts(), /磁盘上已经没有/);
    assert.equal(ofType('editorReplace').length, 0);
  });
});

describe('宿主没有 mergeTexts：说明，不抛', () => {
  let saved;

  before(() => {
    saved = fakeHost.host.mergeTexts;
    fakeHost.host.mergeTexts = undefined;
  });

  after(() => {
    fakeHost.host.mergeTexts = saved;
  });

  test('对比合并：给一句说明，指向另外两颗按钮', async () => {
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-x' });
    assert.match(toasts(), /error: .*没有对比合并视图.*用磁盘版本覆盖编辑器/);
    assert.equal(ofType('editorReplace').length, 0);
  });
});

describe('历史版本：列、读、现在存一版', () => {
  const REL = 'chapters/002-风起.md';
  const V1 = '# 风起\n\n第一版。\n';
  const V2 = '# 风起\n\n第二版，' + '改得很多。'.repeat(80) + '\n';
  const V3 = '# 风起\n\n第三版。\n';
  const V4 = '# 风起\n\n第四版，磁盘上又改过。\n';
  let list;

  before(async () => {
    t.write(REL, V1);
    await controller.workspace.write(REL, { text: V2 }, { mode: 'overwrite', review: false });
    await controller.workspace.write(REL, { text: V3 }, { mode: 'overwrite', review: false });
    await send({ type: 'listVersions', path: REL });
    list = ofType('versions')[0];
  });

  test('列出来新的在前：时间、字数、字节数', () => {
    assert.equal(list.path, REL);
    assert.equal(list.unavailable, undefined);
    assert.equal(list.entries.length, 2);
    assert.ok(list.entries[0].time >= list.entries[1].time);
    assert.equal(list.entries[1].bytes, Buffer.byteLength(V1));
    assert.equal(list.entries[0].words, bundle.fsx.countWords(V2));
  });

  test('读某一个快照的全文：回同一个 requestId', async () => {
    await send({ type: 'readVersion', path: REL, id: list.entries[1].id, requestId: 'r-read' });
    const r = ofType('versionText')[0];
    assert.equal(r.requestId, 'r-read');
    assert.equal(r.id, list.entries[1].id);
    assert.equal(r.text, V1);
  });

  test('读不到的：带 error，不抛', async () => {
    await send({ type: 'readVersion', path: REL, id: '../../config.md', requestId: 'r-bad' });
    const r = ofType('versionText')[0];
    assert.equal(r.text, undefined);
    assert.match(r.error, /找不到/);
  });

  test('现在存一版：存的是磁盘上的那一份（不是编辑器里的），之后重推列表', async () => {
    t.write(REL, V4);
    await send({ type: 'saveVersion', path: REL });
    const names = snapNames(REL);
    assert.equal(names.length, 3);
    assert.equal(fs.readFileSync(t.rel('.novelforge/history', REL, names[0]), 'utf8'), V4);
    assert.match(toasts(), /磁盘上现在这一份/);
    assert.equal(ofType('versions')[0].entries.length, 3);
  });

  test('与最新一版一字不差时不重复存', async () => {
    await send({ type: 'saveVersion', path: REL });
    assert.equal(snapNames(REL).length, 3);
    assert.match(toasts(), /一字不差/);
  });

  test('quiet（放回一版之前发的）：照样存、一句话都不说、列表照样重推', async () => {
    t.write(REL, V1);
    await send({ type: 'saveVersion', path: REL, quiet: true });
    assert.equal(snapNames(REL).length, 4);
    assert.equal(toasts(), '');
    assert.equal(ofType('versions')[0].entries.length, 4);
    await send({ type: 'saveVersion', path: REL, quiet: true });
    assert.equal(snapNames(REL).length, 4);
    assert.equal(toasts(), '', '一样的不重复存，也不说');
  });

  test('不是创作产物：列表是空的、带原因；现在存一版报错不存', async () => {
    t.write('随手记.md', '一');
    await send({ type: 'listVersions', path: '随手记.md' });
    const r = ofType('versions')[0];
    assert.deepEqual(r.entries, []);
    assert.match(r.unavailable, /不是工程里的创作产物/);
    await send({ type: 'saveVersion', path: '随手记.md' });
    assert.match(toasts(), /error: .*不是工程里的创作产物/);
    assert.equal(fs.existsSync(t.rel('.novelforge/history/随手记.md')), false);
  });

  test('还没有快照的文件：空列表，不带原因', async () => {
    t.write('chapters/003-无痕.md', '还没被覆盖过。');
    await send({ type: 'listVersions', path: 'chapters/003-无痕.md' });
    const r = ofType('versions')[0];
    assert.deepEqual(r.entries, []);
    assert.equal(r.unavailable, undefined);
  });
});

describe('放回之前那一下：节流本来会丢掉的那一份也留住', () => {
  const REL = 'chapters/004-残灯.md';
  const BIG = '灯芯烧到了底。'.repeat(200);
  before(async () => {
    t.write(REL, BIG);
    // 第一次覆盖：存下 BIG。紧接着一处小改：不到 10 分钟、改动很小，节流不存——磁盘上是「BIG 一二」、历史里只有 BIG。
    await controller.workspace.write(REL, { text: `${BIG}一` }, { mode: 'overwrite', review: false });
    await controller.workspace.write(REL, { text: `${BIG}一二` }, { mode: 'overwrite', review: false });
  });

  test('起点：历史里只有 BIG（「BIG 一」那次被节流了）', () => {
    assert.equal(snapNames(REL).length, 1);
  });

  test('前端把 BIG 那一版放回编辑区之前发 saveVersion quiet：磁盘上的「BIG 一二」先进了历史', async () => {
    await send({ type: 'saveVersion', path: REL, quiet: true });
    const names = snapNames(REL);
    assert.equal(names.length, 2);
    assert.equal(fs.readFileSync(t.rel('.novelforge/history', REL, names[0]), 'utf8'), `${BIG}一二`);
  });

  test('之后把放回的那份存盘（编辑器保存）：「BIG 一二」仍在历史里，可以再恢复回来', async () => {
    await controller.workspace.write(REL, { text: BIG }, { mode: 'overwrite', review: false });
    assert.equal(t.read(REL), BIG);
    const texts = snapNames(REL).map((n) => fs.readFileSync(t.rel('.novelforge/history', REL, n), 'utf8'));
    assert.ok(texts.includes(`${BIG}一二`));
  });
});

describe('存档点里的样子混进同一条时间线', () => {
  const REL = 'chapters/005-渡口.md';
  const C1 = '# 渡口\n\n船还没来。\n';
  const C2 = '# 渡口\n\n船来了，没有人下来。\n';
  const C3 = '# 渡口\n\n船来了，下来一个戴斗笠的人。\n';
  const ids = {};
  let list;

  before(async () => {
    const base = Date.now() - 60_000;
    t.write(REL, C1);
    ids.one = (await bundle.checkpoints.createCheckpoint(t.project, { note: '一', auto: false, now: base })).id;
    // 这一份没动，只是又存了一个（自动的也一样）：时间线上不该多一行。
    ids.two = (await bundle.checkpoints.createCheckpoint(t.project, { note: '二', auto: false, now: base + 1000 })).id;
    t.write(REL, C2);
    ids.three = (await bundle.checkpoints.createCheckpoint(t.project, { note: '三', auto: false, now: base + 2000 })).id;
    // 经网关覆盖：存下 C2 的快照（时间是此刻，排在存档点前面）。
    await controller.workspace.write(REL, { text: C3 }, { mode: 'overwrite', review: false });
    await send({ type: 'listVersions', path: REL });
    list = ofType('versions')[0];
  });

  test('新的在前：快照、存档点「三」、存档点「一」；「二」与「一」一样，不另列', () => {
    assert.deepEqual(
      list.entries.map((e) => (e.checkpoint ? `cp ${e.checkpoint.note}` : 'snapshot')),
      ['snapshot', 'cp 三', 'cp 一']
    );
  });

  test('存档点那几行：id 是 cp: 加存档点的 id，带备注与手动 / 自动、字数', () => {
    const three = list.entries[1];
    assert.equal(three.id, `cp:${ids.three}`);
    assert.deepEqual(three.checkpoint, { note: '三', auto: false });
    assert.equal(three.words, bundle.fsx.countWords(C2));
    assert.equal(three.bytes, Buffer.byteLength(C2));
  });

  test('读得回存档点里那一份的全文', async () => {
    await send({ type: 'readVersion', path: REL, id: `cp:${ids.one}`, requestId: 'r-cp' });
    const r = ofType('versionText')[0];
    assert.equal(r.requestId, 'r-cp');
    assert.equal(r.text, C1);
  });

  test('存档点里没有这一份、存档点不在：带 error，不抛', async () => {
    await send({ type: 'readVersion', path: 'chapters/099-没有.md', id: `cp:${ids.one}`, requestId: 'r-cp2' });
    assert.match(ofType('versionText')[0].error, /里没有/);
    await send({ type: 'readVersion', path: REL, id: 'cp:2001-01-01_00-00-00+0800', requestId: 'r-cp3' });
    assert.match(ofType('versionText')[0].error, /找不到/);
  });

  test('改了备注：重列时跟上（读过的清单按大小与修改时间认，不拿旧的）', async () => {
    await bundle.checkpoints.noteCheckpoint(t.project, ids.three, '三，改过备注');
    await send({ type: 'listVersions', path: REL });
    assert.equal(ofType('versions')[0].entries[1].checkpoint.note, '三，改过备注');
  });
});
