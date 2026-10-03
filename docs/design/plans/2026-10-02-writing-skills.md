# 写作技能（阶段 Skill）

> 2026-10-02。七期之后单独做的一期，**在 main 上直接开发**。移植自 AI-Novel-Writer（GPL-3.0，`~/workspace/AI-Novel-Writer`，master `a2948c1`）的「写作 Skill」：上游 ADR 0015「写作 Skill 是按阶段冻结的补充指导」，代码在 `src/shared/writing-skills.ts`、`src/services/agent/skill-registry.ts`、`src/services/agent/writing-skill-bindings.ts`、`src/services/agent/tools/{inspect,install,bind}-writing-skill.tool.ts`、`electron/controllers/app-data-controller.ts:58-400`、`src/services/workflows/commands/base-command.ts:48-95`、`src/components/settings/SkillSettings.tsx`。
>
> 总计划 §1 #27 原先把「阶段 Skill」列为不做；作者 2026-10-02 要求移植，那一行已改。

**Goal:** 作者能给本工程的每个阶段（规划 / 写正文 / 审稿 / 修稿）绑一份写作技能——一份自包含、纯提示词的 `SKILL.md`——这个阶段往后的每一次生成都把它放在提示词最前面，对话页、agent、工程页批量带的是同一份。技能从三个来源来：内置、我的技能库（`~/.novelforge/skills/`，从 GitHub 先检查再安装）、本工程（`.novelforge/skills/`，手放）。

## 作者拍板的三件（2026-10-02）

| # | 问题 | 定案 |
|---|---|---|
| A | 总计划 #27 写着「阶段 Skill 不做」 | 推翻，这一期做 |
| B | 上游的三个 agent 工具 | **并进 `run` 的动作**，工具数不变（七个是硬约束） |
| C | 对话里 `/技能名` 手动调用 | **不做**：`/` 已经是阶段命令面板；上游这条路还绕过兼容检查与预算 |

## 落在哪

| 模块 | 做了什么 |
|---|---|
| `model/writingSkill.ts` | 纯函数：`SKILL.md` 解析（上游那份手写的 frontmatter）、六条不兼容规则（逐条照搬）、建议阶段、名字与 id、绑定文件格式、`skillStageOf`、注入那一块的说法、GitHub 地址。零运行时 import，前端直接用 |
| `skills/` | 三个来源的读、我的技能库的装与卸、GitHub 先检查再安装（重新下载核对 sha256）、阶段绑定。见 [skills/README.md](../../../src/core/skills/README.md) |
| `context/layers/skill.ts` + `recipes.ts` | `skill` 层：八张配方都在 P0 那一组的最后带一层；消息里排在用户消息最前面 |
| `workspace/` | 新种类 `skill`（`.novelforge/skills.json` 与 `.novelforge/skills/**`，plain handler）；`.novelforge/skills` 进受保护目录；`writeSkillBindings` |
| `tools/novel/run.ts` | 四个动作：`listSkills` / `inspectSkill`（`auto`）、`installSkill` / `bindSkill`（`always`）；新参数 `url`、`stage`；卸载进 `REFUSED` |
| `controller/skills.ts` + 协议 | `requestSkills` / `inspectSkill` / `installSkill` / `uninstallSkill` / `bindSkill` 进；`skills` / `skillInspection` 出。独立版空窗口由 WorkspaceHub 直接调（技能库能看能装能卸，绑定要工程） |
| 设置页「技能」 | 第三个子页：本工程的阶段绑定（四个下拉框）、从 GitHub 安装（检查 → 看正文 → 确认安装）、技能库。改了当场生效，「保存设置」在这一页藏起来 |

## 自定的取舍（⚑，收尾时报给作者）

1. ⚑ **阶段怎么对上**：规划 = 架构 / 大纲 / 细纲三层的生成与落定（含补齐设定、批量拆细纲、角色图谱第二步、细纲紧凑重建）；写正文 = 写、接着写、重写与续写那几轮（含批量写章）；审稿 = 审稿与重来一次；修稿 = 按勾选修稿与修稿续写。**讨论不带**（上游的 AI 助手对话也不带）；定稿、摘要、文风提取不经装配器，本来就带不到（上游同样不带）。
2. ⚑ **预算**：不 force，排在 P0 那一组最后（作者事实先拿预算）；放不下整份不带、明细写明需要多少（上游是让这次调用失败）。
3. ⚑ **绑了却带不上**（找不到、变得不兼容、绑定文件读不懂）：明细里 dropped 写原因，生成照常（上游是整个工作流起不来）。
4. ⚑ **不冻结快照**：每次装配读盘，批量跑到一半改了绑定后面就用新的（上游在工作流开始时冻结）。日志里记一句用了哪份，同一句五分钟内只记一次。
5. ⚑ **名字可以是中文**；用户与工程技能的**身份是目录名**（上游取 frontmatter 的 name，手放的技能卸载会删个空）。
6. ⚑ **卸载挪进回收站**（`~/.novelforge/.trash/skills/`，上游直接删），本工程绑了它的阶段一起解绑。
7. ⚑ **检查结果带正文**给作者看（上游装之前看不到）；agent 安装的确认框写明说明与正文开头 200 字（上游只显示地址）。
8. ⚑ **`run` 多一个 `listSkills`**；`bindSkill` 的技能 id 复用 `name` 参数，新增 `url`、`stage` 两个参数。
9. ⚑ **内置只搬两个**（长篇连续性与场景推进、自然语言润色，中文正文照抄）：其余五个是上游 AI 助手对话用的，正文让模型调它自己的工具。之后另加了三份去 AI 味（写正文 / 审稿 / 修稿），见 [2026-10-02-less-ai-tone.md](2026-10-02-less-ai-tone.md)；实测无效已归档，换成一份修正文风加写完之后的删修饰，见 [2026-10-03-plain-prose.md](2026-10-03-plain-prose.md)。
10. ⚑ **绑定文件是 JSON**（`.novelforge/skills.json`，形状照搬上游）；写它不走覆盖审阅——两条入口动手前都已经问过作者。

## 不做

- 中英双语、提示词三级覆盖（总计划 #27 仍然不做）。
- 从本地文件 / zip / 任意网址安装（上游也只认 GitHub）。
- 技能的更新：同名的不覆盖，要换新版先卸载旧的（与上游一样）。
- 对话里 `/技能名` 手动调用（C）。

## 验收

- `npm run typecheck` 零错误；`npm run test:node` 与 `npm run test:e2e` 全绿。
- 新增测试：`tests/unit/model/writingSkill.test.js`、`tests/integration/skills/library.test.js`、`tests/integration/context/skills.test.js`、`tests/integration/tools/runSkills.test.js`、`tests/dom/view/skillsSettings.test.js`；`kind.test.js`、`runTool.test.js`、`settings.test.js` 随改动更新。
- **没有调真实模型、没有连真实 GitHub**：GitHub 请求在测试里由假的 `fetch` 应答。
