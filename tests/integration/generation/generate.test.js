/**
 * `generation/generate.ts`：装配 → 调模型 → 解析 → 产出 Draft。
 *
 * 这一层**一个字都不写磁盘**（落盘在 `workspace/`，且只在用户点了采纳之后），
 * 所以这里要钉住的是三件事：
 *
 * 1. **产出的 Draft 自带 artifact 与 summary**——从前生成一次要解析三次
 *    （生成时、后端画卡片时、采纳时），中间那次是多余的。
 * 2. **`cleanOutput` 只对正文层做**——那几条正则跑在 JSON 产物上会切坏结构。
 * 3. **失败挂在细纲上、成功清掉**（AGENTS 第 16 条），取消不算失败。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const PLOT_JSON = JSON.stringify({
  目标: '进入宗门',
  剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
  冲突与转折: '三拍推进',
  伏笔与回收: '第三块令牌',
});

let bundle;
let gen;
let h;
let fake;
let t;
let project;

/** `config.read()` 的返回值。 */
let settings = {};
/** 第 N 次调用该回什么。 */
let replyFn = () => '';
/** 第 N 次调用该吐哪串事件。给了就优先于 `replyFn`。 */
let eventsFn;
/** warn / error 级日志。 */
const warns = [];

function configure(extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    ...extra,
  };
  fake.calls.length = 0;
  warns.length = 0;
  h.answers.length = 0;
  // 每个用例自己决定要不要造事件流：上一段用例留下的钩子不该漏给下一段。
  eventsFn = undefined;
}

/** 收一次生成的全部回调。 */
function recorder() {
  const r = { deltas: [], reasoning: [], done: undefined, error: undefined, cancelled: false };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: (d) => r.reasoning.push(d),
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => { r.cancelled = true; },
    },
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });
  gen = bundle.generate;

  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      warns.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    // 不是一段文本的响应（只有思考、什么都没有）走这一条。缺省不给，
    // 于是照旧走 replyFn。
    events: (messages, i) => (eventsFn ? eventsFn(messages, i) : undefined),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'generate', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    arc: '',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '林昭进入宗门' },
  });
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const PLOT_TARGET = { kind: 'plot', plotRelPath: '.novelforge/plots/001-夜入青云.md' };

describe('剧情层 · 产出 Draft', () => {
  let out;
  let rec;

  before(async () => {
    configure();
    replyFn = () => PLOT_JSON;
    rec = recorder();
    out = await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: '排一下这一章' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('调了一次模型', () => {
    assert.equal(fake.calls.length, 1, `调了 ${fake.calls.length} 次`);
  });

  test('产出了 draft', () => {
    assert.ok(out.draft, JSON.stringify(out));
  });

  test('draft 带 id', () => {
    assert.ok(out.draft.id && typeof out.draft.id === 'string', out.draft.id);
  });

  test('draft 记下了 job 与 target', () => {
    assert.equal(out.draft.job, 'plot');
    assert.equal(out.draft.target.plotRelPath, PLOT_TARGET.plotRelPath);
  });

  // 生成时就带上 artifact：从前要等前端拿到文本、后端再 parse 一次画卡片。
  test('draft 自带解析好的产物', () => {
    assert.equal(out.draft.artifact.kind, 'plot', JSON.stringify(out.draft.artifact));
  });

  test('产物四节都在', () => {
    assert.equal(out.draft.artifact.sections.伏笔与回收, '第三块令牌');
  });

  test('draft 自带一句话形状描述', () => {
    assert.equal(out.draft.summary, '剧情 · 4/4 节', out.draft.summary);
  });

  test('draft 记下字数', () => {
    assert.ok(out.draft.words > 0, String(out.draft.words));
  });

  test('draft 带创建时间', () => {
    assert.ok(!Number.isNaN(Date.parse(out.draft.createdAt)), out.draft.createdAt);
  });

  test('回调拿到了完整文本', () => {
    assert.equal(rec.r.done, PLOT_JSON, rec.r.done);
  });

  test('装配结果一并回给调用方', () => {
    assert.ok(out.built && out.built.messages.length > 0);
  });

  // 一个字都不写磁盘：落盘只在用户点了采纳之后（AGENTS 第 19 条）。
  test('细纲没有被写过', async () => {
    const plot = await project.readPlot(PLOT_TARGET.plotRelPath);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('正文层 · cleanOutput 只在这一层跑', () => {
  let manuscript;
  let plotRaw;

  before(async () => {
    configure();
    replyFn = () => '好的，以下是续写：\n\n## 第一章 灯下\n\n雨下了三天。';
    const a = recorder();
    manuscript = (
      await gen.generate(
        project,
        {
          job: 'manuscript',
          target: { kind: 'manuscript', plotRelPath: PLOT_TARGET.plotRelPath },
          ask: '接着写',
        },
        a.handlers,
        { signal: new AbortController().signal }
      )
    ).draft;

    // 同一段文本走剧情层：那几条正则会把 JSON 的第一行剥掉，绝不能跑。
    replyFn = () => `\`\`\`json\n${PLOT_JSON}\n\`\`\``;
    const b = recorder();
    plotRaw = (
      await gen.generate(
        project,
        { job: 'plot', target: PLOT_TARGET, ask: 'x' },
        b.handlers,
        { signal: new AbortController().signal }
      )
    ).draft.raw;
  });

  test('正文剥掉了开场白', () => {
    assert.ok(!manuscript.raw.includes('以下是续写'), manuscript.raw);
  });

  test('正文剥掉了章节标题', () => {
    assert.ok(!manuscript.raw.includes('第一章 灯下'), manuscript.raw);
  });

  test('正文本身留着', () => {
    assert.ok(manuscript.raw.includes('雨下了三天'), manuscript.raw);
  });

  // 关键：JSON 产物原样保留代码围栏，剥围栏是 `parseArtifact` 的活
  // （`stripCodeFence`），在这里剥会把「去掉开场白」那几条正则用到 JSON 上。
  test('JSON 产物不过 cleanOutput', () => {
    assert.ok(plotRaw.startsWith('```json'), plotRaw.slice(0, 40));
  });

  test('围栏包着的 JSON 照样解析得出来', async () => {
    const artifact = bundle.generate.parseDraftArtifact(
      'plot',
      plotRaw
    );
    assert.equal(artifact.sections.冲突与转折, '三拍推进', JSON.stringify(artifact));
  });
});

/**
 * 兜底解析：模型没按契约给 JSON 时，全文塞进主字段。
 *
 * 这条路留着是为了**不白烧那一次调用**——产物就摊在气泡里，作者看得见它是
 * 什么，落盘前还要过一遍卡片（第 19 条）。批量路径反过来用严格解析
 * （`parsePlotStrict`），那里没有人逐份过目。
 */
describe('模型没给 JSON 时兜底', () => {
  let draft;

  before(async () => {
    configure();
    replyFn = () => '我觉得这一章的冲突可以提前。';
    const rec = recorder();
    draft = (
      await gen.generate(
        project,
        { job: 'plot', target: PLOT_TARGET, ask: '你怎么看' },
        rec.handlers,
        { signal: new AbortController().signal }
      )
    ).draft;
  });

  test('产出了 draft', () => {
    assert.ok(draft);
  });

  // 兜底落在「剧情脉络」而不是「目标」：`isPlotFilled` 只看前者，
  // 兜进「目标」的话这一段采纳后会显示成「还没排剧情」的空壳。
  test('全文落在剧情脉络那一节', () => {
    assert.equal(draft.artifact.kind, 'plot');
    assert.equal(draft.artifact.sections.剧情脉络, '我觉得这一章的冲突可以提前。');
  });

  test('形状描述说得出填了几节', () => {
    assert.equal(draft.summary, '剧情 · 1/4 节', draft.summary);
  });
});

describe('模型抛错', () => {
  let rec;
  let out;
  let failures;

  before(async () => {
    configure();
    fake.reset();
    replyFn = () => {
      throw new bundle.provider.LlmError('假装 429 限流');
    };
    rec = recorder();
    out = await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    // recordFailure 是 fire-and-forget。
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('onError 被调用', () => {
    assert.ok(rec.r.error && rec.r.error.includes('429'), rec.r.error);
  });

  test('没有产出 draft', () => {
    assert.equal(out.draft, undefined, JSON.stringify(out.draft));
  });

  // 第 16 条：失败要留在出错的东西身上，toast 五秒就没了。
  test('失败挂在细纲上', () => {
    assert.ok(failures[PLOT_TARGET.plotRelPath], JSON.stringify(Object.keys(failures)));
  });

  test('失败进日志', () => {
    assert.ok(warns.some((w) => w.includes('429')), warns.join('|'));
  });
});

describe('成功要清掉失败标记', () => {
  let failures;

  before(async () => {
    configure();
    replyFn = () => PLOT_JSON;
    const rec = recorder();
    await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  // 修好了还挂着标记，用户会学会无视它。
  test('细纲上的红标记没了', () => {
    assert.ok(!failures[PLOT_TARGET.plotRelPath], JSON.stringify(failures));
  });
});

describe('取消', () => {
  let rec;
  let failures;

  before(async () => {
    configure();
    replyFn = () => {
      throw new bundle.provider.CancelledError();
    };
    rec = recorder();
    const abort = new AbortController();
    await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: abort.signal }
    );
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('onCancelled 被调用', () => {
    assert.ok(rec.r.cancelled);
  });

  test('取消不报错', () => {
    assert.equal(rec.r.error, undefined, rec.r.error);
  });

  // 用户自己点的停止不是失败，挂个红标记只会让他以为出了问题。
  test('取消不记失败', () => {
    assert.ok(!failures[PLOT_TARGET.plotRelPath], JSON.stringify(failures));
  });
});

describe('模型引用无效时不调模型', () => {
  let rec;
  let out;
  let callsBefore;

  before(async () => {
    configure({ providers: [], models: [] });
    callsBefore = fake.calls.length;
    rec = recorder();
    out = await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('说明了原因', () => {
    assert.ok(rec.r.error, '应当 onError');
  });

  test('没有调模型', () => {
    assert.equal(fake.calls.length, callsBefore);
  });

  test('没有 draft 也没有 built', () => {
    assert.equal(out.draft, undefined);
    assert.equal(out.built, undefined);
  });
});

describe('装配明细 · 降级与丢弃进 warn 日志', () => {
  before(async () => {
    // 预算压到最小，长附件必然被截断或丢弃。「不静默截断」要求它进日志。
    configure({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 2000, maxOutputTokens: 500 }] }],
      models: ['p/m'],
    });
    replyFn = () => PLOT_JSON;
    const rec = recorder();
    await gen.generate(
      project,
      {
        job: 'plot',
        target: PLOT_TARGET,
        ask: 'x',
        attachments: [{ id: 'big', kind: 'file', label: '大文件', text: '雨'.repeat(20000) }],
      },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('降级/丢弃的条目进了 warn 日志', () => {
    assert.ok(warns.some((w) => w.includes('降级') || w.includes('丢弃')), warns.join('|'));
  });

  // 一次正文生成的 prompt 有十万字，进了缓冲会把此前所有日志挤没。
  test('日志里没有 prompt 全文', () => {
    assert.ok(!warns.some((w) => w.includes('雨雨雨雨雨雨雨雨雨雨')), warns.join('|').slice(0, 200));
  });
});

/**
 * 调试模式：这一次到底发给模型了什么，原样落一份在会话旁边。
 *
 * 这里验的是**生成这一侧**接上没有：给了 sessionId 才写、写的是这一次真发出去
 * 的消息、装配明细跟着一起留（「它为什么没看见那份细纲」的答案通常就在那张表的
 * 某一行上）。文件排版本身在 tests/unit/runtime/debug.test.js 里验。
 */
describe('调试模式：完整上下文落盘', () => {
  const fs = require('fs');
  const path = require('path');
  const dirOf = (id) => path.join(t.dir, '.novelforge', 'sessions', `${id}.debug`);
  const filesIn = (id) => {
    try {
      return fs.readdirSync(dirOf(id));
    } catch {
      return [];
    }
  };
  const textIn = (id) => fs.readFileSync(path.join(dirOf(id), filesIn(id)[0]), 'utf8');

  before(async () => {
    configure({ debug: true });
    replyFn = () => PLOT_JSON;
    const rec = recorder();
    await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: '排一下这一章的剧情' },
      rec.handlers,
      { signal: new AbortController().signal, sessionId: 'gen-dbg' }
    );
  });

  test('落在那个会话的调试目录里', () => {
    assert.equal(filesIn('gen-dbg').length, 1, filesIn('gen-dbg').join('、'));
  });

  test('文件名说得出这是哪一层的活', () => {
    assert.match(filesIn('gen-dbg')[0], /generate-plot\.md$/);
  });

  test('里面是这一次真发出去的消息', () => {
    const sent = fake.calls.at(-1).map((m) => m.content).join('\n');
    const dumped = textIn('gen-dbg');
    assert.ok(sent.length > 0);
    assert.ok(dumped.includes('排一下这一章的剧情'), dumped.slice(0, 400));
  });

  test('装配明细跟着留下来', () => {
    assert.ok(textIn('gen-dbg').includes('## 装配明细'), textIn('gen-dbg').slice(0, 600));
  });

  test('模型的回答补在同一份文件里', () => {
    assert.ok(textIn('gen-dbg').includes(PLOT_JSON), textIn('gen-dbg').slice(-500));
  });

  // 工程页的批量任务没有会话：不造落点，工程里不该多出没人认领的目录。
  describe('没有会话 id', () => {
    before(async () => {
      configure({ debug: true });
      replyFn = () => PLOT_JSON;
      const rec = recorder();
      await gen.generate(
        project,
        { job: 'plot', target: PLOT_TARGET, ask: 'x' },
        rec.handlers,
        { signal: new AbortController().signal }
      );
    });

    test('sessions/ 下只有刚才那一个调试目录', () => {
      const names = fs.readdirSync(path.join(t.dir, '.novelforge', 'sessions'));
      assert.deepEqual(names, ['gen-dbg.debug'], names.join('、'));
    });
  });

  describe('关着', () => {
    before(async () => {
      configure();
      replyFn = () => PLOT_JSON;
      const rec = recorder();
      await gen.generate(
        project,
        { job: 'plot', target: PLOT_TARGET, ask: 'x' },
        rec.handlers,
        { signal: new AbortController().signal, sessionId: 'gen-off' }
      );
    });

    test('一个文件都不写', () => {
      assert.deepEqual(filesIn('gen-off'), []);
    });
  });
});

/**
 * 空产出：**不造 Draft。**
 *
 * 现场（会话 `20260831-161311-a81305`）：推理模型吐完 1893 字思考就把流断了，
 * 一个字正文都没有。从前这里照样造出一份 `raw: ''` 的草稿，于是一路装成成功
 * ——工具回「已生成：分卷清单 · 0 字」，agent 转头跟作者说「正在等你点头」，
 * 而 `onArtifact` 解析不出形状根本没弹卡片。空产物必须在这一层就变成失败。
 */
describe('只有思考、没有正文', () => {
  let out;
  let rec;
  let failures;

  before(async () => {
    configure();
    fake.reset();
    eventsFn = () => [
      { type: 'reasoning', text: '先看看大纲有几条主线……' },
      { type: 'usage', usage: { inputTokens: 2927, outputTokens: 0 } },
    ];
    rec = recorder();
    out = await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('没有产出 draft', () => {
    assert.equal(out.draft, undefined, JSON.stringify(out.draft));
  });

  test('onError 说清了「只有思考」', () => {
    assert.ok(rec.r.error && rec.r.error.includes('只输出了思考'), rec.r.error);
  });

  test('那句话里给了下一步怎么办', () => {
    assert.ok(rec.r.error.includes('再试一次'), rec.r.error);
  });

  // 第 16 条：失败要留在出错的东西身上。
  test('失败挂在细纲上', () => {
    assert.ok(failures[PLOT_TARGET.plotRelPath], JSON.stringify(Object.keys(failures)));
  });

  test('进了日志', () => {
    assert.ok(warns.some((w) => w.includes('没有产出内容')), warns.join('|'));
  });

  test('装配结果照旧回给调用方', () => {
    assert.ok(out.built && out.built.messages.length > 0);
  });
});

describe('一个字都没有（连思考也没有）', () => {
  let out;
  let rec;

  before(async () => {
    configure();
    fake.reset();
    replyFn = () => '';
    rec = recorder();
    out = await gen.generate(
      project,
      { job: 'plot', target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('没有产出 draft', () => {
    assert.equal(out.draft, undefined, JSON.stringify(out.draft));
  });

  test('onError 说的是「什么都没输出」', () => {
    assert.ok(rec.r.error && rec.r.error.includes('什么都没输出'), rec.r.error);
  });
});
