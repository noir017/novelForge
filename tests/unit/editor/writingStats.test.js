/**
 * 码字统计的纯逻辑（`media/src/editor/writingStats.ts`，零 DOM）与字数口径（`media/src/editor/words.ts`）。
 * 状态栏、面板、localStorage 那一整条链路在 tests/dom/standalone/stats.test.js，这里钉口径：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | `countWords` 与 core 对拍 | 编辑器一趟循环的写法与后端正则的写法一字不差（状态栏要与工程页对得上） |
 * | `wordDelta` | 只数改动那一段，等于前后各数一遍全文再相减（英文词被接长、劈开、并起来都对） |
 * | 哪些算码字 | 打字、输入法上屏算；粘贴、程序改写、组字中途、撤销重做不在这里算 |
 * | `StepLedger` | 撤销自己打的字减回去、重做加上；撤销粘贴不动 |
 * | 时长 | 停笔不超过 2 分钟的那段才算，记在后一下落笔的文件上，各文件加起来等于总数 |
 * | 速度、目标、时长的说法 | 不到 1 分钟不报速度；还差 / 超出 / 正好；八成换色 |
 * | 标题行 | 章节开头的 `# 标题` 不算字，与 core `stripH1` 同一条规则 |
 * | 今日码字 | 本地日期、跨午夜、坏值回落、多窗口只加增量、只留 30 天 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  IDLE_MS,
  MIN_SPEED_MS,
  DAILY_KEEP,
  StepLedger,
  WritingSession,
  addDaily,
  bumpDaily,
  countsAsWriting,
  dayKey,
  formatDuration,
  goalProgress,
  headingWords,
  isWritingActivity,
  parseDaily,
  serializeDaily,
  signedWords,
  speedPerHour,
  wordDelta,
} = loadModule('media/src/editor/writingStats.ts');
const { countWords, groupDigits } = loadModule('media/src/editor/words.ts');
const { EditHistory, diffText } = loadModule('media/src/editor/history.ts');
const core = loadModule('src/core/model/fs.ts');
const { stripH1 } = loadModule('src/core/model/markdown.ts');

/** 可复现的伪随机（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 各种会让字数口径出岔子的字符：汉字（含扩展 A）、英文、数字、撇号、空白、中英文标点、全角字母、emoji。 */
const ALPHABET = ['林', '昭', '雨', '㐀', 'a', 'B', 'z', '9', "'", ' ', '\n', '\r', '\t', '　', '，', '。', '"', '-', 'Ａ', '😀', '_'];
function randomText(rand, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s;
}

describe('countWords：与 core 一字不差', () => {
  const samples = [
    '',
    '林昭推开门，雨下了三天。',
    'He said "OK" 3 times, it\'s fine.',
    '第3章 He走了。',
    '㐀㐁 扩展A区也算',
    'ＡＢＣ全角字母不算词',
    '😀 emoji 不算字',
    'line1\r\nline2\n\n　　段首缩进',
    "don't won't  rock'n'roll",
  ];
  for (const text of samples) {
    test(`「${text.slice(0, 16).replace(/\s/g, '·')}」`, () => {
      assert.equal(countWords(text), core.countWords(text));
    });
  }

  test('随机拼出来的 300 段也一样', () => {
    const rand = rng(7);
    for (let i = 0; i < 300; i++) {
      const text = randomText(rand, 1 + Math.floor(rand() * 60));
      assert.equal(countWords(text), core.countWords(text), JSON.stringify(text));
    }
  });
});

describe('wordDelta：只数改动那一段', () => {
  /** 把一处改动套到 before 上，返回改动之后的全文与 wordDelta。 */
  const apply = (before, at, removed, inserted) => {
    assert.equal(before.slice(at, at + removed.length), removed, '夹具写错了');
    const after = before.slice(0, at) + inserted + before.slice(at + removed.length);
    return { after, delta: wordDelta(after, { at, removed, inserted }) };
  };
  const exact = (before, at, removed, inserted) => {
    const { after, delta } = apply(before, at, removed, inserted);
    assert.equal(delta, countWords(after) - countWords(before), JSON.stringify({ before, at, removed, inserted }));
    return delta;
  };

  test('打中文：一个字一个', () => {
    assert.equal(exact('林昭推开门。', 5, '', '，雨下了'), 3);
  });

  test('英文词中间再打一个字母：词数不变', () => {
    assert.equal(exact('hello world', 2, '', 'x'), 0);
  });

  test('词中间打一个空格：一个词劈成两个', () => {
    assert.equal(exact('helloworld', 5, '', ' '), 1);
  });

  test('删掉两个词之间的空格：并成一个', () => {
    assert.equal(exact('hello world', 5, ' ', ''), -1);
  });

  test('退格删字：倒扣', () => {
    assert.equal(exact('林昭推开门。', 3, '开门', ''), -2);
  });

  test('打字盖掉选区：删掉的扣、打的加', () => {
    assert.equal(exact('林昭推开门。', 0, '林昭', 'Lin Zhao'), 0);
    assert.equal(exact('林昭推开门。', 2, '推开门', '走'), -2);
  });

  test('文首、文末、空文档', () => {
    assert.equal(exact('', 0, '', '雨夜'), 2);
    assert.equal(exact('abc', 0, '', 'x'), 0);
    assert.equal(exact('abc', 3, '', ' d'), 1);
  });

  test('随机的 500 处改动：都等于前后各数一遍全文再相减', () => {
    const rand = rng(42);
    for (let i = 0; i < 500; i++) {
      const before = randomText(rand, Math.floor(rand() * 40));
      const at = Math.floor(rand() * (before.length + 1));
      const len = Math.floor(rand() * (before.length - at + 1));
      exact(before, at, before.slice(at, at + len), randomText(rand, Math.floor(rand() * 6)));
    }
  });
});

describe('哪些改动算码字', () => {
  const change = { at: 0, removed: '', inserted: '林' };

  test('键盘打字、输入法上屏（带 change）算', () => {
    assert.equal(countsAsWriting('typing', change), true);
    assert.equal(countsAsWriting('composition', change), true);
  });

  test('组字中途（不带 change）不算字，但算「在写」', () => {
    assert.equal(countsAsWriting('composition', undefined), false);
    assert.equal(isWritingActivity('composition'), true);
  });

  test('粘贴 / 剪切 / 拖放、程序改写、撤销重做都不按「打的字」算', () => {
    for (const source of ['input', 'program', 'undo', 'redo']) {
      assert.equal(countsAsWriting(source, change), false, source);
      assert.equal(isWritingActivity(source), false, source);
    }
  });
});

describe('StepLedger：撤销 / 重做跟着那一步走', () => {
  /** 用真的 EditHistory 走一遍：记一步（或并进去），再让账本看栈顶。 */
  function harness() {
    const history = new EditHistory();
    const ledger = new StepLedger();
    let text = '';
    let t = 0;
    const edit = (next, words, opts = {}) => {
      const change = diffText(text, next, next.length);
      history.record(change, { start: text.length, end: text.length }, { start: next.length, end: next.length }, { now: (t += 100), ...opts });
      text = next;
      ledger.afterEdit(history.topId, words);
    };
    const undo = () => {
      text = history.undo(text).text;
      return ledger.afterUndo(history.topId);
    };
    const redo = () => {
      text = history.redo(text).text;
      return ledger.afterRedo(history.topId);
    };
    return { history, edit, undo, redo, text: () => text };
  }

  test('撤销一次粘贴：码字数不动；再撤销自己打的字：减回去', () => {
    const h = harness();
    h.edit('林昭', 2, { merge: true });
    h.edit('林昭推开门', 0); // 粘贴：不计入
    assert.equal(h.undo(), 0);
    assert.equal(h.undo(), -2);
    assert.equal(h.text(), '');
  });

  test('重做：自己打的加回来，粘贴的还是不算', () => {
    const h = harness();
    h.edit('林昭', 2, { merge: true });
    h.edit('林昭推开门', 0);
    h.undo();
    h.undo();
    assert.equal(h.redo(), 2);
    assert.equal(h.redo(), 0);
  });

  test('连续打字并成一步：撤销一次退掉整串的字数', () => {
    const h = harness();
    h.edit('林', 1, { merge: true });
    h.edit('林昭', 1, { merge: true });
    h.edit('林昭来', 1, { merge: true });
    assert.equal(h.history.size, 1);
    assert.equal(h.undo(), -3);
  });

  test('程序改写并进刚打的那一步（成对符号补的后半个）：那一步的字数不变', () => {
    const h = harness();
    h.edit('“林', 1, { merge: true });
    h.edit('“林”', 0, { join: true });
    assert.equal(h.undo(), -1);
  });

  test('账本开始之前就有的步（重新开始计时之前打的）：撤销不动这次的数', () => {
    const history = new EditHistory();
    history.record({ at: 0, removed: '', inserted: '林昭' }, { start: 0, end: 0 }, { start: 2, end: 2 });
    const ledger = new StepLedger();
    history.undo('林昭');
    assert.equal(ledger.afterUndo(history.topId), 0);
    history.redo('');
    assert.equal(ledger.afterRedo(history.topId), 0);
  });
});

describe('本次码字：时长只算在写的那段', () => {
  test('第一下落笔不算时长；之后两下之间不超过 2 分钟的那段算', () => {
    const s = new WritingSession(0);
    assert.equal(s.touch('a.md', 'A', 1_000), 0);
    assert.equal(s.touch('a.md', 'A', 31_000), 30_000);
    assert.equal(s.touch('a.md', 'A', 31_000 + IDLE_MS), IDLE_MS, '正好 2 分钟还算');
    assert.equal(s.ms, 30_000 + IDLE_MS);
  });

  test('停笔超过 2 分钟：那一段整个不算，回来之后接着算', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 0);
    assert.equal(s.touch('a.md', 'A', IDLE_MS + 1), 0);
    assert.equal(s.touch('a.md', 'A', IDLE_MS + 10_001), 10_000);
    assert.equal(s.ms, 10_000);
  });

  test('两下落笔之间的那段记在后一下的文件上，各文件加起来等于总数', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 0);
    s.touch('b.md', 'B', 20_000);
    s.touch('a.md', 'A', 50_000);
    assert.equal(s.files.get('a.md').ms, 30_000);
    assert.equal(s.files.get('b.md').ms, 20_000);
    assert.equal(s.ms, 50_000);
  });

  test('时钟往回拨不倒扣、也不凭空多出一段', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 100_000);
    assert.equal(s.touch('a.md', 'A', 50_000), 0);
    assert.equal(s.touch('a.md', 'A', 110_000), 10_000);
  });

  test('字数按文件分别记、汇总；明细按字数排；改名跟着走', () => {
    const s = new WritingSession(0);
    s.add('a.md', '第 1 章', 30);
    s.add('b.md', '第 2 章', 120);
    s.add('a.md', '第 1 章', -5);
    assert.equal(s.words, 145);
    assert.deepEqual(s.breakdown().map((f) => [f.path, f.words]), [['b.md', 120], ['a.md', 25]]);
    s.rename('a.md', 'c.md');
    assert.deepEqual([...s.files.keys()].sort(), ['b.md', 'c.md']);
    assert.equal(s.files.get('c.md').words, 25);
  });

  test('改名到一个已经有明细的路径：并进去', () => {
    const s = new WritingSession(0);
    s.add('a.md', 'A', 10);
    s.add('b.md', 'B', 5);
    s.rename('a.md', 'b.md');
    assert.equal(s.files.size, 1);
    assert.equal(s.files.get('b.md').words, 15);
  });
});

describe('速度、时长、目标的说法', () => {
  test('速度按每小时算；不到 1 分钟、或者净字数不是正的不报', () => {
    assert.equal(speedPerHour(600, 30 * 60_000), 1200);
    assert.equal(speedPerHour(600, MIN_SPEED_MS - 1), undefined);
    assert.equal(speedPerHour(0, 30 * 60_000), undefined);
    assert.equal(speedPerHour(-40, 30 * 60_000), undefined);
  });

  test('时长：不到 1 分钟 / N 分钟 / H 小时 M 分', () => {
    assert.equal(formatDuration(59_000), '不到 1 分钟');
    assert.equal(formatDuration(42 * 60_000 + 5_000), '42 分钟');
    assert.equal(formatDuration(125 * 60_000), '2 小时 5 分');
    assert.equal(formatDuration(120 * 60_000), '2 小时');
  });

  test('千分位与带符号的字数', () => {
    assert.equal(groupDigits(3120), '3,120');
    assert.equal(groupDigits(1234567), '1,234,567');
    assert.equal(groupDigits(-1200), '-1,200');
    assert.equal(signedWords(356), '+356');
    assert.equal(signedWords(-12), '-12');
    assert.equal(signedWords(0), '0');
  });

  test('还差多少', () => {
    const g = goalProgress(3120, 4000);
    assert.equal(`${g.count}，${g.rest}`, '3,120 / 4,000 字，还差 880');
    assert.equal(g.enough, false);
    assert.equal(g.over, false);
  });

  test('到了八成算写够（后端判「写够了」的线），进度条换色', () => {
    assert.equal(goalProgress(3200, 4000).enough, true);
    assert.equal(goalProgress(3199, 4000).enough, false);
  });

  test('超了说超了多少；正好写够', () => {
    const g = goalProgress(4120, 4000);
    assert.equal(g.rest, '超出 120');
    assert.equal(g.over, true);
    assert.equal(goalProgress(4000, 4000).rest, '正好写够');
  });

  test('没有目标（缺席、0、负数）：不报', () => {
    assert.equal(goalProgress(100, undefined), undefined);
    assert.equal(goalProgress(100, 0), undefined);
    assert.equal(goalProgress(100, -5), undefined);
  });
});

describe('章节开头的「# 标题」不算字：与 core stripH1 同一条规则', () => {
  const samples = [
    '# 第三章 夜访\n\n林昭推开门。',
    '\n\n# Night Visit 3\r\n正文 here.',
    '#没有空格不是标题\n正文。',
    '## 二级标题不是\n正文。',
    '   # 前面有空白\n正文。',
    '#\n第一行被当成标题内容\n第二行。',
    '# 只有标题',
    '正文里的\n# 不在开头\n不算标题。',
  ];
  for (const text of samples) {
    test(`「${text.slice(0, 14).replace(/\s/g, '·')}」`, () => {
      assert.equal(countWords(text) - headingWords(text), core.countWords(stripH1(text.trim())));
    });
  }
});

describe('今日码字：按本地日期、坏值回落、多窗口只加增量', () => {
  const at = (h, m) => new Date(2026, 9, 18, h, m).getTime();

  test('日期是本地的：23:59 是这一天，过了零点是下一天', () => {
    assert.equal(dayKey(at(23, 59)), '2026-10-18');
    assert.equal(dayKey(at(23, 59) + 2 * 60_000), '2026-10-19');
  });

  test('一笔增量跨午夜：各记各的那一天', () => {
    const inc = {};
    bumpDaily(inc, at(23, 58), 30, 60_000);
    bumpDaily(inc, at(23, 59) + 2 * 60_000, 12, 30_000);
    assert.deepEqual(inc, { '2026-10-18': { words: 30, ms: 60_000 }, '2026-10-19': { words: 12, ms: 30_000 } });
  });

  test('读写往返', () => {
    const rec = { '2026-10-18': { words: 1820, ms: 7_500_000 } };
    assert.deepEqual(parseDaily(serializeDaily(rec)), rec);
  });

  test('坏值一律回落成没有，不抛', () => {
    for (const raw of [null, undefined, '', '不是 JSON', '[]', '42', '{"days":[]}', '{"days":"x"}', '{"v":1}']) {
      assert.deepEqual(parseDaily(raw), {}, String(raw));
    }
  });

  test('某一天的数写坏了只丢那一天', () => {
    const raw = JSON.stringify({
      v: 1,
      days: {
        '2026-10-17': { words: '30', ms: 1 },
        '2026-10-16': { words: 10, ms: -1 },
        '昨天': { words: 10, ms: 1 },
        '2026-10-15': null,
        '2026-10-18': { words: 12.4, ms: 60_000.6 },
      },
    });
    assert.deepEqual(parseDaily(raw), { '2026-10-18': { words: 12, ms: 60_001 } });
  });

  test('是加不是覆盖：两个窗口各写自己的增量，加起来不丢不重', () => {
    let shared = parseDaily(null);
    // 窗口 A 先写 10 字，窗口 B 再写 5 字：B 写的时候现读 A 写下的那一份。
    shared = parseDaily(serializeDaily(addDaily(shared, { '2026-10-18': { words: 10, ms: 1000 } })));
    shared = parseDaily(serializeDaily(addDaily(shared, { '2026-10-18': { words: 5, ms: 500 } })));
    assert.deepEqual(shared, { '2026-10-18': { words: 15, ms: 1500 } });
  });

  test('不改传进来的两份', () => {
    const stored = { '2026-10-18': { words: 1, ms: 1 } };
    const inc = { '2026-10-18': { words: 2, ms: 2 } };
    addDaily(stored, inc);
    assert.deepEqual(stored, { '2026-10-18': { words: 1, ms: 1 } });
    assert.deepEqual(inc, { '2026-10-18': { words: 2, ms: 2 } });
  });

  test(`只留最近 ${DAILY_KEEP} 天`, () => {
    const stored = {};
    for (let d = 1; d <= DAILY_KEEP; d++) {
      bumpDaily(stored, new Date(2026, 8, d, 12).getTime(), d, 0);
    }
    const out = addDaily(stored, { '2026-10-18': { words: 1, ms: 0 } });
    assert.equal(Object.keys(out).length, DAILY_KEEP);
    assert.equal('2026-09-01' in out, false);
    assert.equal('2026-10-18' in out, true);
  });
});
