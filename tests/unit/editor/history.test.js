/**
 * 内置编辑器的撤销历史（`media/src/editor/history.ts`）：纯逻辑，不碰 DOM。
 * 编辑器里的整条链路（按键、切标签、组字、菜单）在 tests/dom/standalone/undo.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 连续打字并成一步，超过 1 秒、不挨着、换类型、带换行都另起 | 撤销的粒度 |
 * | 退格往前吃、Delete 往后吃都并 | 删除同理 |
 * | `join` 并进刚记下的那一步，撤销 / 重做之后不再并 | 成对标点的后半个随前半个一起退 |
 * | 新的改动清掉重做栈 | 常规语义 |
 * | 上限 | 丢最早的，不无限增长 |
 * | 与文字对不上就整份作废 | 宁可退不回去，也不拿错位的差异改乱正文 |
 * | `diffText` 拿光标认对有歧义的位置、不切开代理对 | 差异记得准 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { EditHistory, diffText, MERGE_WINDOW_MS } = loadModule('media/src/editor/history.ts');

const caret = (n) => ({ start: n, end: n });

/** 模拟在 text 上打一下：返回新文字，并把这一下记进 h。 */
function apply(h, text, change, opts) {
  const next = text.slice(0, change.at) + change.inserted + text.slice(change.at + change.removed.length);
  h.record(change, caret(change.at + change.removed.length), caret(change.at + change.inserted.length), opts);
  return next;
}

describe('EditHistory：合并', () => {
  test('连续打字并成一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '林' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '昭' }, { merge: true, now: 300 });
    assert.equal(h.size, 1);
    assert.deepEqual(h.undo(t), { text: '', selection: caret(0) });
  });

  test('间隔超过 1 秒另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '林' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '昭' }, { merge: true, now: MERGE_WINDOW_MS + 1 });
    assert.equal(h.size, 2);
    assert.equal(h.undo(t).text, '林');
  });

  test('窗口按上一下算，不按这一步的开头算', () => {
    const h = new EditHistory();
    let t = '';
    for (let i = 0; i < 5; i++) {
      t = apply(h, t, { at: i, removed: '', inserted: '字' }, { merge: true, now: i * 900 });
    }
    assert.equal(h.size, 1);
  });

  test('位置不挨着另起一步', () => {
    const h = new EditHistory();
    let t = '甲乙';
    t = apply(h, t, { at: 2, removed: '', inserted: '丙' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 0, removed: '', inserted: '丁' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('带换行的单独一步，之后打的字也不并进来', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '\n' }, { merge: true, now: 10 });
    t = apply(h, t, { at: 2, removed: '', inserted: '乙' }, { merge: true, now: 20 });
    assert.equal(h.size, 3);
  });

  test('打字与删除不并', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲乙' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '乙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('打字盖掉选区之后接着打，并成一步', () => {
    const h = new EditHistory();
    let t = '旧词';
    t = apply(h, t, { at: 0, removed: '旧词', inserted: '新' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '的' }, { merge: true, now: 10 });
    assert.equal(t, '新的');
    assert.equal(h.size, 1);
    assert.equal(h.undo(t).text, '旧词');
  });

  test('退格往前吃、Delete 往后吃都并', () => {
    const h = new EditHistory();
    let t = '甲乙丙丁';
    t = apply(h, t, { at: 3, removed: '丁', inserted: '' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 2, removed: '丙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(h.size, 1);
    assert.equal(h.undo(t).text, '甲乙丙丁');

    const h2 = new EditHistory();
    let u = '甲乙丙丁';
    u = apply(h2, u, { at: 1, removed: '乙', inserted: '' }, { merge: true, now: 0 });
    u = apply(h2, u, { at: 1, removed: '丙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(u, '甲丁');
    assert.equal(h2.size, 1);
    assert.equal(h2.undo(u).text, '甲乙丙丁');
  });

  test('不带 merge 的（粘贴、程序改写）前后都不并', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = apply(h, t, { at: 2, removed: '', inserted: '丙' }, { merge: true, now: 20 });
    assert.equal(h.size, 3);
  });

  test('seal 之后另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    h.seal();
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('撤销之后接着打字另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = h.undo(t).text;
    t = apply(h, t, { at: 1, removed: '', inserted: '丙' }, { merge: true, now: 20 });
    assert.equal(h.size, 2);
    assert.equal(h.undo(t).text, '甲');
  });
});

describe('EditHistory：join', () => {
  test('并进刚记下的那一步，撤销时一起退、重做时一起回', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '（' }, { now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '）' }, { join: true, now: 10 });
    assert.equal(h.size, 1);
    const back = h.undo(t);
    assert.equal(back.text, '');
    assert.equal(h.redo(back.text).text, '（）');
  });

  test('撤销过之后的 join 照常另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = h.undo(t).text;
    t = apply(h, t, { at: 1, removed: '', inserted: '丙' }, { join: true, now: 20 });
    assert.equal(h.size, 2);
  });
});

describe('EditHistory：栈', () => {
  test('新的改动清掉重做栈', () => {
    const h = new EditHistory();
    let t = apply(h, '', { at: 0, removed: '', inserted: '甲' });
    t = h.undo(t).text;
    assert.equal(h.canRedo, true);
    apply(h, t, { at: 0, removed: '', inserted: '乙' });
    assert.equal(h.canRedo, false);
  });

  test('上限：丢最早的', () => {
    const h = new EditHistory(3);
    let t = '';
    for (let i = 0; i < 5; i++) {
      t = apply(h, t, { at: i, removed: '', inserted: String(i) });
    }
    assert.equal(h.size, 3);
    for (let i = 0; i < 3; i++) {
      t = h.undo(t).text;
    }
    assert.equal(t, '01');
    assert.equal(h.undo(t), undefined);
  });

  test('与文字对不上：整份作废，不改文字', () => {
    const h = new EditHistory();
    apply(h, '', { at: 0, removed: '', inserted: '甲' });
    assert.equal(h.undo('被别处改过'), undefined);
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
  });

  test('删掉与插入相同：什么都不记', () => {
    const h = new EditHistory();
    h.record({ at: 0, removed: '甲', inserted: '甲' }, caret(0), caret(0));
    assert.equal(h.size, 0);
  });

  test('每一步一个编号（码字统计认撤销的是哪一步）：并进去的不换号，撤销后栈顶回到上一步、重做回来还是原来那个号', () => {
    const h = new EditHistory();
    assert.equal(h.topId, undefined);
    let t = apply(h, '', { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    const first = h.topId;
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { merge: true, now: 10 });
    assert.equal(h.topId, first, '并进同一步');
    t = apply(h, t, { at: 2, removed: '', inserted: '丙丁' });
    const second = h.topId;
    assert.notEqual(second, first);
    t = h.undo(t).text;
    assert.equal(h.topId, first);
    t = h.redo(t).text;
    assert.equal(h.topId, second);
  });
});

describe('diffText', () => {
  test('相同返回 undefined', () => {
    assert.equal(diffText('甲', '甲'), undefined);
  });

  test('公共前后缀之间那一段', () => {
    assert.deepEqual(diffText('雨夜。', '雨夜，林昭。'), { at: 2, removed: '', inserted: '，林昭' });
    assert.deepEqual(diffText('甲乙丙', '甲丙'), { at: 1, removed: '乙', inserted: '' });
  });

  test('拿光标认对有歧义的位置', () => {
    // 在第一个 a 后面又打了一个 a：单看前后缀会认成插在第二个 a 后面。
    assert.deepEqual(diffText('aab', 'aaab'), { at: 2, removed: '', inserted: 'a' });
    assert.deepEqual(diffText('aab', 'aaab', 2), { at: 1, removed: '', inserted: 'a' });
  });

  test('光标对不上时退回单看前后缀', () => {
    assert.deepEqual(diffText('甲乙', '甲丙乙', 0), { at: 1, removed: '', inserted: '丙' });
  });

  test('不把代理对切成两半', () => {
    const d = diffText('a\u{1F600}', 'a\u{1F601}');
    assert.equal(d.removed, '\u{1F600}');
    assert.equal(d.inserted, '\u{1F601}');
  });
});
