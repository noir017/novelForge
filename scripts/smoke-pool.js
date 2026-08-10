/**
 * 并发工具与模型池的离线验证。
 *
 * 这两个模块是「工程页批量任务」提速的地基，出错的后果很隐蔽：
 * 并发数失控会撞服务商限流；fallback 挑错模型会把用户没配 Key 的模型
 * 也算进去；取消后还接着起新任务，用户点了「停止」却停不下来。
 * 这些都不是手测看得出来的，所以在这里用假 provider 全部钉住。
 *
 * 用法：node scripts/smoke-pool.js
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

/** 要用 Host / registry / config 模块级状态的模块必须打进同一个 bundle。 */
function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath}';`)
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

const { host: hostMod, concurrency, pool: poolMod, registry, provider: providerMod, logger } = loadBundle({
  host: './src/core/host.ts',
  concurrency: './src/core/concurrency.ts',
  pool: './src/core/llm/pool.ts',
  registry: './src/core/llm/registry.ts',
  provider: './src/core/llm/provider.ts',
  logger: './src/core/logger.ts',
});

const { runPool, serialize } = concurrency;
const { createModelPool } = poolMod;
const { CancelledError, LlmError } = providerMod;

// ---------------------------------------------------------------- 假宿主

/** 当前这一轮测试的配置。每个用例自己改。 */
let settings = {};
const inputs = [];
const warns = [];

const fakeHost = {
  name: 'standalone',
  supportsVscodeLm: true,
  config: { read: () => settings, write: async () => {} },
  input: async () => {
    inputs.push('prompted');
    return undefined;
  },
  confirm: async () => undefined,
  pick: async () => undefined,
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: () => {},
  selectionAttachment: async () => undefined,
};
hostMod.initHost(fakeHost);
logger.addLogSink((entry) => {
  if (entry.level === 'warn' || entry.level === 'error') {
    warns.push(`${entry.message} ${entry.detail ?? ''}`);
  }
});

// ---------------------------------------------------------------- 假模型
//
// 用 vscode-lm 这个 kind：它是唯一一条走 registerProviderFactory 的路径，
// 于是不必碰 SecretStore 就能塞进假模型（其余 kind 会去要 API Key）。

/** ref -> 这一轮该怎么表现。 */
let behavior = {};
/** 每次调用记一条 { ref }。 */
const calls = [];

registry.registerProviderFactory((active) => {
  const spec = behavior[active.ref];
  // 「这个模型在本环境构造不出来」——工厂返回 undefined 就是这个意思。
  if (spec === 'unavailable') {
    return undefined;
  }
  return {
    id: 'vscode-lm',
    label: active.ref,
    maxInputTokens: async () => undefined,
    chatStream: async function* () {
      calls.push({ ref: active.ref });
      if (spec === 'fail') {
        throw new LlmError(`${active.ref} 假装 429 限流`);
      }
      if (spec === 'cancel') {
        throw new CancelledError();
      }
      yield `ok:${active.ref}`;
    },
  };
});

/** 配 N 个模型（都在 vscode-lm 服务商 `p` 下）。 */
function configure(refs, extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: refs.map((r) => ({ name: r.slice(2) })) }],
    models: refs,
    ...extra,
  };
  calls.length = 0;
  inputs.length = 0;
  warns.length = 0;
}

/** 让 pool.run 的回调「调一次模型」。 */
const useModel = (llm) => providerMod.collectStream(llm.chatStream([], {}));

/**
 * 分档用的配置：providers 从「所有被提到的引用」推出来，
 * 于是档位里的模型也解析得出。`windows` 可给单个模型指定窗口。
 */
function configureTiers({ models = [], tierModels = {}, taskTiers = {}, windows = {}, ...extra }) {
  const all = [...models, ...Object.values(tierModels).flat()];
  const names = [...new Set(all.map((r) => r.slice(2)))];
  settings = {
    providers: [
      {
        id: 'p',
        kind: 'vscode-lm',
        models: names.map((name) => ({ name, ...(windows[`p/${name}`] ?? {}) })),
      },
    ],
    models,
    tierModels,
    taskTiers,
    ...extra,
  };
  calls.length = 0;
  inputs.length = 0;
  warns.length = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------------------------------------------------------------- runPool

  console.log('\n== runPool：并发上限与顺序 ==');
  {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const results = await runPool(items, 4, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5 + ((item * 7) % 11)); // 参差的耗时，制造乱序完成
      inFlight--;
      return item * 2;
    });
    check('并发峰值不超过 limit', peak <= 4, `峰值 ${peak}`);
    check('确实并发了（不是退化成串行）', peak > 1, `峰值 ${peak}`);
    check('每一项都有结果', results.length === 12);
    check(
      '结果按 index 对齐（完成顺序不影响）',
      results.every((r, i) => r.status === 'fulfilled' && r.value === i * 2)
    );
  }

  {
    const order = [];
    await runPool([1, 2, 3, 4], 1, async (item) => {
      order.push(`start${item}`);
      await sleep(2);
      order.push(`end${item}`);
    });
    check(
      'limit=1 严格串行（与改造前逐字一致）',
      order.join(',') === 'start1,end1,start2,end2,start3,end3,start4,end4',
      order.join(',')
    );
  }

  console.log('\n== runPool：失败与取消 ==');
  {
    const ran = [];
    const results = await runPool([1, 2, 3], 2, async (item) => {
      ran.push(item);
      if (item === 2) {
        throw new Error('第二项炸了');
      }
      return item;
    });
    check('单项失败不影响其余', ran.length === 3, ran.join(','));
    check('失败项标为 rejected', results[1].status === 'rejected');
    check('失败项带得出原因', String(results[1].reason.message).includes('第二项炸了'));
    check('其余项照常有值', results[0].value === 1 && results[2].value === 3);
  }

  {
    const abort = new AbortController();
    const ran = [];
    const results = await runPool(
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
    check('取消后不再启动新任务', ran.length === 2, `跑了 ${ran.join('、')}`);
    check('未启动的项留在结果里（占位为 CancelledError）', results.length === 6);
    check(
      '占位是取消而不是成功',
      results[5].status === 'rejected' && results[5].reason.name === 'CancelledError'
    );
  }

  {
    let done = 0;
    const seen = [];
    await runPool([1, 2, 3, 4], 3, async (i) => sleep(3 + i), {
      onSettled: (_r, item, _i, finished) => {
        done = finished;
        seen.push(`${item}:${finished}`);
      },
    });
    check('onSettled 的计数单调递增到总数', done === 4, seen.join(' '));
    check(
      'onSettled 的计数没有重复（进度条不会倒退）',
      new Set(seen.map((s) => s.split(':')[1])).size === 4,
      seen.join(' ')
    );
  }

  console.log('\n== serialize：审阅排队 ==');
  {
    let inFlight = 0;
    let peak = 0;
    const order = [];
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
    check('同一时刻只有一个在跑', peak === 1, `峰值 ${peak}`);
    check('按入队顺序执行', order.join(',') === '1,2,3', order.join(','));
  }

  {
    // 一次审阅抛错不能卡死后面排队的（用户放弃某张卡后其余还得能弹）。
    const after = [];
    const boom = serialize(async () => {
      throw new Error('审阅炸了');
    }).catch((e) => after.push(`caught:${e.message}`));
    const next = serialize(async () => {
      after.push('next-ran');
    });
    await Promise.all([boom, next]);
    check('前一个抛错不影响后面排队的', after.includes('next-ran'), after.join(','));
    check('异常照旧抛给它自己的调用方', after.some((s) => s.startsWith('caught:')));
  }

  // ---------------------------------------------------------------- 模型池

  console.log('\n== 模型池：构造 ==');
  {
    behavior = {};
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
    check('三个模型都进了池', pool && pool.size === 3, pool && pool.refs.join('、'));
    check('label 报得出数量', pool.label.includes('3 个模型'), pool.label);
    check('primary 是第一个', pool.primary.label === 'p/a', pool.primary.label);
  }

  {
    behavior = { 'p/b': 'unavailable' };
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary' });
    check('构造不出来的模型被剔除', pool.refs.join(',') === 'p/a,p/c', pool.refs.join(','));
    check('剔除时说清是谁、为什么', warns.some((w) => w.includes('p/b')), warns.join(' | '));
    check('剔除备选模型时不弹输入框', inputs.length === 0, `弹了 ${inputs.length} 次`);
  }

  {
    behavior = {};
    configure(['p/a', 'nosuch/x', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary' });
    check('解析不出的引用被剔除', pool.refs.join(',') === 'p/a,p/c', pool.refs.join(','));
    check(
      '解析失败的原因写进日志',
      warns.some((w) => w.includes('nosuch/x')),
      warns.join(' | ')
    );
  }

  {
    behavior = { 'p/a': 'unavailable' };
    configure(['p/a']);
    const pool = await createModelPool({ task: 'chapterSummary' });
    check('一个可用模型都没有时返回 undefined', pool === undefined);
  }

  console.log('\n== 模型池：并发轮转（负载均衡） ==');
  {
    behavior = {};
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
    for (let i = 0; i < 6; i++) {
      await pool.run(`第 ${i} 项`, useModel);
    }
    const counts = {};
    for (const c of calls) {
      counts[c.ref] = (counts[c.ref] ?? 0) + 1;
    }
    check(
      '6 次调用均摊到 3 个模型',
      counts['p/a'] === 2 && counts['p/b'] === 2 && counts['p/c'] === 2,
      JSON.stringify(counts)
    );
    check(
      '轮转是按配置顺序起步的',
      calls.slice(0, 3).map((c) => c.ref).join(',') === 'p/a,p/b,p/c',
      calls.map((c) => c.ref).join(',')
    );
  }

  console.log('\n== 模型池：串行恒用首选 ==');
  {
    behavior = {};
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    for (let i = 0; i < 4; i++) {
      await pool.run('x', useModel);
    }
    check(
      '串行模式每次都用第一个',
      calls.every((c) => c.ref === 'p/a'),
      calls.map((c) => c.ref).join(',')
    );
  }

  console.log('\n== 模型池：随机 fallback ==');
  {
    behavior = { 'p/a': 'fail' };
    configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 2 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    const text = await pool.run('第 1 章', useModel);
    check('首选失败后换了别的模型', text !== 'ok:p/a' && text.startsWith('ok:p/'), text);
    check('换的是列表里的其余模型', ['ok:p/b', 'ok:p/c'].includes(text), text);
    check('第一次仍然先试首选', calls[0].ref === 'p/a', calls.map((c) => c.ref).join(','));
    check('换模型时留下 warn', warns.some((w) => w.includes('改用')), warns.join(' | '));
  }

  {
    behavior = { 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' };
    configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 1 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    let err;
    try {
      await pool.run('第 1 章', useModel);
    } catch (e) {
      err = e;
    }
    check('全失败时把错误抛出去', !!err, String(err));
    check('重试次数不超过 fallbackAttempts', calls.length === 2, `调了 ${calls.length} 次`);
  }

  {
    behavior = { 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' };
    configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 5 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    await pool.run('第 1 章', useModel).catch(() => {});
    check('不会把同一个模型试两遍', new Set(calls.map((c) => c.ref)).size === calls.length, calls.map((c) => c.ref).join(','));
    check('最多把池里每个模型试一遍', calls.length === 3, `调了 ${calls.length} 次`);
  }

  {
    behavior = { 'p/a': 'fail' };
    configure(['p/a'], { fallbackAttempts: 3 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    await pool.run('第 1 章', useModel).catch(() => {});
    check('池里只有一个模型时不重试（换谁都是它自己）', calls.length === 1, `调了 ${calls.length} 次`);
  }

  {
    behavior = { 'p/a': 'cancel' };
    configure(['p/a', 'p/b'], { fallbackAttempts: 3 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    let err;
    try {
      await pool.run('第 1 章', useModel);
    } catch (e) {
      err = e;
    }
    check('用户取消时不 fallback', calls.length === 1, `调了 ${calls.length} 次`);
    check('取消原样上抛', err && err.name === 'CancelledError', String(err));
  }

  {
    behavior = {};
    configure(['p/a', 'p/b'], { fallbackAttempts: 0 });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    behavior = { 'p/a': 'fail' };
    await pool.run('第 1 章', useModel).catch(() => {});
    check('fallbackAttempts=0 时不重试', calls.length === 1, `调了 ${calls.length} 次`);
  }

  // ---------------------------------------------------------------- 模型分档

  console.log('\n== 模型分档：档位生效 ==');
  {
    behavior = {};
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], balanced: ['p/mid'], quality: ['p/smart'] },
    });
    const fast = await createModelPool({ task: 'chapterSummary' });
    const merge = await createModelPool({ task: 'globalSummaryMerge' });
    const card = await createModelPool({ task: 'characterCard' });
    check('单章摘要走快速档', fast.refs.join(',') === 'p/cheap', fast.refs.join(','));
    check('全书摘要最终合并走精标档', merge.refs.join(',') === 'p/smart', merge.refs.join(','));
    check('角色卡走均衡档', card.refs.join(',') === 'p/mid', card.refs.join(','));
    check('label 里带档位名', fast.label.includes('快速档'), fast.label);
    check(
      '分档不动对话页的当前模型',
      settings.models.join(',') === 'p/writer',
      settings.models.join(',')
    );
  }

  console.log('\n== 模型分档：空档位继承默认模型 ==');
  {
    behavior = {};
    configureTiers({ models: ['p/a', 'p/b'], tierModels: {} });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
    check('三档全空时沿用 models', pool.refs.join(',') === 'p/a,p/b', pool.refs.join(','));
    check('label 说明是沿用来的', pool.label.includes('未配置，沿用默认模型'), pool.label);
    // 分档之前的行为：并发轮转、失败换人，一条都不能少。
    behavior = {};
    for (let i = 0; i < 4; i++) {
      await pool.run(`第 ${i} 项`, useModel);
    }
    check(
      '未配档时并发轮转与分档前一致',
      calls.map((c) => c.ref).join(',') === 'p/a,p/b,p/a,p/b',
      calls.map((c) => c.ref).join(',')
    );
  }

  {
    // 只配了快速档：其余两档的任务仍走默认模型，不该被快速档顺手接管。
    behavior = {};
    configureTiers({ models: ['p/writer'], tierModels: { fast: ['p/cheap'] } });
    const fast = await createModelPool({ task: 'chapterSummary' });
    const merge = await createModelPool({ task: 'globalSummaryMerge' });
    check('配了的档用自己的模型', fast.refs.join(',') === 'p/cheap', fast.refs.join(','));
    check('没配的档仍继承 models', merge.refs.join(',') === 'p/writer', merge.refs.join(','));
  }

  console.log('\n== 模型分档：任务归档的覆盖 ==');
  {
    behavior = {};
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      // 内置默认里单章摘要是快速档，这里改成精标。
      taskTiers: { chapterSummary: 'quality' },
    });
    const pool = await createModelPool({ task: 'chapterSummary' });
    check('覆盖优先于内置默认', pool.refs.join(',') === 'p/smart', pool.refs.join(','));

    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      taskTiers: { chapterSummary: '超级档', nosuchTask: 'fast' },
    });
    const fallbackPool = await createModelPool({ task: 'chapterSummary' });
    check(
      '非法档位名退回内置默认而不是崩',
      fallbackPool.refs.join(',') === 'p/cheap',
      fallbackPool.refs.join(',')
    );
  }

  console.log('\n== 模型分档：fallback 不跨档 ==');
  {
    // behavior 要在建池**之前**定：假工厂在构造 provider 时就把它读走了。
    behavior = { 'p/cheap': 'fail' };
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap', 'p/cheap2'], quality: ['p/smart'] },
      fallbackAttempts: 5,
    });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    await pool.run('第 1 章', useModel).catch(() => {});
    const used = calls.map((c) => c.ref);
    check('档内换人照旧生效', used.includes('p/cheap2'), used.join(','));
    check('绝不升级到精标档的模型', !used.includes('p/smart'), used.join(','));
  }

  {
    // 档内只有一个模型：无人可换，照旧上抛，不去别的档找。
    behavior = { 'p/cheap': 'fail' };
    configureTiers({
      models: ['p/writer', 'p/spare'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      fallbackAttempts: 5,
    });
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    let err;
    try {
      await pool.run('第 1 章', useModel);
    } catch (e) {
      err = e;
    }
    check('档内无人可换时不重试', calls.length === 1, `调了 ${calls.length} 次`);
    check('错误照旧上抛', !!err, String(err));
    check(
      '也不去 models 里捞人',
      !calls.some((c) => c.ref === 'p/writer' || c.ref === 'p/spare'),
      calls.map((c) => c.ref).join(',')
    );
  }

  console.log('\n== 模型分档：Key 输入框与预算 ==');
  {
    behavior = { 'p/cheap2': 'unavailable' };
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap', 'p/cheap2'] },
    });
    const pool = await createModelPool({ task: 'chapterSummary' });
    check('档内备选缺 Key 被剔除', pool.refs.join(',') === 'p/cheap', pool.refs.join(','));
    check('剔除档内备选时不弹输入框', inputs.length === 0, `弹了 ${inputs.length} 次`);
    check('剔除原因写进日志', warns.some((w) => w.includes('p/cheap2')), warns.join(' | '));
  }

  {
    behavior = {};
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      windows: {
        'p/writer': { contextWindow: 200000, maxOutputTokens: 8000 },
        'p/cheap': { contextWindow: 32000, maxOutputTokens: 2000 },
      },
      contextWindow: 128000,
      maxOutputTokens: 4096,
    });
    const fast = await createModelPool({ task: 'chapterSummary' });
    const merge = await createModelPool({ task: 'globalSummaryMerge' });
    check(
      'primaryBudget 取该档首选的窗口，不是对话页模型的',
      fast.primaryBudget.contextWindow === 32000,
      String(fast.primaryBudget.contextWindow)
    );
    check(
      'primaryBudget 的输出上限同样跟着该档走',
      fast.primaryBudget.maxOutputTokens === 2000,
      String(fast.primaryBudget.maxOutputTokens)
    );
    check(
      '模型没自带窗口时退回兼容值',
      merge.primaryBudget.contextWindow === 128000 && merge.primaryBudget.maxOutputTokens === 4096,
      JSON.stringify(merge.primaryBudget)
    );
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
