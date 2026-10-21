/**
 * 不走链的产物（大纲等）写完查一遍：截断、没写到本批最后一章、缺了哪几章、出现了不认的区间标题
 * （大纲一章一条，docs/design/plans/2026-10-21-outline-per-chapter.md）。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');
const { outlineOf } = require('../../helpers/outline');

const s = loadModule('src/core/generation/structured.ts');

describe('singleShotNotes · 大纲', () => {
  test('一章一条、写满本批：不说', () => {
    const notes = s.singleShotNotes('outline', outlineOf(10), 'end', { from: 1, to: 10 });
    assert.deepEqual(notes, []);
  });

  test('区间标题：说不认，点出有几个', () => {
    const notes = s.singleShotNotes('outline', '## 第1–3章：甲\n一\n\n## 第4–20章：乙\n二\n', 'end', { from: 1, to: 20 });
    assert.ok(notes.some((n) => /有 2 个「## 第a–b章」这样的区间标题/.test(n)), JSON.stringify(notes));
    assert.ok(notes.some((n) => /认不出「## 第N章：标题」这样的章标题/.test(n)), JSON.stringify(notes));
  });

  test('只写到第 N 章：说写到哪、主按钮会接着推续写', () => {
    const notes = s.singleShotNotes('outline', outlineOf(15), 'end', { from: 1, to: 20 });
    assert.ok(notes.some((n) => /产出只写到第 15 章（这一批要写到第 20 章）/.test(n)), JSON.stringify(notes));
  });

  test('中间缺了几章：点名缺第几章', () => {
    const raw = outlineOf(10).replace('## 第4章\n第4章的事。\n\n', '').replace('## 第7章\n第7章的事。\n\n', '');
    const notes = s.singleShotNotes('outline', raw, 'end', { from: 1, to: 10 });
    assert.ok(notes.some((n) => /缺第 4、7 章/.test(n)), JSON.stringify(notes));
  });
});
