/**
 * 模型每一轮都读的文字里，不许再有旧链路的说法。
 *
 * 卷、剧情段、中转站、拆章随一期重构从代码里删掉了，但工具描述是字符串——删代码不会让它
 * 编译不过，也没有哪条行为测试会因为一句过时的说明变红。而模型是照着这些字去找路径、
 * 填参数的：`list` 的说明里写着「卷纲在 .novelforge/volumes/」，它就会去列一个不存在的
 * 目录；`search` 的说明里写着 `kinds=volume`，它填进去会被静默丢掉、变成不限种类的搜索。
 *
 * 只查模型读得到的那几处：每个工具的 `description`、每个参数的说明与枚举值、MCP 回给
 * 外部 agent 的 `instructions`。代码注释与 README 里讲「从前……、为什么删掉」的历史说明是有意的，不在这里。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../helpers/load');

/** 旧链路的说法。「卷」单列：它只在作为一个词出现时算（「卷入」「试卷」不算）。 */
const STALE = ['中转站', '剧情段', '拆分', '拆成章节', '拆章', '卷纲', 'volumes/', 'manuscripts/', 'beatsHash'];
const VOLUME = /(^|[^入试答画书])卷(?![入])/;

let bundle;

before(() => {
  bundle = loadBundle({
    tools: './src/core/tools/novel/index.ts',
    instructions: './src/core/mcp/instructions.ts',
  });
});

/** 一个工具里模型看得见的全部文字：描述、参数说明、枚举值。 */
function textsOf(tool) {
  const props = tool.parameters?.properties ?? {};
  return [
    [`${tool.name}.description`, tool.description],
    ...Object.entries(props).flatMap(([key, p]) => [
      [`${tool.name}.${key}`, p.description ?? ''],
      ...(p.enum ?? []).map((v) => [`${tool.name}.${key}.enum`, v]),
    ]),
  ];
}

function assertClean(where, text) {
  for (const word of STALE) {
    assert.ok(!text.includes(word), `${where} 里还有「${word}」：${text}`);
  }
  assert.ok(!VOLUME.test(text), `${where} 里还有「卷」：${text}`);
}

describe('工具说明不提旧链路', () => {
  test('七个工具都查到了', () => {
    assert.equal(bundle.tools.NOVEL_TOOLS.length, 7);
  });

  test('描述、参数说明与枚举值', () => {
    for (const tool of bundle.tools.NOVEL_TOOLS) {
      for (const [where, text] of textsOf(tool)) {
        assertClean(where, text);
      }
    }
  });

  // 「拆分」这个动作仍在 run 的拒绝清单里（拿着老提示词来的模型要听到「这是有意不给的」），
  // 但不许出现在可用动作的枚举里——否则模型会照着列表去点它。
  test('run 的可用动作里没有 split', () => {
    const run = bundle.tools.NOVEL_TOOLS.find((t) => t.name === 'run');
    assert.ok(!run.parameters.properties.action.enum.includes('split'));
  });
});

describe('MCP 说明不提旧链路', () => {
  test('MCP_INSTRUCTIONS', () => {
    const text = String(bundle.instructions.MCP_INSTRUCTIONS);
    assert.ok(text.length > 0);
    assertClean('MCP_INSTRUCTIONS', text);
  });
});
