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

  // 正文里混进作者的笔记（「反派在此处需要透露……」）时，模型会把称谓填进 name、真名塞进别名。
  describe('剧作称谓', () => {
    let labeled;

    before(() => {
      labeled = ch.parseCharacterResponse(
        JSON.stringify([
          { name: '反派', aliases: ['韩厉', '头领'], tags: ['配角'] },
          { name: '林昭', aliases: ['主角', '阿昭'] },
          { name: '主角', aliases: [] },
        ])
      );
    });

    test('称谓当名字的换成别名里的真名，称谓挪进 tags', () => {
      assert.deepEqual(
        { name: labeled[0].name, aliases: labeled[0].aliases, tags: labeled[0].tags },
        { name: '韩厉', aliases: ['头领'], tags: ['配角', '反派'] }
      );
    });

    test('别名里的称谓被剔掉', () => {
      assert.deepEqual(labeled[1].aliases, ['阿昭']);
    });

    test('光一个称谓、没有真名的不建卡', () => {
      assert.deepEqual(labeled.map((c) => c.name), ['韩厉', '林昭']);
    });
  });
});

describe('characters.ts · mergeWithinBatch', () => {
  let ch;

  before(() => {
    ch = loadModule('src/core/features/characters.ts');
  });

  test('同名的两条并成一条：别名标签取并集，小节先到先得、空的用后一条补', () => {
    const merged = ch.mergeWithinBatch(
      ch.parseCharacterResponse(
        JSON.stringify([
          { name: '韩厉', aliases: [], tags: ['反派'], 身份: '黑风寨寨主' },
          { name: '反派', aliases: ['韩厉', '头领'], 身份: '黑风寨头领', 性格: '多疑', 性别: '男' },
        ])
      )
    );
    assert.equal(merged.length, 1);
    assert.deepEqual(
      { aliases: merged[0].aliases, tags: merged[0].tags, gender: merged[0].gender },
      { aliases: ['头领'], tags: ['反派'], gender: '男' }
    );
    assert.equal(merged[0].sections.身份, '黑风寨寨主');
    assert.equal(merged[0].sections.性格, '多疑');
  });

  // 模型把两个人列成两条，就是认为他们是两个人；那条别名才是错的（方源的卡挂过孪生弟弟「方正」）。
  test('别名是同一批另一条的正式名：去掉别名，两个人都留着', () => {
    const merged = ch.mergeWithinBatch(
      ch.parseCharacterResponse(JSON.stringify([{ name: '方源', aliases: ['方正', '古月方源'] }, { name: '方正', aliases: [] }]))
    );
    assert.deepEqual(
      merged.map((c) => [c.name, c.aliases]),
      [
        ['方源', ['古月方源']],
        ['方正', []],
      ]
    );
  });
});
