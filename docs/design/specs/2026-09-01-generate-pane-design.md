# 设计：「生成」页 —— 手动调用 generate

> 状态：**已实现**（2026-09-01）。这一份是当时的设计；当下的真相以
> [media/README.md](../../../media/README.md)、[src/core/README.md](../../../src/core/README.md)
> 与 `controller/generate.ts` 的文件头为准。
>
> 与设计有出入的三处，都是实机跑出来之后改的：
>
> - **正文层的候选也列已交付的段**。原设计只列未交付的，而 sample-novel 那样
>   写完的工程里未交付的是零——下拉框会是空的，而作者想做的恰恰是回头重写某一章。
> - **`genTargets` 要带上当前选中的模型**。原设计没说，于是显式挑了模型之后，
>   界面回显的还是自动档那一个——而那一行正是他按下花钱按钮前唯一的依据。
> - **落点候选去掉了「· 正文」那类后缀**，真实路径改挂在选项的 tooltip 上。
>
> 样例页面（当时用来定观感的）：[2026-09-01-generate-pane-mockup.html](2026-09-01-generate-pane-mockup.html)。

## 为什么要有这一页

现在 `generate` 只有一个入口：agent 在对话页里替作者决定「这一次生成什么、
落在哪、带哪几套写法」。作者要精确地生成一份东西，得靠一句话把意图说清，
再指望 agent 把六个 job、一条路径、几个技能名全填对——**填错的代价是花了钱
产出一份不要的东西**，而中间还隔着一层猜。

这一页把那六个参数原样摆出来，作者自己填、自己按。它不比 agent 聪明，
它只是**确定**。

## 一条红线：这一页不和 agent 纠缠

**不碰 `ChatSession`、不碰 `DraftStore`、不碰 `controller/gate.ts`。**

这三样是对话页那条路的状态，agent 循环、气泡、闸门卡片全挂在上面。生成页
借用它们能省一点代码，代价是**又一处「两条路共用一份状态」**——本次重构要
解开的正是这种耦合。所以它自己持有一份 pending draft（一次一份，新的顶掉
旧的），自己那条采纳栏结算，页面关掉/刷新就没了（没落盘的东西本来就不该
活过一次刷新）。

复用的只有**纯函数与无状态模块**：`generation/generate.ts`、`generation/accept.ts`、
`workspace/kind.ts`、`model/pipeline.ts`、`skills.ts`。这几样 agent 也用，
但它们不持有状态，共用不产生耦合。

## 页面结构

tab 顺序：`对话 | 生成 | 工程 | 历史 | 日志 | 设置`（独立版活动栏图标 `✦`）。
DOM 在 `shells/shared/panes.ts` 里定义一次，两个壳共用（壳契约见那份文件头）。

```
┌─ pane-generate ─────────────────────────────────┐
│ ① 产出什么                                       │
│   [ 剧情细纲                    ▾ ]              │
│   排这一段的剧情脉络：发生什么、因果怎么串…       │
├─────────────────────────────────────────────────┤
│ ② 落在哪                                         │
│   [ 剧情 4《楼道》  plots/01-开端/04-楼道.md ▾ ] │
│   ▸ 手填路径                                     │
│   ✓ 剧情层 · 那里已有内容，采纳时会让你先比对     │
├─────────────────────────────────────────────────┤
│ ③ 补充要求                                       │
│   [ textarea，可空 ]                             │
├─────────────────────────────────────────────────┤
│ ④ 目标字数     ← 只在 job=manuscript 时出现      │
│   [ 2000 ]  0 为不限                             │
├─────────────────────────────────────────────────┤
│ ⑤ skills                          已选 1 份      │
│   ☐ 情绪弧线  工程   六种情绪弧线、七种反转…      │
│   ☑ 章节钩子  工程   章首怎么开、章尾怎么断…      │
├─────────────────────────────────────────────────┤
│ ⑥ 用哪个模型                                     │
│   [ 按层自动（剧情层 → 快速档）  ▾ ]             │
│   [ 思考深度：不指定             ▾ ]             │
│   实际会用：glm/glm-4-plus · 窗口 128k           │
├─────────────────────────────────────────────────┤
│ ⑦ [ 生成 ] [ 停止 ]         这一次会调一次模型   │
├═════════════════════════════════════════════════┤
│ ⑧ 输出                                           │
│   ● 正在写… 1,240 字            [ 装配明细 ▸ ]   │
│   ▸ 思考过程                                     │
│   ┌───────────────────────────────────────────┐ │
│   │ 流式正文，可编辑                           │ │
│   └───────────────────────────────────────────┘ │
│   形状：剧情 · 4/4 节                            │
├─────────────────────────────────────────────────┤
│ ⑨ [ 采纳并写入 plots/01-开端/04-楼道.md ]        │
│   [ 不采纳 ]  [ 用同样的参数重来 ]               │
└─────────────────────────────────────────────────┘
```

### ① 产出什么（job）

`<select>`，六项，文案取 `JOB_LABEL`；下面一行取 `JOB_HINT`。**两份都从后端
那一份常量来**，前端不另写——工具描述、gate 卡片、日志用的是同一份，前端抄
一遍就会在改文案时对不上。

窄侧栏里六颗横排的分段控件会折行成两排，`<select>` 不会，所以用它。

### ② 落在哪（target）

**候选下拉为主，手填为辅。**

工具收的是一条裸路径，因为模型手上只有路径。作者手上有的是「第 12 章」
「第二卷」，让他去拼 `.novelforge/plots/01-开端/04-楼道.md` 是把模型的接口
硬塞给人。所以下拉框按**当前 job 所属的层**列候选：

| stage | 候选 |
|---|---|
| `outline` | 只有 `.novelforge/outline.md`，自动填好，下拉框禁用 |
| `volume` | `volumes/` 下各卷，label 用卷号 + 卷名 |
| `plot` | `plots/` 下各段，按卷分组，label 用 `segmentLabel` |
| `manuscript` | `manuscripts/` 下各份 + 已发布的章 |

切 job 时候选跟着换；换 job 后旧落点若不在新名单里就清空，不留一个下一秒
必然报错的值。

`▸ 手填路径` 折叠着，展开是一个文本框：老工程、尚不存在的落点（拆段要往
一卷里加新段，那份细纲还没有）走它。

下面那一行是**实时校验**，把工具的两条错误路径提前到花钱之前：

- 认不出这条路径是哪一层 → 红字，照抄工具那句指路
- 认出来了但与 job 不同层 → 红字，`expectedPathHint` 那句
- 都对 → 绿字「✓ 剧情层」，落点已有内容时补一句「那里已有内容，采纳时会让
  你先比对」（判据是 `targetHasContent`，两件「拆」一律不报覆盖）

### ③ 补充要求（ask）

textarea，可空。placeholder：「留空就按上一层的产物照常生成」。

### ④ 目标字数（targetWords）

`job=manuscript` 时才**渲染**，其余时候整块不在 DOM 里——不是渲染出来再禁用。
一个灰着的输入框只会让人想知道怎么点亮它，而答案是「这个 job 下它没有意义」。

### ⑤ skills

复选列表。**标题就叫 `skills`**，与工具那个参数同名——这一页是那个工具的手动
入口，参数叫什么，界面上就叫什么，中间不再隔一层译名。

**名单一份都不写死。** 来源是后端的 `listGenerateSkills(await listSkills(project,
config.skillModes))`——与工具校验用的**同一个判据**（`audience === 'generate'`
且没被禁用），所以这里勾得上的，那边一定认。切到这一页时拉一次：作者可能
刚写完一份技能，用一份缓存的名单会让新写的那份「明明在磁盘上却选不到」。

**注意内置那两份都不在名单里**：`character-voice` 与 `foreshadowing-audit` 的
`audience` 是 `agent`（缺省值就是它），那是给 agent 自己读的查法，不是交给创作
模型的写法。工程自己写的技能要在 frontmatter 里显式标 `audience: generate`
才会出现在这一页上。

每行显示不带前缀的 `stem` + 一枚来源角标（内置 / 工程）+ 一句 `description`，
`title` 上挂带前缀的全名（`project: 情绪弧线`）——发给后端的是全名，界面上
显示全名只会让每一行都顶着一截重复的前缀。

**空名单是最常见的情况**（绝大多数工程不会自己写技能），那时整块换成一句
虚线框里的指路，把唯一不显然的那一条说清：

> 这个工程还没有可交给创作模型的 skill。在 `.novelforge/skills/<名字>/SKILL.md`
> 里写一份，frontmatter 标上 `audience: generate`，它就会出现在这里。

**不做模糊匹配、不做搜索、不按 job 自动筛**：名单本来就短，勾选没有拼错的
余地；而「哪一份配哪个 job」写在各自的 description 里（「写正文时带上」
「排剧情段时带上」），那是作者读一眼就能判断的事，用代码去猜只会在猜错时
悄悄少带一份。

### ⑥ 用哪个模型

两个下拉：

**模型** —— 缺省「按层自动」，即照抄工具那张表：`plot` 层走 `plotOutline` 档池
（并带上池的 `primaryBudget`），其余三层用 `config.active`。也可以显式挑任一
具体模型，挑了就用它、不走池。

下面一行**回显实际解析到的那一个**（模型名 + 窗口）。「按层自动」不写清算到
了谁，等于让作者在不知道用哪个模型的情况下按下花钱的按钮。池建不出来时这里
如实显示回落到了哪个，与工具里那条 warn 是同一件事。

**思考深度** —— 缺省「不指定」。

工具刻意不带 thinking（第 26 条），理由是 agent 一轮里可能调好几次，每次都按
极限档想一遍，等于把那个下拉框变成一个倍率不明的开关。**这一页不成立**：
作者按一次、生成一次，倍率就在他眼前。

### ⑦ 动作条

| 按钮 | 何时可用 | 干什么 |
|---|---|---|
| **生成** primary | ②校验通过 且 不在跑 | 发 `genRun` |
| **停止** danger | 只在跑时显示 | abort |

右边一句常驻提示：「这一次会调一次模型」。

### ⑧ 输出

- **状态行**：`装配中 → 思考中 → 正在写（实时字数）→ 完成 / 失败 / 已取消`
- **装配明细** ▸：生成结束后展开，画 `BuiltContext`（哪几层、各占多少 token、
  谁被降级成了摘要）。这是这个项目「透明展示」那一条在手动路径上的落点。
- **思考过程** ▸：有 reasoning 增量时才出现，缺省折叠
- **正文区**：流式追加，**可编辑**——采纳前作者能改。采纳时按框里当下的文本
  重新解析，不用 `draft.raw`。
- **形状行**：`describeArtifact` 那一句（「剧情 · 4/4 节」）+ 字数

### ⑨ 采纳栏

有 draft 时才出现。

| 按钮 | 干什么 |
|---|---|
| **采纳并写入 `<相对路径>`** primary | `acceptArtifact`；落点已有内容时文案变**覆盖**，并仍走 workspace 的覆盖审阅 |
| **不采纳** | 丢掉这份 draft，磁盘不动 |
| **用同样的参数重来** | 表单不清空，直接再跑一次 |

解析不出可落盘形状时，采纳按钮不渲染，改成一句「这份产出解析不出这一层要的
结构」——写一个空产物比不写更糟。

## 三条必须与工具一致的行为

1. **校验前置，一分钱不花。** job 与落点不同层、路径认不出、技能名对不上，
   全在点「生成」之前红字说清。工具里那三条 `return { error }` 在这里是表单校验。
2. **产出绝不自动落盘。** `Draft` 只在内存，采纳是显式一颗按钮（第 19 条）。
   覆盖仍过 workspace 覆盖审阅——两层都过了才真的改磁盘。
3. **失败进 `errorLog`，成功清掉。** 挂在目标细纲上，与 `generate()` 内部那条
   路完全一样（这一段本来就在 `generation/generate.ts` 里，不必新写）。

### 两件工具做而这一页不做的

- **`usage.record(1)`**：那是 agent 的预算，这一页没有循环、没有上限。
- **debug `sessionId`**：这一页没有会话，硬造一个会在工程里留下没人认领的
  目录（与工程页批量任务同一条理由）。调试模式下这一次不留完整上下文快照。

## 协议

进（`protocol/in.ts`）：

```ts
| { type: 'genTargets'; stage: CreationStage }
| { type: 'genRun'; job: CreationJob; target: string; ask: string;
    targetWords?: number; skills: string[]; model?: string; thinking?: ThinkingDepth }
| { type: 'genStop' }
| { type: 'genAdopt'; draftId: string; text: string }
| { type: 'genDiscard'; draftId: string }
```

出（`protocol/out.ts`）：

```ts
| { type: 'genTargets'; stage: CreationStage;
    items: { relPath: string; label: string; hasContent: boolean }[] }
| { type: 'genPhase'; phase: 'idle'|'building'|'thinking'|'writing'|'done'|'error'|'cancelled';
    message?: string; model?: string; contextWindow?: number }
| { type: 'genDelta'; text: string }
| { type: 'genReasoning'; text: string }
| { type: 'genDone'; draftId: string; words: number; summary?: string;
    where: string; relPath: string; overwrites: boolean; canAdopt: boolean;
    built?: BuiltContextView }
| { type: 'genAdopted'; relPath?: string; message: string }
```

技能名单复用已有的 `skillList`（切到本页时请求一次），模型名单复用 `ViewState.models`。

## 要动的文件

```
新增  src/core/controller/generate.ts        这一页唯一的后端落点
新增  media/src/view/generate.ts             前端
新增  media/src/css/view/generate.css
改    src/core/protocol/in.ts / out.ts       上面那两组消息
改    src/core/controller/index.ts           路由 5 条
改    src/shells/shared/panes.ts             generatePane()
改    src/shells/vscode/webviewHtml.ts       + tab + pane
改    src/shells/standalone/page.ts          + tab + pane（带图标）
改    media/src/view/index.ts, refs.ts       接线
改    media/src/css/view.css                 @import
```

**一个字都不改**：`context/`、`features/artifact.ts`、`generation/generate.ts`、
`generation/accept.ts`、`tools/novel/generate.ts`、`controller/agent.ts`、
`controller/gate.ts`。
