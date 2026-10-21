# 写作技能认常规技能格式（内置改成目录）

> 2026-10-21。在 main 上直接开发，接在 271b190（两份外来去 AI 味做成 TS 内置）之后。起因：作者看到内置技能是写死在 TS 里的字符串，说「这不行，改造一下 skill 功能，内置 skill 要能支持常规的 skill 格式」。之前那次为了过兼容检查，Humanizer-zh 删了 `allowed-tools`，fiction-humanizer-zh 把 `references/` 并进了正文，两份都动了上游。

**Goal:** 常规的技能目录（一份 `SKILL.md`，YAML frontmatter，旁边是 `references/*.md` 这类附带文件）**原样放进来就能用**。内置技能的唯一真相就是仓库里的那些目录。三个来源（内置 / 我的技能库 / 本工程）和从 GitHub 装，走的是同一套读法。

## 硬约束

- **三个壳的产物都是单文件**：VS Code 是 esbuild 的 bundle，独立版、桌面 sidecar、Docker 是 `bun build --compile`。运行时旁边没有仓库，内置的目录只能构建时内嵌。先例是 `embed-media.js`，它也说明了在运行时读 `__dirname` 这条路走不通：c25df21 修「关于」显示 0.0.0，就是因为这个。
- **零运行时依赖**：不引入 yaml 库。
- **生成是一次调用**：模型没有读文件的工具，常规技能里「按需读取 references/x.md」做不到，附带文件只能事先接进提示词。

## 定案（⚑ = 我按推荐项定的。AskUserQuestion 在 IM 里没弹出来，作者批方案时没改）

| # | 问题 | 定案 |
|---|---|---|
| ⚑1 | 范围 | 三个来源同一套读法；从 GitHub 装时，引用到的附带文件逐个下载 |
| ⚑2 | 附带文件怎么带 | 只带被引用到的文本文件（`.md` / `.markdown` / `.txt`），引用可以传递。每份标上路径，接在正文后面。预算和 64 KiB 都按合计算，放不下就整份不带。明确引用了却带不上的（找不到、越出技能目录、不是文本）判「包含相对引用」。没被引用的（README、CHANGELOG、LICENSE）不带 |
| ⚑3 | frontmatter 里给 agent 看的声明 | `allowed-tools` / `tools` 不算依赖工具，`metadata` 这类嵌套块不看；`hooks` / `mcp` / `scripts` / `sub-agents` 照旧算 |
| ⚑4 | 上游原文动不动 | 正文、附带文件、`LICENSE` 一字不改，只在 frontmatter 里加 `display_name` 与 `stage` 两行（前面加一行注释说明） |
| 5 | 内置的身份与顺序 | 取目录名，与另外两个来源一样；按目录名的码点排 |

## 落在哪

| 位置 | 做了什么 |
|---|---|
| `src/core/skills/builtin/<名字>/` | 五份内置，一个目录一份。原来那三份的 `SKILL.md` 与原来的 raw 逐字相同；两份外来的取自上游 f4518a8（Humanizer-zh）与 859a3fd（fiction-humanizer-zh）。出处移到 `builtin/README.md` |
| `scripts/embed-skills.js` | 把每个目录的全部文件写进 `builtin/embedded.ts`（不入库）。换行收成 `\n`，只收 UTF-8 文本；内容没变不写，要写就先写临时文件再 rename |
| 调它的三处 | `embed-media.js` 开头（typecheck、e2e、独立版、单文件、sidecar、Docker、release）、`esbuild.js`（VS Code）、`tests/helpers/load.js`（node 测试，单跑一条也算） |
| `model/writingSkill.ts` | frontmatter 换成 YAML 子集，只读顶层键：引号、块标量、多行纯量、列表与嵌套块整块归上一个键（不再拍平）、注释、BOM、CRLF。新增 `skillReferences`；`inspectSkillMarkdown(raw, 名字, files)` 在给的文件里按引用找附带文件；`SkillInspection` 多了 `attachments` 和 `unresolved`；`renderSkillBlock` 把附带文件接在后面 |
| `skills/library.ts` | `collectSkillFiles` 从 `SKILL.md` 出发按引用一层层读，磁盘读与 GitHub 下载共用一份。读磁盘时路径上每一段都不跟链接。`installUserSkill(名字, 文件表)` 会写出整棵目录 |
| `skills/github.ts` | 附带文件和 `SKILL.md` 用同一个分支，路径相对 `SKILL.md` 所在目录，一份份下载；404 当作没有，别的失败直接抛。sha256 对整份清单（路径加内容）算 |
| 界面、agent | `SkillRow.files`、`SkillInspectionView.attachments`；设置页显示「附带 N 份文件」，检查卡上一份一个折叠块；`skills` 工具的 inspect、install、list 说法跟着改 |

## 为什么只带被引用的

常规技能目录里常有 README、CHANGELOG、LICENSE、tests/（Humanizer-zh 仓库根就是这样）。全带的话，这些东西会进每一次生成的提示词。正文自己写明了要读哪几份，就照它的写，所以 fiction-humanizer-zh 带上的正好是那四份 `references/`。

普通链接（比如 `[例子](a.md)`）找不到只是不带，跟以前一样；只有明确指向旁边文件的写法带不上才判不兼容。这是为了不把从前兼容的技能判成不兼容。

## 没做的

- 不按「任务需要」挑附带文件：一次调用里没法判断，要带就全带。
- 不支持图片之类的非文本附带文件。
- 不做技能更新：要换新版还是先卸载。
- 插件 `npm run watch` 期间改了内置目录，不会触发重新内嵌。重启 watch 就行。

## 验收

- `npm test`：typecheck、node 测试，以及 e2e（`PATH="$HOME/.bun/bin:$PATH"`）。
- 删掉 `embedded.ts` 之后，`npm run compile`、单跑一条测试、`npm run typecheck` 都会自己生成；`dist/extension.js` 里有内置技能的正文。
- `npm run dist` 出的单文件在空目录里起服务，经 MCP `skills list` 列出五份内置，都可绑。
- 真实 GitHub 上两个地址「先检查」都判可以装，fiction 那份列出四份附带文件。
