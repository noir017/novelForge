/**
 * 叙事线新格式（2026-10-20 重做）：一条线一个文件，解析、状态现算、外科式写入、当前进度的指纹。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 几种手写格式都认、认不出的行不崩、不当伏笔也不当事件 | 第 1 条：作者会手改 |
 * | 文件名就是线名，H1 只在对得上时用 | 设计稿：同名按 normalizeQuote 归一判 |
 * | 种类认不出当支线；事件类型整个词对得上才算 | 「收」与「收束」是两种 |
 * | 状态取章号最大的线事件，伏笔的事件不会把收了的线打开 | 状态不落盘，每次从事件现算 |
 * | asOf 只留之前的事件、写到这一章或更晚的当前进度不用 | 不把后面的剧情透给前面 |
 * | 断了：主线 5 章、其余 15 章；过了计划收束章算逾期 | 设计稿 ⚑9 |
 * | 追加 / 按章换 / 按证据清理只动那几行，BOM、CRLF、作者的行原样 | 第 3 条：作者写的字一个都不动 |
 * | 当前进度：空的、指纹对得上的归机器，改过的归作者 | 照角色卡「当前状态」（第 19 条的例外） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/threadFile.ts');

const REL = '.novelforge/threads/林昭与沈青.md';

const FILE = [
  '---',
  'kind: 感情线',
  'origin: 计划',
  'plan: 3-40',
  'progressThrough: 12',
  'progressHash: abc',
  'generatedBy: novel-forge',
  '---',
  '',
  '# 林昭与沈青',
  '',
  '## 意图',
  '从互相猜忌到并肩，第 40 章前确定心意。',
  '',
  '## 当前进度',
  '第 12 章两人在青崖镇结盟，沈青仍瞒着自己是沈家遗孤。',
  '',
  '## 伏笔',
  '- 玉佩的来历：林昭的玉佩是沈家旧物（计划第 3 章埋、第 18 章前收）',
  '- 沈青的旧伤（计划第 5 章埋）',
  '- （待补充）',
  '> 说明文字，不是伏笔。',
  '',
  '## 进展',
  '- 第 3 章 · 计划 · 推进：两人初遇，互相试探',
  '- 第 3 章 · 计划 · 埋〈玉佩的来历〉：打斗中玉佩露出来',
  '- 第 3 章 · 推进：两人在镇口初遇，沈青出手试探 〔证据：「她的剑停在他喉前三寸」〕',
  '- 第 3 章 · 埋〈玉佩的来历〉：玉佩第一次露面 〔证据：「他摸了摸怀里那块温润的玉佩」〕',
  '- 第 12 章 · 关系：林昭—沈青，猜忌 → 结盟 〔证据：「从今往后，你的仇就是我的仇」〕',
  '- 作者自己加的一行备注',
  '',
  '### 作者的小标题',
  '- 第 13 章：作者手写的一笔，没有类型也没有证据',
  '',
  '## 作者自加的一节',
  '- 第 99 章 · 收束：这一节不是进展，不认',
  '',
].join('\n');

describe('threadFile.ts · 解析', () => {
  const th = t.parseThreadFile(FILE, REL, 2);

  test('frontmatter：种类、来源、计划区间、当前进度写到第几章与指纹', () => {
    assert.equal(th.name, '林昭与沈青');
    assert.equal(th.relPath, REL);
    assert.equal(th.kind, '感情线');
    assert.equal(th.origin, '计划');
    assert.equal(th.from, 3);
    assert.equal(th.to, 40);
    assert.equal(th.progressThrough, 12);
    assert.equal(th.progressHash, 'abc');
    assert.equal(th.index, 2);
  });

  test('意图与当前进度是整节文字', () => {
    assert.equal(th.intent, '从互相猜忌到并肩，第 40 章前确定心意。');
    assert.match(th.progress, /^第 12 章两人在青崖镇结盟/);
  });

  test('伏笔：括号里的埋与收认成章号；占位文字、引用行不算', () => {
    assert.deepEqual(th.foreshadowing, [
      { name: '玉佩的来历', what: '林昭的玉佩是沈家旧物', plant: 3, resolve: 18 },
      { name: '沈青的旧伤', what: '', plant: 5 },
    ]);
  });

  test('进展：计划与实际、伏笔名、证据都认；没写类型的当推进；别的节里的不认', () => {
    assert.equal(th.events.length, 6);
    assert.deepEqual(th.events[0], { chapter: 3, planned: true, type: '推进', what: '两人初遇，互相试探' });
    assert.deepEqual(th.events[1], {
      chapter: 3,
      planned: true,
      type: '埋',
      foreshadowing: '玉佩的来历',
      what: '打斗中玉佩露出来',
    });
    assert.deepEqual(th.events[3], {
      chapter: 3,
      planned: false,
      type: '埋',
      foreshadowing: '玉佩的来历',
      what: '玉佩第一次露面',
      evidence: '他摸了摸怀里那块温润的玉佩',
    });
    assert.equal(th.events[4].type, '关系');
    assert.equal(th.events[4].what, '林昭—沈青，猜忌 → 结盟');
    assert.deepEqual(th.events[5], { chapter: 13, planned: false, type: '推进', what: '作者手写的一笔，没有类型也没有证据' });
  });

  test('没有 frontmatter、种类认不出：当支线、来源当计划；名字取文件名', () => {
    const x = t.parseThreadFile('# 别的名字\n\n## 意图\n随便写写\n', '.novelforge/threads/沈家旧案.md');
    assert.equal(x.name, '沈家旧案');
    assert.equal(x.kind, '支线');
    assert.equal(x.origin, '计划');
    assert.equal(x.from, undefined);
    assert.equal(x.intent, '随便写写');
    const y = t.parseThreadFile('---\nkind: 奇怪的线\norigin: 正文\n---\n', '.novelforge/threads/a.md');
    assert.equal(y.kind, '支线');
    assert.equal(y.origin, '正文');
  });

  test('H1 只在和文件名对得上时当名字（机器建文件时名字里的冒号被清洗掉了）', () => {
    const x = t.parseThreadFile('# 林昭: 复仇\n', '.novelforge/threads/林昭-复仇.md');
    assert.equal(x.name, '林昭: 复仇');
    assert.equal(t.threadFileName('林昭: 复仇'), '林昭-复仇.md');
  });

  test('BOM、CRLF、空串、乱写都不崩', () => {
    const crlf = `﻿${FILE.replace(/\n/g, '\r\n')}`;
    const x = t.parseThreadFile(crlf, REL);
    assert.equal(x.events.length, 6);
    assert.equal(x.foreshadowing.length, 2);
    assert.doesNotThrow(() => t.parseThreadFile('', REL));
    assert.doesNotThrow(() => t.parseThreadFile('---\n---\n## 进展\n- 第 x 章\n- 第 0 章 · 推进：零\n##\n', REL));
    assert.equal(t.parseThreadFile('## 进展\n- 第 0 章 · 推进：零\n', REL).events.length, 0);
  });

  test('未归属的伏笔：同样的伏笔、进展两节', () => {
    const u = t.parseUnfiledFile(
      `${t.UNFILED_TEMPLATE}`.replace('## 进展\n', '## 进展\n\n- 第 2 章 · 埋〈断剑〉：断剑落潭 〔证据：「剑落进了深潭」〕\n'),
      '.novelforge/threads/未归属的伏笔.md'
    );
    assert.equal(u.name, '未归属的伏笔');
    assert.equal(u.events.length, 1);
    assert.equal(t.isUnfiledName(' 未归属的伏笔 '), true);
    assert.equal(t.isUnfiledName('林昭与沈青'), false);
  });
});

describe('threadFile.ts · 认名字、种类与事件类型', () => {
  test('种类四种与几种别名，认不出是 undefined', () => {
    assert.equal(t.threadKindOf('主线'), '主线');
    assert.equal(t.threadKindOf(' 感情 线'), '感情线');
    assert.equal(t.threadKindOf('副线'), '支线');
    assert.equal(t.threadKindOf('成长线'), '人物线');
    assert.equal(t.threadKindOf('伏笔'), undefined);
  });

  test('事件类型整个词对得上才算：收与收束是两种', () => {
    assert.equal(t.eventTypeOf('收'), '收');
    assert.equal(t.eventTypeOf('收束'), '收束');
    assert.equal(t.eventTypeOf('回收'), '收');
    assert.equal(t.eventTypeOf('埋下'), '埋');
    assert.equal(t.eventTypeOf('收到密信'), undefined);
    assert.equal(t.parseEventLine('第 3 章 收到密信').type, '推进');
    assert.equal(t.parseEventLine('第 3 章 收到密信').what, '收到密信');
  });

  test('「计划」后面接的不是类型：不是计划事件', () => {
    const e = t.parseEventLine('第 3 章 计划有变，两人改道');
    assert.equal(e.planned, false);
    assert.equal(e.what, '计划有变，两人改道');
  });

  test('分隔符、括号写法宽松认', () => {
    const e = t.parseEventLine('第3章-计划-收<玉佩>: 揭开身世');
    assert.deepEqual(e, { chapter: 3, planned: true, type: '收', foreshadowing: '玉佩', what: '揭开身世' });
    const f = t.parseEventLine('第 5 章 · 推进：沈青受伤 [证据：“血从指缝里渗出来”]');
    assert.equal(f.evidence, '血从指缝里渗出来');
    assert.equal(f.what, '沈青受伤');
  });

  test('计划区间：几种写法与写回', () => {
    assert.deepEqual(t.parsePlan('3-40'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('第3–40章'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('40-3'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('3-'), { from: 3 });
    assert.deepEqual(t.parsePlan('-40'), { to: 40 });
    assert.deepEqual(t.parsePlan('待定'), {});
    assert.equal(t.planText(3, 40), '3-40');
    assert.equal(t.planText(3), '3-');
    assert.deepEqual(t.parsePlan(t.planText(undefined, 40)), { to: 40 });
    assert.equal(t.planText(), undefined);
  });
});

/** 只给状态函数用的最小一条线。 */
function line(events, extra = {}) {
  return { name: '线', relPath: REL, kind: '支线', origin: '计划', intent: '', progress: '', foreshadowing: [], events, index: 0, ...extra };
}
const ev = (chapter, type, extra = {}) => ({ chapter, planned: false, type, what: '', ...extra });

describe('threadFile.ts · 状态现算', () => {
  test('没有实际事件是计划中（计划事件不算）', () => {
    assert.equal(t.threadStatus(line([{ ...ev(3, '推进'), planned: true }])), '计划中');
  });

  test('章号最大的线事件定状态，同章取写在后面的', () => {
    assert.equal(t.threadStatus(line([ev(3, '推进'), ev(9, '收束'), ev(5, '关系')])), '已收束');
    assert.equal(t.threadStatus(line([ev(9, '收束'), ev(9, '推进')])), '进行中');
    assert.equal(t.threadStatus(line([ev(4, '放弃')])), '已放弃');
  });

  test('伏笔的事件不会把收了的线重新打开，但说明这条线动过', () => {
    const x = line([ev(3, '推进'), ev(9, '收束'), ev(12, '收', { foreshadowing: '玉佩' })]);
    assert.equal(t.threadStatus(x), '已收束');
    assert.equal(t.lastActiveChapter(x), 12);
    assert.equal(t.threadStatus(line([ev(2, '埋', { foreshadowing: '玉佩' })])), '进行中');
  });

  test('asOf：只留之前的事件；当前进度写到这一章或更晚就不用', () => {
    const x = line([ev(3, '推进'), ev(8, '推进')], { progress: '结盟了', progressThrough: 8 });
    const at8 = t.asOf(x, 8);
    assert.deepEqual(at8.events.map((e) => e.chapter), [3]);
    assert.equal(at8.progress, '');
    const at9 = t.asOf(x, 9);
    assert.equal(at9, x, '没有要去掉的就原样返回');
  });

  test('断了：主线 5 章、其余 15 章；不是进行中不算', () => {
    const main = line([ev(10, '推进')], { kind: '主线' });
    assert.deepEqual(t.threadStateAt(main, 14), { status: '进行中', lastActive: 10, gap: 4, stalled: false, overdue: false });
    assert.equal(t.threadStateAt(main, 15).stalled, true);
    assert.equal(t.threadStateAt(line([ev(10, '推进')]), 24).stalled, false);
    assert.equal(t.threadStateAt(line([ev(10, '推进')]), 25).stalled, true);
    assert.equal(t.threadStateAt(line([ev(10, '收束')]), 99).gap, undefined);
  });

  test('过了计划收束章还没收是逾期；收了的不算', () => {
    assert.equal(t.threadStateAt(line([], { to: 20 }), 21).overdue, true);
    assert.equal(t.threadStateAt(line([], { to: 20 }), 20).overdue, false);
    assert.equal(t.threadStateAt(line([ev(19, '收束')], { to: 20 }), 30).overdue, false);
  });

  test('伏笔：登记了的在前、只在事件里出现的跟在后面；状态、埋在第几章、逾期', () => {
    const x = line(
      [ev(3, '埋', { foreshadowing: '玉佩' }), ev(9, '收', { foreshadowing: '玉 佩' }), ev(4, '埋', { foreshadowing: '断剑' })],
      { foreshadowing: [{ name: '玉佩', what: '沈家旧物', plant: 3, resolve: 18 }, { name: '旧伤', what: '', resolve: 6 }] }
    );
    const list = t.foreshadowingOf(x, 10);
    assert.deepEqual(
      list.map((f) => [f.name, f.status, f.plantedAt, f.closedAt, f.overdue]),
      [
        ['玉佩', '已收', 3, 9, false],
        ['旧伤', '计划', undefined, undefined, true],
        ['断剑', '已埋', 4, undefined, false],
      ]
    );
  });
});

describe('threadFile.ts · 渲染与新建', () => {
  test('事件一行与伏笔一行的写法', () => {
    assert.equal(
      t.renderEventLine({ chapter: 3, planned: true, type: '埋', foreshadowing: '玉佩', what: '露出来' }),
      '第 3 章 · 计划 · 埋〈玉佩〉：露出来'
    );
    assert.equal(
      t.renderEventLine({ chapter: 12, planned: false, type: '关系', what: '结盟', evidence: '你的仇就是我的仇' }),
      '第 12 章 · 关系：结盟 〔证据：「你的仇就是我的仇」〕'
    );
    assert.equal(t.renderForeshadowLine({ name: '玉佩', what: '旧物', plant: 3, resolve: 18 }), '玉佩：旧物（计划第 3 章埋、第 18 章前收）');
    assert.equal(t.renderForeshadowLine({ name: '旧伤', what: '', resolve: 6 }), '旧伤（第 6 章前收）');
  });

  test('新建一条线：读回来与写进去的一样', () => {
    const raw = t.renderThreadFile({
      name: '沈家旧案',
      kind: '支线',
      origin: '正文',
      from: 5,
      intent: '十年前那把火是谁放的。',
      foreshadowing: [{ name: '火折子', what: '现场留下的火折子', plant: 5, resolve: 20 }],
      events: [{ chapter: 5, planned: false, type: '推进', what: '旧案被提起', evidence: '十年前那场大火' }],
    });
    const x = t.parseThreadFile(raw, '.novelforge/threads/沈家旧案.md');
    assert.equal(x.kind, '支线');
    assert.equal(x.origin, '正文');
    assert.equal(x.from, 5);
    assert.equal(x.to, undefined);
    assert.equal(x.intent, '十年前那把火是谁放的。');
    assert.equal(x.progress, '');
    assert.deepEqual(x.foreshadowing, [{ name: '火折子', what: '现场留下的火折子', plant: 5, resolve: 20 }]);
    assert.equal(x.events.length, 1);
    assert.equal(x.events[0].evidence, '十年前那场大火');
    assert.match(raw, /generatedBy: novel-forge/);
    assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'));
  });
});

describe('threadFile.ts · 外科式写入', () => {
  test('追加伏笔：插在「伏笔」最后一行后面，同名（含事件里出现过的）跳过，其余字节不动', () => {
    const { text, added } = t.appendForeshadowing(FILE, [
      { name: '玉 佩的来历', what: '换个说法' },
      { name: '断剑', what: '剑里藏着字', resolve: 30 },
    ]);
    assert.deepEqual(added.map((f) => f.name), ['断剑']);
    const lines = text.split('\n');
    const at = lines.indexOf('- 断剑：剑里藏着字（第 30 章前收）');
    assert.ok(at > 0);
    assert.equal(lines[at - 1], '> 说明文字，不是伏笔。');
    assert.equal(text.replace('- 断剑：剑里藏着字（第 30 章前收）\n', ''), FILE);
  });

  test('追加伏笔：没有「伏笔」一节就在「进展」前面建；一条都没加原样返回', () => {
    const raw = '# 线\n\n## 意图\n意图\n\n## 进展\n- 第 1 章 · 推进：开头\n';
    const { text } = t.appendForeshadowing(raw, [{ name: '玉佩', what: '' }]);
    assert.equal(text, '# 线\n\n## 意图\n意图\n\n## 伏笔\n\n- 玉佩\n\n## 进展\n- 第 1 章 · 推进：开头\n');
    assert.equal(t.appendForeshadowing(raw, []).text, raw);
  });

  test('追加伏笔：空串（「未归属的伏笔」还不存在）也写得出能读回来的', () => {
    const { text } = t.appendForeshadowing(t.UNFILED_TEMPLATE, [{ name: '断剑', what: '落潭' }]);
    assert.deepEqual(t.parseUnfiledFile(text, 'x').foreshadowing, [{ name: '断剑', what: '落潭' }]);
    assert.match(text, /## 伏笔\n\n- 断剑：落潭\n\n## 进展/);
  });

  test('追加实际事件：按章号插（同章计划在前）、同一条不重复记、CRLF 与 BOM 原样', () => {
    const crlf = `﻿${FILE.replace(/\n/g, '\r\n')}`;
    const fresh = { chapter: 5, planned: false, type: '推进', what: '沈青受伤', evidence: '血从指缝里渗出来' };
    const again = { chapter: 3, planned: false, type: '推进', what: '换个说法', evidence: '她的剑停在他喉前三寸。' };
    const { text, added } = t.appendEvents(crlf, [fresh, again]);
    assert.deepEqual(added, [fresh]);
    assert.ok(text.startsWith('﻿---\r\n'));
    assert.ok(!/[^\r]\n/.test(text), '换行符都还是 CRLF');
    const lines = text.slice(1).split('\r\n');
    const at = lines.indexOf('- 第 5 章 · 推进：沈青受伤 〔证据：「血从指缝里渗出来」〕');
    assert.match(lines[at + 1], /^- 第 12 章 · 关系/);
    assert.equal(text.replace('- 第 5 章 · 推进：沈青受伤 〔证据：「血从指缝里渗出来」〕\r\n', ''), crlf);
  });

  test('追加实际事件：比已有的都晚就接在「进展」最后一行有字的后面；没有「进展」就在末尾建', () => {
    const early = t.appendEvents(FILE, [{ chapter: 1, planned: false, type: '推进', what: '更早' }]).text;
    assert.equal(early, FILE.replace('## 进展\n', '## 进展\n- 第 1 章 · 推进：更早\n'), '插在第一条前面，不多出空行');
    const raw = '# 线\n\n## 进展\n\n- 第 1 章 · 推进：开头\n\n## 作者的节\n随笔\n';
    const { text } = t.appendEvents(raw, [{ chapter: 2, planned: false, type: '推进', what: '下一步' }]);
    assert.equal(text, '# 线\n\n## 进展\n\n- 第 1 章 · 推进：开头\n- 第 2 章 · 推进：下一步\n\n## 作者的节\n随笔\n');
    const bare = t.appendEvents('# 线\n', [{ chapter: 2, planned: false, type: '推进', what: '下一步' }]).text;
    assert.equal(bare, '# 线\n\n## 进展\n\n- 第 2 章 · 推进：下一步\n');
  });

  test('按章换计划事件：只换这一章的计划事件，插回原来的位置；实际事件与别的章不动', () => {
    const { text, removed } = t.replacePlannedEvents(FILE, 3, [{ type: '推进', what: '改了：两人在雨里初遇' }]);
    assert.equal(removed, 2);
    const x = t.parseThreadFile(text, REL);
    assert.deepEqual(
      x.events.filter((e) => e.planned).map((e) => e.what),
      ['改了：两人在雨里初遇']
    );
    assert.equal(x.events.filter((e) => !e.planned).length, 4);
    const lines = text.split('\n');
    assert.equal(lines[lines.indexOf('## 进展') + 1], '- 第 3 章 · 计划 · 推进：改了：两人在雨里初遇');
  });

  test('按章换计划事件：原来没有的按章号插（排在同章实际事件前面）；给空的就是只删', () => {
    const { text } = t.replacePlannedEvents(FILE, 12, [{ type: '关系', what: '结盟' }]);
    const lines = text.split('\n');
    const at = lines.indexOf('- 第 12 章 · 计划 · 关系：结盟');
    assert.match(lines[at + 1], /^- 第 12 章 · 关系：林昭—沈青/);
    const cleared = t.replacePlannedEvents(FILE, 3, []);
    assert.equal(cleared.removed, 2);
    assert.equal(t.parseThreadFile(cleared.text, REL).events.filter((e) => e.planned).length, 0);
    assert.equal(t.replacePlannedEvents(FILE, 7, []).text, FILE);
  });

  test('按证据清理：只删这一章、证据已经不在正文里的实际事件；没证据的（作者手写）与计划事件不动', () => {
    const chapter3 = '她的剑停在他喉前三寸。两人对视良久。';
    const { text, removed } = t.pruneChapterEvents(FILE, 3, chapter3);
    assert.deepEqual(removed.map((e) => e.type), ['埋']);
    assert.equal(text, FILE.replace('- 第 3 章 · 埋〈玉佩的来历〉：玉佩第一次露面 〔证据：「他摸了摸怀里那块温润的玉佩」〕\n', ''));
    assert.equal(t.pruneChapterEvents(FILE, 13, '').text, FILE, '第 13 章那一笔没有证据，是作者的');
  });
});

describe('threadFile.ts · 当前进度', () => {
  test('空的、指纹对得上的归机器；改过的、没记过指纹却有内容的归作者', () => {
    assert.equal(t.progressOwnedByMachine({ progress: '' }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '（待补充）' }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '结盟', progressHash: t.progressHashOf('结盟\n') }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '结盟了', progressHash: t.progressHashOf('结盟') }), false);
    assert.equal(t.progressOwnedByMachine({ progress: '作者写的' }), false);
  });

  test('换写当前进度：只换这一节与两个 frontmatter 字段，读回来指纹对得上', () => {
    const next = t.patchProgress(FILE, '第 15 章两人反目。', 15);
    const x = t.parseThreadFile(next, REL);
    assert.equal(x.progress, '第 15 章两人反目。');
    assert.equal(x.progressThrough, 15);
    assert.equal(t.progressOwnedByMachine(x), true);
    assert.equal(x.events.length, 6);
    assert.equal(
      next.replace(/progressThrough: 15\nprogressHash: \w+\n/, 'progressThrough: 12\nprogressHash: abc\n').replace('第 15 章两人反目。', '第 12 章两人在青崖镇结盟，沈青仍瞒着自己是沈家遗孤。'),
      FILE.replace('## 当前进度\n第 12', '## 当前进度\n\n第 12')
    );
  });

  test('手写的线没有 frontmatter：补一段只有那两个字段的', () => {
    const next = t.patchProgress('# 线\n\n## 意图\n写写\n', '刚开头', 1);
    assert.match(next, /^---\nprogressThrough: 1\nprogressHash: \w+\n---\n\n# 线/);
    assert.equal(t.parseThreadFile(next, 'x/线.md').progress, '刚开头');
  });
});

describe('threadFile.ts · 排线：校验模型的输出', () => {
  const existing = { threads: [{ name: '青云旧案', kind: '主线' }], foreshadowing: ['火折子'] };

  test('先逐条校验再截：名字、种类、意图、区间、重名、主线只能一条', () => {
    const { plans, dropped } = t.verifyThreadPlans(
      [
        { title: '青云 旧案', kind: '主线', intent: '重名' },
        { title: '宗门大比', kind: '主线', intent: '主线已有' },
        { title: '断剑之谜', kind: '悬念', intent: '种类不对' },
        { title: '执法堂', kind: '支线', from: 2, to: 30, intent: '越界' },
        { title: '倒过来', kind: '支线', from: 9, to: 3, intent: '区间反了' },
        { title: '', kind: '支线', intent: '没名字' },
        { title: '未归属的伏笔', kind: '支线', intent: '保留名' },
        { title: '没有意图', kind: '支线' },
        { title: '林昭与沈青', type: '感情线', from: '3', to: 18, intent: '从猜忌到并肩。' },
        { title: '林昭的成长', kind: '人物线', intent: '从复仇到放下。' },
      ],
      existing,
      20
    );
    assert.deepEqual(plans.map((p) => [p.name, p.kind, p.origin, p.from, p.to]), [
      ['林昭与沈青', '感情线', '计划', 3, 18],
      ['林昭的成长', '人物线', '计划', undefined, undefined],
    ]);
    assert.deepEqual(dropped.map((d) => d.why), [
      t.SAME_THREAD,
      '主线全书只能有一条，已经有了',
      '种类不是主线 / 支线 / 感情线 / 人物线之一',
      '计划区间不对（全书 20 章）',
      '计划区间不对（全书 20 章）',
      '没有名字',
      '「未归属的伏笔」是保留名',
      '意图是空的',
    ]);
  });

  test('同一批里第二条主线不收；一次最多 8 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `线${i}`, kind: i < 2 ? '主线' : '支线', intent: '意图' }));
    const { plans, dropped } = t.verifyThreadPlans(many, { threads: [], foreshadowing: [] });
    assert.equal(plans.length, 8);
    assert.deepEqual(plans.filter((p) => p.kind === '主线').map((p) => p.name), ['线0']);
    assert.deepEqual(dropped.map((d) => d.why), ['主线全书只能有一条，已经有了', '一次最多排 8 条']);
  });

  test('伏笔：与全书已有的、同一批前面的重名跳过；章号不合理只去掉章号；一条线最多 5 条', () => {
    const fore = (title, extra = {}) => ({ title, what: `${title}是什么`, ...extra });
    const { plans, foreshadowDropped } = t.verifyThreadPlans(
      [
        {
          title: '甲',
          kind: '支线',
          intent: '意图',
          foreshadowing: [fore('玉佩', { plant: 3, resolve: 18 }), fore('火 折子'), fore('旧伤', { plant: 25, resolve: 2 }), fore('一'), fore('二'), fore('三'), fore('四')],
        },
        { title: '乙', kind: '支线', intent: '意图', foreshadowing: [fore('玉佩')] },
      ],
      existing,
      20
    );
    assert.deepEqual(plans[0].foreshadowing, [
      { name: '玉佩', what: '玉佩是什么', plant: 3, resolve: 18 },
      { name: '旧伤', what: '旧伤是什么', resolve: 2 },
      { name: '一', what: '一是什么' },
      { name: '二', what: '二是什么' },
      { name: '三', what: '三是什么' },
    ]);
    assert.deepEqual(plans[1].foreshadowing, []);
    assert.deepEqual(foreshadowDropped.map((d) => [d.name, d.why]), [
      ['火 折子', '同名的伏笔已经有了'],
      ['四', '一条线最多排 5 条伏笔'],
      ['玉佩', '同名的伏笔已经有了'],
    ]);
  });

  test('全书已有的伏笔名：各条线与未归属的，登记的与只在事件里出现的都算', () => {
    const book = {
      threads: [line([ev(3, '埋', { foreshadowing: '断剑' })], { foreshadowing: [{ name: '玉佩', what: '' }] })],
      unfiled: { name: '未归属的伏笔', relPath: 'x', foreshadowing: [{ name: '火折子', what: '' }], events: [] },
    };
    assert.deepEqual(t.foreshadowNames(book), ['玉佩', '断剑', '火折子']);
  });
});
