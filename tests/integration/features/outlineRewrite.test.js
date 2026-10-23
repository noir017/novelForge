/**
 * 分段重写情节大纲（features/outlineRewrite.ts）：工程页「情节大纲」右键「重写…」。
 *
 * 情节大纲是各章细纲「梗概」的汇总（docs/design/plans/2026-10-22-outline-from-plots.md）：**只重写还没写正文的章**，
 * 写过的那几条由定稿照正文写，不动；写入时按章号拆回各章细纲。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 分段 | 只切没写的那一截，按 20 章一段；空大纲不分段；排到的章都写过了，段是空的 |
 * | 全套 | 照架构规划；要求每段都带；后一段看得见前一段的新版；一次审阅、整份写入（拆回各章细纲），写过的章不动 |
 * | 中途失败 | 已重写的几段照样审阅写入，没轮到的保留旧版，报错 |
 * | 不写入 | 审阅时放弃：细纲一个字不动 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let replyFn;
const projects = [];

const pad3 = (n) => String(n).padStart(3, '0');

/** 旧大纲：第 1–45 章，一章一条。 */
function oldOutline() {
  return `# 情节大纲\n\n${entries(1, 45, '旧版')}\n`;
}

/** 第 from–to 章，一章一条：`## 第N章：tag` + `tag第 N 章。` */
function entries(from, to, tag) {
  const out = [];
  for (let no = from; no <= to; no++) {
    out.push(`## 第${no}章：${tag}\n${tag}第 ${no} 章。`);
  }
  return out.join('\n\n');
}

/** 这一次调用要写哪一段。 */
function rangeOf(messages) {
  const user = messages[messages.length - 1].content;
  const planned = /本次必须写第 (\d+)(?:–(\d+))? 章的情节大纲/.exec(user);
  return planned ? { from: Number(planned[1]), to: Number(planned[2] ?? planned[1]) } : undefined;
}

function defaultReply(messages) {
  const r = rangeOf(messages);
  return r ? entries(r.from, r.to, '新规划') : '';
}

/** 汇总出来的情节大纲（没有标题行与说明）。 */
async function outlineOf(t) {
  t.project.invalidate();
  return t.project.readOutline();
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    rewrite: './src/core/features/outlineRewrite.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => replyFn(messages) });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

/** 写了 7 章、大纲排到第 45 章的工程。 */
async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '重写大纲测试' });
  projects.push(t);
  for (let no = 1; no <= 7; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n林昭第${no}次见到沈青。\n`);
  }
  writeOutline(t, oldOutline());
  t.project.invalidate();
  fake.reset();
  replyFn = defaultReply;
  h.setReviewVerdict('apply');
  return t;
}

describe('分段', () => {
  test('只切没写的那一截，按 20 章一段', () => {
    const plan = bundle.rewrite.planOutlineRewrite(114, 100);
    assert.deepEqual(plan.batches.map((b) => [b.from, b.to]), [[101, 114]]);
    assert.deepEqual(bundle.rewrite.planOutlineRewrite(30, 0).batches.map((b) => [b.from, b.to]), [
      [1, 20],
      [21, 30],
    ]);
  });

  test('排到的章都写过了：段是空的', () => {
    const over = bundle.rewrite.planOutlineRewrite(30, 50);
    assert.equal(over.through, 30);
    assert.deepEqual(over.batches, []);
  });

  test('还没有大纲（没有一章有梗概）不分段', async () => {
    const t = await makeTempProject(bundle.project, { prefix: 'outline-rewrite-empty', title: '空' });
    projects.push(t);
    assert.equal(await bundle.rewrite.outlineRewritePlan(t.project), undefined);
  });
});

describe('全套', () => {
  let t;
  let plan;
  let calls;
  let before7;
  before(async () => {
    t = await fresh('outline-rewrite-all');
    before7 = t.read('.novelforge/summaries/007-第7章.md');
    plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.expect();
    calls = await bundle.rewrite.rewriteOutline(t.project, plan, '节奏再快一点');
  });

  test('第 1–7 章写过了不重写，第 8–45 章分两段重新规划，说明里写明次数', () => {
    assert.deepEqual(plan.batches.map((b) => [b.from, b.to]), [
      [8, 27],
      [28, 45],
    ]);
    const text = bundle.rewrite.describeOutlineRewrite(plan);
    assert.match(text, /按 20 章一段重写第 8–45 章，调用 2 次模型/);
    assert.match(text, /第 1–7 章已经写了正文，那几条由定稿照正文写，不动/);
    assert.equal(calls, 2);
    assert.deepEqual(fake.calls.map((m) => rangeOf(m)), plan.batches);
  });

  test('作者的要求每一段都带', () => {
    for (const m of fake.calls) {
      assert.ok(m.some((x) => x.content.includes('节奏再快一点')));
    }
  });

  test('后一段看得见前一段刚写好的新版，没轮到的还是旧版', () => {
    const second = fake.calls[1].map((x) => x.content).join('\n');
    assert.match(second, /【重写中】第 8–27 章是这次刚重写好的新版/);
    assert.match(second, /新规划第 26 章。/);
    assert.doesNotMatch(second, /旧版第 26 章。/);
    const first = fake.calls[0].map((x) => x.content).join('\n');
    // 这一段（第 8–27 章）之后还没轮到的旧版只带第一行。
    assert.match(first, /后面已经排好的（只列第一行）：\n- 第28章 旧版：旧版第 28 章。/);
  });

  test('一次审阅、整份写入：拆回各章细纲，写过的章一个字不动', async () => {
    assert.equal(h.reviewed.length, 1);
    const outline = await outlineOf(t);
    assert.match(outline, /## 第1章：旧版\n旧版第 1 章。/);
    assert.match(outline, /## 第8章：新规划\n新规划第 8 章。/);
    assert.match(outline, /## 第45章：新规划/);
    assert.doesNotMatch(outline, /旧版第 8 章/);
    assert.equal(t.read('.novelforge/summaries/007-第7章.md'), before7);
    assert.ok(!h.erred(), h.toasts.join('\n'));
  });
});

describe('中途失败', () => {
  test('已重写的几段照样审阅写入，没轮到的保留旧版，报错', async () => {
    const t = await fresh('outline-rewrite-halt');
    const plan = await bundle.rewrite.outlineRewritePlan(t.project);
    replyFn = (m) => (rangeOf(m)?.from === 28 ? '' : defaultReply(m));
    h.expect();
    await bundle.rewrite.rewriteOutline(t.project, plan, '');
    assert.equal(h.reviewed.length, 1);
    const outline = await outlineOf(t);
    assert.match(outline, /## 第8章：新规划/);
    assert.match(outline, /## 第31章：旧版/);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('已重写第 8–27 章的大纲，后面的保留旧版')), h.toasts.join('\n'));
  });
});

describe('不写入', () => {
  test('审阅时放弃：细纲一个字不动', async () => {
    const t = await fresh('outline-rewrite-discard');
    const before = await outlineOf(t);
    const plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.setReviewVerdict('discard');
    h.expect();
    await bundle.rewrite.rewriteOutline(t.project, plan, '');
    assert.equal(await outlineOf(t), before);
  });
});

// 工程页「情节大纲」右键「重写…」：问完要求先弹确认框报段数、挑这一次的模型（2026-10-23 作者要的），取消就不调。
describe('从工程页右键进来', () => {
  async function rewriteFromProjectPage(t, ...answers) {
    const controller = new bundle.controller.ChatController(t.project);
    controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
    h.expect(...answers);
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'outline' } });
    controller.dispose();
  }

  test('问完要求、在确认框上取消：不调模型，大纲不动', async () => {
    const t = await fresh('outline-rewrite-confirm-cancel');
    const before = await outlineOf(t);
    await rewriteFromProjectPage(t, '节奏再快一点', undefined);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['开始重写']);
    assert.ok(c.message.includes('预计 2 次调用'), c.message);
    assert.match(c.detail, /按 20 章一段重写第 8–45 章/);
    assert.equal(c.call.model, '', '缺省按分档（与不问时一样走情节大纲那一档）');
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
    assert.equal(fake.callCount(), 0);
    assert.equal(await outlineOf(t), before);
  });

  test('点「开始重写」：照分段重写', async () => {
    const t = await fresh('outline-rewrite-confirm-go');
    await rewriteFromProjectPage(t, '', '开始重写');
    assert.equal(fake.callCount(), 2);
    assert.match(await outlineOf(t), /## 第8章：新规划/);
  });
});
