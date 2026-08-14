/**
 * 「更新角色卡」：分批、增量/全量、失败降级、并发与审阅排队。
 * 迁自 scripts/smoke-characterCard.js（86 条断言）。
 *
 * 这条流程是唯一一处「一次动作要调 N 次模型」的地方，N 由上下文预算算出，
 * 且要在动手前告诉作者。这些都不能靠手测——章节一多就要造几十万字语料。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

function cardJson(overrides) {
  return JSON.stringify({
    aliases: [],
    tags: ['主角'],
    身份: '幸存者',
    外貌: '',
    性格: '沉默寡言',
    语言习惯: '答话极短',
    人物关系: '',
    当前状态: '在客栈',
    未收伏笔: '',
    ...overrides,
  });
}

let bundle;
let projectMod;
let castMod;
let cardMod;
let errorLog;
let h;
let fake;
let t;
let project;

/**
 * 默认并发 1，让绝大多数用例保持串行行为；并发那一节自己把它调大。
 * 窗口刻意开得小（4000），好让几章正文就撑出多批来。
 */
let settings;

const CARD = '.novelforge/characters/林昭.md';

/**
 * 对应原脚本的 `expect()`：清答案队列与各录制器，并把「调了几次」归零。
 * **刻意不动应答队列**——原脚本的 expect() 也不动 `replies`。
 */
function expect(...values) {
  h.expect(...values);
  fake.calls.length = 0;
  h.resetPeaks();
}

/** 对应原脚本的 `replies = [...]`；顺带把模型侧并发峰值归零。 */
function setReplies(items) {
  fake.reset(items);
}

/**
 * 造一段剧情：段文件 + `words` 字的正文 + 一份带 cast 的摘要。
 *
 * 角色卡通读的是 `manuscripts/` 里的正文、出场统计来自按段的摘要——
 * `chapters/` 已经退出流水线，这条链上一个字都不读它。
 */
function makePlot(no, title, cast, words = 400) {
  const pad = '雨下了三天，石板路泡得发白。'.repeat(Math.ceil(words / 14)).slice(0, words);
  const stem = `${String(no).padStart(3, '0')}-${title}`;
  t.write(
    `.novelforge/plots/${stem}.md`,
    `---\nplot: ${no}\ntitle: ${title}\n---\n\n## 目标\n\n略。\n\n## 剧情脉络\n\n甲乙丙。\n`
  );
  t.write(`.novelforge/manuscripts/${stem}.md`, `# 第${no}段 ${title} · 正文\n\n${pad}\n`);
  t.write(
    `.novelforge/summaries/${stem}.md`,
    `---\nplot: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${no}段 ${title} · 摘要\n\n## 梗概\n\n略。\n\n## 出场人物\n\n${cast.join('、')}\n`
  );
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    cast: './src/core/views/cast.ts',
    characterCard: './src/core/features/characterCard.ts',
    registry: './src/core/llm/registry.ts',
    // 失败记录会落进工程库；这里要能读回来断言，收尾还要关掉连接。
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  ({ project: projectMod, cast: castMod, characterCard: cardMod, errorLog } = bundle);

  settings = makeSettings({ contextWindow: 4000 });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  // 真实的 diff 审阅是「弹出去等用户」，这里也要留出重入的机会，
  // 否则串行与否根本测不出来。
  h.setReviewDelay(6);
  bundle.host.initHost(h.host);
  // `replies.length > 1 ? shift() : replies[0]` = repeatLast；`?? cardJson()` = fallback；
  // chatStream 里的 sleep(4) = delayMs（不留延时的话并发与串行跑出来一样）。
  fake = installFakeProvider(bundle.registry, {
    repeatLast: true,
    fallback: cardJson(),
    delayMs: 4,
  });

  t = await makeTempProject(projectMod, { prefix: 'charcard', title: '角色卡测试' });
  project = t.project;

  // 林昭出场 1、2、4、5 章；沈氏只在第 3 章；「客栈掌柜」全程没有角色卡。
  makePlot(1, '楔子', ['林昭', '客栈掌柜']);
  makePlot(2, '入镇', ['林昭']);
  makePlot(3, '夜谈', ['沈氏', '客栈掌柜']);
  makePlot(4, '追兵', ['林昭']);
  makePlot(5, '渡口', ['林昭']);
  t.write(CARD, '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n（待补充）\n');
  project.invalidate();
});

after(() => {
  // **必须先关库再删目录**：Windows 上 SQLite 连接开着时删不掉。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('分批与「预计调用次数」', () => {
  let callCount;
  let ask;
  let confirmMessages;
  let corpus;
  let call0;
  let call1;
  let reviewedCount;
  let card;
  let opened;

  before(async () => {
    expect('开始');
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, CARD, 'full');

    callCount = fake.calls.length;
    ask = h.confirms.find((c) => c.message.includes('预计调用模型'));
    confirmMessages = h.confirms.map((c) => c.message);
    // 只读该角色出场的那 4 章，第 3 章（沈氏）不该进来。
    corpus = fake.calls.map((m) => m[1].content).join('\n');
    call0 = fake.calls[0];
    call1 = fake.calls[1];
    reviewedCount = h.reviewed.length;
    card = t.read(CARD);
    opened = [...h.opened];
  });

  // 4000 的窗口装不下 4 章 400 字的正文，必须分批。
  test('分成了多批', () => {
    assert.ok(callCount > 1, `只调了 ${callCount} 次`);
  });

  test('动手前问过用户', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('确认框写明预计调用次数', () => {
    assert.ok(ask && ask.message.includes(`预计调用模型 ${callCount} 次`), ask && ask.message);
  });

  test('确认框写明要读几章', () => {
    assert.ok(ask && ask.message.includes('通读 4 章'), ask && ask.message);
  });

  test('只装该角色的出场章节', () => {
    assert.ok(!corpus.includes('夜谈'), '第 3 章不该出现');
  });

  test('装进了他出场的章节', () => {
    assert.ok(['楔子', '入镇', '追兵', '渡口'].every((x) => corpus.includes(x)));
  });

  // 后一批要看得到前一批的产出，否则就成了各写各的。
  test('后续批次带上当前档案', () => {
    assert.ok(
      call1[1].content.includes('当前的角色档案') && call1[1].content.includes('沉默寡言'),
      call1[1].content.slice(0, 200)
    );
  });

  test('提示词要求控制篇幅', () => {
    assert.ok(call0[0].content.includes('精炼') && call0[0].content.includes('字以内'));
  });

  test('提示词点名性格与语言习惯优先', () => {
    assert.ok(call0[0].content.includes('「性格」和「语言习惯」'));
  });

  test('走了 diff 审阅', () => {
    assert.equal(reviewedCount, 1, String(reviewedCount));
  });

  test('写回了模型产出', () => {
    assert.ok(card.includes('沉默寡言'), card.slice(0, 200));
  });

  test('回写出场章节', () => {
    assert.ok(card.includes('appearsIn: [1, 2, 4, 5]'), card.split('\n')[5]);
  });

  test('记下读到第几章', () => {
    assert.ok(card.includes('updatedThrough: 5'), card);
  });

  test('保留作者写的别名', () => {
    assert.ok(card.includes('阿昭'));
  });

  test('单卡更新后自动打开该卡', () => {
    assert.ok(opened.includes(CARD), JSON.stringify(opened));
  });
});

describe('增量更新', () => {
  let corpus;
  let callCount;
  let card;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    project.invalidate();
    makePlot(6, '新章', ['林昭']);
    project.invalidate();

    expect('开始');
    setReplies([cardJson({ 当前状态: '已渡河' })]);
    await cardMod.updateCharacterCard(project, CARD, 'incremental');

    corpus = fake.calls.map((m) => m[1].content).join('\n');
    callCount = fake.calls.length;
    card = t.read(CARD);

    // 没有新章节时不该白跑一次模型。
    expect();
    await cardMod.updateCharacterCard(project, CARD, 'incremental');
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  test('增量只读新章节', () => {
    assert.ok(corpus.includes('新章'), corpus.slice(0, 100));
  });

  test('增量不重读旧章节', () => {
    assert.ok(!corpus.includes('楔子') && !corpus.includes('渡口'));
  });

  test('增量只调一次模型', () => {
    assert.equal(callCount, 1, String(callCount));
  });

  test('增量后 updatedThrough 前进', () => {
    assert.ok(card.includes('updatedThrough: 6'), card);
  });

  test('增量后 appearsIn 含新章', () => {
    assert.ok(card.includes('6'), card);
  });

  test('增量写入了新内容', () => {
    assert.ok(card.includes('已渡河'));
  });

  test('没有新章节时不调模型', () => {
    assert.equal(callCountAgain, 0, String(callCountAgain));
  });

  test('没有新章节时明说', () => {
    assert.ok(toastsAgain.some((x) => x.includes('没有新的出场章节')), toastsAgain.join(' | '));
  });
});

describe('解析失败与取消', () => {
  let partialCard;
  let partialLine;
  let partialActive;
  let partialMarks;
  let beforeAllFail;
  let afterAllFail;
  let allFailReviewed;
  let allFailToasts;
  let allFailActive;
  let allFailMarks;
  let successCard;
  let successActive;
  let cancelCallCount;
  let keptCard;
  let afterDiscard;

  before(async () => {
    // 某一批解析失败：其余批的成果照样写回，但 updatedThrough 不能跳过失败的章。
    // 这里让第一批失败、后面成功——若把 updatedThrough 推到最后一章，
    // 第 1、2 章就再也不会被读到了。
    makePlot(7, '第七', ['林昭']);
    makePlot(8, '第八', ['林昭']);
    project.invalidate();
    fs.writeFileSync(
      t.rel(CARD),
      '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nappearsIn: [1, 2, 4, 5, 6]\nupdatedThrough: 0\n---\n\n# 林昭\n\n## 身份\n\n旧的\n',
      'utf8'
    );
    expect('开始');
    setReplies(['模型答非所问，完全不是 JSON', cardJson({ 身份: '新的' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    partialCard = t.read(CARD);
    // 第一批（含第 1、2 章）失败 → 水位线必须停在 0，否则那两章被永久跳过。
    partialLine = partialCard.split('\n').find((l) => l.startsWith('updatedThrough'));

    // 部分失败必须在界面上留痕：卡确实更新了一部分，但还缺一块。
    partialActive = await errorLog.listActiveFailures(project);
    partialMarks = partialActive[CARD] || [];

    // 全部失败：不改卡、不推进 updatedThrough、明确报错。
    beforeAllFail = t.read(CARD);
    expect('开始');
    setReplies(['还是不是 JSON']);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    afterAllFail = t.read(CARD);
    allFailReviewed = h.reviewed.length;
    allFailToasts = [...h.toasts];

    // ★ 这次修的 bug：日志与 toast 都要求用户「恰好在看」，而卡一字未改，
    //   界面上跟更新成功的一模一样。失败必须挂在卡上，一直挂到成功为止。
    allFailActive = await errorLog.listActiveFailures(project);
    allFailMarks = allFailActive[CARD] || [];

    // 修好之后标记必须自己消失——留着比一开始不报错更糟。
    expect('开始');
    setReplies([cardJson({ 身份: '这次成了' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    successCard = t.read(CARD);
    successActive = await errorLog.listActiveFailures(project);

    // 用户在确认框点取消：一次模型都不该调。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    cancelCallCount = fake.calls.length;

    // 审阅时放弃：卡不变。
    keptCard = t.read(CARD);
    h.setReviewVerdict('discard');
    expect('开始');
    setReplies([cardJson({ 身份: '不该写进去' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    afterDiscard = t.read(CARD);
    h.setReviewVerdict('apply');
  });

  test('部分失败仍写回成功的部分', () => {
    assert.ok(partialCard.includes('新的'), partialCard.slice(0, 300));
  });

  test('水位线停在第一个失败章节之前', () => {
    assert.equal(partialLine, 'updatedThrough: 0', partialLine);
  });

  test('部分失败在卡上留下标记', () => {
    assert.ok(partialMarks.length > 0, JSON.stringify(partialActive));
  });

  test('部分失败标记为「部分完成」而非「未改动」', () => {
    assert.equal(partialMarks[0] && partialMarks[0].severity, 'warn', partialMarks[0] && partialMarks[0].severity);
  });

  test('部分失败的说明里给出水位线', () => {
    assert.ok(
      partialMarks[0] && partialMarks[0].message.includes('已读到'),
      partialMarks[0] && partialMarks[0].message
    );
  });

  test('全部失败时角色卡一字不改', () => {
    assert.equal(afterAllFail, beforeAllFail);
  });

  test('全部失败时不弹审阅', () => {
    assert.equal(allFailReviewed, 0, String(allFailReviewed));
  });

  test('全部失败时报错', () => {
    assert.ok(allFailToasts.some((x) => x.startsWith('error:')), allFailToasts.join(' | '));
  });

  test('全部失败在卡上留下标记', () => {
    assert.ok(allFailMarks.length > 0, JSON.stringify(allFailActive));
  });

  test('全部失败标记为「未改动」', () => {
    assert.equal(allFailMarks[0] && allFailMarks[0].severity, 'error', allFailMarks[0] && allFailMarks[0].severity);
  });

  test('标记里说清了是解析失败、卡未改动', () => {
    assert.ok(
      allFailMarks[0] && allFailMarks[0].message.includes('解析失败') && allFailMarks[0].message.includes('未改动'),
      allFailMarks[0] && allFailMarks[0].message
    );
  });

  // 同一张卡 + 同一动作只留最新一条：连着失败两次不该并排挂两个感叹号。
  test('同一动作只保留最新一条', () => {
    assert.equal(allFailMarks.length, 1, String(allFailMarks.length));
  });

  test('成功后角色卡确实更新了', () => {
    assert.ok(successCard.includes('这次成了'));
  });

  test('成功一次后标记自动消失', () => {
    assert.ok(!successActive[CARD], JSON.stringify(successActive));
  });

  test('用户取消则不调模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('审阅放弃则不落盘', () => {
    assert.equal(afterDiscard, keptCard);
  });
});

describe('摘要里没有的角色', () => {
  let callCount;
  let toasts;

  before(async () => {
    t.write('.novelforge/characters/幽灵.md', '---\nname: 幽灵\n---\n\n# 幽灵\n');
    project.invalidate();
    expect('开始');
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, '.novelforge/characters/幽灵.md', 'full');
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  test('没出场的角色不调模型', () => {
    assert.equal(callCount, 0, String(callCount));
  });

  test('没出场的角色明确报错', () => {
    assert.ok(
      toasts.some((x) => x.startsWith('error:') && x.includes('幽灵')),
      toasts.join(' | ')
    );
  });
});

describe('给未建卡的人物建卡', () => {
  let beforeCount;
  let afterCount;
  let created;
  let reviewedCount;
  let calls;
  let index;
  let missingToasts;

  before(async () => {
    project.invalidate();
    const before = await project.listCharacters();
    beforeCount = before.length;
    expect('开始');
    setReplies([cardJson({ 身份: '停舟客栈的掌柜' })]);
    await cardMod.createCardForCast(project, '客栈掌柜');

    const after = await project.listCharacters();
    afterCount = after.length;
    created = after.find((c) => c.name === '客栈掌柜');
    reviewedCount = h.reviewed.length;
    calls = [...fake.calls];

    // 建完之后他就不该再出现在「未建卡」列表里了。
    project.invalidate();
    index = await castMod.buildCastIndex(project);

    // 摘要里已经没有的人不能凭空建卡。
    expect('开始');
    await cardMod.createCardForCast(project, '查无此人');
    missingToasts = [...h.toasts];
  });

  test('确实建出了一张卡', () => {
    assert.equal(afterCount, beforeCount + 1, `${beforeCount} → ${afterCount}`);
  });

  test('新卡带出场章节', () => {
    assert.ok(
      created && created.appearsIn.join(',') === '1,3',
      created && created.appearsIn.join(',')
    );
  });

  test('新卡填上了模型产出', () => {
    assert.ok(created && created.sections.身份.includes('掌柜'), created && created.sections.身份);
  });

  // 刚建出来的空卡没有作者写的内容，不必走 diff。
  test('新建卡不走 diff 审阅', () => {
    assert.equal(reviewedCount, 0, String(reviewedCount));
  });

  test('只读该人物的出场章节', () => {
    assert.ok(calls.every((m) => !m[1].content.includes('入镇')), '第 2 章没有客栈掌柜');
  });

  test('建卡后离开未建卡列表', () => {
    assert.ok(
      !index.unknown.some((m) => m.name === '客栈掌柜'),
      index.unknown.map((m) => m.name).join('、')
    );
  });

  test('建卡后进入已建卡列表', () => {
    assert.ok(index.known.some((m) => m.card && m.card.name === '客栈掌柜'));
  });

  test('摘要里没有的人不建卡', () => {
    assert.ok(missingToasts.some((x) => x.startsWith('error:')), missingToasts.join(' | '));
  });
});

describe('批量更新所有角色卡', () => {
  let ask;
  let confirmMessages;
  let callCount;
  let corpus;
  let reviewedCount;
  let openedCount;
  let linCard;
  let fullCorpus;
  let fullReviewedCount;
  let bothRewritten;
  let fullToasts;
  let cancelCallCount;
  let idleConfirms;
  let idleToasts;

  before(async () => {
    // 上一节的失败用例把林昭的水位线打回了 0；这里重置成「读到第 6 章」，
    // 增量批量才只剩第 7、8 章可读。幽灵没出场、客栈掌柜没有新章。
    fs.writeFileSync(
      t.rel(CARD),
      '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nappearsIn: [1, 2, 4, 5, 6]\nupdatedThrough: 6\n---\n\n# 林昭\n\n## 身份\n\n旧的\n',
      'utf8'
    );
    project.invalidate();

    // ---- 增量：只挑有新出场的卡，动手前报总调用次数。
    project.invalidate();
    expect('逐张确认后开始');
    setReplies([cardJson({ 当前状态: '批量测试中' })]);
    await cardMod.updateAllCharacterCards(project, 'incremental');

    ask = h.confirms.find((c) => c.message.includes('预计调用模型'));
    confirmMessages = h.confirms.map((c) => c.message);
    callCount = fake.calls.length;
    corpus = fake.calls.map((m) => m[1].content).join('\n');
    reviewedCount = h.reviewed.length;
    openedCount = h.opened.length;
    linCard = t.read(CARD);

    // ---- 从头重建：全部有出场的卡全量重读，可整体直接采纳。
    expect('全部直接采纳并开始');
    setReplies([cardJson({ 身份: '重建的身份' })]);
    await cardMod.updateAllCharacterCards(project, 'full');

    fullCorpus = fake.calls.map((m) => m[1].content).join('\n');
    fullReviewedCount = h.reviewed.length;
    bothRewritten =
      t.read(CARD).includes('重建的身份') &&
      t.read('.novelforge/characters/客栈掌柜.md').includes('重建的身份');
    fullToasts = [...h.toasts];

    // ---- 取消：一次模型都不调。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.updateAllCharacterCards(project, 'full');
    cancelCallCount = fake.calls.length;

    // ---- 无可更新：不弹确认框，直接说明。
    expect();
    await cardMod.updateAllCharacterCards(project, 'incremental');
    idleConfirms = h.confirms.map((c) => c.message);
    idleToasts = [...h.toasts];
  });

  test('批量动手前问过用户', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('确认框给出两种采纳方式', () => {
    assert.ok(
      ask && ask.actions.includes('逐张确认后开始') && ask.actions.includes('全部直接采纳并开始'),
      ask && JSON.stringify(ask.actions)
    );
  });

  test('预计调用次数与实际一致', () => {
    assert.ok(ask && ask.message.includes(`预计调用模型 ${callCount} 次`), ask && ask.message);
  });

  test('跳过情况写进明细', () => {
    assert.ok(ask && ask.detail.includes('幽灵') && ask.detail.includes('客栈掌柜'), ask && ask.detail);
  });

  test('增量批量只读新出场的章节', () => {
    assert.ok(corpus.includes('第七') && !corpus.includes('楔子'), corpus.slice(0, 120));
  });

  test('逐张确认模式走了 diff 审阅', () => {
    assert.equal(reviewedCount, 1, String(reviewedCount));
  });

  test('批量不自动打开卡', () => {
    assert.equal(openedCount, 0, JSON.stringify(h.opened));
  });

  test('林昭的卡已更新', () => {
    assert.ok(linCard.includes('批量测试中'));
  });

  test('重建读全部出场章节', () => {
    assert.ok(fullCorpus.includes('楔子') && fullCorpus.includes('夜谈'));
  });

  test('直接采纳模式不走审阅', () => {
    assert.equal(fullReviewedCount, 0, String(fullReviewedCount));
  });

  test('两张卡都已重写', () => {
    assert.ok(bothRewritten);
  });

  test('完成提示报数', () => {
    assert.ok(fullToasts.some((x) => x.includes('已更新 2 张')), fullToasts.join(' | '));
  });

  test('用户取消则不调模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('没有新章节时不弹确认框', () => {
    assert.equal(idleConfirms.length, 0, JSON.stringify(idleConfirms));
  });

  test('没有新章节时明说', () => {
    assert.ok(idleToasts.some((x) => x.includes('没有需要更新的角色卡')), idleToasts.join(' | '));
  });
});

describe('批量更新：并发与审阅排队', () => {
  let callsPeak;
  let reviewPeak;
  let reviewedCount;
  let firstConfirm;
  let linCard;
  let ask;
  let callCount;

  before(async () => {
    settings.concurrency = 3;
    try {
      // 逐张确认 + 并发：分析可以重叠，但 diff 一次只能弹一张——
      // 同时弹三个 diff，用户根本不知道自己在看谁。
      expect('逐张确认后开始');
      setReplies([cardJson({ 当前状态: '并发审阅' })]);
      await cardMod.updateAllCharacterCards(project, 'full');

      callsPeak = fake.peak();
      reviewPeak = h.reviewPeak();
      reviewedCount = h.reviewed.length;
      firstConfirm = h.confirms[0];
      linCard = t.read(CARD);
      // 预计调用次数是承诺，不能因为并发就对不上账。
      ask = h.confirms.find((c) => c.message.includes('预计调用模型'));
      callCount = fake.calls.length;
    } finally {
      settings.concurrency = 1;
    }
  });

  test('并发时确实重叠了模型请求', () => {
    assert.ok(callsPeak > 1, `峰值 ${callsPeak}`);
  });

  test('并发不超过配置值', () => {
    assert.ok(callsPeak <= 3, `峰值 ${callsPeak}`);
  });

  test('diff 审阅仍然一次只弹一张', () => {
    assert.equal(reviewPeak, 1, `峰值 ${reviewPeak}`);
  });

  test('每张卡都审阅到了', () => {
    assert.equal(reviewedCount, 2, String(reviewedCount));
  });

  test('确认框写明并发', () => {
    assert.ok(
      firstConfirm && firstConfirm.detail.includes('并发 2 张'),
      firstConfirm && firstConfirm.detail
    );
  });

  test('逐张确认时说明 diff 会排队', () => {
    assert.ok(
      firstConfirm && firstConfirm.detail.includes('一张一张弹出'),
      firstConfirm && firstConfirm.detail
    );
  });

  test('两张卡都写盘了', () => {
    assert.ok(linCard.includes('并发审阅'));
  });

  test('并发不改变预计调用次数', () => {
    assert.ok(ask && ask.message.includes(`预计调用模型 ${callCount} 次`), ask && ask.message);
  });
});

describe('给未建卡的人全部建卡', () => {
  let ask;
  let confirmMessages;
  let pending;
  let cancelCallCount;
  let noEmptyCard;
  let bothCreated;
  let boatmanCard;
  let reviewedCount;
  let callsPeak;
  let doneToasts;
  let index;
  let idleConfirms;
  let idleToasts;

  before(async () => {
    // 造两个还没有卡的人物，各出场两章。
    makePlot(9, '渡船', ['艄公', '货郎']);
    makePlot(10, '雨歇', ['艄公', '货郎']);
    project.invalidate();

    // ---- 取消：一次模型都不调。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.createCardsForAllCast(project);
    ask = h.confirms.find((c) => c.message.includes('预计调用模型'));
    confirmMessages = h.confirms.map((c) => c.message);
    // 未建卡的人不止这两位（沈氏一直没建卡），所以报数按实际人数对，
    // 而不是钉死一个数字——重要的是「说的人数 = 列出的人数」。
    pending = await castMod.buildCastIndex(project).then((idx) => idx.unknown.length);
    cancelCallCount = fake.calls.length;
    noEmptyCard = !fs.existsSync(t.rel('.novelforge/characters/艄公.md'));

    // ---- 真跑：并发建卡，新卡不走 diff。
    settings.concurrency = 3;
    try {
      expect('开始建卡');
      setReplies([cardJson({ 身份: '批量建出来的' })]);
      await cardMod.createCardsForAllCast(project);

      bothCreated =
        fs.existsSync(t.rel('.novelforge/characters/艄公.md')) &&
        fs.existsSync(t.rel('.novelforge/characters/货郎.md'));
      boatmanCard = t.read('.novelforge/characters/艄公.md');
      reviewedCount = h.reviewed.length;
      callsPeak = fake.peak();
      doneToasts = [...h.toasts];

      project.invalidate();
      index = await castMod.buildCastIndex(project);
    } finally {
      settings.concurrency = 1;
    }

    // ---- 人都建过了：不弹确认框，直接说明。
    expect();
    await cardMod.createCardsForAllCast(project);
    idleConfirms = h.confirms.map((c) => c.message);
    idleToasts = [...h.toasts];
  });

  test('批量建卡动手前问过用户', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('确认框报清人数', () => {
    assert.ok(
      ask && ask.message.includes(`给 ${pending} 位未建卡的人物建卡`),
      ask && ask.message
    );
  });

  test('确认框列出是哪几位', () => {
    assert.ok(ask && ask.detail.includes('艄公') && ask.detail.includes('货郎'), ask && ask.detail);
  });

  test('用户取消则不调模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('取消时不留下空卡', () => {
    assert.ok(noEmptyCard);
  });

  test('两张新卡都建出来了', () => {
    assert.ok(bothCreated);
  });

  test('新卡填上了模型产出', () => {
    assert.ok(boatmanCard.includes('批量建出来的'));
  });

  test('新卡带出场章节', () => {
    assert.ok(boatmanCard.includes('appearsIn: [9, 10]'), boatmanCard.slice(0, 200));
  });

  test('批量建卡不走 diff 审阅', () => {
    assert.equal(reviewedCount, 0, String(reviewedCount));
  });

  test('并发时确实重叠了模型请求', () => {
    assert.ok(callsPeak > 1, `峰值 ${callsPeak}`);
  });

  test('完成提示报数', () => {
    assert.ok(doneToasts.some((x) => x.includes(`已建 ${pending} 张`)), doneToasts.join(' | '));
  });

  test('建完后未建卡列表里没有他们', () => {
    assert.ok(
      !index.unknown.some((m) => m.name === '艄公' || m.name === '货郎'),
      index.unknown.map((m) => m.name).join('、')
    );
  });

  test('没人可建时不弹确认框', () => {
    assert.equal(idleConfirms.length, 0, JSON.stringify(idleConfirms));
  });

  test('没人可建时明说', () => {
    assert.ok(idleToasts.some((x) => x.includes('都已经有角色卡')), idleToasts.join(' | '));
  });
});
