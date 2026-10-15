const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('characterCardParse.ts · parseCardResponse', () => {
  test('解析性格并过滤泛称别名', () => {
    const { parseCardResponse } = loadModule('src/core/features/characterCardParse.ts');
    const parsed = parseCardResponse(
      JSON.stringify({
        aliases: ['阿昭', '姐姐'],
        性格: '沉默寡言，遇事先观察。',
      })
    );

    assert.equal(parsed.sections.性格, '沉默寡言，遇事先观察。');
    assert.deepEqual(parsed.aliases, ['阿昭']);
  });

  test('性别规范成「男」「女」；看不出就没有', () => {
    const { parseCardResponse } = loadModule('src/core/features/characterCardParse.ts');
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '女性', 性格: '冷' })).gender, '女');
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '', 性格: '冷' })).gender, undefined);
    // 只给了性别、七节全空：照旧算没解出东西，不拿一张空卡去烦作者。
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '男' })), undefined);
  });
});
