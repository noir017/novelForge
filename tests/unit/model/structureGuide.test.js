/**
 * 故事结构指导：六种结构按总章数切成章号区间。
 *
 * 上游（AI-Novel-Writer）只给四种算了区间，英雄之旅与节拍表只有一行占位。
 * 这里钉的是：六种都有区间，而且在任何章数下都**连续、从第 1 章起、到最后一章止**
 * ——大纲按它排结构拐点，断一截就有几章落不进任何一段。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const guide = loadModule('src/core/model/structureGuide.ts');
const setting = loadModule('src/core/model/settingFile.ts');

function assertContiguous(stages, total, label) {
  assert.equal(stages[0].from, 1, `${label}：从第 1 章起`);
  assert.equal(stages[stages.length - 1].to, total, `${label}：到第 ${total} 章止`);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    assert.ok(s.from <= s.to, `${label}：第 ${i + 1} 段 ${s.from}–${s.to}`);
    if (i > 0) {
      const prev = stages[i - 1];
      // 章数够分时首尾相接；不够分时允许相邻段共用一章，但不许跳过章。
      assert.ok(s.from === prev.to + 1 || (s.from === prev.to && s.to === prev.to), `${label}：第 ${i} / ${i + 1} 段衔接 ${prev.to} → ${s.from}`);
    }
  }
}

describe('structureGuide.ts · 六种结构的章号区间', () => {
  for (const structure of setting.PLOT_STRUCTURES) {
    for (const total of [3, 11, 20, 30, 100, 1000]) {
      test(`${structure} · ${total} 章：连续、覆盖全书`, () => {
        assertContiguous(guide.structureStages(structure, total), total, `${structure}/${total}`);
      });
    }
  }

  test('章数够分时每段至少一章，不共用', () => {
    const stages = guide.structureStages('save_the_cat', 30);
    assert.equal(stages.length, 15);
    for (let i = 1; i < stages.length; i++) {
      assert.equal(stages[i].from, stages[i - 1].to + 1);
    }
  });

  test('三幕 100 章：20 / 55 / 25（与上游的切法一致）', () => {
    const [a, b, c] = guide.structureStages('three_act', 100);
    assert.deepEqual([a.from, a.to, b.from, b.to, c.from, c.to], [1, 20, 21, 75, 76, 100]);
  });

  test('英雄之旅与节拍表都有逐段章号（修上游只有一行占位的缺口）', () => {
    const hero = guide.structureGuideText('heros_journey', 100);
    assert.match(hero, /英雄之旅/);
    assert.match(hero, /平凡世界（第 1–5 章）/);
    assert.match(hero, /携宝归来（第 93–100 章）/);
    const cat = guide.structureGuideText('save_the_cat', 100);
    assert.match(cat, /中点（第 51–52 章）/);
    assert.equal(cat.split('\n').filter((l) => l.startsWith('- ')).length, 15);
  });

  test('结构缺席按三幕算', () => {
    assert.match(guide.structureGuideText(undefined, 40), /三幕结构/);
  });

  // 分批写大纲时最常见的错：把第 1–20 章写成全书的缩略版。
  test('给了区间就点明本批落在哪几段', () => {
    const text = guide.structureGuideText('three_act', 100, { from: 1, to: 20 });
    assert.match(text, /本次只写第 1–20 章，它们落在：第一幕 · 建置（第 1–20 章）/);
    const later = guide.structureGuideText('three_act', 100, { from: 61, to: 80 });
    assert.match(later, /第二幕 · 对抗与发展（第 21–75 章）、第三幕 · 高潮与结局（第 76–100 章）/);
  });
});
