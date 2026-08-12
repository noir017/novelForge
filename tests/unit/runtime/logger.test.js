/**
 * 日志系统：脱敏、环形缓冲、detail 截断、sink 的分发与级别过滤、格式化。
 * 迁自 scripts/smoke-logging.js 的 `== 脱敏 ==`、`== 缓冲 ==`、`== detail 截断 ==`、
 * `== sink ==`、`== 格式化 ==` 五节。
 *
 * 三条硬约束：日志里绝不出现 API Key；缓冲有上限；sink 抛异常不能带崩调用方。
 *
 * 这几节改的都是 logger 的模块级状态（缓冲、sink 表、sink 级别），用例之间有先后依赖——
 * node:test 同文件内默认串行执行，顺序与迁移前一致。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let logger;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    logger: './src/core/logger.ts',
  });
  logger = bundle.logger;
  bundle.host.initHost(makeFakeHost().host);
});

describe('脱敏', () => {
  const cases = [
    ['sk-proj-abcdefghijklmnop', 'OpenAI 风格'],
    ['sk-ant-api03-QQQQzzzz1111', 'Anthropic 风格'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'Bearer 头'],
    ['api_key=9f8e7d6c5b4a3210', 'api_key=… 形式'],
    ['{"x-api-key": "topsecretvalue123"}', 'JSON 里的 x-api-key'],
  ];
  for (const [raw, label] of cases) {
    test(`${label}被隐去`, () => {
      const out = logger.redact(raw);
      assert.ok(out.includes('已隐去'), out);
    });
  }

  // 抹的是密钥不是正文：一句普通日志不该被改写。
  test('普通文本不受影响', () => {
    const plain = '第 12 章《夜访》摘要已写入';
    assert.equal(logger.redact(plain), plain, logger.redact(plain));
  });

  describe('emit 的两条路径都过 redact', () => {
    let entry;

    before(() => {
      logger.clearLogs();
      const log = logger.scoped('测试');
      log.error('连接失败 sk-proj-abcdefghijklmnop', { key: 'sk-ant-api03-ZZZZwwww2222' });
      entry = logger.recentLogs().at(-1);
    });

    test('message 已脱敏', () => {
      assert.ok(!entry.message.includes('abcdefghijklmnop'), entry.message);
    });

    test('detail 已脱敏', () => {
      assert.ok(!entry.detail.includes('wwww2222'), entry.detail);
    });
  });
});

describe('缓冲', () => {
  let over;
  let kept;
  let sawDebugAfterRaise;
  let afterClear;

  before(() => {
    logger.clearLogs();
    const log = logger.scoped('压测');
    over = logger.MAX_ENTRIES + 200;
    for (let i = 0; i < over; i++) {
      log.debug(`第 ${i} 条`);
    }
    kept = [...logger.recentLogs()];

    // 缓冲永远收全量：sink 级别调高不该让日志页看不到 debug。
    logger.setSinkLevel('error');
    logger.clearLogs();
    log.debug('调试内容');
    sawDebugAfterRaise = logger.recentLogs().some((e) => e.level === 'debug');
    logger.setSinkLevel('debug');

    logger.clearLogs();
    afterClear = [...logger.recentLogs()];
  });

  test('缓冲不超过上限', () => {
    assert.equal(kept.length, logger.MAX_ENTRIES, `${kept.length}`);
  });

  test('丢的是最旧的', () => {
    assert.equal(kept[0].message, `第 ${over - logger.MAX_ENTRIES} 条`, kept[0].message);
  });

  test('最新一条还在', () => {
    assert.equal(kept.at(-1).message, `第 ${over - 1} 条`, kept.at(-1).message);
  });

  test('seq 单调递增', () => {
    assert.ok(kept.every((e, i) => i === 0 || e.seq > kept[i - 1].seq));
  });

  test('调高 sink 级别后缓冲仍收 debug', () => {
    assert.ok(sawDebugAfterRaise);
  });

  test('清空后只留一条痕迹', () => {
    assert.equal(afterClear.length, 1, `${afterClear.length}`);
  });

  test('痕迹说明日志被清过', () => {
    assert.ok(afterClear[0].message.includes('清空'));
  });
});

describe('detail 截断', () => {
  let entry;

  before(() => {
    logger.clearLogs();
    logger.scoped('测试').info('长 detail', 'x'.repeat(50000));
    entry = logger.recentLogs().at(-1);
  });

  test('detail 被截断', () => {
    assert.ok(entry.detail.length < 3000, `${entry.detail.length}`);
  });

  test('截断处有说明', () => {
    assert.ok(entry.detail.includes('省略'), entry.detail.slice(-40));
  });
});

describe('sink', () => {
  let seen;
  let threw;
  let alive;
  let recursed;
  let filtered;

  before(() => {
    logger.clearLogs();
    logger.setSinkLevel('debug');
    seen = [];
    const sub = logger.addLogSink((e) => seen.push(e.message));
    const log = logger.scoped('测试');
    log.info('一');
    log.info('二');

    sub.dispose();
    log.info('三');

    // sink 抛异常只能被吞掉，绝不能带崩调用方。
    alive = [];
    const bad = logger.addLogSink(() => {
      throw new Error('sink 坏了');
    });
    const good = logger.addLogSink((e) => alive.push(e.message));
    threw = false;
    try {
      log.info('四');
    } catch {
      threw = true;
    }
    bad.dispose();
    good.dispose();

    // sink 里再打日志不能无限递归。
    const reentrant = logger.addLogSink(() => logger.scoped('回环').debug('sink 内部日志'));
    recursed = false;
    try {
      log.info('五');
    } catch {
      recursed = true;
    }
    reentrant.dispose();

    // 级别过滤只作用于 sink。
    logger.setSinkLevel('warn');
    filtered = [];
    const sub2 = logger.addLogSink((e) => filtered.push(e.level));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    sub2.dispose();
    logger.setSinkLevel('debug');
  });

  test('sink 收到每一条', () => {
    assert.equal(seen.join(','), '一,二', seen.join(','));
  });

  test('dispose 后不再收', () => {
    assert.ok(!seen.includes('三'), seen.join(','));
  });

  test('坏 sink 不抛给调用方', () => {
    assert.ok(!threw);
  });

  test('坏 sink 不影响别的 sink', () => {
    assert.ok(alive.includes('四'), alive.join(','));
  });

  test('sink 内部再打日志不炸栈', () => {
    assert.ok(!recursed);
  });

  test('sink 按级别过滤', () => {
    assert.equal(filtered.join(','), 'warn,error', filtered.join(','));
  });
});

describe('格式化', () => {
  test('毫秒', () => {
    assert.equal(logger.formatDuration(860), '860ms', logger.formatDuration(860));
  });

  test('秒', () => {
    assert.equal(logger.formatDuration(3200), '3.2s', logger.formatDuration(3200));
  });

  test('分秒', () => {
    assert.equal(logger.formatDuration(72000), '1 分 12 秒', logger.formatDuration(72000));
  });

  test('Error 取 message', () => {
    assert.equal(logger.describeError(new Error('炸了')), '炸了');
  });

  test('字符串原样', () => {
    assert.equal(logger.describeError('炸了'), '炸了');
  });

  test('对象转 JSON', () => {
    assert.equal(logger.describeError({ a: 1 }), '{"a":1}', logger.describeError({ a: 1 }));
  });

  describe('formatLogEntry', () => {
    let line;

    before(() => {
      logger.clearLogs();
      logger.scoped('测试').warn('一句话', '两行\n详情');
      line = logger.formatLogEntry(logger.recentLogs().at(-1));
    });

    test('单行含级别与来源', () => {
      assert.ok(line.includes('WARN') && line.includes('测试'), line);
    });

    test('detail 缩进在下一行', () => {
      assert.ok(line.includes('\n    两行'), JSON.stringify(line));
    });
  });
});
