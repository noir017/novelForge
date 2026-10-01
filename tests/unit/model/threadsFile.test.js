/**
 * 叙事线文件（七期）：解析、外科式追加、状态推导、挑线、校验模型的输出。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 几种手写格式都认、认不出的行不崩 | 第 1 条：作者会手改 |
 * | 状态取章号最大的事件，同章取后写的 | 状态不落盘，每次从事件推出来 |
 * | 追加只动插入的那几行 | 第 3 条：作者写的字一个都不动 |
 * | 计划中、没到区间、细纲没提的线不带 | 带进去等于提示模型提前埋 |
 * | 放不下的跳过、接着试下一条 | 上游 `break`：一条长的挡住后面所有短的 |
 * | 证据归一后逐字找、至少 4 个字 | 上游只去空白，一个「。」也算逐字出现 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/threadsFile.ts');

const FILE = [
  '# 叙事线',
  '',
  '> 说明文字，不是线。',
  '',
  '## 玉佩的来历',
  '- 类型：伏笔',
  '- 计划：第 2–8 章',
  '- 意图：林昭身上的玉佩是沈家旧物，第 8 章前揭开他的身世。',
  '- 事件：',
  '  - 第 3 章 · 埋下：「他摸了摸怀里那块温润的玉佩」——玉佩第一次露面',
  '  - 第 5 章 · 推进：「沈青盯着那道云纹看了很久」——沈青认出了纹样',
  '- 作者自己加的一行',
  '',
  '## 青崖镇的大火',
  '- 类型：悬念',
  '- 计划：第10-20章',
  '- 意图：大火是谁放的。',
  '',
].join('\n');

describe('threadsFile.ts · 解析', () => {
  test('标题、类型、区间、意图、事件', () => {
    const [jade, fire] = t.parseThreads(FILE);
    assert.equal(jade.title, '玉佩的来历');
    assert.equal(jade.kind, '伏笔');
    assert.equal(jade.from, 2);
    assert.equal(jade.to, 8);
    assert.match(jade.intent, /沈家旧物/);
    assert.deepEqual(
      jade.events.map((e) => [e.chapter, e.type, e.evidence, e.reason]),
      [
        [3, '埋下', '他摸了摸怀里那块温润的玉佩', '玉佩第一次露面'],
        [5, '推进', '沈青盯着那道云纹看了很久', '沈青认出了纹样'],
      ]
    );
    assert.equal(fire.from, 10);
    assert.equal(fire.to, 20);
    assert.equal(fire.index, 1);
  });

  test('手写的几种写法：半角冒号、顶格事件、没有引号、单章区间、倒着写的区间', () => {
    const text = [
      '## 断剑',
      '* 类型: 伏笔',
      '- 计划: 第 7 章',
      '- 第 7 章 - 埋下: 断剑出现 —— 顶格写的事件',
      '- 第8章 回收 「剑柄上刻着沈字」',
      '## 婚约',
      '- 计划：12~9',
      '- 第 9 章：两家提起婚约',
    ].join('\r\n');
    const [sword, vow] = t.parseThreads(`﻿${text}`);
    assert.equal(sword.kind, '伏笔');
    assert.equal(sword.from, 7);
    assert.equal(sword.to, 7);
    assert.deepEqual(sword.events.map((e) => e.type), ['埋下', '回收']);
    assert.equal(sword.events[0].evidence, '');
    assert.match(sword.events[0].reason, /断剑出现/);
    assert.equal(sword.events[1].evidence, '剑柄上刻着沈字');
    assert.equal(vow.from, 9);
    assert.equal(vow.to, 12);
    // 没写类型的事件行按「推进」算。
    assert.equal(vow.events[0].type, '推进');
  });

  test('「收到密信」不会被认成回收', () => {
    const [x] = t.parseThreads('## 密信\n- 第 4 章 收到密信');
    assert.equal(x.events[0].type, '推进');
  });

  test('认不出的东西不崩、不当成线', () => {
    assert.deepEqual(t.parseThreads(''), []);
    assert.deepEqual(t.parseThreads('随便写点什么\n- 第 3 章 · 埋下'), []);
    assert.deepEqual(t.parseThreads('##   \n- 类型：伏笔'), []);
    const [x] = t.parseThreads('## 只有名字\n- 计划：不知道\n- 第 0 章 · 埋下：没有这一章');
    assert.equal(x.from, undefined);
    assert.deepEqual(x.events, []);
  });

  test('### 不是新的一条线', () => {
    const list = t.parseThreads('## 甲\n### 备注\n- 类型：伏笔');
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, '伏笔');
  });
});

describe('threadsFile.ts · 状态', () => {
  test('没有事件是计划中；取章号最大的；同章取后写的', () => {
    const [jade, fire] = t.parseThreads(FILE);
    assert.equal(t.threadStatus(fire), '计划中');
    assert.equal(t.threadStatus(jade), '推进中');
    const [x] = t.parseThreads('## 甲\n- 第 6 章 · 回收：x\n- 第 4 章 · 推进：y');
    assert.equal(t.threadStatus(x), '已回收');
    const [y] = t.parseThreads('## 乙\n- 第 6 章 · 回收：x\n- 第 6 章 · 推进：y');
    assert.equal(t.threadStatus(y), '推进中');
    assert.equal(t.isClosed('已回收'), true);
    assert.equal(t.isClosed('已放弃'), true);
    assert.equal(t.isClosed('推进中'), false);
  });

  test('工程页的计数：已过回收章只算没收的', () => {
    const list = t.parseThreads(FILE + '\n## 丙\n- 计划：第 1–2 章\n- 第 2 章 · 回收：「x」');
    assert.deepEqual(t.countThreads(list, 9), { total: 3, open: 2, closed: 1, overdue: 1 });
    assert.deepEqual(t.countThreads(list, 3), { total: 3, open: 2, closed: 1, overdue: 0 });
  });
});

const PLAN = { title: '断剑', kind: '伏笔', from: 4, to: 9, intent: '断剑是沈家的信物。' };

describe('threadsFile.ts · 追加线', () => {
  test('空文件先写文件头', () => {
    const out = t.appendThreads('', [PLAN]);
    assert.ok(out.startsWith('# 叙事线'));
    const [x] = t.parseThreads(out);
    assert.deepEqual([x.title, x.kind, x.from, x.to, x.intent], ['断剑', '伏笔', 4, 9, '断剑是沈家的信物。']);
    assert.match(out, /- 计划：第 4–9 章\n- 意图：断剑是沈家的信物。\n- 事件：\n$/);
  });

  test('已有文件：原文每一行原样在前，新线接在末尾，BOM 与 CRLF 保留', () => {
    const raw = `﻿${FILE.replace(/\n/g, '\r\n')}\r\n\r\n`;
    const out = t.appendThreads(raw, [PLAN]);
    assert.ok(out.startsWith('﻿'));
    assert.ok(out.startsWith(`﻿${FILE.trimEnd().replace(/\n/g, '\r\n')}`));
    assert.ok(!/[^\r]\n/.test(out), '没有混进 LF');
    assert.deepEqual(t.parseThreads(out).map((x) => x.title), ['玉佩的来历', '青崖镇的大火', '断剑']);
    assert.match(out, /作者自己加的一行/);
  });
});

const EV = { chapter: 7, type: '回收', evidence: '那块玉佩原来是沈家的', reason: '身世揭开' };

describe('threadsFile.ts · 追加事件', () => {
  test('插在这条线最后一条事件后面，缩进照那一行；别的行一个不动', () => {
    const out = t.appendEvents(FILE, '玉佩的来历', [EV]);
    const lines = out.split('\n');
    const at = lines.indexOf('  - 第 7 章 · 回收：「那块玉佩原来是沈家的」——身世揭开');
    assert.ok(at > 0, out);
    assert.match(lines[at - 1], /第 5 章/);
    assert.equal(lines[at + 1], '- 作者自己加的一行');
    assert.deepEqual(out.split('\n').filter((l, i) => i !== at), FILE.split('\n'));
    assert.equal(t.threadStatus(t.parseThreads(out)[0]), '已回收');
  });

  test('没有事件行：插在「- 事件：」后面', () => {
    const raw = t.appendThreads('', [PLAN]);
    const out = t.appendEvents(raw, '断剑', [{ ...EV, type: '埋下' }]);
    assert.match(out, /- 事件：\n  - 第 7 章 · 埋下：「那块玉佩原来是沈家的」——身世揭开\n$/);
  });

  test('连「- 事件：」也没有：在这条线末尾补一行，不插到下一条线里去', () => {
    const out = t.appendEvents(FILE, '青崖镇的大火', [{ ...EV, chapter: 11, type: '埋下' }]);
    const [, fire] = t.parseThreads(out);
    assert.equal(fire.events.length, 1);
    assert.match(out, /- 意图：大火是谁放的。\n- 事件：\n  - 第 11 章 · 埋下/);
  });

  test('名字按归一化认；找不到返回 undefined', () => {
    assert.ok(t.appendEvents(FILE, '玉佩 的来历！', [EV]));
    assert.equal(t.appendEvents(FILE, '没有这一条', [EV]), undefined);
  });

  test('CRLF 保留', () => {
    const out = t.appendEvents(FILE.replace(/\n/g, '\r\n'), '玉佩的来历', [EV]);
    assert.ok(!/[^\r]\n/.test(out));
  });
});

describe('threadsFile.ts · 写正文时带哪几条', () => {
  const list = t.parseThreads(
    [
      '## 玉佩的来历', '- 类型：伏笔', '- 计划：第 2–8 章', '- 意图：沈家旧物。', '- 第 3 章 · 埋下：「他摸了摸玉佩」',
      '## 远方的来信', '- 类型：悬念', '- 计划：第 10–12 章', '- 意图：信是谁寄的。',
      '## 青崖镇的大火', '- 类型：悬念', '- 计划：第 1–3 章', '- 意图：大火是谁放的。', '- 第 1 章 · 埋下：「火光冲天」',
      '## 断剑', '- 类型：伏笔', '- 计划：第 4–5 章', '- 意图：断剑是信物。',
      '## 已经收了', '- 计划：第 1–9 章', '- 第 2 章 · 回收：「x」',
      '## 沈青的心事', '- 类型：人物', '- 意图：沈青一直瞒着林昭。',
      '## 旧伤', '- 类型：伏笔', '- 计划：第 1–30 章', '- 意图：左臂的旧伤。', '- 第 2 章 · 埋下：「左臂隐隐作痛」',
    ].join('\n')
  );
  const focus = { no: 5, plotText: '林昭在客栈里收到了远方的来信。', names: ['沈青', '林'] };

  test('候选与顺序：细纲提到的 → 区间内（回收章近的在前）→ 已过回收章 → 人物对上的', () => {
    const got = t.threadCandidates(list, focus).map((c) => [c.thread.title, c.rank]);
    assert.deepEqual(got, [
      ['远方的来信', 0],
      ['断剑', 1],
      ['玉佩的来历', 1],
      ['旧伤', 1],
      ['青崖镇的大火', 2],
      ['沈青的心事', 4],
    ]);
  });

  test('计划中、没到埋下那一章、细纲没提的不带；收了的不带', () => {
    const titles = t.threadCandidates(list, { ...focus, plotText: '' }).map((c) => c.thread.title);
    assert.ok(!titles.includes('远方的来信'));
    assert.ok(!titles.includes('已经收了'));
  });

  test('一个字的名字不拿来匹配', () => {
    const titles = t.threadCandidates(list, { no: 5, plotText: '', names: ['林'] }).map((c) => c.thread.title);
    assert.ok(!titles.includes('沈青的心事'));
  });

  test('最多 6 条、一共 1200 字；放不下的跳过、接着试下一条', () => {
    const { picked, dropped } = t.pickActiveThreads(list, focus, { count: 3 });
    assert.equal(picked.length, 3);
    assert.deepEqual(dropped.map((d) => d.thread.title), ['旧伤', '青崖镇的大火', '沈青的心事']);
    assert.match(dropped[0].note, /只带 3 条/);

    const [first] = t.pickActiveThreads(list, focus).picked;
    const tight = t.pickActiveThreads(list, focus, { chars: first.line.length + 5 });
    assert.equal(tight.picked.length, 1);
    assert.match(tight.dropped[0].note, /只带 \d+ 字/);

    // 长的放不下，后面短的照样能进来。
    const long = t.parseThreads(`## 长线\n- 计划：第 1–9 章\n- 意图：${'很长'.repeat(500)}\n## 短线\n- 计划：第 1–9 章\n- 意图：短。`);
    const r = t.pickActiveThreads(long, { no: 5, plotText: '', names: [] }, { chars: 60 });
    assert.deepEqual(r.picked.map((p) => p.thread.title), ['短线']);
  });

  test('一行：中文状态、区间、不许提前揭开；意图与证据截短', () => {
    const jade = list[0];
    const line = t.renderThreadLine(jade, '已埋下', 5);
    assert.equal(line, '- 玉佩的来历（伏笔 · 已埋下 · 第 2 章埋、第 8 章前收；第 8 章之前不要揭开）意图：沈家旧物。；最近：第 3 章「他摸了摸玉佩」');
    assert.match(t.renderThreadLine(jade, '已埋下', 8), /计划在本章前后回收/);
    assert.match(t.renderThreadLine(jade, '已埋下', 9), /已过计划回收的第 8 章/);
    const [huge] = t.parseThreads(`## 长\n- 意图：${'字'.repeat(300)}\n- 第 2 章 · 推进：「${'句'.repeat(300)}」`);
    assert.ok(t.renderThreadLine(huge, '推进中', 3).length < 140);
  });
});

describe('threadsFile.ts · 校验排出来的线', () => {
  const existing = t.parseThreads('## 玉佩的来历\n- 计划：第 2–8 章');

  test('先校验后截：前面坏的不连累后面好的', () => {
    const bad = Array.from({ length: 8 }, (_, i) => ({ title: `坏${i}`, type: '伏笔', from: 5, to: 2, intent: 'x' }));
    const good = { title: '好的', type: '伏笔', from: 2, to: 5, intent: '意图' };
    const { plans, dropped } = t.verifyThreadPlans([...bad, good], [], 100);
    assert.deepEqual(plans.map((p) => p.title), ['好的']);
    assert.equal(dropped.length, 8);
    assert.match(dropped[0].why, /区间/);
  });

  test('重名（与已有的、与同一批前面的）跳过；越过总章数的丢；字符串数字认', () => {
    const { plans, dropped } = t.verifyThreadPlans(
      [
        { title: '玉佩 的来历', type: '伏笔', from: 1, to: 3, intent: 'x' },
        { title: '断剑', type: '伏笔', from: '4', to: '9', intent: 'y' },
        { title: '断剑', type: '伏笔', from: 4, to: 9, intent: 'z' },
        { title: '远方', type: '悬念', from: 4, to: 120, intent: 'w' },
        { title: '', type: '悬念', from: 1, to: 2, intent: 'w' },
        'not an object',
      ],
      existing,
      100
    );
    assert.deepEqual(plans, [{ title: '断剑', kind: '伏笔', from: 4, to: 9, intent: 'y' }]);
    assert.deepEqual(
      dropped.map((d) => d.why),
      ['同名的线已经有了', '同名的线已经有了', '计划回收的第 120 章超出了全书 100 章', '没有名字', '没有名字']
    );
  });

  test('最多 8 条', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ title: `线${i}`, type: '伏笔', from: 1, to: 2, intent: 'x' }));
    const { plans, dropped } = t.verifyThreadPlans(raw, []);
    assert.equal(plans.length, 8);
    assert.match(dropped[0].why, /最多排 8 条/);
  });
});

describe('threadsFile.ts · 校验定稿时判出来的事件', () => {
  const judged = t.parseThreads(FILE);
  const TEXT = '雨夜。林昭把那块玉佩翻过来，背面刻着一个「沈」字。\n\n他忽然明白，那块玉佩原来是沈家的。';

  test('证据归一后在正文里找得到才收；认不出线、类型、证据太短的丢', () => {
    const { events, dropped } = t.verifyThreadEvents(
      [
        { thread: '玉佩的来历', type: '回收', evidence: '那块玉佩，原来是沈家的', reason: '身世揭开' },
        { thread: '玉佩的来历', type: '推进', evidence: '他在雨里哭了', reason: '编的' },
        { thread: '没有这条', type: '埋下', evidence: '雨夜。林昭把那块玉佩', reason: '' },
        { thread: '青崖镇的大火', type: '起火', evidence: '雨夜。林昭把那块玉佩', reason: '' },
        { thread: '青崖镇的大火', type: '埋下', evidence: '。', reason: '' },
      ],
      judged,
      7,
      TEXT
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].thread.title, '玉佩的来历');
    assert.deepEqual(events[0].event, { chapter: 7, type: '回收', evidence: '那块玉佩，原来是沈家的', reason: '身世揭开' });
    assert.deepEqual(dropped.map((d) => d.why), ['证据在正文里找不到', '认不出是哪一条线', '事件类型认不出', '证据太短，认不出是哪一句']);
  });

  test('同一章、同一句已经记过的不重复记', () => {
    const marked = t.parseThreads(t.appendEvents(FILE, '玉佩的来历', [{ chapter: 7, type: '回收', evidence: '那块玉佩原来是沈家的', reason: '' }]));
    const { events } = t.verifyThreadEvents(
      [{ thread: '玉佩的来历', type: '回收', evidence: '那块玉佩原来是沈家的。', reason: '' }],
      marked,
      7,
      TEXT
    );
    assert.deepEqual(events, []);
  });

  test('定稿时送哪几条：没收的，有关的在前，最多 12 条', () => {
    const names = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰';
    const many = t.parseThreads(Array.from({ length: 15 }, (_, i) => `## 线${names[i]}\n- 计划：第 ${20 + i}–${30 + i} 章`).join('\n'));
    const { judged: j, skipped } = t.threadsToJudge(many, { no: 3, plotText: '线辰在这里', names: [] });
    assert.equal(j.length, 12);
    assert.equal(j[0].title, '线辰');
    assert.equal(skipped.length, 3);
  });
});
