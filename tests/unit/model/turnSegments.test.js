/**
 * 一轮 assistant 排下来的段（`serializeTurn` 的那一半）。
 *
 * 界面**只认 `segments`**：文字块、工具条、generate 卡按数组顺序画。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 有 segments | 原样带过去，不动它 |
 * | 没调工具 | **没有段**：一块正文就是全部，那一轮照旧可就地编辑 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { serializeTurn } = loadModule('src/core/controller/serialize.ts');

const call = (callId, name, extra) =>
  Object.assign({ callId, name, title: name, ok: true, summary: '摘要', elapsedMs: 1 }, extra);

const assistant = (extra) =>
  serializeTurn(Object.assign({ id: 'a1', role: 'assistant', content: '', at: 'x' }, extra));

describe('段：新会话原样带过去', () => {
  const segments = [
    { kind: 'tool', call: call('c1', 'read') },
    { kind: 'text', text: '我先看看。' },
    { kind: 'tool', call: call('c2', 'generate', { output: '### 全书结构' }) },
    { kind: 'text', text: '写好了。' },
  ];

  test('顺序与内容一个字都不动', () => {
    assert.deepEqual(assistant({ content: '我先看看。\n\n写好了。', segments }).segments, segments);
  });

  // 那几千字是产物本身，回放时要画在卡里；从前它根本没进会话，刷新就没了。
  test('generate 产出的正文跟着段走', () => {
    const out = assistant({ segments }).segments[2];
    assert.equal(out.call.output, '### 全书结构');
  });
});

describe('段：没调工具时没有段', () => {
  test('assistant 一块正文', () => {
    assert.equal(assistant({ content: '好的。' }).segments, undefined);
  });

  test('user 那一支也没有', () => {
    const turn = serializeTurn({ id: 'u1', role: 'user', content: '写一段', at: 'x' });
    assert.equal(turn.segments, undefined);
  });
});
