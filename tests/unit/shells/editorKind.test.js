/**
 * 独立版内置编辑器的文件负载带 `kind`（`kindOfPath` 算的）：前端据此分「正文」（chapter / draft）
 * 与其余文件——Tab 缩进全角还是半角就看它，前端不自己拿路径猜。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | `editorOpen` 带 kind：章节、草稿、角色卡、工程外的随手文件各是各的 | 与网关同一张表 |
 * | `editorSaved` 也带 kind | 前端的保存分支会拿回执刷新文件，漏了等于保存一次就忘了是正文 |
 * | 三条都带 `label`（标签上的短标记与名字、面包屑） | 称呼由后端算，前端不拿路径猜；漏一条前端就退回原始路径 |
 * | 打开请求上的 `preview` / `replace` 原样带回 `editorOpen` | 临时标签与「原位换掉」由内置编辑器决定，后端不看 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');

const bundle = loadBundle({
  fileHost: './src/shells/standalone/fileHost.ts',
  stores: './src/core/stores.ts',
});
const { FileHost } = bundle.fileHost;

let dir;
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-editor-kind-'));
  put('chapters/001-雨夜.md', '# 雨夜\n\n林昭推开客栈的门。\n');
  put('drafts/001-雨夜.md', '草稿\n');
  put('.novelforge/characters/林昭.md', '# 林昭\n');
  put('notes.txt', '随手记\n');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function hostWith(sent) {
  return new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);
}

async function openKind(rel) {
  const sent = [];
  await hostWith(sent).openInEditor(rel);
  const msg = sent.find((m) => m.type === 'editorOpen');
  assert.ok(msg, JSON.stringify(sent));
  return msg.file.kind;
}

describe('内置编辑器的文件负载带 kind', () => {
  test('章节是 chapter', async () => {
    assert.equal(await openKind('chapters/001-雨夜.md'), 'chapter');
  });

  test('草稿是 draft', async () => {
    assert.equal(await openKind('drafts/001-雨夜.md'), 'draft');
  });

  test('角色卡是 character', async () => {
    assert.equal(await openKind('.novelforge/characters/林昭.md'), 'character');
  });

  test('不在任何区里的文件是 other', async () => {
    assert.equal(await openKind('notes.txt'), 'other');
  });

  test('editorOpen 带称呼：正文不带短标记、面包屑写第几章', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('chapters/001-雨夜.md');
    const label = sent.find((m) => m.type === 'editorOpen').file.label;
    assert.deepEqual(label, {
      tag: '',
      title: '001-雨夜',
      crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 1 章 雨夜' }],
    });
  });

  test('草稿带「草稿」，与同一章的正文分得清', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('drafts/001-雨夜.md');
    const label = sent.find((m) => m.type === 'editorOpen').file.label;
    assert.equal(label.tag, '草稿');
    assert.equal(label.title, '001-雨夜');
  });

  test('打开请求上的 preview / replace 原样带回', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('chapters/001-雨夜.md', 'draft', { preview: true, replace: 'chapters/000-旧.md' });
    const msg = sent.find((m) => m.type === 'editorOpen');
    assert.deepEqual(
      { pane: msg.pane, preview: msg.preview, replace: msg.replace },
      { pane: 'draft', preview: true, replace: 'chapters/000-旧.md' }
    );
  });

  test('没带标记的打开：editorOpen 上也没有（正常标签）', async () => {
    const sent = [];
    await hostWith(sent).openFile('chapters/001-雨夜.md');
    const msg = sent.find((m) => m.type === 'editorOpen');
    assert.equal('preview' in msg, false);
    assert.equal('replace' in msg, false);
  });

  test('openFile / openBeside 把 preview 传下去', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.openFile('chapters/001-雨夜.md', { preview: true });
    await host.openBeside('drafts/001-雨夜.md', { preview: true });
    const opens = sent.filter((m) => m.type === 'editorOpen');
    assert.deepEqual(opens.map((m) => [m.file.path, m.pane, m.preview]), [
      ['chapters/001-雨夜.md', undefined, true],
      ['drafts/001-雨夜.md', 'draft', true],
    ]);
  });

  test('保存回执也带 kind', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.saveFromEditor('chapters/001-雨夜.md', '# 雨夜\n\n改过了。\n');
    const msg = sent.find((m) => m.type === 'editorSaved');
    assert.ok(msg, JSON.stringify(sent));
    assert.equal(msg.file.kind, 'chapter');
  });

  test('保存回执与磁盘核对的新版也带称呼', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.saveFromEditor('.novelforge/characters/林昭.md', '# 林昭\n\n改过。\n');
    assert.equal(sent.find((m) => m.type === 'editorSaved').file.label.tag, '角色');
    await host.checkEditorFiles([{ path: '.novelforge/characters/林昭.md', hash: 'stale' }]);
    const changed = sent.find((m) => m.type === 'editorDiskChanged');
    assert.ok(changed, JSON.stringify(sent.map((m) => m.type)));
    assert.equal(changed.file.label.title, '林昭');
  });
});
