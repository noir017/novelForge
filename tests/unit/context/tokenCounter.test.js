/**
 * 可替换的 token 计数器：注册/切换、`prepare` 抛错时不带崩、用量校准统计。
 * 迁自 scripts/smoke.js 的 `== tokenCounter.ts · 可替换实现 ==` 一节。
 *
 * 这一节改的是模块级单例，用例之间有先后依赖——node:test 同文件内默认串行执行，
 * 顺序与迁移前一致。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('tokenCounter.ts · 可替换实现', () => {
  let tc;
  /** 切换计数器之前，默认实现对同一段文本给出的结果，供「切回来」时比对。 */
  let before默认;
  // 探针里带一段英文：纯中文在默认口径下正好是 1 token/字，与「一个字符一个
  // token」的假计数器撞上，切没切过去就看不出来了。
  const PROBE = '雨下了三天 abcdefgh';

  before(() => {
    tc = loadModule('src/core/context/tokenCounter.ts');
  });

  describe('默认实现', () => {
    test('默认计数器是启发式的', () => {
      assert.equal(tc.activeTokenCounter().id, 'heuristic');
    });

    test('默认计数器自述为估算', () => {
      assert.equal(tc.activeTokenCounter().accuracy, 'estimate');
    });

    test('注册表里有默认实现', () => {
      assert.ok(tc.listTokenCounters().some((c) => c.id === 'heuristic'));
    });
  });

  describe('注册与切换', () => {
    let prepared = 0;

    before(() => {
      before默认 = tc.countTokens(PROBE);
      // 注册一个「一个字符一个 token」的假计数器，验证切换真的生效。
      tc.registerTokenCounter({
        id: 'test-exact',
        label: '测试用',
        accuracy: 'exact',
        prepare: async () => { prepared++; },
        count: (t) => t.length,
        charsFor: (n) => n,
      });
    });

    test('注册后出现在列表里', () => {
      assert.ok(tc.listTokenCounters().some((c) => c.id === 'test-exact'));
    });

    test('切换成功', async () => {
      assert.equal(await tc.useTokenCounter('test-exact'), true);
    });

    test('prepare 被调用一次', () => {
      assert.equal(prepared, 1);
    });

    test('切换后计数走新实现', () => {
      assert.equal(tc.countTokens(PROBE), PROBE.length);
    });

    test('切换后反推字符数也走新实现', () => {
      assert.equal(tc.charsForTokens(100), 100);
    });

    test('新旧实现给出不同结果（确实切了）', () => {
      assert.notEqual(before默认, tc.countTokens(PROBE));
    });
  });

  describe('计数器坏掉不能让写作流程停下', () => {
    before(() => {
      tc.registerTokenCounter({
        id: 'test-broken',
        label: '坏的',
        accuracy: 'exact',
        prepare: async () => { throw new Error('加载失败'); },
        count: () => 0,
        charsFor: () => 0,
      });
    });

    test('prepare 抛错时切换失败而非抛出', async () => {
      assert.equal(await tc.useTokenCounter('test-broken'), false);
    });

    test('切换失败后仍用原计数器', () => {
      assert.equal(tc.activeTokenCounter().id, 'test-exact');
    });

    test('未注册的 id 返回 false', async () => {
      assert.equal(await tc.useTokenCounter('不存在'), false);
    });
  });

  describe('reset', () => {
    before(() => {
      tc.resetTokenCounter();
    });

    test('reset 回到默认实现', () => {
      assert.equal(tc.activeTokenCounter().id, 'heuristic');
    });

    test('reset 后计数恢复', () => {
      assert.equal(tc.countTokens(PROBE), before默认);
    });
  });

  // 这一节是「token 数不准」那次修的三处系统性偏差，各钉一条。
  describe('启发式口径', () => {
    let h;

    before(() => {
      tc.resetTokenCounter();
      h = new tc.HeuristicTokenCounter();
    });

    test('中文按 1 token/字（默认口径）', () => {
      assert.equal(h.count('雨下了三天'), 5);
    });

    // 全角逗号是 U+FF0C，不在 U+3000–303F 里。从前它落进「其他」按 1/3 算，
    // 中文正文里一成多的字符就这么被少算了。
    test('全角标点跟着中文算，不落进「其他」', () => {
      assert.equal(h.count('雨，下，了，'), 6);
    });

    test('扩展 B 的生僻字也认得（代理对不按 emoji 算）', () => {
      assert.equal(h.count('\u{20000}\u{20001}'), 2);
    });

    // 英文按词算：词间那个空格并进后面那个词，不再单收一份。
    test('英文约每 4 字符 1 token，空格不另计', () => {
      const text = 'the quick brown fox jumps over the lazy dog';
      const n = h.count(text);
      assert.ok(n >= 9 && n <= 12, `got ${n}（9 个词，约 11 token）`);
    });

    test('短词至少 1 token', () => {
      assert.equal(h.count('a'), 1);
    });

    // ≤3 位的数字各家都并成一个 token，不是逐位折算。
    test('数字按段算', () => {
      assert.equal(h.count('2026'), 2);
    });

    test('空串为 0', () => {
      assert.equal(h.count(''), 0);
    });

    test('各档口径对中文给出不同的数', () => {
      const text = '雨下了三天，屋檐下的水线连成一片。';
      const gpt = new tc.HeuristicTokenCounter(tc.TOKEN_PROFILES.gpt).count(text);
      const cjk = new tc.HeuristicTokenCounter(tc.TOKEN_PROFILES.cjkNative).count(text);
      assert.ok(cjk < gpt && gpt < h.count(text), `${cjk} < ${gpt} < ${h.count(text)}`);
    });

    test('几档口径都注册进了注册表', () => {
      const ids = tc.listTokenCounters().map((c) => c.id);
      assert.ok(['heuristic', 'heuristic-gpt', 'heuristic-claude', 'heuristic-cjk'].every((id) => ids.includes(id)));
    });
  });

  describe('校准回路：只收真实用量，不拿估算冒充', () => {
    before(() => {
      tc.resetUsageStats();
    });

    test('没有样本时比值为 1', () => {
      assert.equal(tc.usageStats().ratio, 1);
    });

    test('记下一个样本', () => {
      tc.recordUsage('续写', 1200, { inputTokens: 1000, outputTokens: 500 });
      assert.equal(tc.usageStats().samples, 1);
    });

    test('比值 = 估算/实测', () => {
      assert.ok(Math.abs(tc.usageStats().ratio - 1.2) < 1e-9, String(tc.usageStats().ratio));
    });

    test('输出 token 累计', () => {
      assert.equal(tc.usageStats().outputTotal, 500);
    });

    // 服务商没给 usage 时什么都不记——否则比值会被污染成 1。
    test('没有 inputTokens 则不计样本', () => {
      tc.recordUsage('摘要', 800, {});
      assert.equal(tc.usageStats().samples, 1);
    });

    test('只有输出时不计输入样本', () => {
      tc.recordUsage('摘要', 800, { outputTokens: 200 });
      assert.equal(tc.usageStats().samples, 1);
    });

    test('但输出仍累计', () => {
      assert.equal(tc.usageStats().outputTotal, 700);
    });

    test('describeUsage 报出实测与偏差', () => {
      const note = tc.describeUsage(1200, { inputTokens: 1000, outputTokens: 500 });
      assert.ok(note.includes('实测 1000') && note.includes('+20%'), note);
    });

    test('没有用量时 describeUsage 为空', () => {
      assert.equal(tc.describeUsage(1200, {}), undefined);
      tc.resetUsageStats();
    });
  });
});
