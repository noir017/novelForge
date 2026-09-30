# 一期：一章一纲的数据层与状态机 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：26 条产品承诺，本期直接关系到第 1、2、3、8、9、18、20、21 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §2（目标态）、§3.3 的 W1/W2、§4（D13–D24）。
> 3. [设计](../specs/2026-09-29-blueprint-pipeline-design.md) 的 D1–D3、D11。
> 4. 前置：零期已合入（`403a6ac`..`028faa6`）。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 把「大纲 → 卷 → 剧情段 → 中转站 → 拆章」换成「架构 → 大纲 → 细纲（一章一份）→ 正文（直接落 `chapters/`）」的数据层、状态机、协议与界面骨架。本期**不移植任何新提示词**（那是二、三期），只保证：新链路的每一层都有落点、状态机算得对、主按钮指得准、工程还能跑。

**Architecture:** 自底向上。先加纯函数的新格式（零消费者，单测先绿），再做一次大切换（状态机 + 所有消费者 + 删卷与中转站），最后是前端骨架与夹具。

**Tech Stack:** TypeScript、`node:test`、jsdom（DOM 测试）、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试（corePurity / shellPurity / layerBoundary）全程要绿。
- 老工程磁盘上的 `volumes/`、`manuscripts/`、`scenes/`、老四节细纲**一个字节都不动**：代码不读它们（`kindOfPath` 判成 `other`），`guard.ts` 继续把这几个目录列为受保护目录。
- **解析一律不抛**（第 1 条）：老四节细纲读进来就是「三节全空」，状态机如实说「待写细纲」，不崩。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。
- 只删与卷、段、中转站、拆章直接相关的代码与测试，别的测试一条不许红。

---

## 本期定下的模型（写进代码注释）

### 阶段、能力、目标

```ts
type CreationStage = 'setting' | 'outline' | 'plot' | 'manuscript';
// 架构 / 大纲 / 细纲 / 正文
type Capability = 'discuss' | 'generate' | 'settle';          // 删 split
type SettingDoc = 'config' | 'premise' | 'characters' | 'world';

type CreationTarget =
  | { kind: 'setting'; doc: SettingDoc }
  | { kind: 'outline' }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'manuscript'; plotRelPath: string };
```

- `STAGE_CAPABILITIES`：setting / outline / manuscript 是 `[discuss, generate]`，plot 是 `[discuss, settle, generate]`。
- 老会话兼容（`normalizeAction` / `normalizeTarget`）：
  - `volume` → `outline`，`scene` → `plot`；
  - `split` → `generate`；
  - `setting` 带着认不出的 `doc` → `config`。
- 界面叫法：
  - 阶段 `setting` 叫「架构」，避免和设定条目（lore，界面上叫「设定」）撞名；
  - 四件文档依次叫「小说配置 / 故事前提 / 角色图谱 / 世界观」。

### 单章状态机

`PlotStage = 'plot' | 'manuscript' | 'finalize' | 'done'`，对应「待写细纲 / 待写正文 / 待定稿 / 已完成」。

判据（`written` = 同号章节存在且字数 > 0）：

| 条件 | 阶段 |
|---|---|
| `!written && !plotFilled` | plot |
| `!written && plotFilled` | manuscript |
| `written`，摘要存在且不过期，或 `markedDone` | done |
| `written`，细纲在正文之后改过（`upstreamStale`） | manuscript（重写） |
| `written`，字数不到目标的 80% | manuscript（接着写） |
| 其余 | finalize |

- 目标字数取细纲的 `targetWords`；没有就取 `config.md` 的 `wordsPerChapter`；两者都没有时「有字就算写够」。
- `finalize` 的主按钮是 `projectAction: 'finalizeChapter'`。**本期只做摘要**，四期再补角色状态；按钮文案本期写「定稿（生成摘要）」。

### 全书状态机（纯函数，controller 只取数）

```ts
interface BookFacts {
  settings: Record<SettingDoc, boolean>;   // 各自有没有实质内容
  outlineFilled: boolean;
  outlineCoverage: number;    // 大纲按章号区间覆盖到第几章；有内容但没有区间标题时视为 Infinity
  totalChapters?: number;     // config.md
  nextChapterNo: number;      // 从第 1 章起连续有正文的最大章号 + 1
  nextPlotFilled: boolean;    // 那一章有没有排好的细纲
}
type BookStage = 'setting' | 'outline' | 'plots' | 'writing' | 'complete';
```

按顺序取第一个不满足的：
1. 四件设定按 config → premise → characters → world 的顺序，缺哪件推哪件；
2. 大纲缺失，或 `nextChapterNo > outlineCoverage` → 生成 / 续写情节大纲，区间是 `[coverage+1, min(total, coverage+20)]`；
3. `!nextPlotFilled` → 拆细纲，区间是 `[N, min(N+4, coverage, total)]`；
4. 已经写满 `totalChapters` → complete，不给按钮；
5. 否则进入第 N 章的单章状态机。

`NextStepPlan` 新增 `range?: { from: number; to: number }`，本期只用来显示和透传。**本期的「拆细纲」一次只生成区间里的第一章**；按区间一次出 5 章是二期的事。

### 一条轴

- 细纲 `plots/NNN-标题.md` 平铺，不再按卷分子目录；`plots/` 下子目录里的文件判成 `other`。
- 细纲号 = 章号。第 N 章的细纲、正文、摘要按号互认，**只在 `views/pipeline.ts` 的一个函数里做**（`chapterOfPlotNo`）：同号的章节有多份时取路径排序第一份，并记一条 warn。
- 正文落点：同号章节已存在就用它；否则是 `chapters/NNN-<细纲标题>.md`。解析落点要读盘，所以是 async 的 `chapterTargetOf(project, plotRelPath)`（views/pipeline.ts），**不放进纯函数 `pathOfTarget`**。

### 细纲格式（D3）

```markdown
---
no: 12
title: 夜入青云
role: 小高潮
characters: [林昭, 沈青]
targetWords: 3000
upstreamHash: …
writtenFrom: …
status: done        # 可选，作者手工宣布
generatedBy: novel-forge
---
# 第12章 夜入青云
## 本章目的
## 关键事件
## 章末钩子
```

- `isPlotFilled`：「关键事件」非空才算排过。
- `characters[]` 不进 `buildCastIndex`（D13）。
- **`writtenFrom`**：正文依据的细纲指纹，由正文落盘路径（accept 与批量写正文）写进细纲自己的 frontmatter。
  - `upstreamStale` 的判据是 `writtenFrom && writtenFrom !== plotContentHash(plot)`。
  - 为什么记在细纲这一侧：章节可以是 `.txt`、没有 frontmatter，而且是作者的文件（第 9 条），只能记在细纲这边。这和从前 `chapters:` 字段是同一个理由。
  - 作者手写的正文没有 `writtenFrom`，所以永远不会被标脏（第 18a 条）。
- `upstreamHash`：大纲里**覆盖本章的那一节**的指纹，找不到对应区间就用全书大纲的指纹。这样改第 21–40 章那一节，不会让第 1–20 章的细纲挂 ⟳。

### 设定文档与大纲区间

- `model/settingFile.ts`：四件文档的路径、小节表、`isSettingFilled`、解析与渲染。
  - `config.md` 的 frontmatter 字段见总计划 §2.1，数字字段用 `asNumber` 容错。
  - `characters` 这一件没有自己的文件，「有没有」看 `characters/` 下有没有至少一张卡。
- `model/outlineFile.ts`：
  - `parseOutlineRanges(text)` 认 `## 第a–b章：标题` 与 `## 第N章：标题`（横线接受 `-–—~～至到`，冒号接受中英文），返回 `{from, to, title, text}[]`；
  - `outlineCoverage(text)` 返回覆盖到的最大章号；
  - `outlineSliceFor(text, no)` 返回覆盖第 `no` 章的那一节。

---

## 提交节奏（7 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `feat` | 纯函数新格式：`settingFile`、`outlineFile`，以及细纲 D3 格式的解析与渲染（新文件 `blueprintFile.ts`，暂不接线） |
| 2 | `refactor` | **大切换 · 模型与网关**：`pipeline.ts` 新状态机，`plotFile.ts` 换成 D3，删 `volumeFile.ts`；`project.ts`、`types.ts`、`kind.ts`、handlers、`workspace/index.ts`；删 `splitChapter.ts` |
| 3 | `refactor` | **大切换 · 装配与生成**：context 各层与配方、`prompts.ts` 的过渡版契约、`artifact.ts`、`accept.ts`、`generate.ts`、`pipelineBatch.ts` |
| 4 | `refactor` | **大切换 · 视图、协议、controller、工具、agent** |
| 5 | `refactor` | 前端骨架：W1 + W2（工程页「故事架构」组 + 一轴章节列表，流水线条三格，删掉目标字数输入框） |
| 6 | `test` | sample-novel 重做 + 契约测试 |
| 7 | `docs` | 本期涉及的模块 README 同步（全量改写留到六期） |

commit 2–4 之间**允许**测试红，但 typecheck 必须过；commit 4 结束时 `test:node` 全绿。实在拆不开的话，2–4 合成一个 commit。

---

### Task 1：纯函数新格式（commit 1）

**Files:**
- Create：`src/core/model/settingFile.ts`、`src/core/model/outlineFile.ts`
- Create：`tests/unit/model/settingFile.test.js`、`tests/unit/model/outlineFile.test.js`
- 细纲 D3 格式直接写在 Task 2 的 `plotFile.ts` 里；这里先把 `outlineFile` 的区间解析做好，Task 2 就能直接用。

**测试要点：**
- 区间标题的各种写法：`第1-20章`、`第1–20章`、`第 21 至 40 章`、`第7章`、全角冒号 / 半角冒号 / 没有冒号；
- 不连续的区间、重叠的区间：以先出现的那一节为准，不抛；
- `config.md` frontmatter 写坏时各字段退化成 undefined；数字字段是字符串时转成数字；
- `isSettingFilled` 不把占位文字（`（待补充）`）当作内容。

### Task 2：模型与网关（commit 2）

**`model/pipeline.ts`** 按上面的模型整份重写：
- 保留 `chapterLabel`、`isFallbackChapterTitle`、`labelOf`、`commandsFor`、`describeTarget`、`targetKey`、`manuscriptRatio`；
- 删 `volumeLabel`、`segmentLabel`、`segmentDisplayNo`、`volumeOfTarget`；
- 新增 `SETTING_DOCS`、`SETTING_DOC_LABEL`、`settingOfTarget`；
- `deriveBookStage` / `deriveBookNextStep` 换成新签名，`deriveBookNextStep` 返回带 `target` 与 `range` 的计划：
  - `plots` 那一档的 target 路径由 controller 用 `plotPathForNo` 补；
  - `writing` 那一档返回 undefined，controller 转去问第 N 章的单章状态机。

**`model/plotFile.ts`**：
- 换成 D3 格式；
- `Plot` 删 `arc` 和 `chapters`，加 `role`、`characters`、`writtenFrom`；
- 渲染出的标题行是 `# 第N章 标题`；
- 文件名规则不变（三位数前缀）。

**删 `model/volumeFile.ts`**，同时删 `chapterFile.ts` 里的 `splitByMark` 等拆章函数。

**`model/project.ts`：**
- 删 `volumesDir`、`plotsDirForVolume`、`plotsMirrorRelPathForVolume`、`manuscriptsDir`、`plotStem`、`manuscriptPathForPlot`、`manuscriptMirrorRelPath`、`listVolumes`、`readVolume`、`nextVolumeNo`、`listPlotsOfVolume`、`readManuscript`；
- `listPlots` 只扫 `plots/` 根目录；
- 加 `configPath`、`premisePath`、`worldPath`，以及 `readSetting(doc)`、`readConfigDoc()`（返回解析好的 config）；
- `initialize` 不再建 `volumes/`、`manuscripts/`，改为写入 config / premise / world 的模板；大纲模板去掉「分卷规划」一节，换成区间示例；
- `nextPlotNo` 改成「下一个没有细纲的章号」。

**`model/types.ts`**：删 `Manuscript`；`Chapter` 与 `ManifestChapter` 的注释里去掉中转站。

**`workspace/kind.ts`：**
- `ArtifactKind` 删 `volume`、`manuscript`，加 `setting`（同时带上 `doc`）；
- `plots/` 下只认根目录的文件；
- `pathOfTarget`：setting 返回对应文档路径；`characters` 那一件返回角色目录；manuscript 抛错，提示调用方改用 `chapterTargetOf`。

**handlers：**
- 删 `volume.ts`、`manuscript.ts`；
- `plot.ts` 的上游指纹换成大纲切片的指纹（`outlineSliceFor`），删掉伴生搬迁（没有中转站了）；
- 加 `setting.ts`：纯文本加 frontmatter，不记账；
- `types.ts` 删 `appendSeparator` 的「拆分候选点」语义，缺省只空一行。

**`workspace/index.ts`：**
- 删 `writeVolume`、`deleteVolume`、`appendToManuscript`、`splitManuscript`；
- `writePlot` 去掉 `dir` 参数；
- 加 `recordWrittenFrom(plotRelPath)`：用 `rewriteFrontmatter` 只改细纲的 frontmatter。

**`workspace/guard.ts`**：受保护目录表加上 `.novelforge/volumes`（原来漏了）。

**删 `features/splitChapter.ts`** 及其调用点。

### Task 3：装配与生成（commit 3）

- **`context/layers/`：**
  - `artifacts.ts` 删卷的三层；`plotSelf` / `plotPrev` / `plotNext` 改读 D3 三节；
  - `focus.ts` 按章号认，不再回落到中转站，删 `segmentsOfVolume`；
  - `render.ts`：新细纲的渲染；`selectCharacters` **优先**取本章细纲的 `characters[]`，其次才是原有判据（D13）。
- **`context/recipes.ts`：**
  - 删 volume，加 setting（system、ask、config、已有的三件文档、历史）；
  - 正文配方本期**不加新层**（三期做），只把数据源从中转站换到 `chapters/`。
- **`context/prompts.ts`：**
  - 删拆卷、拆段的职责与契约；
  - 加 setting 的**过渡版**职责与契约：按该文档的小节输出 Markdown，二期换成移植的提示词；
  - 细纲契约换成 D3 三节，并删掉「不写画面」的禁令（第 21 条本期先改代码，文字六期再改）。
- **`features/artifact.ts`：**
  - 删 `volumeList`、`plotSegment`、`parsePlotList`；
  - 加 `settingDoc` 产物（落点由 target 决定）；
  - `plot` 产物换成 D3 三节，外加 `role`、`characters`、`targetWords`、`title`。
- **`generation/accept.ts`**：五条分支变成 setting / outline / plot / manuscript 四条：
  - manuscript：`chapterTargetOf` → 章节不存在就 `create`，写入时带 `# 第N章 标题`；存在就 `append`，中间空一行。然后 `recordWrittenFrom`，再 `syncManifest`。
  - 覆盖 / 重写的语义留到三期定，本期保持从前「接着往下写」的行为。
- **`generation/generate.ts`**：失败挂在细纲路径上（不变），正文落点换掉。
- **`features/pipelineBatch.ts`**：
  - `generatePlots`：给「有章号、没有排好细纲」的章一章一次地补，不再按卷；
  - `writeManuscripts`：写到 `chapters/`；并发先保持原样，四期改成串行。
- **`model/tiers.ts`**：删 volume 相关的任务说明。

### Task 4：视图、协议、controller、工具、agent（commit 4）

- **`views/pipeline.ts`：**
  - `buildPlotPipeline` 按号合并细纲与章节；
  - `buildPipelineIndex` 返回 `rows`：1..max(细纲号, 章号) 的**每一个章号**一行，缺号的不补空行；
  - 删 `segments`、`displayNo`、`consumed`、`chaptersOfSegment`；
  - 加 `buildBookFacts(project)`，供 controller 与 agent 共用（第 20 条：同一份事实）。
- **`views/projectView.ts`：**
  - `ProjectTree` 删 `volumes`、`volumeCount`、`segmentCount`、`volumesRoot`；
  - 加 `architecture: ArchitectureRow[]`（五行：四件文档加情节大纲，每行带 `filled`、`upstreamStale`、`detail`）和 `bookStage`；
  - `ProjectPlotNode` 删 `kind`、`manuscriptPath`，一行就是一个章号。
- **`views/workbench.ts`**：setting / outline / plot / manuscript 四种浮窗；正文层的浮窗显示本章细纲的三节加字数（顺带修掉 §3.1-7）。
- **`protocol/`：**
  - `views.ts`、`in.ts` 跟着改；
  - `ProjectAction` 删 `newVolume`、`splitManuscript`，`summarizePlot` 改名 `finalizeChapter`；
  - `SendPayload` 删 `targetWords`（W1），加可选的 `range`。
- **`controller/chat.ts`：**
  - `pushPipeline` 在单章状态机返回 undefined 时，退回到全书下一步；
  - `bookNextStep` 改用 `buildBookFacts` + 纯函数；
  - `selectPlot` 按号认章：给章节路径时找同号细纲的**应在**路径。
- **`controller/project.ts`**：`newPlot` 为下一个没有细纲的章号建空壳；删 `newVolume`、`splitManuscript`；`finalizeChapter` 本期走原来的 summarize。
- **`tools/novel/`：**
  - `generate` 接受章节路径：按号解析出细纲，作为 manuscript target；描述文案同步；
  - `run` 删 `split`；
  - `list`、`search`、`naming` 改文案和枚举。
- **`agent/context.ts`**：状态简报换成全书状态加当前章，用 `buildBookFacts`。
- **`model/session.ts`**：老会话按上面的兼容规则回落。
- **`shells/vscode/quickContinue.ts`**：manuscript target 改成按章号解析。

### Task 5：前端骨架（commit 5）

- **`media/src/view/pipeline.ts`**：
  - 面包屑写「第 N 章《标题》」或「故事架构 · 故事前提」；
  - 三格是「细纲 · 正文 · 定稿」；
  - 删掉卷那一格。
- **`composer.ts`**：主按钮发 `step.target` 与 `step.range`（修 §3.1-1）；删 `#targetWords`。
- **`state.ts`**：目标下拉只列章号行，「新建细纲」落到下一个没有细纲的章。
- **`project/index.ts`、`groups.ts`、`rows.ts`：**
  - 「故事架构」组五行，组标题写 x/5，右键「打开 / 生成（重写）」；
  - 「章节」组一行一章：`第12章 夜入青云　纲● 文 2980/3000 定稿●`；
  - 删卷组、剧情段、时间线分界线。
- **`panes.ts`**：删过时文案（§3.1-10）和目标字数输入框。
- **CSS**：删卷与段的样式，确认 `verify-css` 没有意外改动。
- **DOM 测试**：
  - 重写 `dom/view/creation.test.js`、`projectTree.test.js` 里跟卷和段相关的组，以及 `tests/helpers/dom.js` 的 `sampleTree` / `pipelineView`；
  - 新增一条断言：主按钮发出的 `send` 带的是 `step.target`。

### Task 6：sample-novel 与契约（commit 6）

- 3 章正文**不动**（否则要同步 contentHash 与 sourceHash）。
- 补 `config.md`（totalChapters 30、wordsPerChapter 400，和现有正文的长度对得上）、`premise.md`、`world.md`。
- `outline.md` 改成按区间分节；3 份细纲换成 D3 格式。
- `tests/contract/sampleNovel.test.js` 删「中转站为空」那一条，加「细纲号 = 章号」「config 能解析」两条。

### Task 7：模块 README（commit 7）

只改本期动过、而且现在的描述已经**错了**的段落：model、workspace、views、context、generation、features、media、tests。AGENTS.md 与根 README 的全量改写留到六期，本期只在 AGENTS.md 顶部加一行「生成链路重构中，以总计划为准」。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- 独立版打开 sample-novel：
  - 工程页有「故事架构」组（5/5）和一轴的章节列表；
  - 主按钮是「写第 4 章细纲」一类（因为 sample 只写了 3 章）；
  - 点了之后发出去的 target 是第 4 章的细纲路径。
- 独立版新建一个空工程：主按钮是「生成小说配置」，点了之后流式输出、出写入卡、能落盘到 `config.md`（过渡版提示词，内容好不好不算验收项）。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「一期：一章一纲的数据层与状态机」。先读 `docs/design/plans/2026-09-30-blueprint-pipeline-phase1.md` 全文、根目录 AGENTS.md、`docs/design/plans/2026-09-30-blueprint-pipeline-roadmap.md` 的 §2 与 §4。按 Task 1→7 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 4 与 Task 7 结束时跑 `npm run test:node` 与 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。老工程的 `volumes/`、`manuscripts/` 目录在磁盘上一个字节都不动。遇到计划里没写到、又会改变产品行为的决定，停下来问。
