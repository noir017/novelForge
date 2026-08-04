# core/features — 功能编排

面向用户动作的编排层：每个文件对应一类「点一下发生什么」。负责组合数据层（model）、装配器（context）与模型层（llm），并把结果以回调形式交回宿主，不直接操作 UI。

## 文件

| 文件 | 职责 |
|---|---|
| [continueWriting.ts](continueWriting.ts) | ★ `ContinueSession`：续写编排——装配上下文 → 流式生成 → 回调交回调用方决定采纳。含 `preview()`（只装配不调用模型）、取消、输出清洗与连接测试；`quickContinue` 为不开面板的快速续写。 |
| [summarize.ts](summarize.ts) | 单章摘要（六个固定小节，temperature 固定 0.3）、批量同步过期摘要、map-reduce 重建全书摘要（每 N 章一批 reduce 再合并）。 |
| [characters.ts](characters.ts) | 从选定章节提取/更新角色卡。**绝不静默覆盖作者手写的角色卡**——已存在的角色一律走 diff 编辑器确认，新角色直接创建。另含 `newCharacter` / `newLore` 的新建模板。 |
| [style.ts](style.ts) | 从 1~3 章样章归纳文风指南写入 `.novelforge/style.md`，覆盖前先确认（style.md 常被作者手工调过）。 |

## 关键设计

- **回调而非返回**：生成类操作通过 `GenerateHandlers`（onDelta / onDone / onError / onCancelled）汇报进度，UI 层决定怎么展示流式内容。
- **模型输出清洗**：LLM 常把正文包在 code fence 里或加上「好的，以下是续写」之类的前言，写入前统一剥掉（`stripCodeFence` 等）。
- **人工确认优先**：凡是覆盖作者可能手改过的文件（角色卡、style.md），一律先 diff / 弹窗确认。
- **摘要温度 0.3**：摘要要稳定、可复现，不用用户设的创作温度。

## 依赖关系

依赖 `model/`、`context/`、`llm/`。被 `vscode/extension.ts`（命令）与 `ui/chatController.ts`（对话面板）调用。部分函数会用 `vscode.window` 的 QuickPick / diff 编辑器做交互——这是本层与宿主唯一的直接耦合点。
