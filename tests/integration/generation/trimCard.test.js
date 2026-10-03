/**
 * 删修饰的写入（controller/chat.ts 的 `askArtifact`）：点了「写入」之后，宿主实现了 `mergeTexts` 就逐段
 * 对照删之前 ↔ 删之后，落盘的是作者挑过的那一份。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 合并视图拿到删之前、删之后两版 | 作者要看得出删了什么 |
 * | 挑过的那一份落盘 | 删错的段退回原文 |
 * | 放弃就不写 | 与覆盖审阅的「放弃」同一个意思 |
 * | 宿主不实现就直接写删后的 | VS Code 的 diff 编辑器左边认磁盘文件，比不了两份内存里的文字 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let controller;
let script = [];
/** 每一次 `mergeTexts` 的参数；`answer` 是下一次要交回的结论。 */
const merges = [];
let answer;

const A = `${filler(520, 1).slice(0, -1)}格外${filler(30, 2)}`;
const B = `${filler(520, 3).slice(0, -1)}狠狠${filler(30, 4)}`;
const CHAPTER = [A, B].join('\n\n');
const TRIMMED = [A.replace('格外', ''), B.replace('狠狠', '')].join('\n\n');
const GOOD = `[1] ${A.replace('格外', '')}\n\n[2] ${B.replace('狠狠', '')}`;

const plotOf = (no) => `.novelforge/plots/00${no}-第${no}章.md`;

async function write(no) {
  script = [{ text: CHAPTER, stop: 'end' }, { text: GOOD, stop: 'end' }];
  await controller.handle({
    type: 'send',
    payload: {
      text: '',
      stage: 'manuscript',
      capability: 'generate',
      target: { kind: 'manuscript', plotRelPath: plotOf(no) },
      targetNo: 0,
      attachments: [],
      excludedIds: [],
    },
  });
  const file = fs.readdirSync(path.join(t.dir, 'chapters')).find((f) => f.startsWith(`00${no}-`));
  return file ? fs.readFileSync(path.join(t.dir, 'chapters', file), 'utf8') : undefined;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    trimModifiers: true,
  };
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings,
    overrides: {
      mergeTexts: async (title, before, after) => {
        merges.push({ title, before, after });
        return answer;
      },
    },
  });
  bundle.host.initHost(h.host);
  installFakeProvider(bundle.registry, {
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'trim-card', title: '青云剑录' });
  const ws = new bundle.ws.Workspace(t.project);
  for (const no of [1, 2, 3, 4]) {
    await ws.writePlot({
      no, title: `第${no}章`, role: '', characters: [], targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '目的', 关键事件: '事件', 章末钩子: '钩子' },
    });
  }
  await t.project.syncManifest();

  controller = new bundle.controller.ChatController(t.project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('写入时逐段对照', () => {
  test('合并视图拿到删之前、删之后两版；原样采用就写删后的', async () => {
    merges.length = 0;
    answer = 'apply';
    const text = await write(1);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].before, CHAPTER);
    assert.equal(merges[0].after, TRIMMED);
    assert.ok(text.includes(TRIMMED));
  });

  test('挑过的那一份落盘', async () => {
    const merged = [A, B.replace('狠狠', '')].join('\n\n');
    answer = { merged };
    const text = await write(2);
    assert.ok(text.includes(merged));
    assert.ok(text.includes('格外'));
  });

  test('放弃就不写', async () => {
    answer = 'discard';
    assert.equal(await write(3), undefined);
  });

  test('宿主不实现 mergeTexts：直接写删后的', async () => {
    const saved = h.host.mergeTexts;
    h.host.mergeTexts = undefined;
    merges.length = 0;
    try {
      const text = await write(4);
      assert.equal(merges.length, 0);
      assert.ok(text.includes(TRIMMED));
    } finally {
      h.host.mergeTexts = saved;
    }
  });
});
