# scripts — 构建与诊断工具

这里只放构建与诊断脚本，外加一个测试**调度器**。**测试用例本身在 [`tests/`](../tests/README.md)**。

| 脚本 | 用途 |
|---|---|
| [run-tests.js](run-tests.js) | 全量测试的调度器（`npm test` / `npm run test:node` 走它）。把测试分两组**并行**跑，各用对它最省的进程策略：`dom/` 整组共用一个进程（省掉十七次多余的 `require('jsdom')`，那一下 1.9 秒），其余每文件一进程（它们**依赖**隔离，`host.ts` / `registry.ts` 是模块级单例）。`--all` 再把 typecheck 与 e2e 一起并行。另开两层缓存：`NODE_COMPILE_CACHE` 与 `helpers/load.js` 的磁盘 bundle 缓存。开跑前统一生成一次前端资源，各段因此都带 `--ignore-scripts`（那些 pre 钩子会重写 `dist/media/`，而 dom 组正拿着它跑）。理由与失效规则见 [tests/README.md](../tests/README.md#全量为什么是分组并行的)。 |
| [build-media.js](build-media.js) | 把 `media/src/` 下的前端源码（TS + CSS 片段）用 esbuild 打包成 `dist/media/` 的四个 `.js` 与两个 `.css`（IIFE，classic script；`dist/` 整个不入库）。`compile` / `watch` / `embed-media` / `typecheck` / `test:dom` 前都会跑到。**加新产物**要在 `JS_ENTRIES` / `CSS_ENTRIES` 里加一条；在已有产物内部拆模块不必动它。 |
| [embed-media.js](embed-media.js) | 把前端资源 base64 内嵌成 `src/shells/standalone/mediaAssets.ts`（生成文件，已 gitignore），供 `bun build --compile` 的单文件可执行使用。`.js` / `.css` 从 `dist/media/` 取（构建产物），`icon.svg` 从 `media/` 取（仓库静态文件）。会先跑一次 `build-media`，所以内嵌的永远不是过期产物；**顺手也跑一次 `build-skills`**（它是全部构建路径的公共前置，而那份生成文件被 `core/` import——少一次不是「资源过期」而是编译失败）。`typecheck` / `test:e2e` / `dist` 前会自动跑。**新增产物后要把它加进这里的 `built` 数组。** |
| [build-skills.js](build-skills.js) | 把 `src/skills/**/SKILL.md` 烘成 `src/core/skills/builtin.ts`（生成文件，已 gitignore）。**理由与 embed-media 同源**：三个壳的资源路径各不相同，独立版更是单文件可执行、运行时根本没有 `src/skills/` 可读；烘成常量三个壳全部白拿，`.vscodeignore` 一行不改。**幂等**——内容没变就不碰文件（否则会顶掉 mtime，让 `tests/helpers/load.js` 的磁盘 bundle 缓存整片失效）。挂在 `esbuild.js`、`embed-media.js` 与 `tests/helpers/load.js` 三处前置上，所以正常路径上不必手动跑；手动是 `npm run skills`。**内置技能不许有 `references/`**（`read` 够不着工程之外的路径，链接会断），这里直接拦，另有 [tests/contract/skills.test.js](../tests/contract/skills.test.js) 比对磁盘与常量。 |
| [build-sidecar.js](build-sidecar.js) | 把独立版编译成**带 target triple 后缀**的单文件可执行，落到 `src/shells/desktop/binaries/`，供桌面壳（Tauri）当 sidecar 打包。与 `npm run dist` 同源同产物，只有文件名和落点不同——Tauri 的 `externalBin` 认「同名 + `-<triple>`」这个约定。用法 `npm run sidecar`（当前平台）/ `npm run sidecar:all`（连 Windows 一起，Bun 交叉编译）。由 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 自动触发，一般不必手动跑。**加平台**要在 `TARGETS` 里加一行，同时给 CI 的 matrix 加一台 runner（sidecar 能交叉编译，Rust 壳不能）。 |
| [verify-css.js](verify-css.js) | 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变（那才影响层叠）。拆分或重排 `media/src/css/` 的片段后拿它对着旧产物验一遍。用法 `node scripts/verify-css.js <旧> <新>`。 |
| [diag-stream.js](diag-stream.js) | 诊断用：对着真实服务商跑一次流式请求，把分块与解析结果打出来。需要真实 API Key，不进任何自动化流程。 |
| [diag-tools.js](diag-tools.js) | 诊断用：排查「agent 一步就停、一个工具都不调」。走**真实**那条路（真实 provider、真实 `AGENT_SYSTEM`、真实的八个工具规格），劫持 `fetch` 打印请求体里到底带没带 `tools` / `tool_choice`，同时把 SSE 原样计数（有几个内容块、什么类型、`stop_reason` 是什么），把三种同形的成因分开：**我们没发**（本地 bug）／**上游吞了**（网关转协议丢了 `tool_use` 块）／**我们没解析出来**（`feedToolUse`）。`NF_DIAG_RAW=1` 连原始 SSE 一起打。会真的花钱（每档一次请求），需要真实 API Key，不进任何自动化流程。 |

> `check-core-purity.js` 已迁去 [`tests/contract/corePurity.test.js`](../tests/contract/corePurity.test.js)——它是一条架构断言，属于测试。
> 十九个 `smoke-*.js` 已迁去 `tests/`，按测试类型分目录，见 [tests/README.md](../tests/README.md)。
