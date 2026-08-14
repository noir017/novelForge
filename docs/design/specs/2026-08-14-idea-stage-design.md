# 灵感层设计（脑洞 → 全书大纲）

日期：2026-08-14
状态：待评审

> **注**：本文写于流水线换轴之前，行文里的「章节细纲 / 按章」现在都是**剧情段**
> （`.novelforge/plots/`），`chapters/` 已退成作者自己切正文的发布区。灵感层
> 本身在大纲**之上**，不受那次换轴影响——下面的设计照旧成立，只需把「章」
> 读成「段」。

## 背景与目标

项目定位从「为长篇小说做 LLM 上下文管理」改成**「把一个脑洞养成一本完整的书」**。定位一改，流水线的源头就露出一个缺口：

现在的源头是 `.novelforge/outline.md`。**在它之前的那一步——「这本书到底是个什么东西」——不在工程里**：作者只能在对话框里打一段话，让模型直接吐一份大纲。那段话不落盘、不可讨论、不可挑刺、不可重做，下一次开对话就没了；大纲写歪了也回溯不到「当初我想的是什么」。

本设计补上这一层：**灵感（idea）**，产物是 `.novelforge/idea.md`，与既有四层同构——同样的 Stage × Capability × Target 三维模型、同样的产物解析三层降级、同样的采纳才落盘、同样的零模型调用新鲜度链。

流水线因此变成五层：

```
灵感      →  全书大纲  →  章节细纲  →  场景细节  →  正文
这是个什么故事  故事讲什么   这章发生什么   这幕长什么样   怎么写出来
```

**非目标**：不做「一键从脑洞生成整本书」。灵感层的价值在于把那句话**变成可反复挑刺的产物**，而不是多一个自动化入口。

## 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 产物落点 | `.novelforge/idea.md`，单文件，与 `outline.md` / `style.md` 同级 | 全书唯一一份，没有镜像路径问题 |
| 文件格式 | frontmatter + 固定小节（同细纲/场景卡） | 复用 `pickSections` / `stringifySections`，解析可三层降级 |
| 阶段能力 | `discuss / expand / critique / check / generate / rewrite`，**无 `split`** | 灵感的下一层是一份大纲文档，不是一个清单；「展开成大纲」由大纲层的 `generate` 承担，与 `scene` 层无 split 同理 |
| 新鲜度链 | `idea.md ──hash──▶ outline.md`，hash 记在 `project.json` | `outline.md` 是作者高频手改的纯 Markdown，给它加 frontmatter 会天天撞冲突；manifest 已经是「文件自身放不下指纹」时的落点（正文的 `beatsHash` 就在那里） |
| 灵感进不进正文上下文 | **不进**。只出现在 `idea` 与 `outline` 两张配方里 | 立意已经沉淀进大纲与细纲，写正文时再带一遍是纯浪费；这与「前三层不带正文原文」是同一条取舍 |
| 老工程迁移 | 不自动生成、不强制补。没有 `idea.md` 就是一张空卡 | 已经写了七十章的人不需要被叫回去补一份「立意」 |
| 初始化 | `initialize()` 写入 `IDEA_TEMPLATE`，但**不改**初始化问的那两个问题（书名 / 作者） | 让「先有个名字」变成动笔门槛是反的；名字可以最后再起 |

## A. 领域模型（`src/core/model/pipeline.ts`）

纯类型 + 纯函数层的改动，前端、装配器、编排层共用这一份。

```ts
export type CreationStage = 'idea' | 'outline' | 'plan' | 'scene' | 'manuscript';
export const CREATION_STAGES = ['idea', 'outline', 'plan', 'scene', 'manuscript'];
```

配套的五张表各加一行：

| 表 | `idea` 的值 |
| --- | --- |
| `STAGE_LABEL` | `灵感` |
| `STAGE_QUESTION` | `这是个什么故事？` |
| `STAGE_ROLE` | `选题策划` |
| `STAGE_CAPABILITIES` | `['discuss','expand','critique','check','generate','rewrite']` |
| `DEFAULT_CAPABILITY` | `discuss`（与其余四层一致：默认动作不花钱） |
| `CAPABILITY_LABEL_IN.idea` | `generate: '写下这个脑洞'`、`rewrite: '重写脑洞'` |

`CreationTarget` 加一支：

```ts
| { kind: 'idea' }
```

- `targetKey({kind:'idea'})` → `'idea'`
- `describeTarget` → `'灵感'`
- `chapterOfTarget` → `undefined`（与 `outline` 同）
- `normalizeTarget` 的兜底**仍是 `outline`**：它在任何工程里都存在，改兜底会让老会话的落点漂移

### 全书级流水线状态（新增）

现有 `ChapterStage` / `deriveStage` 回答的是「这一章走到哪了」。灵感层不属于任何一章，需要一个同构的全书级状态机：

```ts
export type BookStage = 'idea' | 'outline' | 'chapters' | 'writing';

export interface BookFacts {
  ideaFilled: boolean;      // idea.md 有实质内容
  outlineFilled: boolean;   // outline.md 去掉模板占位后有内容
  chapterCount: number;
  ideaStale: boolean;       // 大纲所依据的灵感已变（manifest.ideaHash 对不上）
}

export function deriveBookStage(f: BookFacts): BookStage;
export function deriveBookNextStep(stage: BookStage, f: BookFacts): NextStepPlan | undefined;
```

判据自上而下取第一个不满足的：没灵感 → 写灵感；有灵感没大纲 → 生成大纲；有大纲没章节 → 拆成章节；有章节 → 交给既有的按章流水线（返回 `undefined`，创作页照旧按当前章节给下一步）。

`ideaStale` 只影响标记，不改变 `BookStage`——**改了灵感不等于大纲作废**，只是提醒回头看一眼（与 ⟳ 的既有语义一致）。

### 判据为什么不落盘

与 `deriveStage` 同一条理由：状态字段会在作者手删内容之后开始撒谎。`ideaFilled` / `outlineFilled` 每次从磁盘现算。

## B. 文件格式（新增 `src/core/model/ideaFile.ts`）

与 `planFile.ts` / `sceneFile.ts` 同类：纯函数、零 I/O、解析绝不抛。

```ts
export const IDEA_SECTION_KEYS = [
  '一句话',        // logline：一句话说清这本书是什么
  '前提',          // 这个世界/情境哪里不一样，钩子在哪
  '主角与欲望',    // 谁，他要什么，为什么现在
  '核心冲突与代价', // 挡在中间的是什么，输了会怎样
  '结局设想',      // 想收在哪儿（可以只是一个方向）
  '基调与参照',    // 想写成什么味道，像哪几本书
] as const;

export interface Idea {
  relPath: string;
  title: string;          // frontmatter.title，与 project.json 的书名同步显示
  sections: IdeaSections;
  body: string;           // 小节之外作者自己加的内容，读回来时保留
}

export function isIdeaFilled(s: IdeaSections): boolean;  // 一句话 或 核心冲突与代价 非空
export function parseIdeaFile(text: string, relPath: string): Idea;
export function renderIdeaFile(idea: WritableIdea): string;
```

`isIdeaFilled` 只认那两节：只写了「基调与参照」等于什么都没想清楚，流水线该停在 `idea`。占位文字（`（待补充）`）不算内容——复用 `planFile.ts` 里那个 `meaningful`，提取到 `markdown.ts` 共用。

模板（`IDEA_TEMPLATE`，写在 `project.ts` 与其余模板并列）：六个小节 + 每节一句括号提示，与 `OUTLINE_TEMPLATE` 的写法一致。

### `project.ts` 的改动

- `get ideaPath()` → `.novelforge/idea.md`
- `readIdea()` / `writeIdea()`（与 `readOutline` / `writeOutline` 并列，缺文件时返回空 `Idea` 而不是抛）
- `initialize()` 增加 `writeIfAbsent(this.ideaPath, IDEA_TEMPLATE)`
- `ProjectManifest` 增加两个可选字段：

```ts
ideaHash?: string;      // 生成/最后一次采纳 outline.md 时 idea.md 的 hash
```

`MANIFEST_VERSION` 不动：新增可选字段，老 manifest 读进来就是 `undefined`，语义正好是「没有依据、不标脏」。

## C. 新鲜度链

现有链条前面接一节：

```
idea.md    ──hash──▶ outline.md      (manifest.ideaHash)      ← 新增
outline.md ──hash──▶ plans/*.md      (frontmatter.upstreamHash)
plans/X.md ──hash──▶ scenes/X/*.md   (frontmatter.upstreamHash)
scenes/X/* ──hash──▶ chapters/X      (manifest.beatsHash)
chapters/X ──hash──▶ summaries/X.md  (frontmatter.sourceHash)
```

- 采纳大纲（`acceptOutline`）时把当前 `idea.md` 的 hash 写进 `manifest.ideaHash`。
- `manifest.ideaHash` 存在且与当前 `idea.md` 对不上 → 大纲行/大纲面包屑挂 ⟳。
- **`ideaHash` 不存在时不标脏**——手写的大纲（以及所有老工程的大纲）永远不挂 ⟳，与「手写产物不挂 ⟳」的既有规则一致。
- 依然是零模型调用、零 token，只是多比对一个 hash。

**不做级联**：改了灵感只标大纲，不顺着往下把所有细纲一起标脏。⟳ 是「回头看一眼」的提示，不是审计报告；一次改动点亮全书三百行 ⟳，作者会学会无视所有标记。

## D. 上下文装配

### 新增层 `ideaDoc`（`src/core/context/layers/artifacts.ts`）

读 `idea.md`，渲染成 `# 这本书是什么` 段落。空文件时不产出条目（而不是产出一个空段落）。

`ContextItemKind` 与 `LayerName` 各加 `'ideaDoc'`。

### 配方（`src/core/context/recipes.ts`）

```ts
idea: [
  { layer: 'system',      priority: 0, force: true },
  { layer: 'ask',         priority: 0, force: true },
  { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
  { layer: 'ideaDoc',     priority: 0, force: true },
  { layer: 'history',     priority: 1, cap: HISTORY_CAP },
  { layer: 'lore',        priority: 2 },
],
```

这一层**刻意贫瘠**：讨论「这本书是个什么故事」时，大纲、摘要、角色卡都还不存在，或者存在也没用——真正的输入是作者那句话和现有的灵感卡。`lore` 留着是为了一种真实情形：世界观是先搭起来的，脑洞长在它上面。

`outline` 配方在 `outlineDoc` 之前插入：

```ts
{ layer: 'ideaDoc', priority: 0, force: true },
```

于是「从脑洞生成大纲」不需要作者再复述一遍立意——这正是这一层存在的意义。其余三张配方一字不动。

## E. 提示词（`src/core/context/prompts.ts`）

`STAGE_DUTY.idea`：

> 你负责帮作者把一个还很模糊的念头想清楚：这个故事的钩子在哪、主角要什么、挡在中间的是什么、输了会付出什么代价、大致收在哪儿。你不排幕、不分章、不写场景——那是后面几层的事。判断一个故事成不成立，看的是「主角的欲望有没有被真正阻挡」，不是「设定够不够炫」。

`buildOutputContract` 的 `idea` 分支（`generate` / `rewrite`）：要求只输出 JSON，键即 `IDEA_SECTION_KEYS`，并补三条要求：

1. 「一句话」必须能让人一句话之内明白这书是什么，不要写成宣传语。
2. 「核心冲突与代价」要写清失败会失去什么——没有代价的冲突撑不起一本书。
3. 想不清楚的小节留空字符串，不要为了填满而编。

`critique` 在这一层最值钱，沿用通用的「只说问题和改法，不要顺手替他改写」，不额外定制。

`askHeading` 不动（灵感层用通用的 `# 我的要求`）。

## F. 产物解析与采纳

`src/core/features/artifact.ts`：

```ts
| { kind: 'idea'; sections: IdeaSections }
```

- `parseArtifact`：`stage === 'idea'` → `parseIdeaSections(text)`，三层降级（JSON → `## 小节` → 全文塞进「一句话」）。
- `isArtifactEmpty` / `describeArtifact`（`灵感 · 4/6 节`）各加一支。
- 另出一个 `parseIdeaStrict`（只走前两层，不做全文兜底），留给将来可能出现的批量路径；创作页用带兜底的那个。

`src/core/features/creation.ts`：

- `acceptArtifact` 增加 `case 'idea': return this.acceptIdea(artifact.sections)`。
- `acceptIdea` 走 `confirmOverwrite`（已有内容时先对比再决定），与 `acceptOutline` 同形。
- `acceptOutline` 末尾增加一行：把当前 `idea.md` 的 hash 写进 manifest。

## G. 视图与协议

| 位置 | 改动 |
| --- | --- |
| `core/views/pipeline.ts` | 新增 `buildBookPipeline(project): BookPipeline`（取 `BookFacts` → `deriveBookStage` / `deriveBookNextStep`） |
| `core/views/workbench.ts` | `target.kind === 'idea'` 时给出灵感卡：标题「灵感」，摊开六个小节（全书唯一一份，内容短，可以全摊）；空态文案「这本书还只是一个念头。先把它说清楚，大纲从它展开。」 |
| `core/views/projectView.ts` | 「文风与摘要」分组顶部增加**灵感**一行（与全书大纲同类：固定文件，不可改名/删除） |
| `core/protocol/views.ts` | `ProjectView` 增加 `ideaPath`；流水线视图增加 `bookStage` 与 `ideaStale` |
| `core/files/attachments.ts` | `@` 引用候选增加 `idea.md`（与 `outline.md` / `style.md` 并列） |

## H. 前端

- **面包屑**：最左端多一格 `灵感`，点了切到灵感层。链条变成 `灵感 › 全书大纲 › 第 12 章《…》 › 场景 2`。大纲那一格在 `ideaStale` 时挂 ⟳。
- **主按钮（下一步）**：当前没选章节时读 `bookStage`——「写下这个脑洞 → 生成全书大纲 → 拆成章节」。**新工程第一次打开创作页，主按钮是「写下这个脑洞」而不是一片空白**，这是这次改动对新用户最直接的收益。
- **`/` 命令面板**：`commandsFor('idea')` 自动产出六条，前端零改动。
- **工程页**：灵感行右键给「打开 / 讨论这个脑洞 / 重写」，无「删除」。
- 阶段徽章、进度条等按 `CREATION_STAGES` 遍历的地方自动多一格；需要检查前端是否有写死四层的地方（`media/src/view/creation/*` 的流水线条）。

## I. 测试

| 档 | 用例 |
| --- | --- |
| `unit` | `ideaFile` 解析/渲染往返、坏 frontmatter 不抛、`isIdeaFilled` 的占位判定；`deriveBookStage` / `deriveBookNextStep` 全状态覆盖；`STAGE_CAPABILITIES.idea` 不含 `split`；`normalizeTarget('idea')` 与老会话兜底不变；`parseIdeaSections` 三层降级 |
| `integration` | 采纳灵感产物落盘（含覆盖确认）；采纳大纲写入 `manifest.ideaHash`；改 `idea.md` 后大纲标脏、老工程（无 `ideaHash`）不标脏；`idea` / `outline` 两张配方的装配明细 |
| `dom` | 面包屑五格与点击切层；新工程空态的主按钮文案；工程页灵感行的右键菜单 |
| `contract` | 无新增约束；`sample-novel/` 增加一份 `idea.md` 并确认 hash 断言不受影响 |

## J. 分期

| 期 | 内容 | 可独立交付 |
| --- | --- | --- |
| **一** | 领域模型 + `ideaFile.ts` + `project.ts` 读写与模板 + 解析/采纳 + 提示词 + 两张配方 | 能在创作页选「灵感」层讨论并生成产物，写盘可用 |
| **二** | `BookStage` 全书状态机 + 主按钮 + 面包屑 + 工程页那一行 | 新工程有明确的第一步 |
| **三** | `ideaHash` 新鲜度链与 ⟳ | 改了脑洞能看见大纲需要回头 |

一期是主体（八成工作量集中在模型层与解析层，且全部有既有同构实现可抄）；二三期各自小而独立，可以分开评审。

## K. 明确不做

- **不做「一键成书」**：灵感 → 大纲 → 拆章 → 批量细纲这条链每一步都要作者点。
- **不把灵感注入正文上下文**：写第 80 章时带上一份立意宣言，只会挤掉真正有用的前文。
- **不做灵感的多版本管理**（同时养三个脑洞、A/B 对比）。真要比，`idea.md` 是普通 Markdown，Git 分支比任何内置版本机制都好用。
- **不自动为老工程反推灵感**（读全书摘要倒推一份立意）。看起来聪明，实际是拿模型编一段作者从没想过的话，然后把它挂在流水线源头。
