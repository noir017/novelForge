# Agent 架构改造 · 索引

从这里开始。**新接手的 agent 先读这一页，再按分期读对应的计划。**

## 是什么

把对话页的 AI 从「执行一条命令」（chatbot + workflow）改成「拿着工具达成一个目标」（agent），同时保住 [AGENTS.md](../../AGENTS.md) 的 23 条产品承诺。

agent **只做上层调度**；真正要生成文本时，它通过工具调用走既有的分阶段装配 + 提示词那条路。

## 读什么

| 文档 | 什么时候读 |
|---|---|
| [设计：agent 架构改造](specs/2026-08-15-agent-architecture-design.md) | **一定先读。** 四层架构、7 个工具、为什么这么切 |
| [零期：事件流 provider](plans/2026-08-15-agent-phase0-provider-events.md) | 动手做零期时 |
| [一期：workspace 读写网关](plans/2026-08-15-agent-phase1-workspace.md) | 动手做一期时 |
| [二期：generation 无状态化](plans/2026-08-15-agent-phase2-generation.md) | 动手做二期时 |
| [三期：agent 循环 + 只读四件套](plans/2026-08-15-agent-phase3-loop.md) | 动手做三期时 |
| [四期：写工具 + 策略](plans/2026-08-15-agent-phase4-write.md) | 动手做四期时 |

每份计划末尾都有一段**「给接手 agent 的提示词」**，可以直接复制给新会话。

## 分期与依赖

```
零期  L0 事件流 provider          ← 必须最先做，其余都依赖它
 ↓
一期  L1 workspace 读写网关        ← 最大的一期，是「能安全给 agent 写权限」的前提
 ↓
二期  L2 generation 无状态化       ← 依赖一期（落盘要先搬进 workspace）
 ↓
三期  L3 agent 循环 + 只读工具      ← 第一个有新功能的一期
 ↓
四期  写工具 + 策略 + UI           ← 依赖前四期的全部保护
```

**零到二期一个新功能都没有，全是重构**，验收标准都是 `npm test` 全绿。它们把「能不能安全地给 agent 一个 `write`」这个问题彻底解决掉——三期的 agent 循环因此只有 300 行左右，四期加写权限不需要新的保护代码。

## 四条贯穿全程的红线

1. **agent 不决定「下一步」。** 那是 `model/pipeline.ts` 的 `deriveNextStep`，零模型调用、精确、免费。每回合把它的结论注入 agent，agent 拿着去执行。两处各判各的，界面上就会出现「徽章说待拆场景，agent 让你写正文」（第 20 条）。
2. **agent 上下文薄，生成上下文厚。** agent 只看状态、路径、字数、hash、工具结果摘要；`generate` 工具内部照旧跑 `buildContext` + `recipeFor` 装十万字。生成产物**绝不回灌** agent 循环。
3. **不动 `context/recipes.ts` / `prompts.ts` / `layers/` / `features/artifact.ts`。** 分阶段装配是这个项目既有质量的来源，agent 化不碰它。
4. **写盘只有一条路**（`workspace.write`），覆盖已有内容一律审阅，任何策略模式下都不放开。

## 不做

- 不做一键成书、不做多 agent、不做工具调用的文本协议兜底
- 不给 `bash`、不给工程根外的路径、不给删除/改名/移动工具
- 不做向后兼容（项目处于初期开发阶段，见 `.claude/CLAUDE.md`）
