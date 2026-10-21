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

describe('threadFile.ts · 定稿：送哪些去认', () => {
  const pair = line([ev(3, '推进'), { ...ev(6, '推进'), planned: true }], {
    name: '林昭与沈青',
    kind: '感情线',
    index: 1,
    foreshadowing: [{ name: '玉佩', what: '旧物', resolve: 5 }, { name: '旧伤', what: '' }, { name: '名册', what: '', plant: 9 }],
    progress: '结盟了',
    progressThrough: 6,
  });
  const main = line([ev(2, '推进')], { name: '主线', kind: '主线', index: 0 });
  const done = line([ev(2, '收束')], { name: '收了', index: 2 });
  const quiet = line([ev(5, '推进')], { name: '沈家旧案', index: 3, foreshadowing: [{ name: '火折子', what: '', plant: 2 }] });
  const book = {
    threads: [main, pair, done, quiet],
    unfiled: {
      name: '未归属的伏笔',
      relPath: 'u',
      foreshadowing: [{ name: '提灯人', what: '' }],
      events: [ev(4, '埋', { foreshadowing: '提灯人' }), { ...ev(6, '埋', { foreshadowing: '断剑' }), planned: true }],
    },
  };

  test('本章的计划事件：各条线与未归属的都算，带在哪条线上', () => {
    assert.deepEqual(t.plannedFor(book, 6).map((p) => [p.line, p.event.type, p.event.foreshadowing]), [
      ['林昭与沈青', '推进', undefined],
      [undefined, '埋', '断剑'],
    ]);
  });

  test('线：本章有计划的 → 细纲提到的 → 主线 → 最近动过的；收了的不送；超出的跳过；当前进度写到这一章的不用', () => {
    const r = t.threadsToJudge(book, 6, '沈家旧案又被提起', 3);
    assert.deepEqual(r.judged.map((x) => x.name), ['林昭与沈青', '沈家旧案', '主线']);
    assert.equal(r.judged[0].progress, '', '当前进度写到第 6 章，定稿第 6 章时不用');
    assert.equal(r.judged[0].events.length, 1, '第 6 章及以后的事件去掉');
    assert.deepEqual(t.threadsToJudge(book, 6, '', 1).skipped.map((x) => x.name), ['主线', '沈家旧案']);
  });

  // 只在本章计划事件里出现、还没登记的（断剑）不算「没收的伏笔」：它在「本章计划」那一节里交给模型。
  test('伏笔：计划到期却没埋的（到期早的在前）→ 已埋的 → 其余；收了的不送；未归属的也在', () => {
    const r = t.foreshadowToJudge(book, 6, 10);
    assert.deepEqual(r.judged.map((f) => [f.name, f.line, f.status]), [
      ['火折子', '沈家旧案', '计划'],
      ['玉佩', '林昭与沈青', '计划'],
      ['提灯人', undefined, '已埋'],
      ['旧伤', '林昭与沈青', '计划'],
      ['名册', '林昭与沈青', '计划'],
    ]);
    assert.equal(t.foreshadowToJudge(book, 6, 2).skipped.length, 3);
  });

  // 试跑报告问题 4：没收的伏笔第 7 章就超过 foreshadowJudge，「伙计的执念来源」计划第 8 章埋，第 8 章恰好没送去认——
  // 从前不看伏笔自己的计划埋的章，没埋的排线伏笔落在最末一档，被模型自己登记的「已埋」挤了出去。
  test('伏笔：本章计划埋或收的 → 计划到期没埋的 → 已埋没收的（回收章近的在前、没写回收章的随后）→ 其余；上限照旧', () => {
    const grown = Array.from({ length: 6 }, (_, i) => ev(i + 1, '埋', { foreshadowing: `自登记${i + 1}` }));
    const big = {
      threads: [
        line(
          [...grown, ev(2, '埋', { foreshadowing: '名册' }), ev(3, '埋', { foreshadowing: '旧伤' }), { ...ev(8, '收', { foreshadowing: '断剑' }), planned: true }],
          {
            name: '主线',
            kind: '主线',
            index: 0,
            foreshadowing: [
              { name: '名册', what: '', resolve: 30 },
              { name: '旧伤', what: '', resolve: 9 },
              { name: '断剑', what: '', plant: 2, resolve: 8 },
              { name: '执念来源', what: '', plant: 8, resolve: 65 },
              { name: '温情假象', what: '', plant: 1, resolve: 18 },
              { name: '后面才埋', what: '', plant: 20 },
            ],
          }
        ),
      ],
      unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [], events: [] },
    };
    const r = t.foreshadowToJudge(big, 8, 6);
    assert.deepEqual(r.judged.map((f) => f.name), ['断剑', '温情假象', '执念来源', '旧伤', '名册', '自登记6']);
    assert.deepEqual(r.skipped.map((f) => f.name), ['自登记5', '自登记4', '自登记3', '自登记2', '自登记1', '后面才埋']);
  });
});

describe('threadFile.ts · 定稿：校验认出来的东西', () => {
  const text = '夜里，沈青把玉佩翻过来，背面刻着一个沈字。从今往后，他不再疑她。院外有人提着灯走过。';
  const pair = line([], { name: '林昭与沈青', kind: '感情线', foreshadowing: [{ name: '玉佩', what: '' }] });
  const book = {
    threads: [pair, line([], { name: '主线', kind: '主线' }), line([ev(1, '收束')], { name: '收了' })],
    unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [{ name: '提灯人', what: '' }], events: [] },
  };
  const verify = (raw, judged = [pair]) => t.verifyFinds(raw, { chapter: 6, text, judged, book });

  test('事件：线的事件只认送去的线与新线；伏笔的事件跟着伏笔走；证据逐字找得到；同一条只记一次', () => {
    // 玉佩、提灯人在这一章之前都埋下了（还没埋下的不能收，见下一条）。
    const planted = {
      threads: [{ ...pair, events: [ev(3, '埋', { foreshadowing: '玉佩' })] }, ...book.threads.slice(1)],
      unfiled: { ...book.unfiled, events: [ev(2, '埋', { foreshadowing: '提灯人' })] },
    };
    const r = t.verifyFinds({
      events: [
        { line: '林昭与沈青', type: '关系', what: '猜忌 → 信任', evidence: '从今往后，他不再疑她' },
        { line: '林昭与沈青', type: '关系', what: '重复', evidence: '从今往后他不再疑她。' },
        { line: '随便写的', type: '收', foreshadowing: '玉 佩', what: '揭开', evidence: '背面刻着一个沈字' },
        { type: '收', foreshadowing: '提灯人', what: '露面', evidence: '院外有人提着灯走过' },
        { line: '收了', type: '推进', what: 'x', evidence: '院外有人提着灯走过' },
        { line: '谁也不是', type: '推进', what: 'x', evidence: '院外有人提着灯走过' },
        { line: '林昭与沈青', type: '升华', what: 'x', evidence: '院外有人提着灯走过' },
        { line: '林昭与沈青', type: '推进', what: 'x', evidence: '编出来的一句话' },
        { line: '林昭与沈青', type: '推进', what: 'x', evidence: '沈字' },
        { line: '林昭与沈青', type: '收', foreshadowing: '没见过', what: 'x', evidence: '院外有人提着灯走过' },
        { line: '林昭与沈青', type: '收', what: 'x', evidence: '院外有人提着灯走过' },
      ],
    }, { chapter: 6, text, judged: [pair], book: planted });
    assert.deepEqual(r.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]), [
      ['林昭与沈青', '关系', undefined],
      ['林昭与沈青', '收', '玉佩'],
      [undefined, '收', '提灯人'],
    ]);
    assert.deepEqual(r.dropped.map((d) => d.why), [
      '这条线已经收束，或这一次没送去认',
      '认不出是哪一条线',
      '事件类型认不出',
      '证据在正文里找不到',
      '证据太短，认不出是哪一句',
      '认不出是哪一条伏笔',
      '没写是哪一条伏笔',
    ]);
  });

  // 复跑报告问题 2：证据丢弃率 13%，多半是把「他」换成了人名、两句拼成一句。⚑ 找最接近的原句，够像就换成原句收下。
  test('证据逐字找不到：正文里最接近的一句够像就换成那一句原文收下（记在 relocated 里），不够像照旧丢', () => {
    const r = verify({
      events: [
        { line: '林昭与沈青', type: '关系', what: '猜忌 → 信任', evidence: '从今往后，林昭不再疑她' },
        { line: '林昭与沈青', type: '推进', what: '编的', evidence: '林昭决定明天一早就离开青崖镇' },
      ],
      newThreads: [{ title: '提灯人的身份', kind: '人物线', evidence: '院外有个人提着灯走过' }],
    });
    assert.deepEqual(r.events.map((e) => [e.event.type, e.event.evidence]), [['关系', '从今往后，他不再疑她。']]);
    assert.deepEqual(r.newThreads.map((x) => x.evidence), ['院外有人提着灯走过。']);
    assert.deepEqual(r.dropped.map((d) => d.why), ['证据在正文里找不到']);
    assert.deepEqual(r.relocated, [
      { from: '院外有个人提着灯走过', to: '院外有人提着灯走过。' },
      { from: '从今往后，林昭不再疑她', to: '从今往后，他不再疑她。' },
    ]);
    assert.equal(verify({ events: [{ line: '林昭与沈青', type: '推进', what: 'x', evidence: '从今往后，他不再疑她' }] }).relocated, undefined, '逐字找得到的不算换过');
  });

  // 复跑报告问题 1（rerun-repro.js 第 1 段）：排线排的伏笔第 1 章还是「计划」，a 报了「收」，校验照收，从此不再提醒「不要提前揭开」。
  test('还没埋下的伏笔不能收、不能弃；之前埋过、这一章有它的「埋」（报的、已经记下的）、新认出的才算埋下', () => {
    const r = verify({
      events: [
        { line: '林昭与沈青', type: '收', foreshadowing: '玉佩', what: '揭开', evidence: '背面刻着一个沈字' },
        { type: '弃', foreshadowing: '提灯人', what: '作废', evidence: '院外有人提着灯走过' },
      ],
    });
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.dropped, [
      { what: '林昭与沈青〈玉佩〉', why: '这条伏笔还没埋下，不能收' },
      { what: '？〈提灯人〉', why: '这条伏笔还没埋下，不能弃' },
    ]);
    // 同一章先埋后收（报的顺序不论）：两条都记。
    const both = verify({
      events: [
        { line: '林昭与沈青', type: '收', foreshadowing: '玉佩', what: '揭开', evidence: '背面刻着一个沈字' },
        { line: '林昭与沈青', type: '埋', foreshadowing: '玉佩', what: '露面', evidence: '沈青把玉佩翻过来' },
      ],
    });
    assert.deepEqual(both.events.map((e) => e.event.type), ['收', '埋']);
    // 证据找不到的「埋」不算这一章埋下了。
    const fake = verify({
      events: [
        { line: '林昭与沈青', type: '埋', foreshadowing: '玉佩', what: '露面', evidence: '编出来的一句话' },
        { line: '林昭与沈青', type: '收', foreshadowing: '玉佩', what: '揭开', evidence: '背面刻着一个沈字' },
      ],
    });
    assert.deepEqual(fake.events, []);
    // 重新定稿这一章：这一章已经记下了它的「埋」。
    const again = t.verifyFinds(
      { events: [{ type: '收', foreshadowing: '提灯人', what: '揭开', evidence: '院外有人提着灯走过' }] },
      { chapter: 6, text, judged: [pair], book: { ...book, unfiled: { ...book.unfiled, events: [ev(6, '埋', { foreshadowing: '提灯人' })] } } }
    );
    assert.deepEqual(again.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '提灯人']]);
    // 这一章新认出的伏笔会补一条「埋」：同一章收它照记。
    const fresh = verify({
      newForeshadowing: [{ title: '断剑', what: '', evidence: '背面刻着一个沈字' }],
      events: [{ type: '收', foreshadowing: '断剑', what: '揭开', evidence: '院外有人提着灯走过' }],
    });
    assert.deepEqual(fresh.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '断剑']]);
  });

  test('新线：种类四选一、不重名、主线已有不收、要有证据、一章最多 2 条；事件可以挂在新线上', () => {
    const r = verify({
      newThreads: [
        { title: '沈家旧案', kind: '支线', intent: '沈家的事', evidence: '背面刻着一个沈字' },
        { title: '林昭 与沈青', kind: '感情线', evidence: '背面刻着一个沈字' },
        { title: '另一条主线', kind: '主线', evidence: '背面刻着一个沈字' },
        { title: '奇怪的线', kind: '暗线', evidence: '背面刻着一个沈字' },
        { title: '没证据', kind: '支线', evidence: '编出来的一句话' },
        { title: '提灯人的身份', kind: '人物线', evidence: '院外有人提着灯走过' },
        { title: '第三条', kind: '支线', evidence: '院外有人提着灯走过' },
      ],
      events: [{ line: '沈家旧案', type: '推进', what: '沈字露面', evidence: '背面刻着一个沈字' }],
    });
    assert.deepEqual(r.newThreads.map((x) => [x.name, x.kind]), [['沈家旧案', '支线'], ['提灯人的身份', '人物线']]);
    assert.deepEqual(r.dropped.map((d) => d.why), [
      '这条线已经有了',
      '主线全书只能有一条，已经有了',
      '种类不是主线 / 支线 / 感情线 / 人物线之一',
      '证据在正文里找不到',
      '一章最多认出 2 条新线',
    ]);
    assert.deepEqual(r.events.map((e) => e.line), ['沈家旧案']);
  });

  test('新伏笔：挂得上线就挂（已有的或新认出的），挂不上进未归属；没见过的被埋了也当新伏笔', () => {
    const r = verify({
      newThreads: [{ title: '沈家旧案', kind: '支线', evidence: '背面刻着一个沈字' }],
      newForeshadowing: [
        { title: '沈字', what: '玉佩背面的沈字', line: '沈家旧案', evidence: '背面刻着一个沈字' },
        { title: '断剑', what: '', line: '没有这条线', evidence: '院外有人提着灯走过' },
        { title: '玉佩', what: '重名', evidence: '院外有人提着灯走过' },
      ],
      events: [{ line: '林昭与沈青', type: '埋', foreshadowing: '那盏灯', what: '提灯', evidence: '院外有人提着灯走过' }],
    });
    assert.deepEqual(r.newForeshadowing.map((f) => [f.name, f.line]), [
      ['沈字', '沈家旧案'],
      ['断剑', undefined],
      ['那盏灯', '林昭与沈青'],
    ]);
    assert.deepEqual(r.dropped.map((d) => [d.what, d.why]), [['新伏笔 玉佩', '这条伏笔已经有了']]);
  });

  // ⚑ 试跑之后从 5 收到 3：模型报的新伏笔多半是噪音，一章就报了 4 条。
  test('一章最多认出 3 条新伏笔（先校验后截）：单列的「埋」报出来的没见过的伏笔也算在里面', () => {
    const r = verify({
      newForeshadowing: [
        { title: '沈字', what: '', evidence: '编出来的一句话' },
        { title: '一', what: '', evidence: '背面刻着一个沈字' },
        { title: '二', what: '', evidence: '从今往后，他不再疑她' },
        { title: '三', what: '', evidence: '院外有人提着灯走过' },
      ],
      events: [{ line: '林昭与沈青', type: '埋', foreshadowing: '四', what: '', evidence: '院外有人提着灯走过' }],
    });
    assert.deepEqual(r.newForeshadowing.map((f) => f.name), ['一', '二', '三']);
    assert.deepEqual(r.dropped.map((d) => d.why), ['证据在正文里找不到', '一章最多认出 3 条新伏笔']);
  });

  test('一章最多 8 个事件（先校验后截）；整份不是对象也不崩', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ line: '林昭与沈青', type: '推进', what: `第${i}件`, evidence: i === 0 ? '编出来的一句话' : text.slice(i, i + 6) }));
    const r = verify({ events: many });
    assert.equal(r.events.length, 8);
    assert.deepEqual(r.dropped.map((d) => d.why), ['证据在正文里找不到', '一章最多记 8 个事件']);
    assert.deepEqual(verify(null), { events: [], newThreads: [], newForeshadowing: [], dropped: [] });
    assert.deepEqual(verify([1, 2]).events, []);
  });

  test('归并：线并进线、伏笔并进伏笔，认不出的不并；用上之后事件改挂、不另建', () => {
    const finds = verify({
      newThreads: [{ title: '沈家的旧案', kind: '支线', evidence: '背面刻着一个沈字' }],
      newForeshadowing: [{ title: '那块玉佩', what: '', line: '沈家的旧案', evidence: '背面刻着一个沈字' }],
      events: [
        { line: '沈家的旧案', type: '推进', what: '露面', evidence: '背面刻着一个沈字' },
        { line: '林昭与沈青', type: '收', foreshadowing: '那块玉佩', what: '揭开', evidence: '院外有人提着灯走过' },
      ],
    });
    const merges = t.verifyMerges(
      [
        { new: '沈家的旧案', into: '主线', reason: '同一桩旧案' },
        { new: '沈家的旧案', into: '林昭与沈青', reason: '同一桩旧案' },
        { new: '那块玉佩', into: '林昭与沈青', reason: '同一块玉佩' },
        { new: '那块玉佩', into: '玉佩', reason: '同一块玉佩' },
        { new: '不存在', into: '主线', reason: '没有这一条' },
      ],
      finds,
      book,
      6
    );
    assert.deepEqual(merges, [
      { kind: 'thread', from: '沈家的旧案', into: '主线', reason: '同一桩旧案' },
      { kind: 'foreshadowing', from: '那块玉佩', into: '玉佩', reason: '同一块玉佩' },
    ]);
    const applied = t.applyMerges(finds, merges, book, 6);
    assert.deepEqual(applied.finds.newThreads, []);
    assert.deepEqual(applied.finds.newForeshadowing, []);
    // 玉佩写到第 6 章时还是「计划」：这一章就是它埋下的一章，补的「埋」排在同一章的「收」前面。
    assert.deepEqual(applied.finds.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.evidence]), [
      ['主线', '推进', undefined, '背面刻着一个沈字'],
      ['林昭与沈青', '埋', '玉佩', '背面刻着一个沈字'],
      ['林昭与沈青', '收', '玉佩', '院外有人提着灯走过'],
    ]);
    assert.deepEqual(applied.merges, merges, '都带过来了事件，没有说明');
  });

  // 试跑报告问题 2（repro.js 第 2 段）：新伏笔只写在 newForeshadowing、没单列「埋」，并进已有的以后这一章的记录整条没了。
  describe('归并之后新伏笔的那一条「埋」挂到已有的那条上', () => {
    const raw = [
      '---',
      'kind: 主线',
      'plan: 1-100',
      '---',
      '',
      '# 沈默的灭门复仇',
      '',
      '## 伏笔',
      '',
      '- 焦黑罗盘的本质：罗盘是大火余烬。（计划第 1 章埋、第 95 章前收）',
      '- 祠堂的隐秘：祠堂里藏着灵位。',
      '',
      '## 进展',
      '',
      '- 第 1 章 · 埋〈祠堂的隐秘〉：祠堂第一次露面 〔证据：「祠堂的门半掩着」〕',
      '',
    ].join('\n');
    const main = t.parseThreadFile(raw, '.novelforge/threads/沈默的灭门复仇.md');
    const story = { threads: [main], unfiled: t.parseUnfiledFile('', '.novelforge/threads/未归属的伏笔.md') };
    const body = '罗盘虽然渐渐平息了那种滚烫的烙铁感，但余温依旧像碎炭一般留在皮肉里。祠堂地下有一座祭坛。';
    const find = (newForeshadowing, events = []) =>
      t.verifyFinds({ events, newThreads: [], newForeshadowing }, { chapter: 2, text: body, judged: [main], book: story });
    const run = (finds, raw) => {
      const r = t.applyMerges(finds, t.verifyMerges(raw, finds, story, 2), story, 2);
      return { merges: r.merges, events: t.completeFinds(r.finds, 2).events };
    };
    const burn = { title: '罗盘使用后的灼烧侵蚀', what: '灼烧感侵蚀活人气息', line: '沈默的灭门复仇', evidence: '余温依旧像碎炭一般留在皮肉里' };

    test('已有的那条还没埋：这一章记一条「埋〈已有的〉」，证据用新伏笔的；完成提示不另加说明', () => {
      const r = run(find([burn]), [{ new: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质', reason: '都是罗盘的代价' }]);
      assert.deepEqual(r.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.what, e.event.evidence]), [
        ['沈默的灭门复仇', '埋', '焦黑罗盘的本质', '灼烧感侵蚀活人气息', '余温依旧像碎炭一般留在皮肉里'],
      ]);
      assert.equal(r.merges[0].note, undefined);
    });

    test('模型单列了「埋〈新的〉」：改叫已有的名字，同一章只记一条', () => {
      const r = run(find([burn], [{ line: '沈默的灭门复仇', type: '埋', foreshadowing: '罗盘使用后的灼烧侵蚀', what: '罗盘发烫', evidence: '滚烫的烙铁感' }]), [
        { new: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质', reason: '都是罗盘的代价' },
      ]);
      assert.deepEqual(r.events.map((e) => [e.event.type, e.event.foreshadowing, e.event.evidence]), [['埋', '焦黑罗盘的本质', '滚烫的烙铁感']]);
    });

    test('已有的那条第 1 章已经埋下：不再记第二条「埋」，说明写在 note 里（完成提示照它说）', () => {
      const altar = { title: '祠堂地下祭坛', what: '祠堂地下有祭坛', line: '沈默的灭门复仇', evidence: '祠堂地下有一座祭坛' };
      const r = run(find([altar], [{ line: '沈默的灭门复仇', type: '埋', foreshadowing: '祠堂地下祭坛', what: '祭坛', evidence: '祠堂地下有一座祭坛' }]), [
        { new: '祠堂地下祭坛', into: '祠堂的隐秘', reason: '祠堂底下藏的就是祭坛' },
      ]);
      assert.deepEqual(r.events, []);
      assert.equal(r.merges[0].note, '〈祠堂的隐秘〉第 1 章已经埋下，这一章不再记「埋」');
    });

    test('已经埋下的伏笔，模型直接再报一次「埋」：不记，说清第几章已经埋下', () => {
      const finds = find([], [{ line: '沈默的灭门复仇', type: '埋', foreshadowing: '祠堂的隐秘', what: '又见祠堂', evidence: '祠堂地下有一座祭坛' }]);
      assert.deepEqual(finds.events, []);
      assert.deepEqual(finds.dropped.map((d) => [d.what, d.why]), [['沈默的灭门复仇〈祠堂的隐秘〉', '这条伏笔第 1 章已经埋下']]);
      // 重新定稿第 1 章：埋在第 1 章那一次不算「之前」，照收（同一条由去重挡住）。
      const again = t.verifyFinds(
        { events: [{ line: '沈默的灭门复仇', type: '埋', foreshadowing: '祠堂的隐秘', what: '祠堂', evidence: '祠堂地下有一座祭坛' }] },
        { chapter: 1, text: body, judged: [main], book: story }
      );
      assert.equal(again.events.length, 1);
    });

    test('伏笔只能并进还没收的：并进收了的那条不认（照新的建），理由只进日志', () => {
      const closed = t.parseThreadFile(raw.replace('\n## 进展\n', '\n## 进展\n\n- 第 1 章 · 收〈焦黑罗盘的本质〉：揭开 〔证据：「罗盘」〕'), main.relPath);
      const book2 = { threads: [closed], unfiled: story.unfiled };
      assert.deepEqual(t.openForeshadowing(book2, 2).map((f) => [f.name, f.status]), [['祠堂的隐秘', '已埋']]);
      const finds = find([burn]);
      assert.deepEqual(t.verifyMerges([{ new: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质' }], finds, book2, 2), []);
      assert.deepEqual(t.verifyMerges([{ new: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质', reason: '都是罗盘的事' }], finds, story, 2), [
        { kind: 'foreshadowing', from: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质', reason: '都是罗盘的事' },
      ]);
    });

    // 复跑报告问题 4：并了 2 次、2 次都错，理由都是「两者均指……」；修复 3 以后并错的「埋」会记到已有伏笔上。⚑ 更保守。
    test('归并更保守：没给理由的不并；两个伏笔名一个相同的词都没有的不并（复跑里并错的两次）；没采纳的说出来', () => {
      const threat = { title: '红姑的灯', what: '红姑的灯火逼近', line: '沈默的灭门复仇', evidence: '余温依旧像碎炭一般留在皮肉里' };
      const vessel = { title: '沈默的容器身份', what: '沈默是容器', line: '沈默的灭门复仇', evidence: '祠堂地下有一座祭坛' };
      const finds = find([threat, vessel, burn]);
      const rejected = [];
      const merges = t.verifyMerges(
        [
          { new: '红姑的灯', into: '焦黑罗盘的本质', reason: '两者均指代废墟外正在逼近的威胁性邪祟。' },
          { new: '沈默的容器身份', into: '祠堂的隐秘', reason: '两者均指向沈默非活人且作为某种载体的本质。' },
          { new: '罗盘使用后的灼烧侵蚀', into: '焦黑罗盘的本质' },
        ],
        finds,
        story,
        2,
        rejected
      );
      assert.deepEqual(merges, []);
      assert.deepEqual(rejected.map((r) => r.why), ['两个名字里没有一个相同的词', '两个名字里没有一个相同的词', '没说为什么是同一件事']);
      assert.match(rejected[0].what, /^〈红姑的灯〉→〈焦黑罗盘的本质〉（两者均指代/);
      // 线不看名字（同一条剧情线换个名字很常见），照样要理由。
      assert.equal(t.namesShareWord('红姑的灯', '红姑的监视'), true);
      assert.equal(t.namesShareWord('祠堂地下祭坛', '祠堂的隐秘'), true);
      assert.equal(t.namesShareWord('沈默的容器身份', '尸斑的出现'), false);
    });

    test('并掉的新线这一章没带来任何事件：note 说「这一章没有另记事件」，不替它编一条推进', () => {
      const finds = t.verifyFinds(
        { newThreads: [{ title: '复仇之路', kind: '支线', intent: '换个说法', evidence: '余温依旧像碎炭一般留在皮肉里' }] },
        { chapter: 2, text: body, judged: [main], book: story }
      );
      const r = t.applyMerges(finds, [{ kind: 'thread', from: '复仇之路', into: '沈默的灭门复仇' }], story, 2);
      assert.deepEqual(t.completeFinds(r.finds, 2).events, []);
      assert.equal(r.merges[0].note, '这一章没有另记事件');
    });
  });

  test('补上隐含的那一条：新线没有事件记一条推进，新伏笔没有埋记一条埋', () => {
    const finds = verify({
      newThreads: [{ title: '沈家旧案', kind: '支线', evidence: '背面刻着一个沈字' }],
      newForeshadowing: [{ title: '那盏灯', what: '提灯', evidence: '院外有人提着灯走过' }],
    });
    const done = t.completeFinds(finds, 6);
    assert.deepEqual(done.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.evidence]), [
      ['沈家旧案', '推进', undefined, '背面刻着一个沈字'],
      [undefined, '埋', '那盏灯', '院外有人提着灯走过'],
    ]);
  });

  test('当前进度：名字认得出、不是空的才收，截到 150 字，一条线一条', () => {
    const long = '长'.repeat(200);
    assert.deepEqual(
      t.verifyProgress(
        [{ line: '林昭 与沈青', text: '结盟了' }, { line: '林昭与沈青', text: '又一条' }, { line: '没送去的', text: 'x' }, { line: '主线', text: '' }, { thread: '主线', progress: long }],
        ['林昭与沈青', '主线']
      ).map((x) => [x.line, [...x.text].length]),
      [
        ['林昭与沈青', 3],
        ['主线', 150],
      ]
    );
  });

  // 试跑（gemini-3-flash-lite）：提示里写成「名字（种类）」，10 次里 9 次照抄回来，22 条只落盘 1 条。
  test('当前进度：模型回的线名带了种类、括号、引号、【线】标签也认得出；原样对得上的优先', () => {
    const sent = ['沈默的灭门复仇', '沈默与沈怀山的博弈', '林昭与沈青', '旧案', '旧案主线', '玉佩'];
    const got = t.verifyProgress(
      [
        { line: '沈默的灭门复仇（主线）', text: '一' },
        { line: '沈默与沈怀山的博弈 (人物线)', text: '二' },
        { line: '「林昭与沈青」〈感情线〉', text: '三' },
        { line: '旧案主线', text: '四' },
        { line: '【线】《玉佩》', text: '五' },
      ],
      sent
    );
    assert.deepEqual(got.map((x) => [x.line, x.text]), [
      ['沈默的灭门复仇', '一'],
      ['沈默与沈怀山的博弈', '二'],
      ['林昭与沈青', '三'],
      ['旧案主线', '四'],
      ['玉佩', '五'],
    ]);
    // 只有「旧案」送去了：「旧案 · 主线」去掉末尾的种类认成它。
    assert.deepEqual(t.verifyProgress([{ line: '旧案 · 主线', text: '六' }], ['旧案']).map((x) => x.line), ['旧案']);
    assert.deepEqual(t.verifyProgress([{ line: '旧案的余波（主线）', text: '七' }], ['旧案']), [], '去掉装饰也对不上的不收');
    assert.equal(t.bareThreadName('【线】「沈默的灭门复仇」（主线）'), '沈默的灭门复仇');
  });
});

describe('threadFile.ts · 写正文、审稿带哪几条', () => {
  const pair = line(
    [ev(3, '推进', { what: '初遇。' }), ev(3, '埋', { foreshadowing: '玉佩' }), { ...ev(5, '推进', { what: '挡刀' }), planned: true }, { ...ev(5, '埋', { foreshadowing: '断剑', what: '断剑落潭' }), planned: true }],
    {
      name: '林昭与沈青',
      kind: '感情线',
      relPath: 'p',
      index: 0,
      progress: '结盟了。',
      progressThrough: 4,
      foreshadowing: [{ name: '玉佩', what: '旧物', resolve: 18 }, { name: '断剑', what: '' }, { name: '名册', what: '', plant: 9 }],
    }
  );
  const later = line([], { name: '后面才开', relPath: 'l', index: 1, from: 9 });
  const book = { threads: [pair, later], unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [], events: [] } };

  test('一行：现在（去掉句末标点）、本章计划、没收的伏笔（本章计划埋的在前，还没到埋的不提）', () => {
    const [c] = t.manuscriptThreads(book, 5, '');
    assert.equal(c.line, '- 林昭与沈青（感情线 · 进行中）现在：结盟了；本章计划：推进——挡刀；埋〈断剑〉——断剑落潭；没收的伏笔：断剑（本章计划埋，不要当场揭开）、玉佩（第 18 章前不要揭开）');
    assert.deepEqual([c.relPath, c.status, c.why, c.rank], ['p', '进行中', '本章有计划', 0]);
  });

  test('计划中、还没到开始那一章的不带；当前进度写到这一章或更晚的不用，改用之前的事件', () => {
    assert.deepEqual(t.manuscriptThreads(book, 5, '').map((c) => c.name), ['林昭与沈青']);
    const [c] = t.manuscriptThreads(book, 4, '');
    // 「最近」不取「埋」（复跑之后：「埋」那一句写的多半是伏笔的谜面，不是这条线走到哪）。
    assert.equal(c.line, '- 林昭与沈青（感情线 · 进行中）最近：第 3 章推进：初遇；没收的伏笔：玉佩（第 18 章前不要揭开）');
  });

  test('放不下的跳过、接着试下一条；明细里怎么称呼可换', () => {
    const list = [{ line: 'a'.repeat(5) }, { line: 'b'.repeat(20) }, { line: 'c'.repeat(3) }];
    const r = t.fitThreads(list, { count: 2, chars: 10 }, '伏笔');
    assert.deepEqual(r.picked.map((x) => x.line), ['aaaaa', 'ccc']);
    assert.deepEqual(r.dropped.map((x) => x.note), ['伏笔一共只带 10 字，放不下这一条']);
    assert.deepEqual(t.fitThreads(list, { count: 1, chars: 100 }).dropped.map((x) => x.note), [
      '叙事线一次只带 1 条，排在后面的没带',
      '叙事线一次只带 1 条，排在后面的没带',
    ]);
  });

  // 复跑报告问题 5 的两个例子：细纲写「发现两枚铜牌与铜钱的共鸣契机」，伏笔叫「旧铜牌与铜钱的共鸣」。⚑ 六成、连着三个字。
  test('细纲提没提到一条伏笔：去掉虚字之后的两字词六成出现、有两个挨着；名字只有两个字的要整个出现', () => {
    const plot = t.mentionTest('沈默发现两枚铜牌与铜钱的共鸣契机。他捡到照骨镜残片，惊醒了无面鬼火。阿婆递来一碗水。井底有人。沉船的秘密。他摸出玉佩。');
    assert.deepEqual(
      ['旧铜牌与铜钱的共鸣', '照骨镜的残片', '无面鬼火的本质', '阿婆的真实身份', '井底的秘密', '玉佩', '佩剑', '名册'].map((n) => [n, plot(n)]),
      [
        ['旧铜牌与铜钱的共鸣', true],
        ['照骨镜的残片', true],
        ['无面鬼火的本质', true],
        ['阿婆的真实身份', false],
        ['井底的秘密', false],
        ['玉佩', true],
        ['佩剑', false],
        ['名册', false],
      ]
    );
  });

  test('本章细纲、本章计划提到的伏笔一律列出，不占每条线 4 条的名额；收束了的线只列提到的那几条', () => {
    const many = ['甲', '乙', '丙', '丁', '戊'].map((x, i) => ({ name: `${x}号暗格`, what: '', resolve: 20 + i }));
    const fores = [...many, { name: '照骨镜的残片', what: '', resolve: 30 }, { name: '还远的计划', what: '', plant: 9, resolve: 40 }];
    const main = line([ev(1, '推进', { what: '起火' }), ...fores.slice(0, 6).map((f) => ev(1, '埋', { foreshadowing: f.name }))], {
      name: '主线',
      kind: '主线',
      relPath: 'm',
      foreshadowing: fores,
    });
    main.events.push({ ...ev(5, '推进', { what: '〈还远的计划〉推迟到第 12 章埋' }), planned: true });
    const closed = line([ev(1, '埋', { foreshadowing: '沉船' }), ev(2, '收束')], { name: '收了', relPath: 'c', index: 1, foreshadowing: [{ name: '沉船', what: '' }] });
    const b = { threads: [main, closed], unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [], events: [] } };
    const rows = t.manuscriptThreads(b, 5, '他捡到照骨镜残片。沉船浮出水面。');
    const m = rows.find((r) => r.name === '主线');
    assert.equal(
      m.line,
      '- 主线（主线 · 进行中）最近：第 1 章推进：起火；本章计划：推进——〈还远的计划〉推迟到第 12 章埋；没收的伏笔：照骨镜的残片（第 30 章前不要揭开）、' +
        '还远的计划（第 40 章前不要揭开）、甲号暗格（第 20 章前不要揭开）、乙号暗格（第 21 章前不要揭开）、丙号暗格（第 22 章前不要揭开）、丁号暗格（第 23 章前不要揭开）'
    );
    assert.deepEqual(m.mentioned, ['照骨镜的残片', '还远的计划']);
    const c = rows.find((r) => r.name === '收了');
    // 没有回收章的不硬写「不要提前揭开」。
    assert.deepEqual([c.line, c.rank, c.why], ['- 收了（支线 · 已收束）没收的伏笔：沉船（还没定哪一章收，细纲没安排就别揭开）', 0, '本章细纲提到了它上面的伏笔']);
    assert.ok(t.reviewForeshadowing(b, 5).some((r) => r.line === '- 沉船（挂在「收了」· 已埋 · 还没定哪一章收，细纲没安排就不该揭开）'));
    // 没提到时：收束了的线不带，计划中、还没到埋的不提，主线照旧最多 4 条。
    const bare = t.manuscriptThreads(b, 5, '');
    assert.deepEqual(bare.map((r) => r.name), ['主线']);
    assert.ok(!bare[0].line.includes('照骨镜') && !bare[0].line.includes('戊号暗格'), bare[0].line);
  });

  test('审稿：只提跟这一章有关的伏笔，「不要揭开」换成「不该揭开」', () => {
    assert.deepEqual(t.reviewForeshadowing(book, 5).map((c) => c.line), [
      '- 断剑（挂在「林昭与沈青」· 计划 · 本章计划埋，不该当场揭开）',
      '- 玉佩（挂在「林昭与沈青」· 已埋 · 第 18 章前不该揭开）是什么：旧物',
    ]);
  });
});

describe('threadFile.ts · 拆细纲带哪几条（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const pair = line(
    [ev(3, '推进', { what: '初遇。' }), ev(3, '埋', { foreshadowing: '玉佩' }), plan(6, '推进', { what: '挡刀' }), plan(7, '收', { foreshadowing: '旧伤' })],
    {
      name: '林昭与沈青',
      kind: '感情线',
      relPath: 'p',
      index: 0,
      from: 2,
      to: 30,
      intent: '从猜忌到并肩。',
      progress: '结盟了。',
      progressThrough: 4,
      foreshadowing: [
        { name: '玉佩', what: '旧物', resolve: 18 },
        { name: '旧伤', what: '', resolve: 7 },
        { name: '名册', what: '', plant: 9 },
        { name: '令牌', what: '', plant: 5, resolve: 20 },
      ],
    }
  );
  const fire = line([ev(1, '推进', { what: '起火' })], { name: '大火', kind: '主线', relPath: 'f', index: 1, from: 1, to: 40 });
  const later = line([], { name: '后面才开', relPath: 'l', index: 2, from: 12, foreshadowing: [{ name: '师父的信', what: '' }] });
  const quiet = line([ev(2, '推进', { what: '犹豫' })], { name: '断了的线', kind: '人物线', relPath: 'q', index: 3 });
  const closed = line([ev(2, '收束')], { name: '收了的线', relPath: 'c', index: 4, foreshadowing: [{ name: '收了线上没收的', what: '', resolve: 4 }] });
  const unfiled = {
    name: '未归属的伏笔',
    relPath: 'u',
    foreshadowing: [{ name: '提灯人', what: '院外提灯的人', resolve: 4 }],
    events: [ev(2, '埋', { foreshadowing: '提灯人' })],
  };
  const book = { threads: [pair, fire, later, quiet, closed], unfiled };

  test('线：这几章原来有计划的 → 主线 → 进行中的 → 还没到开始的（写明还不到）；收束了的不带', () => {
    const { lines } = t.plotThreads(book, { from: 5, to: 9 });
    assert.deepEqual(lines.map((c) => [c.name, c.why]), [
      ['林昭与沈青', '本批原来有计划'],
      ['大火', '主线'],
      ['断了的线', '最近第 2 章动过'],
      ['后面才开', '计划第 12 章起，本批还不到'],
    ]);
    assert.equal(
      lines[0].line,
      '- 林昭与沈青（感情线 · 进行中 · 计划第 2–30 章）意图：从猜忌到并肩；现在：结盟了；最近：第 3 章推进：初遇；第 3 章埋〈玉佩〉；本批原来的计划：第 6 章推进——挡刀'
    );
    assert.equal(lines[3].line, '- 后面才开（支线 · 计划中 · 计划第 12 章起）本批还不到它开始的那一章，不要提前开');
  });

  test('伏笔：这几章或更早要收的在前（逾期的写「已过」）→ 原来有计划的 → 已埋的、计划在这几章埋的；之后才埋的不带', () => {
    const { foreshadowing } = t.plotThreads(book, { from: 5, to: 9 });
    assert.deepEqual(foreshadowing.map((c) => c.line), [
      '- 收了线上没收的（挂在「收了的线」· 计划 · 已过第 4 章，还没收，还没埋，先埋再收）',
      '- 提灯人（挂在「未归属的伏笔」· 已埋 · 已过第 4 章，还没收）是什么：院外提灯的人',
      '- 旧伤（挂在「林昭与沈青」· 计划 · 本批要收，最晚第 7 章，还没埋，先埋再收）本批原来的计划：第 7 章收',
      '- 玉佩（挂在「林昭与沈青」· 已埋 · 第 18 章前收，之前不要揭开）是什么：旧物',
      '- 令牌（挂在「林昭与沈青」· 计划 · 本批要埋，计划第 5 章、第 20 章前收）',
      '- 名册（挂在「林昭与沈青」· 计划 · 本批要埋，计划第 9 章）',
    ]);
    // 「后面才开」那条线还没开始：它上面没定哪一章埋的伏笔不提。
    assert.ok(!foreshadowing.some((c) => c.name === '师父的信'));
  });

  test('单章说「本章」；按区间第一章算：当前进度写到那一章或更晚不用，之后的事件不算', () => {
    const { lines, foreshadowing } = t.plotThreads(book, { from: 3, to: 3 });
    assert.equal(lines[0].name, '大火');
    const p = lines.find((c) => c.name === '林昭与沈青');
    assert.equal(p.line, '- 林昭与沈青（感情线 · 计划中 · 计划第 2–30 章）意图：从猜忌到并肩');
    assert.equal(p.why, '本批在它的计划区间里'.replace('本批', '本章'));
    // 第 7 章才收、本章没计划，也没定哪一章埋：线已经到了计划区间，照提，写明还没定。
    assert.equal(foreshadowing.find((c) => c.name === '旧伤').why, '还没定哪一章埋');
    assert.ok(!foreshadowing.some((c) => c.name === '令牌'), '计划第 5 章才埋');
    assert.equal(t.planScope({ from: 3, to: 3 }), '本章');
    assert.equal(t.planScope({ from: 3, to: 7 }), '本批');
  });
});

describe('threadFile.ts · 拆细纲：计划落到哪份文件上（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const pair = line([ev(3, '推进'), ev(3, '埋', { foreshadowing: '玉佩' }), plan(6, '推进', { what: '旧的计划' })], {
    name: '林昭与沈青',
    relPath: 'p',
    index: 0,
    foreshadowing: [{ name: '玉佩', what: '旧物', resolve: 18 }, { name: '旧伤', what: '' }],
  });
  const closed = line([ev(2, '收束')], { name: '收了的线', relPath: 'c', index: 1, foreshadowing: [{ name: '收了的伏笔', what: '' }] });
  closed.events.push(ev(2, '收', { foreshadowing: '收了的伏笔' }));
  const unfiled = {
    name: '未归属的伏笔',
    relPath: 'u',
    foreshadowing: [{ name: '提灯人', what: '' }],
    events: [ev(2, '埋', { foreshadowing: '提灯人' }), plan(6, '收', { foreshadowing: '提灯人' })],
  };
  const book = { threads: [pair, closed], unfiled };
  const entry = (line, type, extra = {}) => ({ line, type, what: '', ...extra });

  test('线的事件：认得出、没收束的线才记；认不出的、收束了的丢掉并说原因', () => {
    const [c] = t.resolvePlanEvents(book, [
      { no: 6, entries: [entry('林昭 与 沈青', '推进', { what: '挡刀' }), entry('没有这条线', '关系'), entry('收了的线', '推进')] },
    ]);
    assert.deepEqual(c.events, [{ line: '林昭与沈青', event: { chapter: 6, planned: true, type: '推进', what: '挡刀' } }]);
    assert.deepEqual(c.dropped, [
      { what: '没有这条线 关系', why: '认不出是哪一条线' },
      { what: '收了的线 推进', why: '这条线已经收束了' },
    ]);
    // 第 6 章原来有两条计划（线上一条、未归属里一条）：写入时整组换掉。
    assert.equal(c.replaced, 2);
  });

  test('伏笔的事件跟着伏笔走（不看 line）；收了的不记，已经埋下的再埋不记；没见过的被收丢掉', () => {
    const [c] = t.resolvePlanEvents(book, [
      {
        no: 6,
        entries: [
          entry('别的线', '收', { foreshadowing: '提灯人' }),
          entry('', '收', { foreshadowing: '玉佩' }),
          entry('', '收', { foreshadowing: '收了的伏笔' }),
          entry('', '埋', { foreshadowing: '玉佩' }),
          entry('', '收', { foreshadowing: '没见过' }),
        ],
      },
    ]);
    assert.deepEqual(
      c.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]),
      [
        [undefined, '收', '提灯人'],
        ['林昭与沈青', '收', '玉佩'],
      ]
    );
    assert.deepEqual(c.dropped.map((d) => d.why), ['这条伏笔已经收了', '这条伏笔第 3 章已经埋下了', '认不出是哪一条伏笔']);
  });

  test('没见过的伏笔被埋：挂在认得出的线上，认不出进未归属；登记成「计划第 N 章埋、第 b 章前收」；后面几章收它认得出', () => {
    const [a, b] = t.resolvePlanEvents(book, [
      { no: 8, entries: [entry('林昭与沈青', '收', { foreshadowing: '断剑' })] },
      {
        no: 7,
        entries: [
          entry('林昭与沈青', '埋', { foreshadowing: '断剑', what: '断剑落潭', resolve: 9 }),
          entry('瞎写的线', '埋', { foreshadowing: '名册', what: '名册少一页' }),
        ],
      },
    ]);
    // 按章号先后走：第 7 章先埋，第 8 章才收得到。
    assert.deepEqual([a.no, b.no], [7, 8]);
    assert.deepEqual(a.newForeshadowing, [
      { line: '林昭与沈青', foreshadowing: { name: '断剑', what: '断剑落潭', plant: 7, resolve: 9 } },
      { foreshadowing: { name: '名册', what: '名册少一页', plant: 7 } },
    ]);
    assert.deepEqual(a.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]), [
      ['林昭与沈青', '埋', '断剑'],
      [undefined, '埋', '名册'],
    ]);
    assert.deepEqual(b.events, [{ line: '林昭与沈青', event: { chapter: 8, planned: true, type: '收', foreshadowing: '断剑', what: '' } }]);
    assert.equal(a.replaced, 0);
  });

  // 复跑报告问题 1：拆细纲照写了「没埋就收」（未归属的伏笔里〈无面鬼火的实体凝聚〉第 15 章计划收，从没埋过）。
  test('计划「收」要排在「埋」之后：实际埋过、或者更早的一章计划埋它（已有的、这一批前面几章的）才记', () => {
    const fresh = {
      ...book,
      threads: [
        {
          ...pair,
          foreshadowing: [...pair.foreshadowing, { name: '名册', what: '', plant: 5 }, { name: '令牌', what: '' }, { name: '断剑', what: '' }],
          events: [...pair.events, plan(5, '埋', { foreshadowing: '令牌' }), plan(9, '埋', { foreshadowing: '断剑' })],
        },
        closed,
      ],
    };
    const [c7, c8] = t.resolvePlanEvents(fresh, [
      {
        no: 7,
        entries: [
          entry('', '收', { foreshadowing: '旧伤' }),
          entry('', '收', { foreshadowing: '名册' }),
          entry('', '收', { foreshadowing: '令牌' }),
          entry('', '收', { foreshadowing: '断剑' }),
          entry('', '埋', { foreshadowing: '名册' }),
        ],
      },
      { no: 8, entries: [entry('', '收', { foreshadowing: '名册' })] },
    ]);
    // 旧伤从没埋过、也没有计划埋；名册「计划第 5 章埋」只是伏笔那一行写的，不算安排过；断剑计划第 9 章才埋；同一章先埋后收也不算。
    assert.deepEqual(c7.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '令牌'], ['埋', '名册']]);
    assert.deepEqual(c7.dropped.map((d) => d.what), ['收〈旧伤〉', '收〈名册〉', '收〈断剑〉']);
    assert.match(c7.dropped[0].why, /还没埋，「收」要排在「埋」之后/);
    // 第 7 章刚排了「埋〈名册〉」，第 8 章收得到。
    assert.deepEqual(c8.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '名册']]);
    // 这一次要换掉的那一章里原来的「埋」不算：第 5 章重拆、没再埋令牌，第 7 章就收不了。
    const [, r7] = t.resolvePlanEvents(fresh, [
      { no: 5, entries: [] },
      { no: 7, entries: [entry('', '收', { foreshadowing: '令牌' })] },
    ]);
    assert.deepEqual(r7.events, []);
  });

  test('解码：没写是 undefined、写成别的形状当空的；逐条校验；规范化的形状原样', () => {
    assert.deepEqual(t.decodePlanEntries(undefined, 3), { notes: [] });
    assert.deepEqual(t.decodePlanEntries('乱写', 3).entries, []);
    const r = t.decodePlanEntries([{ line: '甲', type: '埋', foreshadowing: '未归属的伏笔' }, { line: '甲', type: '埋', foreshadowing: '玉佩', resolve: 2 }], 3);
    assert.deepEqual(r.entries, [{ line: '甲', type: '埋', foreshadowing: '玉佩', what: '' }], '回收章不比本章晚的不要');
    assert.match(r.notes[0], /伏笔「未归属的伏笔」是保留名/);
    assert.deepEqual(t.planEntryJson({ line: '', type: '埋', foreshadowing: '玉佩', what: 'x', resolve: 9 }), {
      line: '',
      type: '埋',
      foreshadowing: '玉佩',
      what: 'x',
      resolve: 9,
    });
  });
});

// 复跑报告问题 3：第 11–15 章拆出来 12 条全是「推进」，到期该埋的 3 条一条也没排；补充实验里该收的漏了 1 条、也没写推迟。
describe('threadFile.ts · 拆细纲：到期却没安排的伏笔（复跑之后）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const main = line([ev(1, '推进'), ev(4, '埋', { foreshadowing: '井底的秘密' }), plan(14, '收', { foreshadowing: '镇子底下的骨头' })], {
    name: '灭门复仇',
    kind: '主线',
    relPath: 'm',
    foreshadowing: [
      { name: '阿婆的真实身份', what: '', plant: 5, resolve: 18 },
      { name: '无面鬼火的本质', what: '', plant: 9, resolve: 20 },
      { name: '井底的秘密', what: '', resolve: 13 },
      { name: '照骨镜的残片', what: '', resolve: 15 },
      { name: '镇子底下的骨头', what: '', resolve: 12 },
      { name: '还远着的', what: '', plant: 30, resolve: 40 },
    ],
  });
  main.events.push(ev(8, '埋', { foreshadowing: '镇子底下的骨头' }));
  const body = line([ev(1, '推进')], { name: '死僵化', kind: '人物线', relPath: 'b', index: 1, foreshadowing: [{ name: '尸斑的出现', what: '', plant: 12, resolve: 19 }] });
  const book = { threads: [main, body], unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [], events: [] } };
  const entry = (lineName, type, extra = {}) => ({ line: lineName, type, what: '', ...extra });
  const batch = (entriesOf) => [11, 12, 13, 15].map((no) => ({ no, entries: entriesOf(no) }));

  test('只排了推进：到期该埋的（这几章里的、早就过了的）、该收的都列出来；第 14 章原来的计划算安排过；还远的不算', () => {
    const due = t.unplannedDue(book, batch(() => [entry('灭门复仇', '推进')]));
    assert.deepEqual(due.map((u) => [u.name, u.line, u.need]), [
      ['阿婆的真实身份', '灭门复仇', ['埋']],
      ['无面鬼火的本质', '灭门复仇', ['埋']],
      ['井底的秘密', '灭门复仇', ['收']],
      ['照骨镜的残片', '灭门复仇', ['收']],
      ['尸斑的出现', '死僵化', ['埋']],
    ]);
    assert.deepEqual(due.map(t.describeUnplannedDue), [
      '〈阿婆的真实身份〉（计划第 5 章埋，还没埋）',
      '〈无面鬼火的本质〉（计划第 9 章埋，还没埋）',
      '〈井底的秘密〉（第 13 章前收）',
      '〈照骨镜的残片〉（第 15 章前收）',
      '〈尸斑的出现〉（计划第 12 章埋，还没埋）',
    ]);
  });

  test('安排了的、写明推迟的不算；没埋就收的被丢掉，照样算没安排', () => {
    const due = t.unplannedDue(
      book,
      batch((no) =>
        no === 11
          ? [entry('', '埋', { foreshadowing: '阿婆的真实身份' }), entry('', '收', { foreshadowing: '照骨镜的残片' }), entry('', '收', { foreshadowing: '井底的秘密' })]
          : no === 12
            ? [entry('灭门复仇', '推进', { what: '〈无面鬼火的本质〉推迟到第 22 章埋：先收拾红姑' }), entry('', '埋', { foreshadowing: '尸斑的出现' })]
            : []
      )
    );
    // 照骨镜的残片从没埋过：第 11 章的「收」被丢掉，还是没安排。
    assert.deepEqual(due.map((u) => [u.name, u.need]), [['照骨镜的残片', ['收']]]);
    assert.deepEqual(t.unplannedDue(book, []), []);
  });

  test('拆细纲那一层：回收章到了、还没埋的说「先埋再收」，前面排过「埋」的不说；该埋的说「本批要埋」', () => {
    const { foreshadowing } = t.plotThreads(
      { ...book, threads: [{ ...main, events: [...main.events, plan(10, '埋', { foreshadowing: '照骨镜的残片' })] }, body] },
      { from: 11, to: 15 }
    );
    const hint = (name) => foreshadowing.find((c) => c.name === name).why;
    assert.equal(hint('井底的秘密'), '本批要收，最晚第 13 章');
    assert.equal(hint('照骨镜的残片'), '本批要收，最晚第 15 章');
    assert.equal(hint('阿婆的真实身份'), '计划第 5 章埋，还没埋、第 18 章前收');
    assert.equal(hint('尸斑的出现'), '本批要埋，计划第 12 章、第 19 章前收');
    assert.equal(t.plotThreads(book, { from: 11, to: 15 }).foreshadowing.find((c) => c.name === '照骨镜的残片').why, '本批要收，最晚第 15 章，还没埋，先埋再收');
  });
});

describe('threadFile.ts · 写前检查要的数（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const main = line([ev(1, '推进'), ev(6, '推进'), plan(8, '关系')], { name: '青崖旧案', kind: '主线', relPath: 'm', index: 0, foreshadowing: [{ name: '玉佩', what: '', resolve: 5 }, { name: '名册', what: '' }] });
  main.events.push(plan(9, '收', { foreshadowing: '玉佩' }));
  const later = line([], { name: '还没开始', relPath: 'l', index: 1 });
  const closed = line([ev(2, '收束')], { name: '收了', relPath: 'c', index: 2, foreshadowing: [{ name: '收了线上的', what: '', resolve: 4 }] });
  const unfiled = { name: '未归属的伏笔', relPath: 'u', foreshadowing: [{ name: '提灯人', what: '', resolve: 3 }], events: [ev(2, '收', { foreshadowing: '提灯人' })] };
  const book = { threads: [main, later, closed], unfiled };

  test('线只算进行中的（带阈值与有计划事件的章）；伏笔只算没收、写了回收章的（带计划收它的章）', () => {
    assert.deepEqual(t.threadWatch(book), {
      lines: [{ name: '青崖旧案', kind: '主线', lastActive: 6, stall: 5, planned: [8, 9] }],
      foreshadowing: [
        { name: '玉佩', resolve: 5, planned: [9] },
        { name: '收了线上的', resolve: 4, planned: [] },
      ],
      unplanted: [],
    });
  });

  // 复跑之后的第三类提醒要的数：还是「计划」、写了计划埋的章的伏笔，带哪几章计划埋它；埋了的、收了的不算。
  test('还没埋的伏笔：状态「计划」、写了计划埋的章（带计划埋它的章）；按写到第 N 章时算', () => {
    const story = line([ev(1, '推进'), ev(6, '埋', { foreshadowing: '名册' }), plan(12, '埋', { foreshadowing: '影子' })], {
      name: '主线',
      kind: '主线',
      relPath: 'm',
      foreshadowing: [
        { name: '阿婆的身份', what: '', plant: 5, resolve: 18 },
        { name: '名册', what: '', plant: 3 },
        { name: '影子', what: '', plant: 10 },
        { name: '没写埋的章', what: '' },
      ],
    });
    const b = { threads: [story], unfiled: { name: '未归属的伏笔', relPath: 'u', foreshadowing: [], events: [] } };
    assert.deepEqual(t.threadWatch(b).unplanted, [
      { name: '阿婆的身份', plant: 5, planned: [] },
      { name: '影子', plant: 10, planned: [12] },
    ]);
    // 写第 6 章时名册还没埋（第 6 章那一次不算之前）。
    assert.deepEqual(t.threadWatch(b, 6).unplanted.map((f) => f.name), ['阿婆的身份', '名册', '影子']);
  });

  test('按写到第 N 章时算：之后的实际事件不算，计划照原样', () => {
    assert.deepEqual(t.threadWatch(book, 5).lines, [{ name: '青崖旧案', kind: '主线', lastActive: 1, stall: 5, planned: [8, 9] }]);
    // 写第 2 章时「收了」那条线还没收束，可它只有收束那一个事件（第 2 章）——那时还是计划中，不算进行中。
    assert.deepEqual(t.threadWatch(book, 2).lines.map((l) => l.name), ['青崖旧案']);
  });
});
