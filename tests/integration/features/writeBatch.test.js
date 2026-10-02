/**
 * 批量写章（四期，D10）：严格串行地一章一章写，续写链与对话页同一份。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 确认框报区间、模式与上限，弹窗确认过的不再问 | 第 4 条；W9 不叠弹窗 |
 * | 已有正文的跳过，第一章没细纲的在它前面收住 | 第 19 条批量那一面；后一章要接着前一章写 |
 * | 写完即定稿：写一章、定稿一章，再写下一章 | D17：自动定稿只在这里 |
 * | 一章写不出来就停，后面的不写 | 失败即停：后面的章接不上 |
 * | 重演、没写够：写进去然后停，挂黄 ❗ | 钱已经花了（D6），但不能踩着有问题的结尾往下写 |
 * | 后面几章才登场的人提前写进来：同上 | 五期补遗 §1.2：下一章要从他第一次露面写起 |
 * | 写完这一章就停 / 停止 | 只在章与章之间停；停止时正在写的那一章不落盘 |
 * | 一章之内续写那几轮不换模型 | 一章写到一半换人，文风断在段落中间 |
 * | 完成提示带「打开第 N 章」 | D24 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let settings;
/** 这一次该答什么。按用例换。 */
let replyFn;
const finished = [];

const pad3 = (n) => String(n).padStart(3, '0');
const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelforge/plots/${pad3(no)}-${TITLES[no - 1]}.md`;

/** 按执行卡里的钩子认是第几章在写（续写那几轮另有契约）。 */
function chapterOf(messages) {
  const user = messages[messages.length - 1].content;
  if (user.includes('请无缝续写当前章节正文')) {
    return { continuation: true };
  }
  const m = /- 章节钩子：第 (\d+) 章结尾/.exec(user);
  return m ? { no: Number(m[1]) } : {};
}

function isSummary(messages) {
  return (messages[0]?.content ?? '').includes('建立可检索的章节档案');
}
function isState(messages) {
  return (messages[0]?.content ?? '').includes('依据本章正文更新角色的「当前状态」');
}
function isReview(messages) {
  return (messages[0]?.content ?? '').includes('严谨的小说审稿编辑');
}

/** 缺省的应答：正文一次写够，摘要与状态各给一份。 */
function defaultReply(messages) {
  if (isSummary(messages)) {
    const no = Number(/第 (\d+) 章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
    return JSON.stringify({
      梗概: `第 ${no} 章的事。`,
      出场人物: [{ name: '林昭', aliases: [] }],
      关键事件: [],
      连续性事实: [],
    });
  }
  if (isState(messages)) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '往北去了' }] });
  }
  const { no, continuation } = chapterOf(messages);
  if (continuation) {
    return { text: filler(400, 900), stop: 'end' };
  }
  return { text: filler(700, no * 100), stop: 'end' };
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    plotFile: './src/core/model/plotFile.ts',
    progress: './src/core/runtime/progress.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    behavior: { 'p/broken': 'fail' },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  bundle.progress.onTaskFinished((t) => finished.push(t));
});

/** 一个排好前 5 章细纲的新工程。`written` 里的章先写好正文，`blank` 里的章只有骨架。 */
async function fresh(prefix, { written = [], blank = [] } = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'broken', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 4,
  };
  const t = await makeTempProject(bundle.project, { prefix, title: '批量写章' });
  t.write('.novelforge/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  const ws = new bundle.ws.Workspace(t.project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      role: '铺垫',
      characters: ['林昭'],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: blank.includes(no)
        ? bundle.plotFile.emptyPlotSections()
        : { 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章林昭查到一点东西。`, 章末钩子: `第 ${no} 章结尾：又一个人不见了。` },
    });
  }
  for (const no of written) {
    t.write(CH(no), `# ${TITLES[no - 1]}\n\n作者自己写的第 ${no} 章。\n`);
  }
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿\n\n## 当前状态\n\n（待补充）\n');
  t.project.invalidate();
  fake.reset();
  h.toasts.length = 0;
  h.confirms.length = 0;
  h.answers.length = 0;
  finished.length = 0;
  replyFn = defaultReply;
  return t;
}

async function failuresOf(t, key) {
  return (await bundle.errorLog.listActiveFailures(t.project))[key] ?? [];
}

describe('只写正文：下一可写章起 3 章', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-draft');
    h.expect('开始写章');
    calls = await bundle.batch.writeManuscripts(t.project);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('确认框报区间、模式与上限（一章最多 8 次）', () => {
    const c = h.confirms[0];
    assert.equal(c.message, '第 1–3 章：要写 3 章正文（只写正文），预计 3 次调用，最多 24 次。现在写？');
    assert.match(c.detail, /一章一章串行写/);
  });

  test('写了 3 章，一章一次，不看并发设置', () => {
    assert.equal(calls, 3);
    assert.deepEqual(fake.calls.map((m) => chapterOf(m).no), [1, 2, 3]);
    for (const no of [1, 2, 3]) {
      assert.ok(t.read(CH(no)).startsWith(`# ${TITLES[no - 1]}\n\n`), CH(no));
    }
    assert.ok(!t.has(CH(4)));
  });

  // 后一章接着前一章写：第 2 章装配的时候，第 1 章已经落盘了。
  test('后一章的装配里有前一章的结尾', () => {
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(user.includes('上一章结尾原文') || user.includes('前文正文'), user.slice(0, 300));
    assert.ok(user.includes(filler(700, 100).slice(-40)));
  });

  test('细纲上记了 writtenFrom；只写正文不定稿', async () => {
    t.project.invalidate();
    assert.ok((await t.project.getPlot(1)).writtenFrom);
    assert.ok(!t.has('.novelforge/summaries/001-停舟.md'));
  });

  test('完成提示带「打开第 3 章」', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.equal(f.message, '第 1–3 章已写好（调用 3 次）。');
    assert.deepEqual(f.open, { plotRelPath: PLOT(3), label: '打开第 3 章' });
  });
});

describe('写完即定稿；已有正文的跳过；弹窗确认过的不再问', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-finalize', { written: [2] });
    calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('不弹确认框', () => {
    assert.equal(h.confirms.length, 0);
  });

  test('写一章、定稿一章（摘要 + 角色状态），再写下一章；第 2 章跳过', () => {
    const order = fake.calls.map((m) => (isSummary(m) ? 'summary' : isState(m) ? 'state' : `write:${chapterOf(m).no}`));
    assert.deepEqual(order, ['write:1', 'summary', 'state', 'write:3', 'summary', 'state']);
    assert.equal(calls, 6);
  });

  test('作者写的第 2 章一个字没动', () => {
    assert.equal(t.read(CH(2)), '# 令牌\n\n作者自己写的第 2 章。\n');
  });

  test('两章都定了稿：摘要在、角色状态更新到第 3 章', () => {
    assert.ok(t.has('.novelforge/summaries/001-停舟.md'));
    assert.ok(t.has('.novelforge/summaries/003-夜访.md'));
    assert.match(t.read('.novelforge/characters/林昭.md'), /stateThrough: 3/);
  });

  test('完成提示说定稿了几章', () => {
    assert.match(finished.find((x) => x.title === '批量写章').message, /定稿 2 章/);
  });
});

describe('第一章没细纲的在它前面收住', () => {
  let t;
  before(async () => {
    t = await fresh('wb-noplot', { blank: [3] });
    h.expect('开始写章');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 5 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('写到第 2 章为止，确认框里说了为什么', () => {
    assert.match(h.confirms[0].message, /^第 1–2 章：要写 2 章正文/);
    assert.match(h.confirms[0].detail, /第 3 章还没有细纲，写到它前面为止/);
    assert.ok(t.has(CH(2)) && !t.has(CH(3)) && !t.has(CH(4)));
  });
});

describe('一章写不出来就停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-fail');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        throw new Error('假装服务商 500');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写好了，第 2、3 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)) && !t.has(CH(3)));
  });

  test('红 ❗ 挂在第 2 章的细纲上', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'error');
    assert.match(f.message, /假装服务商 500/);
  });

  test('提示说清停在哪、后面还有几章', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.equal(f.level, 'error');
    assert.match(f.message, /第 1 章已写好。第 2 章没写成（假装服务商 500），批量停在这里。后面的第 3 章没写。/);
  });
});

describe('重演：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-replay');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const ch1 = t.read(CH(1)).trim();
        return { text: `${ch1.slice(-200)}\n\n${filler(700, 555)}`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章写进去了、没定稿；第 3 章没写', () => {
    assert.ok(t.has(CH(2)));
    assert.ok(!t.has('.novelforge/summaries/002-令牌.md'));
    assert.ok(!t.has(CH(3)));
  });

  test('黄 ❗ 挂在第 2 章上，写明原因', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /开头与上一章结尾大段重合/);
  });

  test('提示的按钮打开的是停下的那一章', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /第 2 章写进去了，但开头与上一章结尾大段重合/);
    assert.deepEqual(f.open, { plotRelPath: PLOT(2), label: '打开第 2 章' });
  });
});

describe('后面几章才登场的人提前写了进来：写进去，然后停（五期补遗 §1.2）', () => {
  let t;
  before(async () => {
    t = await fresh('wb-early');
    // 第 3 章才排沈秋；第 2 章的结尾把他写了出来。
    const ws = new bundle.ws.Workspace(t.project);
    await ws.writePlot({
      no: 3,
      title: TITLES[2],
      role: '铺垫',
      characters: ['林昭', '沈秋'],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: { 本章目的: '第 3 章的目的', 关键事件: '第 3 章林昭遇见沈秋。', 章末钩子: '第 3 章结尾：又一个人不见了。' },
    });
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        return { text: `${filler(700, 556)}\n\n巷口站着一个人，是沈秋。`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章写进去了、没定稿；第 3 章没写', () => {
    assert.ok(t.has(CH(2)));
    assert.ok(!t.has('.novelforge/summaries/002-令牌.md'));
    assert.ok(!t.has(CH(3)));
  });

  test('黄 ❗ 挂在第 2 章上，写明是谁', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /第 3 章才登场的沈秋提前写进了这一章/);
  });

  test('写第 2 章时执行卡后面就点了名', () => {
    const asked = fake.calls.map((c) => c[c.length - 1].content).find((u) => /- 章节钩子：第 2 章结尾/.test(u));
    assert.match(asked, /本章不出场：沈秋（第 3 章才登场）/);
  });
});

describe('续写到最后仍不到八成：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-short');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      return { text: filler(100, chapterOf(messages).continuation ? 7 : 8), stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写了（续写过一轮），第 2 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.equal(fake.callCount(), 2);
  });

  test('黄 ❗：不到目标的八成', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /不到目标的八成/);
  });
});

describe('结尾停在半句上、续写也没接完：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-half');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      // 第一次字数够了、停在半句上；续写那两轮都只多几个字。
      return chapterOf(messages).continuation ? { text: '的骨头', stop: 'end' } : { text: `${filler(700, 9).slice(0, -1)}，全身`, stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写了、没定稿，第 2 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.ok(!t.has('.novelforge/summaries/001-停舟.md'));
  });

  test('黄 ❗：结尾停在半句上', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /结尾停在半句上/);
  });
});

describe('写完这一章就停；停止', () => {
  test('点了「写完这一章就停」：这一章写完、落盘，然后收', async () => {
    const t = await fresh('wb-pause');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 1) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批量写章');
        assert.equal(task.pausable, true);
        assert.ok(bundle.progress.requestStop(task.id));
        assert.equal(bundle.progress.activeTasks().find((x) => x.id === task.id).stopping, true);
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, confirmed: true });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(finished.find((x) => x.title === '批量写章').message, /写完第 1 章停下了。后面的第 2–3 章没写。/);
    cleanup(t.dir, bundle.db);
  });

  test('点了「停止」：正在写的那一章不落盘', async () => {
    const t = await fresh('wb-cancel');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批量写章');
        bundle.progress.cancelTask(task.id);
        throw new bundle.provider.CancelledError();
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, confirmed: true });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.deepEqual(await failuresOf(t, PLOT(2)), []);
    cleanup(t.dir, bundle.db);
  });
});

describe('一章之内续写那几轮不换模型', () => {
  let t;
  let answered = 0;
  before(async () => {
    t = await fresh('wb-pin');
    // 首选坏了：第一次调用换到同档的第二个；之后续写那几轮直接用它，不再先去碰坏的那个。
    settings.models = ['p/broken', 'p/m'];
    settings.fallbackAttempts = 1;
    // 坏的那个在应答之前就抛了：走到这里的每一次都是好的那个在答。
    replyFn = (messages) => {
      answered++;
      const { continuation } = chapterOf(messages);
      return continuation ? { text: filler(400, 3), stop: 'end' } : { text: filler(200, 4), stop: 'maxTokens' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 1 }, confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('坏的那个只碰了一次：续写那几轮直接用第一次成功的那个', () => {
    assert.ok(answered >= 2, `答了 ${answered} 次`);
    assert.equal(fake.callCount(), answered + 1);
    assert.ok(t.has(CH(1)));
  });
});

describe('没有可写的', () => {
  test('都写过了：不问、不调', async () => {
    const t = await fresh('wb-none', { written: [1, 2, 3] });
    assert.equal(await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 } }), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('都已经写过正文了')), h.toasts.join('|'));
    cleanup(t.dir, bundle.db);
  });
});

// ---------------------------------------------------------------- 一致性预检（五期）

/** 第 2 章的细纲改成排着沈秋；沈秋的卡上「当前状态」写着 `state`。 */
function scheduleShenQiu(t, state, through = 0) {
  t.write(
    PLOT(2),
    [
      '---', 'no: 2', `title: ${TITLES[1]}`, 'characters: [林昭, 沈秋]', 'targetWords: 600', '---', '',
      `# 第2章 ${TITLES[1]}`, '', '## 本章目的', '', '第 2 章的目的', '', '## 关键事件', '', '第 2 章林昭查到一点东西。', '',
      '## 章末钩子', '', '第 2 章结尾：又一个人不见了。', '',
    ].join('\n')
  );
  t.write('.novelforge/characters/沈秋.md', `---\nname: 沈秋\nstateThrough: ${through}\n---\n\n# 沈秋\n\n## 当前状态\n\n${state}\n`);
  t.project.invalidate();
}

describe('一致性预检：开跑之前查一遍，有问题先问', () => {
  test('作者说「仅本次忽略」：照写，跑的中途不再为它停', async () => {
    const t = await fresh('wb-preflight-ignore');
    scheduleShenQiu(t, '已死亡');
    h.expect('仅本次忽略，照写');
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, confirmed: true });
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0].message, /^一致性预检：第 1–3 章里有 1 处要留意（这一步没有调用模型）/);
    assert.match(h.confirms[0].detail, /第 2 章：沈秋的当前状态（开篇状态）写着「已死亡」/);
    assert.equal(calls, 3);
    assert.ok(t.has(CH(3)));
    cleanup(t.dir, bundle.db);
  });

  test('作者没答应：一次模型都不调', async () => {
    const t = await fresh('wb-preflight-cancel');
    scheduleShenQiu(t, '已死亡');
    h.expect(undefined);
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, confirmed: true });
    assert.equal(calls, 0);
    assert.equal(fake.calls.length, 0);
    cleanup(t.dir, bundle.db);
  });

  // 前面刚定稿的一章把某人写死了，后面一章还排着他：批量没有人看着，停在那一章前面。
  test('中途新冒出来的：停在那一章前面，挂黄 ❗', async () => {
    const t = await fresh('wb-preflight-midway');
    scheduleShenQiu(t, '（待补充）');
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '第 1 章的事。', 出场人物: [{ name: '林昭', aliases: [] }, { name: '沈秋', aliases: [] }], 关键事件: [], 连续性事实: [] });
      }
      if (isState(messages)) {
        return JSON.stringify({ updates: [{ name: '沈秋', 当前状态: '已死亡，尸体留在渡口' }] });
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', confirmed: true });
    assert.equal(h.confirms.length, 0, '开跑时还没有问题');
    assert.ok(t.has(CH(1)));
    assert.ok(!t.has(CH(2)), '第 2 章没写');
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /第 2 章的一致性预检发现 1 处问题（沈秋在角色卡上已经死了，细纲仍排着），批量停在这里/);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(fails.some((x) => x.severity === 'warn' && /一致性预检/.test(x.message)), JSON.stringify(fails));
    cleanup(t.dir, bundle.db);
  });
});

// 五期补遗 §4：写完即审稿。写 → 审 → 定稿；报告进一个新会话；审出问题、审稿失败都不停。
describe('写完即审稿', () => {
  let t;
  const order = [];
  before(async () => {
    t = await fresh('wb-review');
    replyFn = (messages) => {
      if (isReview(messages)) {
        const user = messages[messages.length - 1].content;
        const no = Number(/- 章节钩子：第 (\d+) 章结尾/.exec(user)?.[1] ?? /第 (\d+) 章林昭查到/.exec(user)?.[1] ?? 0);
        order.push(`审${no}`);
        if (no === 2) {
          return { text: '这不是 JSON', stop: 'end' };
        }
        const quote = /# 待审正文\n\n([\s\S]{20})/.exec(user)?.[1] ?? '';
        return {
          text: JSON.stringify({
            summary: `第 ${no} 章还行`,
            items: [{ category: '剧情合理性', severity: 'error', quote, description: '这一句有问题' }],
            goalReviews: [],
          }),
          stop: 'end',
        };
      }
      if (isSummary(messages)) {
        order.push('定稿');
      } else if (!isState(messages)) {
        order.push('写');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', review: true, confirmed: true });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('三章都写了；每章是写 → 审 → 定稿', () => {
    assert.ok([1, 2, 3].every((no) => t.has(CH(no))));
    assert.deepEqual(order.filter((x) => x !== '审2'), ['写', '审1', '定稿', '写', '定稿', '写', '审3', '定稿']);
  });

  test('第 2 章审稿两次都不合格：不停，后面照写', () => {
    assert.deepEqual(order.filter((x) => x === '审2'), ['审2', '审2']);
    assert.ok(t.has(CH(3)));
  });

  test('报告进了一个新会话：标题、一章一轮、报告卡与报错', () => {
    const dir = t.project.sessionsDir;
    const files = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const s = JSON.parse(require('fs').readFileSync(require('path').join(dir, files[0]), 'utf8'));
    assert.equal(s.title, '批量审稿 · 第 1–3 章');
    assert.deepEqual(s.turns.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(s.turns[0].command, '审稿');
    assert.equal(s.turns[1].review.report.chapterNo, 1);
    assert.equal(s.turns[1].review.report.issues.length, 1);
    assert.match(s.turns[3].error, /^审稿失败：/);
    assert.equal(s.turns[5].review.report.chapterNo, 3);
    assert.equal(s.target.kind, 'manuscript');
  });

  test('完成提示：每章审出什么，按钮打开那个会话', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /审稿：第 1 章 1 严重 · 0 建议；第 2 章审稿失败；第 3 章 1 严重 · 0 建议。报告在会话「批量审稿 · 第 1–3 章」里/);
    assert.equal(f.open.label, '打开审稿报告');
    assert.ok(f.open.sessionId);
  });

  test('没确认过的走确认框：说清写完即审稿与审稿用哪一档', async () => {
    const t2 = await fresh('wb-review-ask');
    h.answers.push(undefined);
    await bundle.batch.writeManuscripts(t2.project, { range: { from: 1, to: 2 }, review: true });
    const c = h.confirms.at(-1);
    assert.match(c.message, /只写正文、写完即审稿/);
    assert.match(c.detail, /每写完一章先审一遍/);
    assert.match(c.detail, /批量审稿/);
    cleanup(t2.dir, bundle.db);
  });
});
