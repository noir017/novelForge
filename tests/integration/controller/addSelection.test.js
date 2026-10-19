/**
 * 「加入选区」的后端一半：独立版内置编辑器里的选区由前端带上来（`addSelection.selection`），
 * 没带才交给宿主（插件读 VS Code 编辑器的选区，独立版弹粘贴框）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 带了选区就直接做成附件，不问宿主 | 宿主取不到网页里的选区，问了只会弹粘贴框 |
 * | id、名字与插件那一份一个样（`sel:路径:起-止`、`文件名:起-止`） | 同一处选区重复添加时靠 id 去重 |
 * | 存的是快照 | 选的时候是那个样子，之后文件改了不该让历史对话跟着变 |
 * | 路径越界只留文字 | 不留一个点不开的路径 |
 * | 没带选区才问宿主；宿主也没有就提示 | 原来那条路照旧 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let h;
let controller;
let posted = [];
let hostAsked = 0;
let hostGives;

/** 发一条 addSelection，返回这一下之后推给前端的附件列表（没推就是 undefined）。 */
async function add(selection) {
  posted = [];
  await controller.handle(selection ? { type: 'addSelection', selection } : { type: 'addSelection' });
  return posted.filter((m) => m.type === 'attachments').at(-1)?.items;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  h = makeFakeHost({ name: 'standalone', settings: () => settings });
  h.host.selectionAttachment = async () => {
    hostAsked++;
    return hostGives;
  };
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'add-selection', title: '青云剑录' });
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('前端带上来的选区', () => {
  let items;
  before(async () => {
    items = await add({ relPath: 'chapters/001-雨夜.md', text: '  雨下了一夜。\n林昭推门进来。\n', start: 2, end: 3 });
  });

  test('直接做成附件，不问宿主', () => {
    assert.equal(hostAsked, 0);
    assert.equal(items?.length, 1, JSON.stringify(posted));
  });

  test('id 与名字和插件那一份一个样', () => {
    assert.equal(items[0].id, 'sel:chapters/001-雨夜.md:2-3');
    assert.equal(items[0].label, '001-雨夜.md:2-3');
    assert.equal(items[0].kind, 'selection');
  });

  test('存的是去掉首尾空白的快照，带路径与行号', () => {
    assert.equal(items[0].text, '雨下了一夜。\n林昭推门进来。');
    assert.equal(items[0].relPath, 'chapters/001-雨夜.md');
    assert.deepEqual(items[0].range, { start: 2, end: 3 });
  });

  test('同一处再加一次不重复，说一句已经引用过', async () => {
    const again = await add({ relPath: 'chapters/001-雨夜.md', text: '雨下了一夜。\n林昭推门进来。', start: 2, end: 3 });
    assert.equal(again, undefined, JSON.stringify(posted));
    assert.ok(posted.some((m) => m.type === 'toast' && m.message.includes('已经引用过')), JSON.stringify(posted));
  });

  test('路径越界只留文字', async () => {
    const out = await add({ relPath: '../别处/机密.md', text: '不该留路径', start: 1, end: 1 });
    const last = out.at(-1);
    assert.equal(last.text, '不该留路径');
    assert.equal(last.relPath, undefined, JSON.stringify(last));
    assert.equal(last.label, '选区');
  });
});

describe('没带选区：交给宿主', () => {
  test('宿主给了就用宿主的', async () => {
    hostAsked = 0;
    hostGives = { id: 'paste-1', kind: 'selection', label: '粘贴的选区', text: '粘进来的一段' };
    const out = await add();
    assert.equal(hostAsked, 1);
    assert.equal(out.at(-1).id, 'paste-1');
  });

  test('文字全是空白也当没带', async () => {
    hostAsked = 0;
    await add({ relPath: 'chapters/001-雨夜.md', text: '   \n ', start: 1, end: 2 });
    assert.equal(hostAsked, 1);
  });

  test('宿主也没有就提示一句，不加附件', async () => {
    hostGives = undefined;
    const out = await add();
    assert.equal(out, undefined, JSON.stringify(posted));
    const toast = posted.find((m) => m.type === 'toast');
    assert.ok(toast?.message.includes('没有可加入的文本'), JSON.stringify(posted));
    assert.equal(toast.level, 'error');
  });
});
