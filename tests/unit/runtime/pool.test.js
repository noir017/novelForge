/**
 * 模型池：构造与剔除、并发轮转、串行恒用首选、随机 fallback，以及模型分档在池上的落法。
 * 迁自 scripts/smoke-pool.js 的 `== 模型池：… ==` 与 `== 模型分档：… ==` 各节。
 *
 * 出错的后果很隐蔽：fallback 挑错模型会把用户没配 Key 的模型也算进去；取消后还接着
 * 起新任务，用户点了「停止」却停不下来。这些手测都看不出来，所以用假 provider 全部钉住。
 *
 * host / registry / config 都有模块级状态，所以这几个模块必须打进同一个 bundle。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');

/** 当前这一轮测试的配置。每个用例自己改。 */
let settings = {};
/** ref -> 这一轮该怎么表现。注意：必须**就地改**，假工厂是按引用闭包捕获它的。 */
const behavior = {};
const warns = [];

let createModelPool;
let collectStream;
let fake;
let host;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    concurrency: './src/core/runtime/concurrency.ts',
    pool: './src/core/llm/pool.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    logger: './src/core/runtime/logger.ts',
  });

  ({ createModelPool } = bundle.pool);
  ({ collectStream } = bundle.provider);

  host = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(host.host);

  bundle.logger.addLogSink((entry) => {
    if (entry.level === 'warn' || entry.level === 'error') {
      warns.push(`${entry.message} ${entry.detail ?? ''}`);
    }
  });

  // 假模型走 vscode-lm 这个 kind：它是唯一一条走 registerProviderFactory 的路径，
  // 于是不必碰 SecretStore 就能塞进假模型（其余 kind 会去要 API Key）。
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    // helper 在记下 calls 之后会给该条打上 .ref，所以这里拿得到当前模型引用。
    reply: (messages) => `ok:${messages.ref}`,
  });
});

/** 代替迁移前的 `behavior = {...}`：helper 闭包捕获了这个对象，只能就地改。 */
function setBehavior(next) {
  for (const key of Object.keys(behavior)) delete behavior[key];
  Object.assign(behavior, next);
}

/** 配 N 个模型（都在 vscode-lm 服务商 `p` 下）。 */
function configure(refs, extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: refs.map((r) => ({ name: r.slice(2) })) }],
    models: refs,
    ...extra,
  };
  fake.reset();
  host.inputs.length = 0;
  warns.length = 0;
}

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
  fake.reset();
  host.inputs.length = 0;
  warns.length = 0;
}

/** 让 pool.run 的回调「调一次模型」。 */
const useModel = (llm) => collectStream(llm.chatStream([], {}));
/** 这一轮实际调过的模型引用。 */
const usedRefs = () => fake.calls.map((c) => c.ref);

describe('模型池：构造', () => {
  describe('三个模型都可用', () => {
    let pool;

    before(async () => {
      setBehavior({});
      configure(['p/a', 'p/b', 'p/c']);
      pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
    });

    test('三个模型都进了池', () => {
      assert.ok(pool && pool.size === 3, pool && pool.refs.join('、'));
    });

    test('label 报得出数量', () => {
      assert.ok(pool.label.includes('3 个模型'), pool.label);
    });

    test('primary 是第一个', () => {
      assert.equal(pool.primary.label, 'p/a', pool.primary.label);
    });
  });

  describe('构造不出来的被剔除', () => {
    let pool;
    let warnText;
    let inputCount;

    before(async () => {
      setBehavior({ 'p/b': 'unavailable' });
      configure(['p/a', 'p/b', 'p/c']);
      pool = await createModelPool({ task: 'chapterSummary' });
      warnText = warns.join(' | ');
      inputCount = host.inputs.length;
    });

    test('构造不出来的模型被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/c', pool.refs.join(','));
    });

    test('剔除时说清是谁、为什么', () => {
      assert.ok(warnText.includes('p/b'), warnText);
    });

    test('剔除备选模型时不弹输入框', () => {
      assert.equal(inputCount, 0, `弹了 ${inputCount} 次`);
    });
  });

  describe('解析不出的引用被剔除', () => {
    let pool;
    let warnText;

    before(async () => {
      setBehavior({});
      configure(['p/a', 'nosuch/x', 'p/c']);
      pool = await createModelPool({ task: 'chapterSummary' });
      warnText = warns.join(' | ');
    });

    test('解析不出的引用被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/c', pool.refs.join(','));
    });

    test('解析失败的原因写进日志', () => {
      assert.ok(warnText.includes('nosuch/x'), warnText);
    });
  });

  describe('一个都不可用', () => {
    let pool;

    before(async () => {
      setBehavior({ 'p/a': 'unavailable' });
      configure(['p/a']);
      pool = await createModelPool({ task: 'chapterSummary' });
    });

    test('一个可用模型都没有时返回 undefined', () => {
      assert.equal(pool, undefined);
    });
  });
});

describe('模型池：并发轮转（负载均衡）', () => {
  let counts;

  before(async () => {
    setBehavior({});
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
    for (let i = 0; i < 6; i++) {
      await pool.run(`第 ${i} 项`, useModel);
    }
    counts = {};
    for (const ref of usedRefs()) {
      counts[ref] = (counts[ref] ?? 0) + 1;
    }
  });

  test('6 次调用均摊到 3 个模型', () => {
    assert.equal(counts['p/a'], 2, JSON.stringify(counts));
    assert.equal(counts['p/b'], 2, JSON.stringify(counts));
    assert.equal(counts['p/c'], 2, JSON.stringify(counts));
  });

  test('轮转是按配置顺序起步的', () => {
    assert.equal(usedRefs().slice(0, 3).join(','), 'p/a,p/b,p/c', usedRefs().join(','));
  });
});

describe('模型池：串行恒用首选', () => {
  before(async () => {
    setBehavior({});
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
    for (let i = 0; i < 4; i++) {
      await pool.run('x', useModel);
    }
  });

  test('串行模式每次都用第一个', () => {
    assert.ok(usedRefs().every((ref) => ref === 'p/a'), usedRefs().join(','));
  });
});

describe('模型池：随机 fallback', () => {
  describe('首选失败换人', () => {
    let text;
    let warnText;

    before(async () => {
      setBehavior({ 'p/a': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 2 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      text = await pool.run('第 1 章', useModel);
      warnText = warns.join(' | ');
    });

    test('首选失败后换了别的模型', () => {
      assert.notEqual(text, 'ok:p/a', text);
      assert.ok(text.startsWith('ok:p/'), text);
    });

    test('换的是列表里的其余模型', () => {
      assert.ok(['ok:p/b', 'ok:p/c'].includes(text), text);
    });

    test('第一次仍然先试首选', () => {
      assert.equal(usedRefs()[0], 'p/a', usedRefs().join(','));
    });

    test('换模型时留下 warn', () => {
      assert.ok(warnText.includes('改用'), warnText);
    });
  });

  describe('全都失败', () => {
    let err;

    before(async () => {
      setBehavior({ 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 1 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('全失败时把错误抛出去', () => {
      assert.ok(!!err, String(err));
    });

    test('重试次数不超过 fallbackAttempts', () => {
      assert.equal(fake.callCount(), 2, `调了 ${fake.callCount()} 次`);
    });
  });

  describe('重试上限大于池子', () => {
    before(async () => {
      setBehavior({ 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 5 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    test('不会把同一个模型试两遍', () => {
      assert.equal(new Set(usedRefs()).size, usedRefs().length, usedRefs().join(','));
    });

    test('最多把池里每个模型试一遍', () => {
      assert.equal(fake.callCount(), 3, `调了 ${fake.callCount()} 次`);
    });
  });

  describe('池里只有一个模型', () => {
    before(async () => {
      setBehavior({ 'p/a': 'fail' });
      configure(['p/a'], { fallbackAttempts: 3 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    test('池里只有一个模型时不重试（换谁都是它自己）', () => {
      assert.equal(fake.callCount(), 1, `调了 ${fake.callCount()} 次`);
    });
  });

  describe('用户取消', () => {
    let err;

    before(async () => {
      setBehavior({ 'p/a': 'cancel' });
      configure(['p/a', 'p/b'], { fallbackAttempts: 3 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('用户取消时不 fallback', () => {
      assert.equal(fake.callCount(), 1, `调了 ${fake.callCount()} 次`);
    });

    test('取消原样上抛', () => {
      assert.ok(err && err.name === 'CancelledError', String(err));
    });
  });

  describe('fallbackAttempts=0', () => {
    before(async () => {
      setBehavior({});
      configure(['p/a', 'p/b'], { fallbackAttempts: 0 });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      // 逐字迁自 smoke-pool.js:426-432，包括这一行的位置。
      setBehavior({ 'p/a': 'fail' });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    // 注意：这条断言是空转的，迁移时原样保留。假工厂在 createModelPool **建池时**
    // 就把 behavior[ref] 读进了 spec（同文件 `fallback 不跨档` 一节的注释说的就是这件事），
    // 所以上面那次「建池之后」才设的 'p/a': 'fail' 根本不生效——p/a 压根没失败。
    // 于是 callCount === 1 只说明「成功调用了一次」，
    // **并不能证明 fallbackAttempts=0 关掉了重试**。要真测这件事，behavior 必须在建池前设好。
    test('fallbackAttempts=0 时不重试', () => {
      assert.equal(fake.callCount(), 1, `调了 ${fake.callCount()} 次`);
    });
  });
});

describe('模型分档：档位生效', () => {
  let fast;
  let merge;
  let card;

  before(async () => {
    setBehavior({});
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], balanced: ['p/mid'], quality: ['p/smart'] },
    });
    fast = await createModelPool({ task: 'chapterSummary' });
    merge = await createModelPool({ task: 'globalSummaryMerge' });
    card = await createModelPool({ task: 'characterCard' });
  });

  test('单章摘要走快速档', () => {
    assert.equal(fast.refs.join(','), 'p/cheap', fast.refs.join(','));
  });

  test('全书摘要最终合并走精标档', () => {
    assert.equal(merge.refs.join(','), 'p/smart', merge.refs.join(','));
  });

  test('角色卡走均衡档', () => {
    assert.equal(card.refs.join(','), 'p/mid', card.refs.join(','));
  });

  test('label 里带档位名', () => {
    assert.ok(fast.label.includes('快速档'), fast.label);
  });

  test('分档不动对话页的当前模型', () => {
    assert.equal(settings.models.join(','), 'p/writer', settings.models.join(','));
  });
});

describe('模型分档：空档位继承默认模型', () => {
  describe('三档全空', () => {
    let pool;

    before(async () => {
      setBehavior({});
      configureTiers({ models: ['p/a', 'p/b'], tierModels: {} });
      pool = await createModelPool({ task: 'chapterSummary', concurrent: true });
      // 分档之前的行为：并发轮转、失败换人，一条都不能少。
      setBehavior({});
      for (let i = 0; i < 4; i++) {
        await pool.run(`第 ${i} 项`, useModel);
      }
    });

    test('三档全空时沿用 models', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/b', pool.refs.join(','));
    });

    test('label 说明是沿用来的', () => {
      assert.ok(pool.label.includes('未配置，沿用默认模型'), pool.label);
    });

    test('未配档时并发轮转与分档前一致', () => {
      assert.equal(usedRefs().join(','), 'p/a,p/b,p/a,p/b', usedRefs().join(','));
    });
  });

  describe('只配了快速档', () => {
    let fast;
    let merge;

    before(async () => {
      // 只配了快速档：其余两档的任务仍走默认模型，不该被快速档顺手接管。
      setBehavior({});
      configureTiers({ models: ['p/writer'], tierModels: { fast: ['p/cheap'] } });
      fast = await createModelPool({ task: 'chapterSummary' });
      merge = await createModelPool({ task: 'globalSummaryMerge' });
    });

    test('配了的档用自己的模型', () => {
      assert.equal(fast.refs.join(','), 'p/cheap', fast.refs.join(','));
    });

    test('没配的档仍继承 models', () => {
      assert.equal(merge.refs.join(','), 'p/writer', merge.refs.join(','));
    });
  });
});

describe('模型分档：任务归档的覆盖', () => {
  let pool;
  let fallbackPool;

  before(async () => {
    setBehavior({});
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      // 内置默认里单章摘要是快速档，这里改成精标。
      taskTiers: { chapterSummary: 'quality' },
    });
    pool = await createModelPool({ task: 'chapterSummary' });

    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      taskTiers: { chapterSummary: '超级档', nosuchTask: 'fast' },
    });
    fallbackPool = await createModelPool({ task: 'chapterSummary' });
  });

  test('覆盖优先于内置默认', () => {
    assert.equal(pool.refs.join(','), 'p/smart', pool.refs.join(','));
  });

  test('非法档位名退回内置默认而不是崩', () => {
    assert.equal(fallbackPool.refs.join(','), 'p/cheap', fallbackPool.refs.join(','));
  });
});

describe('模型分档：fallback 不跨档', () => {
  describe('档内还有人可换', () => {
    let used;

    before(async () => {
      // behavior 要在建池**之前**定：假工厂在构造 provider 时就把它读走了。
      setBehavior({ 'p/cheap': 'fail' });
      configureTiers({
        models: ['p/writer'],
        tierModels: { fast: ['p/cheap', 'p/cheap2'], quality: ['p/smart'] },
        fallbackAttempts: 5,
      });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
      used = usedRefs();
    });

    test('档内换人照旧生效', () => {
      assert.ok(used.includes('p/cheap2'), used.join(','));
    });

    test('绝不升级到精标档的模型', () => {
      assert.ok(!used.includes('p/smart'), used.join(','));
    });
  });

  describe('档内无人可换', () => {
    let err;

    before(async () => {
      // 档内只有一个模型：无人可换，照旧上抛，不去别的档找。
      setBehavior({ 'p/cheap': 'fail' });
      configureTiers({
        models: ['p/writer', 'p/spare'],
        tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
        fallbackAttempts: 5,
      });
      const pool = await createModelPool({ task: 'chapterSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('档内无人可换时不重试', () => {
      assert.equal(fake.callCount(), 1, `调了 ${fake.callCount()} 次`);
    });

    test('错误照旧上抛', () => {
      assert.ok(!!err, String(err));
    });

    test('也不去 models 里捞人', () => {
      assert.ok(
        !usedRefs().some((ref) => ref === 'p/writer' || ref === 'p/spare'),
        usedRefs().join(',')
      );
    });
  });
});

describe('模型分档：Key 输入框与预算', () => {
  describe('档内备选缺 Key', () => {
    let pool;
    let inputCount;
    let warnText;

    before(async () => {
      setBehavior({ 'p/cheap2': 'unavailable' });
      configureTiers({
        models: ['p/writer'],
        tierModels: { fast: ['p/cheap', 'p/cheap2'] },
      });
      pool = await createModelPool({ task: 'chapterSummary' });
      inputCount = host.inputs.length;
      warnText = warns.join(' | ');
    });

    test('档内备选缺 Key 被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/cheap', pool.refs.join(','));
    });

    test('剔除档内备选时不弹输入框', () => {
      assert.equal(inputCount, 0, `弹了 ${inputCount} 次`);
    });

    test('剔除原因写进日志', () => {
      assert.ok(warnText.includes('p/cheap2'), warnText);
    });
  });

  describe('预算跟着档位走', () => {
    let fast;
    let merge;

    before(async () => {
      setBehavior({});
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
      fast = await createModelPool({ task: 'chapterSummary' });
      merge = await createModelPool({ task: 'globalSummaryMerge' });
    });

    test('primaryBudget 取该档首选的窗口，不是对话页模型的', () => {
      assert.equal(fast.primaryBudget.contextWindow, 32000, String(fast.primaryBudget.contextWindow));
    });

    test('primaryBudget 的输出上限同样跟着该档走', () => {
      assert.equal(fast.primaryBudget.maxOutputTokens, 2000, String(fast.primaryBudget.maxOutputTokens));
    });

    test('模型没自带窗口时退回兼容值', () => {
      assert.equal(merge.primaryBudget.contextWindow, 128000, JSON.stringify(merge.primaryBudget));
      assert.equal(merge.primaryBudget.maxOutputTokens, 4096, JSON.stringify(merge.primaryBudget));
    });
  });
});
