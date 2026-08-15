/**
 * Workspace 门面的六个方法：list / read / write / edit / move / remove。
 *
 * 本组只覆盖最基础的两个 handler——`plain`（other / draft）与
 * `doc`（outline / style / globalSummary / character / lore）。
 * 带记账的那几种（plot / scene / manuscript / chapter / summary）在
 * hashChain.test.js 与 split.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
    fs: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
    ws: './src/core/workspace/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsbasic' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('write · 新建', () => {
  let r;

  before(async () => {
    r = await ws.write('随手记.md', { text: '雨下了三天。' }, { mode: 'create' });
  });

  test('落盘了', () => {
    assert.equal(t.read('随手记.md').trim(), '雨下了三天。');
  });

  test('返回相对路径', () => {
    assert.equal(r.rel, '随手记.md');
  });

  test('没被跳过', () => {
    assert.equal(r.skipped, undefined);
  });

  test('message 说得出写到哪了', () => {
    assert.ok(r.message.includes('随手记.md'), r.message);
  });

  test('缺省 mode 就是 create', async () => {
    assert.equal(await codeOf(() => ws.write('随手记.md', { text: '再来' })), 'exists');
  });
});

describe('write · 同名不覆盖', () => {
  test('mode: create 撞上已有文件抛 exists', async () => {
    assert.equal(
      await codeOf(() => ws.write('随手记.md', { text: '新的' }, { mode: 'create' })),
      'exists'
    );
  });

  test('抛了之后磁盘一字未改', () => {
    assert.equal(t.read('随手记.md').trim(), '雨下了三天。');
  });
});

describe('write · 覆盖前审阅', () => {
  test('假宿主同意就覆盖', async () => {
    h.expect('覆盖');
    const r = await ws.write('随手记.md', { text: '改过的内容' }, { mode: 'overwrite' });
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.equal(t.read('随手记.md').trim(), '改过的内容');
  });

  test('假宿主拒绝就跳过', async () => {
    h.expect('保留原样');
    const r = await ws.write('随手记.md', { text: '不该写进去' }, { mode: 'overwrite' });
    assert.equal(r.skipped, true, JSON.stringify(r));
  });

  test('拒绝之后磁盘一字未改', () => {
    assert.equal(t.read('随手记.md').trim(), '改过的内容');
  });

  test('review: false 时不问直接写', async () => {
    h.expect();
    const r = await ws.write('随手记.md', { text: '强写' }, { mode: 'overwrite', review: false });
    assert.equal(r.skipped, undefined);
    assert.equal(h.confirms.length, 0);
    assert.equal(t.read('随手记.md').trim(), '强写');
  });

  test('what 给了就用它当审阅框里的名字', async () => {
    h.expect('保留原样');
    await ws.write('随手记.md', { text: '甲' }, { mode: 'overwrite', what: '我的随手记' });
    assert.ok(h.confirms[0].message.includes('我的随手记'), h.confirms[0].message);
  });
});

describe('write · 乐观锁', () => {
  test('baseHash 对得上就写', async () => {
    const base = bundle.fs.hash(t.read('随手记.md'));
    h.expect('覆盖');
    const r = await ws.write('随手记.md', { text: '基线对得上' }, { mode: 'overwrite', baseHash: base });
    assert.equal(r.skipped, undefined);
  });

  test('baseHash 对不上抛 conflict', async () => {
    assert.equal(
      await codeOf(() =>
        ws.write('随手记.md', { text: '不该写' }, { mode: 'overwrite', baseHash: '旧的' })
      ),
      'conflict'
    );
  });

  test('冲突之后磁盘一字未改', () => {
    assert.equal(t.read('随手记.md').trim(), '基线对得上');
  });
});

describe('write · append', () => {
  test('往不存在的文件 append 等于新建', async () => {
    const r = await ws.write('日志.md', { text: '第一段' }, { mode: 'append' });
    assert.equal(r.skipped, undefined);
    assert.ok(t.read('日志.md').includes('第一段'));
  });

  test('append 不覆盖，也不问', async () => {
    h.expect();
    await ws.write('日志.md', { text: '第二段' }, { mode: 'append' });
    const text = t.read('日志.md');
    assert.ok(text.includes('第一段') && text.includes('第二段'), text);
    assert.equal(h.confirms.length, 0);
  });
});

describe('read', () => {
  before(async () => {
    t.write('长文.md', Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  });

  test('读得回内容', async () => {
    const f = await ws.read('随手记.md');
    assert.equal(f.text.trim(), '基线对得上');
  });

  test('带上 hash（乐观锁基线）', async () => {
    const f = await ws.read('随手记.md');
    assert.equal(f.hash, bundle.fs.hash(t.read('随手记.md')));
  });

  test('带上种类', async () => {
    assert.equal((await ws.read('.novelforge/outline.md')).kind, 'outline');
  });

  test('读不存在的抛 notFound', async () => {
    assert.equal(await codeOf(() => ws.read('查无此文.md')), 'notFound');
  });

  test('越界抛 outOfRoot', async () => {
    assert.equal(await codeOf(() => ws.read('../外面.md')), 'outOfRoot');
  });

  // 不静默截断（AGENTS 第 2 条）：截了多少必须说出来。
  test('按 limit 截断时只给那几行', async () => {
    const f = await ws.read('长文.md', { offset: 10, limit: 5 });
    assert.equal(f.text.split('\n').length, 5, f.text);
    assert.ok(f.text.startsWith('第 11 行'), f.text);
  });

  test('截断时 truncated 说明从哪开始、共多少行', async () => {
    const f = await ws.read('长文.md', { offset: 10, limit: 5 });
    assert.deepEqual(f.truncated, { from: 10, total: 200 });
  });

  test('没截断时不给 truncated', async () => {
    const f = await ws.read('随手记.md');
    assert.equal(f.truncated, undefined);
  });
});

describe('edit', () => {
  before(() => {
    t.write('改改.md', '甲说了一句。乙说了一句。甲又说了一句。\n');
  });

  test('替换唯一命中', async () => {
    const r = await ws.edit('改改.md', [{ old: '乙说了一句。', new: '乙沉默了。' }]);
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.ok(t.read('改改.md').includes('乙沉默了。'), t.read('改改.md'));
  });

  test('old 不唯一且没给 all 就抛', async () => {
    assert.equal(await codeOf(() => ws.edit('改改.md', [{ old: '甲', new: '丙' }])), 'notUnique');
  });

  test('抛了之后一个字都没改', () => {
    assert.ok(t.read('改改.md').includes('甲说了一句。'), t.read('改改.md'));
  });

  test('all: true 时全替换', async () => {
    const r = await ws.edit('改改.md', [{ old: '甲', new: '丙', all: true }]);
    assert.ok(!t.read('改改.md').includes('甲'), t.read('改改.md'));
    assert.ok(r.message.includes('2'), r.message);
  });

  test('old 找不到就抛，不静默什么都不做', async () => {
    assert.equal(
      await codeOf(() => ws.edit('改改.md', [{ old: '压根没有这段', new: 'x' }])),
      'notFound'
    );
  });

  // 一次多条编辑要么全成要么全不成——半截状态比报错难收拾得多。
  test('多条编辑里有一条失败，整批都不落盘', async () => {
    const before = t.read('改改.md');
    await codeOf(() =>
      ws.edit('改改.md', [
        { old: '丙说了一句。', new: '丙笑了。' },
        { old: '压根没有这段', new: 'x' },
      ])
    );
    assert.equal(t.read('改改.md'), before);
  });
});

describe('remove · 搬进 .trash/ 并保留原相对路径', () => {
  before(async () => {
    t.write('待删/甲.md', '甲');
    await ws.remove('待删/甲.md');
  });

  test('原位置没了', () => {
    assert.ok(!t.has('待删/甲.md'));
  });

  test('回收站里保留原相对路径', () => {
    assert.ok(t.has('.novelforge/.trash/待删/甲.md'));
  });

  test('内容原样', () => {
    assert.equal(t.read('.novelforge/.trash/待删/甲.md'), '甲');
  });

  test('删受保护的固定目录抛 protected', async () => {
    assert.equal(await codeOf(() => ws.remove('chapters')), 'protected');
  });

  test('删不存在的抛 notFound', async () => {
    assert.equal(await codeOf(() => ws.remove('查无此文.md')), 'notFound');
  });

  test('删回收站里的东西抛 inTrash', async () => {
    assert.equal(await codeOf(() => ws.remove('.novelforge/.trash/待删/甲.md')), 'inTrash');
  });

  // 同名冲突时加序号，不覆盖之前删掉的东西。
  test('第二次删同名不覆盖回收站里那份', async () => {
    t.write('待删/甲.md', '第二个甲');
    await ws.remove('待删/甲.md');
    assert.equal(t.read('.novelforge/.trash/待删/甲.md'), '甲');
    assert.equal(t.read('.novelforge/.trash/待删/甲-2.md'), '第二个甲');
  });
});

describe('move', () => {
  before(() => {
    t.write('搬家/原件.md', '原件内容');
  });

  test('搬到新位置', async () => {
    const r = await ws.move('搬家/原件.md', '搬家/新名.md');
    assert.equal(r.rel, '搬家/新名.md');
    assert.ok(t.has('搬家/新名.md'));
    assert.ok(!t.has('搬家/原件.md'));
  });

  test('目标已存在时不覆盖', async () => {
    t.write('搬家/占位.md', '占位');
    assert.equal(await codeOf(() => ws.move('搬家/新名.md', '搬家/占位.md')), 'exists');
  });

  test('不覆盖之后两份都还在', () => {
    assert.equal(t.read('搬家/占位.md'), '占位');
    assert.equal(t.read('搬家/新名.md'), '原件内容');
  });

  test('搬固定目录抛 protected', async () => {
    assert.equal(await codeOf(() => ws.move('chapters', '正文')), 'protected');
  });

  test('搬到工程外抛 outOfRoot', async () => {
    assert.equal(await codeOf(() => ws.move('搬家/新名.md', '../外面.md')), 'outOfRoot');
  });
});

describe('list', () => {
  let entries;

  before(async () => {
    t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    t.write('chapters/cover.png', 'PNG');
    project.invalidate();
    entries = await ws.list('chapters');
  });

  test('列得出条目', () => {
    assert.ok(entries.length >= 2, JSON.stringify(entries.map((e) => e.name)));
  });

  test('条目带 kind', () => {
    assert.equal(entries.find((e) => e.name === '001-楔子.md').kind, 'chapter');
  });

  test('二进制的那份是 other', () => {
    assert.equal(entries.find((e) => e.name === 'cover.png').kind, 'other');
  });

  test('文本文件给字数', () => {
    assert.ok(entries.find((e) => e.name === '001-楔子.md').words > 0);
  });

  test('条目带相对路径', () => {
    assert.equal(entries.find((e) => e.name === '001-楔子.md').rel, 'chapters/001-楔子.md');
  });

  test('目录也列出来，type 是 dir', async () => {
    const root = await ws.list();
    assert.equal(root.find((e) => e.name === 'chapters').type, 'dir');
  });

  test('列不存在的目录不抛，给空数组', async () => {
    assert.deepEqual(await ws.list('查无此目录'), []);
  });

  test('列越界目录不抛，给空数组', async () => {
    assert.deepEqual(await ws.list('../外面'), []);
  });
});

describe('doc handler · 固定单文件与角色/设定', () => {
  test('写大纲', async () => {
    h.expect('覆盖');
    const r = await ws.write('.novelforge/outline.md', { text: '# 大纲\n\n第一幕' }, { mode: 'overwrite' });
    assert.equal(r.skipped, undefined);
    assert.ok(t.read('.novelforge/outline.md').includes('第一幕'));
  });

  test('写角色卡', async () => {
    const r = await ws.write('.novelforge/characters/林昭.md', { text: '# 林昭\n\n少年剑客。' });
    assert.equal(r.rel, '.novelforge/characters/林昭.md');
    assert.ok(t.read('.novelforge/characters/林昭.md').includes('少年剑客'));
  });

  test('写设定条目', async () => {
    await ws.write('.novelforge/lore/青云宗.md', { text: '# 青云宗\n\n山门。' });
    assert.ok(t.has('.novelforge/lore/青云宗.md'));
  });

  // 草稿走 plain：纯文本进出，无记账，也永不自动进上下文（第 10 条）。
  test('写草稿', async () => {
    await ws.write('drafts/001-楔子.md', { text: '草稿内容' });
    assert.equal((await ws.read('drafts/001-楔子.md')).kind, 'draft');
  });
});
