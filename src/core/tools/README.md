# core/tools — 工具层

**「能对这个工程做什么」的那一份清单，与「谁拿着它做事」无关。**

从前这些工具住在 `agent/tools/` 里，工具契约也定义在 `agent/registry.ts`。
它能跑，但两层是缠在一起的：

| 缠在哪 | 后果 |
|---|---|
| `ToolContext` 上挂着 agent 的 `Budget`，工具自己 `budget.calls += 1`、还读 `limits` 拼「已用 3/10 次生成」 | 想把工具端出去，得先把 agent 的预算对象一起端出去 |
| 闸门 `switch (tool.name)`，还反过来 `import { describeForReview } from './tools/write'` | 加一个工具要回 agent 里改一次，忘了改不会红——只会某天静默地少问一句 |
| 循环 `import { ALL_TOOLS }` 当缺省，跑完还去翻 `drafts.bySession()` 认新草稿 | 换一套工具就要改循环；而循环本该只管调度 |

现在的分界：**这一层管「做那件事」，调用方管「什么时候做、要不要先问、花了多少」。**

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | ★ 契约。`ToolDef` / `ToolContext` / `ToolResult` / `ToolIntent` / `ToolInvoker` |
| [schema.ts](schema.ts) | 参数 schema 的写法与校验（描述怎么写、为什么必须扁平） |
| [registry.ts](registry.ts) | ★ 一组 `ToolDef` + 一份环境 = 一个能被调用的工具集。执行、兜异常、记日志 |
| [novel/](novel/index.ts) | Novel Forge 这套：`list` / `read` / `search` / `generate` / `write` / `edit` / `run` |

## 谁绑、谁跑

```
controller/agent.ts        createNovelTools({project, workspace, drafts, sessionId})
        │                              │
        │  runAgent({ tools, … })      ▼
        ▼                        ToolRegistry  ──run──▶  workspace / generation / features
   agent/loop.ts  ──invoke──▶   （ToolInvoker）
   （只认 ToolInvoker）
```

**循环手上没有 `Workspace`、没有 `DraftStore`、没有 `ToolDef`。** 它只有四个方法：
`specs()` / `names()` / `intent()` / `invoke()`。于是：

- 换一套工具（另一个领域、将来某个 MCP 客户端）循环一行都不用改；
- 这一层可以单独端出去对外提供服务，不必把调度那一半一起端走。

反过来也成立：**`tools/` 一行都不 import `agent/`**，`agent/` 只 `import type` 那一份
契约。两条由 [tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js)
守着。

## 三个约定

### 1. 工具报数，调用方记账

工具**不知道上限是多少**，它只会说「我调了 2 次模型」：

```ts
ctx.usage.record(1);   // 发请求之前就记——请求发出去钱就花了，抛异常也一样
```

「已用 3/10 次生成」那句话由调用方补（`agent/budget.ts` 的 `describe()`）。
工具里再拼一遍，等于把预算耦合回来——而那正是第一版的毛病。

### 2. 工具自报意图，不自己弹框

确认框是**宿主**的事：同一个 `write`，在面板里该问作者一句，在一条无人值守的
远端会话里问谁？所以工具只描述这一步是什么性质、要问的话该怎么说：

```ts
intent: (args, project) => ({
  gate: 'mutating',                       // 五档之一，见 types.ts
  title: `写入「${describePath(...)}」`,  // 动词短语，主语由调用方加
  detail: `${target}（新建）`,
  proceed: '写入',
})
```

`gate` 的五档（`auto` / `costly` / `mutating` / `reviewed` / `always`）与三种策略
交叉出的那张表在 [agent/policy.ts](../agent/policy.ts)。**哪个工具归哪一档由工具
自己说**——只有它知道自己随后会不会走覆盖审阅（`reviewed`）、下游会不会 diff
（`always` 就是「不会，所以这一句确认就是它的 diff」）。

### 3. 保护不在这一层

越界、回收站、保护目录、大小上限、同名不覆盖、覆盖前审阅、乐观锁——**八条守卫
全在 `workspace/guard.ts`**。工具体里一行路径检查都没有；哪天要在这里写一段，
说明绕过了网关，停下来重想（AGENTS 第 7 / 25 条）。

## 端出去做 MCP：还差什么

形状是照着 MCP 摆的，所以**工具体一行都不用改**：

| 这里 | MCP |
|---|---|
| `ToolDef.name` / `description` / `parameters` | `tools/list` 的一条 |
| `ToolInvoker.invoke` → `ToolInvocation` | `tools/call` 的请求与结果 |
| `ToolDef.mutating` / `costly` | `readOnlyHint` 那类注解 |
| `ToolIntent` | 没有对应物——**确认是宿主的事** |

还没做的三件，都不在这一层：

1. **传输**（stdio / HTTP + JSON-RPC）。按壳只做三件事那条约定，它属于
   `shells/`，不属于 `core/`。
2. **`ToolEnv` 从哪来**。面板那条路上是当前工程；一条 MCP 会话得先说清它开的是
   哪个工程，以及**同一个工程被两个客户端同时写**时怎么办（网关的乐观锁能挡住
   丢改动，但挡不住两边互相覆盖）。
3. **`ctx.report` / `intent` 落到哪**。MCP 客户端不一定有 UI。`generate` 与
   `write` 在无人值守的会话里是该直接拒、还是降级成只读，是个产品决定，
   不该由这一层默默替谁答了。

**在这三件想清楚之前不要先写协议代码**——协议是最容易的那部分。
