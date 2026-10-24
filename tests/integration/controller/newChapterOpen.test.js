/**
 * 工程页「章节」还空着时那颗「新建第 1 章」（新手上手，2026-10-24）：`projectAction newChapter` 带 `open`，建完就打开。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 带 `open`：先问章名，建好正文与细纲，打开那一章 | 新书的第一下就是开写，不必再回工程页点一下 |
 * | 不带 `open`（右键「新建章节文件」）：照旧只建不开 | 那条的口径没变 |
 * | 输入框上取消：什么都不建、不打开 | 第 3 条 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let fakeHost;
const books = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
});

after(() => {
  for (const b of books) {
    b.controller.dispose();
    cleanup(b.t.dir, bundle?.db);
  }
});

async function freshBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '青云剑录' });
  const controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  books.push({ t, controller });
  return { t, controller };
}

describe('新建第 1 章：建完就打开', () => {
  test('带 open：问章名，建好正文与细纲，打开那一章', async () => {
    const { t, controller } = await freshBook('new-chapter-open');
    fakeHost.expect('楔子');
    await controller.handle({ type: 'projectAction', action: 'newChapter', open: true });
    assert.equal(fakeHost.inputs.length, 1);
    assert.ok(fs.existsSync(t.rel('chapters/001-楔子.txt')));
    assert.ok(fs.existsSync(t.rel('.novelforge/summaries/001-楔子.md')));
    assert.deepEqual(fakeHost.opened, ['chapters/001-楔子.txt']);
  });

  test('不带 open（右键「新建章节文件」）：照旧只建不开', async () => {
    const { t, controller } = await freshBook('new-chapter-closed');
    fakeHost.expect('楔子');
    await controller.handle({ type: 'projectAction', action: 'newChapter' });
    assert.ok(fs.existsSync(t.rel('chapters/001-楔子.txt')));
    assert.deepEqual(fakeHost.opened, []);
  });

  test('输入框上取消：什么都不建、不打开', async () => {
    const { t, controller } = await freshBook('new-chapter-cancel');
    fakeHost.expect(undefined);
    await controller.handle({ type: 'projectAction', action: 'newChapter', open: true });
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
    assert.deepEqual(fakeHost.opened, []);
  });
});
