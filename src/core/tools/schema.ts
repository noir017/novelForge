/**
 * 参数 schema 的写法，以及守着它的那批校验。
 *
 * ## 模型只看得见两样东西
 *
 * `description` 与 `parameters`。它决定「这一步该调哪个工具、参数怎么填」时，
 * 手上就这些。所以这一层真正的活不是转换格式（那是十行），而是**把描述与
 * schema 的写法钉死**——描述会慢慢跑偏，schema 会慢慢长出嵌套，两者都不会
 * 报错，只会让模型的调用成功率一点点掉下去。
 *
 * ## 描述怎么写：三条原则
 *
 * 1. **说清坐标系**。工程里的东西全是普通 Markdown，路径就是它们的身份：
 *    细纲在 `.novelforge/plots/`，中转站正文在 `.novelforge/manuscripts/`，
 *    中转站正文在 `.novelforge/manuscripts/`，已发布的章在章节根（默认
 *    `chapters/`）。不说清楚，模型会去猜一个不存在的路径然后反复重试。
 * 2. **说清限制**。「一次最多返回 400 行，超出会截断并告诉你截了多少」——
 *    这既是第 2 条（不静默截断）的落点，也是让模型知道「还有下一页」的唯一
 *    途径。
 * 3. **不写领域知识**。「剧情不写画面、天气、台词」那几句在
 *    `context/prompts.ts` 里，由 `generate` **内部那次调用**自己带着。在工具
 *    描述里再写一遍，一是白烧 token（每一轮都要发），二是两处迟早跑偏——
 *    而跑偏之后没有任何测试会红。
 *
 * ## 参数尽量扁平
 *
 * `{path, offset, limit}` 好过 `{target: {kind, chapterNo}}`。嵌套
 * 对象是模型最容易填错的地方，而填错的表现是一次白花的往返。所以
 * {@link validateToolDef} **直接拒绝嵌套对象属性**，不是靠人记得。
 */
import type { ToolDef } from './types';

interface PropSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description: string;
  items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
  enum?: string[];
}

export function str(description: string, values?: string[]): PropSchema {
  return values ? { type: 'string', description, enum: values } : { type: 'string', description };
}

export function int(description: string): PropSchema {
  return { type: 'integer', description };
}

export function bool(description: string): PropSchema {
  return { type: 'boolean', description };
}

export function strArray(description: string): PropSchema {
  return { type: 'array', description, items: { type: 'string' } };
}

/**
 * 拼一个对象 schema。`required` 里的键必须在 `props` 里，否则
 * {@link validateToolDef} 会报出来。
 *
 * `additionalProperties: false` 是有意的：模型多塞一个字段时我们希望**当场
 * 知道**，而不是安静地忽略掉一个它以为自己传了的参数。
 */
export function objectSchema(
  props: Record<string, PropSchema>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/**
 * 校验一条定义。返回一句人话说明哪里不对，没问题时返回 undefined。
 *
 * 调用方（{@link ToolRegistry}）拿到说明就抛。这不是防御性编程：这些 schema
 * 是我们自己写的常量，跑一次就固定下来了。抛在注册那一刻等于把「描述写歪了」
 * 变成一条红测试，而不是三个月后某次对话里模型莫名其妙填错参数。
 */
export function validateToolDef(def: ToolDef, seen: ReadonlySet<string>): string | undefined {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name ?? '')) {
    // 各家 API 对工具名的字符集要求不一，取交集最省心。
    return '名字只能是小写字母、数字与下划线，且以字母开头';
  }
  if (seen.has(def.name)) {
    return '名字重复了——同名工具模型只认得出一个，另一个永远调不到';
  }
  if (!def.description?.trim()) {
    return '没有描述。模型只靠描述与参数决定怎么用它';
  }

  const schema = def.parameters as { type?: unknown; properties?: unknown; required?: unknown };
  if (schema?.type !== 'object' || !isPlainObject(schema.properties)) {
    return 'parameters 必须是 `{ type: "object", properties: {…} }`';
  }
  const props = schema.properties as Record<string, unknown>;

  for (const [key, raw] of Object.entries(props)) {
    if (!isPlainObject(raw)) {
      return `参数 ${key} 的 schema 不是对象`;
    }
    // 这条路上的输入可能是手写的字面量 schema（测试里就是），所以按最松的
    // 形状读，不套 PropSchema——校验器自己不该假设被校验的东西已经合法。
    const type = typeof raw.type === 'string' ? raw.type : '';
    const description = typeof raw.description === 'string' ? raw.description : '';
    const items = isPlainObject(raw.items) ? raw.items : undefined;

    if (!description.trim()) {
      return `参数 ${key} 没有 description——模型看不出该填什么`;
    }
    // 扁平：嵌套对象是模型最容易填错的地方。
    if (type === 'object') {
      return `参数 ${key} 是嵌套对象。摊平成几个标量参数（{path, offset, limit} 好过 {target:{…}}）`;
    }
    if (type === 'array' && items?.type === undefined) {
      return `参数 ${key} 是数组但没说元素类型`;
    }
    if (type === 'array' && items?.type === 'object') {
      return `参数 ${key} 是对象数组。摊平它`;
    }
  }

  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    return 'required 必须是数组';
  }
  for (const key of required) {
    if (!(key in props)) {
      return `required 里的 ${String(key)} 不在 properties 里`;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
