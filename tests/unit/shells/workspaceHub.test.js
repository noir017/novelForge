/**
 * WorkspaceHub：一个进程同时开几个工程，每个窗口（连接）各绑一个或者空着。
 * 测试写进临时目录，设置存内存，不碰 ~/.novelforge。
 *
 * FileHost / ChatController / initHost 共享模块级单例，必须 loadBundle。
 */
const { describe, test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle, loadModule } = require('../../helpers/load');

const bundle = loadBundle({
  workspaceHub: './src/shells/standalone/workspaceHub.ts',
  fileHost: './src/shells/standalone/fileHost.ts',
  scopedHost: './src/shells/standalone/scopedHost.ts',
  progress: './src/core/runtime/progress.ts',
  host: './src/core/host.ts',
  secrets: './src/core/llm/registry.ts',
  stores: './src/core/stores.ts',
});

const { readWindowState, writeWindowState, rememberOpen } = loadModule(
  'src/shells/standalone/windowState.ts'
);


const { WorkspaceHub } = bundle.workspaceHub;
const { FileHost } = bundle.fileHost;
const { ScopedHost, currentScope, runInScope } = bundle.scopedHost;

let windowDir;
let projA;
let projB;
/** 不在任何窗口上下文里的广播（启动期的 getHost()）。 */
let stray;
/** 设置存内存，不碰 ~/.novelforge/config.json。 */
let config;
/** @type {InstanceType<typeof WorkspaceHub>} */
let hub;
let windows;

// 必须与生产代码同源：workspaceHub.ts 用的是 **异步** fsp.realpath，而
// Node 在 Windows 上两者对 8.3 短名的处理相反——fs.realpathSync 原样保留
// `RUNNER~1`，fsp.realpath 会展开成 `runneradmin`。CI 的 runner 用户名超过
// 8 字符，os.tmpdir() 就返回短名，用 sync 版对期望值会与实现差一截路径。
// 本机用户名短，短名不出现，所以这个坑只在 CI 上炸。
function real(p) {
  return fs.realpathSync.native(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 开一个窗口。`project` 是它网址上的 `?project=`。 */
async function openWindow(project) {
  const messages = [];
  const conn = hub.connect((m) => messages.push(m), project);
  windows.push(conn);
  await conn.ready;
  return {
    conn,
    messages,
    ofType: (type) => messages.filter((m) => m.type === type),
    last: (type) => messages.filter((m) => m.type === type).pop(),
    send: (msg) => hub.receive(conn, msg),
    clear: () => {
      messages.length = 0;
    },
  };
}

before(() => {
  windowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-win-'));
  projA = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-a-'));
  projB = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-b-'));
  fs.writeFileSync(path.join(projA, 'note-a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(projB, 'note-b.txt'), 'b', 'utf8');

  stray = [];
  config = {
    data: undefined,
    read() {
      return this.data;
    },
    async write(s) {
      this.data = s;
    },
  };
  bundle.host.initHost(new ScopedHost(new FileHost(config, (m) => stray.push(m))));
  bundle.progress.setTaskOwnerResolver(() => currentScope()?.owner);
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
});

beforeEach(() => {
  windows = [];
  stray.length = 0;
  hub = new WorkspaceHub({ config, windowDir, idleMs: 20 });
});

afterEach(async () => {
  for (const c of windows) {
    hub.disconnect(c);
  }
  await hub.closeAll();
});

after(() => {
  fs.rmSync(windowDir, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  fs.rmSync(projB, { recursive: true, force: true });
});

describe('WorkspaceHub：一个窗口', () => {
  test('打开目录后这个窗口的 snapshot 只有一项，id 是 realpath', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    const snap = hub.snapshot(w.conn);
    assert.equal(snap.currentId, real(projA));
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].root, real(projA));
    assert.equal(snap.items[0].name, path.basename(projA));
    assert.equal(snap.openInNewWindow, true);
    assert.ok(hub.controllerOf(projA));
    assert.ok(w.ofType('init').length > 0);
  });

  test('同一 realpath 再 open 不重建 controller、不重推 init', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    const first = hub.controllerOf();
    const inits = w.ofType('init').length;
    await w.send({ type: 'openFolder', path: path.join(projA, '.') });
    assert.equal(hub.controllerOf(), first);
    assert.equal(w.ofType('init').length, inits);
  });

  test('replace 换成另一目录：这个窗口只留新的，旧的没有窗口了按空闲回收', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: projB });
    assert.equal(hub.snapshot(w.conn).currentId, real(projB));
    await sleep(80);
    assert.deepEqual(hub.openRoots(), [real(projB)]);
  });

  test('mode add 在已有工程时不改当前 id', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: projB, mode: 'add' });
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
    assert.ok(w.ofType('toast').some((m) => m.message.includes('一个工程')));
  });

  test('close 后窗口为空、工程当场关掉；lastOpen 清掉、recents 保留', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'closeFolder' });
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.equal(w.last('workspaces').currentId, null);
    assert.deepEqual(hub.openRoots(), []);
    assert.equal(hub.controllerOf(), undefined);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.ok(win.recents.some((r) => r.root === real(projA)));
  });

  test('不是目录则 toast，窗口不变', async () => {
    const w = await openWindow();
    const file = path.join(windowDir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    await w.send({ type: 'openFolder', path: file });
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不是目录')));
  });

  test('目录不存在则 toast；已开着的工程不受影响', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: path.join(windowDir, 'no-such-book') });
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不存在')));
  });

  test('listHostDir 只回发起的窗口，条目没有正文', async () => {
    const w = await openWindow();
    const other = await openWindow();
    await w.send({ type: 'listHostDir', path: projA });
    const listing = w.ofType('hostDir')[0];
    assert.ok(listing);
    assert.ok(listing.entries.some((e) => e.name === 'note-a.txt'));
    assert.ok(listing.entries.every((e) => !('text' in e) && !('content' in e)));
    assert.equal(other.ofType('hostDir').length, 0);
  });

  test('空窗口 ready 不发 init', async () => {
    const w = await openWindow();
    w.clear();
    await w.send({ type: 'ready' });
    assert.ok(w.ofType('workspaces').some((m) => m.currentId === null));
    assert.ok(w.ofType('settings').length > 0);
    assert.equal(w.ofType('init').length, 0);
  });

  test('空窗口发创作消息：提示先打开文件夹', async () => {
    const w = await openWindow();
    await w.send({ type: 'stop' });
    assert.ok(w.ofType('toast').some((m) => /打开文件夹/.test(m.message)));
  });

  test('createFile 写空文件，已存在则拒绝', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    w.clear();
    await w.send({ type: 'createFile', relPath: 'fresh.md' });
    assert.equal(fs.readFileSync(path.join(projA, 'fresh.md'), 'utf8'), '');
    assert.ok(w.ofType('editorOpen').some((m) => m.file.path === 'fresh.md'));
    w.clear();
    await w.send({ type: 'createFile', relPath: 'fresh.md' });
    assert.ok(w.ofType('toast').some((m) => /已存在/.test(m.message)));
  });

  test('createFile 无工程则 toast', async () => {
    const w = await openWindow();
    await w.send({ type: 'createFile', relPath: 'x.md' });
    assert.ok(w.ofType('toast').some((m) => /打开文件夹/.test(m.message)));
  });

  test('openReadme 打开工程根 README', async () => {
    fs.writeFileSync(path.join(projA, 'README.md'), '# hi', 'utf8');
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    w.clear();
    await w.send({ type: 'openReadme' });
    assert.ok(w.ofType('editorOpen').some((m) => m.file.path === 'README.md'));
  });
});

describe('WorkspaceHub：几个窗口', () => {
  test('两个窗口各开一个工程，互不干扰', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projB });
    assert.equal(hub.snapshot(a.conn).currentId, real(projA));
    assert.equal(hub.snapshot(b.conn).currentId, real(projB));
    assert.deepEqual(hub.openRoots().sort(), [real(projA), real(projB)].sort());
    assert.notEqual(hub.controllerOf(projA), hub.controllerOf(projB));
  });

  test('工程的消息只发给开着它的窗口', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projB });
    a.clear();
    b.clear();
    await a.send({ type: 'createFile', relPath: 'only-a.md' });
    assert.ok(a.ofType('editorOpen').some((m) => m.file.path === 'only-a.md'));
    assert.equal(b.ofType('editorOpen').length, 0);
    fs.rmSync(path.join(projA, 'only-a.md'));
  });

  test('getHost() 落到所在窗口的上下文，不广播给别的窗口', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    a.clear();
    b.clear();
    await runInScope(a.conn.runtime.scope, async () => {
      await Promise.resolve();
      bundle.host.getHost().toast('只给 A');
    });
    assert.ok(a.ofType('toast').some((m) => m.message === '只给 A'));
    assert.equal(b.ofType('toast').length, 0);
    assert.equal(stray.length, 0);
  });

  test('长任务只出现在它那个工程的窗口里', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    a.clear();
    b.clear();
    const running = runInScope(a.conn.runtime.scope, () =>
      bundle.progress.runTask('测试任务', () => gate)
    );
    await sleep(10);
    assert.ok(a.last('tasks').tasks.some((t) => t.title === '测试任务'));
    assert.ok(b.ofType('tasks').every((m) => m.tasks.length === 0));
    release();
    await running;
  });

  test('两个窗口开同一个工程共用一份 controller；一个窗口关掉不影响另一个', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projA });
    assert.equal(hub.openRoots().length, 1);
    await a.send({ type: 'closeFolder' });
    assert.equal(hub.snapshot(a.conn).currentId, null);
    assert.equal(hub.snapshot(b.conn).currentId, real(projA));
    assert.ok(hub.controllerOf(projA));
  });

  test('新窗口带 ?project= 就开那个工程，不带落到最近操作的那个', async () => {
    const a = await openWindow(projA);
    assert.equal(hub.snapshot(a.conn).currentId, real(projA));
    const b = await openWindow(projB);
    assert.equal(hub.snapshot(b.conn).currentId, real(projB));
    const c = await openWindow();
    assert.equal(hub.snapshot(c.conn).currentId, real(projB));
    await a.send({ type: 'windowFocus' });
    const d = await openWindow();
    assert.equal(hub.snapshot(d.conn).currentId, real(projA));
    assert.equal(readWindowState(windowDir).lastOpen, real(projA));
  });

  test('?project= 指向不存在的目录：空窗口 + toast', async () => {
    const w = await openWindow(path.join(windowDir, 'gone-book'));
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不存在')));
  });

  test('MCP：带 project 落到那个工程，不带落到最近操作的；没开着的回 undefined', async () => {
    const a = await openWindow(projA);
    await openWindow(projB);
    await a.send({ type: 'windowFocus' });
    assert.ok(hub.mcpBackend(projA));
    assert.ok(hub.mcpBackend(projB));
    assert.ok(hub.mcpBackend());
    assert.equal(hub.controllerOf(), hub.controllerOf(projA));
    assert.equal(hub.mcpBackend(path.join(windowDir, 'not-open')), undefined);
  });

  test('窗口全关了：最近操作的工程留着（MCP 还要用），别的空闲回收', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    hub.disconnect(a.conn);
    hub.disconnect(b.conn);
    await sleep(80);
    assert.deepEqual(hub.openRoots(), [real(projB)]);
  });

  test('窗口在空闲期内回来（刷新）就接着用同一份', async () => {
    const a = await openWindow(projA);
    await openWindow(projB);
    const ctrl = hub.controllerOf(projA);
    hub.disconnect(a.conn);
    const again = await openWindow(projA);
    await sleep(80);
    assert.equal(hub.controllerOf(projA), ctrl);
    assert.equal(hub.snapshot(again.conn).currentId, real(projA));
  });

  test('改设置：所有窗口都收到新设置与新的 openInNewWindow；不带这一项保持原值', async () => {
    const a = await openWindow(projA);
    const b = await openWindow();
    await a.send({ type: 'switchTab', tab: 'settings' });
    const current = a.last('settings').settings;
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: false } });
    assert.equal(b.last('settings').settings.openInNewWindow, false);
    assert.equal(b.last('workspaces').openInNewWindow, false);
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: undefined } });
    assert.equal(b.last('settings').settings.openInNewWindow, false);
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: true } });
    assert.equal(b.last('workspaces').openInNewWindow, true);
  });
});

describe('WorkspaceHub：启动', () => {
  test('bootstrap 恢复 lastOpen，不带 ?project= 的窗口落到它上面', async () => {
    rememberOpen(projA, windowDir);
    await hub.bootstrap();
    assert.equal(hub.defaultRoot(), real(projA));
    const w = await openWindow();
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
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
    assert.equal(hub.defaultRoot(), undefined);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.equal(win.recents[0].name, 'missing-book');
  });
});
