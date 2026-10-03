/**
 * 带 action 的工具共用的那一套（`tools/novel/actions.ts` 的 `defineActionTool`）。
 *
 * 六个工具（pipeline / summary / characters / extract / book / skills）各有一张动作表，
 * 参数校验、拒绝清单、描述、闸门、记账都由这一个工厂做。各工具自己的行为在同目录的
 * `<工具>Tool.test.js`；这里只钉工厂那一层：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 删除 / 改名 / 移动 / 拆分 / 卸载……被当成「有意不给」拦下 | 「认不出」会让模型换十个名字继续试；「这是有意的」能让它停下来 |
 * | 认不出的动作列出这个工具可用的动作 | 列表里只有这个工具的，模型不会跨工具去点 |
 * | 给了动作不认的参数当场报错，说清谁认 | 以为传了一个区间、其实被忽略，比多一次往返更糟 |
 * | 缺必填参数当场报错，带参数说明，不跑 | 不放它跑一趟空的 |
 * | 描述列出每个动作，标「调模型 / 不调模型」 | 模型据此决定要不要先问作者 |
 * | schema 是扁平标量，action 必填且是枚举 | 外部 agent 填嵌套对象最容易填错 |
 * | 记账：报几次记几次；参数错不算执行失败 | 第 4 条 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const ACTION_TOOLS = ['pipeline', 'summary', 'characters', 'extract', 'book', 'skills'];
const REFUSED = ['delete', 'remove', 'trash', 'rename', 'move', 'initProject', 'newChapter', 'split', 'uninstall'];

let bundle;
let ctx;
let reports;

const toolOf = (name) => bundle.tools.NOVEL_TOOLS.find((x) => x.name === name);

function resetCtx() {
  reports = [];
  ctx = {
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: () => {},
  };
}

/**
 * 一张假的动作表：不碰工程，只看工厂怎么转发。`ran` 记下每一次真正跑到 feature 的调用。
 */
let ran;
let fakeTool;

before(() => {
  bundle = loadBundle({
    tools: './src/core/tools/novel/index.ts',
    actions: './src/core/tools/novel/actions.ts',
    schema: './src/core/tools/schema.ts',
  });
  const { defineActionTool, ArgError } = bundle.actions;
  const { str } = bundle.schema;
  ran = [];
  fakeTool = defineActionTool({
    name: 'fake',
    summary: '假的动作表。',
    usage: '用法说明。',
    params: { path: str('那份文件的路径。'), name: str('那个人的名字。') },
    actions: {
      look: {
        label: '看一眼',
        costly: false,
        gate: 'auto',
        async run() {
          ran.push('look');
          return { text: '看过了', calls: 0 };
        },
      },
      spend: {
        label: '花三次',
        costly: true,
        uses: ['path', 'name'],
        requires: ['path'],
        async run(_ctx, args) {
          ran.push(['spend', args.path]);
          return { text: '花了', calls: 3 };
        },
      },
      badArg: {
        label: '参数值不对',
        costly: false,
        async run() {
          throw new ArgError('值不对。');
        },
      },
      boom: {
        label: '会炸',
        costly: true,
        async run() {
          throw new Error('磁盘满了');
        },
      },
    },
  });
  resetCtx();
});

describe('故意不给的动作', () => {
  for (const name of ACTION_TOOLS) {
    test(`${name}：删除、改名、拆分、卸载……都说清这是有意的`, async () => {
      for (const bad of REFUSED) {
        resetCtx();
        const r = await toolOf(name).run(ctx, { action: bad, path: 'x.md' });
        assert.ok(r.error?.includes('这个动作，而且这是有意的'), `${name} ${bad}: ${r.error}`);
        assert.ok(r.error.includes(`${name} 可用的是：`), r.error);
        assert.equal(ctx.usage.calls, 0);
      }
    });
  }

  // 拒绝在参数校验之前：拿着 path 来删东西，听到的是「有意不给」，不是「不认 path」。
  test('拒绝的说法按动作分：删除、改名、拆分正文', async () => {
    const say = async (action) => (await toolOf('pipeline').run(ctx, { action, path: 'x.md' })).error;
    assert.ok((await say('delete')).startsWith('没有删除这个动作，而且这是有意的——那类操作由作者自己做。'));
    assert.ok((await say('rename')).startsWith('没有改名这个动作'));
    assert.ok((await say('split')).startsWith('没有拆分正文这个动作'));
  });

  test('哪个工具的 action 枚举里都没有拒绝的动作', () => {
    for (const name of ACTION_TOOLS) {
      const values = toolOf(name).parameters.properties.action.enum;
      for (const bad of REFUSED) {
        assert.ok(!values.includes(bad), `${name} 的枚举里有 ${bad}`);
      }
    }
  });
});

describe('认不出的动作', () => {
  test('列出这个工具可用的动作，且只列它自己的', async () => {
    const r = await toolOf('pipeline').run(ctx, { action: '把书写完' });
    assert.equal(r.error, '认不出动作「把书写完」。pipeline 可用的是：completeSettings / batchPlots / batchManuscripts / newPlot。');
  });

  // 拆过工具之后最常见的错：拿 summary 的动作去调 pipeline。列表里看得见该去哪。
  test('别的工具的动作也算认不出', async () => {
    const r = await toolOf('pipeline').run(ctx, { action: 'finalize', path: 'x.md' });
    assert.ok(r.error.startsWith('认不出动作「finalize」。'), r.error);
  });

  test('action 必填', async () => {
    const r = await toolOf('summary').run(ctx, {});
    assert.equal(r.error, 'action 是必填的。summary 可用的是：finalize / sync / rebuildGlobal。');
  });

  test('前后的空白不算', async () => {
    resetCtx();
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: '  look ' });
    assert.equal(r.text, '看过了');
    assert.deepEqual(ran, ['look']);
  });
});

describe('参数对得上动作', () => {
  test('给了动作不认的参数：当场报错，说清谁认，不跑', async () => {
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: 'look', path: 'a.md' });
    assert.equal(r.error, 'look 不认 path，只有 spend 认。');
    assert.deepEqual(ran, []);
  });

  // 外部 agent 常把没填的参数显式写成 undefined：那不算给了。
  test('值是 undefined 的参数不算给了', async () => {
    const r = await fakeTool.run(ctx, { action: 'look', path: undefined });
    assert.equal(r.error, undefined, r.error);
  });

  test('缺必填：报错带参数说明，不跑', async () => {
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: 'spend', name: '林昭' });
    assert.equal(r.error, 'spend 需要参数：path。path：那份文件的路径。');
    assert.deepEqual(ran, []);
  });

  test('只有空白的必填也算缺', async () => {
    const r = await fakeTool.run(ctx, { action: 'spend', path: '  ' });
    assert.ok(r.error?.startsWith('spend 需要参数：path。'), r.error);
  });
});

describe('执行与记账', () => {
  test('报几次记几次，气泡里说出来，display 写着次数', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'spend', path: 'a.md' });
    assert.equal(r.text, '花了');
    assert.equal(ctx.usage.calls, 3);
    assert.deepEqual(reports, ['花三次：调用模型 3 次']);
    assert.deepEqual(r.display, { title: 'fake spend', detail: '3 次调用' });
  });

  test('0 次不进气泡，display 写「未调模型」', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'look' });
    assert.deepEqual(reports, []);
    assert.deepEqual(r.display, { title: 'fake look', detail: '未调模型' });
  });

  // 参数值不对是模型能当场改的错，原样回给它；不挂「xx 失败」的前缀，那会让它以为是工程出了事。
  test('ArgError 原样回给模型', async () => {
    const r = await fakeTool.run(ctx, { action: 'badArg' });
    assert.equal(r.error, '值不对。');
  });

  test('feature 抛错：挂上动作的说法，账上不记', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'boom' });
    assert.ok(r.error.startsWith('会炸失败：'), r.error);
    assert.ok(r.error.includes('磁盘满了'), r.error);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('描述与 schema', () => {
  test('描述 = 一句话 + 每个动作（调模型 / 不调模型、要什么参数）+ 用法', () => {
    assert.equal(
      fakeTool.description,
      '假的动作表。可用的 action：look=看一眼（不调模型）；spend=花三次（调模型，要 path）；' +
        'badArg=参数值不对（不调模型）；boom=会炸（调模型）。用法说明。'
    );
  });

  for (const name of ACTION_TOOLS) {
    test(`${name}：描述列出每个动作，标明调不调模型`, () => {
      const tool = toolOf(name);
      for (const a of tool.parameters.properties.action.enum) {
        // 说法里自己也可能带括号与分号：认的是每一条末尾那个「（调模型…）」后面紧跟的分隔符。
        assert.match(tool.description, new RegExp(`(：|；)${a}=.*?（(调模型|不调模型)(，要 [^）]+)?）(；|。)`), `${name} ${a}`);
      }
    });

    test(`${name}：参数是扁平标量，action 必填`, () => {
      const schema = toolOf(name).parameters;
      assert.equal(schema.type, 'object');
      assert.deepEqual(schema.required, ['action']);
      assert.equal(schema.additionalProperties, false);
      for (const [key, p] of Object.entries(schema.properties)) {
        assert.ok(['string', 'integer', 'number', 'boolean'].includes(p.type), `${name}.${key}: ${JSON.stringify(p)}`);
        assert.ok(p.description, `${name}.${key} 没有说明`);
      }
    });
  }

  // 工具级的两个标记由动作表推出：有一个动作调模型就 costly，有一个动作不是 auto 就 mutating。
  test('工具级标记由动作表推出', () => {
    assert.equal(fakeTool.costly, true);
    assert.equal(fakeTool.mutating, true);
    const flags = Object.fromEntries(ACTION_TOOLS.map((n) => [n, [toolOf(n).costly, toolOf(n).mutating]]));
    assert.deepEqual(flags, {
      pipeline: [true, true],
      summary: [true, true],
      characters: [true, true],
      extract: [true, true],
      book: [true, true],
      skills: [false, true],
    });
  });
});

describe('意图', () => {
  test('缺省 mutating，标题是动作的说法；调模型的提醒随后还有一问', () => {
    const i = fakeTool.intent({ action: 'spend', path: 'a.md', name: '林昭' });
    assert.equal(i.gate, 'mutating');
    assert.equal(i.title, '花三次');
    assert.equal(i.detail, 'a.md 林昭\n要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。');
  });

  test('查询类报 auto', () => {
    assert.equal(fakeTool.intent({ action: 'look' }).gate, 'auto');
  });

  test('认不出的动作归 mutating', () => {
    const i = fakeTool.intent({ action: 'delete' });
    assert.equal(i.gate, 'mutating');
    assert.equal(i.title, '执行 fake delete');
  });
});
