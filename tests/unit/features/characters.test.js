/**
 * 角色 JSON 解析的容错。迁自 scripts/smoke.js 的
 * `== characters.ts · parseCharacterResponse ==` 一节。
 *
 * 容错优先：解析失败退化为忽略（空数组），绝不抛崩。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const JSON_REPLY = JSON.stringify([
  { name: '林昭', aliases: ['阿昭'], tags: ['主角'], 身份: '幸存者', 语言习惯: '答话极短', 当前状态: '客栈中' },
  { name: '沈氏', aliases: [], tags: ['配角'], 人物关系: ['与林昭：试探', '与掌柜：未知'] },
]);

describe('characters.ts · parseCharacterResponse', () => {
  let ch;
  let cards;

  before(() => {
    ch = loadModule('src/core/features/characters.ts');
    cards = ch.parseCharacterResponse(JSON_REPLY);
  });

  test('解析出两个角色', () => {
    assert.equal(cards.length, 2);
  });

  test('保留 aliases', () => {
    assert.equal(cards[0].aliases[0], '阿昭');
  });

  test('映射小节字段', () => {
    assert.equal(cards[0].sections.身份, '幸存者');
    assert.equal(cards[0].sections.语言习惯, '答话极短');
  });

  test('未提供的小节为空串', () => {
    assert.equal(cards[0].sections.外貌, '');
  });

  test('数组字段转为列表', () => {
    assert.equal(cards[1].sections.人物关系, '- 与林昭：试探\n- 与掌柜：未知');
  });

  describe('容错', () => {
    test('代码块包裹的 JSON', () => {
      assert.equal(ch.parseCharacterResponse('```json\n' + JSON_REPLY + '\n```').length, 2);
    });

    test('前后有废话的 JSON', () => {
      assert.equal(ch.parseCharacterResponse('好的：\n' + JSON_REPLY + '\n以上。').length, 2);
    });

    test('非 JSON 返回空数组', () => {
      assert.equal(ch.parseCharacterResponse('我无法完成').length, 0);
    });

    test('坏 JSON 返回空数组而非抛错', () => {
      assert.equal(ch.parseCharacterResponse('[{name: 缺引号}]').length, 0);
    });

    test('无 name 的条目被丢弃', () => {
      assert.equal(ch.parseCharacterResponse('[{"身份":"x"}]').length, 0);
    });

    test('字符串形式的 aliases 被拆分', () => {
      assert.equal(ch.parseCharacterResponse('[{"name":"甲","aliases":"a、b"}]')[0].aliases.length, 2);
    });
  });
});
