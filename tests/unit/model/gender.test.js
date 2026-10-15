/**
 * 角色卡的「性别」（frontmatter 的 `gender`）：同义写法收口、空话当没写、卡上写了的不让模型改，
 * 以及装配时跟着名字进上下文——写正文的模型不用再拿名字猜。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const G = loadModule('src/core/model/gender.ts');
const R = loadModule('src/core/context/layers/render.ts');

const card = (over = {}) => ({
  slug: '陆清河',
  relPath: '.novelforge/characters/陆清河.md',
  name: '陆清河',
  aliases: [],
  tags: ['配角'],
  appearsIn: [],
  body: '',
  sections: { 身份: '散修阵法师', 外貌: '', 性格: '', 语言习惯: '', 人物关系: '', 当前状态: '在溶洞疗伤', 未收伏笔: '' },
  ...over,
});

describe('gender.ts · 规范写法', () => {
  test('同义写法收成「男」「女」', () => {
    for (const v of ['男', '男性', 'male', 'M', ' man ']) {
      assert.equal(G.normalizeGender(v), '男', v);
    }
    for (const v of ['女', '女性', 'Female', 'f', 'woman']) {
      assert.equal(G.normalizeGender(v), '女', v);
    }
  });

  test('空、「未知」「不详」与非字符串当没写', () => {
    for (const v of ['', '  ', '未知', '不详', '无', 'unknown', undefined, 1, ['女']]) {
      assert.equal(G.normalizeGender(v), undefined, String(v));
    }
  });

  test('认不出的照原样留着，截到 8 个字', () => {
    assert.equal(G.normalizeGender('无性别'), '无性别');
    assert.equal(G.normalizeGender('一二三四五六七八九十'), '一二三四五六七八');
  });

  test('卡上写了的不动，没写才用新给的', () => {
    assert.equal(G.keepGender('女', '男'), '女');
    assert.equal(G.keepGender(undefined, 'female'), '女');
    assert.equal(G.keepGender(undefined, '未知'), undefined);
  });
});

describe('render.ts · 性别跟着名字进上下文', () => {
  test('完整角色卡与只带三节的精简版，抬头都带性别与别名', () => {
    const c = card({ gender: '女', aliases: ['清河'] });
    assert.ok(R.renderCharacter(c, false).startsWith('【陆清河（女；又称 清河）】'), R.renderCharacter(c, false));
    assert.ok(R.renderCharacter(c, true).startsWith('【陆清河（女；又称 清河）】'));
    assert.ok(R.renderCharacter(card({ gender: '女' }), true).startsWith('【陆清河（女）】'));
  });

  test('没写性别、没有别名：与从前一样只有名字', () => {
    assert.ok(R.renderCharacter(card(), false).startsWith('【陆清河】'));
    assert.ok(R.renderCharacter(card({ aliases: ['清河'] }), false).startsWith('【陆清河（又称 清河）】'));
  });

  test('角色图谱一览：名字后面是性别与别名，再是定位', () => {
    assert.ok(R.renderRosterLine(card({ gender: '女' })).startsWith('- 陆清河（女）［配角］'));
    assert.ok(R.renderRosterLine(card()).startsWith('- 陆清河［配角］'));
  });
});
