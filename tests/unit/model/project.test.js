/**
 * `cast` 字段的序列化往返与小节文本反解。
 * 迁自 scripts/smoke.js 的 `== castParse.ts · 出场人物字段 ==` 一节。
 *
 * 摘要是出场人物的唯一真相：frontmatter 里的 `林昭(阿昭、昭儿)` 与结构化条目
 * 必须互为逆运算，否则「谁是谁」会在一次读写之间漂移。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('castParse.ts · 出场人物字段', () => {
  let p;
  before(() => {
    p = loadModule('src/core/model/castParse.ts');
  });

  describe('parseCastEntry / renderCastEntry', () => {
    test('解析带别名的 cast 条目', () => {
      const entry = p.parseCastEntry('林昭(阿昭、昭儿)');
      assert.equal(entry.name, '林昭', JSON.stringify(entry));
      assert.equal(entry.aliases.length, 2, JSON.stringify(entry));
    });

    test('解析无别名的 cast 条目', () => {
      assert.equal(p.parseCastEntry('沈氏').aliases.length, 0);
    });

    test('全角括号也认', () => {
      assert.equal(p.parseCastEntry('林昭（阿昭）').name, '林昭');
    });

    test('渲染带别名', () => {
      assert.equal(p.renderCastEntry({ name: '林昭', aliases: ['阿昭'] }), '林昭(阿昭)');
    });

    test('渲染无别名不加括号', () => {
      assert.equal(p.renderCastEntry({ name: '沈氏', aliases: [] }), '沈氏');
    });

    test('渲染时别名与名字相同则丢弃', () => {
      assert.equal(p.renderCastEntry({ name: '沈氏', aliases: ['沈氏'] }), '沈氏');
    });

    test('cast 条目序列化往返', () => {
      const round = p.parseCastEntry(p.renderCastEntry({ name: '林昭', aliases: ['阿昭', '昭儿'] }));
      assert.equal(round.name, '林昭');
      assert.equal(round.aliases.join('、'), '阿昭、昭儿');
    });
  });

  describe('castFromText（旧摘要与手写摘要走这条）', () => {
    test('文本反解顿号分隔', () => {
      assert.equal(p.castFromText('林昭、沈氏、客栈掌柜').length, 3);
    });

    test('文本反解列表写法', () => {
      assert.equal(p.castFromText('- 林昭\n- 沈氏').length, 2);
    });

    test('文本反解去重', () => {
      assert.equal(p.castFromText('林昭、林昭').length, 1);
    });

    test('文本反解跳过「无」', () => {
      assert.equal(p.castFromText('无').length, 0);
    });

    test('文本反解跳过整段描述', () => {
      assert.equal(p.castFromText('本章没有新人物出场，只有林昭一人在客栈中独坐').length, 0);
    });
  });
});
