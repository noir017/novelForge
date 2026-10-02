/**
 * 导入原稿（拆书 A 的前一半，features/importManuscript.ts）：工程里的一本 txt → `chapters/NNN-标题.md`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只列工程里的 txt，章节文件与隐藏目录里的不算 | 不拿章节去拆、不读工程外 |
 * | 确认框报章数、章号区间、丢掉了什么，写明不调模型 | 切的结果作者看过才落盘 |
 * | 正文一段一行，标题进文件名；简介、卷标题、目录不导入 | 原稿进来就是能接着写的样子 |
 * | 接在已有章节之后 | 一条轴（第 8 条），不撞号 |
 * | 认不出章标题：不弹确认框、一个文件都不写 | 不把整本当一章塞进来 |
 * | GBK 照读 | 中文 txt 一大半是 GBK |
 * | 导入完问一句要不要接着补齐；不接就零调用 | 第 4 条：调模型的那一步另报次数 |
 * | agent 给的路径只认清单里的 | 第 25 条：不越过既有的闸门 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
const projects = [];

const BOOK = [
  '青云剑录',
  '作者：某某',
  '',
  '目录',
  '第一章 入宗',
  '第二章 雪夜',
  '',
  '第一卷 少年游',
  '第一章 入宗',
  '　　林昭站在山门前。',
  '　　“你来晚了。”沈青说。',
  '第二章 雪夜',
  '雪下了一夜。',
  '第二卷 江湖远',
  '第三章',
  '天亮了，林昭下山。',
].join('\n');

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    importer: './src/core/features/importManuscript.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: () => '' });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '导入测试' });
  projects.push(t);
  fake.reset();
  return t;
}

describe('导入原稿 · 挑文件', () => {
  test('只列工程里的 txt：章节文件、隐藏目录里的不算', async () => {
    const t = await fresh('import-list');
    t.write('原稿.txt', BOOK);
    t.write('参考/别人的书.txt', BOOK);
    t.write('chapters/001-楔子.txt', '一章 txt 正文');
    t.write('.novelforge/import/藏着的.txt', BOOK);
    t.project.invalidate();
    const files = await t.project.listImportableTexts();
    assert.deepEqual(files.map((f) => f.relPath).sort(), ['原稿.txt', '参考/别人的书.txt'].sort());
  });

  test('工程里一本 txt 都没有：说清放哪，不弹选择框', async () => {
    const t = await fresh('import-none');
    h.expect();
    const r = await bundle.importer.importManuscript(t.project);
    assert.deepEqual(r, { imported: 0, calls: 0 });
    assert.equal(h.picks.length, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('把整本 txt 放进工程目录')), h.toasts.join('|'));
  });
});

describe('导入原稿 · 切章落盘', () => {
  let t;
  let r;
  let confirm;
  before(async () => {
    t = await fresh('import-ok');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    // 选文件 → 导入 → 不接着补齐
    h.expect('原稿.txt', '导入', undefined);
    r = await bundle.importer.importManuscript(t.project);
    confirm = h.confirms[0];
  });

  test('确认框报章数、区间、丢掉了什么，写明不调模型', () => {
    assert.match(confirm.message, /^从《原稿》认出 3 章（\d+ 字），导入为第 1–3 章？这一步不调用模型。$/);
    assert.match(confirm.detail, /UTF-8/);
    assert.match(confirm.detail, /第 1 章《入宗》（原文「第一章 入宗」/);
    assert.match(confirm.detail, /第一个章标题之前的 \d+ 字（「青云剑录 作者：某某 目录」）不导入/);
    assert.match(confirm.detail, /2 行卷标题（第一卷 少年游、第二卷 江湖远）不算章/);
    assert.match(confirm.detail, /2 个标题下面没有正文（多半是目录），跳过/);
  });

  test('一章一个文件，标题进文件名，一段一行', () => {
    assert.deepEqual(r, { imported: 3, calls: 0 });
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林昭站在山门前。\n\n“你来晚了。”沈青说。\n');
    assert.equal(t.read('chapters/002-雪夜.md'), '# 雪夜\n\n雪下了一夜。\n');
    // 「第三章」一行没有章名：纯序号名，不写标题行。
    assert.equal(t.read('chapters/003.md'), '天亮了，林昭下山。\n');
    // 原 txt 不动。
    assert.equal(t.read('原稿.txt'), BOOK);
  });

  test('导入完问要不要接着补齐；不接就零调用', () => {
    assert.match(h.confirms[1].message, /^已导入第 1–3 章。接着从已写正文补齐/);
    assert.equal(fake.callCount(), 0);
  });

  test('工程认得出这三章', async () => {
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.deepEqual(chapters.map((c) => [c.order, c.title]), [[1, '入宗'], [2, '雪夜'], [3, '第 3 章']]);
  });
});

describe('导入原稿 · 边角', () => {
  test('接在已有章节之后', async () => {
    const t = await fresh('import-append');
    t.write('chapters/001-旧稿.md', '# 旧稿\n\n作者早先写的。\n');
    t.write('续稿.txt', '第一章 新的\n新写的一章。');
    t.project.invalidate();
    h.expect('续稿.txt', '导入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 1);
    assert.match(h.confirms[0].message, /导入为第 2 章/);
    assert.match(h.confirms[0].detail, /工程里已经有 1 章，接在第 1 章之后/);
    assert.equal(t.read('chapters/002-新的.md'), '# 新的\n\n新写的一章。\n');
    assert.equal(t.read('chapters/001-旧稿.md'), '# 旧稿\n\n作者早先写的。\n');
  });

  test('认不出章标题：不弹确认框，一个文件都不写', async () => {
    const t = await fresh('import-noheads');
    t.write('散文.txt', '从前有座山。\n山里有座庙。');
    t.project.invalidate();
    h.expect('散文.txt', '导入');
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('认不出章节标题')));
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
  });

  test('GBK 编码照读，确认框写明编码', async () => {
    const t = await fresh('import-gbk');
    // 「第一章 雪夜\n雪下了一夜。」的 GBK 编码
    const bytes = Buffer.from('b5dad2bbd5c220d1a9d2b90ad1a9cfc2c1cbd2bbd2b9a1a3', 'hex');
    fs.writeFileSync(t.rel('旧稿.txt'), bytes);
    t.project.invalidate();
    h.expect('旧稿.txt', '导入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 1);
    assert.match(h.confirms[0].detail, /GBK/);
    assert.equal(t.read('chapters/001-雪夜.md'), '# 雪夜\n\n雪下了一夜。\n');
  });

  test('作者取消：一个文件都不写', async () => {
    const t = await fresh('import-cancel');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
  });

  test('agent 给的路径只认清单里的：章节文件、工程外都拒绝', async () => {
    const t = await fresh('import-path');
    t.write('chapters/001-楔子.txt', '第一章 楔子\n正文');
    t.project.invalidate();
    await assert.rejects(() => bundle.importer.importManuscript(t.project, { path: 'chapters/001-楔子.txt' }), /不是工程里能拆的 txt/);
    await assert.rejects(() => bundle.importer.importManuscript(t.project, { path: '../外面.txt' }), /不是工程里能拆的 txt/);
  });
});
