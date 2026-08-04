# scripts — 离线冒烟测试

五个不依赖 VS Code、也不需要真实 API Key 的测试脚本，`npm run smoke` 依次执行，`npm test` = typecheck + smoke。

| 脚本 | 覆盖范围 |
|---|---|
| [smoke.js](smoke.js) | Markdown 解析、tokenizer、模型输出清洗、摘要/角色 JSON 解析的容错，以及 `sample-novel/` 的 hash 一致性 |
| [smoke-providers.js](smoke-providers.js) | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商配置兜底 |
| [smoke-builder.js](smoke-builder.js) | 用真实文件系统的 vscode 桩跑完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、discuss 模式、provider 配额压缩；另含工程页快照 |
| [smoke-llm.js](smoke-llm.js) | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，Anthropic 的 system 提取与消息合并 |
| [smoke-session.js](smoke-session.js) | 会话读写 round-trip、损坏文件容错、列表排序、重命名/删除、id 唯一性，`.novel` → `.novelforge` 迁移 |

## 技术要点

- 不用测试框架：每个脚本自带 `check(name, cond, detail)`，失败计数非零即非零退出码。
- 跑的是 **TypeScript 源码**：用 esbuild 把单个 TS 文件 bundle 成 CJS 后 `require`，并用 `Module._load` 打 `vscode` 模块桩。
- 数据目录用 `sample-novel/` 或临时目录，测试后自清理（smoke.js 对 sample-novel 只读）。

改动 `src/core/` 后务必跑一遍 `npm run smoke`——这是 CI 之外唯一的回归防线。
