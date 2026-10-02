/**
 * `agent/context.ts` 的**状态注入**那一半。
 *
 * 这一段是 AGENTS 第 20 条在 agent 上的落点：**界面永远只推荐一个下一步，
 * 且由状态机算出来**。所以最要紧的断言不是「文案好不好看」，而是
 * **注入的 label / hint 与状态机的输出一字不差**——单章看 `deriveNextStep`，
 * 全书看 `deriveBookStage` / `deriveBookNextStep`。两处各判各的，界面上就会出现
 * 「徽章说待写细纲，agent 让你写正文」。
 *
 * 一本书从零走一遍：全新工程（推架构第一件）→ 架构齐了（推大纲）→ 大纲有了（推拆细纲）
 * → 选中一章，细纲 / 正文 / 定稿逐档往前 → 这一章做完，转去报全书的下一步 → 全书写完，
 * 照实说没有下一步。另起一个老工程（99 章成品、从没用过本工具）验 D11：它被推回架构，
 * 但选中的章按章号认、不被倒回去要求补细纲。
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

const PLOT1 = '.novelforge/plots/001-北行.md';
const CH1 = 'chapters/001-北行.md';

const brief = (target) => bundle.context.buildStateBrief(project, target);

/** 直接问单章状态机：注入的那句必须与它一字不差。 */
async function nextStepOf(relPath, p = project) {
  const view = await bundle.views.buildPlotPipelineView(p, relPath);
  return bundle.pipeline.deriveNextStep(view.stage, bundle.viewsPipeline.factsOf(view));
}

/** 直接问全书状态机（与创作页主按钮吃同一份事实）。 */
async function bookStepOf(p = project) {
  const facts = await bundle.viewsPipeline.buildBookFacts(p);
  const stage = bundle.pipeline.deriveBookStage(facts);
  return { stage, step: bundle.pipeline.deriveBookNextStep(stage, facts) };
}

/** 一份 D3 细纲。`events` 为空时这一章就还没排过。 */
function writePlot1(events) {
  return ws.writePlot({
    no: 1,
    title: '北行',
    role: '开篇',
    characters: ['林昭'],
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '林昭北上', 关键事件: events },
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
    viewsPipeline: './src/core/views/pipeline.ts',
    serialize: './src/core/controller/serialize.ts',
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

describe('全新工程 · 架构四件一件都没有', () => {
  let text;
  let expected;

  before(async () => {
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('报出工程名', () => {
    assert.ok(text.includes('《青云志》'), text);
  });

  test('说清已写几章', () => {
    assert.ok(text.includes('已写 0 章'), text);
  });

  test('没选中章时照实说', () => {
    assert.ok(text.includes('当前目标：还没选定某一章'), text);
  });

  // 全书那一层：架构四件按 配置 → 前提 → 角色图谱 → 世界观 的顺序，缺哪件推哪件。
  test('下一步是生成小说配置', () => {
    assert.ok(text.includes('生成小说配置'), text);
  });

  test('下一步的 label 与全书状态机一字不差', () => {
    assert.ok(text.includes(expected.label), `${text}\n期望含 ${expected.label}`);
  });

  test('hint 也一字不差', () => {
    assert.ok(text.includes(expected.hint), `${text}\n期望含 ${expected.hint}`);
  });

  test('把「不要另做判断」写给模型', () => {
    assert.ok(text.includes('不要另做判断'), text);
  });

  // 作者还在架构那一层时，当前目标说「故事架构」，下一步仍然来自全书。
  test('target 在架构层时说「故事架构」', async () => {
    const s = await brief({ kind: 'setting', doc: 'config' });
    assert.ok(s.includes('当前目标：故事架构'), s);
    assert.ok(s.includes(expected.label), s);
  });
});

describe('架构齐了、还没有大纲', () => {
  let text;
  let expected;

  before(async () => {
    t.write(
      '.novelforge/config.md',
      '---\ngenre: 玄幻\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n少年林昭北上入宗。\n'
    );
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n入宗 → 被疑 → 自证。\n');
    t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n宗门认令牌不认人。\n');
    t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n北地少年。\n');
    project.invalidate();
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('报出计划章数（config.md 的总章数）', () => {
    assert.ok(text.includes('（计划 30 章）'), text);
  });

  // `initialize()` 撒的大纲模板只有标题与说明，不算有内容。
  test('下一步是生成情节大纲，带章号区间', () => {
    assert.ok(text.includes('生成情节大纲（第 1–20 章）'), text);
  });

  test('与全书状态机一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });
});

describe('大纲有了、还没有细纲', () => {
  let text;
  let expected;

  before(async () => {
    t.write('.novelforge/outline.md', '# 大纲\n\n## 第1–20章：北行\n\n少年入宗，一路向北。\n');
    project.invalidate();
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('下一步是拆细纲，区间从第 1 章起', () => {
    assert.ok(text.includes('拆细纲（第 1–5 章）'), text);
  });

  test('与全书状态机一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });
});

describe('选中一章 · 注入的下一步与单章状态机一字不差', () => {
  let text;
  let expected;

  before(async () => {
    await writePlot1('');
    project.invalidate();
    expected = await nextStepOf(PLOT1);
    text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
  });

  // 细纲号 = 章号：说「第 1 章」，与工程页那一行、创作页的面包屑是同一个说法。
  test('报出当前目标那一章', () => {
    assert.ok(text.includes('当前目标：第 1 章《北行》'), text);
  });

  test('报出目标的路径', () => {
    assert.ok(text.includes(PLOT1), text);
  });

  // 「关键事件」空着就不算排过——只写了本章目的的骨架，状态机如实说待写细纲。
  test('状态用的是状态机的说法', () => {
    assert.ok(text.includes('状态：待写细纲'), text);
  });

  // 第 20 条的硬断言：两处各判各的，界面上就会出现「徽章说 A、agent 让你做 B」。
  test('下一步的 label 与 deriveNextStep 一字不差', () => {
    assert.ok(text.includes(expected.label), `${text}\n期望含「${expected.label}」`);
  });

  test('下一步的 hint 也一字不差', () => {
    assert.ok(text.includes(expected.hint), `${text}\n期望含「${expected.hint}」`);
  });

  test('细纲排完之后下一步跟着变：待写正文', async () => {
    await writePlot1('出城、遇雪、投宿；收在客栈门口。');
    project.invalidate();
    const after = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.ok(after.includes('状态：待写正文'), after);
    assert.ok(after.includes(now.label) && now.label === '写第 1 章', `${after}\n期望含「${now.label}」`);
  });

  // 全书那一层走到「在写」时不自己给按钮，转去问下一个该写的那一章——
  // 没选中章时 agent 听到的就是那一章的下一步。
  test('没选中章时，全书转去报下一个该写的章', async () => {
    const s = await brief();
    const { stage } = await bookStepOf();
    assert.equal(stage, 'writing');
    assert.ok(s.includes('写第 1 章'), s);
  });

  test('写了一部分还没写够：接着写', async () => {
    t.write(CH1, `# 北行\n\n${'字'.repeat(100)}\n`);
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.equal(now.label, '接着写');
    assert.ok(s.includes('状态：待写正文') && s.includes(now.label) && s.includes(now.hint), `${s}\n期望含「${now.hint}」`);
  });

  // 正文那一章的路径也认得到同一章（细纲号 = 章号）。
  test('给章节路径也认到同一章', async () => {
    const s = await brief({ kind: 'manuscript', plotRelPath: CH1 });
    assert.ok(s.includes('当前目标：第 1 章《北行》'), s);
  });

  test('写够了：待定稿，下一步是定稿第 1 章', async () => {
    t.write(CH1, `# 北行\n\n${'字'.repeat(400)}\n`);
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.ok(s.includes('状态：待定稿'), s);
    assert.ok(s.includes(now.label) && now.label === '定稿第 1 章', s);
  });
});

/**
 * ★ 单章做完之后**不沉默**：从前 `done` 之后没有下一步，agent 只会说「这一章做完了」，
 * 作者得自己去找下一章。现在与创作页主按钮同一条路（controller/chat.ts 的 `pushPipeline`）：
 * 那一章做完了就转去问全书，落到下一个该做的事上。
 */
describe('这一章定稿之后转去报全书的下一步', () => {
  let text;
  let expected;

  before(async () => {
    const chapter = (await project.listChapters()).find((c) => c.order === 1);
    await ws.writeSummary(chapter, chapter.contentHash, {
      ...bundle.project.emptySummarySections(),
      梗概: '林昭出城北上。',
    });
    project.invalidate();
    text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    ({ step: expected } = await bookStepOf());
  });

  test('这一章的状态是已完成', () => {
    assert.ok(text.includes('状态：已完成'), text);
  });

  test('说清这一章做完了', () => {
    assert.ok(text.includes('这一章都做完了'), text);
  });

  // 第 2 章还没有细纲：全书下一步是从第 2 章起拆细纲。
  test('转去报的是全书的下一步（拆第 2 章起的细纲）', () => {
    assert.ok(text.includes('拆细纲（第 2–6 章）'), text);
  });

  test('与全书状态机一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });

  test('已写章数跟着变', () => {
    assert.ok(text.includes('已写 1 章'), text);
  });

  // 第 20 条 (c)：做完了就不给下一步。造一个假的出来，agent 会自作主张挑一章开始烧钱。
  test('全书写完了就照实说，不造一个下一步', async () => {
    const saved = t.read('.novelforge/config.md');
    t.write('.novelforge/config.md', saved.replace('totalChapters: 30', 'totalChapters: 1'));
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    t.write('.novelforge/config.md', saved);
    project.invalidate();
    assert.ok(s.includes('全书都写完了'), s);
    assert.ok(!s.includes('由状态机算出'), s);
  });
});

/**
 * 主按钮点下「拆细纲（第 2–6 章）」之后，会话的 target 是第 2 章细纲**应该**在的位置
 * （文件还不存在，见 controller/chat.ts 的 `bookNextStep`）。这时创作页的流水线按
 * `buildPlotPipelineView` 给一份空壳，主按钮说「写第 2 章细纲」；状态注入也必须说同一句。
 */
describe('target 是还没落盘的下一章细纲', () => {
  const pending = '.novelforge/plots/002.md';

  // 索引里只有「有文件」的章号；那一号既无细纲也无正文时，findPipeline 要自己补一份
  // 空壳，否则会报成「还没选定某一章」+ 全书的「拆细纲」，与主按钮分叉（第 20 条）。
  test(
    '与创作页主按钮一致（写第 2 章细纲）',
    async () => {
      const s = await brief({ kind: 'plot', plotRelPath: pending });
      const now = await nextStepOf(pending);
      assert.ok(s.includes('当前目标：第 2 章'), s);
      assert.ok(s.includes(now.label), `${s}\n期望含「${now.label}」`);
    }
  );
});

describe('⟳ 上游变更提醒', () => {
  async function stalePlot(no) {
    // 细纲记了 upstreamHash 才会标脏（手写的产物永不标脏）；'old-hash' 对不上
    // 大纲里的任何一节。
    await ws.writePlot({
      no,
      title: `第${no}章`,
      role: '',
      characters: [],
      upstreamHash: 'old-hash',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: 'x', 关键事件: 'y' },
    });
  }

  test('改过上游之后点名列出受影响的章', async () => {
    for (const no of [201, 202, 203]) {
      await stalePlot(no);
    }
    project.invalidate();
    const text = await brief();
    assert.ok(text.includes('第 201 章、第 202 章、第 203 章'), text);
    assert.ok(text.includes('⟳'), text);
  });

  test('超过 5 章时写「等 N 章」，不把全书列一遍', async () => {
    for (let no = 220; no <= 230; no++) {
      await stalePlot(no);
    }
    project.invalidate();
    const text = await brief();
    assert.ok(text.includes('等 14 章'), text);
  });

  test('提醒那一行不会长到把状态挤掉', async () => {
    const text = await brief();
    const line = text.split('\n').find((l) => l.startsWith('提醒：'));
    assert.ok(line.length < 120, `${line.length} 字：${line}`);
  });
});

describe('整段的体量', () => {
  test('状态注入不超过十来行', async () => {
    const text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    assert.ok(text.split('\n').length <= 12, `${text.split('\n').length} 行：\n${text}`);
  });
});

/**
 * D11：老工程（几十章正文、从没有过架构）会被推回架构第一件——新链路写正文要读前提、
 * 角色与世界观，没有它们上下文就是空的。但**选中的某一章**按章号认，报的是它自己的
 * 状态：有字就是待定稿 / 已完成，不被倒回去要求补细纲。
 */
describe('老工程 · 99 章成品、没有架构也没有细纲', () => {
  let t2;
  let old;
  let text;

  before(async () => {
    t2 = await makeTempProject(bundle.project, { prefix: 'agentstate-old', title: '旧书' });
    old = t2.project;
    for (let i = 1; i <= 99; i++) {
      t2.write(`chapters/${String(i).padStart(3, '0')}-第${i}章.md`, `# 第${i}章\n\n${'字'.repeat(3000)}\n`);
    }
    t2.write('.novelforge/outline.md', '# 大纲\n\n少年入宗，一路向北。\n');
    old.invalidate();
    text = await bundle.context.buildStateBrief(old);
  });

  after(() => {
    if (t2) cleanup(t2.dir);
  });

  test('说「已写 99 章」', () => {
    assert.ok(text.includes('已写 99 章'), text);
  });

  test('总字数按万字报', () => {
    assert.ok(/\d+\.\d 万字/.test(text), text);
  });

  // 从前（D11）推的是「生成小说配置」：凭一句话编一套与这 99 章无关的设定。拆书 A 之后改成照正文整理。
  test('全书下一步是「从已写正文补齐」，是工程动作、不带调用次数（框里再报）', async () => {
    const { step } = await bookStepOf(old);
    assert.equal(step.label, '从已写正文补齐…');
    assert.equal(step.projectAction, 'deriveFromText');
    assert.equal(step.calls, undefined);
    assert.ok(step.hint.includes('第 1–99 章') && step.hint.includes('小说配置'), step.hint);
    assert.ok(text.includes(step.label) && text.includes(step.hint), text);
  });

  test('选中某一章按章号认，报它自己的状态', async () => {
    const rel = 'chapters/099-第99章.md';
    const s = await bundle.context.buildStateBrief(old, { kind: 'manuscript', plotRelPath: rel });
    const now = await nextStepOf(rel, old);
    assert.ok(s.includes('当前目标：第 99 章') && s.includes(rel), s);
    assert.ok(s.includes('状态：待定稿'), s);
    assert.ok(s.includes(now.label), `${s}\n期望含「${now.label}」`);
  });

  // 老工程写了 99 章、从没碰过这个工具，不该被倒回去要求补细纲。
  test('不说「待写细纲」', async () => {
    const s = await bundle.context.buildStateBrief(old, { kind: 'manuscript', plotRelPath: 'chapters/050-第50章.md' });
    assert.ok(!s.includes('待写细纲'), s);
  });
});

// 判据各写一遍的话，创作页主按钮会说「写第 12 章」而 agent 去写了第 13 章——
// 这种分叉没有任何测试拦得住，只能靠「只有一份」来防。
describe('主按钮与状态注入吃的是同一个 factsOf', () => {
  test('controller 那一侧转发到 views/pipeline 的同一份实现', () => {
    assert.equal(bundle.serialize.factsOf, bundle.viewsPipeline.factsOf);
  });
});
