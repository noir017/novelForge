/**
 * 并发工具：runPool 的并发上限、结果对齐、失败与取消，serialize 的排队语义。
 * 迁自 scripts/smoke-pool.js 的 `== runPool：并发上限与顺序 ==`、
 * `== runPool：失败与取消 ==`、`== serialize：审阅排队 ==` 三节。
 *
 * concurrency.ts 只 import 了 CancelledError，不碰 host / config，所以单独 bundle 即可。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');
const { sleep } = require('../../helpers/fakeProvider');

describe('runPool：并发上限与顺序', () => {
  let runPool;

  before(() => {
    ({ runPool } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('并发上限', () => {
    let peak = 0;
    let results;

    before(async () => {
      let inFlight = 0;
      const items = Array.from({ length: 12 }, (_, i) => i);
      results = await runPool(items, 4, async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5 + ((item * 7) % 11)); // 参差的耗时，制造乱序完成
        inFlight--;
        return item * 2;
      });
    });

    test('并发峰值不超过 limit', () => {
      assert.ok(peak <= 4, `峰值 ${peak}`);
    });

    // 依赖真实定时器交错，是这一组里唯一天生有抖动的断言。
    test('确实并发了（不是退化成串行）', () => {
      assert.ok(peak > 1, `峰值 ${peak}`);
    });

    test('每一项都有结果', () => {
      assert.equal(results.length, 12);
    });

    test('结果按 index 对齐（完成顺序不影响）', () => {
      assert.ok(results.every((r, i) => r.status === 'fulfilled' && r.value === i * 2));
    });
  });

  describe('limit=1', () => {
    let order;

    before(async () => {
      order = [];
      await runPool([1, 2, 3, 4], 1, async (item) => {
        order.push(`start${item}`);
        await sleep(2);
        order.push(`end${item}`);
      });
    });

    test('limit=1 严格串行（与改造前逐字一致）', () => {
      assert.equal(order.join(','), 'start1,end1,start2,end2,start3,end3,start4,end4', order.join(','));
    });
  });
});

describe('runPool：失败与取消', () => {
  let runPool;

  before(() => {
    ({ runPool } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('单项失败', () => {
    let ran;
    let results;

    before(async () => {
      ran = [];
      results = await runPool([1, 2, 3], 2, async (item) => {
        ran.push(item);
        if (item === 2) {
          throw new Error('第二项炸了');
        }
        return item;
      });
    });

    test('单项失败不影响其余', () => {
      assert.equal(ran.length, 3, ran.join(','));
    });

    test('失败项标为 rejected', () => {
      assert.equal(results[1].status, 'rejected');
    });

    test('失败项带得出原因', () => {
      assert.ok(String(results[1].reason.message).includes('第二项炸了'));
    });

    test('其余项照常有值', () => {
      assert.equal(results[0].value, 1);
      assert.equal(results[2].value, 3);
    });
  });

  describe('中途取消', () => {
    let ran;
    let results;

    before(async () => {
      const abort = new AbortController();
      ran = [];
      results = await runPool(
        [1, 2, 3, 4, 5, 6],
        1,
        async (item) => {
          ran.push(item);
          if (item === 2) {
            abort.abort();
          }
          return item;
        },
        { signal: abort.signal }
      );
    });

    test('取消后不再启动新任务', () => {
      assert.equal(ran.length, 2, `跑了 ${ran.join('、')}`);
    });

    test('未启动的项留在结果里（占位为 CancelledError）', () => {
      assert.equal(results.length, 6);
    });

    test('占位是取消而不是成功', () => {
      assert.equal(results[5].status, 'rejected');
      assert.equal(results[5].reason.name, 'CancelledError');
    });
  });

  describe('onSettled', () => {
    let done = 0;
    let seen;

    before(async () => {
      seen = [];
      await runPool([1, 2, 3, 4], 3, async (i) => sleep(3 + i), {
        onSettled: (_r, item, _i, finished) => {
          done = finished;
          seen.push(`${item}:${finished}`);
        },
      });
    });

    test('onSettled 的计数单调递增到总数', () => {
      assert.equal(done, 4, seen.join(' '));
    });

    test('onSettled 的计数没有重复（进度条不会倒退）', () => {
      assert.equal(new Set(seen.map((s) => s.split(':')[1])).size, 4, seen.join(' '));
    });
  });
});

describe('serialize：审阅排队', () => {
  let serialize;

  before(() => {
    ({ serialize } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('排队执行', () => {
    let peak = 0;
    let order;

    before(async () => {
      let inFlight = 0;
      order = [];
      await Promise.all(
        [1, 2, 3].map((i) =>
          serialize(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            order.push(i);
            await sleep(5);
            inFlight--;
          })
        )
      );
    });

    test('同一时刻只有一个在跑', () => {
      assert.equal(peak, 1, `峰值 ${peak}`);
    });

    test('按入队顺序执行', () => {
      assert.equal(order.join(','), '1,2,3', order.join(','));
    });
  });

  describe('一个抛错不卡死后面的', () => {
    let after;

    before(async () => {
      // 一次审阅抛错不能卡死后面排队的（用户放弃某张卡后其余还得能弹）。
      after = [];
      const boom = serialize(async () => {
        throw new Error('审阅炸了');
      }).catch((e) => after.push(`caught:${e.message}`));
      const next = serialize(async () => {
        after.push('next-ran');
      });
      await Promise.all([boom, next]);
    });

    test('前一个抛错不影响后面排队的', () => {
      assert.ok(after.includes('next-ran'), after.join(','));
    });

    test('异常照旧抛给它自己的调用方', () => {
      assert.ok(after.some((s) => s.startsWith('caught:')));
    });
  });
});
