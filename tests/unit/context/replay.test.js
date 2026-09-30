/**
 * 重演检测（context/replay.ts）：新写的一章开头，是不是把上一章结尾又演了一遍。
 *
 * 判法移植自 AI-Novel-Writer：两边归一后按 8 字 n-gram 比对，新稿前 1200 字里**连续覆盖
 * ≥ 80 字**才算。这组用例钉住三件事：
 *
 * 1. 真重演（整段搬过来、只改了标点空白）一定报；
 * 2. 零星撞词、刻意呼应的一句台词不报——否则卡片天天标红，作者很快就不看了；
 * 3. 报出来的 `quote` 是新稿里的原文（带标点），作者一眼认得出是哪一段。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const replay = loadModule('src/core/context/replay.ts');

/** 上一章结尾：一段足够长、互不重复的叙述。 */
const PREV = [
  '雪下到半夜才停。林昭把残令揣进怀里，沿着河堤往回走，脚下的冰壳一踩就碎。',
  '客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空，半晌才说了一句：“李叔来过，问你去了哪里。”',
  '林昭没有答话，只把湿透的斗篷挂在门后，从灶上端下那碗早就凉了的姜汤，一口一口喝完。',
].join('\n\n');

describe('replay · 判重演', () => {
  test('新稿开头整段搬了上一章结尾（标点与空白改过）→ 命中', () => {
    // 第二、三两段连着搬过来：一段只有五十来字，够不上 80 字的门槛。
    const moved = PREV.split('\n\n').slice(1).join('\n').replace(/，/g, ',').replace(/。/g, '. ');
    const draft = `${moved}\n\n天亮之后，他去了镇东的井边，那里围着一圈人，谁也不说话。`;
    const v = replay.detectReplay(PREV, draft);
    assert.equal(v.hit, true);
    assert.ok(v.run >= replay.REPLAY_RUN, String(v.run));
    // 给作者看的是新稿里的原文，不是归一之后的那串字。
    assert.ok(draft.includes(v.quote), v.quote);
    assert.match(v.quote, /沈氏坐在柜台后面/);
  });

  test('只撞了几个词（人名、地名）→ 不命中', () => {
    const draft =
      '林昭一早就出了客栈。沈氏在后院劈柴，没有抬头看他。镇东的井边围着一圈人，李叔站在最前面，手里攥着一截烧黑的木头。';
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('刻意呼应一句台词（不到 80 字）→ 不命中', () => {
    const draft = `“李叔来过，问你去了哪里。”这句话他在心里又过了一遍，然后推开了井边那扇门。门后面是一段向下的石阶，潮气扑面而来。`;
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('重演出在 1200 字之后 → 不判（只查开头）', () => {
    const lead = '他走了很久。'.repeat(220); // 1320 字，把重演推到 1200 之外
    const draft = `${lead}${PREV.split('\n\n')[1]}`;
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('任一边太短 → 不判，不抛', () => {
    assert.deepEqual(replay.detectReplay('', '随便什么'), { hit: false });
    assert.deepEqual(replay.detectReplay(PREV, '短。'), { hit: false });
    assert.deepEqual(replay.detectReplay('雪。', PREV), { hit: false });
  });

  test('全角半角、大小写差异照样认得出（NFKC + 小写）', () => {
    const body = '公司的招牌在雨里晃了一整夜，楼下的保安换了三拨，谁也说不清那辆黑车是几点开走的，只记得车牌尾号是七七三，车窗上贴着一张褪色的通行证，副驾驶座上放着半包没拆的烟和一把折断的伞。';
    const prev = `ＡＢＣ${body}`;
    const draft = `abc${body}\n\n第二天一早，警察来了。`;
    assert.equal(replay.detectReplay(prev, draft).hit, true);
  });
});

describe('replay · 上一章结尾', () => {
  test('不长就原样', () => {
    assert.equal(replay.previousEnding('  一句话。  '), '一句话。');
  });

  test('长了取最后约 1000 字，开头对齐到句子边界', () => {
    const long = `${'前面的事。'.repeat(300)}最后一句在这里。`;
    const end = replay.previousEnding(long);
    assert.ok(end.length <= replay.PREVIOUS_ENDING_CHARS, String(end.length));
    assert.ok(end.endsWith('最后一句在这里。'));
    // 从句子开头起，不从半句「的事。」起。
    assert.ok(end.startsWith('前面的事。'), end.slice(0, 10));
  });
});
