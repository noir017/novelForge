# 零期：事件流 provider Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md) —— 23 条产品承诺，一条都不能破
> 2. 本期的设计依据 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L0 一节**
> 3. [src/core/llm/README.md](../../../src/core/llm/README.md)
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。

**Goal:** 把 `LlmProvider` 的唯一原语从「吐字符串的流」换成「吐事件的流」，让它能收发工具调用。三个 provider 全部改完，13 个既有调用点行为逐字节不变。

**Architecture:** 先定类型与 `collectText`（纯新增，不动任何实现），再逐个 provider 改造并让老接口消失，最后一次性把 13 个调用点迁过去。**不留 `chatStream` 的兼容层**——同时存在两条路是这类改造最容易腐烂的地方。

**Tech Stack:** TypeScript（`src/core/llm/`，零 vscode 依赖；vscode-lm 那份在 `src/shells/vscode/`）+ `node:test` + `npm run typecheck`。不新增依赖。

## Global Constraints

- **行为不变**：13 个既有调用点产出的文本、reasoning 分流、usage 合并口径，一个字节都不能变。本期唯一的验收标准就是 `npm test` 全绿。
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js` 守着）。
- **日志不记 prompt 全文、不记正文全文、不出现 API Key**（AGENTS.md 第 11 条）。新加的工具调用日志只记工具名与参数的键名，**不记参数值**——参数值里可能有正文片段。
- `args` 解析失败**绝不抛**：发一个 `args: {}` 的 `toolCall`，由上层报错。抛异常会炸掉整轮对话。
- 每个 Task 结束立刻 commit；前缀 `refactor` / `feat` / `test`；中文正文。
- 不要同时留下 `chatStream` 与 `stream`。

---

## 目标态文件结构

```
src/core/llm/
├── provider.ts        ★ 大改：StreamEvent / AgentMessage / ToolSpec / LlmProvider.stream
├── collect.ts         ★ 新增：collectText（原 collectStream 的位置）
├── openaiProvider.ts  ★ 改：SSE → StreamEvent，含 tool_calls 按 index 累积
├── anthropicProvider.ts ★ 改：同上，含 tool_use content block
├── registry.ts        不动
└── pool.ts            不动（它只转发 provider，不碰消息形状）

src/shells/vscode/
└── vscodeLmProvider.ts ★ 改：LanguageModelToolCallPart
```

## 提交节奏（5 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `refactor` | 定义 StreamEvent / AgentMessage / ToolSpec 与 collectText |
| 2 | `refactor` | OpenAI provider 改事件流，支持 tool_calls |
| 3 | `refactor` | Anthropic provider 改事件流，支持 tool_use |
| 4 | `refactor` | vscode-lm provider 改事件流 |
| 5 | `refactor` | 13 个调用点迁到 collectText，删掉 chatStream |

---

### Task 1: 定义事件流类型与 `collectText`

**Files:**
- Modify: `src/core/llm/provider.ts`
- Create: `src/core/llm/collect.ts`
- Create: `tests/unit/llm/collect.test.js`

**Interfaces:**

`provider.ts` 新增（`ChatMessage` / `chatStream` / `collectStream` **本 Task 先留着**，Task 5 才删）：

```ts
/** 一次工具调用。args 已解析成对象；解析失败时是空对象。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 参数原文。解析失败时上层要把它回显给模型看。 */
  raw: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object，原样透传给各家 API。 */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required';

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface StreamOptions {
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
}

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  readonly label: string;
  maxInputTokens(): Promise<number | undefined>;
  stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
}
```

`collect.ts`：

```ts
export interface CollectHandlers {
  onDelta?(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onUsage?(usage: TokenUsage): void;
  onToolCall?(call: ToolCall): void;
}

export interface CollectResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
}

/** 收全流，按字段合并 usage。既有调用点用它替代 collectStream。 */
export async function collect(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<CollectResult>;

/** 只要文本那一份。13 个既有调用点用这个。 */
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<string>;
```

**usage 合并口径必须与现状一致**：同一次请求可能回调多次（Anthropic 在 `message_start` 给输入、`message_delta` 给输出），**按字段合并，后到的覆盖同名字段，缺席的字段保留**。照抄 `features/creation.ts:145-152` 与 `features/summarize.ts` 里那段。

- [ ] **Step 1: 写失败测试** `tests/unit/llm/collect.test.js`

```js
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

async function* streamOf(events) { for (const e of events) yield e; }

describe('llm/collect', () => {
  let c;
  before(() => { c = loadModule('src/core/llm/collect.ts'); });

  test('collectText 只拼 text 事件', async () => {
    const text = await c.collectText(streamOf([
      { type: 'text', text: '雨下了' },
      { type: 'reasoning', text: '（先想想）' },
      { type: 'text', text: '三天。' },
    ]));
    assert.equal(text, '雨下了三天。');
  });

  test('reasoning 不混进正文，单独回调', async () => {
    const seen = [];
    await c.collectText(streamOf([
      { type: 'reasoning', text: 'a' },
      { type: 'text', text: 'X' },
      { type: 'reasoning', text: 'b' },
    ]), { onReasoning: (d, full) => seen.push([d, full]) });
    assert.deepEqual(seen, [['a', 'a'], ['b', 'ab']]);
  });

  test('usage 按字段合并，缺席字段保留', async () => {
    const r = await c.collect(streamOf([
      { type: 'usage', usage: { inputTokens: 100 } },
      { type: 'text', text: 'x' },
      { type: 'usage', usage: { outputTokens: 20 } },
    ]));
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('toolCall 收进数组并回调', async () => {
    const call = { id: 'c1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' };
    const seen = [];
    const r = await c.collect(streamOf([{ type: 'toolCall', call }]), {
      onToolCall: (x) => seen.push(x.name),
    });
    assert.deepEqual(r.toolCalls, [call]);
    assert.deepEqual(seen, ['read']);
  });

  test('onDelta 收到增量与全量', async () => {
    const seen = [];
    await c.collectText(streamOf([
      { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    ]), { onDelta: (d, full) => seen.push([d, full]) });
    assert.deepEqual(seen, [['a', 'a'], ['b', 'ab']]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test "tests/unit/llm/collect.test.js"
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`provider.ts` 加上面那批类型（`LlmProvider` **暂时同时声明 `chatStream` 与可选的 `stream?`**，让三个 provider 能分 Task 迁移）。`collect.ts` 实现两个函数。

- [ ] **Step 4: 跑测试**

```bash
node --test "tests/unit/llm/collect.test.js"
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/llm/provider.ts src/core/llm/collect.ts tests/unit/llm/collect.test.js
git commit -m "refactor(llm): 定义事件流类型与 collect

StreamEvent / AgentMessage / ToolSpec 就位，collectText 保持「传一个流拿一段文本」的形状。provider 实现下一步改。"
```

---

### Task 2: OpenAI provider 改事件流

**Files:**
- Modify: `src/core/llm/openaiProvider.ts`
- Create: `tests/unit/llm/openaiToolCalls.test.js`

**关键实现点（照抄这几条，不要自己发挥）：**

1. **消息转换**。`AgentMessage[]` → OpenAI 的 `messages[]`：
   - `system` / `user` 原样
   - `assistant` 带 `toolCalls` 时输出 `tool_calls: [{id, type:'function', function:{name, arguments: raw}}]`；`content` 为空串时给 `null`
   - `tool` → `{role:'tool', tool_call_id, content}`
2. **tools 透传**：`tools: specs.map(s => ({type:'function', function:{name, description, parameters}}))`，`tool_choice` 直接给 `'auto'|'none'|'required'`。**没有 tools 时这两个字段一律不带**——有些兼容实现见到未知字段会直接 400（既有代码在 `stream_options` 上已经踩过这个坑，注释就在那儿）。
3. **`tool_calls` 分片按 `index` 累积，不是按 `id`**：

```ts
// 每个 index 一个累积槽。id 只在第一片给，name 通常也只给一次。
const slots = new Map<number, { id: string; name: string; args: string }>();
// delta.tool_calls?.forEach(tc => {
//   const slot = slots.get(tc.index) ?? { id: '', name: '', args: '' };
//   if (tc.id) slot.id = tc.id;
//   if (tc.function?.name) slot.name = tc.function.name;
//   if (tc.function?.arguments) slot.args += tc.function.arguments;
//   slots.set(tc.index, slot);
// });
```

4. **流结束时**（`finish_reason === 'tool_calls'` 或流自然结束）把每个槽 yield 成一个 `toolCall` 事件。`JSON.parse(args)` 失败时 **`args: {}`，`raw` 保留原文，不抛**。
5. `reasoning_content` / `reasoning` → `{type:'reasoning'}`；`delta.content` → `{type:'text'}`；`usage` → `{type:'usage'}`。三条与现状逐字节一致。
6. `stream_options: { include_usage: true }` 的条件从「调用方给了 onUsage」改成**恒开**——事件流里 usage 是一等公民，没有「调用方想不想听」这回事。

- [ ] **Step 1: 写失败测试** `tests/unit/llm/openaiToolCalls.test.js`

测的是**纯函数**，不发网络请求。因此实现时要把两段逻辑抽成可导出的纯函数：

```ts
export function toOpenAiMessages(messages: AgentMessage[]): unknown[];
export function accumulateToolCalls(chunks: OpenAiToolCallDelta[][]): ToolCall[];
```

用例至少覆盖：

| 用例 | 断言 |
|---|---|
| 单个工具调用分三片到达（id 只在第一片） | 拼出完整 `{id, name, args}` |
| 两个并行工具调用（index 0 与 1 交错） | 各自拼对，不串味 |
| `arguments` 是坏 JSON | `args` 为 `{}`，`raw` 保留原文，不抛 |
| `assistant` 带 toolCalls 转换 | `content: null`，`tool_calls` 形状正确 |
| `tool` 消息转换 | `{role:'tool', tool_call_id, content}` |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— `chatStream` 改名为 `stream`，签名换成 `(AgentMessage[], StreamOptions) => AsyncIterable<StreamEvent>`
- [ ] **Step 4: 跑测试**

```bash
node --test "tests/unit/llm/*.test.js"
npm run typecheck
node --test "tests/integration/llm/streaming.test.js"
```

`streaming.test.js` 这一轮会红（它还在调 `chatStream`），**这是预期的**——Task 5 一起修。在 commit message 里写明。

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(llm): OpenAI provider 改事件流，支持 tool_calls

分片按 index 累积不是按 id——id 只在第一片给。坏 JSON 不抛，发一个 args 为空的 toolCall 让上层去报。
integration/llm/streaming.test.js 暂红，等调用点一起迁。"
```

---

### Task 3: Anthropic provider 改事件流

**Files:**
- Modify: `src/core/llm/anthropicProvider.ts`
- Create: `tests/unit/llm/anthropicToolUse.test.js`

**关键实现点：**

1. **`tool_result` 不是独立 role**。Anthropic 把它放在 `user` 消息的 content block 里：

```json
{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"…"}]}
```

所以 `AgentMessage[]` → Anthropic messages 的转换比 OpenAI 复杂：连续的 `tool` 消息要合并进**一条** `user` 消息的 content 数组。

2. **`assistant` 带 toolCalls** 输出成 content block 数组：

```json
{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"tool_use","id":"…","name":"…","input":{…}}]}
```

`text` 为空时不要放空的 text block（会 400）。

3. **工具调用分三个事件到达**：
   - `content_block_start` → `content_block.type === 'tool_use'`，带 `id` / `name`，`input` 是 `{}`
   - `content_block_delta` → `delta.type === 'input_json_delta'`，`partial_json` 是**逐字符拼的 JSON 串**
   - `content_block_stop` → 这一块完了，此时才 `JSON.parse` 并 yield `toolCall`

   按 `event.index` 累积（与 OpenAI 一样，多个并行调用各占一个 index）。

4. `mergeConsecutive` 那条「首条必须是 user、相邻同角色合并」的既有逻辑**要保留**，但现在 content 可能是数组，合并规则改成：相邻同角色时把 content 数组接起来（字符串先包成 `[{type:'text',text}]`）。
5. `tools` 透传：`tools: specs.map(s => ({name, description, input_schema: parameters}))`。**字段名是 `input_schema` 不是 `parameters`。** `tool_choice`: `auto` → `{type:'auto'}`，`required` → `{type:'any'}`，`none` → 不带 tools。
6. `text_delta` → `text`；`thinking_delta` → `reasoning`；两处 usage → `usage`。与现状逐字节一致。

- [ ] **Step 1: 写失败测试** `tests/unit/llm/anthropicToolUse.test.js`

同样抽纯函数来测：

```ts
export function toAnthropicMessages(messages: AgentMessage[]): unknown[];
export function accumulateToolUse(events: AnthropicEvent[]): ToolCall[];
```

用例至少覆盖：

| 用例 | 断言 |
|---|---|
| `input_json_delta` 逐字符拼 | `content_block_stop` 后 yield 出完整 args |
| 两个并行 tool_use（index 0 与 1） | 各自拼对 |
| 坏 JSON | `args: {}`，`raw` 保留 |
| 连续三条 `tool` 消息 | 合并成**一条** user，content 里三个 tool_result |
| `assistant` 空 text + toolCalls | content 里没有空 text block |
| 首条不是 user | 前面补一条 `（继续）` |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试**
- [ ] **Step 5: Commit**

---

### Task 4: vscode-lm provider 改事件流

**Files:**
- Modify: `src/shells/vscode/vscodeLmProvider.ts`

**关键实现点：**

1. `sendRequest(msgs, { tools, toolMode }, token)`。`vscode.LanguageModelChatTool` 的字段是 `{name, description, inputSchema}`。
2. 响应流用 `response.stream`（不是 `response.text`），逐个判断 part 类型：
   - `vscode.LanguageModelTextPart` → `{type:'text'}`
   - `vscode.LanguageModelToolCallPart` → `{type:'toolCall'}`，**`input` 已经是解析好的对象**，不用累积；`raw` 填 `JSON.stringify(part.input)`
3. `tool` 消息 → `vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(content)])])`
4. `assistant` 带 toolCalls → `LanguageModelChatMessage.Assistant([...text, ...new LanguageModelToolCallPart(id, name, args)])`
5. **系统提示并进首条 user 的既有逻辑保留**（`toLmMessages`）——那是这个 provider 的特点，不是缺陷。
6. vscode-lm 不给 usage，不发 `usage` 事件（现状也没有）。

**注意**：这个文件在 `src/shells/vscode/` 下，可以 import `vscode`；但它 import 的类型来自 `core/llm/provider`，方向是对的。

- [ ] **Step 1: 实现**（这一份没有单元测试——它需要真实的 `vscode` 命名空间。靠 `npm run typecheck` 与手动 F5 验证）
- [ ] **Step 2: 验证**

```bash
npm run typecheck
npm run compile
```

然后 F5 起 Extension Development Host，用一个 Copilot 模型跑一次普通续写，确认文本照常流出来。

- [ ] **Step 3: Commit**

---

### Task 5: 13 个调用点迁移，删掉 `chatStream`

**Files:**
- Modify: `src/core/llm/provider.ts`（删 `ChatMessage` / `chatStream` / `collectStream`；`ChatOptions` 的 `onReasoning` / `onUsage` 一并删掉）
- Modify: `src/core/features/creation.ts`（2 处）
- Modify: `src/core/features/summarize.ts`（3 处）
- Modify: `src/core/features/pipelineBatch.ts`（3 处）
- Modify: `src/core/features/characterCard.ts`（1 处）
- Modify: `src/core/features/characters.ts`（1 处）
- Modify: `src/core/features/lore.ts`（2 处）
- Modify: `src/core/features/style.ts`（1 处）
- Modify: `tests/integration/llm/streaming.test.js`
- Modify: `src/core/llm/README.md`

**迁移模式**（三种形状，逐个对号入座）：

```ts
// ── 形状 A：collectStream + 无回调（summarize / lore / style / characters / characterCard）
const raw = await collectStream(llm.chatStream(messages, options));
// ↓
const raw = await collectText(llm.stream(messages, options));

// ── 形状 B：collectStream + onUsage 在 options 里（pipelineBatch）
const raw = await collectStream(llm.chatStream(messages, { …, onUsage: (u) => merge(u) }));
// ↓
const raw = await collectText(llm.stream(messages, { … }), { onUsage: (u) => merge(u) });

// ── 形状 C：手写 for-await（creation.ts:164 与 :479）
for await (const delta of provider.chatStream(built.messages, options)) { full += delta; handlers.onDelta(delta, full); }
// ↓
for await (const ev of provider.stream(built.messages, options)) {
  if (ev.type === 'text') { full += ev.text; handlers.onDelta(ev.text, full); }
  else if (ev.type === 'reasoning') { reasoning += ev.text; handlers.onReasoning?.(ev.text, reasoning); }
  else if (ev.type === 'usage') { mergeUsage(usage, ev.usage); }
}
```

`creation.ts` 的 `testConnection`（:479）是形状 C 的简化版：拿到任何 `text` 事件就 break。

**`ChatMessage` → `AgentMessage`**：13 处传的都是 `{role:'system'|'user'|'assistant', content}`，结构上已经是合法的 `AgentMessage`，**只需要改 import 的类型名**。`buildContext` 返回的 `BuiltContext.messages` 类型也跟着改（`context/types.ts` 与 `context/builder.ts` 各一处）。

**usage 合并要抽成一个共享函数**：现在 `creation.ts` 与 `pipelineBatch.ts` 各写了一遍同样的 `if (u.inputTokens !== undefined) …`。搬进 `collect.ts` 导出 `mergeUsage(target, patch)`。

- [ ] **Step 1: 改 `provider.ts`，删掉老接口**

`LlmProvider` 上 `stream` 从可选改成必需，`chatStream` 删掉。此时全项目编译不过——这是预期的，下一步逐个修。

- [ ] **Step 2: 逐文件迁移**

顺序建议：`context/types.ts` → `context/builder.ts` → `features/creation.ts` → 其余六个 feature。每改完一个跑一次 `npm run typecheck` 看剩余错误在缩小。

- [ ] **Step 3: 修集成测试**

`tests/integration/llm/streaming.test.js` 现在调 `providerMod.collectStream(openai.chatStream(...))`。改成 `collectText(openai.stream(...))`，并**补两条新用例**：

| 用例 | 断言 |
|---|---|
| 假 SSE 里带 `tool_calls` 分片 | 收到一个 `toolCall` 事件，args 拼对 |
| 假 SSE 里 `tool_calls` 的 arguments 是坏 JSON | `args` 为 `{}`，不抛 |

- [ ] **Step 4: 全量验证**

```bash
npm run typecheck
npm test
```

Expected: 全绿。**这是本期唯一的验收标准**——13 个调用点的行为必须逐字节不变。

- [ ] **Step 5: 更新 `src/core/llm/README.md`**

至少写清三件事：`StreamEvent` 是唯一原语；三家的工具调用分片累积各有什么坑（OpenAI 按 index、Anthropic 按 content block、vscode-lm 不用累积）；坏 JSON 不抛的理由。

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(llm): 13 个调用点迁到 collectText，删掉 chatStream

不留兼容层：同时存在两条路是这类改造最容易腐烂的地方。行为逐字节不变，npm test 全绿是本期唯一的验收标准。"
```

---

## 本期不做

- **不接 agent**。这一期结束时项目里没有任何一处**用**工具调用，只是**能**用。
- **不改 `pool.ts`**。它只转发 provider，不碰消息形状。
- **不加 `supportsTools` 字段**。那是三期的事（agent 模型选择器要用），这一期加了没人读。
- **不改设置页**。

## 给接手 agent 的提示词

> 你在 novel-forge 仓库里执行「零期：事件流 provider」。
>
> 先读 `AGENTS.md`（23 条产品承诺）与 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L0 一节，再读 `src/core/llm/` 下的四个文件与 `src/shells/vscode/vscodeLmProvider.ts`。
>
> 这一期**没有新功能**，全部是重构。唯一的验收标准是 `npm test` 全绿——13 个既有调用点（摘要、角色卡、设定、文风、批量流水线、创作、连接测试）产出的文本、reasoning 分流、usage 合并口径，一个字节都不能变。
>
> 按 `docs/design/plans/2026-08-15-agent-phase0-provider-events.md` 的 5 个 Task 逐个做，每个 Task 做完立刻 commit（前缀 `refactor(llm)`，中文正文，**不要加 Co-Authored-By 或 Generated with 标记**）。
>
> 三件最容易做错的事：
> 1. OpenAI 的 `tool_calls` 分片**按 `index` 累积，不是按 `id`**——`id` 只在第一片给。
> 2. Anthropic 的 `tool_result` **不是独立 role**，要合并进一条 `user` 消息的 content 数组。
> 3. `JSON.parse(args)` 失败**绝不抛**——发一个 `args: {}` 的 toolCall，`raw` 保留原文。抛异常会炸掉整轮对话。
>
> 遇到「这里要不要顺手改一下」的念头时：不要。这一期只搬管道。
