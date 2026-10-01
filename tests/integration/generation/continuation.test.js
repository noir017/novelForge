/**
 * 正文的续写链（generation/continuation.ts 的 `completeManuscript`，经 `generate` 跑）。
 *
 * 假模型按轮脚本化应答（`{ text, stop }`），钉住三期计划 §3 的每一个分支：
 *
 * | 情形 | 断言 |
 * |---|---|
 * | 一次写够 | 1 次调用，不续写，没有说明 |
 * | 截断后续写 | 被截断就续，哪怕字数够了；气泡里轮与轮之间只空一行 |
 * | 不到八成续写 | 正常收尾但不够八成就续 |
 * | 低增长丢弃、恢复一次 | 被截断又没写出东西：丢掉、气泡退回、恢复那一轮开头说清 |
 * | 恢复也失败 | 停下，已写的保留，照样出 Draft |
 * | 思考耗尽 | 截断且正文不到 100 字：报错，不出 Draft |
 * | 最终未写够 | 模型收尾又只多了几句：不再催，说「未写够」，照样出 Draft |
 * | 续写那一轮调用失败 | 已写的保留 |
 * | 重演 | 开头搬了上一章结尾：Draft 带 `replay`，说明里写明 |
 * | 接着写 | 只含新增的那一段，字数连已有的算 |
 * | 重写 | 上一版正文作底稿带进 prompt |
 * | 收尾过早（五期补遗 §1.1） | 先回退到钩子那一段之前再写；回退之后又收尾就停；回退那一轮没写成就把原结尾放回去 |
 * | 本章边界（§1.2、§1.3） | 执行卡后面点名「本章不出场」的人与比喻词上限；续写那一轮说已经用了几次 |
 * | 写完查（§1.2、§1.3、§1.5） | 提前登场、比喻词超标、英文缩写都记进说明 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let gen;
let h;
let fake;
let t;
let project;
let settings = {};
let script = [];

const P1 = '.novelforge/plots/001-夜入青云.md';
const P2 = '.novelforge/plots/002-客栈.md';
const P3 = '.novelforge/plots/003-夜访.md';

/** 第 1 章的正文（写第 2 章时，它的结尾是重演检测的对照）。 */
const CH1_END = [
  '雪下到半夜才停。林昭把残令揣进怀里，沿着河堤往回走，脚下的冰壳一踩就碎，远处的更鼓敲过了三下。',
  '客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空，半晌才说了一句：“李叔来过，问你去了哪里，我说你出城收账去了。”',
].join('\n\n');

function recorder() {
  const r = { deltas: [], done: undefined, error: undefined, progress: [], resets: [] };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
      onProgress: (p) => r.progress.push(p),
      onReset: (full) => r.resets.push(full),
    },
  };
}

async function write(plotRelPath, replies, extra = {}) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await gen.generate(
    project,
    { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath }, ask: '', ...extra },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, users: fake.calls.map((c) => c[c.length - 1].content) };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  gen = bundle.generate;
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'continuation', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  // 第 3 章才排沈秋：写第 2 章时他在「本章不出场」的名单上（五期补遗 §1.2）。
  const cast = { 1: ['林昭'], 2: ['林昭'], 3: ['林昭', '沈秋'] };
  for (const [no, title] of [[1, '夜入青云'], [2, '客栈'], [3, '夜访']]) {
    await ws.writePlot({
      no,
      title,
      role: '',
      characters: cast[no],
      targetWords: 1000,
      upstreamHash: '',
      done: false,
      sections: { ...empty, 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章的关键事件`, 章末钩子: `第 ${no} 章的钩子` },
    });
  }
  await ws.createChapter(1, '夜入青云', `${filler(900, 1)}\n\n${CH1_END}`);
  await ws.createChapter(3, '夜访', filler(400, 3));
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('一次写够', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: filler(900, 10), stop: 'end' }]);
  });

  test('只调一次，不续写', () => {
    assert.equal(r.calls, 1);
    assert.equal(r.draft.length.rounds, 0);
    assert.equal(r.draft.calls, 1);
  });

  test('够了八成：已达标，没有说明', () => {
    assert.equal(r.draft.length.reached, true);
    assert.equal(r.draft.length.words, 900);
    assert.equal(r.draft.length.target, 1000);
    assert.equal(r.draft.notes, undefined, JSON.stringify(r.draft.notes));
  });

  test('写法：这一章还没有正文 → write', () => {
    assert.equal(r.draft.writeMode, 'write');
  });

  test('进度从第 0 轮报起，报到写完的字数', () => {
    assert.equal(r.rec.progress[0].round, 0);
    assert.equal(r.rec.progress.at(-1).words, 900);
    assert.equal(r.rec.progress.at(-1).target, 1000);
  });
});

describe('截断后续写', () => {
  let r;
  before(async () => {
    // 字数已经够了，但结尾停在半句上：照样续。
    r = await write(P2, [{ text: filler(850, 11), stop: 'maxTokens' }, { text: filler(400, 12), stop: 'end' }]);
  });

  test('续了一轮，一共 2 次调用', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.rounds, 1);
    assert.equal(r.draft.calls, 2);
  });

  test('两段拼成一章，中间空一行', () => {
    assert.equal(r.draft.raw, `${filler(850, 11)}\n\n${filler(400, 12)}`);
    assert.equal(r.draft.length.words, 1250);
  });

  test('气泡里轮与轮之间只空一行，不插「——第 k 步——」', () => {
    const streamed = r.rec.deltas.join('');
    assert.ok(!streamed.includes('——'), streamed.slice(0, 80));
    assert.ok(streamed.includes(`${filler(850, 11)}\n\n${filler(400, 12)}`));
  });

  test('续写那一轮带着已写的末尾，说清还差多少', () => {
    assert.match(r.users[1], /请无缝续写当前章节正文/);
    assert.match(r.users[1], /# 本章已写正文/);
    assert.match(r.users[1], /剩余约 150 字/);
  });

  test('说明里写了续写了几轮', () => {
    assert.ok(r.draft.notes.some((n) => /续写第 1 轮：多了 400 字/.test(n)), JSON.stringify(r.draft.notes));
  });

  test('进度报了第 1 轮', () => {
    assert.ok(r.rec.progress.some((p) => p.round === 1));
  });
});

describe('不到八成续写', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: filler(500, 20), stop: 'end' }, { text: filler(450, 21), stop: 'end' }]);
  });

  test('正常收尾但只有一半：续一轮', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.words, 950);
    assert.equal(r.draft.length.reached, true);
  });
});

describe('续写被截断又没写出东西：丢弃，恢复一次', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 30), stop: 'end' },
      { text: filler(120, 31), stop: 'maxTokens' },
      { text: filler(400, 32), stop: 'end' },
    ]);
  });

  test('3 次调用：写、丢掉的那一轮、恢复', () => {
    assert.equal(r.calls, 3);
    assert.equal(r.draft.length.rounds, 2);
  });

  test('丢掉的那一轮不在正文里', () => {
    assert.ok(!r.draft.raw.includes(filler(120, 31)));
    assert.equal(r.draft.raw, `${filler(500, 30)}\n\n${filler(400, 32)}`);
  });

  test('气泡退回到丢弃之前那一版', () => {
    assert.deepEqual(r.rec.resets, [filler(500, 30)]);
  });

  test('恢复那一轮开头说清「上一轮已丢弃」', () => {
    assert.match(r.users[2], /已被全部丢弃/);
    assert.ok(!r.users[1].includes('已被全部丢弃'));
  });

  test('说明里写了丢弃与恢复', () => {
    assert.ok(r.draft.notes.some((n) => /已丢弃，再给一次恢复机会/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('恢复那一轮也没写出东西：停下，已写的保留', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 40), stop: 'end' },
      { text: filler(80, 41), stop: 'maxTokens' },
      { text: filler(90, 42), stop: 'maxTokens' },
      { text: filler(900, 43), stop: 'end' },
    ]);
  });

  test('只给一次恢复机会：3 次调用就停', () => {
    assert.equal(r.calls, 3);
  });

  test('照样出 Draft，正文是丢弃之前的那一版', () => {
    assert.ok(r.draft);
    assert.equal(r.draft.raw, filler(500, 40));
  });

  test('未写够、最后被截断，都写进说明', () => {
    assert.equal(r.draft.length.reached, false);
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /恢复）仍被截断/);
    assert.match(notes, /未写够：这一章写到 500 \/ 1000 字/);
  });
});

describe('思考把输出预算吃光了', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ reasoning: '想了很久很久……', text: filler(30, 50), stop: 'maxTokens' }]);
  });

  test('报错，说清是思考吃光的，提示怎么调', () => {
    assert.match(r.rec.error, /思考/);
    assert.match(r.rec.error, /最大输出 token|思考深度/);
  });

  test('不出 Draft，不再续写', () => {
    assert.equal(r.draft, undefined);
    assert.equal(r.calls, 1);
  });
});

describe('最终未写够：模型收尾、又只多了几句', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(400, 60), stop: 'end' },
      { text: filler(100, 61), stop: 'end' },
      { text: filler(900, 62), stop: 'end' },
    ]);
  });

  test('不再催：2 次调用', () => {
    assert.equal(r.calls, 2);
  });

  test('已写的不丢，照样出 Draft', () => {
    assert.equal(r.draft.raw, `${filler(400, 60)}\n\n${filler(100, 61)}`);
    assert.equal(r.draft.length.reached, false);
  });

  test('说明里写「未写够」与为什么停', () => {
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /只多了 100 字，模型已经收尾/);
    assert.match(notes, /未写够/);
  });
});

describe('续写那一轮调用失败', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 70), stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假装 502');
      },
    ]);
  });

  test('前面写好的保留，照样出 Draft', () => {
    assert.ok(r.draft, r.rec.error);
    assert.equal(r.draft.raw, filler(500, 70));
    assert.equal(r.rec.error, undefined);
  });

  test('说明里写了哪一轮、为什么', () => {
    assert.ok(r.draft.notes.some((n) => /续写第 1 轮调用失败（.*502/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('重演上一章结尾', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: `${CH1_END}\n\n${filler(900, 80)}`, stop: 'end' }]);
  });

  test('Draft 带上重合的那一段原文', () => {
    assert.ok(r.draft.replay, JSON.stringify(r.draft.notes));
    assert.ok(r.draft.replay.includes('沈氏坐在柜台后面'), r.draft.replay);
  });

  test('说明里写明', () => {
    assert.ok(r.draft.notes.some((n) => /与上一章结尾大段重合/.test(n)), JSON.stringify(r.draft.notes));
  });

  test('没重演的不带', async () => {
    const clean = await write(P2, [{ text: filler(900, 81), stop: 'end' }]);
    assert.equal(clean.draft.replay, undefined);
  });
});

describe('接着写第 3 章', () => {
  let r;
  before(async () => {
    r = await write(P3, [{ text: filler(500, 90), stop: 'end' }], { writeMode: 'continue' });
  });

  test('Draft 只含新增的那一段', () => {
    assert.equal(r.draft.raw, filler(500, 90));
    assert.equal(r.draft.writeMode, 'continue');
  });

  test('字数连已有的一起算：400 + 500，已达标', () => {
    assert.equal(r.draft.length.words, 900);
    assert.equal(r.draft.length.added, 500);
    assert.equal(r.draft.length.reached, true);
  });

  test('第一次调用就带着本章已写的末尾', () => {
    assert.match(r.users[0], /# 本章已写正文/);
    assert.match(r.users[0], /剩余约 600 字/);
  });

  test('接着写不查重演（这一章的开头早就有了）', () => {
    assert.equal(r.draft.replay, undefined);
  });
});

describe('重写第 3 章（不带写法，这一章已有正文）', () => {
  let r;
  before(async () => {
    r = await write(P3, [{ text: filler(950, 100), stop: 'end' }]);
  });

  test('写法是 rewrite', () => {
    assert.equal(r.draft.writeMode, 'rewrite');
  });

  test('上一版正文作底稿带进 prompt', () => {
    assert.match(r.users[0], /【上一版草稿】/);
    assert.ok(r.users[0].includes(filler(400, 3).slice(0, 50)));
  });

  test('整章重写：字数不含上一版', () => {
    assert.equal(r.draft.length.words, 950);
  });
});

// ---------------------------------------------------------------- 五期补遗

/** 第一次调用：四段，最后一段收在第 2 章的钩子上（一共 420 字左右，不到八成）。 */
const LANDED = [filler(150, 200), filler(150, 201), filler(100, 202), '他回头望去，第 2 章的钩子就这样落了下来。'];

describe('收尾过早：先回退到钩子那一段之前再写', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: LANDED.join('\n\n'), stop: 'end' }, { text: filler(600, 203), stop: 'end' }]);
  });

  test('2 次调用，写够了', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.reached, true);
  });

  test('收在钩子上的那一段拿掉了，新写的接在它前面', () => {
    assert.equal(r.draft.raw, [...LANDED.slice(0, 3), filler(600, 203)].join('\n\n'));
    assert.ok(!r.draft.raw.includes('钩子就这样落了下来'));
  });

  test('气泡退回到切点', () => {
    assert.deepEqual(r.rec.resets, [LANDED.slice(0, 3).join('\n\n')]);
  });

  test('续写那一轮说清收尾拿掉了、要重新落到钩子上，差多少按切完算', () => {
    assert.match(r.users[1], /收尾那一段已经拿掉了/);
    assert.match(r.users[1], /重新落到章末钩子上/);
    assert.match(r.users[1], /剩余约 600 字/);
  });

  test('说明里写了切了几段', () => {
    assert.ok(r.draft.notes.some((n) => /按章末钩子收了尾：拿掉结尾 1 段/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('回退之后又收尾、仍不够八成：不再往钩子后面续', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      { text: filler(350, 210), stop: 'end' },
      { text: filler(500, 211), stop: 'end' },
    ]);
  });

  test('2 次调用就停', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.reached, false);
  });

  test('说明里写为什么停、未写够', () => {
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /没有再往章末钩子后面续写/);
    assert.match(notes, /未写够/);
  });
});

// 真实模型试跑：一次只写一千字上下，一章要回退两三轮。每次只在上一轮新写的那一段里切。
describe('回退之后又收在钩子上、仍不够：再回退一次，只切上一轮那一段', () => {
  const AGAIN = [filler(200, 250), filler(150, 251), '他抬起头，第 2 章的钩子又一次落了下来。'];
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      { text: AGAIN.join('\n\n'), stop: 'end' },
      { text: filler(500, 252), stop: 'end' },
    ]);
  });

  test('3 次调用，写够了', () => {
    assert.equal(r.calls, 3);
    assert.equal(r.draft.length.reached, true);
  });

  test('两次收在钩子上的那一段都拿掉了；前面接受过的一个字没动', () => {
    assert.equal(r.draft.raw, [...LANDED.slice(0, 3), ...AGAIN.slice(0, 2), filler(500, 252)].join('\n\n'));
  });

  test('第二次回退那一轮也说清了', () => {
    assert.match(r.users[2], /收尾那一段已经拿掉了/);
    assert.equal(r.draft.notes.filter((n) => /拿掉结尾 1 段/.test(n)).length, 2, JSON.stringify(r.draft.notes));
  });
});

describe('回退那一轮调用失败：原来的结尾放回去', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假装 502');
      },
    ]);
  });

  test('正文还是第一次写的那一版，结尾在', () => {
    assert.equal(r.draft.raw, LANDED.join('\n\n'));
  });

  test('说明里写了放回去，不说截断', () => {
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /原来的结尾放回去了/);
    assert.ok(!/截断/.test(notes), notes);
  });
});

describe('一段写成的正文没法回退：照旧往后接', () => {
  test('与三期一样续一轮', async () => {
    const r = await write(P2, [{ text: filler(500, 220), stop: 'end' }, { text: filler(450, 221), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.equal(r.draft.raw, `${filler(500, 220)}\n\n${filler(450, 221)}`);
    assert.ok(!r.users[1].includes('收尾那一段已经拿掉了'));
  });
});

describe('本章边界：点名不出场的人、比喻词上限', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: `仿佛隔世。仿佛重生。${filler(500, 230)}`, stop: 'maxTokens' },
      { text: filler(500, 231), stop: 'end' },
    ]);
  });

  test('第一次调用：执行卡后面列出本章不出场的人与比喻词上限', () => {
    assert.match(r.users[0], /【本章边界】/);
    assert.match(r.users[0], /本章不出场：沈秋（第 3 章才登场）/);
    assert.match(r.users[0], /「仿佛」「犹如」「宛如」全章合计不超过 3 次/);
  });

  test('续写那一轮：已经用了几次、还能用几次', () => {
    assert.match(r.users[1], /已写部分用了 2 次「仿佛」「犹如」「宛如」，续写部分最多再用 1 次/);
    assert.match(r.users[1], /本章不出场：沈秋/);
  });

  test('写第 3 章时沈秋排在本章里，不点名', async () => {
    const r3 = await write(P3, [{ text: filler(950, 232), stop: 'end' }]);
    assert.ok(!/本章不出场/.test(r3.users[0]));
  });
});

describe('写完查：提前登场、比喻词超标、英文缩写', () => {
  let r;
  before(async () => {
    const text = [
      filler(400, 240),
      '他仿佛听见了什么，犹如惊弓之鸟，宛如困兽，仿佛又回到那一夜，PTSD 又犯了。',
      `${filler(400, 241)}。巷子尽头站着一个人，是沈秋。`,
    ].join('\n\n');
    r = await write(P2, [{ text, stop: 'end' }]);
  });

  test('提前登场：谁、按细纲第几章、哪一句', () => {
    assert.ok(
      r.draft.notes.some((n) => /沈秋按细纲第 3 章才登场，本章已经写到了：「巷子尽头站着一个人，是沈秋。」/.test(n)),
      JSON.stringify(r.draft.notes)
    );
  });

  test('比喻词：全章几次、逐个列', () => {
    assert.ok(
      r.draft.notes.some((n) => /全章合计 4 次（「仿佛」2 次、「犹如」1 次、「宛如」1 次），超过 3 次的上限/.test(n)),
      JSON.stringify(r.draft.notes)
    );
  });

  test('英文缩写', () => {
    assert.ok(r.draft.notes.some((n) => /正文里有英文缩写：PTSD/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('本章细纲自己提到了后面才登场的人：不点名、写完也不算越界', () => {
  let r;
  before(async () => {
    const ws = new bundle.ws.Workspace(project);
    const plot = await project.readPlot(P2);
    await ws.writePlot({ ...plot, sections: { ...plot.sections, 章末钩子: '有人提醒林昭：沈秋已经在找他了' } }, P2);
    r = await write(P2, [{ text: `${filler(900, 260)}。“沈秋已经在找你了。”有人低声说。`, stop: 'end' }]);
    await ws.writePlot(plot, P2);
  });

  test('执行卡后面没有「本章不出场：沈秋」', () => {
    assert.match(r.users[0], /【本章边界】/);
    assert.doesNotMatch(r.users[0], /本章不出场/);
  });

  test('写完不报提前登场', () => {
    assert.ok(!(r.draft.notes ?? []).some((n) => /才登场/.test(n)), JSON.stringify(r.draft.notes));
  });
});
