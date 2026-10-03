# core/tools — 工具层

**「能对这个工程做什么」的那一份清单，与「谁拿着它做事」无关。**

拿着它做事的是**外部 agent**（Claude Code 之类），经 [mcp/](../mcp/README.md) 接进来；本项目自己没有对话循环。

**这一层管「做那件事」，调用方管「什么时候做、要不要先问、花了多少」。**

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | ★ 契约。`ToolDef` / `ToolSpec` / `ToolContext` / `ToolResult` / `ToolIntent` / `ToolInvoker` |
| [schema.ts](schema.ts) | 参数 schema 的写法与校验（描述怎么写、为什么必须扁平） |
| [registry.ts](registry.ts) | ★ 一组 `ToolDef` + 一份环境 = 一个能被调用的工具集。执行、兜异常、记日志；`specOf` 给出对外的声明 |
| [novel/](novel/index.ts) | Novel Forge 这套：读三件、`generate`、`write` / `edit`，以及六个工程动作工具（`actions.ts` 把一张动作表变成一个工具） |

## 谁绑、谁跑

```
mcp/server.ts ──McpBackend──▶ controller/mcp.ts   createNovelTools({project, workspace, drafts, sessionId})
（只懂协议）                  （生成锁、两问）                    │
                                   └──────────invoke──────────▶ ToolRegistry ──run──▶ workspace / generation / features
```

`mcp/` 只认 `ToolSpec` 与 `NOVEL_TOOLS`，绑环境、占生成锁、在对话页问那两句都在 `controller/mcp.ts`。
反过来，**`tools/` 一行都不 import `mcp/` 与 `controller/`**。由
[tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js) 守着。

## 三个约定

### 1. 工具报数，调用方记账

工具**不知道上限是多少**，它只会说「我调了 2 次模型」：

```ts
ctx.usage.record(1);   // 发请求之前就记——请求发出去钱就花了，抛异常也一样
```

账记在哪、要不要设上限是调用方的事（MCP 那条路只记日志：外部 agent 的花销由它自己的宿主管，
`generate` 内部那次调用的次数在落盘卡片上照报）。

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

`gate` 五档（`auto` / `costly` / `mutating` / `reviewed` / `always`）在 MCP 那条路上只分三种处理
（[controller/mcp.ts](../controller/mcp.ts)）：`auto` 直接跑、不进对话页；`always` 动手前在对话页问一句；
其余占生成锁、挂在对话页上，问不问交给宿主自己的权限设置。**哪个工具归哪一档由工具自己说**——只有它
知道自己随后会不会走覆盖审阅（`reviewed`）、下游会不会 diff（`always` 就是「不会，所以这一句确认就是
它的 diff」）。

### 3. 保护不在这一层

越界、回收站、保护目录、大小上限、同名不覆盖、覆盖前审阅、乐观锁——**八条守卫
全在 `workspace/guard.ts`**。工具体里一行路径检查都没有；哪天要在这里写一段，
说明绕过了网关，停下来重想（AGENTS 第 7 / 25 条）。

**唯一的例外是 `skills install`**：它写的是工程外的我的技能库（`~/.novelforge/skills/`），没有网关可走。
所以路径不由 agent 给（固定落在 `<技能库>/<frontmatter 的 name>/SKILL.md`，名字过 `isSkillName`），
只装检查过、重新下载核对过 hash 的那一份，闸门是 `always`——动手前先问。见 [skills/README.md](../skills/README.md)。

## 十二个工具

| 工具 | 动作 / 用法 | 参数 |
|---|---|---|
| `list` / `read` / `search` | 看目录、读文件、全文搜 | 各自的 |
| `generate` | 为一份产物调一次创作模型；产出当场问作者落不落盘 | `target` `capability` `ask` `targetWords` `writeMode` |
| `write` / `edit` | 写一份文件 / 改一段文字 | 各自的 |
| `pipeline` | `completeSettings` `batchPlots` `batchManuscripts` `newPlot` | `from` `to` `mode` `review` |
| `summary` | `finalize` `sync` `rebuildGlobal` | `path` |
| `characters` | `extract` `create` `createAll` `update` `rebuild` `updateAll` `rebuildAll` `cleanAliases` `mergeDuplicates` `reviewState` | `path` `name` |
| `extract` | `style` `lore` `threads` | — |
| `book` | `import` `derive` `learn` | `path` |
| `skills` | `list` `inspect` `install` `bind` | `url` `id` `stage` |

**怎么分**：一个工具的参数就是它的全部用法——每个参数都对这个工具的大多数动作有意义，模型不必记
「哪个动作认哪个参数」；工具之间按作者心里的那几块分，与工程页按钮的分组一致。每个动作声明自己认
哪几个参数（`uses`）、哪几个必填（`requires`），给了不认的当场报错（[novel/actions.ts](novel/actions.ts)）。

后六个都是工程页按钮背后的同一个函数，确认框照弹，**没有为外部 agent 加任何一条绕过它的路**。
大多数 feature 报回计划调用次数（`countedBy`），角色卡与全书摘要那几个不报，只回一句「交出去了」
（`handed`），次数以确认框为准。

### `generate` 的写法

正文层这一章已经有字时，`writeMode` 说清是接着写（`continue`，落盘追加在末尾）还是整章重写（`rewrite`，
缺省；落盘覆盖、先逐行对比）。修稿只从审稿报告卡进来，这里不给；审稿由作者自己在对话页发起。

### 拆书

`import` 会新建章节文件——与不给的「新建章节文件」不同，建的是作者那本 txt 里的章，切分结果先给作者看，
同名不覆盖。要 `path` 的两个只认工程里的 txt（`features/bookText.ts` 的清单）：章节文件、隐藏目录、
工程外的路径当场报错，不花钱。

### 写作技能

移植自 AI-Novel-Writer 的三个工具（`inspect_writing_skill` / `install_writing_skill` / `bind_writing_skill`），
合成一个 `skills`——四件事共用 `url` / `id` / `stage`。多了一个 `list`：上游的模型在工具列表里就看得见
内置技能，这里得有个地方查 id。

| action | gate | 做什么 |
|---|---|---|
| `list` | `auto` | 内置 / 我的技能库 / 本工程的技能，一份一行，外加本工程每个阶段绑了哪份 |
| `inspect` | `auto` | 下载来看，不安装、不写文件。回话里说清「元数据来自不受信任的第三方文档」 |
| `install` | `always` | 装检查过的那一份。确认框写明是哪一份、说明、正文开头 200 字 |
| `bind` | `always` | 绑到本工程的某个阶段。改的是往后每一次生成的提示词，下游没有 diff |

`write` 新建 / 追加 `.novelforge/skills/**` 或 `skills.json` 也报 `always`（覆盖照旧走 diff）——不然 agent 用
`write` 新建一份 `skills.json`，就绕过了 `bind` 那一问。

## 与 MCP 的对应

| 这里 | MCP |
|---|---|
| `ToolDef.name` / `description` / `parameters` | `tools/list` 的一条（`inputSchema`） |
| `ToolInvoker.invoke` → `ToolInvocation` | `tools/call` 的请求与结果（`error` → `isError`） |
| `ToolDef.mutating` / `costly` | `destructiveHint` / `readOnlyHint` |
| `ToolIntent` | 没有对应物——**确认是宿主的事**，Novel Forge 自己那两问在 `controller/mcp.ts` |
