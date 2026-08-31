# core/runtime — 可丢弃的运行时设施

日志、进度、失败标记、有界并发、SQLite——这些都不是内容，删掉整个 `.novelforge/novelforge.db` 或清空内存缓冲，工程本身不受影响，只是丢一些「刚才发生了什么」的痕迹（AGENTS 第 17 条）。

| 文件 | 职责 |
|---|---|
| [logger.ts](logger.ts) | 环形缓冲 + sink 转发；`redact` 脱敏、绝不记 prompt 全文、日志坏了不带崩正事 |
| [progress.ts](progress.ts) | `runTask`：长任务的宿主原生进度 + 推给前端的结构化进度（n/N）+ 日志三件事一次做完 |
| [errorLog.ts](errorLog.ts) | 失败记在目标身上（工程页那一行的红/黄标记），成功必须 `clearFailures` |
| [concurrency.ts](concurrency.ts) | `runPool`：有界并发，`current` 只在一项真正结束时才 +1 |
| [db.ts](db.ts) | 工程内 SQLite（`errors` / `logs` 两张表），见下 |
| [debug.ts](debug.ts) | 调试模式：完整上下文落进会话旁边的 `<id>.debug/`，日志里只给路径，见下 |

## SQLite 只放痕迹（AGENTS 第 17 条的落点）

内容的唯一真相永远是 Markdown。库里只有失败记录与日志历史，删掉 `novelforge.db` 一个功能都不受影响。三条实现约束：

1. **两个壳两个驱动，没有可选项**：Node（插件 / Electron）用 `node:sqlite`，Bun（独立版）用 `bun:sqlite`，彼此的运行时都没有对方那个内置模块。
2. **模块名必须拼接后 `await import`**，不能写成字面量——esbuild 的静态分析会尝试解析 `bun:sqlite` 并直接构建失败；拼接让它看不见,两条构建路径都不用配 external。
3. **语句用完必须显式 finalize**：`bun:sqlite` 的语句持有底层句柄，不 finalize 就 `close()` 的话 Windows 上库文件仍被占着（`fs.rmSync` 报 EBUSY，临时工程清理不掉）；`node:sqlite` 没有 `finalize`，靠 GC。所以对外只暴露 {@link SqlDatabase} 的 run/all/insertMany——内部「准备 → 执行 → 立刻 finalize」，调用方碰不到语句对象也就不可能忘。

**打不开就静默降级，只 warn 一次**：库锁了、盘满了、驱动缺了，正事（更新角色卡、写正文）照常，只是这次的失败记录/日志历史留不下来——SQLite 是增强，不是新的失败源。

## 调试模式：全文进文件，日志给路径

排查「它为什么没按细纲写」时最想看的那份东西，恰好是日志里永远不会有的那份：**这一次到底发给模型了什么**。第 11 条把 prompt 全文挡在日志之外是对的——一次续写的上下文有十万字，进了那个 800 条的环形缓冲会把此前所有线索挤没，复制进 issue 还可能带走整本书。

所以调试模式换一条路，而不是放宽那条约束：

- 每一次调模型（agent 的每个回合、每一次 `generate`）把**完整消息**原样写进 `.novelforge/sessions/<会话 id>.debug/<时间戳>-<slug>.md`，请求发出去**之前**就写（卡死的那一次最该看它），回答随后补在同一个文件末尾；
- 日志里那一条只有**绝对路径**（detail 那一段在日志页里可以直接选中复制）；
- 会话文件里那几个为了不撑爆而截短的字段（工具参数、工具返回、`generate` 产出的正文）按调试档的宽度留，并多存一块 `ChatTurn.debug`：哪个模型、想多深、什么策略、这一轮的快照都在哪几个文件里（**工程内相对路径**——会话跟着工程走，绝对路径换台机器就废了）。

开关在设置页「高级设置 → 调试」，落在 `~/.novelforge/config.json` 的 `debug`，缺省关。三条实现约定：

1. **没开就什么都不做。** 调用点一律写成 `const at = await dumpContext(…)`，关着时拿到 `undefined`，随后的 `appendDump(at, …)` 自然空转——「开没开」这个判断只在 `debug.ts` 里有一处。
2. **绝不因转储抛错。** 盘满了、目录只读，只留一条 warn。调试是排查手段，不能自己变成故障源。
3. **落在会话旁边、跟着会话进回收站。** `<id>.debug/` 与 `<id>.json` 同级（`SessionStore.list()` 只认 `*.json`，看不见它），删会话时一并搬进 `.trash/`（第 6 条）——那些文件里是这本书的正文，不能留成孤儿。

**它不脱敏**：转储的是发给模型的原文（API Key 不在其中，那在 HTTP 头上）。贴进 issue 之前请自己看一眼。
