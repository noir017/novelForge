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

  test('当前进度：line 只照抄【线】后面的名字，不带种类', () => {
    const { THREAD_PROGRESS_SYSTEM } = mod();
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('每条线以「【线】线名」开头'));
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('line 只照抄【线】后面那个名字，一字不改：不带种类，不加括号、引号或别的字'));
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
    for (const s of ['只有确实是同一件事、同一条线，才并进已有的那一条', '同一个物件、同一个人身上的两件事不算同一件事', '拿不准就不要并', '"reason"']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
    // 复跑之后：并错的两次理由都是「两者均指……」——同一类，不是同一件事。
    for (const s of ['只是同一类的不算', 'reason 必须说出两条共同指向的那一个谜底或那一件事', '「两者均指向……」这种同一类的，就是不该并']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
  });

  test('排线：有感情发展、成长或堕落弧线的分别排成感情线、人物线，没有就不凑数', () => {
    const { threadPlanSystem } = mod();
    assert.ok(threadPlanSystem(30, false).includes('故事里有感情发展、主角明显的成长或堕落弧线的，分别排成感情线、人物线；没有就不凑数。'));
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
