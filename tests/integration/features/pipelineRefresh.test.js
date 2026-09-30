/**
 * `pushState` 连流水线条一起推。
 *
 * 从前它只推 state：总结完、在编辑器里手改了细纲、文件监听触发，流水线条与主按钮
 * 都停在旧状态。壳的文件监听、编辑器保存、工程页动作走的都是 pushState，所以这里
 * 直接调它，守的是「磁盘变了 → 主按钮跟着变」这一件事。
 *
 * 一章一纲之后单章状态机是「细纲 → 正文 → 定稿 → 完成」，这里把四格各走一遍：
 * 每一格都是磁盘在创作页之外变了（编辑器里写细纲、手贴正文、改细纲、写摘要），
 * 主按钮都得跟上。最后一格还守着「单章做完就转去问全书」——主按钮不该在一章做完
 * 之后沉默。
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

const PLOT = '.novelforge/plots/010-夜渡.md';
const CHAPTER = 'chapters/010-夜渡.md';

/** 第 10 章的细纲。三节（D3），判「排过没有」只看「关键事件」。 */
const plot = (sections) => ({
  no: 10, title: '夜渡', role: '', characters: [], upstreamHash: '', done: false,
  sections: { 本章目的: '', 关键事件: '', 章末钩子: '', ...sections },
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
    pipe: './src/core/views/pipeline.ts',
    controller: './src/core/controller/index.ts',
  });
  const h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'pipelinerefresh', title: '刷新测试' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  // 一份只有「本章目的」的细纲：还没排过，主按钮该是「写细纲」。
  await ws.writePlot(plot({ 本章目的: '渡河' }));
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
  await controller.handle({ type: 'selectPlot', plotRelPath: PLOT });
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

  // 只写了「本章目的」不算排过：一句话就能写，拿它当判据的话空壳会立刻显示「已规划」。
  test('还没排细纲：主按钮落在细纲层', async () => {
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'plot', JSON.stringify(pipe.next));
  });

  // 模拟作者在编辑器里把细纲写好、保存——磁盘变了，没有经过创作页。
  test('细纲在别处写好之后，主按钮跟着换到正文', async () => {
    await ws.writePlot(plot({ 本章目的: '渡河', 关键事件: '林昭夜渡青河，船到中流翻了。' }));
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'manuscript', JSON.stringify(pipe.next));
    assert.equal(pipe.next?.label, '写第 10 章', JSON.stringify(pipe.next));
  });

  // 正文就落在同号的章节上（没有中转站了）。作者手贴进来的一样算：细纲与配置
  // 都没写目标字数，于是「有字就算写够」，下一步是定稿。
  test('同号章节在别处写出正文之后，主按钮换到定稿', async () => {
    t.write(CHAPTER, '# 夜渡\n\n船到中流，缆绳断了。\n');
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.chapter.relPath, CHAPTER, JSON.stringify(pipe.pipeline?.chapter));
    assert.equal(pipe.next?.projectAction, 'finalizeChapter', JSON.stringify(pipe.next));
  });

  // 细纲在正文之后改过（在编辑器里改，走 edit）→ 正文标脏 → 主按钮换成「重写」。
  // 前提是这一章记过 writtenFrom：作者手贴的正文没有这笔账，永远不标脏（第 18a 条），
  // 所以先按正文落盘那一步的样子记一笔。
  test('细纲在正文之后改过，主按钮换成重写', async () => {
    const current = await project.readPlot(PLOT);
    await ws.recordWrittenFrom(PLOT, bundle.pipe.plotContentHash(current));
    const fresh = await refresh();
    assert.equal(fresh.next?.projectAction, 'finalizeChapter', '前提：记完账这一章仍是待定稿');

    await ws.edit(PLOT, [{ old: '船到中流翻了', new: '船到中流被人凿穿了' }]);
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.chapter.upstreamStale, true, JSON.stringify(pipe.pipeline?.chapter));
    assert.equal(pipe.next?.label, '重写第 10 章', JSON.stringify(pipe.next));
  });

  // 定稿（摘要对得上正文）之后这一章做完了——主按钮**转去问全书**，而不是沉默。
  // 这个工程的架构一件都没填，全书的下一步是「生成小说配置」。
  test('这一章定稿之后，主按钮转去问全书的下一步', async () => {
    const chapter = (await project.listChapters()).find((c) => c.order === 10);
    await ws.writeSummary(chapter, chapter.contentHash, {
      梗概: '林昭夜渡青河。', 出场人物: '林昭', 时间地点: '', 关键事件: '', 新增伏笔: '', 状态变更: '',
    });
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.stage, 'done', JSON.stringify(pipe.pipeline?.stage));
    assert.deepEqual(pipe.next?.target, { kind: 'setting', doc: 'config' }, JSON.stringify(pipe.next));
  });
});
