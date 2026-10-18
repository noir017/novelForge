/**
 * 历史版本的纯函数（`src/core/workspace/history.ts`）：快照目录怎么镜像原文件的路径、快照文件名怎么起与读回来、
 * 存不存（节流）、留几个（裁剪）。落盘的那一半在 tests/integration/workspace/history.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let h;
let project;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    history: './src/core/workspace/history.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  h = bundle.history;
  // 只算路径，不碰盘。
  project = bundle.project.NovelProject.open(path.join(os.tmpdir(), 'novelforge-history-unit'));
});

const MIN = 60_000;

describe('快照目录镜像原文件的相对路径', () => {
  test('章节：.novelforge/history/<原路径>/，扩展名留在目录名里', () => {
    assert.equal(h.historyDirOf(project, 'chapters/第一卷/003-深处.txt'), '.novelforge/history/chapters/第一卷/003-深处.txt');
  });

  test('同名不同扩展名各是各的目录，不撞车', () => {
    assert.notEqual(h.historyDirOf(project, 'chapters/003.md'), h.historyDirOf(project, 'chapters/003.txt'));
    assert.notEqual(h.historyDirOf(project, 'chapters/003'), h.historyDirOf(project, 'chapters/003.md'));
  });

  test('.novelforge/ 里的文件同样原样镜像（细纲、角色卡）', () => {
    assert.equal(
      h.historyDirOf(project, '.novelforge/summaries/第一卷/003-深处.md'),
      '.novelforge/history/.novelforge/summaries/第一卷/003-深处.md'
    );
    assert.equal(h.historyDirOf(project, '.novelforge/characters/林昭.md'), '.novelforge/history/.novelforge/characters/林昭.md');
  });

  test('反斜杠归一、越界给 undefined', () => {
    assert.equal(h.historyDirOf(project, 'chapters\\001.md'), '.novelforge/history/chapters/001.md');
    assert.equal(h.historyDirOf(project, '../外面.md'), undefined);
    assert.equal(h.historyDirOf(project, '/etc/passwd'), undefined);
  });
});

describe('快照文件名', () => {
  test('本地时间 + 时区，扩展名一律 .txt', () => {
    const name = h.snapshotFileName(new Date(2026, 9, 18, 14, 32, 5));
    assert.match(name, /^2026-10-18_14-32-05[+-]\d{4}\.txt$/);
  });

  test('读回来的时刻与起名时的一致（精确到秒）', () => {
    const at = new Date(2026, 9, 18, 14, 32, 5, 678);
    const back = h.parseSnapshotFileName(h.snapshotFileName(at));
    assert.equal(back.time, Math.floor(at.getTime() / 1000) * 1000);
    assert.equal(back.dup, 1);
  });

  test('同一秒的第二个带序号，读回来序号对', () => {
    const name = h.snapshotFileName(new Date(2026, 9, 18, 14, 32, 5), 2);
    assert.match(name, /-2\.txt$/);
    assert.equal(h.parseSnapshotFileName(name).dup, 2);
  });

  test('时区写在名字里：换了时区读回来还是同一刻', () => {
    assert.equal(
      h.parseSnapshotFileName('2026-10-18_14-32-05+0800.txt').time,
      h.parseSnapshotFileName('2026-10-18_06-32-05+0000.txt').time
    );
    assert.equal(h.parseSnapshotFileName('2026-10-18_14-32-05+0800.txt').time, Date.UTC(2026, 9, 18, 6, 32, 5));
  });

  test('不是快照的名字认不出（作者放进来的别的文件）', () => {
    for (const name of ['.gitignore', '笔记.txt', '2026-10-18.txt', '2026-10-18_14-32-05+0800.md', '2026-10-18_14-32-05.txt']) {
      assert.equal(h.parseSnapshotFileName(name), undefined, name);
    }
  });

  test('排序：新的在前、同一秒序号大的在前，别的名字丢掉', () => {
    const sorted = h.sortSnapshotNames([
      '2026-10-18_14-32-05+0800.txt',
      '笔记.txt',
      '2026-10-18_14-40-00+0800.txt',
      '2026-10-18_14-32-05+0800-2.txt',
      '2026-10-17_23-59-59+0800.txt',
    ]);
    assert.deepEqual(sorted, [
      '2026-10-18_14-40-00+0800.txt',
      '2026-10-18_14-32-05+0800-2.txt',
      '2026-10-18_14-32-05+0800.txt',
      '2026-10-17_23-59-59+0800.txt',
    ]);
  });

  test('排序按时刻不按字面：+0000 的 07:00 比 +0800 的 14:32 晚', () => {
    assert.deepEqual(h.sortSnapshotNames(['2026-10-18_14-32-05+0800.txt', '2026-10-18_07-00-00+0000.txt']), [
      '2026-10-18_07-00-00+0000.txt',
      '2026-10-18_14-32-05+0800.txt',
    ]);
  });
});

describe('改动大小（公共前后缀粗算）', () => {
  test('一样是 0', () => {
    assert.equal(h.changedChars('雨下了三天。', '雨下了三天。'), 0);
  });

  test('中间改一处：只算改掉的那段较长的一边', () => {
    assert.equal(h.changedChars('他走进了院子。', '他慢慢走进了院子。'), 2);
    assert.equal(h.changedChars('他慢慢走进了院子。', '他走进了院子。'), 2);
    assert.equal(h.changedChars('甲乙丙丁', '甲XYZ丁'), 3);
  });

  test('末尾追加：算追加的长度', () => {
    assert.equal(h.changedChars('第一段。', '第一段。\n\n第二段很长。'), 8);
  });

  test('首尾各改一处：中间全算进去（宁可多存）', () => {
    const body = '中'.repeat(1000);
    assert.equal(h.changedChars(`A${body}B`, `C${body}D`), 1002);
  });
});

describe('存不存（节流）', () => {
  const now = Date.UTC(2026, 9, 18, 6, 32, 0);
  const big = '正'.repeat(2000);

  test('还没有快照：存', () => {
    assert.deepEqual(h.decideSnapshot({ old: '旧', next: '新', now }), { save: true, reason: 'first' });
  });

  test('新内容与旧内容一样（什么都没覆盖）：不存', () => {
    assert.deepEqual(h.decideSnapshot({ old: '一样', next: '一样', now }), { save: false, reason: 'unchanged' });
  });

  test('只差换行风格也算一样（CRLF 归一）', () => {
    assert.equal(h.decideSnapshot({ old: 'a\r\nb', next: 'a\nb', now }).save, false);
  });

  test('旧内容与最新快照一字不差：不存（哪怕新内容是大改）', () => {
    const d = h.decideSnapshot({ old: big, next: '全换了', latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: false, reason: 'same' });
  });

  test('最新快照不到 10 分钟、两处改动都很小：不存（自动保存攒不出几百个快照）', () => {
    const d = h.decideSnapshot({ old: `${big}一句`, next: `${big}一句两句`, latest: { text: big, time: now - 3 * MIN }, now });
    assert.deepEqual(d, { save: false, reason: 'small' });
  });

  test('最新快照超过 10 分钟：小改也存', () => {
    const d = h.decideSnapshot({ old: `${big}一句`, next: `${big}一句两句`, latest: { text: big, time: now - 11 * MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'quiet' });
  });

  test('正好 10 分钟算超过', () => {
    assert.equal(h.decideSnapshot({ old: `${big}一`, next: `${big}一二`, latest: { text: big, time: now - 10 * MIN }, now }).save, true);
  });

  test('不到 10 分钟，但自上一版以来攒的改动超过 300 字：存', () => {
    const drifted = `${big}${'新'.repeat(301)}`;
    const d = h.decideSnapshot({ old: drifted, next: `${drifted}再一句`, latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'bigChange' });
  });

  test('不到 10 分钟、旧内容与上一版只差几个字，但这一次是大改（整章重写 / 修稿 / 一键排版）：总是存', () => {
    const old = `${big}刚打的几个字`;
    const rewritten = '重'.repeat(2000);
    const d = h.decideSnapshot({ old, next: rewritten, latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'bigChange' });
  });

  test('正好 300 字算小改', () => {
    const d = h.decideSnapshot({ old: `${big}${'新'.repeat(300)}`, next: `${big}${'新'.repeat(300)}。`, latest: { text: big, time: now - MIN }, now });
    assert.equal(d.save, false);
  });

  test('「现在存一版」（force）跳过节流', () => {
    const d = h.decideSnapshot({ old: `${big}一`, latest: { text: big, time: now - MIN }, now, force: true });
    assert.deepEqual(d, { save: true, reason: 'force' });
  });

  test('「现在存一版」与最新快照一字不差时也不重复存', () => {
    const d = h.decideSnapshot({ old: big, latest: { text: big, time: now - MIN }, now, force: true });
    assert.deepEqual(d, { save: false, reason: 'same' });
  });

  test('几个阈值就是文件头写的那几个数', () => {
    assert.equal(h.HISTORY_KEEP, 50);
    assert.equal(h.HISTORY_QUIET_MS, 10 * MIN);
    assert.equal(h.HISTORY_SMALL_CHANGE, 300);
    assert.equal(h.HISTORY_GITIGNORE, '*\n');
  });
});

describe('保留裁剪', () => {
  const names = (n) =>
    Array.from({ length: n }, (_, i) => h.snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * MIN)));

  test('不超过 50 个：一个都不删', () => {
    assert.deepEqual(h.snapshotsToPrune(names(50)), []);
  });

  test('超过 50 个：删掉最旧的那几个', () => {
    const all = names(53);
    assert.deepEqual(new Set(h.snapshotsToPrune(all)), new Set(all.slice(0, 3)));
  });

  test('乱序给进来也按时刻认最旧的；不是快照的名字不在删除之列', () => {
    const all = names(52);
    const shuffled = [...all].reverse().concat(['.gitignore', '笔记.txt']);
    const pruned = h.snapshotsToPrune(shuffled);
    assert.deepEqual(new Set(pruned), new Set(all.slice(0, 2)));
    assert.ok(!pruned.includes('笔记.txt'));
  });

  test('保留数可以调（测试与以后的设置用）', () => {
    const all = names(5);
    assert.deepEqual(new Set(h.snapshotsToPrune(all, 2)), new Set(all.slice(0, 3)));
  });
});
