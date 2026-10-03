# core/tools — 工具层

**「能对这个工程做什么」的那一份清单，与「谁拿着它做事」无关。**

拿着它做事的是**外部 agent**（Claude Code 之类），经 [mcp/](../mcp/README.md) 接进来；本项目自己没有对话循环。

**这一层管「做那件事」，调用方管「什么时候做、要不要先问、花了多少」。**

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | ★ 契约。`ToolDef` / `ToolSpec` / `ToolContext` / `ToolResult` / `ToolIntent` / `ToolInvoker` |
| [schema.ts](schema.ts) | 参数 schema 的写法与校验（描述怎么写、为什么必须扁平） |
| [registry.ts](registry.ts) | ★ 一组 `ToolDef` + 一份环境 = 一个能被调用的工具集。执行、兜异常、记日志；`specOf` 给出对外的声明 |
| [novel/](novel/index.ts) | Novel Forge 这套：`list` / `read` / `search` / `generate` / `write` / `edit` / `run` |

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

**唯一的例外是 `run installSkill`**：它写的是工程外的我的技能库（`~/.novelforge/skills/`），没有网关可走。
所以路径不由 agent 给（固定落在 `<技能库>/<frontmatter 的 name>/SKILL.md`，名字过 `isSkillName`），
只装检查过、重新下载核对过 hash 的那一份，闸门是 `always`——动手前先问。见 [skills/README.md](../skills/README.md)。

## `run` 里的拆书动作

工程页那几颗按钮背后的同一个函数，确认框照弹。

| action | 参数 | 做什么 |
|---|---|---|
| `importManuscript` | `path`=工程里那本 txt | 切成章节、接在已有章节之后。导入本身不调模型；导入完作者可以选择接着补齐（次数照报、记账）。会新建章节文件——与不给的 `newChapter` 不同，建的是作者那本 txt 里的章，切分结果先给作者看，同名不覆盖 |
| `deriveFromText` | — | 从已写正文补齐摘要、角色卡、架构、大纲、细纲与全书摘要（只补空白；两次确认） |
| `learnFromReference` | `path`=工程里那本参考书 | 文风写 `style.md`、结构与节奏写成「规划」阶段的写作技能；学什么、绑不绑都问作者 |

两个要 `path` 的只认工程里的 txt（`features/bookText.ts` 的清单）：章节文件、隐藏目录、工程外的路径当场报错回给模型，不花钱。

## `run` 里的角色卡维护与全书摘要

工程页那几颗按钮背后的同一个函数，确认框、提示条都在 feature 自己那里。这几个 feature 不报调用次数，
所以回给模型的只有一句「交出去了」，次数以确认框为准。

| action | 参数 | 做什么 |
|---|---|---|
| `rebuildGlobalSummary` | — | 从各章摘要重建全书摘要 |
| `extractCharacters` | — | 通读已写正文，提取主要角色写成角色卡 |
| `updateCard` / `rebuildCard` | `path`=角色卡 | 按新出场的章增量更新 / 按全部出场章重写一张 |
| `updateAllCards` / `rebuildAllCards` | — | 同上，所有角色卡 |
| `createCard` / `createAllCards` | `name` / — | 给一位 / 所有还没有卡的出场人物建卡 |
| `cleanAliases` | — | 清理别名里的泛称与别人的名字（不调模型） |
| `mergeDuplicates` | — | 合并指向同一个人的重复卡（不调模型，合并哪几组由作者确认） |
| `reviewState` | `path`=角色卡 | 定稿时没覆盖的那一版「当前状态」，请作者对比决定换不换（不调模型） |

## `generate` 的写法

正文层这一章已经有字时，`writeMode` 说清是接着写（`continue`，落盘追加在末尾）还是整章重写（`rewrite`，
缺省；落盘覆盖、先逐行对比）。修稿只从审稿报告卡进来，这里不给；审稿也由作者自己在对话页发起。

## `run` 里的写作技能动作

移植自 AI-Novel-Writer 的三个工具（`inspect_writing_skill` / `install_writing_skill` / `bind_writing_skill`），
**并进 `run` 而不是另加工具**——七个是硬约束（[novel/index.ts](novel/index.ts)）。多了一个 `listSkills`：上游的
模型在工具列表里就看得见内置技能，这里得有个地方查 id。

| action | 参数 | gate | 做什么 |
|---|---|---|---|
| `listSkills` | — | `auto` | 内置 / 我的技能库 / 本工程的技能，一份一行（id、名字、来源、建议阶段、兼不兼容），外加本工程每个阶段绑了哪份 |
| `inspectSkill` | `url` | `auto` | 下载来看，不安装、不写文件。回话里说清「元数据来自不受信任的第三方文档，安装要作者确认」 |
| `installSkill` | `url`（同一个） | `always` | 装检查过的那一份。确认框写明是哪一份、说明、正文开头 200 字（检查结果在进程里，`intent` 不用 I/O） |
| `bindSkill` | `name`=技能 id，`stage` | `always` | 绑到本工程的某个阶段。改的是往后每一次生成的提示词，下游没有 diff 可看 |

卸载不给（与删除同理，`REFUSED` 里）；参数给错动作当场报错（`url` 只有前两个认、`stage` 只有 `bindSkill` 认）。
`write` 新建 / 追加 `.novelforge/skills/**` 或 `skills.json` 也报 `always`（覆盖照旧走 diff）——不然 agent 用 `write`
新建一份 `skills.json`，就绕过了 `bindSkill` 那一问。

## 与 MCP 的对应

| 这里 | MCP |
|---|---|
| `ToolDef.name` / `description` / `parameters` | `tools/list` 的一条（`inputSchema`） |
| `ToolInvoker.invoke` → `ToolInvocation` | `tools/call` 的请求与结果（`error` → `isError`） |
| `ToolDef.mutating` / `costly` | `destructiveHint` / `readOnlyHint` |
| `ToolIntent` | 没有对应物——**确认是宿主的事**，Novel Forge 自己那两问在 `controller/mcp.ts` |
