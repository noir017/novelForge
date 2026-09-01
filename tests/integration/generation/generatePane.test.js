/**
 * 「生成」页的后端：**手动调 `generate` 的那条路**。
 *
 * 这一组钉的是四件与 `tools/novel/generate.ts` 必须一致的事，以及一件那条路
 * 没有的事：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 落点候选按层给、说法由后端出 | 作者手上是「第 12 卷」，不是一条路径 |
 * | 三条校验都在**发请求之前** | 认不出 / 层对不上 / skill 名字错，一分钱不花 |
 * | 产出**不落盘**，采纳才写 | 第 19 条，与策略无关 |
 * | 模型按层解析并回显 | 不写清算到了谁，等于让人闭眼按下花钱的按钮 |
 * | 不碰会话与 DraftStore | 这一页与 agent 那条路没有共用状态 |
 *
 * 走的是真的 controller（`dispatch`），模型换成假 provider——要测的正是拼接与
 * 生命周期，打桩就等于把要测的东西替换掉了。
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let controller;
let settings;

/** 后端推给前端的消息，按顺序。每条用例开头清空。 */
let posted = [];
/** 假 provider 实际被调用了几次。校验路径上必须是 0。 */
let calls = 0;
/** 假模型这一次要吐什么。 */
let reply = '# 全书大纲\n\n少年下山，一路问道。\n';

const of = (type) => posted.filter((m) => m.type === type);
const last = (type) => of(type).pop();

function installProvider() {
  bundle.registry.registerProviderFactory(() => ({
    id: 'vscode-lm',
    label: '假模型',
    maxInputTokens: async () => undefined,
    stream: async function* () {
      calls += 1;
      yield { type: 'text', text: reply };
    },
  }));
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    skillModes: {},
  };
  bundle.host.initHost(
    makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings }).host
  );
  installProvider();

  t = await makeTempProject(bundle.project, { prefix: 'genpane', title: '青云剑录' });

  // 一卷、一段，以及一份给创作模型的技能。候选与校验都要拿它们说话。
  t.write('.novelforge/volumes/01-开端.md', '---\nno: 1\ntitle: 开端\n---\n\n## 本卷起点\n\n少年在山下。\n');
  t.write('.novelforge/plots/01-开端/001-下山.md', '---\nno: 1\ntitle: 下山\n---\n\n## 本段目标\n\n下山。\n');
  t.write(
    '.novelforge/skills/去AI味/SKILL.md',
    '---\ndescription: 清 AI 味\naudience: generate\n---\n\n# 去AI味\n\n别写「眼中闪过一丝」。\n'
  );

  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (msg) => posted.push(msg), reveal: () => {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

beforeEach(() => {
  posted = [];
  calls = 0;
});

const targets = async (job) => {
  await controller.dispatch({ type: 'genTargets', job });
  return last('genTargets');
};

const run = async (patch) =>
  controller.dispatch({ type: 'genRun', ask: '', skills: [], ...patch });

// ---------------------------------------------------------------- 落点候选

describe('落点候选', () => {
  test('大纲层只有 outline.md 一个落点', async () => {
    const msg = await targets('outline');
    assert.equal(msg.stage, 'outline');
    assert.deepEqual(
      msg.items.map((i) => i.relPath),
      ['.novelforge/outline.md']
    );
  });

  test('卷纲层列各卷，说法由后端出', async () => {
    const msg = await targets('volume');
    assert.equal(msg.stage, 'volume');
    assert.equal(msg.items[0].label, '第 1 卷《开端》');
    assert.equal(msg.items[0].relPath, '.novelforge/volumes/01-开端.md');
  });

  test('剧情层列剧情段', async () => {
    const msg = await targets('plot');
    assert.equal(msg.stage, 'plot');
    assert.ok(msg.items.some((i) => i.relPath === '.novelforge/plots/01-开端/001-下山.md'), JSON.stringify(msg.items));
  });

  test('正文层的落点是中转站里那份镜像', async () => {
    const msg = await targets('manuscript');
    assert.equal(msg.stage, 'manuscript');
    assert.ok(
      msg.items.every((i) => i.relPath.startsWith('.novelforge/manuscripts/')),
      JSON.stringify(msg.items)
    );
  });

  // 拆卷/拆段往下加一份新的空壳，落点上本来就没东西——说「会覆盖」是吓唬人。
  test('两件「拆」永远不报覆盖', async () => {
    t.write('.novelforge/outline.md', '# 全书大纲\n\n已经写过了。\n');
    assert.equal((await targets('outline')).items[0].hasContent, true);
    assert.equal((await targets('volumeList')).items[0].hasContent, false);
    t.write('.novelforge/outline.md', '');
  });
});

// ---------------------------------------------------------------- 模型

describe('模型', () => {
  test('剧情层走分档，并说明是哪一档', async () => {
    const { model } = await targets('plot');
    assert.ok(model.tierNote && model.tierNote.includes('剧情层'), model.tierNote);
    assert.equal(model.ref, 'p/m');
    assert.equal(model.contextWindow, 100000);
  });

  test('大纲层不分档，用默认模型', async () => {
    const { model } = await targets('outline');
    assert.ok(model.tierNote && model.tierNote.includes('不分档'), model.tierNote);
  });

  // 作者显式挑了一个模型：回显必须按**那一个**算。不带过去的话，他挑了
  // 32k 的模型而界面还写着自动档那个 200k 的窗口——而这一行正是他按下花钱
  // 按钮之前唯一的依据。
  test('显式挑了模型就按那一个回显，不再报档位', async () => {
    settings.providers[0].models.push({ name: 'small', contextWindow: 32000, maxOutputTokens: 4096 });
    await controller.dispatch({ type: 'genTargets', job: 'plot', model: 'p/small' });
    const { model } = last('genTargets');
    assert.equal(model.ref, 'p/small');
    assert.equal(model.contextWindow, 32000);
    assert.equal(model.tierNote, undefined, '显式挑的模型不该再说走哪一档');
  });

  test('认不出的模型引用给一句原因，而不是静默回落', async () => {
    await controller.dispatch({ type: 'genTargets', job: 'plot', model: 'p/早就删了' });
    const { model } = last('genTargets');
    assert.ok(model.issue && model.issue.includes('认不出'), model.issue);
  });
});

// ---------------------------------------------------------------- 校验

describe('三条校验都在花钱之前', () => {
  test('认不出的路径：报错，一次模型都不调', async () => {
    await run({ job: 'outline', target: '不知道这是什么.md' });
    assert.equal(calls, 0, '校验路径上不该调模型');
    const phase = last('genPhase');
    assert.equal(phase.phase, 'error');
    assert.ok(phase.message.includes('认不出'), phase.message);
    assert.equal(last('genDone').draft, undefined);
  });

  test('job 与落点不同层：报错并指出两边各是哪一层', async () => {
    await run({ job: 'plot', target: '.novelforge/volumes/01-开端.md' });
    assert.equal(calls, 0);
    const { message } = last('genPhase');
    assert.ok(message.includes('剧情层'), message);
    assert.ok(message.includes('卷纲层'), message);
  });

  test('skill 名字对不上：整次拒绝，一次模型都不调', async () => {
    await run({ job: 'outline', target: '.novelforge/outline.md', skills: ['project:没有这一份'] });
    assert.equal(calls, 0, '名字错了还发请求，等于让作者付了钱却没用上他要的写法');
    assert.equal(last('genPhase').phase, 'error');
  });

  test('给创作模型的那一份认得出来', async () => {
    await run({ job: 'outline', target: '.novelforge/outline.md', skills: ['project:去AI味'] });
    assert.equal(calls, 1);
    assert.equal(last('genPhase').phase, 'done');
  });
});

// ---------------------------------------------------------------- 跑与采纳

describe('产出不落盘，采纳才写', () => {
  let draftId;

  beforeEach(async () => {
    posted = [];
    calls = 0;
    await run({ job: 'outline', target: '.novelforge/outline.md' });
    draftId = last('genDone').draft.draftId;
  });

  test('正文流给前端', () => {
    assert.ok(of('genDelta').some((m) => m.text.includes('少年下山')), JSON.stringify(of('genDelta')));
  });

  test('结论里带形状与落点，没有正文', () => {
    const { draft } = last('genDone');
    assert.ok(draft.artifact.summary.includes('全书大纲'), draft.artifact.summary);
    assert.equal(draft.relPath, '.novelforge/outline.md');
    assert.equal(draft.raw, undefined, '产出的正文不该再回灌一遍');
  });

  test('这一刻磁盘上什么都没变', () => {
    assert.equal(t.read('.novelforge/outline.md').includes('少年下山'), false);
  });

  test('不碰会话，也不进 DraftStore', () => {
    assert.equal(controller.current.turns.length, 0, '生成页不该往会话里塞东西');
    assert.equal(controller.drafts.get(draftId), undefined, '生成页的产出不该进 agent 那条路的草稿表');
  });

  test('采纳之后才写进去', async () => {
    posted = [];
    await controller.dispatch({ type: 'genAdopt', draftId, text: '# 全书大纲\n\n少年下山，一路问道。\n' });
    assert.ok(last('genAdopted').relPath, JSON.stringify(last('genAdopted')));
    assert.ok(t.read('.novelforge/outline.md').includes('少年下山'));
    t.write('.novelforge/outline.md', '');
  });

  test('写进去的是作者改过的那一版，不是生成那一刻的原文', async () => {
    await controller.dispatch({ type: 'genAdopt', draftId, text: '# 全书大纲\n\n作者自己改过的一句。\n' });
    assert.ok(t.read('.novelforge/outline.md').includes('作者自己改过'));
    t.write('.novelforge/outline.md', '');
  });

  test('不采纳：磁盘不动，那一份也就没了', async () => {
    posted = [];
    await controller.dispatch({ type: 'genDiscard', draftId });
    assert.equal(t.read('.novelforge/outline.md').includes('少年下山'), false);
    await controller.dispatch({ type: 'genAdopt', draftId, text: '随便什么' });
    assert.equal(last('genAdopted').relPath, undefined, '丢过的产出不该还能采纳');
  });

  test('内容是空的就不写', async () => {
    posted = [];
    await controller.dispatch({ type: 'genAdopt', draftId, text: '   ' });
    assert.equal(last('genAdopted').relPath, undefined);
    assert.equal(t.read('.novelforge/outline.md').includes('少年下山'), false);
  });
});
