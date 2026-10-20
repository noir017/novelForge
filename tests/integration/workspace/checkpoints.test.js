/**
 * 存档点的落盘一半（`src/core/workspace/checkpoints.ts`）与退回的编排（`src/core/features/checkpoint.ts` 的
 * `restoreCheckpoint`、网关的 `restoreBytes`）：真临时工程。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 存哪些：创作产物（含草稿、细纲、角色卡、设定），不存会话、历史版本、回收站、manifest、工程根的随手记 | 与历史版本同一个口径；会话与内部文件不是书 |
 * | 同样的内容只存一份；第二个存档点只多存改过的那几份 | 存档点要存得起，自动存几十个也不翻倍 |
 * | 自动存档点与最近一个一模一样不另存；手动的照存 | 自动的不刷屏；作者要一个带名字的点 |
 * | 超过 2 MB 的不存、记下来，跟现在比时不算「之后新建」 | 第 2 条：不静默丢 |
 * | `.gitignore` 只在建目录那一次放 | 同历史版本：作者删掉就是想让 git 收 |
 * | 整个目录是内部文件：读不到、写不进、列不出、搜不到、监听挡掉 | 一堆按 hash 命名的对象，只经面板看 |
 * | 跟现在比：改过的 / 之后删掉的 / 之后新建的，`hashNow` 与网关乐观锁同一个口径 | 退回时原样带回来当乐观锁 |
 * | 退回字节原样（GBK 章节不转码）、细纲的指纹一起回到当时（不重记 upstreamHash） | 第 18 条：整本退回之后就是当时那条链 |
 * | 退回之前先存「退回之前」；编辑器未保存的跳过；乐观锁对不上的跳过；勾了才搬进回收站；被盖掉的存一版历史 | 第 3、6 条 |
 * | 有任务在跑就不退 | 一边写一边退，谁也说不清 |
 * | 自动的留最近 30 个，手动的不裁；写备注即留住；清理只删没人引用、写下超过一小时的对象；有清单读不懂就不清 | 存档点不能无限长，也不能清错 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let cp;
const dirs = [];

/** 「雨夜」两个字的 GBK 字节，外加一个换行：退回之后必须一个字节不差。 */
const GBK = Buffer.from([0xd3, 0xea, 0xd2, 0xb9, 0x0a]);

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsx: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    ws: './src/core/workspace/index.ts',
    feature: './src/core/features/checkpoint.ts',
    watch: './src/core/watchPolicy.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } }).host);
  cp = bundle.checkpoints;
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推开门。\n');
  t.write('chapters/第一卷/002-深处.md', '# 深处\n\n山很深。\n');
  t.write('.novelforge/summaries/001-雨夜.md', '---\nno: 1\nupstreamHash: aaaa\n---\n\n## 梗概\n\n雨夜。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句话\n\n剑客。\n');
  t.write('drafts/001-雨夜.md', '草稿：先写门。\n');
  return { t, ws: new bundle.ws.Workspace(t.project) };
}

const objectCount = (t) => {
  const root = t.rel('.novelforge/checkpoints/objects');
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root).reduce((n, d) => n + fs.readdirSync(path.join(root, d)).filter((f) => !f.endsWith('.tmp')).length, 0);
};

const hashOf = (t, rel) => bundle.fsx.hash(fs.readFileSync(t.rel(rel), 'utf8'));

/** 面板上点「整本退回」会发的那一份请求。 */
async function wholeRequest(t, id, { trashAdded = false, dirty = [] } = {}) {
  const d = await cp.diffCheckpoint(t.project, id);
  const paths = d.entries.filter((e) => e.status !== 'added').map((e) => e.path);
  const trash = trashAdded ? d.entries.filter((e) => e.status === 'added').map((e) => e.path) : [];
  const expect = {};
  for (const e of d.entries) expect[e.path] = e.hashNow ?? null;
  return { id, paths, trash, expect, dirty };
}

describe('存哪些', () => {
  let t;
  let files;

  before(async () => {
    ({ t } = await fresh('cp-tracked'));
    t.write('README.md', '工程根的随手记\n');
    t.write('.novelforge/sessions/s1.json', '{}');
    t.write('.novelforge/history/chapters/001-雨夜.md/2026-10-01_10-00-00+0800.txt', '旧稿');
    t.write('.novelforge/.trash/chapters/009-删掉的.md', '删掉的');
    files = await cp.trackedFiles(t.project);
  });

  test('章节（含卷目录里的）、细纲、角色卡、草稿、架构模板都在', () => {
    for (const rel of ['chapters/001-雨夜.md', 'chapters/第一卷/002-深处.md', '.novelforge/summaries/001-雨夜.md', '.novelforge/characters/林昭.md', 'drafts/001-雨夜.md']) {
      assert.ok(files.includes(rel), `${rel} 不在：${files.join('、')}`);
    }
    assert.ok(files.some((f) => f.startsWith('.novelforge/') && /config|premise|world|outline/.test(f)), files.join('、'));
  });

  test('会话、历史版本、回收站、manifest、工程根的随手记都不在', () => {
    for (const bad of ['README.md', '.novelforge/sessions/s1.json', '.novelforge/project.json']) {
      assert.ok(!files.includes(bad), bad);
    }
    assert.ok(!files.some((f) => f.includes('/history/') || f.includes('.trash')), files.join('、'));
  });
});

describe('存：去重、自动不刷屏、.gitignore、太大的不存', () => {
  let t;
  let first;

  before(async () => {
    ({ t } = await fresh('cp-create'));
    first = await cp.createCheckpoint(t.project, { note: '开头', auto: false });
  });

  test('第一个：每份内容一个对象，清单记下备注与手动', async () => {
    assert.equal(first.created, true);
    assert.equal(first.newObjects, objectCount(t));
    const info = await cp.readCheckpoint(t.project, first.id);
    assert.equal(info.note, '开头');
    assert.equal(info.auto, false);
    assert.ok(info.files['chapters/001-雨夜.md'].words > 0);
  });

  test('.gitignore 只在建目录那一次放；删掉之后不再补', async () => {
    assert.equal(t.read('.novelforge/checkpoints/.gitignore'), '*\n');
    t.remove('.novelforge/checkpoints/.gitignore');
    await cp.createCheckpoint(t.project, { note: '', auto: false });
    assert.equal(t.has('.novelforge/checkpoints/.gitignore'), false);
  });

  test('第二个：只多存改过的那一份', async () => {
    const before = objectCount(t);
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推开门。\n');
    const r = await cp.createCheckpoint(t.project, { note: '改了一章', auto: false });
    assert.equal(r.newObjects, 1);
    assert.equal(objectCount(t), before + 1);
  });

  test('自动的与最近一个一模一样就不另存，沿用最近那一个', async () => {
    const latest = (await cp.listCheckpoints(t.project))[0];
    const r = await cp.createCheckpoint(t.project, { note: '批量写章之前', auto: true });
    assert.equal(r.created, false);
    assert.equal(r.id, latest.id);
  });

  test('手动的一模一样也照样存（只多一份清单）', async () => {
    const n = (await cp.listCheckpoints(t.project)).length;
    const r = await cp.createCheckpoint(t.project, { note: '再存一个', auto: false });
    assert.equal(r.created, true);
    assert.equal(r.newObjects, 0);
    assert.equal((await cp.listCheckpoints(t.project)).length, n + 1);
  });

  test('列表新的在前；同一秒的第二个带序号', async () => {
    const now = new Date(2025, 0, 2, 3, 4, 5).getTime(); // 别的用例都在此刻，撞不上
    const a = await cp.createCheckpoint(t.project, { note: 'a', auto: false, now });
    const b = await cp.createCheckpoint(t.project, { note: 'b', auto: false, now });
    assert.equal(a.id, cp.checkpointIdOf(new Date(now)));
    assert.equal(b.id, `${a.id}-2`);
    const list = await cp.listCheckpoints(t.project);
    assert.ok(list.every((c, i) => i === 0 || list[i - 1].time >= c.time));
    assert.equal(list.at(-1).id, a.id);
  });

  test('超过 2 MB 的不存、记下来；跟现在比时不算之后新建', async () => {
    t.write('chapters/003-大.md', '字'.repeat(800_000)); // 2.4 MB
    const r = await cp.createCheckpoint(t.project, { note: '大', auto: false });
    assert.deepEqual(r.skipped, ['chapters/003-大.md']);
    const info = await cp.readCheckpoint(t.project, r.id);
    assert.equal(info.files['chapters/003-大.md'], undefined);
    const d = await cp.diffCheckpoint(t.project, r.id);
    assert.equal(d.entries.length, 0);
    t.remove('chapters/003-大.md');
  });

  test('还不是小说工程：存不了，说为什么', async () => {
    const dir = makeTempDir('cp-not-project');
    dirs.push(dir.dir);
    const p = bundle.project.NovelProject.open(dir.dir);
    assert.match(await cp.checkpointUnavailable(p), /还不是小说工程/);
    await assert.rejects(cp.createCheckpoint(p, { note: '', auto: false }), /还不是小说工程/);
    assert.equal(fs.existsSync(path.join(dir.dir, '.novelforge')), false);
  });
});

describe('内部文件：读不到、写不进、列不出、搜不到、监听挡掉', () => {
  let t;
  let ws;
  let id;

  before(async () => {
    ({ t, ws } = await fresh('cp-internal'));
    id = (await cp.createCheckpoint(t.project, { note: '', auto: false })).id;
  });

  test('读清单当不存在；往里写、建目录都拒', async () => {
    await assert.rejects(ws.read(`.novelforge/checkpoints/points/${id}.json`), (e) => e.code === 'notFound');
    await assert.rejects(ws.write('.novelforge/checkpoints/x.md', { text: 'x' }), (e) => e.code === 'protected');
    await assert.rejects(ws.mkdir('.novelforge/checkpoints/new'), (e) => e.code === 'protected');
    await assert.rejects(ws.remove('.novelforge/checkpoints'), (e) => ['protected', 'notFound'].includes(e.code));
  });

  test('列 .novelforge 看不见它；全文检索搜不到对象里的字', async () => {
    assert.ok(!(await ws.list('.novelforge')).some((e) => e.name === 'checkpoints'));
    t.remove('chapters/001-雨夜.md'); // 现在只有存档点里还有「推开门」
    const r = await ws.search('推开门');
    assert.equal(r.hits.length, 0, JSON.stringify(r.hits));
  });

  test('监听挡掉它的变动（相对、绝对、Windows 分隔符都认）', () => {
    assert.equal(bundle.watch.shouldIgnoreChange('.novelforge/checkpoints/objects/3f/abc'), true);
    assert.equal(bundle.watch.shouldIgnoreChange(t.rel('.novelforge/checkpoints/points/x.json')), true);
    assert.equal(bundle.watch.shouldIgnoreChange('.novelforge\\checkpoints\\points\\x.json'), true);
    assert.equal(bundle.watch.shouldIgnoreChange('.novelforge/checkpointsx.md'), false);
  });
});

describe('跟现在比', () => {
  test('改过的 / 之后删掉的 / 之后新建的；hashNow 与网关乐观锁同一个口径', async () => {
    const { t } = await fresh('cp-diff');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推开门，雨很大。\n');
    t.remove('chapters/第一卷/002-深处.md');
    t.write('chapters/004-新.md', '# 新\n\n新的一章。\n');
    const d = await cp.diffCheckpoint(t.project, id);
    const by = Object.fromEntries(d.entries.map((e) => [e.path, e]));
    assert.equal(by['chapters/001-雨夜.md'].status, 'changed');
    assert.equal(by['chapters/001-雨夜.md'].kind, 'chapter');
    assert.equal(by['chapters/001-雨夜.md'].hashNow, hashOf(t, 'chapters/001-雨夜.md'));
    assert.equal(by['chapters/第一卷/002-深处.md'].status, 'deleted');
    assert.equal(by['chapters/第一卷/002-深处.md'].hashNow, undefined);
    assert.equal(by['chapters/004-新.md'].status, 'added');
    assert.equal(d.entries.length, 3);
    assert.ok(d.unchanged > 0);
  });

  test('存档点不在了：notFound；名字带斜杠的不认', async () => {
    const { t } = await fresh('cp-diff-missing');
    await assert.rejects(cp.diffCheckpoint(t.project, '2026-01-01_00-00-00+0800'), (e) => e.code === 'notFound');
    await assert.rejects(cp.diffCheckpoint(t.project, '../../x'), (e) => e.code === 'notFound');
  });
});

describe('整本退回', () => {
  let t;
  let id;
  let outcome;
  let plotBefore;

  before(async () => {
    ({ t } = await fresh('cp-restore'));
    fs.writeFileSync(t.rel('chapters/005-旧码.txt'), GBK);
    plotBefore = fs.readFileSync(t.rel('.novelforge/summaries/001-雨夜.md'));
    id = (await cp.createCheckpoint(t.project, { note: '第一卷写完', auto: false })).id;

    t.write('chapters/001-雨夜.md', '# 雨夜\n\n全改了。\n');
    fs.writeFileSync(t.rel('chapters/005-旧码.txt'), '改成了 utf8\n');
    t.write('.novelforge/summaries/001-雨夜.md', '---\nno: 1\nupstreamHash: bbbb\nsourceHash: cccc\n---\n\n## 梗概\n\n全变了。\n');
    t.remove('chapters/第一卷'); // 整个卷目录删掉
    t.write('chapters/006-之后新建.md', '# 之后新建\n\n后来写的。\n');

    outcome = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: false });
  });

  test('改过的、删掉的都回来了；字节原样（GBK 不转码）', () => {
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n他推开门。\n');
    assert.deepEqual(fs.readFileSync(t.rel('chapters/005-旧码.txt')), GBK);
    assert.equal(t.read('chapters/第一卷/002-深处.md'), '# 深处\n\n山很深。\n');
    assert.equal(outcome.refused, undefined);
    assert.deepEqual(outcome.skipped, []);
  });

  test('细纲连同 frontmatter 的指纹回到当时，一个字节不差（不按大纲此刻重记）', () => {
    assert.deepEqual(fs.readFileSync(t.rel('.novelforge/summaries/001-雨夜.md')), plotBefore);
  });

  test('之后新建的缺省不动', () => {
    assert.equal(t.has('chapters/006-之后新建.md'), true);
    assert.deepEqual(outcome.trashed, []);
  });

  test('先存了一个「退回到 … 之前」的自动存档点，里面是退回之前的样子', async () => {
    const before = await cp.readCheckpoint(t.project, outcome.before);
    assert.equal(before.auto, true);
    assert.match(before.note, /^退回到.*「第一卷写完」之前$/);
    assert.ok(before.files['chapters/006-之后新建.md']);
    const restored = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, outcome.before), { busy: false });
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n全改了。\n', '退回本身也能撤回');
    assert.equal(restored.refused, undefined);
  });

  test('被盖掉的那一份存了一版历史', () => {
    const dir = t.rel('.novelforge/history/chapters/001-雨夜.md');
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
  });

  test('章节清单跟着同步（卷目录里那一章回来了）', async () => {
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.ok(chapters.some((c) => c.relPath === 'chapters/第一卷/002-深处.md'));
  });
});

describe('退回的闸门', () => {
  test('勾了才把之后新建的搬进回收站（第 6 条，不真删）', async () => {
    const { t } = await fresh('cp-trash');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/007-后来.md', '# 后来\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id, { trashAdded: true }), { busy: false });
    assert.deepEqual(o.trashed, ['chapters/007-后来.md']);
    assert.equal(t.has('chapters/007-后来.md'), false);
    assert.equal(t.has('.novelforge/.trash/chapters/007-后来.md'), true);
  });

  test('编辑器里有未保存修改的跳过；面板打开之后又改过的跳过；又建出来的跳过', async () => {
    const { t } = await fresh('cp-locks');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改一。\n');
    t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句话\n\n改过。\n');
    t.remove('chapters/第一卷/002-深处.md');
    const req = await wholeRequest(t, id, { dirty: ['chapters/001-雨夜.md'] });
    // 面板打开之后：角色卡又被改了一次，删掉的那一章又被建了出来。
    t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句话\n\n又改了。\n');
    t.write('chapters/第一卷/002-深处.md', '# 深处\n\n别处刚写的。\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, req, { busy: false });
    const reasons = Object.fromEntries(o.skipped.map((s) => [s.path, s.reason]));
    assert.equal(reasons['chapters/001-雨夜.md'], 'dirty');
    assert.equal(reasons['.novelforge/characters/林昭.md'], 'changed');
    assert.equal(reasons['chapters/第一卷/002-深处.md'], 'appeared');
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改一。\n');
    assert.match(t.read('.novelforge/characters/林昭.md'), /又改了/);
    assert.match(t.read('chapters/第一卷/002-深处.md'), /别处刚写的/);
  });

  test('有任务在跑：不退，什么都不动，也不存「退回之前」', async () => {
    const { t } = await fresh('cp-busy');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    const n = (await cp.listCheckpoints(t.project)).length;
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: true });
    assert.match(o.refused, /有任务在跑/);
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改了。\n');
    assert.equal((await cp.listCheckpoints(t.project)).length, n);
  });

  test('单份：只退回那一份；存档点里没有的路径、越界的路径都不碰', async () => {
    const { t } = await fresh('cp-single');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    t.write('drafts/001-雨夜.md', '草稿也改了。\n');
    const o = await bundle.feature.restoreCheckpoint(
      t.project,
      {
        id,
        paths: ['chapters/001-雨夜.md', 'chapters/999-没有.md', '../外面.md'],
        trash: [],
        expect: { 'chapters/001-雨夜.md': hashOf(t, 'chapters/001-雨夜.md') },
        dirty: [],
      },
      { busy: false }
    );
    assert.deepEqual(o.restored, ['chapters/001-雨夜.md']);
    assert.equal(t.read('drafts/001-雨夜.md'), '草稿也改了。\n');
    assert.deepEqual(o.skipped.map((s) => [s.path, s.reason]), [['chapters/999-没有.md', 'notInCheckpoint']]);
  });

  test('网关的 restoreBytes：absent 时目标已在报 exists；基线对不上报冲突；不能写进内部目录', async () => {
    const { t, ws } = await fresh('cp-bytes');
    await assert.rejects(ws.restoreBytes('chapters/001-雨夜.md', Buffer.from('x'), { absent: true }), (e) => e.code === 'exists');
    await assert.rejects(ws.restoreBytes('chapters/001-雨夜.md', Buffer.from('x'), { baseHash: 'nope' }), (e) => e instanceof bundle.ws.WsConflictError);
    await assert.rejects(ws.restoreBytes('.novelforge/sessions/x.json', Buffer.from('x')), (e) => e.code === 'protected');
    await assert.rejects(ws.restoreBytes('../外面.md', Buffer.from('x')), (e) => e.code === 'outOfRoot');
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n他推开门。\n');
  });
});

describe('保留与清理', () => {
  test('自动的留最近 30 个，手动的不裁；裁掉之后没人用的对象写下一小时之后才清', async () => {
    const { t } = await fresh('cp-prune');
    const manual = await cp.createCheckpoint(t.project, { note: '手动', auto: false });
    const base = Date.now();
    for (let i = 0; i < 32; i++) {
      t.write('chapters/001-雨夜.md', `# 雨夜\n\n第 ${i} 版。\n`);
      await cp.createCheckpoint(t.project, { note: `自动 ${i}`, auto: true, now: base + i * 1000 });
    }
    const list = await cp.listCheckpoints(t.project);
    assert.equal(list.filter((c) => c.auto).length, 30);
    assert.ok(list.some((c) => c.id === manual.id));
    assert.ok(!list.some((c) => c.note === '自动 0' || c.note === '自动 1'));

    // 「第 0 版」「第 1 版」的对象没人用了，但刚写下：这次不清。一小时之后再清。
    const before = objectCount(t);
    assert.equal(await cp.collectGarbage(t.project), 0);
    assert.equal(await cp.collectGarbage(t.project, Date.now() + 2 * 3600_000), 2);
    assert.equal(objectCount(t), before - 2);
    // 还在的存档点都读得回来。
    for (const c of await cp.listCheckpoints(t.project)) {
      for (const rel of Object.keys(c.files)) {
        await cp.readCheckpointBytes(t.project, c, rel);
      }
    }
  });

  test('有一份清单读不懂：整个不清（宁可多留）', async () => {
    const { t } = await fresh('cp-gc-unreadable');
    await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('.novelforge/checkpoints/objects/ff/' + 'f'.repeat(62), '没人用的');
    t.write('.novelforge/checkpoints/points/2026-01-01_00-00-00+0800.json', '{坏了');
    assert.equal(await cp.collectGarbage(t.project, Date.now() + 2 * 3600_000), 0);
    assert.equal((await cp.listCheckpoints(t.project)).length, 1, '读不懂的那份不进列表');
  });

  test('写备注：自动的就此留住（变成手动）', async () => {
    const { t } = await fresh('cp-note');
    const { id } = await cp.createCheckpoint(t.project, { note: '批量写章之前', auto: true });
    const info = await cp.noteCheckpoint(t.project, id, '  写完第三章  ');
    assert.equal(info.auto, false);
    assert.equal(info.note, '写完第三章');
    assert.equal((await cp.readCheckpoint(t.project, id)).auto, false);
  });

  test('对象坏了：读这一份报 notFound，退回时跳过它、说出来', async () => {
    const { t } = await fresh('cp-corrupt');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    const info = await cp.readCheckpoint(t.project, id);
    const sha = info.files['chapters/001-雨夜.md'].sha;
    fs.writeFileSync(t.rel('.novelforge/checkpoints/objects', sha.slice(0, 2), sha.slice(2)), '坏了');
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: false });
    assert.equal(o.skipped[0].reason, 'unreadable');
    assert.match(o.skipped[0].detail, /坏了/);
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改了。\n');
  });
});
