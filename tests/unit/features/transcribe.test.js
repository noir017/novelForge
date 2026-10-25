/**
 * 转写的整条走法（features/transcribe.ts 的 `transcribeJson`，2026-10-25 起所有结构化产物都走它）。调用是假的：
 * 一个按顺序交回应答的函数，记下每次收到的消息。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 原文就是 JSON | 不转，按这一步的解码直接判（与改之前一样）；判不过照样不转 |
 * | 不像这一步的输出 | 不花转写那一次；坏了语法的 JSON 照转 |
 * | 照抄 | 一次过；「无」换成空的；交回规范化的 JSON |
 * | 改了字 / 解码不过 / 截断 | 重转一次，说清上次哪里不对；还不过交回原因与两条说明 |
 * | 转写调用失败 | 不往外抛，交回 `failed`；取消照旧往外抛 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

// 同一个 bundle：用例里抛的 CancelledError 与 transcribe.ts 认的是同一个类。
const { t: T, p: P } = loadBundle({ t: './src/core/features/transcribe.ts', p: './src/core/llm/provider.ts' });

const SOURCE = ['## 林昭', '- 身份：青云宗外门弟子', '- 当前状态：左臂受伤，藏在后院', '- 定位：主角'].join('\n');
const spec = (over = {}) => ({
  label: '角色状态',
  contract: '【合同】{"name":"…","state":"…","role":"protagonist|supporting"}',
  decode: (json) => {
    const v = JSON.parse(json);
    return v.name && v.state ? { ok: true, value: v } : { ok: false, message: '缺 name 或 state' };
  },
  mapped: ['role'],
  ...over,
});
const scripted = (...replies) => {
  const seen = [];
  const call = async (messages, label) => {
    seen.push({ messages, label });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? { text: r, stop: 'end' } : r;
  };
  return { call, seen };
};
const GOOD = JSON.stringify({ name: '林昭', state: '左臂受伤，藏在后院', role: 'protagonist' });

describe('features/transcribe.ts · transcribeJson', () => {
  test('原文就是 JSON：不转，按解码直接判；判不过照样不转', async () => {
    const { call, seen } = scripted();
    const r = await T.transcribeJson(GOOD, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.direct, true);
    assert.equal(r.calls, 0);
    const bad = await T.transcribeJson('{"name":"林昭"}', spec(), call);
    assert.deepEqual([bad.ok, bad.message, bad.calls], [false, '缺 name 或 state', 0]);
    assert.equal(seen.length, 0);
  });

  test('不像这一步的输出：不花转写那一次；坏了语法的 JSON 照转', async () => {
    const { call, seen } = scripted(GOOD);
    const looksLike = (s) => s.includes('当前状态');
    const r = await T.transcribeJson('我不太确定。', spec({ looksLike }), call);
    assert.deepEqual([r.ok, r.calls, seen.length], [false, 0, 0]);
    const fixed = await T.transcribeJson('{"name":"林昭","state":"左臂受伤，藏在后院",', spec({ looksLike }), call);
    assert.equal(fixed.ok, true);
    assert.equal(seen.length, 1);
  });

  test('照抄：一次过，「无」换成空的，交回规范化的 JSON；转写只带合同与原文', async () => {
    const { call, seen } = scripted(`好的：${JSON.stringify({ name: '林昭', state: '左臂受伤，藏在后院', role: 'protagonist', note: '无' })}`);
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.calls, 1);
    assert.equal(r.value.note, '');
    assert.equal(JSON.parse(r.json).state, '左臂受伤，藏在后院');
    assert.equal(seen[0].label, '角色状态转写成 JSON');
    assert.ok(seen[0].messages[0].content.includes('格式转写员'));
    assert.ok(seen[0].messages[1].content.includes('【合同】') && seen[0].messages[1].content.includes('【原文】\n## 林昭'));
  });

  test('改了字：重转一次，说清哪几处；第二次照抄就收下', async () => {
    const { call, seen } = scripted(JSON.stringify({ name: '林昭', state: '左臂重伤，躲在柴房' }), GOOD);
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.calls, 2);
    assert.ok(seen[1].messages[1].content.includes('【上次转写不合格】这几处不是原文里的字：「左臂重伤，躲在柴房」'), seen[1].messages[1].content);
    assert.deepEqual(r.notes, ['角色状态转写不合格（这几处不是原文里的字：「左臂重伤，躲在柴房」），重转一次']);
  });

  test('解码不过、被截断：重转一次，还不过交回原因与两条说明', async () => {
    const { call } = scripted({ text: '{"name":"林昭"', stop: 'maxTokens' }, JSON.stringify({ name: '林昭' }));
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.deepEqual([r.ok, r.failed, r.calls, r.message], [false, false, 2, '缺 name 或 state']);
    assert.deepEqual(r.notes, ['角色状态转写不合格（转写被输出上限截断），重转一次', '角色状态重转仍不合格（缺 name 或 state）']);
  });

  test('retries: 0 只转一次', async () => {
    const { call } = scripted('不是 JSON');
    const r = await T.transcribeJson(SOURCE, spec({ retries: 0 }), call);
    assert.deepEqual([r.ok, r.calls], [false, 1]);
  });

  test('转写调用失败：不往外抛，交回 failed；取消照旧往外抛', async () => {
    const failed = await T.transcribeJson(SOURCE, spec(), scripted(new Error('429 限流')).call);
    assert.deepEqual([failed.ok, failed.failed, failed.calls], [false, true, 1]);
    assert.ok(failed.message.startsWith('转写调用失败（'), failed.message);
    await assert.rejects(T.transcribeJson(SOURCE, spec(), scripted(new P.CancelledError()).call), (e) => e instanceof P.CancelledError);
  });
});
