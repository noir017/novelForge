/**
 * 叙事线四段系统提示里，2026-10-21 真实模型试跑之后补上的几句（设计稿「实施状态（试跑之后的修复）」）。提示词的效果只能靠
 * 真实模型试，这里只钉住「这几句还在」：改提示词时别把它们抹掉。
 *
 * | 断言 | 试跑里看到的 |
 * |---|---|
 * | 认事件讲清什么算伏笔、什么不算；上限跟着常量走 | 22 条新伏笔多半是章末危机、本章已经揭开的事、普通情节 |
 * | 证据要直接写出这件事本身 | 证据句在正文里有，却和它要证明的事不沾边 |
 * | 当前进度只照抄【线】后面的名字 | 「名字（种类）」照抄回来，22 条只落盘 1 条 |
 * | 归并只有同一件事才并，同一个物件 / 同一个人身上的两件事不算 | 约一半并错 |
 * | 排线：有感情发展、成长或堕落弧线的分别排成感情线、人物线 | 没有感情线、漏了一条现成的人物线 |
 *
 * 2026-10-24 一份 80 多章真实工程的报告之后补的：
 *
 * | 断言 | 报告里看到的 |
 * |---|---|
 * | 当前进度按【人物】的性别写人称，原来写错的改过来；【人物】是写了性别的卡里的主角与出现过名字的人 | 女主角的当前进度一路写成「他」 |
 * | 认事件：只围着一件事转的线，那件事揭开了另报「收束」 | 第 7 章只报了「收〈伏笔〉」，线挂了「断了 75 章」 |
 * | 认事件：收束、放弃时把挂在线上的伏笔收掉或弃掉 | 「已收束 · 1 条伏笔没收」 |
 * | 认事件：什么不算新线（一章内的事、连着几章的同一场比试、路人闲聊），拿不准不报 | 路人一句闲聊、一场比试拆成两条都立成了线 |
 * | 认事件：收、弃未归属的伏笔时线名写它属于哪条线（程序据此挪过去） | 第 53 章埋下没挂上线，第 61 章导师揭开了，仍留在未归属里 |
 *
 * 2026-10-25 起改成转写（四段都按格式写自然语言，转写模型照各自的合同照抄成原来那份 JSON）：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 四段都不再要 JSON（没有「只输出一个 JSON 对象」、英文字段名），各有格式与示例 | 作者实测要模型直接出 JSON 写出来的东西更差 |
 * | 认事件：证据用「」引出正文原句 | 转写照抄，之后照旧由 verifyFinds 对正文逐字核 |
 * | 四份转写合同：形状正好是原来解码认的那一份，种类 / 类型怎么对、证据一个字都不能改 | 解码一行没改 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mod = () => loadModule('src/core/features/threadsPrompt.ts');
const tf = () => loadModule('src/core/model/threadFile.ts');

describe('threadsPrompt.ts · 试跑之后补上的几句', () => {
  test('认事件：什么算伏笔、什么不算；证据要直接写出这件事；上限跟着常量走（新伏笔 3 条）', () => {
    const { THREAD_FIND_SYSTEM } = mod();
    for (const s of [
      '读者看见了、还没得到解释或交代、后文要回收的线索、疑问或承诺',
      '章末悬念、章末的危机（那是看点',
      '本章内已经揭开、交代清楚的事（揭开的是给出的伏笔，就报一条「收」）',
      '单纯发生了的事件',
      '证据必须直接写出这件事本身',
      '「他」不要换成人名',
      '给出的伏笔已经埋下的不要再报「埋」',
      // 复跑之后：「计划」状态的伏笔第 1 章就被报了「收」。
      '还没埋下的伏笔不能直接报「收」「弃」',
    ]) {
      assert.ok(THREAD_FIND_SYSTEM.includes(s), s);
    }
    const { FINALIZE_EVENT_LIMIT, FINALIZE_NEW_THREAD_LIMIT, FINALIZE_NEW_FORESHADOW_LIMIT } = tf();
    assert.equal(FINALIZE_NEW_FORESHADOW_LIMIT, 3);
    assert.ok(
      THREAD_FIND_SYSTEM.includes(`事件最多 ${FINALIZE_EVENT_LIMIT} 条，新线最多 ${FINALIZE_NEW_THREAD_LIMIT} 条，新伏笔最多 3 条`),
      THREAD_FIND_SYSTEM.slice(-80)
    );
  });

  test('当前进度：线名只照抄【线】后面的名字，不带种类', () => {
    const { THREAD_PROGRESS_SYSTEM } = mod();
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('每条线以「【线】线名」开头'));
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('线名只照抄【线】后面那个名字，一字不改：不带种类，不加括号、引号或别的字'));
  });

  test('认事件：线的事揭开了就收束；收束时收掉或弃掉挂在线上的伏笔；什么不算新线', () => {
    const { THREAD_FIND_SYSTEM } = mod();
    for (const s of [
      '那件事在本章揭开了，线也就走完了：「收」那条伏笔之外，另报一条「收束」',
      '报一条线「收束」「放弃」时，把【还没收的伏笔】里挂在这条线上的逐条看一遍',
      '正文让它跟着这条线一起作废了的（例如那一整段经历原来是幻觉）报「弃」',
      '什么算新线：一件要跨很多章才走得完的事',
      '一章之内就开始又结束的事',
      '换了人上场也还是同一件事',
      '路人、龙套的闲聊',
      '拿不准是不是新线，就不要报',
      '收、弃一条挂在「未归属的伏笔」上的伏笔时，线名写它在本章揭开时属于给出的哪一条线',
    ]) {
      assert.ok(THREAD_FIND_SYSTEM.includes(s), s);
    }
  });

  test('当前进度：人称照【人物】的性别写，原来写错的改过来', () => {
    const { THREAD_PROGRESS_SYSTEM } = mod();
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('人称照那里写的性别：女的用「她」，男的用「他」；原来的当前进度里用错了的，这一次改过来'));
  });

  test('归并：只有确实是同一件事才并；同一个物件、同一个人身上的两件事不算；拿不准不并', () => {
    const { THREAD_MERGE_SYSTEM } = mod();
    for (const s of ['只有确实是同一件事、同一条线，才并进已有的那一条', '同一个物件、同一个人身上的两件事不算同一件事', '拿不准就不要并', '两条共同指向的那一个谜底或那一件事']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
    // 复跑之后：并错的两次理由都是「两者均指……」——同一类，不是同一件事。
    for (const s of ['只是同一类的不算', '理由必须说出两条共同指向的那一个谜底或那一件事', '「两者均指向……」这种同一类的，就是不该并']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
  });

  test('排线：有感情发展、成长或堕落弧线的分别排成感情线、人物线，没有就不凑数', () => {
    const { threadPlanSystem } = mod();
    assert.ok(threadPlanSystem(30, false).includes('故事里有感情发展、主角明显的成长或堕落弧线的，分别排成感情线、人物线；没有就不凑数。'));
  });
});

describe('threadsPrompt.ts · 2026-10-25 起按格式写、转写成 JSON', () => {
  const systems = () => {
    const m = mod();
    return { 排线: m.threadPlanSystem(30, false), 认事件: m.THREAD_FIND_SYSTEM, 当前进度: m.THREAD_PROGRESS_SYSTEM, 归并: m.THREAD_MERGE_SYSTEM };
  };

  test('四段都不再要 JSON：没有 JSON 形状与英文字段名，各有【输出格式】与【格式示例】、说不写 JSON', () => {
    for (const [name, s] of Object.entries(systems())) {
      assert.ok(!s.includes('只输出一个 JSON 对象') && !s.includes('{"') && !/"(?:threads|events|progress|merges)"/.test(s), `${name}：${s.slice(0, 400)}`);
      assert.ok(s.includes('【输出格式】') && s.includes('【格式示例】') && s.includes('不写 JSON'), name);
    }
  });

  test('排线：一条线一段「## 线名」，种类、章节、意图、伏笔（第 N 章埋，第 M 章前收）；章号范围跟着总章数', () => {
    const s = mod().threadPlanSystem(30, true);
    for (const x of ['以「## 线名」开头', '种类：主线、支线、感情线、人物线之一', '写成「第 3 章—第 40 章」', '（第 N 章埋，第 M 章前收）', '1–30 之间的整数', '已经有了，这一次不要再排主线', '每条线最多 5 条伏笔']) {
      assert.ok(s.includes(x), x);
    }
  });

  test('认事件：三节「## 事件」「## 新线」「## 新伏笔」，一条一行「类型｜线名：……。证据：「正文原句」」，证据用「」引起来', () => {
    const s = mod().THREAD_FIND_SYSTEM;
    for (const x of ['「## 事件」「## 新线」「## 新伏笔」', '「类型｜线名：发生了什么。证据：「正文原句」」', '「埋〈伏笔名〉」', '证据一律用「」引起来', '哪一节没有就写「无」']) {
      assert.ok(s.includes(x), x);
    }
  });

  test('当前进度一段「【线】线名」「当前进度：……」；归并一行「新 → 已有：理由」，一条都不并写「无」', () => {
    const m = mod();
    assert.ok(m.THREAD_PROGRESS_SYSTEM.includes('第一行「【线】线名」，第二行「当前进度：……」（150 字以内）'));
    assert.ok(m.THREAD_MERGE_SYSTEM.includes('「新认出的名字 → 已有的名字：两条共同指向的那一个谜底或那一件事」'));
    assert.ok(m.THREAD_MERGE_SYSTEM.includes('一条都不该并就只写「无」'));
  });

  test('四份转写合同：形状是原来那一份；种类、类型只能是那几个词；证据一个字都不能改；文字照抄', () => {
    const m = mod();
    const plan = m.threadPlanJsonContract();
    assert.ok(plan.includes('{"threads":[{"title":"…","kind":"感情线","from":3,"to":18,"intent":"…","foreshadowing":[{"title":"…","what":"…","plant":3,"resolve":18}]}]}'), plan);
    assert.ok(plan.includes('只能是主线、支线、感情线、人物线这四个词之一'), plan);
    const find = m.threadFindJsonContract();
    assert.ok(find.includes('{"events":[...],"newThreads":[...],"newForeshadowing":[...]}') && find.includes('只能是推进、关系、收束、放弃、埋、收、弃之一'), find);
    assert.ok(find.includes('不带最外面那一对「」；一个字都不能改、不能补、不能删'), find);
    assert.ok(m.threadProgressJsonContract().includes('{"progress":[{"line":"…","text":"…"}]}'));
    assert.ok(m.threadMergeJsonContract().includes('{"merges":[{"new":"…","into":"…","reason":"…"}]}'));
    for (const c of [plan, find, m.threadProgressJsonContract(), m.threadMergeJsonContract()]) {
      assert.ok(c.includes('文字一律从原文照抄：不改写、不总结、不润色') && c.includes('写「无」或没有这一项的：文字给 ""，列表给 []'), c);
    }
  });
});

describe('threads.ts · 当前进度的【人物】', () => {
  const card = (name, extra = {}) => ({ name, aliases: [], tags: [], sections: {}, ...extra });
  const people = (cards, text) => loadModule('src/core/features/threads.ts').progressPeople(cards, text);

  test('写了性别的：主角在前（名字没出现也在），其余名字或别名出现过才列；带别名', () => {
    const cards = [
      card('沈青', { gender: '男' }),
      card('林昭', { gender: '女', tags: ['主角'], aliases: ['小昭'] }),
      card('李叔', { gender: '男' }),
      card('阿婆', { aliases: ['婆婆'] }),
      card('柳', { gender: '女' }),
    ];
    const text = '【线】沈家旧案\n原来的当前进度：读者已知他已身处局内，婆婆不肯说，柳树下埋着东西。';
    assert.deepEqual(people(cards, text), ['- 林昭（女；又称 小昭）']);
    assert.deepEqual(people(cards, `${text}沈青追问李叔。`), ['- 林昭（女；又称 小昭）', '- 沈青（男）', '- 李叔（男）']);
    assert.deepEqual(people([], text), []);
  });
});
