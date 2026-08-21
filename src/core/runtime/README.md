# core/runtime — 可丢弃的运行时设施

日志、进度、失败标记、有界并发、SQLite——这些都不是内容，删掉整个 `.novelforge/novelforge.db` 或清空内存缓冲，工程本身不受影响，只是丢一些「刚才发生了什么」的痕迹（AGENTS 第 17 条）。

| 文件 | 职责 |
|---|---|
| [logger.ts](logger.ts) | 环形缓冲 + sink 转发；`redact` 脱敏、绝不记 prompt 全文、日志坏了不带崩正事 |
| [progress.ts](progress.ts) | `runTask`：长任务的宿主原生进度 + 推给前端的结构化进度（n/N）+ 日志三件事一次做完 |
| [errorLog.ts](errorLog.ts) | 失败记在目标身上（工程页那一行的红/黄标记），成功必须 `clearFailures` |
| [concurrency.ts](concurrency.ts) | `runPool`：有界并发，`current` 只在一项真正结束时才 +1 |
| [db.ts](db.ts) | 工程内 SQLite（`errors` / `logs` 两张表），见下 |

## SQLite 只放痕迹（AGENTS 第 17 条的落点）

内容的唯一真相永远是 Markdown。库里只有失败记录与日志历史，删掉 `novelforge.db` 一个功能都不受影响。三条实现约束：

1. **两个壳两个驱动，没有可选项**：Node（插件 / Electron）用 `node:sqlite`，Bun（独立版）用 `bun:sqlite`，彼此的运行时都没有对方那个内置模块。
2. **模块名必须拼接后 `await import`**，不能写成字面量——esbuild 的静态分析会尝试解析 `bun:sqlite` 并直接构建失败；拼接让它看不见,两条构建路径都不用配 external。
3. **语句用完必须显式 finalize**：`bun:sqlite` 的语句持有底层句柄，不 finalize 就 `close()` 的话 Windows 上库文件仍被占着（`fs.rmSync` 报 EBUSY，临时工程清理不掉）；`node:sqlite` 没有 `finalize`，靠 GC。所以对外只暴露 {@link SqlDatabase} 的 run/all/insertMany——内部「准备 → 执行 → 立刻 finalize」，调用方碰不到语句对象也就不可能忘。

**打不开就静默降级，只 warn 一次**：库锁了、盘满了、驱动缺了，正事（更新角色卡、写正文）照常，只是这次的失败记录/日志历史留不下来——SQLite 是增强，不是新的失败源。
