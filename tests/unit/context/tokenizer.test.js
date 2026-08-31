/**
 * token 估算与按预算截取。迁自 scripts/smoke.js 的 `== tokenizer.ts ==` 一节。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

describe('tokenizer.ts', () => {
  let tk;
  let text;

  before(() => {
    tk = loadModule('src/core/context/tokenizer.ts');
    // 取一段真实正文（`manuscripts/` 是工具写出来的产物，也是装配器实际
    // 要按预算截的那一份），而不是 chapters/ 里作者切好的发布章节。
    text = fs.readFileSync(path.join(SAMPLE, 'chapters/002-客栈里的女人.md'), 'utf8');
  });

  test('空串为 0', () => {
    assert.equal(tk.estimateTokens(''), 0);
  });

  // 默认口径 1 token/字。从前是 1.5——那是 GPT-3 时代字节级 BPE 的数，
  // 如今各家中文词表下都在 0.6~1.0 之间，1.5 等于把窗口白扔三分之一。
  test('中文按 1 token/字估算', () => {
    assert.equal(tk.estimateTokens('雨下了三天'), 5);
  });

  test('英文按 4 字符估算', () => {
    assert.equal(tk.estimateTokens('abcdefgh'), 2);
  });

  test('中文估算低于同字数的旧口径（1.5x）', () => {
    assert.ok(tk.estimateTokens('雨下了三天') < Math.ceil(5 * 1.5));
  });

  test('中文估算高于英文同长度', () => {
    assert.ok(tk.estimateTokens('一二三四') > tk.estimateTokens('abcd'));
  });

  test('示例正文 token 数量级合理（500~2000）', () => {
    const full = tk.estimateTokens(text);
    assert.ok(full > 500 && full < 2000, `got ${full}`);
  });

  describe('takeTail', () => {
    test('takeTail 不超预算', () => {
      const tail = tk.takeTail(text, 100);
      assert.ok(tk.estimateTokens(tail) <= 100, `got ${tk.estimateTokens(tail)}`);
    });

    test('takeTail 取的是结尾', () => {
      const tail = tk.takeTail(text, 100);
      assert.ok(text.trimEnd().endsWith(tail.trimEnd().slice(-20)));
    });

    test('takeTail 不足预算时原样返回', () => {
      assert.equal(tk.takeTail('短文本', 1000), '短文本');
    });
  });

  describe('takeHead', () => {
    test('takeHead 带截断标记', () => {
      // 不静默截断：降级/丢弃必须留下痕迹。
      assert.ok(tk.takeHead(text, 100).includes('因上下文预算截断'));
    });

    test('takeHead 取的是开头', () => {
      assert.ok(tk.takeHead(text, 100).startsWith(text.slice(0, 40)));
    });

    test('takeHead 不足预算时原样返回', () => {
      assert.equal(tk.takeHead('短文本', 1000), '短文本');
    });

    // 从前是「按预算切满，再把标记接上去」，于是结果必然超出十几个 token，
    // 调用方只好自己减一个魔数来兜。标记的开销现在算在预算之内。
    test('takeHead 连截断标记一起不超预算', () => {
      for (const cap of [60, 100, 300, 800]) {
        assert.ok(tk.estimateTokens(tk.takeHead(text, cap)) <= cap, `cap=${cap}`);
      }
    });

    test('预算小到连标记都放不下时给空串，而不是只剩一行标记', () => {
      assert.equal(tk.takeHead(text, 3), '');
    });
  });

  // 截断的边界从前是「按最贵的中文系数反推字符数」，一段英文因此只拿到它
  // 实际能放的四分之一。现在是拿计数器本身二分出来的，多长算多长。
  describe('截断卡在预算上，而不是按系数反推', () => {
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(200);

    test('英文截断后确实用满了预算', () => {
      const head = tk.takeHead(english, 400);
      const used = tk.estimateTokens(head);
      assert.ok(used <= 400 && used > 400 * 0.8, `用了 ${used}/400`);
    });

    test('中文截断后也用满了预算', () => {
      const head = tk.takeHead(text.repeat(4), 400);
      const used = tk.estimateTokens(head);
      assert.ok(used <= 400 && used > 400 * 0.8, `用了 ${used}/400`);
    });

    test('takeTail 一个字都放不下时给空串（不能把整段原样还回来）', () => {
      // `text.slice(-0)` 是整段文本——这条挡的就是那个坑。
      assert.equal(tk.takeTail(text, 1), '');
    });

    test('emoji 不会被从中间劈开', () => {
      const emoji = '🌧️🌂☔🌩️'.repeat(50);
      const head = tk.takeHead(emoji, 40);
      assert.ok(!/[\uD800-\uDBFF]$/.test(head.replace(/\n……（此处因上下文预算截断）$/, '')));
    });
  });

  // 一次请求的输入不只是各条 content 之和：工具调用的参数、思考凭据、
  // 每条消息的协议开销都占同一个窗口。
  describe('estimateMessagesTokens / estimateToolsTokens', () => {
    test('工具调用的参数算进去了', () => {
      const args = { path: 'chapters/001.md', content: '雨下了三天。'.repeat(200) };
      const withCall = tk.estimateMessagesTokens([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'write', args, raw: JSON.stringify(args) }],
        },
      ]);
      // content 是空的：只数 content 的话这条消息几乎不占地方。
      assert.ok(withCall > 800, `got ${withCall}`);
    });

    test('思考凭据算进去了（下一轮要原样交回去）', () => {
      const base = [{ role: 'assistant', content: '好的' }];
      const withTrace = [
        { role: 'assistant', content: '好的', traces: [{ kind: 'anthropic', payload: { text: '想'.repeat(500) } }] },
      ];
      assert.ok(tk.estimateMessagesTokens(withTrace) > tk.estimateMessagesTokens(base) + 400);
    });

    test('每条消息都带一份协议开销', () => {
      const one = tk.estimateMessagesTokens([{ role: 'user', content: '在' }]);
      const three = tk.estimateMessagesTokens([
        { role: 'user', content: '在' },
        { role: 'user', content: '在' },
        { role: 'user', content: '在' },
      ]);
      assert.ok(three > one * 2, `${one} → ${three}`);
    });

    test('循环引用不带崩计数', () => {
      const args = {};
      args.self = args;
      assert.ok(
        tk.estimateMessagesTokens([
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'write', args, raw: '' }] },
        ]) > 0
      );
    });

    test('工具声明也要花 token', () => {
      const specs = [
        { name: 'write', description: '写盘', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ];
      assert.ok(tk.estimateToolsTokens(specs) > 10);
      assert.equal(tk.estimateToolsTokens([]), 0);
      assert.equal(tk.estimateToolsTokens(undefined), 0);
    });
  });
});
