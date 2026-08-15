/**
 * 摘要解析的三层降级：JSON → Markdown 小节 → 全文进梗概。
 * 迁自 scripts/smoke.js 的 `== summarize.ts · parseSummaryResponse ==` 一节。
 *
 * 这三层是硬约束：解析失败等于这一章的剧情永远进不了上下文。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

const JSON_REPLY = JSON.stringify({
  梗概: '林昭进镇。',
  出场人物: [{ name: '林昭', aliases: ['阿昭'] }, { name: '李叔', aliases: [] }],
  时间地点: '傍晚，镇口',
  关键事件: ['递上令牌', '掌柜多看了他两眼'],
  新增伏笔: ['令牌来历'],
  状态变更: '',
});

const STANDARD_MD = `## 梗概\n\n林昭进镇。\n\n## 出场人物\n\n林昭、李叔\n\n## 时间地点\n\n傍晚，镇口\n\n## 关键事件\n\n- 递上令牌\n\n## 新增伏笔\n\n令牌来历\n\n## 状态变更\n\n无`;

describe('summarize.ts · parseSummaryResponse', () => {
  let sum;
  before(() => {
    sum = loadModule('src/core/features/summarize.ts');
  });

  describe('第一层：JSON 路径（现在的提示词要求的形状）', () => {
    let j;
    before(() => {
      j = sum.parseSummaryResponse(JSON_REPLY);
    });

    test('JSON：解析梗概', () => {
      assert.equal(j.sections.梗概, '林昭进镇。');
    });

    test('JSON：数组小节渲染成列表', () => {
      assert.equal(j.sections.关键事件, '- 递上令牌\n- 掌柜多看了他两眼');
    });

    test('JSON：空字段为空串而非「无」', () => {
      assert.equal(j.sections.状态变更, '');
    });

    test('JSON：出场人物结构化', () => {
      assert.equal(j.cast.length, 2, JSON.stringify(j.cast));
      assert.equal(j.cast[0].name, '林昭', JSON.stringify(j.cast));
    });

    test('JSON：保留 cast 别名', () => {
      assert.equal(j.cast[0].aliases[0], '阿昭');
    });

    // 出场人物小节从 cast 渲染回来，两者始终一致。
    test('JSON：出场人物小节由 cast 渲染', () => {
      assert.equal(j.sections.出场人物, '林昭(阿昭)、李叔');
    });

    test('JSON：代码块包裹', () => {
      assert.equal(sum.parseSummaryResponse('```json\n' + JSON_REPLY + '\n```').sections.梗概, '林昭进镇。');
    });

    test('JSON：前后有废话', () => {
      assert.equal(sum.parseSummaryResponse('好的：\n' + JSON_REPLY + '\n以上。').cast.length, 2);
    });

    // 出场人物写成字符串（模型没照做）也要收下。
    test('JSON：出场人物写成字符串也解析', () => {
      const loose = sum.parseSummaryResponse('{"梗概":"x","出场人物":"林昭、沈氏","关键事件":[]}');
      assert.equal(loose.cast.length, 2, JSON.stringify(loose.cast));
      assert.equal(loose.cast[1].name, '沈氏', JSON.stringify(loose.cast));
    });

    // 语法合法但不相干的 JSON 不能被认成一份（空的）摘要——认下来就不会再降级，
    // 结果是静默写出一份没有内容的摘要文件。降级后走小节解析，最终全文进梗概。
    test('JSON：不相干的 JSON 不被当成摘要', () => {
      const irrelevant = sum.parseSummaryResponse('{"text":"模型答非所问"}');
      assert.ok(irrelevant.sections.梗概.includes('模型答非所问'), irrelevant.sections.梗概);
    });

    // 同上：模型把六小节写成 markdown 但外面裹了个 JSON 壳时，仍要拿到小节。
    test('JSON：壳外的小节仍能解析', () => {
      const wrapped = sum.parseSummaryResponse('{"summary": "x"}\n\n## 梗概\n\n林昭进镇。\n\n## 关键事件\n\n- 递上令牌');
      assert.equal(wrapped.sections.梗概, '林昭进镇。');
    });
  });

  describe('第二层：Markdown 降级（旧格式 / 模型不听话 / 作者手改）', () => {
    let parsed;
    before(() => {
      parsed = sum.parseSummaryResponse(STANDARD_MD);
    });

    test('降级：解析标准六小节', () => {
      assert.equal(parsed.sections.梗概, '林昭进镇。');
      assert.equal(parsed.sections.出场人物, '林昭、李叔');
    });

    test('降级：关键事件保留列表', () => {
      assert.equal(parsed.sections.关键事件, '- 递上令牌');
    });

    // 没有结构化 cast 时从「出场人物」小节文本反解，角色页不该因此少人。
    test('降级：从小节文本反解出场人物', () => {
      assert.equal(parsed.cast.length, 2, JSON.stringify(parsed.cast));
      assert.equal(parsed.cast[0].name, '林昭', JSON.stringify(parsed.cast));
    });

    test('降级：剥离代码块围栏', () => {
      assert.equal(sum.parseSummaryResponse('```markdown\n' + STANDARD_MD + '\n```').sections.梗概, '林昭进镇。');
    });

    test('降级：行内写法兜底', () => {
      const inline = sum.parseSummaryResponse('梗概：林昭进镇。\n出场人物：林昭、李叔\n关键事件：递上令牌');
      assert.equal(inline.sections.梗概, '林昭进镇。');
      assert.equal(inline.sections.出场人物, '林昭、李叔');
    });

    test('降级：加粗行内写法兜底', () => {
      assert.equal(sum.parseSummaryResponse('**梗概**：林昭进镇。\n**出场人物**：林昭').sections.梗概, '林昭进镇。');
    });
  });

  describe('第三层：全文进梗概', () => {
    test('降级：完全无结构时全文进梗概', () => {
      assert.equal(
        sum.parseSummaryResponse('模型胡说了一通完全没有结构的内容。').sections.梗概,
        '模型胡说了一通完全没有结构的内容。'
      );
    });

    test('降级：无结构时 cast 为空', () => {
      assert.equal(sum.parseSummaryResponse('模型胡说了一通完全没有结构的内容。').cast.length, 0);
    });

    // 「无」这类占位不是人名。
    test('降级：出场人物写「无」不产生假人', () => {
      assert.equal(sum.parseSummaryResponse('## 梗概\n\nx\n\n## 出场人物\n\n无').cast.length, 0);
    });
  });

  describe('真实示例摘要文件', () => {
    let realParsed;
    before(() => {
      const real = fs.readFileSync(path.join(SAMPLE, '.novelforge/summaries/002-客栈里的女人.md'), 'utf8');
      const md = loadModule('src/core/model/markdown.ts');
      realParsed = sum.parseSummaryResponse(md.parseMarkdown(real).body);
    });

    test('解析真实摘要文件', () => {
      assert.ok(realParsed.sections.出场人物.includes('沈氏'), realParsed.sections.出场人物);
    });

    test('真实摘要的未收伏笔非空', () => {
      assert.ok(realParsed.sections.新增伏笔.length > 10);
    });

    test('真实摘要能反解出出场人物', () => {
      assert.ok(realParsed.cast.some((c) => c.name === '沈氏'), JSON.stringify(realParsed.cast));
    });
  });
});
