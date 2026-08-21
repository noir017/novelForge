/**
 * 全量 node 测试的调度器：把测试分两组**并行**跑，各用对它最省的进程策略。
 *
 * ## 为什么不是一条 `node --test` 命令
 *
 * 两组测试的开销结构完全不同，一条命令喂不了两种胃口：
 *
 * - **`dom/`**：每个文件都要 `require('jsdom')`，那一下就是 **1.9 秒**。`node:test`
 *   默认每文件一个进程，十八个 dom 文件于是把这笔钱付了十八遍（约 34 秒纯 CPU）。
 *   这组走 `--experimental-test-isolation=none`：**整组一个进程**，jsdom 只加载一次。
 *   dom 用例本来就只读 `dist/media/` 的产物、各自 `mount()` 出独立的 jsdom，
 *   没有跨文件的进程级状态，合进一个进程是安全的。
 * - **`unit/` `integration/` `contract/`**：反过来——它们**依赖进程隔离**。
 *   `loadBundle` 出来的 `host.ts` / `registry.ts` 是模块级单例，`generateTool` 那些
 *   用例还会各自 `initHost` 一次；合进一个进程会互相踩（试过，六条挂）。
 *   这组保持每文件一进程，只把并发调高。
 *
 * 两组之间没有任何共享状态，所以直接并行，墙上时间取两者较慢的那个。
 *
 * ## 三笔省下来的开销
 *
 * | 手段 | 省掉什么 |
 * |---|---|
 * | dom 整组一个进程 | 17 次多余的 jsdom 加载 |
 * | `NODE_COMPILE_CACHE` | 每个进程重复编译 node 内部模块与依赖的字节码 |
 * | `tests/helpers/load.js` 的磁盘缓存 | 七十多个进程各自重跑一遍 esbuild |
 *
 * 并发数取 `availableParallelism - 1`（留一核给 dom 那组），下限 2。
 * 机器核多不见得越快——两组本就在抢同一批核，压太满反而慢。
 *
 * ## `--all`：连 typecheck 与 e2e 一起
 *
 * `npm test` 从前是 `typecheck && test:node && test:e2e` 串成一条，三段各自等前一段
 * 跑完，而它们**彼此不依赖**（typecheck 只读源码，e2e 起自己的服务）。加 `--all`
 * 把这三件事与上面两组一起并行，墙上时间取最慢的那一个。
 *
 * 任何一段失败都让整体退非零，且**所有段都会跑完**——一次就把全部问题看清，
 * 而不是修一个再发现下一个。
 *
 * 用法：`node scripts/run-tests.js`（即 `npm run test:node`）
 *      `node scripts/run-tests.js --all`（即 `npm test`）
 *   NF_TEST_CONCURRENCY=n  手动指定非 dom 那组的并发数
 * 其余环境变量（NF_TEST_LOGS / NF_TEST_STACK / NF_TEST_MAX_FAILS）原样传给 reporter。
 */
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPORTER = './tests/reporters/quiet.mjs';
const ALL = process.argv.includes('--all');

/** 编译缓存落在 node_modules/.cache 下——已被 .gitignore 挡住，npm ci 会清掉。 */
const COMPILE_CACHE = path.join(ROOT, 'node_modules', '.cache', 'nf-node-compile');

const cpus = os.availableParallelism?.() ?? os.cpus().length;
const CONCURRENCY = Number(process.env.NF_TEST_CONCURRENCY) || Math.max(2, cpus - 1);

/** 两组测试。`isolation: 'none'` 那组整组共用一个进程。 */
const GROUPS = [
  {
    name: 'dom',
    args: ['--experimental-test-isolation=none', 'tests/dom/**/*.test.js'],
  },
  {
    name: 'node',
    args: [`--test-concurrency=${CONCURRENCY}`, 'tests/{unit,integration,contract}/**/*.test.js'],
  },
];

/**
 * `--all` 时一起并行的另外两件事。
 *
 * 走 `--ignore-scripts` **绕开 pre 钩子**：`pretypecheck` 与 `pretest:e2e` 都会跑
 * `embed-media`（内含 `build-media`），而 dom 那组正在读 `dist/media/` 的产物——
 * 三件事并行时那就是一边读一边被重写。资源改由下面的 `prepare()` 在**开跑前**
 * 统一生成一次，谁都不必自己再来一遍。
 */
const EXTRA = [
  { name: 'typecheck', cmd: 'npm', args: ['run', '--ignore-scripts', 'typecheck'] },
  { name: 'e2e', cmd: 'npm', args: ['run', '--ignore-scripts', 'test:e2e'] },
];

/**
 * 跑一组，把输出**攒起来**最后一次吐掉。
 *
 * 不直接透传 stdout：几件事并行，交错的输出会把「哪条失败属于哪件」搅乱。
 * reporter 本来就只吐失败与一行总计，攒完再打不会有延迟感。
 */
function run(name, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, NODE_COMPILE_CACHE: COMPILE_CACHE },
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm / bun 在 Windows 上是 .cmd，不走 shell 起不来。
      shell: cmd !== process.execPath,
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('error', (e) => resolve({ name, code: 1, out: out + String(e) }));
    child.on('close', (code) => resolve({ name, code: code ?? 1, out }));
  });
}

const runGroup = (g) =>
  run(g.name, process.execPath, ['--test', `--test-reporter=${REPORTER}`, ...g.args]);

/**
 * 开跑前把前端资源生成好：`dist/media/` 的产物（dom 那组要读）与
 * `mediaAssets.ts`（typecheck 与 e2e 要读）。
 *
 * **必须在这里做完，不能留给各段的 pre 钩子**——并行时那些钩子会同时重写同一批
 * 文件，而 dom 那组正拿着它们跑。串行地做一次，之后全程只读。
 */
async function prepare() {
  const r = await run('资源', process.execPath, ['scripts/embed-media.js']);
  if (r.code !== 0) {
    process.stdout.write(`\n✗ 前端资源生成失败\n${r.out}\n`);
    process.exit(1);
  }
}

(async () => {
  const started = Date.now();
  await prepare();

  const jobs = [
    ...GROUPS.map((g) => () => runGroup(g)),
    ...(ALL ? EXTRA.map((e) => () => run(e.name, e.cmd, e.args)) : []),
  ];
  const results = await Promise.all(jobs.map((j) => j()));

  for (const { name, code, out } of results) {
    const body = out.trim();
    // 全绿的 typecheck 没有输出，别为它印一个空标题。
    if (!body && code === 0) continue;
    process.stdout.write(`\n──── ${name} ────\n${body}\n`);
  }

  const failed = results.filter((r) => r.code !== 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    failed.length
      ? `\n✗ ${failed.map((r) => r.name).join(' / ')} 有失败，合计 ${secs}s\n`
      : `\n✓ ${results.length} 组全绿（${results.map((r) => r.name).join(' / ')}），合计 ${secs}s\n`
  );
  process.exit(failed.length ? 1 : 0);
})();
