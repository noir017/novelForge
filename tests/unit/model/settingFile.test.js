/**
 * 架构层三份文档（model/settingFile.ts）：小说配置、故事前提、世界观。
 *
 * 守的是三件事：作者手改 frontmatter 不崩（第 1 条）；模板里的占位不算「填过」
 * （否则主按钮从第一天起就跳过配置）；渲染再解析回来一字不差。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let S;
before(() => {
  S = loadModule('src/core/model/settingFile.ts');
});

const CONFIG = [
  '---',
  'genre: 玄幻',
  'subGenre: 东方玄幻',
  'audience: 男频',
  'structure: three_act',
  'pov: third_limited',
  'totalChapters: 100',
  'wordsPerChapter: 3000',
  '---',
  '# 小说配置',
  '',
  '## 一句话',
  '少年夜渡青河。',
  '',
  '## 核心梗概',
  '林昭在青河翻船后得到一枚玉佩。',
].join('\n');

describe('parseBookConfig', () => {
  test('frontmatter 各字段', () => {
    const c = S.parseBookConfig(CONFIG, '.novelforge/config.md');
    assert.equal(c.genre, '玄幻');
    assert.equal(c.subGenre, '东方玄幻');
    assert.equal(c.audience, '男频');
    assert.equal(c.structure, 'three_act');
    assert.equal(c.pov, 'third_limited');
    assert.equal(c.totalChapters, 100);
    assert.equal(c.wordsPerChapter, 3000);
  });

  test('小节按固定表抽取，缺的是空串', () => {
    const c = S.parseBookConfig(CONFIG, '.novelforge/config.md');
    assert.equal(c.sections.一句话, '少年夜渡青河。');
    assert.equal(c.sections.核心梗概, '林昭在青河翻船后得到一枚玉佩。');
    assert.equal(c.sections.金手指, '');
  });

  test('枚举写中文标签也认', () => {
    const c = S.parseBookConfig('---\nstructure: 起承转合\npov: 第一人称\n---\n', 'x');
    assert.equal(c.structure, 'kishotenketsu');
    assert.equal(c.pov, 'first_person');
  });

  test('认不出的枚举、写坏的数字一律退化成缺席', () => {
    const c = S.parseBookConfig(
      '---\nstructure: 随便写\npov: 上帝视角\ntotalChapters: 一百\nwordsPerChapter: -5\n---\n',
      'x'
    );
    assert.equal(c.structure, undefined);
    assert.equal(c.pov, undefined);
    assert.equal(c.totalChapters, undefined);
    assert.equal(c.wordsPerChapter, undefined);
  });

  test('小数与 0 不算合法章数', () => {
    const c = S.parseBookConfig('---\ntotalChapters: 0\nwordsPerChapter: 2500.5\n---\n', 'x');
    assert.equal(c.totalChapters, undefined);
    assert.equal(c.wordsPerChapter, undefined);
  });

  test('整份不是 Markdown 也不抛', () => {
    const c = S.parseBookConfig('就一句大白话', 'x');
    assert.equal(c.genre, '');
    assert.equal(c.sections.核心梗概, '');
  });
});

describe('renderBookConfig 往返', () => {
  test('渲染再解析，字段与小节一致', () => {
    const c = S.parseBookConfig(CONFIG, 'x');
    const again = S.parseBookConfig(S.renderBookConfig(c), 'x');
    for (const k of ['genre', 'subGenre', 'audience', 'structure', 'pov', 'totalChapters', 'wordsPerChapter']) {
      assert.equal(again[k], c[k], k);
    }
    assert.deepEqual(again.sections, c.sections);
  });

  test('空字符串字段也写出键（这是给人填的表）', () => {
    const text = S.settingTemplate('config');
    assert.match(text, /^genre: *$/m);
    assert.match(text, /^audience: *$/m);
  });
});

describe('前提 / 世界观', () => {
  test('按各自的小节表抽取', () => {
    const p = S.parseSettingDoc('premise', '## 核心冲突链\n甲→乙→丙', 'x');
    assert.equal(p.sections.核心冲突链, '甲→乙→丙');
    assert.equal(p.sections.悬念骨架, '');
    const w = S.parseSettingDoc('world', '## 深层危机\n灵脉将枯', 'x');
    assert.equal(w.sections.深层危机, '灵脉将枯');
  });

  test('renderSettingDoc 往返', () => {
    const sections = { 一句话前提: '当少年遭遇翻船，必须活下来否则家族覆灭', 核心冲突链: '甲', 金手指定位: '', 悬念骨架: '乙' };
    const text = S.renderSettingDoc('premise', sections);
    assert.deepEqual(S.parseSettingDoc('premise', text, 'x').sections, sections);
  });
});

describe('isSettingFilled', () => {
  test('三份模板都不算填过', () => {
    for (const doc of S.SETTING_FILE_DOCS) {
      const parsed = S.parseSettingDoc(doc, S.settingTemplate(doc), 'x');
      assert.equal(S.isSettingFilled(doc, parsed.sections), false, doc);
    }
  });

  test('配置只写了「一句话」不算填过；有「核心梗概」才算', () => {
    assert.equal(S.isSettingFilled('config', { 一句话: '少年夜渡青河' }), false);
    assert.equal(S.isSettingFilled('config', { 核心梗概: '展开了' }), true);
  });

  test('前提看冲突链', () => {
    assert.equal(S.isSettingFilled('premise', { 一句话前提: '只有标题' }), false);
    assert.equal(S.isSettingFilled('premise', { 核心冲突链: '甲→乙' }), true);
  });

  test('世界观任意一节有内容就算', () => {
    assert.equal(S.isSettingFilled('world', { 阶层与资源: '九品' }), true);
  });

  test('占位文字不算内容', () => {
    assert.equal(S.isSettingFilled('config', { 核心梗概: '（待补充）' }), false);
    assert.equal(S.isSettingFilled('config', { 核心梗概: '(待补充)' }), false);
  });

  // 不然「金手指：（待补充）」会被当成内容一路送进 prompt。
  test('解析时占位文字读回来就是空串', () => {
    const c = S.parseBookConfig(S.settingTemplate('config'), 'x');
    assert.ok(Object.values(c.sections).every((v) => v === ''), JSON.stringify(c.sections));
  });
});
