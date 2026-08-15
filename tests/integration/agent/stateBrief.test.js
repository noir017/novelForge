/**
 * `agent/context.ts` 的**状态注入**那一半。
 *
 * 这一段是 AGENTS 第 20 条在 agent 上的落点：**界面永远只推荐一个下一步，
 * 且由状态机算出来**。所以最要紧的断言不是「文案好不好看」，而是
 * **注入的 label / hint 与 `deriveNextStep` 的输出一字不差**——两处各判各的，
 * 界面上就会出现「徽章说待拆场景，agent 让你写正文」。
 *
 * 三种工程形态各验一遍：全新的（连大纲都没有）、只有成品的老工程、
 * 走到一半的章。
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
let ws;

const brief = (target) => bundle.context.buildStateBrief(project, target);

/** 直接问状态机：注入的那句必须与它一字不差。 */
async function nextStepOf(plotRelPath) {
  const view = await bundle.views.buildPlotPipelineView(project, plotRelPath);
  return bundle.pipeline.deriveNextStep(view.stage, {
    sceneCount: view.scenes.length,
    firstUnreadyScene: view.scenes.find((s) => !s.ready)?.no,
    firstUnwrittenScene: view.scenes.find((s) => s.status !== 'written')?.no,
    beatsStale: view.manuscript.beatsStale,
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    context: './src/core/agent/context.ts',
    pipeline: './src/core/model/pipeline.ts',
    views: './src/core/views/projectView.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'agentstate', title: '青云志' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('全新工程 · 连大纲都没有', () => {
  let text;

  before(async () => {
    // `initialize()` 撒了一份大纲模板，它是有内容的——删掉才是「连大纲都没有」。
    t.remove('.novelforge/outline.md');
    project.invalidate();
    text = await brief();
  });

  test('报出工程名', () => {
    assert.ok(text.includes('《青云志》'), text);
  });

  test('说清已发布几章', () => {
    assert.ok(text.includes('已发布 0 章'), text);
  });

  // 全书那一层：没有大纲就写大纲（deriveBookNextStep），与工程页主按钮同源。
  test('下一步来自全书状态机', () => {
    const expected = bundle.pipeline.deriveBookNextStep('outline');
    assert.ok(text.includes(expected.label), `${text}\n期望含 ${expected.label}`);
  });

  test('把「不要另做判断」写给模型', () => {
    assert.ok(text.includes('不要另做判断'), text);
  });
});

describe('老工程 · 99 章成品、一份细纲都没有', () => {
  let text;

  before(async () => {
    for (let i = 1; i <= 99; i++) {
      t.write(`chapters/${String(i).padStart(3, '0')}-第${i}章.md`, `# 第${i}章\n\n${'字'.repeat(3000)}\n`);
    }
    t.write('.novelforge/outline.md', '# 大纲\n\n少年入宗，一路向北。\n');
    project.invalidate();
    text = await brief();
  });

  test('说「已发布 99 章」', () => {
    assert.ok(text.includes('已发布 99 章'), text);
  });

  test('总字数按万字报', () => {
    assert.ok(/\d+\.\d 万字/.test(text), text);
  });

  // 老工程写了 99 章、从没碰过这个工具，不该被倒回去要求补细纲。
  test('不说「待写剧情」', () => {
    assert.ok(!text.includes('待写剧情'), text);
  });

  test('有大纲有章之后全书那一层不再给下一步', () => {
    assert.ok(!text.includes('下一步（由状态机'), text);
  });

  // 第 20 条 (c)：做完了就不给下一步。造一个假的出来，agent 会自作主张挑一章开始烧钱。
  test('不催的时候明说「不要自己挑一章开工」', () => {
    assert.ok(text.includes('不要自己挑一章开工'), text);
  });
});

describe('选中一章 · 注入的下一步与状态机一字不差', () => {
  const plotRel = '.novelforge/plots/100-北行.md';
  let text;
  let expected;

  before(async () => {
    await ws.writePlot({
      no: 100,
      title: '北行',
      arc: '',
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '林昭北上' },
    });
    project.invalidate();
    expected = await nextStepOf(plotRel);
    text = await brief({ kind: 'plot', plotRelPath: plotRel });
  });

  test('报出当前目标那一章', () => {
    assert.ok(text.includes('第 100 章《北行》'), text);
  });

  test('报出目标的路径', () => {
    assert.ok(text.includes(plotRel), text);
  });

  test('本章状态用的是状态机的说法', () => {
    assert.ok(text.includes('待写剧情'), text);
  });

  // 第 20 条的硬断言：两处各判各的，界面上就会出现「徽章说 A、agent 让你做 B」。
  test('下一步的 label 与 deriveNextStep 一字不差', () => {
    assert.ok(text.includes(expected.label), `${text}\n期望含「${expected.label}」`);
  });

  test('下一步的 hint 也一字不差', () => {
    assert.ok(text.includes(expected.hint), `${text}\n期望含「${expected.hint}」`);
  });

  test('剧情排完之后下一步跟着变', async () => {
    await ws.writePlot({
      no: 100,
      title: '北行',
      arc: '',
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        目标: '林昭北上',
        剧情脉络: '出城、遇雪、投宿；收在客栈门口。',
      },
    });
    project.invalidate();
    const after = await brief({ kind: 'plot', plotRelPath: plotRel });
    const now = await nextStepOf(plotRel);
    assert.ok(after.includes(now.label), `${after}\n期望含「${now.label}」`);
    assert.ok(after.includes('待拆场景'), after);
  });

  // 工程页点章名给的是成品路径，对话页下拉给的是细纲路径，说的是同一章。
  test('用成品路径也认得到同一章', async () => {
    const byChapter = await brief({ kind: 'plot', plotRelPath: 'chapters/099-第99章.md' });
    assert.ok(byChapter.includes('第 99 章'), byChapter);
  });
});

describe('⟳ 上游变更提醒', () => {
  test('改过大纲之后点名列出受影响的章', async () => {
    // 细纲记了 upstreamHash 才会标脏（手写的产物永不标脏）。
    for (const no of [11, 12, 13]) {
      await ws.writePlot({
        no,
        title: `第${no}章`,
        arc: '',
        upstreamHash: 'old-hash',
        done: false,
        sections: { ...bundle.plotFile.emptyPlotSections(), 目标: 'x', 剧情脉络: 'y' },
      });
    }
    project.invalidate();
    const text = await brief();
    assert.ok(text.includes('第 11 章'), text);
    assert.ok(text.includes('⟳'), text);
  });

  test('超过 5 章时写「等 N 章」，不把全书列一遍', async () => {
    for (let no = 20; no <= 30; no++) {
      await ws.writePlot({
        no,
        title: `第${no}章`,
        arc: '',
        upstreamHash: 'old-hash',
        done: false,
        sections: { ...bundle.plotFile.emptyPlotSections(), 目标: 'x', 剧情脉络: 'y' },
      });
    }
    project.invalidate();
    const text = await brief();
    assert.ok(/等 \d+ 章/.test(text), text);
  });

  test('提醒那一行不会长到把状态挤掉', async () => {
    const text = await brief();
    const line = text.split('\n').find((l) => l.startsWith('提醒：'));
    assert.ok(line.length < 120, `${line.length} 字：${line}`);
  });
});

describe('整段的体量', () => {
  test('状态注入不超过十来行', async () => {
    const text = await brief({ kind: 'plot', plotRelPath: '.novelforge/plots/100-北行.md' });
    assert.ok(text.split('\n').length <= 12, `${text.split('\n').length} 行：\n${text}`);
  });
});
