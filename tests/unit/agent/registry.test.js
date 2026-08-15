/**
 * `agent/registry.ts`：`ToolDef[]` → `ToolSpec[]`。
 *
 * 模型只看得见 `description` 与 `parameters`，所以这里钉的是**写法**而不是
 * 转换本身（那是十行）。三件事各有一批断言：
 *
 * 1. **schema 合法**——名字合规、不重、必填字段在 properties 里；
 * 2. **参数扁平**——嵌套对象直接拒，那是模型最容易填错的地方；
 * 3. **描述不空**——没有描述的工具/参数模型只能瞎猜。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const reg = loadModule('src/core/agent/registry.ts');

/** 一条最小可用的定义。各用例改其中一处。 */
function def(extra = {}) {
  return {
    name: 'read',
    description: '读一份文件',
    parameters: reg.objectSchema({ path: reg.str('工程内相对路径') }, ['path']),
    run: async () => ({ text: '' }),
    ...extra,
  };
}

describe('toolSpecs 产出的 schema', () => {
  const specs = reg.toolSpecs([
    def(),
    def({
      name: 'search',
      description: '全文检索',
      parameters: reg.objectSchema(
        {
          pattern: reg.str('要找的字面量'),
          kinds: reg.strArray('限定种类'),
          regex: reg.bool('按正则搜'),
          limit: reg.int('最多返回几条'),
        },
        ['pattern']
      ),
    }),
  ]);

  test('每条只带 name / description / parameters 三个字段', () => {
    assert.deepEqual(Object.keys(specs[0]).sort(), ['description', 'name', 'parameters']);
  });

  test('run 不会漏进 spec（它是本地函数，透传给 API 会炸）', () => {
    assert.equal('run' in specs[0], false, JSON.stringify(specs[0]));
  });

  test('parameters 原样透传', () => {
    assert.equal(specs[0].parameters.type, 'object');
    assert.deepEqual(specs[0].parameters.required, ['path']);
  });

  test('数组参数带 items 类型', () => {
    assert.equal(specs[1].parameters.properties.kinds.items.type, 'string');
  });

  test('additionalProperties 关掉——模型多塞字段要当场看得出来', () => {
    assert.equal(specs[0].parameters.additionalProperties, false);
  });
});

describe('校验：名字', () => {
  test('名字重复要报出来', () => {
    assert.throws(() => reg.toolSpecs([def(), def()]), /重复/);
  });

  test('大写字母不收（各家 API 的字符集取交集）', () => {
    assert.throws(() => reg.toolSpecs([def({ name: 'readFile' })]), /小写/);
  });

  test('空名字不收', () => {
    assert.throws(() => reg.toolSpecs([def({ name: '' })]), /小写|无名/);
  });

  test('下划线合法', () => {
    assert.equal(reg.toolSpecs([def({ name: 'read_file' })])[0].name, 'read_file');
  });
});

describe('校验：描述', () => {
  test('工具没有描述要报出来', () => {
    assert.throws(() => reg.toolSpecs([def({ description: '  ' })]), /描述/);
  });

  test('参数没有描述要报出来', () => {
    const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: [] };
    assert.throws(() => reg.toolSpecs([def({ parameters })]), /description/);
  });
});

describe('校验：参数必须扁平', () => {
  test('嵌套对象参数被拒', () => {
    const parameters = {
      type: 'object',
      properties: {
        target: { type: 'object', description: '目标', properties: { kind: { type: 'string' } } },
      },
      required: [],
    };
    assert.throws(() => reg.toolSpecs([def({ parameters })]), /嵌套|摊平/);
  });

  test('对象数组被拒', () => {
    const parameters = {
      type: 'object',
      properties: { edits: { type: 'array', description: '若干编辑', items: { type: 'object' } } },
      required: [],
    };
    assert.throws(() => reg.toolSpecs([def({ parameters })]), /摊平/);
  });

  test('没说元素类型的数组被拒', () => {
    const parameters = {
      type: 'object',
      properties: { kinds: { type: 'array', description: '种类' } },
      required: [],
    };
    assert.throws(() => reg.toolSpecs([def({ parameters })]), /元素类型/);
  });
});

describe('校验：必填字段', () => {
  test('required 里出现 properties 没有的键要报出来', () => {
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path', 'offset'],
    };
    assert.throws(() => reg.toolSpecs([def({ parameters })]), /offset/);
  });

  test('parameters 不是 object schema 时报出来', () => {
    assert.throws(() => reg.toolSpecs([def({ parameters: { type: 'string' } })]), /object/);
  });
});

describe('objectSchema 助手', () => {
  test('没给 required 时是空数组，不是 undefined', () => {
    assert.deepEqual(reg.objectSchema({ a: reg.str('a') }).required, []);
  });

  test('str 带候选值时产出 enum', () => {
    assert.deepEqual(reg.str('能力', ['discuss', 'generate']).enum, ['discuss', 'generate']);
  });
});

describe('只读四件套的注册表', () => {
  const tools = loadModule('src/core/agent/tools/index.ts');

  test('导出 READ_ONLY_TOOLS', () => {
    assert.ok(Array.isArray(tools.READ_ONLY_TOOLS), typeof tools.READ_ONLY_TOOLS);
  });

  // 三期一个写工具都没有：落盘仍走作者点的采纳卡片。
  test('一个 mutating 的工具都没有', () => {
    const bad = tools.READ_ONLY_TOOLS.filter((t) => t.mutating);
    assert.deepEqual(bad.map((t) => t.name), []);
  });

  test('全部能通过 toolSpecs 的校验', () => {
    assert.doesNotThrow(() => reg.toolSpecs(tools.READ_ONLY_TOOLS));
  });
});
