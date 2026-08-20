/**
 * `tools/registry.ts` + `tools/schema.ts`：注册表怎么把 `ToolDef[]` 变成能发出去
 * 的 `ToolSpec[]`，以及它拒收什么。
 *
 * 模型只看得见 `description` 与 `parameters`，所以这里钉的是**写法**而不是
 * 转换本身（那是十行）。四件事各有一批断言：
 *
 * 1. **schema 合法**——名字合规、不重、必填字段在 properties 里；
 * 2. **参数扁平**——嵌套对象直接拒，那是模型最容易填错的地方；
 * 3. **描述不空**——没有描述的工具/参数模型只能瞎猜；
 * 4. **`invoke` 绝不抛**——认不出的名字、工具自己炸掉，都变成一条模型读得懂的
 *    结果。一个工具炸掉不该带走整轮对话。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const reg = loadModule('src/core/tools/registry.ts');
const schema = loadModule('src/core/tools/schema.ts');

/** 注册表要一份环境，但这一组用例一个工具都不真跑，给个空壳就够。 */
const ENV = { project: undefined, workspace: undefined, drafts: undefined, sessionId: 's1' };

/** 一条最小可用的定义。各用例改其中一处。 */
function def(extra = {}) {
  return {
    name: 'read',
    description: '读一份文件',
    parameters: schema.objectSchema({ path: schema.str('工程内相对路径') }, ['path']),
    run: async () => ({ text: '' }),
    ...extra,
  };
}

const specsOf = (defs) => new reg.ToolRegistry(defs, ENV).specs();

/** 一次调用那一面：工具体拿到的 signal / report / usage。 */
function run() {
  const calls = [];
  return {
    signal: new AbortController().signal,
    report: () => {},
    usage: { record: (n) => calls.push(n) },
    calls,
  };
}

describe('specs 产出的 schema', () => {
  const specs = specsOf([
    def(),
    def({
      name: 'search',
      description: '全文检索',
      parameters: schema.objectSchema(
        {
          pattern: schema.str('要找的字面量'),
          kinds: schema.strArray('限定种类'),
          regex: schema.bool('按正则搜'),
          limit: schema.int('最多返回几条'),
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

  test('intent 也不会漏进 spec', () => {
    const s = specsOf([def({ intent: () => ({ gate: 'auto', title: 'x' }) })])[0];
    assert.equal('intent' in s, false, JSON.stringify(s));
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

  test('names 是注册顺序，也就是模型看到的顺序', () => {
    assert.deepEqual(new reg.ToolRegistry([def(), def({ name: 'search' })], ENV).names(), [
      'read',
      'search',
    ]);
  });
});

describe('校验：名字', () => {
  test('名字重复要报出来', () => {
    assert.throws(() => specsOf([def(), def()]), /重复/);
  });

  test('大写字母不收（各家 API 的字符集取交集）', () => {
    assert.throws(() => specsOf([def({ name: 'readFile' })]), /小写/);
  });

  test('空名字不收', () => {
    assert.throws(() => specsOf([def({ name: '' })]), /小写|无名/);
  });

  test('下划线合法', () => {
    assert.equal(specsOf([def({ name: 'read_file' })])[0].name, 'read_file');
  });
});

describe('校验：描述', () => {
  test('工具没有描述要报出来', () => {
    assert.throws(() => specsOf([def({ description: '  ' })]), /描述/);
  });

  test('参数没有描述要报出来', () => {
    const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: [] };
    assert.throws(() => specsOf([def({ parameters })]), /description/);
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
    assert.throws(() => specsOf([def({ parameters })]), /嵌套|摊平/);
  });

  test('对象数组被拒', () => {
    const parameters = {
      type: 'object',
      properties: { edits: { type: 'array', description: '若干编辑', items: { type: 'object' } } },
      required: [],
    };
    assert.throws(() => specsOf([def({ parameters })]), /摊平/);
  });

  test('没说元素类型的数组被拒', () => {
    const parameters = {
      type: 'object',
      properties: { kinds: { type: 'array', description: '种类' } },
      required: [],
    };
    assert.throws(() => specsOf([def({ parameters })]), /元素类型/);
  });
});

describe('校验：必填字段', () => {
  test('required 里出现 properties 没有的键要报出来', () => {
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path', 'offset'],
    };
    assert.throws(() => specsOf([def({ parameters })]), /offset/);
  });

  test('parameters 不是 object schema 时报出来', () => {
    assert.throws(() => specsOf([def({ parameters: { type: 'string' } })]), /object/);
  });
});

describe('objectSchema 助手', () => {
  test('没给 required 时是空数组，不是 undefined', () => {
    assert.deepEqual(schema.objectSchema({ a: schema.str('a') }).required, []);
  });

  test('str 带候选值时产出 enum', () => {
    assert.deepEqual(schema.str('能力', ['discuss', 'generate']).enum, ['discuss', 'generate']);
  });
});

// ★ 这一组是「换个调用方也不会漏掉」的那一半：从前它们散在 agent 的循环里。
describe('invoke 绝不抛', () => {
  test('认不出的名字回一条结果，而不是异常', async () => {
    const r = await new reg.ToolRegistry([def()], ENV).invoke('并不存在的工具', {}, run());
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('没有叫'), r.error);
  });

  // 名单从实际注册的那一份来：写死一串名字，加了工具之后这句话就在撒谎。
  test('顺带告诉模型有哪些可用', async () => {
    const r = await new reg.ToolRegistry([def(), def({ name: 'search' })], ENV).invoke('x', {}, run());
    assert.ok(r.error.includes('read / search'), r.error);
  });

  test('工具抛异常变成 error 结果', async () => {
    const boom = def({
      name: 'boom',
      run: async () => {
        throw new Error('磁盘着火了');
      },
    });
    const r = await new reg.ToolRegistry([boom], ENV).invoke('boom', {}, run());
    assert.equal(r.ok, false);
    assert.ok(r.text.includes('磁盘着火了'), r.text);
  });

  test('出错时 text 就是那句错误（模型只读 text）', async () => {
    const bad = def({ name: 'bad', run: async () => ({ text: '', error: '路径超出工程目录' }) });
    const r = await new reg.ToolRegistry([bad], ENV).invoke('bad', {}, run());
    assert.equal(r.text, '路径超出工程目录');
  });

  test('成功时带出 draftIds 与耗时', async () => {
    const ok = def({ name: 'gen', run: async () => ({ text: '好了', draftIds: ['d1'] }) });
    const r = await new reg.ToolRegistry([ok], ENV).invoke('gen', {}, run());
    assert.equal(r.ok, true);
    assert.deepEqual(r.draftIds, ['d1']);
    assert.equal(typeof r.elapsedMs, 'number');
  });

  test('没产出草稿时 draftIds 是空数组而不是 undefined', async () => {
    const r = await new reg.ToolRegistry([def()], ENV).invoke('read', {}, run());
    assert.deepEqual(r.draftIds, []);
  });
});

describe('工具体拿到环境 + 这一次调用', () => {
  test('两边合成一份 ctx 递进去', async () => {
    let seen;
    const spy = def({ name: 'spy', run: async (ctx) => ((seen = ctx), { text: '' }) });
    const r = run();
    await new reg.ToolRegistry([spy], { ...ENV, sessionId: 's7' }).invoke('spy', {}, r);
    assert.equal(seen.sessionId, 's7');
    assert.equal(seen.signal, r.signal);
    assert.equal(typeof seen.usage.record, 'function');
  });
});

describe('意图：工具不报时兜一个通用的', () => {
  const intentOf = (d, args = {}) => new reg.ToolRegistry([d], ENV).intent(d.name, args);

  test('读类工具归 auto', () => {
    assert.equal(intentOf(def()).gate, 'auto');
  });

  // 宁可多问，也不要有一条没人想过的路。
  test('写盘或花钱的归 mutating', () => {
    assert.equal(intentOf(def({ mutating: true })).gate, 'mutating');
    assert.equal(intentOf(def({ costly: true })).gate, 'mutating');
  });

  test('工具自己报了就用它那一份', () => {
    const d = def({ intent: () => ({ gate: 'always', title: '改一段文字', proceed: '替换' }) });
    assert.deepEqual(intentOf(d), { gate: 'always', title: '改一段文字', proceed: '替换' });
  });

  test('认不出的名字没有意图', () => {
    assert.equal(new reg.ToolRegistry([def()], ENV).intent('没这个', {}), undefined);
  });
});
