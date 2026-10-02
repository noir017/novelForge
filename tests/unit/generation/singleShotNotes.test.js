/**
 * 不走链的产物（大纲等）写完查一遍：截断、没覆盖到本批最后一章、一节覆盖太多章。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const s = loadModule('src/core/generation/structured.ts');

describe('singleShotNotes · 大纲', () => {
  test('一节覆盖 5 章以上：说明里点名是哪几节', () => {
    const notes = s.singleShotNotes('outline', '## 第1–3章：甲\n一\n\n## 第4–20章：乙\n二\n', 'end', { from: 1, to: 20 });
    assert.ok(notes.some((n) => /有 1 节一节覆盖了 5 章以上（第 4–20 章）/.test(n)), JSON.stringify(notes));
  });

  test('每节都不超过 5 章：不说', () => {
    const notes = s.singleShotNotes('outline', '## 第1–5章：甲\n一\n\n## 第6–10章：乙\n二\n', 'end', { from: 1, to: 10 });
    assert.deepEqual(notes, []);
  });
});
