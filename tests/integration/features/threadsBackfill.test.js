/**
 * 从已写正文补记叙事线（`features/threadsBackfill.ts`，叙事线重做四期第 2 个提交）：要判哪几章、确认框怎么说、按章串行判、
 * 一章没判成就停、再点一次从那一章接着判。真临时工程 + 假模型；工程页一路点下来的四期验收另在 threadsBackfillFlow.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 要判的是水位之后、定稿到之前、定稿过且正文没再改过的章；改过的、没定稿的列进 skipped | 第 4 条：不偷偷补 |
 * | 一条线都没有、有情节大纲：先排线，次数算进同一个确认框（每章 2–6 次 + 排线 2 次；2026-10-25 起含转写） | 设计稿「九」；第 4 条 |
 * | 确认框写明章数与次数，走「定稿」档（加上排线的「剧情细纲」档）、看详细度，转写单列一行 | 第 4 条；设计稿「调用次数」 |
 * | 按章号串行：后一章认事件时看得到前一章新认出的线 | 串行的理由 |
 * | 一章没判成：停下，已判的留着，水位停在它前面，失败挂在那一章上；后面的章一次都没调 | 第 16 条；⚑ 一章没判成就停 |
 * | 再点一次：从没判成的那一章接着判，水位推到定稿到，那一章上的失败清掉 | 补记从水位之后接着走 |
 * | 完成提示：判了几章、记了多少事件、新认出几条线几条伏笔、哪几章没判成、判到第几章 | 第 2 条 |
 */
const { describe, test, before, after } = require('node:test');
const fs = require('fs');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;

const THREADS = '.novelforge/threads';
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const text = (no) => `# 第${no}章\n\n林昭在第${no}章走进青崖镇。\n\n沈氏在第${no}章翻开名册。\n`;

/** 第几章认事件那一次答坏（解析不出）。 */
let broken = new Set();
/** 认事件那一次送来了哪几章（按先后）、送来时提示里有没有「沈氏的来意」那条线。 */
const asked = [];

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线')) {
    return JSON.stringify({ threads: [{ title: '青崖旧案', kind: '主线', from: 1, to: 30, intent: '查清七年前那场火。' }] });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('你是小说定稿事实审查员')) {
    asked.push({ no, knowsGrown: user.includes('沈氏的来意') });
    if (broken.has(no)) {
      return '这一章没什么好说的。';
    }
    return JSON.stringify({
      events: [{ line: '青崖旧案', type: '推进', what: `第 ${no} 章往前查`, evidence: `林昭在第${no}章走进青崖镇。` }],
      newThreads:
        no === 1 ? [{ title: '沈氏的来意', kind: '人物线', intent: '沈氏为何盯上林昭。', evidence: '沈氏在第1章翻开名册。' }] : [],
      newForeshadowing: [],
    });
  }
  if (system.includes('判断它们是不是已有的某一条换了个说法')) {
    return JSON.stringify({ merges: [] });
  }
  if (system.includes('给每一条写一两句「当前进度」')) {
    const lines = [...user.matchAll(/^【线】(.+)$/gm)].map((m) => m[1]);
    return JSON.stringify({ progress: lines.map((line) => ({ line, text: `第 ${no} 章：${line}走到了这里。` })) });
  }
  return '（认不出这一步）';
}

/** 第 1–n 章：正文 + 定稿过的细纲（sourceHash 对得上正文）。 */
async function writeFinalized(n) {
  for (let no = 1; no <= n; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= n; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
  }
  project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    threadFile: './src/core/model/threadFile.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'threads-backfill', title: '青崖记' });
  project = t.project;
  await writeFinalized(6);
  // 情节大纲是各章细纲梗概的汇总：第 1–6 章换成大纲那一条，第 7–20 章建只有梗概的空壳。
  writeOutline(t, outlineOf(20, { text: { 1: '林昭进镇，一路查名册。' } }));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];

describe('要判哪几章（零调用）', () => {
  test('水位之后、定稿到之前：定稿过、正文没改过的判；改过的、没定稿的列出来；一条线都没有、有大纲就先排线', async () => {
    // 第 2 章判过了（单章定稿时）；第 5 章定稿之后正文又改了；第 7 章写了没定稿（在定稿到之后，不归补记管）。
    await project.writeManifest({ ...(await project.readManifest()), threadsJudged: [2] });
    t.write(CH(5), `${text(5)}\n又加了一段。\n`);
    t.write(CH(7), text(7));
    project.invalidate();
    const plan = await bundle.backfill.planThreadsBackfill(project);
    assert.deepEqual(plan.chapters.map((c) => c.order), [1, 3, 4, 6]);
    assert.deepEqual(plan.skipped, [{ no: 5, why: '同步之后正文又改过' }]);
    assert.equal(plan.planFirst, true);
    assert.equal(plan.current, 6);
    // 每章写 1–3 次、各转写 1 次（重转最多再 1 次）：2–6、最多 9；先排线：排 1 次、转写 1 次，最多 3 次。
    assert.deepEqual(plan.calls, { low: 8 + 2, high: 24 + 2, max: 36 + 3 });
    // 收回去：后面的用例从干净的第 1–6 章起。
    await project.writeManifest({ ...(await project.readManifest()), threadsJudged: undefined });
    t.write(CH(5), text(5));
    t.remove(CH(7));
    project.invalidate();
  });

  test('没有情节大纲（没有一章细纲写了梗概）：不排线；中间没定稿的章列出来', async () => {
    const dir = t.rel('.novelforge/summaries');
    const saved = new Map();
    for (const name of fs.readdirSync(dir).filter((f) => /^\d/.test(f))) {
      const rel = `.novelforge/summaries/${name}`;
      saved.set(rel, t.read(rel));
      t.write(rel, saved.get(rel).replace(/## 梗概\n[\s\S]*?(?=\n## |$)/, '## 梗概\n'));
    }
    t.write(PLOT(3), t.read(PLOT(3)).replace(/sourceHash: .*\n/, ''));
    project.invalidate();
    const plan = await bundle.backfill.planThreadsBackfill(project);
    assert.equal(plan.planFirst, false);
    assert.deepEqual(plan.skipped, [{ no: 3, why: '还没同步' }]);
    assert.deepEqual(plan.calls, { low: 10, high: 30, max: 45 });
    for (const [rel, text] of saved) {
      t.write(rel, text);
    }
    await writeFinalized(6);
    writeOutline(t, outlineOf(6, { text: { 1: '林昭进镇，一路查名册。' } }));
    project.invalidate();
  });
});

describe('补记：按章串行，第 4 章没判成就停', () => {
  let n;

  before(async () => {
    broken = new Set([4]);
    asked.length = 0;
    fake.calls.length = 0;
    h.expect('开始补记');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('确认框写明章数与次数，先排线算进去；走「定稿」档与「剧情细纲」档，看详细度', () => {
    const c = h.confirms.at(-1);
    assert.match(c.message, /^从已写正文补记叙事线：第 1–6 章同步过、叙事线还没判/);
    assert.ok(c.message.includes('先从情节大纲排一次（排 1 次、转写 1 次）'), c.message);
    assert.ok(c.message.includes('（每章 2–6 次）') && c.message.includes('预计 14–38 次调用，最多 57 次'), c.message);
    assert.deepEqual(c.actions, ['开始补记']);
    assert.ok(c.detail.includes('共 6 章，按章号一章一章往后判'), c.detail);
    assert.equal(c.call.tiers.length, 2);
    // 转写不跟这一次挑的模型，单列一行（2026-10-25）。
    assert.equal(c.call.fixed?.length, 1, JSON.stringify(c.call));
    assert.ok('contextDetail' in c.call);
  });

  test('先排线，再按章号串行：第 2 章认事件时看得到第 1 章新认出的线；第 4 章没判成就停，第 5、6 章没调', () => {
    assert.deepEqual(asked.map((a) => a.no), [1, 2, 3, 4]);
    assert.equal(asked[0].knowsGrown, false);
    assert.equal(asked[1].knowsGrown, true);
    assert.ok(t.has(`${THREADS}/青崖旧案.md`));
    assert.ok(t.has(`${THREADS}/沈氏的来意.md`));
    // 排线 1 + 第 1 章（认事件、归并、当前进度）3 + 第 2、3 章（认事件、当前进度）各 2 + 第 4 章认事件 1。
    assert.equal(fake.calls.length, 1 + 3 + 2 + 2 + 1);
    assert.equal(n, fake.calls.length);
  });

  test('已判的留着、水位停在第 4 章前面；失败挂在第 4 章上（黄 ❗，op threads）', async () => {
    const main = bundle.threadFile.parseThreadFile(t.read(`${THREADS}/青崖旧案.md`), `${THREADS}/青崖旧案.md`);
    assert.deepEqual(main.events.filter((e) => !e.planned).map((e) => e.chapter), [1, 2, 3]);
    assert.deepEqual(await project.readThreadsMark(), { through: 3, judged: [] });
    const [f] = await failuresOf(CH(4));
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threads');
    assert.match(f.message, /^从已写正文补记叙事线没成/);
  });

  test('完成提示：先排线、判了几章、记了多少事件、新认出几条线；第 4 章没判成、后面 2 章没判；判到第 3 章', () => {
    const toast = h.toasts.at(-1);
    assert.ok(toast.startsWith('error: '), toast);
    assert.ok(toast.includes('先从情节大纲排出 1 条叙事线'), toast);
    assert.ok(toast.includes('叙事线补记：判了 3 章（第 1–3 章），记下 4 个事件，新认出 1 条线'), toast);
    assert.ok(toast.includes('第 4 章没判成（模型返回的叙事线事件解析不出来），停在那里，后面 2 章没判'), toast);
    assert.ok(toast.includes('叙事线判到第 3 章（同步到第 6 章）'), toast);
  });

  test('再点一次：线已经有了不再排，从第 4 章接着判，水位推到第 6 章，第 4 章上的失败清掉', async () => {
    broken = new Set();
    asked.length = 0;
    h.expect('开始补记');
    await bundle.backfill.backfillThreads(project);
    const c = h.confirms.at(-1);
    assert.match(c.message, /^从已写正文补记叙事线：第 4–6 章同步过/);
    assert.ok(!c.message.includes('先从情节大纲排一次'), c.message);
    assert.deepEqual(asked.map((a) => a.no), [4, 5, 6]);
    assert.deepEqual(await project.readThreadsMark(), { through: 6, judged: [] });
    assert.deepEqual(await failuresOf(CH(4)), []);
    assert.ok(h.toasts.at(-1).includes('叙事线判到第 6 章，跟上了同步'), h.toasts.at(-1));
  });

  test('跟上了再点：不弹框、零调用，说清已经判到哪', async () => {
    fake.calls.length = 0;
    h.expect();
    assert.equal(await bundle.backfill.backfillThreads(project), 0);
    assert.equal(h.confirms.length, 0);
    assert.equal(fake.calls.length, 0);
    assert.ok(h.toasts.at(-1).includes('叙事线已经判到第 6 章、跟上了同步'), h.toasts.at(-1));
  });
});
