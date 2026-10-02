---
name: novelforge-autopilot
description: 操作一个已经跑起来的 Novel Forge 独立版服务（Bun，127.0.0.1 上的 /ws），从一句话把一本小说从头生成到全部定稿：小说配置 → 补齐设定 → 情节大纲 → 批量拆细纲 → 批量写章（写完即定稿）。用户说「通过本项目创建一本 xx 小说」「从头生成一本书」「把这个工程写完」「接着把剩下的章写完」时用它。只操作、不审内容。
---

# Novel Forge 自动驾驶

用户让你**通过 Novel Forge 本身**生成一本书时，不要去调模型 API、也不要自己写 Markdown 到工程里。要做的是：像网页前端那样，经 WebSocket 给服务发消息，让它自己装配上下文、调模型、落盘。

脚本在本 skill 的 `scripts/` 目录：

- `drv.mjs`：常驻的 WebSocket 驱动。断线会自动重连。
- `nf.py`：每个阶段一个子命令。

两者之间只经一个**状态目录**交换文件，之后用 `$STATE` 指代它：

| 文件 | 内容 |
|---|---|
| `cmd.jsonl` | 待发的消息 |
| `log.txt` | 收发摘要（warn/error 日志、弹窗、toast、taskDone） |
| `pending.json` | 未答的弹窗与权限卡片 |
| `tasks.json` | 工程页长任务的进度 |
| `busy.json` | 对话页是否在生成 |
| `last-<type>.json` | 最新的 pipeline / workspaces / settings 等快照 |

## 0. 准备

1. **找服务端口**：`netstat -ano | grep LISTEN | grep 127.0.0.1`，看 `bun.exe` 的 PID（`tasklist | grep -i bun`）对应哪个端口。也可以 `curl -s http://127.0.0.1:<port>/` 看到 `<!DOCTYPE html>`。服务端口被占时会顺延，不一定是固定值。
2. **起驱动**（后台，`run_in_background: true`）：
   ```sh
   node <skill>/scripts/drv.mjs --port <port> --state D:/tmp/nfdrv
   ```
   之后所有 `nf.py` 都带同一个 `--state`，或设 `NF_STATE`。
3. **看状态**：`python <skill>/scripts/nf.py --state $STATE status`，确认三件事：
   - **打开的工程是不是用户给的那个目录**。不是就 `send '{"type":"openFolder","path":"D:\\\\tmp\\\\xxx"}'`。
   - **模型**：用户指定了模型就在每条命令上加 `--model <服务商>/<模型名>`，脚本每阶段先 `selectModel` 一次。`<模型名>` 必须在设置里存在，看 `last-settings.json` 的 `providers`。
   - **工程页任务用哪个模型**：设置里 `tierModels` 三档都空时，工程页批量任务沿用 `models`（默认模型列表）。如果用户要求「全程用某个模型」，而 `models` 或某一档里还有别的模型，先**问用户**要不要改设置，不要自作主张改。
4. Windows 下中文输出要设 `PYTHONIOENCODING=utf8`。

## 1. 流程（按顺序，每步跑完再下一步）

```sh
NF="python <skill>/scripts/nf.py --state $STATE --model newapi/gemini-3-flash-lite"
$NF idea "一句话脑洞……" --chapters 100 --words 3000   # 小说配置（对话页单步 + 写入卡片）
$NF settings                                        # 工程页「补齐设定」：前提 / 角色图谱 / 世界观
$NF outline                                         # 情节大纲，每段 20 章，续写到覆盖全书
$NF plots                                           # 工程页「批量拆细纲」第 1–N 章
$NF write                                           # 批量写章（写完即定稿），一直跑到全书写完
```

- **耗时**：`write` 最久，gemini-flash 这一档大约 1 分钟一章，100 章要一个半小时左右。用 `run_in_background` 跑，重定向到 `$STATE/write.log`，每隔约 10 分钟 `sleep` 一次看 `tail` 和 `ls chapters | wc -l`。
- **期间要和用户同步进度**：写到多少章了、遇到了什么。

## 2. 每一步实际在做什么（排障时要懂）

| 阶段 | 发的消息 | 落盘前要答什么 |
|---|---|---|
| 小说配置 | `send`，payload 为 `stage:'setting'`、`target:{kind:'setting',doc:'config'}`、`setup:{totalChapters,wordsPerChapter}` | 一张 `gate`（`name:'artifact'`），答 `gateResult proceed` |
| 补齐设定 | `projectAction completeSettings` | 一个 `prompt kind:'confirm'`，答 `promptResult value:'yes'` |
| 情节大纲 | `send`，payload 为 `stage:'outline'`、`target:{kind:'outline'}`、`range:{from,to}` | `gate` |
| 拆细纲 | `projectAction generatePlots`，带 `range`、`confirmed:true` | 无（`confirmed` 表示调用次数已经报过） |
| 批量写章 | `projectAction writeManuscripts`，带 `range`、`confirmed:true`、`mode:'finalize'`、`review:false` | 可能有一致性预检的 `confirm` |
| 接着写 | `chapterAction`，带 `plotRelPath:'.novelforge/plots/NNN-….md'`、`action:'continue'` | `gate` |
| 定稿 | `projectAction finalizeChapter`，带 `relPath:'chapters/NNN-….md'` | 无 |

协议的权威定义在仓库的 `src/core/protocol/in.ts` / `out.ts`。主按钮的下一步在 `last-pipeline.json` 的 `next` 里；`nf.py next` 就是「按一下主按钮」。

## 3. 已知的坑（都已写进脚本，改脚本时别丢）

- **主按钮不会提前续写大纲**：大纲只写第 1–20 章时，主按钮会直接跳去拆细纲，要等写到第 21 章才提示续写。批量拆细纲受大纲覆盖范围限制，所以 `outline` 子命令一次把大纲续到全书。
- **批量写章一次最多 10 章**（`WRITE_BATCH_MAX`），而且会在下面三种情况下提前停。停下的那一章**已落盘但没定稿**：
  - 后面章才登场的人提前出现在这一章。
  - 写不到目标字数的八成。
  - 重演（开头与上一章结尾大段重合）。

  `write` 的处理是：先找出没有摘要的章；字数不到八成就按一次「接着写」；然后单章定稿；再从下一个缺口起下一批。**不定稿就往下写，后面章节拿不到它的摘要**。
- **一致性预检**：例如「某人已死亡，细纲仍安排出场」。脚本会选「仅本次忽略，照写」。这是内容问题，**要记下来写进最后的报告**：在 `log.txt` 里 grep `一致性预检`。
- **服务重启或本机闪退**：
  - 驱动会自动重连。服务端的批量任务不随 WS 断开而停，重连后 `tasks.json` 里还能看到它。
  - 未答的弹窗在断线时按取消处理。
  - 重启 `write` 是安全的：它从磁盘推断进度，已写、已定稿的都跳过。
  - 但服务重启那一刻正在跑的「接着写」可能丢了，那一章会按短稿被定稿。事后用 `status` 加字数检查找出来：手动 `chapterAction continue`，答 `gate`，再 `finalizeChapter` 一次。
- **字数口径**：脚本按去掉空白、frontmatter 之后的字符数估算。服务自己的字数在 `.novelforge/project.json` 的 `wordCount`，比脚本算的略低。以服务为准的判定在 `taskDone` 消息里。
- **不要 `git add` 用户的测试工程**。状态目录放在工程之外，比如 `D:/tmp/nfdrv`。

## 4. 收尾与报告

1. 收尾检查：
   - `status`：未定稿列表应为空，`next` 为 `None`（全书完成）。
   - 检查一遍每章字数：最小值、最大值，以及有没有低于八成的章。
2. 停掉后台的 `drv.mjs`（TaskStop）。
3. 给用户报告：
   - **结果**：章数、总字数、所用模型。
   - **逐步操作**：每个阶段发了什么、答了什么、耗时多少。
   - **自动处理过的停顿**：哪几章提前登场、哪几章字数不够被接着写。
   - **跳过的一致性预检原文**。
   - **中断与恢复**的经过。
   - **脚本与日志的位置**。

   用户说了「不用检查内容」就不要读正文去评价质量，但预检报出的矛盾要如实转述。
