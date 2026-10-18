/**
 * 内置编辑器的磁盘核对与「磁盘上没了」（后端一半）：`files/fileEditing.ts` 的 `checkEditorFiles` /
 * `writeFileFromEditor`，以及独立版 `FileHost` 推出去的 `editorDiskChanged` / `editorDiskGone`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | hash 对不上的回新版、读不到的报没了、对得上的不回 | 前端据此就地换掉没改过的标签、给改过的挂冲突条 |
 * | 越界、不可编辑、坏条目跳过、不抛 | 一条坏消息不该让整批作废，也不该读到工程外面去 |
 * | 只读，一个字节都不写 | 每条 `state` 之后都会核对一次 |
 * | 带了基线、文件却不在：不在原路径重建，报没了 | 网关对这种情况是当新建处理的；作者在外面改的名会白改 |
 * | 答应重建才写；期间原路径又有了别的内容照样撞冲突 | 重建也带着乐观锁 |
 * | 编辑器自己存下去的那份再核对不报「变了」 | 自己保存之后不误报 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');

const bundle = loadBundle({
  fileHost: './src/shells/standalone/fileHost.ts',
  fileEditing: './src/core/files/fileEditing.ts',
  fsModel: './src/core/model/fs.ts',
  stores: './src/core/stores.ts',
});
const { FileHost } = bundle.fileHost;
const { checkEditorFiles, writeFileFromEditor, FileGoneError, FileConflictError } = bundle.fileEditing;
const { hash } = bundle.fsModel;

let dir;
const abs = (rel) => path.join(dir, rel);
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
};
const hostWith = (sent) => new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-editor-disk-'));
  put('chapters/001-雨夜.md', '# 雨夜\n\n林昭推开客栈的门。\n');
  put('.novelforge/summaries/001-雨夜.md', '# 雨夜\n\n## 梗概\n林昭进客栈。\n');
  put('notes.txt', '随手记\n');
  put('pic.png', 'not really a png');
  fs.mkdirSync(abs('chapters/002-目录'), { recursive: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkEditorFiles：按 hash 核对开着的几份', () => {
  const ch = 'chapters/001-雨夜.md';

  test('对得上：什么都不报', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: hash(fs.readFileSync(abs(ch), 'utf8')) }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('对不上：报磁盘上的新版，path 原样用前端给的', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: 'h-old' }]);
    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].path, ch);
    assert.equal(r.changed[0].name, '001-雨夜.md');
    assert.equal(r.changed[0].text, fs.readFileSync(abs(ch), 'utf8'));
    assert.equal(r.changed[0].hash, hash(r.changed[0].text));
  });

  test('前端给空 hash（它以为没了）而文件在：照样报新版', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: '' }]);
    assert.equal(r.changed.length, 1);
  });

  test('读不到（被删、被改名）：报没了', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'chapters/009-删了的.md', hash: 'h' }]);
    assert.deepEqual(r.gone, ['chapters/009-删了的.md']);
  });

  test('那个路径现在是个目录：也算没了', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'chapters/002-目录', hash: 'h' }]);
    assert.deepEqual(r.gone, ['chapters/002-目录']);
  });

  test('越界路径跳过、不抛', async () => {
    const r = await checkEditorFiles(dir, [{ path: '../escape.md', hash: 'h' }, { path: '/etc/passwd.md', hash: 'h' }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('不可编辑的扩展名跳过', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'pic.png', hash: 'h' }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('坏条目跳过，其余照常', async () => {
    const r = await checkEditorFiles(dir, [null, { path: 3, hash: 'h' }, { path: 'notes.txt' }, { path: 'notes.txt', hash: 'h' }]);
    assert.deepEqual(r.changed.map((f) => f.path), ['notes.txt']);
  });

  test('同一路径给两次只报一次', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'notes.txt', hash: 'h' }, { path: 'notes.txt', hash: 'h2' }]);
    assert.equal(r.changed.length, 1);
  });

  test('只读：核对完磁盘上一个字节都没动', async () => {
    const before = fs.statSync(abs(ch)).mtimeMs;
    const content = fs.readFileSync(abs(ch), 'utf8');
    await checkEditorFiles(dir, [{ path: ch, hash: 'h-old' }, { path: 'chapters/009-删了的.md', hash: 'h' }]);
    assert.equal(fs.statSync(abs(ch)).mtimeMs, before);
    assert.equal(fs.readFileSync(abs(ch), 'utf8'), content);
    assert.equal(fs.existsSync(abs('chapters/009-删了的.md')), false);
  });
});

describe('writeFileFromEditor：带了基线、文件却不在', () => {
  const rel = 'chapters/003-改了名的.md';

  test('不在原路径重建，抛「没了」', async () => {
    await assert.rejects(writeFileFromEditor(dir, rel, '编辑器里的内容', 'h-base'), (err) => err instanceof FileGoneError);
    assert.equal(fs.existsSync(abs(rel)), false);
  });

  test('答应重建（recreate）才写', async () => {
    const r = await writeFileFromEditor(dir, rel, '编辑器里的内容', 'h-base', { recreate: true });
    assert.equal(fs.readFileSync(abs(rel), 'utf8'), '编辑器里的内容');
    assert.equal(r.hash, hash('编辑器里的内容'));
  });

  test('答应重建时原路径已经又有了别的内容：照样撞冲突、不覆盖', async () => {
    const other = 'chapters/004-又有了.md';
    put(other, '别处放回来的');
    await assert.rejects(
      writeFileFromEditor(dir, other, '编辑器里的内容', 'h-base', { recreate: true }),
      (err) => err instanceof FileConflictError && err.diskText === '别处放回来的'
    );
    assert.equal(fs.readFileSync(abs(other), 'utf8'), '别处放回来的');
  });

  test('不带基线（作者点了强制保存）照旧直接写', async () => {
    const forced = 'chapters/005-强制.md';
    await writeFileFromEditor(dir, forced, '强制写的');
    assert.equal(fs.readFileSync(abs(forced), 'utf8'), '强制写的');
  });
});

describe('FileHost：推给前端的消息', () => {
  test('磁盘上变了：editorDiskChanged 带 draftPath 与 kind（与 editorOpen 同一个形状）', async () => {
    const sent = [];
    await hostWith(sent).checkEditorFiles([{ path: 'chapters/001-雨夜.md', hash: 'h-old' }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'editorDiskChanged');
    assert.equal(sent[0].file.kind, 'chapter');
    assert.equal(sent[0].file.draftPath, 'drafts/001-雨夜.md');
  });

  test('读不到：editorDiskGone', async () => {
    const sent = [];
    await hostWith(sent).checkEditorFiles([{ path: 'chapters/009-删了的.md', hash: 'h' }]);
    assert.deepEqual(sent, [{ type: 'editorDiskGone', path: 'chapters/009-删了的.md' }]);
  });

  test('都对得上：一条都不推', async () => {
    const sent = [];
    const text = fs.readFileSync(abs('notes.txt'), 'utf8');
    await hostWith(sent).checkEditorFiles([{ path: 'notes.txt', hash: hash(text) }]);
    assert.deepEqual(sent, []);
  });

  test('保存时文件已经不在：推 editorDiskGone，什么都不写', async () => {
    const sent = [];
    await hostWith(sent).saveFromEditor('chapters/006-没了.md', '内容', 'h-base');
    assert.deepEqual(sent, [{ type: 'editorDiskGone', path: 'chapters/006-没了.md' }]);
    assert.equal(fs.existsSync(abs('chapters/006-没了.md')), false);
  });

  test('带 recreate 再来：写下去，回 editorSaved', async () => {
    const sent = [];
    await hostWith(sent).saveFromEditor('chapters/006-没了.md', '内容', 'h-base', { recreate: true });
    assert.equal(sent[0]?.type, 'editorSaved');
    assert.equal(fs.readFileSync(abs('chapters/006-没了.md'), 'utf8'), '内容');
  });

  test('自己存下去的那份再核对：不报「变了」', async () => {
    const sent = [];
    const host = hostWith(sent);
    const rel = 'chapters/001-雨夜.md';
    const base = hash(fs.readFileSync(abs(rel), 'utf8'));
    await host.saveFromEditor(rel, '# 雨夜\n\n改过了。\n', base);
    const saved = sent.find((m) => m.type === 'editorSaved');
    assert.ok(saved, JSON.stringify(sent));
    sent.length = 0;
    await host.checkEditorFiles([{ path: rel, hash: saved.file.hash }]);
    assert.deepEqual(sent, []);
  });

  test('没打开工程时什么都不推', async () => {
    const sent = [];
    await new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m)).checkEditorFiles([{ path: 'a.md', hash: 'h' }]);
    assert.deepEqual(sent, []);
  });
});
