/**
 * 删修饰（generation/trim.ts）：写正文链的最后一步，经 `generate` 跑，设置里开着才跑。
 *
 * | 情形 | 断言 |
 * |---|---|
 * | 删得合格 | 多 1 次调用；Draft 是删后的、带删之前那版；气泡退回删后的；带编号的输出不流进气泡；消息不带装配内容 |
 * | 模型加了字 | 整段退回，Draft 原样、不带删之前那版，说明里写退回原因 |
 * | 删到八成以下 | 从删得最多的段退回，够八成为止 |
 * | 调用失败 | 正文保持原样，照样出 Draft |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let fake;
let t;
let script = [];

const P1 = '.novelforge/plots/001-夜入青云.md';

/** 两段正文，每段中间夹一个可删的程度副词；第三段是对白。目标 1000 字。 */
const A = `${filler(420, 1).slice(0, -1)}格外${filler(30, 2)}`;
const B = `${filler(420, 3).slice(0, -1)}狠狠${filler(30, 4)}`;
const C = '“这一句是对白，不许动。”';
const CHAPTER = [A, B, C].join('\n\n');
const strip = (s, w) => s.replace(w, '');
/** 模型交回来的：两段各删一个词。 */
const GOOD = `[1] ${strip(A, '格外')}\n\n[2] ${strip(B, '狠狠')}\n\n[3] ${C}`;

function recorder() {
  const r = { deltas: [], resets: [], error: undefined };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: () => {},
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
      onProgress: () => {},
      onReset: (full) => r.resets.push(full),
    },
  };
}

async function write(replies) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await bundle.generate.generate(
    t.project,
    { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath: P1 }, ask: '' },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, last: fake.calls.at(-1) };
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
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    trimModifiers: true,
  };
  const h = makeFakeHost({ settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'trim', title: '青云剑录' });
  const ws = new bundle.ws.Workspace(t.project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    role: '',
    characters: ['林昭'],
    targetWords: 1000,
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '目的', 关键事件: '事件', 章末钩子: '钩子' },
  });
  await t.project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('删得合格', () => {
  let r;
  before(async () => {
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: GOOD, stop: 'end' }]);
  });

  test('多调 1 次；Draft 是删后的，带删之前那版', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.calls, 2);
    assert.equal(r.draft.raw, [strip(A, '格外'), strip(B, '狠狠'), C].join('\n\n'));
    assert.equal(r.draft.untrimmed, CHAPTER);
  });

  test('说明里写删了几段、多少字', () => {
    const note = r.draft.notes.find((n) => n.startsWith('删修饰：'));
    assert.match(note, /3 段里删了 2 段/);
  });

  test('气泡：带编号的输出不流进去，最后退回删后的正文', () => {
    assert.ok(!r.rec.deltas.join('').includes('[1]'));
    assert.ok(r.rec.deltas.join('').includes('——删修饰——'));
    assert.equal(r.rec.resets.at(-1), r.draft.raw);
  });

  test('删修饰那一次只给规矩与编号的正文，不带装配内容', () => {
    assert.equal(r.last.length, 2);
    assert.match(r.last[1].content, /\[3\] “这一句是对白，不许动。”/);
    assert.ok(!r.last[1].content.includes('钩子'));
  });
});

describe('模型加了字', () => {
  let r;
  before(async () => {
    const bad = `[1] ${A}又加了一些原文没有的字\n\n[2] ${B}\n\n[3] ${C}`;
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: bad, stop: 'end' }]);
  });

  test('整段退回：Draft 原样，不带删之前那版', () => {
    assert.equal(r.draft.raw, CHAPTER);
    assert.equal(r.draft.untrimmed, undefined);
  });

  test('说明里写退回原因', () => {
    assert.ok(r.draft.notes.some((n) => n.includes('删修饰没有删掉什么') && n.includes('加了原文没有的字 1 段')), JSON.stringify(r.draft.notes));
  });
});

describe('删到八成以下', () => {
  let r;
  before(async () => {
    // 第 1 段删到只剩六成（合格），第 2 段只删一个词：整章掉到八成以下。
    const cut = (s) => `${s.slice(0, Math.round(s.length * 0.6))}。`;
    const deep = `[1] ${cut(A)}\n\n[2] ${strip(B, '狠狠')}\n\n[3] ${C}`;
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: deep, stop: 'end' }]);
  });

  test('退回删得最多的段，够八成为止', () => {
    assert.ok(r.draft.length.reached, JSON.stringify(r.draft.length));
    assert.equal(r.draft.raw, [A, strip(B, '狠狠'), C].join('\n\n'));
    assert.ok(r.draft.notes.some((n) => /又退回删得最多的 1 段/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('调用失败', () => {
  let r;
  before(async () => {
    r = await write([
      { text: CHAPTER, stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假装 503');
      },
    ]);
  });

  test('正文保持原样，照样出 Draft', () => {
    assert.equal(r.rec.error, undefined);
    assert.equal(r.draft.raw, CHAPTER);
    assert.ok(r.draft.notes.some((n) => n.startsWith('删修饰调用失败')), JSON.stringify(r.draft.notes));
    assert.equal(r.rec.resets.at(-1), CHAPTER);
  });
});
