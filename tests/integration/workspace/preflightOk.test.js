/**
 * 预检的永久放行落在细纲 frontmatter 里（五期补遗 §2）：`Workspace.recordPreflightOk`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 记进 `preflightOk`，同名换成新理由，别的原样留着；正文一个字节不动 | 只改 `---` 之间那一段 |
 * | 手写的细纲（没有 frontmatter）不补 | 补一段 frontmatter 等于把它拉进指纹链 |
 * | 改名留着，重新生成这一章的细纲就丢掉 | 重排过的出场是新的安排，要再问一次 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let ws;
const P8 = '.novelforge/plots/008-渡口.md';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    fileOps: './src/core/files/fileOps.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);
  t = await makeTempProject(bundle.project, { prefix: 'preflight-ok', title: '青崖记' });
  ws = new bundle.ws.Workspace(t.project);
  const empty = bundle.plotFile.emptyPlotSections();
  await ws.writePlot({ no: 8, title: '渡口', role: '', characters: ['林昭', '沈秋'], upstreamHash: '', done: false, sections: { ...empty, 关键事件: '林昭在渡口梦见沈秋', 章末钩子: '船上没有人' } });
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const okOf = async (rel) => {
  t.project.invalidate();
  return JSON.parse(JSON.stringify((await t.project.readPlot(rel)).preflightOk));
};

describe('recordPreflightOk', () => {
  test('记进 frontmatter，正文一个字节不动', async () => {
    const body = t.read(P8).split('\n---\n').slice(1).join('\n---\n');
    assert.equal(await ws.recordPreflightOk(P8, [{ name: '沈秋', reason: '托梦' }]), true);
    assert.deepEqual(await okOf(P8), [{ name: '沈秋', reason: '托梦' }]);
    assert.equal(t.read(P8).split('\n---\n').slice(1).join('\n---\n'), body);
  });

  test('同名换成新理由，别的原样留着', async () => {
    await ws.recordPreflightOk(P8, [{ name: '李叔', reason: '回忆' }]);
    await ws.recordPreflightOk(P8, [{ name: '沈秋', reason: '幻象' }]);
    assert.deepEqual(await okOf(P8), [{ name: '李叔', reason: '回忆' }, { name: '沈秋', reason: '幻象' }]);
  });

  test('手写的细纲（没有 frontmatter）不补', async () => {
    const rel = '.novelforge/plots/009-手写.md';
    t.write(rel, '# 第9章 手写\n\n## 关键事件\n\n沈秋出场\n');
    assert.equal(await ws.recordPreflightOk(rel, [{ name: '沈秋', reason: '回忆' }]), false);
    assert.doesNotMatch(t.read(rel), /preflightOk/);
  });

  test('改名留着', async () => {
    t.project.invalidate();
    const plot = await t.project.readPlot(P8);
    const to = await ws.writePlot({ ...plot, title: '夜渡' }, P8);
    assert.deepEqual(await okOf(to), [{ name: '李叔', reason: '回忆' }, { name: '沈秋', reason: '幻象' }]);
  });

  test('重新生成这一章的细纲：丢掉', async () => {
    t.project.invalidate();
    const rel = (await t.project.getPlot(8)).relPath;
    const empty = bundle.plotFile.emptyPlotSections();
    await ws.write(rel, { artifact: { kind: 'plot', title: '夜渡', role: '', characters: ['林昭', '沈秋'], sections: { ...empty, 关键事件: '林昭在渡口又梦见沈秋', 章末钩子: '船上没有人' } } }, { mode: 'overwrite', review: false });
    assert.deepEqual(await okOf(rel), []);
  });
});
