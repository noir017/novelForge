/**
 * 内置编辑器「不丢稿」的后端一半（`controller/versions.ts`）：冲突时的对比合并，与历史版本的列、读、对比、
 * 现在存一版。合并视图用假宿主的 `mergeTexts` 代替（记下两边与称呼，按排好的回答交回）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 对比合并：左边磁盘上此刻的、右边编辑器里的，称呼说得清哪边是哪边 | 作者要看懂自己在挑什么 |
 * | 采纳之后回 `editorReplace`，带磁盘那份的 `base`（hash 对得上）、同一个 `requestId` | 前端据此换内容、换乐观锁基线，之后照常保存，不必强制保存 |
 * | 放弃 / 关掉：什么都不回；**任何一条路都不写盘** | 第 3 条：放回编辑区之后存不存由作者 |
 * | 没有 `mergeTexts` 的宿主：说一句，不抛 | 插件壳不用内置编辑器，但要防住 |
 * | 历史版本：列出来新的在前、读得回全文、对比交回挑过的那份（不带 base）、一处没挑不回 | 恢复从不直接写盘 |
 * | 现在存一版：存的是磁盘上的那一份，与最新一版一样时不重复存，之后重推列表 | 界面上说的「不是编辑器里没保存的那份」要成立 |
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

  test('对比历史版本：给一句说明（快照在哪）', async () => {
    await send({ type: 'compareVersion', path: CHAPTER, id: '2026-10-18_14-32-05+0800.txt', text: EDITOR, requestId: 'r-y' });
    assert.match(toasts(), /\.novelforge\/history/);
  });
});

describe('历史版本：列、读、对比、现在存一版', () => {
  const REL = 'chapters/002-风起.md';
  const V1 = '# 风起\n\n第一版。\n';
  const V2 = '# 风起\n\n第二版，' + '改得很多。'.repeat(80) + '\n';
  const V3 = '# 风起\n\n第三版。\n';
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

  test('对比：左边快照、右边编辑器里的，挑过的那份经 editorReplace 回来，不带 base、不写盘', async () => {
    answers.push({ merged: V1 });
    await send({ type: 'compareVersion', path: REL, id: list.entries[1].id, text: V3, requestId: 'r-cmp' });
    const call = merges.at(-1);
    assert.equal(call.before, V1);
    assert.equal(call.after, V3);
    assert.deepEqual(call.opts.sides, { before: '快照', after: '编辑器里的' });
    const r = ofType('editorReplace')[0];
    assert.equal(r.requestId, 'r-cmp');
    assert.equal(r.text, V1);
    assert.equal(r.base, undefined);
    assert.equal(t.read(REL), V3);
  });

  test('对比时一处都没挑（原样采纳）：不回，说一句', async () => {
    answers.push('apply');
    await send({ type: 'compareVersion', path: REL, id: list.entries[1].id, text: V3, requestId: 'r-cmp2' });
    assert.equal(ofType('editorReplace').length, 0);
    assert.match(toasts(), /没有挑快照里的任何一处/);
  });

  test('现在存一版：存的是磁盘上的那一份（不是编辑器里的），之后重推列表', async () => {
    await send({ type: 'saveVersion', path: REL });
    const names = snapNames(REL);
    assert.equal(names.length, 3);
    assert.equal(fs.readFileSync(t.rel('.novelforge/history', REL, names[0]), 'utf8'), V3);
    assert.match(toasts(), /磁盘上现在这一份/);
    assert.equal(ofType('versions')[0].entries.length, 3);
  });

  test('与最新一版一字不差时不重复存', async () => {
    await send({ type: 'saveVersion', path: REL });
    assert.equal(snapNames(REL).length, 3);
    assert.match(toasts(), /一字不差/);
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
