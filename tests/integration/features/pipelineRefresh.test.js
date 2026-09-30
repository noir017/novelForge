/**
 * `pushState` 连流水线条一起推。
 *
 * 从前它只推 state：拆完章、总结完、在编辑器里手改了细纲、文件监听触发，
 * 流水线条与主按钮都停在旧状态——拆完章按钮还挂着「拆成章节」，再点只报
 * 「还没有正文」。壳的文件监听、编辑器保存、工程页动作走的都是 pushState，
 * 所以这里直接调它，守的是「磁盘变了 → 主按钮跟着变」这一件事。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let controller;
let posted;
let ws;

const plot = (sections) => ({
  no: 10, title: '夜渡', arc: '', upstreamHash: '', done: false,
  sections: { 目标: '', 剧情脉络: '', 冲突与转折: '', 伏笔与回收: '', ...sections },
});

/** 调一次 pushState，回收这一轮推出去的最后一份流水线。 */
async function refresh() {
  posted.length = 0;
  await controller.pushState();
  return posted.filter((m) => m.type === 'pipeline').pop();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    controller: './src/core/controller/index.ts',
  });
  const h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'pipelinerefresh', title: '刷新测试' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  // 一份还没排剧情的细纲：主按钮该是「写剧情」。
  await ws.writePlot(plot({}));
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
  await controller.handle({ type: 'selectPlot', plotRelPath: '.novelforge/plots/010-夜渡.md' });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('pushState 推流水线条', () => {
  test('推了一份流水线', async () => {
    const pipe = await refresh();
    assert.ok(pipe, '没推 pipeline');
    assert.equal(pipe.pipeline?.no, 10, JSON.stringify(pipe.pipeline?.no));
  });

  test('还没排剧情：主按钮落在剧情层', async () => {
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'plot', JSON.stringify(pipe.next));
  });

  // 模拟作者在编辑器里把剧情写好、保存——磁盘变了，没有经过创作页。
  test('细纲在别处写好之后，主按钮跟着换到正文', async () => {
    await ws.writePlot(plot({ 目标: '渡河', 剧情脉络: '林昭夜渡青河，船到中流翻了。' }));
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'manuscript', JSON.stringify(pipe.next));
  });
});
