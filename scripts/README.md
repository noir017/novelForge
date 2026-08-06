# scripts — 离线冒烟测试

六个不依赖 VS Code、也不需要真实 API Key 的测试脚本，`npm run smoke` 依次执行，`npm test` = typecheck + core 纯度检查 + smoke。

| 脚本 | 覆盖范围 |
|---|---|
| [smoke.js](smoke.js) | Markdown 解析、tokenizer、模型输出清洗、摘要/角色 JSON 解析的容错，以及 `sample-novel/` 的 hash 一致性 |
| [smoke-providers.js](smoke-providers.js) | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商配置兜底 |
| [smoke-builder.js](smoke-builder.js) | 用真实文件系统的 vscode 桩跑完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、discuss 模式、provider 配额压缩；另含工程页快照 |
| [smoke-llm.js](smoke-llm.js) | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，Anthropic 的 system 提取与消息合并 |
| [smoke-session.js](smoke-session.js) | 会话读写 round-trip、损坏文件容错、列表排序、重命名/删除、id 唯一性，`.novel` → `.novelforge` 迁移 |
| [smoke-server.js](smoke-server.js) | 独立版服务（需 Bun）：静态资源、WS 首条消息、`Origin` 校验，以及内置编辑器的消息往返——打开、保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒 |

另有两个非测试脚本：

| 脚本 | 用途 |
|---|---|
| [embed-media.js](embed-media.js) | 把 `media/` 下的资源 base64 内嵌成 `src/standalone/mediaAssets.ts`（生成文件，已 gitignore），供 `bun build --compile` 的单文件可执行使用。`typecheck` / `smoke` / `dist` 前会自动跑。**在 `media/` 新增文件后要把它加进这里的 `files` 数组。** |
| [check-core-purity.js](check-core-purity.js) | 断言 `src/core/` 里没有任何 `vscode` 依赖——双形态架构的硬约束。 |

## 技术要点

- 不用测试框架：每个脚本自带 `check(name, cond, detail)`，失败计数非零即非零退出码。
- 跑的是 **TypeScript 源码**：用 esbuild 把单个 TS 文件 bundle 成 CJS 后 `require`，并用 `Module._load` 打 `vscode` 模块桩。`smoke-server.js` 例外，它由 Bun 直接跑 TS。
- 数据目录用 `sample-novel/` 或临时目录，测试后自清理（对 `sample-novel` 只读——`smoke.js` 有 hash 断言，写入类用例一律另开临时工程）。

改动 `src/core/` 后务必跑一遍 `npm run smoke`——这是 CI 之外唯一的回归防线。
