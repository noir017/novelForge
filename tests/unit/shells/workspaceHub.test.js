/**
 * WorkspaceHub：工程目录可空、可热换。测试写进临时目录，不碰 ~/.novelforge。
 *
 * FileHost / ChatController / initHost 共享模块级单例，必须 loadBundle。
 */
const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle, loadModule } = require('../../helpers/load');

const bundle = loadBundle({
  workspaceHub: './src/shells/standalone/workspaceHub.ts',
  fileHost: './src/shells/standalone/fileHost.ts',
  host: './src/core/host.ts',
  secrets: './src/core/llm/registry.ts',
  stores: './src/core/stores.ts',
});

const { readWindowState, writeWindowState, rememberOpen } = loadModule(
  'src/shells/standalone/windowState.ts'
);

const { WorkspaceHub } = bundle.workspaceHub;
const { FileHost } = bundle.fileHost;

let windowDir;
let projA;
let projB;
let messages;
/** @type {InstanceType<typeof WorkspaceHub>} */
let hub;

// 必须与生产代码同源：workspaceHub.ts 用的是 **异步** fsp.realpath，而
// Node 在 Windows 上两者对 8.3 短名的处理相反——fs.realpathSync 原样保留
// `RUNNER~1`，fsp.realpath 会展开成 `runneradmin`。CI 的 runner 用户名超过
// 8 字符，os.tmpdir() 就返回短名，用 sync 版对期望值会与实现差一截路径。
// 本机用户名短，短名不出现，所以这个坑只在 CI 上炸。
function real(p) {
  return fs.realpathSync.native(p);
}

function ofType(type) {
  return messages.filter((m) => m.type === type);
}

before(() => {
  windowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-win-'));
  projA = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-a-'));
  projB = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-b-'));
  fs.writeFileSync(path.join(projA, 'note-a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(projB, 'note-b.txt'), 'b', 'utf8');

  messages = [];
  const broadcast = (m) => messages.push(m);
  const host = new FileHost(new bundle.stores.FileConfigStore(), broadcast);
  bundle.host.initHost(host);
  bundle.secrets.initSecrets({
    data: Object.create(null),
    async get(k) {
      return this.data[k];
    },
    async set(k, v) {
      this.data[k] = v;
    },
    async delete(k) {
      delete this.data[k];
    },
  });
  hub = new WorkspaceHub({ broadcast, host, windowDir });
});

afterEach(async () => {
  await hub.close();
  messages.length = 0;
});

after(() => {
  fs.rmSync(windowDir, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  fs.rmSync(projB, { recursive: true, force: true });
});

describe('WorkspaceHub', () => {
  test('打开目录后 snapshot 只有一项，id 是 realpath', async () => {
    await hub.open(projA);
    const snap = hub.snapshot();
    assert.equal(snap.currentId, real(projA));
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].root, real(projA));
    assert.equal(snap.items[0].name, path.basename(projA));
    assert.ok(hub.activeController());
  });

  test('同一 realpath 再 open 不重建 controller', async () => {
    await hub.open(projA);
    const first = hub.activeController();
    const inits = ofType('init').length;
    await hub.open(path.join(projA, '.'));
    assert.equal(hub.activeController(), first);
    assert.equal(hub.snapshot().items.length, 1);
    assert.equal(ofType('init').length, inits);
  });

  test('replace 换成另一目录，只留一项', async () => {
    await hub.open(projA);
    const first = hub.activeController();
    await hub.open(projB);
    const snap = hub.snapshot();
    assert.notEqual(hub.activeController(), first);
    assert.equal(snap.items.length, 1);
    assert.equal(snap.currentId, real(projB));
  });

  test('mode add 在已有工程时不改当前 id', async () => {
    await hub.open(projA);
    const id = hub.snapshot().currentId;
    await hub.open(projB, 'add');
    assert.equal(hub.snapshot().currentId, id);
    assert.equal(hub.snapshot().items.length, 1);
    assert.ok(ofType('toast').some((m) => m.message.includes('一个工作区')));
  });

  test('close 后 snapshot 为空，lastOpen 清掉、recents 保留', async () => {
    await hub.open(projA);
    await hub.close();
    const snap = hub.snapshot();
    assert.equal(snap.currentId, null);
    assert.equal(snap.items.length, 0);
    assert.equal(hub.activeController(), undefined);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.ok(win.recents.some((r) => r.root === real(projA)));
  });

  test('不是目录则 toast，Hub 不变', async () => {
    const file = path.join(windowDir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    await hub.open(file);
    assert.equal(hub.snapshot().currentId, null);
    assert.ok(ofType('toast').some((m) => m.message.includes('不是目录')));
  });

  test('目录不存在则 toast', async () => {
    await hub.open(path.join(windowDir, 'no-such-book'));
    assert.equal(hub.snapshot().currentId, null);
    assert.ok(ofType('toast').some((m) => m.message.includes('不存在')));
  });

  test('handle 吃掉 listHostDir，条目没有正文', async () => {
    assert.equal(await hub.handle({ type: 'listHostDir', path: projA }), true);
    const listing = ofType('hostDir')[0];
    assert.ok(listing);
    assert.ok(Array.isArray(listing.entries));
    assert.ok(listing.entries.some((e) => e.name === 'note-a.txt'));
    assert.ok(listing.entries.every((e) => !('text' in e) && !('content' in e)));
  });

  test('handle 空窗口 ready 不发 init', async () => {
    assert.equal(await hub.handle({ type: 'ready' }), true);
    assert.ok(ofType('workspaces').some((m) => m.currentId === null));
    assert.ok(ofType('settings').length > 0);
    assert.equal(ofType('init').length, 0);
  });

  test('handle 对创作消息返回 false', async () => {
    assert.equal(await hub.handle({ type: 'stop' }), false);
  });

  test('createFile 写空文件，已存在则拒绝', async () => {
    await hub.open(projA);
    messages.length = 0;
    assert.equal(await hub.handle({ type: 'createFile', relPath: 'fresh.md' }), true);
    assert.equal(fs.readFileSync(path.join(projA, 'fresh.md'), 'utf8'), '');
    assert.ok(ofType('editorOpen').some((m) => m.file.path === 'fresh.md'));
    messages.length = 0;
    await hub.handle({ type: 'createFile', relPath: 'fresh.md' });
    assert.ok(ofType('toast').some((m) => /已存在/.test(m.message)));
  });

  test('createFile 无工程则 toast', async () => {
    assert.equal(await hub.handle({ type: 'createFile', relPath: 'x.md' }), true);
    assert.ok(ofType('toast').some((m) => /打开文件夹/.test(m.message)));
  });

  test('openReadme 打开工程根 README', async () => {
    fs.writeFileSync(path.join(projA, 'README.md'), '# hi', 'utf8');
    await hub.open(projA);
    messages.length = 0;
    assert.equal(await hub.handle({ type: 'openReadme' }), true);
    assert.ok(ofType('editorOpen').some((m) => m.file.path === 'README.md'));
  });

  test('bootstrap 恢复 lastOpen', async () => {
    rememberOpen(projA, windowDir);
    await hub.bootstrap();
    assert.equal(hub.snapshot().currentId, real(projA));
  });

  test('bootstrap 清掉已不存在的 lastOpen，保留 recents', async () => {
    const gone = path.join(windowDir, 'missing-book');
    writeWindowState(
      {
        lastOpen: gone,
        recents: [{ root: gone, name: 'missing-book', openedAt: 1 }],
      },
      windowDir
    );
    await hub.bootstrap();
    assert.equal(hub.snapshot().currentId, null);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.equal(win.recents[0].name, 'missing-book');
  });
});
