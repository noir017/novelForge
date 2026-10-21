/**
 * 叙事线的计划事件随细纲走（叙事线二期，设计稿「二」与「谁能写什么」）：细纲合同多一个 `threads` 字段，细纲写进去时，
 * 各条线里那一章的计划事件整组换掉（features/threadPlan.ts，经 generation/accept.ts 的单章与批量两条路）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 写进去的是这一章的计划：线的事件落在那条线上，伏笔的事件跟着伏笔走，没见过的伏笔被埋了登记成新伏笔（挂不上进未归属） | 计划记在叙事线里，细纲里不再有关于线的小节 |
 * | 这一章原来的计划整组换掉，别的章、实际事件、作者写的行一个字不动 | 第 3 条；设计稿「随细纲走」 |
 * | 认不出是哪条线的丢掉，写入卡片与完成提示里说出来 | 第 2 条 |
 * | 写入卡片上先列出来（会写哪几条、换掉原来的几条） | 第 19 条的例外：同细纲带出的新角色 |
 * | 合同里没写 threads、作者在审阅里放弃了、批量跳过已有的章：那一章的计划不动 | 只在细纲真的写进去之后才换 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;

const DIR = '.novelforge/threads';
const PAIR = `${DIR}/林昭与沈青.md`;
const MAIN = `${DIR}/青崖旧案.md`;
const UNFILED = `${DIR}/未归属的伏笔.md`;
const PLOT = (no) => `.novelforge/summaries/${String(no).padStart(3, '0')}-第${no}章.md`;

const PAIR_TEXT = [
  '---',
  'kind: 感情线',
  'plan: 2-30',
  '---',
  '',
  '# 林昭与沈青',
  '',
  '## 意图',
  '从互相猜忌到并肩。',
  '',
  '## 伏笔',
  '- 玉佩的来历：沈家旧物（计划第 2 章埋、第 6 章前收）',
  '',
  '## 进展',
  '- 第 2 章 · 埋〈玉佩的来历〉：玉佩露面 〔证据：「他摸了摸怀里的玉佩」〕',
  '- 第 4 章 · 计划 · 推进：旧的计划，要被换掉',
  '- 作者手写的一行备注',
  '- 第 5 章 · 计划 · 推进：第 5 章的计划，不动',
  '',
].join('\n');
const MAIN_TEXT = '---\nkind: 主线\nplan: 1-40\n---\n\n# 青崖旧案\n\n## 意图\n查清那场火。\n\n## 进展\n- 第 1 章 · 推进：起火 〔证据：「火光冲天」〕\n';

/** 一份已经排过的细纲（关键事件有内容）。 */
function plotText(no) {
  return `---\nno: ${no}\ntitle: 第${no}章\ntargetWords: 1200\n---\n\n# 第${no}章 第${no}章\n\n## 梗概\n\n第${no}章的梗概\n\n## 关键事件\n\n- 第${no}章原来的事\n`;
}

/** 细纲合同的单项形式：`threads` 给了才带。 */
function blueprint(no, threads) {
  return {
    chapterNumber: no,
    title: `第${no}章`,
    synopsis: `第 ${no} 章重排的梗概`,
    characters: ['林昭'],
    timePlace: '',
    keyEvents: [`第 ${no} 章重排的事`],
    highlights: [],
    stateChange: '',
    ...(threads ? { threads } : {}),
  };
}

const CH4_THREADS = [
  { line: '林昭与沈青', type: '关系', what: '两人结盟' },
  { line: '', type: '收', foreshadowing: '玉佩的来历', what: '沈青认出云纹' },
  { line: '青崖旧案', type: '推进', what: '查到火起那一夜' },
  { line: '', type: '埋', foreshadowing: '断剑', what: '潭底有一把断剑', resolve: 9 },
  { line: '瞎编的线', type: '推进', what: '认不出' },
];

const PLAN = { stage: 'plot', capability: 'generate' };
const SETTLE = { stage: 'plot', capability: 'settle' };

function reset() {
  t.remove(DIR);
  t.write(PAIR, PAIR_TEXT);
  t.write(MAIN, MAIN_TEXT);
  for (const no of [4, 5, 6]) {
    t.write(PLOT(no), plotText(no));
  }
  t.remove(PLOT(7));
  t.project.invalidate();
  h.setReviewVerdict('apply');
}

/** 单章：照对话页那条路解析、写入。 */
async function acceptOne(no, threads, action = PLAN) {
  const target = { kind: 'plot', plotRelPath: PLOT(no) };
  const artifact = bundle.artifact.parseArtifact(action, JSON.stringify({ blueprints: [blueprint(no, threads)] }), target);
  return { artifact, target, result: await bundle.accept.acceptArtifact(t.project, target, artifact) };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    accept: './src/core/generation/accept.ts',
    artifact: './src/core/features/artifact.ts',
    threadPlan: './src/core/features/threadPlan.ts',
    threadFile: './src/core/model/threadFile.ts',
    workspace: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'threadPlan', title: '计划写进线里' });
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('单章细纲写入：这一章的计划写进各条线', () => {
  let msg;
  before(async () => {
    reset();
    msg = (await acceptOne(4, CH4_THREADS)).result.message;
  });

  test('线的事件落在那条线上，伏笔的事件跟着伏笔走（line 写空也落在它所在的线上）', () => {
    const pair = t.read(PAIR);
    assert.ok(pair.includes('- 第 4 章 · 计划 · 关系：两人结盟'), pair);
    assert.ok(pair.includes('- 第 4 章 · 计划 · 收〈玉佩的来历〉：沈青认出云纹'), pair);
    assert.ok(t.read(MAIN).includes('- 第 4 章 · 计划 · 推进：查到火起那一夜'), t.read(MAIN));
  });

  test('这一章原来的计划整组换掉；别的章的计划、实际事件、作者手写的行一个字不动、位置不变', () => {
    const pair = t.read(PAIR);
    assert.ok(!pair.includes('旧的计划，要被换掉'), pair);
    const lines = pair.split('\n');
    const at = (s) => lines.findIndex((l) => l.includes(s));
    assert.ok(at('第 2 章 · 埋〈玉佩的来历〉') < at('第 4 章 · 计划 · 关系'));
    assert.ok(at('第 4 章 · 计划 · 收〈玉佩的来历〉') < at('作者手写的一行备注'));
    assert.ok(at('作者手写的一行备注') < at('第 5 章 · 计划 · 推进：第 5 章的计划，不动'));
    assert.ok(pair.startsWith(PAIR_TEXT.slice(0, PAIR_TEXT.indexOf('## 进展'))), '进展之前一个字不动');
  });

  test('没见过的伏笔被埋、挂不上线：进「未归属的伏笔」，登记成计划第 4 章埋、第 9 章前收', () => {
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 断剑：潭底有一把断剑（计划第 4 章埋、第 9 章前收）'), loose);
    assert.ok(loose.includes('- 第 4 章 · 计划 · 埋〈断剑〉：潭底有一把断剑'), loose);
    const book = bundle.threadFile.parseUnfiledFile(loose, UNFILED);
    assert.deepEqual(book.foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['断剑', 4, 9]]);
  });

  test('完成提示说写进几条、换掉几条、新伏笔、几条没写进去', () => {
    assert.match(msg, /叙事线记下 4 条计划（换掉原来的 1 条），新伏笔：断剑，1 条计划没写进叙事线（见日志）/);
  });

  test('细纲里没有关于线的小节', () => {
    const plot = t.read(PLOT(4));
    assert.ok(!plot.includes('关系') && !plot.includes('断剑'), plot);
  });
});

describe('写入卡片上先列出来', () => {
  test('单章：写哪几条线、新伏笔进哪、换掉原来的几条；认不出的另起一行', async () => {
    reset();
    const target = { kind: 'plot', plotRelPath: PLOT(4) };
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(4, CH4_THREADS)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.deepEqual(lines, [
      '叙事线计划：林昭与沈青 关系；青崖旧案 推进；收〈玉佩的来历〉；埋〈断剑〉（新伏笔，进「未归属的伏笔」）（原来的 1 条整组换掉）',
      '没写进叙事线的：第 4 章 瞎编的线 推进（认不出是哪一条线）',
    ]);
    assert.ok(!t.has(UNFILED), '列出来不写盘');
  });

  test('一批：一章一行；合同里没写 threads 的产物没有这几行', async () => {
    reset();
    const range = { from: 6, to: 7 };
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const raw = JSON.stringify({
      blueprints: [blueprint(6, [{ line: '青崖旧案', type: '推进', what: '六' }]), blueprint(7, [{ line: '林昭与沈青', type: '收束', what: '两人分开' }])],
    });
    const artifact = bundle.artifact.parseArtifact(PLAN, raw, target, range);
    // 玉佩的来历第 6 章前收，这一批没安排：另起一行说出来（复跑之后的程序检查）。
    assert.deepEqual(await bundle.threadPlan.describeThreadPlan(t.project, target, artifact), [
      '叙事线计划：\n第 6 章：青崖旧案 推进\n第 7 章：林昭与沈青 收束',
      '到期却没安排的伏笔：〈玉佩的来历〉（第 6 章前收）——这一批既没安排、也没写推迟（照写不拦，写前检查还会提醒）',
    ]);
    const bare = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(4)] }), { kind: 'plot', plotRelPath: PLOT(4) });
    assert.deepEqual(await bundle.threadPlan.describeThreadPlan(t.project, { kind: 'plot', plotRelPath: PLOT(4) }, bare), []);
  });
});

describe('重拆、落定、审阅放弃、合同里没写', () => {
  test('重拆一章给空的计划：那一章的计划全删掉，别的章不动；之前登记的伏笔留着（只追加）', async () => {
    reset();
    await acceptOne(4, CH4_THREADS);
    const r = (await acceptOne(4, [])).result;
    assert.match(r.message, /叙事线记下 0 条计划（换掉原来的 4 条）/);
    const pair = t.read(PAIR);
    assert.ok(!/第 4 章 · 计划/.test(pair), pair);
    assert.ok(pair.includes('第 5 章 · 计划 · 推进：第 5 章的计划，不动'), pair);
    assert.ok(!/第 4 章 · 计划/.test(t.read(MAIN)));
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 断剑：潭底有一把断剑') && !loose.includes('第 4 章 · 计划'), loose);
  });

  test('落定细纲（settle）同一份合同，同样写进线里', async () => {
    reset();
    await acceptOne(5, [{ line: '青崖旧案', type: '推进', what: '讨论定下的' }], SETTLE);
    assert.ok(t.read(MAIN).includes('- 第 5 章 · 计划 · 推进：讨论定下的'));
    assert.ok(!t.read(PAIR).includes('第 5 章的计划，不动'), '第 5 章原来那条计划换掉了');
  });

  test('合同里没写 threads（手写的 Markdown、老会话的草稿）：原来的计划不动', async () => {
    reset();
    await acceptOne(4, undefined);
    assert.equal(t.read(PAIR), PAIR_TEXT);
  });

  test('作者在覆盖审阅里放弃了：细纲没写进去，计划也不动', async () => {
    reset();
    h.setReviewVerdict('discard');
    const { result } = await acceptOne(4, CH4_THREADS);
    assert.equal(result.skipped, true);
    assert.equal(t.read(PAIR), PAIR_TEXT);
    assert.ok(!t.has(UNFILED));
    h.setReviewVerdict('apply');
  });

  test('批量只补空白：跳过已有细纲的那一章，它的计划不动；新写的那一章写进去', async () => {
    reset();
    const ws = new bundle.workspace.Workspace(t.project);
    const items = bundle.artifact.parsePlotBatch(
      JSON.stringify({
        blueprints: [blueprint(6, [{ line: '青崖旧案', type: '推进', what: '第 6 章不该写进去' }]), blueprint(7, [{ line: '青崖旧案', type: '推进', what: '第 7 章' }])],
      }),
      { from: 6, to: 7 }
    );
    const r = await bundle.accept.acceptPlotBatch(t.project, ws, items, { from: 6, to: 7 }, { onlyBlank: true });
    assert.match(r.message, /保留原样的第 6 章/);
    assert.match(r.message, /叙事线记下 1 条计划/);
    const main = t.read(MAIN);
    assert.ok(main.includes('- 第 7 章 · 计划 · 推进：第 7 章') && !main.includes('第 6 章不该写进去'), main);
  });
});

// 复跑报告问题 3：拆第 11–15 章只排了「推进」，到期该埋的三条伏笔一条也没排。拆完不调模型地查一遍，到期却没安排的说出来。
describe('拆完查一遍：到期却没安排的伏笔', () => {
  const NAMEBOOK = [
    '---',
    'kind: 主线',
    'plan: 1-40',
    '---',
    '',
    '# 青崖旧案',
    '',
    '## 意图',
    '查清那场火。',
    '',
    '## 伏笔',
    '- 名册：少了一页（计划第 3 章埋、第 9 章前收）',
    '- 旧伤：左臂的疤（计划第 8 章埋）',
    '',
    '## 进展',
    '- 第 1 章 · 推进：起火 〔证据：「火光冲天」〕',
    '',
  ].join('\n');

  test('单章：该埋的（计划埋的章过了还没埋）、该收的（回收章到了）没安排，卡片另起一行、完成提示说一句、日志记下', async () => {
    reset();
    t.write(MAIN, NAMEBOOK);
    t.project.invalidate();
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const threads = [{ line: '青崖旧案', type: '推进', what: '只推进' }];
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(6, threads)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.equal(
      lines[lines.length - 1],
      '到期却没安排的伏笔：〈玉佩的来历〉（第 6 章前收）、〈名册〉（计划第 3 章埋，还没埋）——本章既没安排、也没写推迟（照写不拦，写前检查还会提醒）'
    );
    bundle.logger.clearLogs();
    const { result } = await acceptOne(6, threads);
    assert.match(result.message, /2 条到期的伏笔没安排（见日志）/);
    const logs = bundle.logger.recentLogs();
    assert.ok(logs.some((l) => l.message.includes('到期的伏笔有 2 条没安排') && l.detail.includes('〈名册〉')), JSON.stringify(logs));
  });

  test('安排了的、写明推迟的，不算没安排；旧伤计划第 8 章埋，第 6 章还不到', async () => {
    reset();
    t.write(MAIN, NAMEBOOK);
    t.project.invalidate();
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const threads = [
      { line: '', type: '收', foreshadowing: '玉佩的来历', what: '认出云纹' },
      { line: '青崖旧案', type: '推进', what: '〈名册〉推迟到第 12 章埋，先查别的' },
    ];
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(6, threads)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.ok(!lines.some((l) => l.startsWith('到期却没安排的伏笔')), lines.join('\n'));
  });
});
