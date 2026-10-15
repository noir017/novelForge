/**
 * 上下文详细度落到后台任务上：提取文风、提取角色默认勾几章。
 *
 * 作者仍然可以在输入框里改章号——级别只决定**缺省勾哪几章**。这里只看缺省值：输入框直接取消，
 * 一次模型都不调。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 文风：「精简」前 1 章、缺省前 2 章、「完整」前 3 章 | 第 3 级 = 从前写死的前两章 |
 * | 角色：「精简」最近 1 章、缺省最近 3 章、「完整」最近 5 章 | 第 3 级 = 从前写死的最近三章 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let contextDetail;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    style: './src/core/features/style.ts',
    characters: './src/core/features/characters.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
      models: ['p/m'],
      ...(contextDetail ? { contextDetail } : {}),
    }),
  });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'detailDefaults', title: '缺省取章' });
  for (let no = 1; no <= 6; no++) {
    t.write(`chapters/${String(no).padStart(3, '0')}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文，林昭往井边走。\n`);
  }
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

/** 跑一次、在选章那一步取消，返回输入框里缺省填的章号。 */
async function defaultsOf(run, detail) {
  contextDetail = detail;
  h.expect(undefined);
  await run(t.project);
  contextDetail = undefined;
  return h.inputs[0].value;
}

describe('上下文详细度 · 后台任务缺省勾几章', () => {
  test('提取文风：前 1 / 2 / 3 章', async () => {
    const run = (p) => bundle.style.extractStyle(p);
    assert.equal(await defaultsOf(run, 1), '1');
    assert.equal(await defaultsOf(run, undefined), '1,2');
    assert.equal(await defaultsOf(run, 4), '1,2,3');
  });

  test('提取角色：最近 1 / 3 / 5 章', async () => {
    const run = (p) => bundle.characters.extractCharacters(p);
    assert.equal(await defaultsOf(run, 1), '6');
    assert.equal(await defaultsOf(run, undefined), '4,5,6');
    assert.equal(await defaultsOf(run, 4), '2,3,4,5,6');
  });
});
