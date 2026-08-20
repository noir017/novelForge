/**
 * 本机一层目录列举。测试写进临时目录，不扫整个家目录。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

const { listHostDir, createHostDir } = loadModule('src/shells/standalone/hostFs.ts');

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hostfs-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'secret-body', 'utf8');
  fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'x', 'utf8');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const names = (listing) => listing.entries.map((e) => e.name);

describe('listHostDir', () => {
  test('列出子目录与文件，目录在前', async () => {
    const listing = await listHostDir(dir);
    assert.equal(listing.error, undefined);
    assert.ok(names(listing).includes('sub'));
    assert.ok(names(listing).includes('note.txt'));
    const subIdx = listing.entries.findIndex((e) => e.name === 'sub');
    const fileIdx = listing.entries.findIndex((e) => e.name === 'note.txt');
    assert.ok(subIdx < fileIdx);
  });

  test('点开头的目录可见，.git 与 node_modules 隐藏', async () => {
    const listing = await listHostDir(dir);
    assert.ok(names(listing).includes('.hidden'));
    assert.ok(!names(listing).includes('.git'));
    assert.ok(!names(listing).includes('node_modules'));
  });

  test('条目只有名字和路径，没有正文', async () => {
    const listing = await listHostDir(dir);
    const file = listing.entries.find((e) => e.name === 'note.txt');
    assert.equal(file.kind, 'file');
    assert.equal(file.absPath, path.join(dir, 'note.txt'));
    assert.equal('text' in file, false);
    assert.equal(JSON.stringify(file).includes('secret-body'), false);
  });

  test('不存在的目录带 error', async () => {
    const listing = await listHostDir(path.join(dir, 'nope'));
    assert.equal(listing.entries.length, 0);
    assert.match(listing.error, /不存在/);
  });

  test('~ 列举家目录', async () => {
    const listing = await listHostDir('~');
    assert.equal(listing.error, undefined);
    assert.equal(listing.path, os.homedir());
  });

  test('空路径在 Unix 列举根且没有 parent', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const listing = await listHostDir('');
    assert.equal(listing.parent, undefined);
    assert.ok(listing.entries.length > 0);
  });
});

describe('createHostDir', () => {
  test('mkdir 成功后能列到新目录', async () => {
    const listing = await createHostDir(dir, 'fresh');
    assert.equal(listing.error, undefined);
    assert.ok(names(listing).includes('fresh'));
    assert.ok(fs.statSync(path.join(dir, 'fresh')).isDirectory());
  });

  test('拒绝 .. 与斜杠，不在磁盘上造目录', async () => {
    for (const name of ['..', 'a/b', 'a\\b']) {
      const listing = await createHostDir(dir, name);
      assert.match(listing.error, /不合法/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'a')), false);
  });

  test('同名已存在则报错不覆盖', async () => {
    const before = fs.readFileSync(path.join(dir, 'note.txt'), 'utf8');
    const listing = await createHostDir(dir, 'note.txt');
    assert.match(listing.error, /已存在/);
    assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), before);
  });
});
