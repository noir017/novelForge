/**
 * 一轮 assistant 排下来的段（`serializeTurn` 的那一半）。
 *
 * 界面**只认 `segments`**：文字块、工具条、generate 卡按数组顺序画。老会话文件
 * 里还是改成段之前的形状（`content` 一整块 + `toolCalls` 一整串），所以归一必须在
 * 这里做完——放到前端去做等于让界面长期认两种形状，而第二种迟早会走偏。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 新会话（有 segments） | 原样带过去，不动它 |
 * | 老会话（只有 toolCalls） | 拼成「工具们 + 正文」，正是旧界面的顺序 |
 * | 老会话但没说话 | 只有工具段，不补一段空文字（界面会画出一个空盒子） |
 * | 普通一问一答 | **没有段**：一块正文就是全部，那一轮照旧可就地编辑 |
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

describe('段：老会话归一一次', () => {
  test('拼成「工具们 + 正文」，正是旧界面的顺序', () => {
    const turn = assistant({
      content: '排好了。',
      toolCalls: [call('c1', 'read'), call('c2', 'generate')],
    });
    assert.deepEqual(
      turn.segments.map((seg) => (seg.kind === 'text' ? `文字:${seg.text}` : `工具:${seg.call.callId}`)),
      ['工具:c1', '工具:c2', '文字:排好了。']
    );
  });

  // 归一之后就不该再有第二种形状流到前端去。
  test('归一之后不再带着 toolCalls', () => {
    const turn = assistant({ content: '排好了。', toolCalls: [call('c1', 'read')] });
    assert.equal(turn.toolCalls, undefined, JSON.stringify(turn));
  });

  // 一段空文字在界面上是一个空盒子。
  test('那一轮没说话时不补空的文字段', () => {
    const turn = assistant({ content: '', toolCalls: [call('c1', 'read')] });
    assert.equal(turn.segments.length, 1);
    assert.equal(turn.segments[0].kind, 'tool');
  });
});

describe('段：普通一问一答没有段', () => {
  test('assistant 一块正文', () => {
    assert.equal(assistant({ content: '好的。' }).segments, undefined);
  });

  test('user 那一支也没有', () => {
    const turn = serializeTurn({ id: 'u1', role: 'user', content: '写一段', at: 'x' });
    assert.equal(turn.segments, undefined);
  });
});
