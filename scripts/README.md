# scripts — 构建与诊断工具

这里只放构建与诊断脚本。**自动化测试在 [`tests/`](../tests/README.md)**（`npm test`）。

| 脚本 | 用途 |
|---|---|
| [build-media.js](build-media.js) | 把 `media/src/` 下的前端源码（TS + CSS 片段）用 esbuild 打包成 `dist/media/` 的四个 `.js` 与两个 `.css`（IIFE，classic script；`dist/` 整个不入库）。`compile` / `watch` / `embed-media` / `typecheck` / `test:dom` 前都会跑到。**加新产物**要在 `JS_ENTRIES` / `CSS_ENTRIES` 里加一条；在已有产物内部拆模块不必动它。 |
| [embed-media.js](embed-media.js) | 把前端资源 base64 内嵌成 `src/shells/standalone/mediaAssets.ts`（生成文件，已 gitignore），供 `bun build --compile` 的单文件可执行使用。`.js` / `.css` 从 `dist/media/` 取（构建产物），`icon.svg` 从 `media/` 取（仓库静态文件）。会先跑一次 `build-media`，所以内嵌的永远不是过期产物。`typecheck` / `test:e2e` / `dist` 前会自动跑。**新增产物后要把它加进这里的 `built` 数组。** |
| [build-sidecar.js](build-sidecar.js) | 把独立版编译成**带 target triple 后缀**的单文件可执行，落到 `src/shells/desktop/binaries/`，供桌面壳（Tauri）当 sidecar 打包。与 `npm run dist` 同源同产物，只有文件名和落点不同——Tauri 的 `externalBin` 认「同名 + `-<triple>`」这个约定。用法 `npm run sidecar`（当前平台）/ `npm run sidecar:all`（连 Windows 一起，Bun 交叉编译）。由 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 自动触发，一般不必手动跑。**加平台**要在 `TARGETS` 里加一行，同时给 CI 的 matrix 加一台 runner（sidecar 能交叉编译，Rust 壳不能）。 |
| [verify-css.js](verify-css.js) | 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变（那才影响层叠）。拆分或重排 `media/src/css/` 的片段后拿它对着旧产物验一遍。用法 `node scripts/verify-css.js <旧> <新>`。 |
| [diag-stream.js](diag-stream.js) | 诊断用：对着真实服务商跑一次流式请求，把分块与解析结果打出来。需要真实 API Key，不进任何自动化流程。 |

> `check-core-purity.js` 已迁去 [`tests/contract/corePurity.test.js`](../tests/contract/corePurity.test.js)——它是一条架构断言，属于测试。
> 十九个 `smoke-*.js` 已迁去 `tests/`，按测试类型分目录，见 [tests/README.md](../tests/README.md)。
