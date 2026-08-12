/**
 * 长任务登记处：进度快照、n/N、只改一个字段、取消、抛异常、并发。
 * 迁自 scripts/smoke-logging.js 的 `== 长任务 ==`、`== 长任务：只改一个字段 ==`、
 * `== 长任务：取消 ==`、`== 长任务：抛异常 ==`、`== 长任务：并发 ==` 五节。
 *
 * host 用 makeFakeHost()：它默认的 progress 实现把每次进度记成 `${title}｜${m}`，
 * 与迁移前那份手写假宿主逐字一致，所以 h.progressCalls 可直接顶替原来的 hostProgressCalls。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let logger;
let progress;
let hostProgressCalls;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    logger: './src/core/logger.ts',
    progress: './src/core/progress.ts',
  });
  logger = bundle.logger;
  progress = bundle.progress;
  const h = makeFakeHost();
  hostProgressCalls = h.progressCalls;
  bundle.host.initHost(h.host);
});

describe('长任务', () => {
  let startedEmpty;
  let changes;
  let snapshotDuring;
  let result;

  before(async () => {
    hostProgressCalls.length = 0;
    startedEmpty = progress.activeTasks().length;

    changes = [];
    const sub = progress.onTasksChanged(() => changes.push(progress.activeTasks().length));

    snapshotDuring = null;
    result = await progress.runTask('同步章节摘要', async ({ report }) => {
      report({ message: '第 1 章', current: 0, total: 3 });
      snapshotDuring = progress.activeTasks()[0];
      report({ message: '第 2 章', current: 1 });
      return '完成';
    });

    sub.dispose();
  });

  test('起始时没有任务', () => {
    assert.equal(startedEmpty, 0);
  });

  test('返回值透传', () => {
    assert.equal(result, '完成', result);
  });

  test('任务中能看到快照', () => {
    assert.ok(!!snapshotDuring);
  });

  test('快照带标题', () => {
    assert.equal(snapshotDuring.title, '同步章节摘要', snapshotDuring.title);
  });

  test('快照带文案', () => {
    assert.equal(snapshotDuring.message, '第 1 章', snapshotDuring.message);
  });

  test('快照带总数', () => {
    assert.equal(snapshotDuring.total, 3, `${snapshotDuring.total}`);
  });

  test('快照带耗时', () => {
    assert.equal(typeof snapshotDuring.elapsedMs, 'number');
  });

  test('结束后任务表清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('订阅收到过变化', () => {
    assert.ok(changes.length > 0, `${changes.length}`);
  });

  test('宿主进度带 n/N', () => {
    assert.ok(
      hostProgressCalls.some((c) => c.includes('（1/3）')),
      hostProgressCalls.join(' / ')
    );
  });

  test('宿主进度带前缀', () => {
    assert.ok(
      hostProgressCalls.every((c) => c.startsWith('Novel Forge：')),
      hostProgressCalls[0]
    );
  });
});

describe('长任务：只改一个字段', () => {
  let snap;

  before(async () => {
    snap = null;
    await progress.runTask('测试任务', async ({ report }) => {
      report({ message: '甲', current: 2, total: 9 });
      report('乙'); // 纯字符串：只改文案
      snap = progress.activeTasks()[0];
    });
  });

  test('字符串 report 只改文案', () => {
    assert.equal(snap.message, '乙', snap.message);
  });

  test('current 沿用上次', () => {
    assert.equal(snap.current, 2, `${snap.current}`);
  });

  test('total 沿用上次', () => {
    assert.equal(snap.total, 9, `${snap.total}`);
  });
});

describe('长任务：取消', () => {
  let cancelled;
  let sawAbort;
  let idDuring;

  before(async () => {
    sawAbort = false;
    idDuring = '';
    await progress.runTask('可取消任务', async ({ signal, report }) => {
      report({ message: '跑着', current: 0, total: 2 });
      idDuring = progress.activeTasks()[0].id;
      // 迁移前这条断言写在任务体内部；这里把结论带出来，断言留在下面的用例里。
      cancelled = progress.cancelTask(idDuring);
      sawAbort = signal.aborted;
    });
  });

  test('cancelTask 认得在跑的任务', () => {
    assert.ok(cancelled);
  });

  test('任务体看得到 aborted', () => {
    assert.ok(sawAbort);
  });

  test('取消后任务表也清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('对已结束的 id 返回 false', () => {
    assert.equal(progress.cancelTask(idDuring), false);
  });

  test('对未知 id 返回 false', () => {
    assert.equal(progress.cancelTask('task-不存在'), false);
  });
});

describe('长任务：抛异常', () => {
  let caught;
  let errors;

  before(async () => {
    caught = '';
    try {
      await progress.runTask('会失败的任务', async () => {
        throw new Error('故意失败');
      });
    } catch (err) {
      caught = err.message;
    }

    logger.clearLogs();
    try {
      await progress.runTask('再失败一次', async () => {
        throw new Error('又失败了');
      });
    } catch {
      /* 预期内 */
    }
    errors = logger.recentLogs().filter((e) => e.level === 'error');
  });

  test('异常继续往上抛', () => {
    assert.equal(caught, '故意失败', caught);
  });

  test('失败后任务表清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('失败进日志', () => {
    assert.ok(
      errors.some((e) => e.message.includes('又失败了')),
      JSON.stringify(errors)
    );
  });
});

describe('长任务：并发', () => {
  let both;

  before(async () => {
    both = 0;
    await Promise.all([
      progress.runTask('任务甲', async () => {
        await new Promise((r) => setTimeout(r, 20));
        both = Math.max(both, progress.activeTasks().length);
      }),
      progress.runTask('任务乙', async () => {
        await new Promise((r) => setTimeout(r, 20));
        both = Math.max(both, progress.activeTasks().length);
      }),
    ]);
  });

  test('两个任务能同时在表里', () => {
    assert.equal(both, 2, `${both}`);
  });

  test('都结束后表空了', () => {
    assert.equal(progress.activeTasks().length, 0);
  });
});
