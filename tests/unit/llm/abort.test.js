/**
 * makeAbortSignal 的空闲超时：timeoutMs 是「多久没收到数据」，
 * 不是整段请求的上限。流式还在 poke 时不应 abort。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('llm/makeAbortSignal', () => {
  let makeAbortSignal;

  before(() => {
    ({ makeAbortSignal } = loadModule('src/core/llm/provider.ts'));
  });

  test('无 poke 则到期 abort', async () => {
    const { signal, dispose } = makeAbortSignal({ timeoutMs: 40 });
    await wait(80);
    assert.equal(signal.aborted, true);
    dispose();
  });

  test('持续 poke 则不 abort', async () => {
    const { signal, dispose, poke } = makeAbortSignal({ timeoutMs: 60 });
    const t = setInterval(poke, 20);
    await wait(180);
    clearInterval(t);
    assert.equal(signal.aborted, false);
    dispose();
  });

  test('停止 poke 之后才 abort', async () => {
    const { signal, dispose, poke } = makeAbortSignal({ timeoutMs: 50 });
    poke();
    await wait(20);
    poke();
    await wait(20);
    assert.equal(signal.aborted, false);
    await wait(80);
    assert.equal(signal.aborted, true);
    dispose();
  });

  test('dispose 之后不再 abort', async () => {
    const { signal, dispose } = makeAbortSignal({ timeoutMs: 30 });
    dispose();
    await wait(60);
    assert.equal(signal.aborted, false);
  });
});
