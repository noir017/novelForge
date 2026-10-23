/**
 * 「复制完整上下文」的纯函数一半：会话文件里那份完整消息怎么认、拼出来的文字长什么样，
 * 以及 `serializeTurn` 只带标记不带正文。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只有消息本身，不写估算 token、详细度、几条消息、调了几次 | 拿去粘进网页版 AI 接着做，多一行说明模型就当成要求 |
 * | 消息正文原样，按发送顺序、`---` 隔开 | 改一个字就不是当时那一轮了 |
 * | 带了历史才标【我】/【你】，系统提示不标 | 网页 AI 得分得清哪段是它自己上一轮说的；只有一问时标了是多余的字 |
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
  test('只有一问：系统提示与这一轮的话原样相接，什么都不加', () => {
    const text = renderContextText(assistant({ context: digest, contextMessages: [messages[0], messages[3]] }));
    assert.equal(text, `${messages[0].content}\n\n---\n\n${messages[3].content}`);
  });

  test('带了历史：系统提示不标，其余每条前面标【我】/【你】，正文原样、按顺序', () => {
    const text = renderContextText(assistant({ context: digest, contextMessages: messages }));
    assert.equal(
      text,
      [
        messages[0].content,
        `【我】\n${messages[1].content}`,
        `【你】\n${messages[2].content}`,
        `【我】\n${messages[3].content}`,
      ].join('\n\n---\n\n')
    );
  });

  test('不写估算 token、详细度、几条消息，调了几次模型也不说', () => {
    const multi = renderContextText(
      assistant({ context: digest, contextMessages: messages, artifact: { where: 'x', summary: 'y', overwrites: false, calls: 3 } })
    );
    assert.equal(multi, renderContextText(assistant({ contextMessages: messages })));
    assert.doesNotMatch(multi, /完整上下文|token|详细度|条消息|调了|system|assistant/);
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
