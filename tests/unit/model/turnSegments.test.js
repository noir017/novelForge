/**
 * 一轮 assistant 排下来的段（`serializeTurn` 的那一半）。
 *
 * 界面**只认 `segments`**：文字块、工具条、generate 卡按数组顺序画。写段的只有 MCP 那条路，
 * 而且一定标 `mcp`；有段却没标的，是已经移除的内置 agent 留下的旧轮次，要标出来给界面认。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 有 segments | 原样带过去，不动它 |
 * | 普通一问一答 | **没有段**：一块正文就是全部，那一轮照旧可就地编辑 |
 * | 有段、没标 mcp | 标 `builtinAgent`；MCP 气泡与普通回答都不标 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { serializeTurn } = loadModule('src/core/controller/serialize.ts');

const call = (callId, name, extra) =>
  Object.assign({ callId, name, title: name, ok: true, summary: '摘要', elapsedMs: 1 }, extra);

const assistant = (extra) =>
  serializeTurn(Object.assign({ id: 'a1', role: 'assistant', content: '', at: 'x' }, extra));

const segments = [
  { kind: 'tool', call: call('c1', 'read') },
  { kind: 'text', text: '我先看看。' },
  { kind: 'tool', call: call('c2', 'generate', { output: '### 全书结构' }) },
  { kind: 'text', text: '写好了。' },
];

describe('段：原样带过去', () => {
  test('顺序与内容一个字都不动', () => {
    assert.deepEqual(assistant({ content: '我先看看。\n\n写好了。', segments, mcp: true }).segments, segments);
  });

  // 那几千字是产物本身，回放时要画在卡里。
  test('generate 产出的正文跟着段走', () => {
    const out = assistant({ segments, mcp: true }).segments[2];
    assert.equal(out.call.output, '### 全书结构');
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

describe('已经移除的内置 agent 留下的轮次', () => {
  test('有段、没标 mcp 的标成 builtinAgent，段照旧带', () => {
    const turn = assistant({ content: '我先看看。\n\n写好了。', segments });
    assert.equal(turn.builtinAgent, true);
    assert.equal(turn.mcp, undefined);
    assert.deepEqual(turn.segments, segments);
  });

  test('MCP 的气泡不标', () => {
    assert.equal(assistant({ segments, mcp: true }).builtinAgent, undefined);
  });

  test('普通回答与空段都不标', () => {
    assert.equal(assistant({ content: '好的。' }).builtinAgent, undefined);
    assert.equal(assistant({ content: '好的。', segments: [] }).builtinAgent, undefined);
  });
});
