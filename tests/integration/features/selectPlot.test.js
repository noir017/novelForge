/**
 * 「选中一章」这个入口：`selectPlot` 收一个路径，由状态机决定落在哪一层。
 *
 * 它是四层流水线在界面上的**唯一入口**——工程页点章名、对话页下拉框换章、
 * 新建一章之后都走它。而这三处给的路径形状并不一样：
 *
 * | 入口 | 给的是什么 |
 * |---|---|
 * | 工程页点章名 | **主路径**：有成品就是 `chapters/003-夜访.md` |
 * | 对话页下拉框 | 细纲路径，这一章还没规划过时那个文件**并不存在** |
 * | 流水线 / 新建 | 真实的细纲路径 |
 *
 * 从前它只 `readPlot` 一次、读不到就报「这一章不存在，可能刚被改名或删除」，
 * 于是**拆分出来的章、以及老工程里的每一章**一点开就是那句话——而它们明明
 * 好好地躺在 `chapters/` 里。所以这里的每一条都在守同一件事：认的是「哪一章」，
 * 不是「哪个细纲文件」；只有两边都没有才算不存在。
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
let project;
let controller;
let posted;

/** 发一条 selectPlot，回收这一轮推给前端的消息。 */
async function select(relPath) {
  posted.length = 0;
  await controller.handle({ type: 'selectPlot', plotRelPath: relPath });
  return {
    error: posted.find((m) => m.type === 'toast' && m.level === 'error'),
    session: posted.filter((m) => m.type === 'session').pop()?.session,
    pipe: posted.filter((m) => m.type === 'pipeline').pop(),
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'selectplot', title: '选章测试' });
  project = t.project;

  // 第 8 章：规划过，正文也拆分发布了 —— 两面俱全。
  await project.writePlot({
    no: 8, title: '夜访', arc: '', upstreamHash: '', done: false,
    sections: { ...bundle.project.emptyPlotSections?.() ?? {}, 目标: '暴露令牌', 剧情脉络: '甲、乙、丙。', 冲突与转折: '', 伏笔与回收: '' },
  });
  t.write('chapters/008-夜访.md', '# 夜访\n\n三更，林昭醒了。\n');
  // 第 9 章：**只有成品**。一份正文拆成两章时，第二章天生就是这样——
  // 没有细纲，标题也还没起（纯序号名）。老工程里的每一章也是这样。
  t.write('chapters/009.md', '雨停了。\n');
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('工程页点章名（给的是主路径）', () => {
  let r;

  before(async () => {
    r = await select('chapters/008-夜访.md');
  });

  test('不报「这一章不存在」', () => {
    assert.equal(r.error, undefined, r.error && r.error.message);
  });

  // 目标一律落在**细纲那一侧**：场景目录与中转站正文都是按细纲路径镜像的，
  // 让 target 指进 chapters/ 的话，这一章的三层产物会各找各的位置。
  test('目标归到细纲路径', () => {
    assert.equal(r.session.target.plotRelPath, '.novelforge/plots/008-夜访.md');
  });

  test('推来的流水线是第 8 章', () => {
    assert.equal(r.pipe.pipeline?.no, 8, JSON.stringify(r.pipe.pipeline?.no));
  });
});

describe('对话页下拉框选一个只有成品的章', () => {
  let r;
  let dropdownRel;

  before(async () => {
    // 下拉框给的就是 buildState 里算出来的那个路径（`plotPathForNo`）——
    // 这一章还没规划过，所以那个文件并不存在。这正是 bug 的触发点。
    const ninth = (await project.listChapters()).find((c) => c.order === 9);
    dropdownRel = project.plotPathForNo(ninth.order, ninth.title);
    r = await select(dropdownRel);
  });

  // 无标题的章在 listChapters 那边会回落成「第 9 章」，那是「没有标题」的样子
  // 而不是标题。拼进文件名会得到 `009-第-9-章.md`——一个凭空的假名字，
  // 而作者哪天真去补规划时，writePlot 落的又是另一个文件名。
  test('回落标题不进细纲文件名', () => {
    assert.equal(dropdownRel, '.novelforge/plots/009.md');
  });

  test('不报「这一章不存在」', () => {
    assert.equal(r.error, undefined, r.error && r.error.message);
  });

  test('推来的流水线是第 9 章', () => {
    assert.equal(r.pipe.pipeline?.no, 9, JSON.stringify(r.pipe.pipeline?.no));
  });

  // 成品在就是造完了（`deriveStage` 先看 chapterExists）——不该被倒回去补细纲。
  test('已有成品的章不被倒回「待写剧情」', () => {
    assert.notEqual(r.pipe.pipeline?.stage, 'plot', r.pipe.pipeline?.stage);
  });

  // 工作区卡上那句话也得改口：这一章没丢，只是没经过流水线。
  // 说「可能刚被改名或删除」会让作者去找一个根本没丢的东西。
  test('工作区卡不说这一章丢了', () => {
    assert.ok(
      !(r.pipe.workbench?.empty ?? '').includes('改名或删除'),
      JSON.stringify(r.pipe.workbench)
    );
  });
});

describe('真的不存在的章', () => {
  let r;

  before(async () => {
    r = await select('.novelforge/plots/777-没这章.md');
  });

  // 两边都没有才是「不存在」。这条提示本身没错，错的是从前它太容易被撞上。
  test('给出提示而不是崩', () => {
    assert.ok(r.error, JSON.stringify(posted.map((m) => m.type)));
  });

  test('提示说的是改名或删除', () => {
    assert.ok(r.error.message.includes('改名或删除'), r.error.message);
  });
});

describe('状态机仍然在管落在哪一层', () => {
  let planned;

  before(async () => {
    // 一个连剧情都没排的新章：状态机该把作者留在剧情层，而不是丢进正文。
    await project.writePlot({
      no: 20, title: '', arc: '', upstreamHash: '', done: false,
      sections: { 目标: '还没想好', 剧情脉络: '', 冲突与转折: '', 伏笔与回收: '' },
    });
    project.invalidate();
    planned = await select('.novelforge/plots/020.md');
  });

  test('没排剧情的章落在剧情层', () => {
    assert.equal(planned.session.stage, 'plot', planned.session.stage);
  });

  // 切层一律把能力重置成 discuss：默认动作不该是花钱产出一份要不要都不知道的产物。
  test('切层不预置花钱的能力', () => {
    assert.equal(planned.session.capability, 'discuss', planned.session.capability);
  });

  test('主按钮是「写剧情」', () => {
    assert.equal(planned.pipe.next?.capability, 'generate', JSON.stringify(planned.pipe.next));
  });
});
