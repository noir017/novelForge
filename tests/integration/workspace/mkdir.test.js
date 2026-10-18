/**
 * 网关的建目录（`Workspace.mkdir`），以及从前绕过网关直接 `fs.mkdir` 的那一处：工程页 / 文件页的「新建文件夹」
 * （`files/fileOps.ts` 的 `newFolder`）。设定名录「按目录整理」那一处不再先建目录（`ws.move` 落盘前自己补齐父目录），
 * 测在 tests/integration/features/lore.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 建得出来，可以一次建几层 | 设定分类 `宗门/正道` 这样的多层目录 |
 * | 已有同名（目录或文件）报 exists，什么都不动 | 第 3 条 |
 * | 回收站、会话目录、历史版本里建不了；出不了工程根 | 与写文件同一套守卫（第 7 条） |
 * | 「新建文件夹」经网关建，文案不变 | 第 7 条：写盘只有一条路 |
 * | 文件也写不进、搬不进历史版本 | 历史版本是网关自己存的副本，作者的操作塞不进假快照 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（没抛）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    fileOps: './src/core/files/fileOps.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsmkdir', title: '建目录测试' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
  t.write('chapters/001-楔子.md', '# 楔子\n');
  t.write('.novelforge/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt', '旧稿\n');
  t.write('notes/备忘.txt', '随手记。\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('Workspace.mkdir', () => {
  test('建一个目录，返回它的相对路径', async () => {
    const r = await ws.mkdir('chapters/第五卷');
    assert.equal(r.rel, 'chapters/第五卷');
    assert.ok(fs.statSync(t.rel('chapters/第五卷')).isDirectory());
  });

  test('一次建几层', async () => {
    await ws.mkdir('.novelforge/lore/宗门/正道');
    assert.ok(fs.statSync(t.rel('.novelforge/lore/宗门/正道')).isDirectory());
  });

  test('已有同名目录：exists', async () => {
    assert.equal(await codeOf(() => ws.mkdir('chapters/第五卷')), 'exists');
  });

  test('已有同名文件：exists，文件一字不动', async () => {
    assert.equal(await codeOf(() => ws.mkdir('chapters/001-楔子.md')), 'exists');
    assert.equal(t.read('chapters/001-楔子.md'), '# 楔子\n');
  });

  const refused = [
    ['回收站里', '.novelforge/.trash/新目录', 'inTrash'],
    ['回收站本身', '.novelforge/.trash', 'inTrash'],
    ['会话目录里', '.novelforge/sessions/新目录', 'protected'],
    ['历史版本里', '.novelforge/history/新目录', 'inHistory'],
    ['某份文件的快照目录里', '.novelforge/history/chapters/001-楔子.md/新目录', 'inHistory'],
    ['工程根之外', '../外面', 'outOfRoot'],
    ['绝对路径', '/tmp/外面', 'outOfRoot'],
  ];
  for (const [name, rel, code] of refused) {
    test(`${name}建不了（${code}），什么都没建`, async () => {
      assert.equal(await codeOf(() => ws.mkdir(rel)), code);
      if (code !== 'outOfRoot' && rel !== '.novelforge/.trash') {
        assert.equal(t.has(rel), false, rel);
      }
    });
  }
});

describe('新建文件夹经网关建', () => {
  let calls;
  let created;
  let dup;
  let dupToasts;
  let orig;

  before(async () => {
    calls = [];
    const proto = bundle.ws.Workspace.prototype;
    orig = proto.mkdir;
    proto.mkdir = async function (rel) {
      calls.push(rel);
      return orig.call(this, rel);
    };
    try {
      h.expect('第六卷');
      created = await bundle.fileOps.newFolder(project, 'chapters');
      h.expect('第六卷');
      dup = await bundle.fileOps.newFolder(project, 'chapters');
      dupToasts = [...h.toasts];
    } finally {
      proto.mkdir = orig;
    }
  });

  test('建出来了', () => {
    assert.equal(created, 'chapters/第六卷');
    assert.ok(fs.statSync(t.rel('chapters/第六卷')).isDirectory());
  });

  test('走的是 Workspace.mkdir', () => {
    assert.deepEqual(calls, ['chapters/第六卷', 'chapters/第六卷']);
  });

  test('同名照旧拒绝，文案照旧「已存在：…」', () => {
    assert.equal(dup, undefined);
    assert.ok(dupToasts.includes('error: 已存在：chapters/第六卷'), dupToasts.join(' | '));
  });
});

describe('文件写不进、搬不进历史版本（读得到）', () => {
  const SNAP = '.novelforge/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt';

  test('write 新建被拒', async () => {
    assert.equal(await codeOf(() => ws.write('.novelforge/history/伪造.txt', { text: '假快照' }, { mode: 'create' })), 'inHistory');
    assert.equal(t.has('.novelforge/history/伪造.txt'), false);
  });

  test('write 覆盖一份快照被拒，快照一字不动', async () => {
    assert.equal(await codeOf(() => ws.write(SNAP, { text: '改过的' }, { mode: 'overwrite', review: false })), 'inHistory');
    assert.equal(t.read(SNAP), '旧稿\n');
  });

  test('move 进历史版本被拒，原文件留在原处', async () => {
    assert.equal(await codeOf(() => ws.move('notes/备忘.txt', '.novelforge/history/chapters/备忘.txt')), 'inHistory');
    assert.ok(t.has('notes/备忘.txt'));
  });

  test('快照照样读得到', async () => {
    const file = await ws.read(SNAP);
    assert.equal(file.text, '旧稿\n');
  });
});
