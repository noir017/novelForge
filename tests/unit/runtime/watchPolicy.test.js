/**
 * 「哪些改动值得刷新界面」这份策略。它从两个壳里收回 core 的那一刻起就该有测试：
 * 从前插件壳的 7 条 glob 与独立版的黑名单过滤各写一份，改了一处忘了另一处，
 * 表现是「某个壳里改了文件界面不动」——这种事没人会立刻联想到监听规则。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { watchGlobs, shouldIgnoreChange } = loadModule('src/core/watchPolicy.ts');

const CONFIG = { chaptersDir: 'chapters', draftsDir: 'drafts' };

describe('watchGlobs（吃 glob 的宿主）', () => {
  test('章节根有一条全量 glob——空目录的增删与非 .md 章节都靠它', () => {
    assert.ok(watchGlobs(CONFIG).includes('chapters/**'));
  });

  test('草稿目录在监听范围内（手建的草稿要让「有草稿」标记翻过来）', () => {
    assert.ok(watchGlobs(CONFIG).includes('drafts/**'));
  });

  test('跟着配置里的目录名走，不写死 chapters/drafts', () => {
    const globs = watchGlobs({ chaptersDir: '正文', draftsDir: '草稿' });
    assert.ok(globs.includes('正文/**'));
    assert.ok(globs.includes('草稿/**'));
    assert.ok(!globs.some((g) => g.startsWith('chapters/')));
  });

  test('元数据：project.json 与角色/设定两区', () => {
    const globs = watchGlobs(CONFIG);
    assert.ok(globs.includes('.novelforge/project.json'));
    assert.ok(globs.includes('.novelforge/characters/**'));
    assert.ok(globs.includes('.novelforge/lore/**'));
  });
});

describe('shouldIgnoreChange（吃事件流的宿主）', () => {
  test('放行 .md 章节', () => {
    assert.equal(shouldIgnoreChange('chapters/001-楔子.md'), false);
  });

  test('放行非 .md 的章节：.txt / 无扩展名', () => {
    assert.equal(shouldIgnoreChange('chapters/001-楔子.txt'), false);
    assert.equal(shouldIgnoreChange('chapters/001-楔子'), false);
  });

  test('放行目录事件（没有扩展名）', () => {
    assert.equal(shouldIgnoreChange('chapters/第一卷'), false);
  });

  test('挡掉二进制：图片、压缩包、办公文档', () => {
    assert.equal(shouldIgnoreChange('chapters/封面.png'), true);
    assert.equal(shouldIgnoreChange('素材.zip'), true);
    assert.equal(shouldIgnoreChange('参考.docx'), true);
  });

  test('挡掉回收站——删除是「搬进 .trash/」，不挡会多触发一轮全量重扫', () => {
    assert.equal(shouldIgnoreChange('.novelforge/.trash/chapters/003.md'), true);
  });

  test('挡掉 node_modules', () => {
    assert.equal(shouldIgnoreChange('node_modules/foo/index.js'), true);
  });

  test('空文件名不挡（fs.watch 偶尔给不出 filename，宁可多刷一次）', () => {
    assert.equal(shouldIgnoreChange(''), false);
  });

  test('大小写不敏感（Windows 上 .PNG 也该挡）', () => {
    assert.equal(shouldIgnoreChange('chapters/封面.PNG'), true);
  });
});
