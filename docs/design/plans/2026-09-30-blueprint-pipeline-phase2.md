# 二期：架构 + 大纲 + 细纲批次的生成 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期直接关系到第 1、2、3、4、11、15、19、20、21、22 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#1–#8、#21）、§2.3、§3.3 的 W2–W5、§4（D16、D19–D21）。
> 3. [一期计划](2026-09-30-blueprint-pipeline-phase1.md) 的「本期定下的模型」一节：本期在那套状态机与文件格式上长出生成能力，不改格式。
> 4. 上游源码：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植处在注释里注明出处（AGPL 与 GPLv3 可组合，总计划 §8）。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 从一句话到前 5 章细纲，每一步都用从 AI-Novel-Writer 移植的提示词与输出合同生成；结构化产物不合格时按上游的修复链降级；工程页有「一句话」「拆细纲」两个弹窗和「补齐设定」批量动作。正文层的提示词与自动续写是三期的事，本期不动。

**Architecture:** 纯函数先行（结构指导、大纲合并、批次规划、三种结构化解码），再是提示词与装配层，然后是把多次调用串起来的生成链（`generation/structured.ts`，单步与批量两条路共用），最后是落盘、批量动作与前端。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。
- **解析一律不抛**（第 1 条）。解码函数要「报原因」时返回诊断对象，不抛异常；抛只发生在生成链里，并且被 `generate` 兜成一条人话错误。
- **不静默截断**（第 2 条）：每一次降级（拆半重试、单章紧凑重建、语法修复、字段级重写、漏字段）都写进 Draft 的 `notes`，显示在落盘卡片上并进日志。
- **动手之前写明调用次数**（第 4 条、D16）：见下文「调用次数」一节。确认框与主按钮提示用同一个纯函数算。
- **当场过人 / 批量只补空白**（第 19 条）：对话页的每一次生成照旧只出一张落盘卡片；工程页的「补齐设定」「批量拆细纲」跳过已有产物，不问、不覆盖。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。

---

## 本期定下的东西（写进代码注释）

### 1. 六种故事结构都带章号区间（`model/structureGuide.ts`，新）

上游只给三幕、起承转合、多线、自由四种算了区间，英雄之旅与节拍表只有一行占位（`architecture-workflow.ts:238-241`）。这里六种都按累计百分比切，一个分配函数：

- 三幕：20 / 75 / 100；起承转合：25 / 50 / 75 / 100；
- 英雄之旅十二阶段：平凡世界 5、冒险召唤 10、拒绝召唤 13、遇见导师 18、跨越门槛 25、考验盟友敌人 40、接近洞穴 50、磨难 60、奖赏 70、归途 80、复活 92、携宝归来 100；
- 节拍表十五拍：开场画面 1、主题呈现 5、铺垫 10、催化剂 12、犹豫 20、进入第二幕 22、B 故事 25、游戏时间 50、中点 52、坏人逼近 72、一无所有 75、灵魂黑夜 80、进入第三幕 82、终局 98、终场画面 100；
- 多线叙事：交汇点落在 25% / 50% / 75% 那几章；自由结构：开篇前 12%、收尾后 12%。

分配规则：第 i 段的终点 = `max(上一段终点 + 1, round(total × p_i))`，同时给后面每段至少留一章。总章数少于段数时允许相邻段共用一章（「第 3 章：催化剂 · 犹豫」）。`structureStagesIn(range)` 返回与本批区间相交的那几段，大纲续写时告诉模型「这 20 章落在哪几段」。

### 2. 大纲按区间合并（`model/outlineFile.ts` 加 `mergeOutline`）

生成第 a–b 章的大纲时，模型只输出这一段。落盘时：删掉旧大纲里**与 [a, b] 重叠**的区间节，把新的几节插到第一个被删节的位置（没有被删的就按章号插到合适位置）；区间之外的节、没有区间标题的前言原样保留。旧大纲没写过就直接用新的。结果走覆盖审阅（旧大纲有内容时）。

### 3. 细纲批次（`model/pipeline.ts`）

- `BookFacts` 加 `plotFilledNos: number[]`。`deriveBookNextStep` 的「拆细纲」区间改成：从下一可写章起**连续没有细纲**的那几章，最多 5 章，不超过大纲覆盖与总章数。已经排好的章不会被圈进来（主按钮那一批永远是空白）。
- 纯函数 `planPlotBatches({ from, to, filledNos, coverage, total })` → `{ chapters, skipped, batches: number[][], calls }`：区间内跳过已有细纲的章，剩下的按连续段切，每段再切成 ≤5 章一批。工程页弹窗的实时说明与后端确认框都用它（第 4 条：只算一次）。

### 4. 调用次数（`model/pipeline.ts` 的 `CallEstimate`）

`NextStepPlan` 加 `calls?: { expected: number; max: number }`，前端在提示后面写「预计 1 次调用，最多 15 次」。

| 步骤 | 预计 | 最多 | 为什么 |
|---|---|---|---|
| 小说配置 | 1 | 3 | 截断时整份重来 1 次；「全局要求」不合格时只重写这一节 1 次 |
| 故事前提 / 世界观 / 情节大纲 | 1 | 1 | 单份 Markdown，不重试 |
| 角色图谱 | 2–4 | 16 | 身份清单 1 次（截断再 1 次），详情每批 3 人；截断时拆半，另留 1 次语法修复 |
| 细纲一批 n 章 | 1 | 3n | 上游 `blueprint-batch-policy.ts`：拆半全树 2n−1 + 每章一次紧凑重建 n + 一次语法修复 1 |

批量动作的确认框按批次加总报。

### 5. 结构化输出的三种合同与降级

一律「JSON → 不合格就修 → 修不好就说」，**批次细纲 fail-closed，单份文档宽松**：单份文档摊在卡片上，作者看得见缺了什么；批次里没人逐份过目，漏一章就会让流水线从此撒谎。

**小说配置**（上游 `generate_global_config` + `buildNovelConfigJSONContract` + `novel-config-expansion.ts`）
- 模型面向的字段沿用上游英文键（`coreOutline` / `worldSetting` / `goldenFinger` / `protagonistProfile` / `globalGuidance` / `writingStyle` / `referenceWorks` + 五个选择字段），解码时映射到 `config.md` 的七节与 frontmatter；「一句话」一节就是作者的原话。
- 截断（`stop: maxTokens`）→ 丢弃，整份重来 1 次；`globalGuidance` 不合格（>600 字、行数不在 4–8、逐章大纲行 ≥2）→ 只重写这一节 1 次；仍不合格就原样保留并写进说明（上游这里直接作废，这里改成宽松：卡片上看得见，写进去也能手改）。
- 从「一句话」弹窗发起、而 `config.md` 已有内容时，照上游 `mergeExpandedNovelConfig`：长文本保留作者原文、生成的追加在后；类型 / 受众 / 结构 / 视角作者写过的不改。
- **`writingStyle` 写进 `style.md`，只在它还空着时**（D14：文风唯一出处是 `style.md`；第 3 条：有内容就不动，并在卡片上说一句）。
- 规范化结果就是将要落盘的 `config.md` 全文（外加一节「文风」），气泡里看到的就是会写下去的。

**角色图谱**（上游 `GenerateCharactersCommand` 两段式 + `prompt-language.ts` 的身份 / 详情合同）
- 第一步身份清单 `{"slots":[{slotId,name,role,narrativeDuty,relations:[{targetSlotId,relation}]}]}`：3–8 人、名字与 slotId 唯一、至少一个 protagonist、关系闭合不自指。不合格直接报错（上游同样作废）；截断重来 1 次。
- **补上上游没发出去的设计原则**：上游内置模板的 `character_dynamics.content`（盟友 / 对手 / 灰色角色、避免脸谱化）从来没进 prompt——`renderPromptTaskGuidance` 只发 `taskGuidance`，内置模板没有这个字段（AC:1347-1357）。这里把它写进第一步的任务。
- 第二步详情每批 3 人，字段直接对到角色卡七节：`身份 / 外貌 / 性格 / 语言习惯 / 当前状态 / 未收伏笔`，每节有字数上限（第 15 条）；「人物关系」由冻结清单生成，不让模型写。截断拆半，另有 1 次语法修复。
- 规范化结果是 `{"characters":[…]}`（卡片的七节 + role + aliases）。

**细纲批次**（上游 `chapter_blueprint_chunk` + `blueprint-semantic-contract.ts` + `structured-batch-executor.ts` + `structured-syntax-repair.ts`）
- 合同 `{"blueprints":[{chapterNumber,title,role,purpose,keyEvents,characters,newCharacters?,suspenseHook}]}`，三个正文字段对到 D3 的三节（本章目的 / 关键事件 / 章末钩子）。不要上游的 `relationships`（D3 没有它的位置）。
- 超长字段截断而不作废（上游 `decodeGeneratedBlueprints` 同样处理 `value_too_long`）。
- 降级链照搬 SBE：截断且多章 → 对半拆；截断且单章 → 单章紧凑重建（每章至多一次）；JSON 语法坏 → 一次语法修复，修复只许改标点与闭合（`preservesStructuredJsonEvidence`），改了事实就拒绝；解码失败多章拆半、单章紧凑重建；重复章、越界章 → 报错；**漏章且没有截断证据 → 报错，整批不写**（fail-closed）。
- 拆出来的后一半要看得见前一半刚生成、还没落盘的结果：装配器的「前序细纲一览」把它们接在磁盘上那些后面。
- 新角色（`newCharacters`）在细纲写入时直接建卡（D19），卡片上列出会新建哪几张；同名卡已有的不动。
- **单章**细纲（「写第 N 章细纲」「落定细纲」）也用这份合同的单项形式（第 22 条：两个入口契约一致），但解析宽松：蓝图 → 中文键 JSON → Markdown 小节 → 全文塞进关键事件，不走修复链。

### 6. 生成链（`generation/structured.ts`，新）

```ts
interface ChainIO {
  call(messages: AgentMessage[], label: string): Promise<{ text: string; stop?: StopSignal }>;
  build(patch: Partial<BuildRequest>): Promise<AgentMessage[]>;
  signal: AbortSignal;
}
completeConfig(first, io, ctx) / completeRoster(first, io) / completeBlueprints(first | undefined, io, chapters)
  → { raw, notes, calls, … }   // 失败抛 ChainError（人话）
```

- 对话页：`generate` 第一次流式调用之后，按产物种类接上对应的链；后续调用照样流进同一个气泡（每步前面一行「——第 2 步：角色详情（第 1–3 人）——」），链结束后气泡换成规范化结果。链失败：气泡保留已收到的全部输出，报错，不出卡片；失败挂在那一章 / 那一件上（第 16 条）。
- 批量：同一套链，`call` 走分档池的非流式调用。
- 链里所有模型调用用同一个模型（对话页用作者选的那一个，第 12 条）、同一档思考深度（第 26 条：对话页带，批量不带）。

### 7. 落盘（`generation/accept.ts`）

| 产物 | 落法 |
|---|---|
| 小说配置 | 整份写 `config.md`（已有内容时审阅）；「文风」一节只在 `style.md` 空着时写进去 |
| 前提 / 世界观 | 不变 |
| 角色图谱 | 每人一张卡；**同名卡走覆盖审阅**（一张一审，总计划二期条目）；新卡直接建 |
| 情节大纲 | 带区间时按 §2 合并，再整份写（有内容时审阅） |
| 细纲（单章） | 不变；新建时 `targetWords` 缺省取配置的每章字数（D3：必填） |
| 细纲批次 | 逐章：已排过的审阅覆盖，空壳直接填，没有的新建；然后给 `newCharacters` 建卡 |

### 8. 协议与会话

- `SendPayload` 加 `setup?: { totalChapters; wordsPerChapter }`（一句话弹窗带过来的规模）；`range` 不再只透传。
- `ChatTurn` 记 `range` 与 `setup`，「重来一轮」据此原样重跑。
- `Draft` / `SessionDraft` 加 `range`、`notes`、`calls`。
- `SerializedArtifact` 加 `creates?: string[]`（会新建的角色卡）与 `notes?: string[]`。
- `projectAction` 消息加 `range?`；`ProjectAction` 加 `completeSettings`。
- `NextStepView` 加 `form?: 'idea'`（主按钮打开一句话弹窗而不是直接发送）与 `formDefaults`；`ProjectTree` 加 `book`（弹窗默认值：一句话原文、总章数、每章字数、大纲覆盖、配置有没有内容）。
- `LlmTask` 加 `setting`（故事架构，默认精标档：全书只跑一次，后面每一章都吃它）。

### 9. 本期不做

- 架构四件与大纲的 ⟳（上游变了的提醒）：要在每份文档里记上游指纹，而大纲是作者高频手改、没有 frontmatter 的纯 Markdown，留到之后与指纹链一起定。
- 大纲截断后自动续写（上游有断点续写）：截断只写进说明，下一步按钮会因为覆盖不到而再推「续写情节大纲」。
- 单字段生成的独立入口（总计划 §1 #2）：本期只在配置链内部用于「全局要求」重写；作者要单独重写一节时，在对话里对小说配置说「只改全局要求」即可（生成即修改意见）。

---

## 提交节奏（9 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `feat(model)` | 结构指导、大纲合并、批次规划与调用次数（纯函数 + 单测） |
| 3 | `feat(features)` | 三种结构化解码与语法修复证据校验（纯函数 + 单测），`artifact.ts` 接上 |
| 4 | `feat(context)` | 移植的提示词、四个新层与三张配方 |
| 5 | `feat(generation)` | 生成链、`generate` 接链、落盘分派、协议与会话字段 |
| 6 | `feat(features)` | 批量拆细纲按批、补齐设定、`setting` 档位、文风提取并入约束 |
| 7 | `feat(media)` | W3 表单弹窗、W4 一句话、W5 拆细纲、工具栏与主按钮的调用次数 |
| 8 | `test` | 假模型跑通「一句话 → 第 1–5 章细纲」与三种降级 |
| 9 | `docs` | 本期动到的模块 README |

---

### Task 2：纯函数（commit 2）

- Create `src/core/model/structureGuide.ts`：`structureStages(structure, total)`、`structureGuideText(structure, total, range?)`、`structureStagesIn`。
- `src/core/model/outlineFile.ts` 加 `mergeOutline(existing, incoming, range)`。
- `src/core/model/pipeline.ts`：`BookFacts.plotFilledNos`、拆细纲区间、`planPlotBatches`、`CallEstimate` 与各档的 `calls`、`form: 'idea'`。`views/pipeline.ts` 的 `buildBookFacts` 补 `plotFilledNos`。
- 测试：六种结构在 20 / 30 / 100 / 1000 章下区间连续、覆盖 1..total；总章数小于段数时不抛；合并的四种情形（空旧稿、替换中间一节、追加在后、保留前言）；批次规划跳过已有、切连续段、≤5 一批；拆细纲区间在第 N+2 章已有细纲时收在 N+1。

### Task 3：解码（commit 3）

- Create `src/core/features/structuredJson.ts`：`stripFence`、`isRepairableJsonSyntax`、`preservesJsonEvidence`（照搬上游的词法证据比较）。
- Create `src/core/features/blueprint.ts`：`decodeBlueprints(text, chapters)` → `{ ok, items } | { ok: false, diagnostic }`，外加宽松版 `firstBlueprint(text)` 给单章用。
- Create `src/core/features/roster.ts`：`decodeManifest`、`decodeDetails(text, slots)`、`assembleRoster(slots, details)`。
- Create `src/core/features/novelConfig.ts`：`decodeNovelConfig`、`isGlobalGuidanceValid`、`preserveAuthorText`、`mergeWithAuthor`、`renderConfigDraft`（config.md 全文 + 「文风」节）。
- `features/artifact.ts`：`plotBatch` 产物；配置草稿带 frontmatter 时按 `parseBookConfig` 读；单章细纲先认蓝图单项。
- 测试：每种解码的合格 / 缺字段 / 超长截断 / 围栏 / 裸数组；清单闭合、自指、重复名；修复证据：只补闭合括号通过、改了一个字不通过。

### Task 4：提示词与装配（commit 4）

- `context/prompts.ts`：
  - 配置、前提、角色（两步）、世界观、情节大纲、细纲批次 / 单章、语法修复、「全局要求」字段重写的职责、任务与输出契约，各注明上游出处；
  - 系统提示改成可带 `setup` / `range` / 链步骤的形式；
  - 细纲批次带节奏规则（第 1–3 章在批内时带黄金三章）与容量合同（上游 `blueprintCapacityGenerationContract`，目标字数取配置）。
- `context/types.ts`：`BuildRequest` 加 `range`、`setup`、`step`（角色详情 / 紧凑重建）、`draftPlots`；新层 `rosterDoc`、`outlineSlice`、`plotList`、`structure`，新条目种类 `guide`。
- `context/layers/`：四个新层的实现；`focus` 认 `range`（前文边界取 `from`，后文取 `to` 之后）。
- `context/recipes.ts`：按总计划 §2.3 改架构、大纲、细纲三张。
- `context/builder.ts`：新条目的小节标题与顺序；配置 / 细纲的输出契约拿得到 `BookConfig`。
- 测试：三张配方的层与优先级；提示词里设计原则、六种结构、黄金三章、容量合同都在；角色详情那一步带着冻结清单。

### Task 5：生成链与落盘（commit 5）

- Create `src/core/generation/structured.ts`（§6）。
- `generation/generate.ts`：记第一次调用的 `stop`；按产物种类接链；`Draft` 带 `range` / `notes` / `calls`；链失败时保留原文、报错、记失败。
- `generation/accept.ts`：§7 的落法。
- `controller/chat.ts`：`range` / `setup` 进会话与生成请求（对话页批次钳到 ≤5 章）；卡片的落点与说明写区间、新建角色卡与降级说明；批次覆盖判定。
- `model/session.ts`、`generation/drafts.ts`、`protocol/`：§8 的字段。
- 测试（集成）：配置截断重来、全局要求重写、作者原文保留、文风进 `style.md`；角色两步与同名审阅；细纲批次截断拆半、缺字段紧凑重建、语法修复、漏章 fail-closed（磁盘一个字节不动）、新角色建卡；大纲按区间合并。

### Task 6：批量动作（commit 6）

- `features/pipelineBatch.ts`：`generatePlots(project, { range?, confirmed? })` 按 `planPlotBatches` 逐批串行、一批失败即停；每批写完再装配下一批。`completeSettings(project)`：配置（只在有「一句话」可用时）→ 前提 → 角色（一张卡都没有时）→ 世界观，只补空白，确认框报次数。
- `model/tiers.ts`：`setting` 任务；`plotOutline` 的说明改成「每批 5 章一次调用」。
- `controller/project.ts`、`tools/novel/run.ts`：接上新签名（agent 的 `run` 不带区间，走确认框）。
- `features/stylePrompt.ts`：并入上游 `analyze_writing_style` 的任务边界（只学技法、不复述情节 / 角色名 / 地名、不抄原句、不把样本缺点当要求）。
- 测试：区间里已有细纲的章跳过、一批失败后面不跑、确认框的次数与计划一致；补齐设定只补空白。

### Task 7：前端（commit 7）

- Create `media/src/view/form.ts`（W3）：通用表单弹窗，复用 `providerModal` 那层遮罩（两形态都装配了它）；字段有多行文本、数字、章号区间；实时说明；Ctrl+Enter 提交、Esc 取消。
- W4「一句话」：主按钮 `form: 'idea'` 时打开；「故事架构」组小说配置那一行的右键「从一句话生成…」也打开。脑洞、总章数（默认 100）、每章字数（默认 3000），实时显示全书字数；配置已有内容时写明「保留原文，追加生成」。提交后切到对话页、发 `send`（带 `setup`）。
- W5「拆细纲」：工程页工具栏「拆细纲…」与章节组右键打开；区间默认「下一可写章起 5 章」；实时说明跳过几章、分几批、预计 / 最多几次调用（同一个 `planPlotBatches`）；提交发 `projectAction: generatePlots` 带 `range` 与已确认。
- 工具栏加「补齐设定」；故事架构组里第一件没填的那一行给「去生成」（与「去写这一章」同一个道理）。
- 主按钮提示后面写调用次数。
- DOM 测试：弹窗的默认值、实时说明、提交发出的消息；主按钮 `form: 'idea'` 打开弹窗而不直接发送。

### Task 8：验收用例（commit 8）

`tests/integration/generation/blueprintChain.test.js`：假模型按脚本应答，经 controller 从空工程走「一句话 → 配置 → 前提 → 角色图谱 → 世界观 → 大纲第 1–20 章 → 第 1–5 章细纲」，每一步答卡片「写入」，断言磁盘上的文件、主按钮每一步落在哪、总调用次数。

### Task 9：README（commit 9）

只改本期动过、现在描述已经错了的段落：context、generation、features、model、media、tests。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- 假模型跑通 Task 8 那条链；截断、缺字段、漏章三种降级各有测试。
- 独立版新建空工程：主按钮是「生成小说配置」，点了打开一句话弹窗；工程页工具栏有「补齐设定」「拆细纲…」。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「二期：架构 + 大纲 + 细纲批次的生成」。先读 `docs/design/plans/2026-09-30-blueprint-pipeline-phase2.md` 全文、根目录 AGENTS.md、总计划的 §1 与 §4，以及一期计划的「本期定下的模型」。上游源码在 `~/workspace/AI-Novel-Writer`，移植的提示词在注释里注明出处。按 Task 2→9 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 5、Task 8 结束时跑 `npm run test:node`，Task 9 结束时再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。遇到计划里没写到、又会改变产品行为的决定，停下来问。
