/**
 * 分段重写情节大纲（features/outlineRewrite.ts）：工程页「情节大纲」右键「重写…」。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 分段 | 已写 / 没写各自按 20 章切、段不跨线；散文式与空大纲不分段 |
 * | 全套 | 已写的段照摘要整理、其余照架构规划；要求每段都带；后一段看得见前一段的新版；一次审阅、整份写入 |
 * | 中途失败 | 已重写的几段照样审阅写入，没轮到的保留旧版，报错 |
 * | 不写入 | 审阅时放弃：磁盘不动 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let replyFn;
const projects = [];

const OUTLINE = '.novelforge/outline.md';
const pad3 = (n) => String(n).padStart(3, '0');

/** 旧大纲：第 1–45 章，每节 5 章。 */
function oldOutline() {
  const parts = ['# 情节大纲'];
  for (let a = 1; a <= 45; a += 5) {
    parts.push(`## 第${a}–${a + 4}章：旧版\n\n旧版第 ${a}–${a + 4} 章。`);
  }
  return `${parts.join('\n\n')}\n`;
}

function sections(from, to, tag) {
  const out = [];
  for (let a = from; a <= to; a += 5) {
    const b = Math.min(to, a + 4);
    out.push(`## 第${a}–${b}章：${tag}\n\n${tag}第 ${a}–${b} 章。`);
  }
  return out.join('\n\n');
}

/** 这一次调用要写哪一段、走哪份契约。 */
function rangeOf(messages) {
  const user = messages[messages.length - 1].content;
  const derived = /里第 (\d+)(?:–(\d+))? 章实际发生/.exec(user);
  if (derived) {
    return { derive: true, from: Number(derived[1]), to: Number(derived[2] ?? derived[1]) };
  }
  const planned = /本次必须对第 (\d+)(?:–(\d+))? 章输出/.exec(user);
  return planned ? { derive: false, from: Number(planned[1]), to: Number(planned[2] ?? planned[1]) } : undefined;
}

function defaultReply(messages) {
  const r = rangeOf(messages);
  return r ? sections(r.from, r.to, r.derive ? '整理' : '新规划') : '';
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    rewrite: './src/core/features/outlineRewrite.ts',
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
  t.write(OUTLINE, oldOutline());
  t.project.invalidate();
  fake.reset();
  replyFn = defaultReply;
  h.setReviewVerdict('apply');
  return t;
}

describe('分段', () => {
  test('已写 / 没写各自按 20 章切，段不跨线', () => {
    const plan = bundle.rewrite.planOutlineRewrite(114, 100);
    assert.deepEqual(
      plan.batches.map((b) => [b.from, b.to, b.derive]),
      [
        [1, 20, true],
        [21, 40, true],
        [41, 60, true],
        [61, 80, true],
        [81, 100, true],
        [101, 114, false],
      ]
    );
  });

  test('一章没写：全部重新规划；写过的比大纲还长：全部照正文整理', () => {
    assert.deepEqual(bundle.rewrite.planOutlineRewrite(30, 0).batches.map((b) => [b.from, b.to, b.derive]), [
      [1, 20, false],
      [21, 30, false],
    ]);
    const over = bundle.rewrite.planOutlineRewrite(30, 50);
    assert.equal(over.through, 30);
    assert.ok(over.batches.every((b) => b.derive));
  });

  test('散文式大纲与空大纲不分段', async () => {
    const t = await fresh('outline-rewrite-prose');
    t.write(OUTLINE, '# 情节大纲\n\n林昭入宗，一路查下去。\n');
    t.project.invalidate();
    assert.equal(await bundle.rewrite.outlineRewritePlan(t.project), undefined);
    t.write(OUTLINE, '');
    t.project.invalidate();
    assert.equal(await bundle.rewrite.outlineRewritePlan(t.project), undefined);
  });
});

describe('全套', () => {
  let t;
  let plan;
  let calls;
  before(async () => {
    t = await fresh('outline-rewrite-all');
    plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.expect();
    calls = await bundle.rewrite.rewriteOutline(t.project, plan, '节奏再快一点');
  });

  test('第 1–7 章照摘要整理，第 8–45 章分两段重新规划，说明里写明次数', () => {
    assert.deepEqual(
      plan.batches.map((b) => [b.from, b.to, b.derive]),
      [
        [1, 7, true],
        [8, 27, false],
        [28, 45, false],
      ]
    );
    const text = bundle.rewrite.describeOutlineRewrite(plan);
    assert.match(text, /调用 3 次模型/);
    assert.match(text, /第 1–7 章已经写成，照各章摘要整理/);
    assert.match(text, /第 8–45 章照架构重新规划/);
    assert.equal(calls, 3);
    assert.deepEqual(fake.calls.map((m) => rangeOf(m)), plan.batches);
  });

  test('作者的要求每一段都带', () => {
    for (const m of fake.calls) {
      assert.ok(m.some((x) => x.content.includes('节奏再快一点')));
    }
  });

  test('后一段看得见前一段刚写好的新版，没轮到的还是旧版', () => {
    const second = fake.calls[1].map((x) => x.content).join('\n');
    assert.match(second, /【重写中】第 1–7 章是这次刚重写好的新版/);
    assert.match(second, /整理第 1–5 章/);
    assert.match(second, /旧版第 26–30 章/);
    assert.doesNotMatch(second, /旧版第 1–5 章/);
  });

  test('一次审阅、整份写入', () => {
    assert.equal(h.reviewed.length, 1);
    const disk = t.read(OUTLINE);
    assert.doesNotMatch(disk, /旧版/);
    assert.match(disk, /## 第1–5章：整理/);
    assert.match(disk, /## 第8–12章：新规划/);
    assert.match(disk, /## 第43–45章：新规划/);
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
    const disk = t.read(OUTLINE);
    assert.match(disk, /## 第8–12章：新规划/);
    assert.match(disk, /## 第31–35章：旧版/);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('已重写第 1–27 章的大纲，后面的保留旧版')), h.toasts.join('\n'));
  });
});

describe('不写入', () => {
  test('审阅时放弃：磁盘不动', async () => {
    const t = await fresh('outline-rewrite-discard');
    const plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.setReviewVerdict('discard');
    h.expect();
    await bundle.rewrite.rewriteOutline(t.project, plan, '');
    assert.equal(t.read(OUTLINE), oldOutline());
  });
});
