/**
 * 独立版的覆盖审阅（五期 W11 的后端一半）：推一条 `prompt kind: 'merge'`，等网页的合并视图回话。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 推出去的带两个版本与能不能合并 | 合并视图照它画 |
 * | 请求了合并才认 `merged` | 没请求的调用方（角色卡那几处）收不下一份作者拼出来的文字 |
 * | 认不出、没回答 → 取消 | 宁可这一次不写 |
 * | 定位引文：找得到才推 `editorReveal` | 找不到时只打开文件，由 controller 提示 |
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
const { FileHost, parseMergeReply } = bundle.fileHost;

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-merge-'));
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', '001-雨夜.md'), '# 雨夜\n\n林昭推开客栈的门。\n');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function hostWith(sent) {
  return new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);
}

describe('parseMergeReply', () => {
  test('请求了合并：交回挑过的那一份', () => {
    assert.deepEqual(parseMergeReply('{"verdict":"apply","merged":"甲"}', true), { merged: '甲' });
  });
  test('没请求合并：merged 不认，只算采纳', () => {
    assert.equal(parseMergeReply('{"verdict":"apply","merged":"甲"}', false), 'apply');
  });
  test('放弃、取消、认不出', () => {
    assert.equal(parseMergeReply('{"verdict":"discard"}', true), 'discard');
    assert.equal(parseMergeReply(undefined, true), undefined);
    assert.equal(parseMergeReply('yes', true), undefined);
    assert.equal(parseMergeReply('{"verdict":"maybe"}', true), undefined);
  });
});

describe('FileHost.reviewReplace', () => {
  test('推一条 merge 询问，带两个版本；回话之后交回合并结果', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.reviewReplace('第 1 章的正文', '旧', '新', 'chapters/001-雨夜.md', { merge: true });
    const msg = sent.find((m) => m.type === 'prompt');
    assert.equal(msg.kind, 'merge');
    assert.equal(msg.current, '旧');
    assert.equal(msg.proposed, '新');
    assert.equal(msg.mergeable, true);
    assert.match(msg.title, /第 1 章的正文/);
    host.prompts.resolve(msg.requestId, JSON.stringify({ verdict: 'apply', merged: '合' }));
    assert.deepEqual(await pending, { merged: '合' });
  });

  test('没请求合并：只读', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.reviewReplace('角色卡', '旧', '新');
    const msg = sent.find((m) => m.type === 'prompt');
    assert.equal(msg.mergeable, false);
    host.prompts.resolve(msg.requestId, JSON.stringify({ verdict: 'apply' }));
    assert.equal(await pending, 'apply');
  });
});

describe('FileHost.revealText', () => {
  test('找得到：先打开，再推 editorReveal', async () => {
    const sent = [];
    const ok = await hostWith(sent).revealText('chapters/001-雨夜.md', '林昭推开客栈');
    assert.equal(ok, true);
    assert.deepEqual(sent.map((m) => m.type), ['editorOpen', 'editorReveal']);
    assert.equal(sent[1].quote, '林昭推开客栈');
  });

  test('找不到：只打开，返回 false', async () => {
    const sent = [];
    const ok = await hostWith(sent).revealText('chapters/001-雨夜.md', '根本没有这一句');
    assert.equal(ok, false);
    assert.deepEqual(sent.map((m) => m.type), ['editorOpen']);
  });
});
