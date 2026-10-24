/**
 * ★ 叙事线重做四期验收（设计稿「实施：逐期提交清单」四期第 4 个提交）。一本已经写了 5 章、都定稿过、一条叙事线都没有的书
 * （拆书导入再补齐整理出来的、0.2.4 以前「立即同步」过的书都是这个样子），经 controller 一路点下来（与工程页那几颗按钮发的
 * 消息一样），假模型按脚本应答：
 *
 *   工程页「⚠ 第 1–5 章还没判」→ 从正文补记（先排线 + 逐章认事件）→ 水位到第 5 章、不再提示 → 写第 6 章、单章定稿 → 水位到第 6 章
 *   另一本：补记到第 3 章没判成 → 水位停在第 2 章、失败挂在第 3 章上、工程页说「第 3–5 章还没判」
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 补记之前：工程页说「⚠ 第 1–5 章还没判」、判到第 0 章；总览上五列都标「还没判」 | 定稿了、叙事线没判的章看得出来 |
 * | 补记：确认框写明章数与次数（排线 + 每章 1–3 次）；线文件里有带证据的实际事件；水位到第 5 章；工程页不再提示落后、总览不再标 | 设计稿「九」；第 4 条 |
 * | 实际调用次数不超过确认框报的上限 | 第 4 条 |
 * | 再写一章、单章定稿：水位推到第 6 章 | 定稿在连续时推水位 |
 * | 中途一章没判成：已判的留着，水位停在它前面，失败挂在那一章上（第 16 条），工程页说剩下的几章还没判 | ⚑ 一章没判成就停 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
const books = [];

const TITLES = ['停舟', '令牌', '夜访', '井', '名册', '渡口'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;
const THREADS = '.novelforge/threads';
const MAIN = `${THREADS}/青崖旧案.md`;
const text = (no) => `# ${TITLES[no - 1]}\n\n林昭在第${no}章摸了摸怀里的玉佩。\n\n沈氏在第${no}章翻开名册，手指停在第${no}行。\n`;

/** 认事件那一次第几章答坏（解析不出）。 */
let broken = new Set();

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线')) {
    return JSON.stringify({
      threads: [
        {
          title: '青崖旧案',
          kind: '主线',
          from: 1,
          to: 30,
          intent: '查清七年前那场火。',
          foreshadowing: [{ title: '玉佩的来历', what: '玉佩是沈家旧物', plant: 1, resolve: 20 }],
        },
      ],
    });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖镇。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [],
    });
  }
  if (system.includes('你是小说定稿事实审查员')) {
    if (broken.has(no)) {
      return '这一章没什么好说的。';
    }
    return JSON.stringify({
      events: [
        { line: '青崖旧案', type: '推进', what: `林昭第 ${no} 章又往前查`, evidence: `林昭在第${no}章摸了摸怀里的玉佩。` },
        ...(no === 1 ? [{ line: '青崖旧案', type: '埋', foreshadowing: '玉佩的来历', what: '玉佩第一次露面', evidence: '林昭在第1章摸了摸怀里的玉佩' }] : []),
      ],
      newThreads: no === 2 ? [{ title: '名册之谜', kind: '支线', intent: '名册上少了一页。', evidence: '沈氏在第2章翻开名册，手指停在第2行。' }] : [],
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
  // 故事时间（同步时单独一次，2026-10-24 重做）：都紧接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（认不出这一步）';
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    threadFile: './src/core/model/threadFile.ts',
    projectView: './src/core/views/projectView.ts',
    threads: './src/core/views/threads.ts',
    errorLog: './src/core/runtime/errorLog.ts',
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
});

after(() => {
  for (const b of books) {
    b.controller.dispose();
    cleanup(b.t.dir, bundle?.db);
  }
});

/** 一本写了第 1–5 章、都定稿过（细纲的 sourceHash 对得上正文）、有情节大纲、一条叙事线都没有的书。 */
async function writtenBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '青崖记' });
  const project = t.project;
  writeOutline(t, outlineOf(20, { text: { 1: '林昭回镇，一路查名册与玉佩。' } }));
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= 5; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(
      PLOT(no),
      `---\nno: ${no}\ntitle: ${TITLES[no - 1]}\nsourceHash: ${hash}\ncast: [林昭, 沈氏]\n---\n\n# ${TITLES[no - 1]}\n\n## 梗概\n第 ${no} 章。\n\n## 出场人物\n林昭、沈氏\n`
    );
  }
  project.invalidate();
  const controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  const book = { t, project, controller };
  books.push(book);
  return book;
}

const treeOf = async (project) => {
  project.invalidate();
  return bundle.projectView.buildProjectTree(project);
};
const actualOf = (t, rel) =>
  bundle.threadFile
    .parseThreadFile(t.read(rel), rel)
    .events.filter((e) => !e.planned)
    .map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence ?? '']);

describe('叙事线重做四期验收：一本已写 5 章、没有任何线的书——补记，再写一章、单章定稿', () => {
  let book;
  let lagBefore;
  let overviewBefore;
  let confirm;
  let backfillCalls;

  before(async () => {
    book = await writtenBook('threads-phase4');
    const tree = await treeOf(book.project);
    lagBefore = { lag: tree.threads.lag, through: tree.threads.through, current: tree.threads.current };
    overviewBefore = await bundle.threads.buildThreadsOverview(book.project);
    broken = new Set();
    fake.reset();
    // 工程页「从正文补记」：后端先弹确认框，作者点「开始补记」。
    h.expect('开始补记');
    await book.controller.handle({ type: 'projectAction', action: 'backfillThreads' });
    confirm = h.confirms.at(-1);
    backfillCalls = fake.callCount();
  });

  test('补记之前：工程页说「第 1–5 章还没判」、叙事线判到第 0 章；总览五列都标「还没判」', () => {
    assert.deepEqual(lagBefore, { lag: { count: 5, text: '第 1–5 章还没判' }, through: 0, current: 5 });
    assert.equal(overviewBefore.through, 0);
    assert.deepEqual(overviewBefore.chapters.slice(0, 5).map((c) => [c.no, c.state, c.unjudged ?? false]), [1, 2, 3, 4, 5].map((no) => [no, 'finalized', true]));
    // 第 6–20 章是大纲排到了、只有梗概的空壳（大纲是各章细纲梗概的汇总）：计划中，不算「还没判」。
    assert.ok(overviewBefore.chapters.slice(5).every((c) => c.state === 'planned' && !c.unjudged), JSON.stringify(overviewBefore.chapters.slice(5)));
  });

  test('确认框写明章数与次数：先排线 1 次 + 5 章 × 1–3 次', () => {
    assert.match(confirm.message, /^从已写正文补记叙事线：第 1–5 章同步过、叙事线还没判/);
    assert.ok(confirm.message.includes('先从情节大纲排一次（1 次）') && confirm.message.includes('预计 6–16 次调用'), confirm.message);
    assert.deepEqual(confirm.actions, ['开始补记']);
  });

  test('线文件里有带证据的实际事件：排出来的主线每章一条推进、第 1 章埋下玉佩；正文里长出来的线也建了', () => {
    assert.deepEqual(actualOf(book.t, MAIN), [
      [1, '推进', '', '林昭在第1章摸了摸怀里的玉佩。'],
      [1, '埋', '玉佩的来历', '林昭在第1章摸了摸怀里的玉佩'],
      [2, '推进', '', '林昭在第2章摸了摸怀里的玉佩。'],
      [3, '推进', '', '林昭在第3章摸了摸怀里的玉佩。'],
      [4, '推进', '', '林昭在第4章摸了摸怀里的玉佩。'],
      [5, '推进', '', '林昭在第5章摸了摸怀里的玉佩。'],
    ]);
    const main = bundle.threadFile.parseThreadFile(book.t.read(MAIN), MAIN);
    assert.equal(main.progressThrough, 5);
    const grown = bundle.threadFile.parseThreadFile(book.t.read(`${THREADS}/名册之谜.md`), `${THREADS}/名册之谜.md`);
    assert.equal(grown.origin, '正文');
    assert.deepEqual(grown.events.map((e) => e.chapter), [2]);
  });

  test('水位到第 5 章；工程页不再提示落后，线按第 5 章算；总览不再标「还没判」', async () => {
    assert.deepEqual(await book.project.readThreadsMark(), { through: 5, judged: [] });
    assert.equal((await book.project.readManifest()).threadsThrough, 5);
    const tree = await treeOf(book.project);
    assert.equal(tree.threads.through, 5);
    assert.equal(tree.threads.lag, undefined);
    assert.equal(tree.threads.lines.find((l) => l.name === '青崖旧案').detail, '主线 · 进行中 · 最近第 5 章 · 1 条伏笔没收');
    const overview = await bundle.threads.buildThreadsOverview(book.project);
    assert.equal(overview.through, 5);
    assert.ok(overview.chapters.every((c) => !c.unjudged), JSON.stringify(overview.chapters));
  });

  test('完成提示说清判了几章、记了多少事件、新认出几条线；跟上了定稿', () => {
    const toast = h.toasts.at(-1);
    assert.ok(toast.includes('叙事线补记：判了 5 章（第 1–5 章），记下 7 个事件，新认出 1 条线'), toast);
    assert.ok(toast.includes('叙事线判到第 5 章，跟上了同步'), toast);
  });

  test('实际调用次数不超过确认框报的上限', () => {
    const plan = bundle.pipelineModel.threadsBackfillCalls(5, true);
    assert.ok(backfillCalls <= plan.max, `${backfillCalls} > ${plan.max}`);
    // 排线 1；第 1 章认事件 + 当前进度；第 2 章认事件 + 归并 + 当前进度；第 3–5 章各认事件 + 当前进度。
    assert.equal(backfillCalls, 1 + 2 + 3 + 3 * 2);
  });

  test('再写一章、单章定稿：水位推到第 6 章，工程页照样不落后', async () => {
    book.t.write(CH(6), text(6));
    book.project.invalidate();
    h.expect();
    await book.controller.handle({ type: 'projectAction', action: 'finalizeChapter', relPath: CH(6) });
    assert.ok(h.toasts.some((x) => x.includes('第 6 章已同步')), h.toasts.join('|'));
    assert.deepEqual(await book.project.readThreadsMark(), { through: 6, judged: [] });
    assert.ok(actualOf(book.t, MAIN).some(([no, type]) => no === 6 && type === '推进'));
    const tree = await treeOf(book.project);
    assert.equal(tree.threads.current, 6);
    assert.equal(tree.threads.through, 6);
    assert.equal(tree.threads.lag, undefined);
  });
});

describe('叙事线重做四期验收：补记到第 3 章没判成——水位停在它前面', () => {
  let book;

  before(async () => {
    book = await writtenBook('threads-phase4-stop');
    broken = new Set([3]);
    fake.reset();
    h.expect('开始补记');
    await book.controller.handle({ type: 'projectAction', action: 'backfillThreads' });
  });

  test('已判的第 1、2 章留着，第 3 章起没记；水位停在第 2 章', async () => {
    assert.deepEqual(
      actualOf(book.t, MAIN).map(([no]) => no),
      [1, 1, 2]
    );
    assert.deepEqual(await book.project.readThreadsMark(), { through: 2, judged: [] });
  });

  test('失败挂在第 3 章上（第 16 条）；工程页说「第 3–5 章还没判」，提示说停在第 3 章', async () => {
    const failures = await bundle.errorLog.listActiveFailures(book.project);
    assert.ok((failures[CH(3)] ?? []).some((f) => f.op === 'threads' && f.severity === 'warn'), JSON.stringify(failures));
    const tree = await treeOf(book.project);
    assert.deepEqual(tree.threads.lag, { count: 3, text: '第 3–5 章还没判' });
    assert.equal(tree.threads.through, 2);
    const toast = h.toasts.at(-1);
    assert.ok(toast.startsWith('error: ') && toast.includes('第 3 章没判成') && toast.includes('叙事线判到第 2 章（同步到第 5 章）'), toast);
  });

  test('第 3 章单章重新定稿判成了：水位一章一章推到第 3 章（第 4、5 章仍待补记）', async () => {
    broken = new Set();
    h.expect();
    await book.controller.handle({ type: 'projectAction', action: 'finalizeChapter', relPath: CH(3) });
    assert.deepEqual(await book.project.readThreadsMark(), { through: 3, judged: [] });
    const tree = await treeOf(book.project);
    assert.deepEqual(tree.threads.lag, { count: 2, text: '第 4–5 章还没判' });
    const failures = await bundle.errorLog.listActiveFailures(book.project);
    assert.equal(failures[CH(3)], undefined);
  });
});
