/**
 * 假模型本身：应答可以带收尾原因、思考、分片。
 *
 * 续写（三期）要靠 `stop: 'maxTokens'` 区分「被截断」与「说完了」，重演检测
 * 要靠 `filler` 造出互不重样的正文——这两样要是悄悄坏了，后面那批测试会
 * 以一种很难查的方式全绿或全红。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');

/** 不载 bundle：registry 只要能收下 factory 就够。 */
function providerWith(opts) {
  const registry = { registerProviderFactory(f) { this.factory = f; } };
  const fake = installFakeProvider(registry, opts);
  return { fake, provider: registry.factory({ ref: 'fake/m' }) };
}

async function collect(provider) {
  const events = [];
  for await (const ev of provider.stream([{ role: 'user', content: '写' }], { maxOutputTokens: 100 })) {
    events.push(ev);
  }
  return events;
}

describe('假模型的应答形状', () => {
  test('纯字符串照旧只发一条 text，不发 stop', async () => {
    const { provider } = providerWith({ replies: ['一段正文'] });
    const events = await collect(provider);
    assert.deepEqual(events, [{ type: 'text', text: '一段正文' }]);
  });

  test('对象应答在正文之后发 stop', async () => {
    const { provider } = providerWith({ replies: [{ text: '写到一半', stop: 'maxTokens' }] });
    const events = await collect(provider);
    assert.deepEqual(events.at(-1), { type: 'stop', reason: 'maxTokens' });
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), '写到一半');
  });

  test('思考先于正文', async () => {
    const { provider } = providerWith({ replies: [{ reasoning: '先想想', text: '正文', stop: 'end' }] });
    const types = (await collect(provider)).map((e) => e.type);
    assert.deepEqual(types, ['reasoning', 'text', 'stop']);
  });

  test('chunks 把正文切成几片，拼回去一字不差', async () => {
    const text = filler(100, 1);
    const { provider } = providerWith({ replies: [{ text, chunks: 4 }] });
    const parts = (await collect(provider)).filter((e) => e.type === 'text');
    assert.equal(parts.length, 4, String(parts.length));
    assert.equal(parts.map((e) => e.text).join(''), text);
  });

  test('reply 函数也可以回对象', async () => {
    const { provider, fake } = providerWith({ reply: (_m, i) => ({ text: `第${i}轮`, stop: 'end' }) });
    await collect(provider);
    const events = await collect(provider);
    assert.equal(events[0].text, '第1轮');
    assert.equal(fake.callCount(), 2);
  });
});

describe('filler', () => {
  test('恰好 n 个字', () => {
    assert.equal(filler(2345, 7).length, 2345);
  });

  test('同 seed 可复现', () => {
    assert.equal(filler(300, 3), filler(300, 3));
  });

  test('不同 seed 之间没有公共 8-gram（不会被重演检测误判）', () => {
    const grams = (s) => new Set(Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8)));
    const a = grams(filler(1200, 1));
    const shared = [...grams(filler(1200, 2))].filter((g) => a.has(g));
    assert.equal(shared.length, 0, shared.slice(0, 3).join(','));
  });
});
