/**
 * 日志系统与长任务登记处的离线验证。
 *
 * 覆盖三条硬约束：
 *   1. 日志里绝不出现 API Key（redact）；
 *   2. 缓冲有上限，长跑不会把内存吃光；
 *   3. sink 抛异常不能带崩正在跑的功能。
 *
 * 以及 runTask 的对外行为：进度快照、n/N、取消、结束后清表。
 *
 * 用法：node scripts/smoke-logging.js
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 与 smoke-fileops.js 同一套：打进同一个 bundle，共享 host/logger 的模块级状态。 */
function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath.replace(/\\/g, '/')}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  logger: './src/core/logger.ts',
  progress: './src/core/progress.ts',
});

const { logger, progress } = bundle;

/** 假宿主：progress 直通，记下最后一次进度文案供断言。 */
const hostProgressCalls = [];
bundle.host.initHost({
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({}), write: async () => {} },
  input: async () => undefined,
  confirm: async () => undefined,
  pick: async () => undefined,
  progress: async (title, fn) => {
    const abort = new AbortController();
    return fn(abort.signal, (m) => hostProgressCalls.push(`${title}｜${m}`));
  },
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: () => {},
  selectionAttachment: async () => undefined,
});

async function main() {
  console.log('\n== 脱敏 ==');
  {
    const cases = [
      ['sk-proj-abcdefghijklmnop', 'OpenAI 风格'],
      ['sk-ant-api03-QQQQzzzz1111', 'Anthropic 风格'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'Bearer 头'],
      ['api_key=9f8e7d6c5b4a3210', 'api_key=… 形式'],
      ['{"x-api-key": "topsecretvalue123"}', 'JSON 里的 x-api-key'],
    ];
    for (const [raw, label] of cases) {
      const out = logger.redact(raw);
      check(`${label}被隐去`, out.includes('已隐去'), out);
    }
    // 抹的是密钥不是正文：一句普通日志不该被改写。
    const plain = '第 12 章《夜访》摘要已写入';
    check('普通文本不受影响', logger.redact(plain) === plain, logger.redact(plain));

    // 进 emit 的两条路径（message 与 detail）都要过 redact。
    logger.clearLogs();
    const log = logger.scoped('测试');
    log.error('连接失败 sk-proj-abcdefghijklmnop', { key: 'sk-ant-api03-ZZZZwwww2222' });
    const entry = logger.recentLogs().at(-1);
    check('message 已脱敏', !entry.message.includes('abcdefghijklmnop'), entry.message);
    check('detail 已脱敏', !entry.detail.includes('wwww2222'), entry.detail);
  }

  console.log('\n== 缓冲 ==');
  {
    logger.clearLogs();
    const log = logger.scoped('压测');
    const over = logger.MAX_ENTRIES + 200;
    for (let i = 0; i < over; i++) {
      log.debug(`第 ${i} 条`);
    }
    const kept = logger.recentLogs();
    check('缓冲不超过上限', kept.length === logger.MAX_ENTRIES, `${kept.length}`);
    check('丢的是最旧的', kept[0].message === `第 ${over - logger.MAX_ENTRIES} 条`, kept[0].message);
    check('最新一条还在', kept.at(-1).message === `第 ${over - 1} 条`, kept.at(-1).message);
    check('seq 单调递增', kept.every((e, i) => i === 0 || e.seq > kept[i - 1].seq));

    // 缓冲永远收全量：sink 级别调高不该让日志页看不到 debug。
    logger.setSinkLevel('error');
    logger.clearLogs();
    log.debug('调试内容');
    check('调高 sink 级别后缓冲仍收 debug', logger.recentLogs().some((e) => e.level === 'debug'));
    logger.setSinkLevel('debug');

    logger.clearLogs();
    check('清空后只留一条痕迹', logger.recentLogs().length === 1, `${logger.recentLogs().length}`);
    check('痕迹说明日志被清过', logger.recentLogs()[0].message.includes('清空'));
  }

  console.log('\n== detail 截断 ==');
  {
    logger.clearLogs();
    logger.scoped('测试').info('长 detail', 'x'.repeat(50000));
    const entry = logger.recentLogs().at(-1);
    check('detail 被截断', entry.detail.length < 3000, `${entry.detail.length}`);
    check('截断处有说明', entry.detail.includes('省略'), entry.detail.slice(-40));
  }

  console.log('\n== sink ==');
  {
    logger.clearLogs();
    logger.setSinkLevel('debug');
    const seen = [];
    const sub = logger.addLogSink((e) => seen.push(e.message));
    const log = logger.scoped('测试');
    log.info('一');
    log.info('二');
    check('sink 收到每一条', seen.join(',') === '一,二', seen.join(','));

    sub.dispose();
    log.info('三');
    check('dispose 后不再收', !seen.includes('三'), seen.join(','));

    // sink 抛异常只能被吞掉，绝不能带崩调用方。
    const alive = [];
    const bad = logger.addLogSink(() => {
      throw new Error('sink 坏了');
    });
    const good = logger.addLogSink((e) => alive.push(e.message));
    let threw = false;
    try {
      log.info('四');
    } catch {
      threw = true;
    }
    check('坏 sink 不抛给调用方', !threw);
    check('坏 sink 不影响别的 sink', alive.includes('四'), alive.join(','));
    bad.dispose();
    good.dispose();

    // sink 里再打日志不能无限递归。
    const reentrant = logger.addLogSink(() => logger.scoped('回环').debug('sink 内部日志'));
    let recursed = false;
    try {
      log.info('五');
    } catch {
      recursed = true;
    }
    check('sink 内部再打日志不炸栈', !recursed);
    reentrant.dispose();

    // 级别过滤只作用于 sink。
    logger.setSinkLevel('warn');
    const filtered = [];
    const sub2 = logger.addLogSink((e) => filtered.push(e.level));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    check('sink 按级别过滤', filtered.join(',') === 'warn,error', filtered.join(','));
    sub2.dispose();
    logger.setSinkLevel('debug');
  }

  console.log('\n== 格式化 ==');
  {
    check('毫秒', logger.formatDuration(860) === '860ms', logger.formatDuration(860));
    check('秒', logger.formatDuration(3200) === '3.2s', logger.formatDuration(3200));
    check('分秒', logger.formatDuration(72000) === '1 分 12 秒', logger.formatDuration(72000));
    check('Error 取 message', logger.describeError(new Error('炸了')) === '炸了');
    check('字符串原样', logger.describeError('炸了') === '炸了');
    check('对象转 JSON', logger.describeError({ a: 1 }) === '{"a":1}', logger.describeError({ a: 1 }));

    logger.clearLogs();
    logger.scoped('测试').warn('一句话', '两行\n详情');
    const line = logger.formatLogEntry(logger.recentLogs().at(-1));
    check('单行含级别与来源', line.includes('WARN') && line.includes('测试'), line);
    check('detail 缩进在下一行', line.includes('\n    两行'), JSON.stringify(line));
  }

  console.log('\n== 长任务 ==');
  {
    hostProgressCalls.length = 0;
    check('起始时没有任务', progress.activeTasks().length === 0);

    const changes = [];
    const sub = progress.onTasksChanged(() => changes.push(progress.activeTasks().length));

    let snapshotDuring = null;
    const result = await progress.runTask('同步章节摘要', async ({ report }) => {
      report({ message: '第 1 章', current: 0, total: 3 });
      snapshotDuring = progress.activeTasks()[0];
      report({ message: '第 2 章', current: 1 });
      return '完成';
    });

    check('返回值透传', result === '完成', result);
    check('任务中能看到快照', !!snapshotDuring);
    check('快照带标题', snapshotDuring.title === '同步章节摘要', snapshotDuring.title);
    check('快照带文案', snapshotDuring.message === '第 1 章', snapshotDuring.message);
    check('快照带总数', snapshotDuring.total === 3, `${snapshotDuring.total}`);
    check('快照带耗时', typeof snapshotDuring.elapsedMs === 'number');
    check('结束后任务表清空', progress.activeTasks().length === 0);
    check('订阅收到过变化', changes.length > 0, `${changes.length}`);
    check(
      '宿主进度带 n/N',
      hostProgressCalls.some((c) => c.includes('（1/3）')),
      hostProgressCalls.join(' / ')
    );
    check(
      '宿主进度带前缀',
      hostProgressCalls.every((c) => c.startsWith('Novel Forge：')),
      hostProgressCalls[0]
    );
    sub.dispose();
  }

  console.log('\n== 长任务：只改一个字段 ==');
  {
    let snap = null;
    await progress.runTask('测试任务', async ({ report }) => {
      report({ message: '甲', current: 2, total: 9 });
      report('乙'); // 纯字符串：只改文案
      snap = progress.activeTasks()[0];
    });
    check('字符串 report 只改文案', snap.message === '乙', snap.message);
    check('current 沿用上次', snap.current === 2, `${snap.current}`);
    check('total 沿用上次', snap.total === 9, `${snap.total}`);
  }

  console.log('\n== 长任务：取消 ==');
  {
    let sawAbort = false;
    let idDuring = '';
    await progress.runTask('可取消任务', async ({ signal, report }) => {
      report({ message: '跑着', current: 0, total: 2 });
      idDuring = progress.activeTasks()[0].id;
      const cancelled = progress.cancelTask(idDuring);
      check('cancelTask 认得在跑的任务', cancelled);
      sawAbort = signal.aborted;
    });
    check('任务体看得到 aborted', sawAbort);
    check('取消后任务表也清空', progress.activeTasks().length === 0);
    check('对已结束的 id 返回 false', progress.cancelTask(idDuring) === false);
    check('对未知 id 返回 false', progress.cancelTask('task-不存在') === false);
  }

  console.log('\n== 长任务：抛异常 ==');
  {
    let caught = '';
    try {
      await progress.runTask('会失败的任务', async () => {
        throw new Error('故意失败');
      });
    } catch (err) {
      caught = err.message;
    }
    check('异常继续往上抛', caught === '故意失败', caught);
    check('失败后任务表清空', progress.activeTasks().length === 0);

    logger.clearLogs();
    try {
      await progress.runTask('再失败一次', async () => {
        throw new Error('又失败了');
      });
    } catch {
      /* 预期内 */
    }
    const errors = logger.recentLogs().filter((e) => e.level === 'error');
    check('失败进日志', errors.some((e) => e.message.includes('又失败了')), JSON.stringify(errors));
  }

  console.log('\n== 长任务：并发 ==');
  {
    let both = 0;
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
    check('两个任务能同时在表里', both === 2, `${both}`);
    check('都结束后表空了', progress.activeTasks().length === 0);
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
