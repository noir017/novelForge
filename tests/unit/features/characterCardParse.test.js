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
});
