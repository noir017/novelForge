/**
 * 「复制完整上下文」的纯函数一半：会话文件里那份完整消息怎么认、拼出来的文字长什么样，
 * 以及 `serializeTurn` 只带标记不带正文。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 消息正文原样，按发送顺序、角色名隔开 | 这份东西是拿去核对「当时到底发了什么」的，改一个字就不可信 |
 * | 头一行写估算 token、详细度、几条消息 | 贴到别处之后还认得出是哪一级、多大的一份 |
 * | 调了几次模型的写明只是第一次那一份 | 续写那几轮另行装配，不说的话会以为续写也是这一份 |
 * | 手改坏了就当没有 | 不拼半份冒充全份（第 1 条：不抛） |
 * | `serializeTurn` 只给 `fullContext`，不带消息 | 一轮几万字，随每次推会话来回搬是纯浪费 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { contextMessagesOf, renderContextText } = loadModule('src/core/model/session.ts');
const { serializeTurn } = loadModule('src/core/controller/serialize.ts');

const messages = [
  { role: 'system', content: '你是作者。\n\n# 全局要求（每一章都要遵守）\n不写现代词。' },
  { role: 'user', content: '上一轮的要求' },
  { role: 'assistant', content: '上一轮的回答' },
  { role: 'user', content: '# 本章细纲\n林昭夜入青云。' },
];

const assistant = (extra) => Object.assign({ id: 'a1', role: 'assistant', content: '正文', at: 'x' }, extra);

const digest = { usedTokens: 1234, budget: 100000, clamped: false, detail: 3, items: [] };

describe('拼出来的完整上下文', () => {
  const text = renderContextText(assistant({ context: digest, contextMessages: messages }));

  test('头一行：估算 token、详细度、几条消息', () => {
    assert.equal(text.split('\n')[0], '【完整上下文】估算 1234 / 100000 token · 详细度：详细 · 4 条消息');
  });

  test('每条消息原样、按顺序，前面一行角色名', () => {
    const body = text.split('\n').slice(1).join('\n');
    const expected = messages.map((m) => `\n━━━━━━━━ ${m.role} ━━━━━━━━\n${m.content}`).join('\n');
    assert.equal(body, expected);
  });

  test('只调了一次就不说「第一次」', () => {
    assert.doesNotMatch(text, /第一次调用/);
  });

  test('调了几次的写明这是第一次那一份', () => {
    const multi = renderContextText(
      assistant({ context: digest, contextMessages: messages, artifact: { where: 'x', summary: 'y', overwrites: false, calls: 3 } })
    );
    assert.match(multi.split('\n')[1], /一共调了 3 次模型，下面是第一次调用发出去的那一份/);
  });

  test('没有装配清单（不该有，但会话可能被手改）也拼得出来', () => {
    assert.match(renderContextText(assistant({ contextMessages: messages })), /^【完整上下文】4 条消息\n/);
  });
});

describe('认不出就当没有', () => {
  test('没有这个字段（功能加上之前的回复）', () => {
    assert.equal(renderContextText(assistant({ context: digest })), undefined);
  });

  test('空数组', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: [] })), undefined);
  });

  test('不是数组', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: '一段字' })), undefined);
  });

  test('有一条角色认不出或正文不是字符串，整份不认', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: [...messages, { role: 'tool', content: 'x' }] })), undefined);
    assert.equal(contextMessagesOf(assistant({ contextMessages: [...messages, { role: 'user' }] })), undefined);
    assert.equal(contextMessagesOf(assistant({ contextMessages: [null] })), undefined);
  });
});

describe('serializeTurn：只带标记，不带正文', () => {
  test('留着完整消息的标 fullContext', () => {
    const out = serializeTurn(assistant({ context: digest, contextMessages: messages }));
    assert.equal(out.fullContext, true);
    assert.equal(out.contextMessages, undefined);
    assert.doesNotMatch(JSON.stringify(out), /林昭夜入青云/);
  });

  test('没留下（或认不出）的不标', () => {
    assert.equal(serializeTurn(assistant({ context: digest })).fullContext, undefined);
    assert.equal(serializeTurn(assistant({ context: digest, contextMessages: [{ role: 'x' }] })).fullContext, undefined);
  });
});
