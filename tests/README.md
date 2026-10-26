# tests — 自动化测试

不依赖 VS Code、也不需要真实 API Key。运行器是 Node 自带的 **`node:test`**（零新增依赖），
独立版服务那一组由 **Bun** 跑同一套 `node:test` API。

```bash
npm test                 # typecheck + 全部
npm run test:unit        # 只跑快的（毫秒级）
npm run test:integration
npm run test:dom         # 会先构建 dist/media
npm run test:contract
npm run test:e2e         # 需要 Bun
npm run test:verbose     # 出问题时看 node 原样输出
```

单跑一个文件或一条用例：

```bash
node --test tests/unit/model/markdown.test.js
node --test --test-name-pattern="stripH1" "tests/unit/**/*.test.js"
```

> **glob 必须带引号**——`node --test <目录>` 在当前 Node 版本会把目录当成模块入口报
> `MODULE_NOT_FOUND`。引号让 glob 交给 node 自己展开，PowerShell 与 sh 下行为一致。

## 输出：只报失败

四组 `node --test` 都走 `reporters/quiet.mjs`——**只吐失败与一行总计**。全绿时输出就一行：

```
✓ 通过 2197，2197 条，30.5s
```

有失败时每条三行：位置、用例全名（含祖先套件）、期望与实际。

```
✗ tests/unit/model/markdown.test.js:84
  markdown.ts › H1 处理 › stripH1 去掉标题
  实际 "\n雨下了三天。"
  期望 "雨下了三天。"（strictEqual）
```

默认 reporter 每条失败带十几行 YAML（`duration_ms`、`location`、完整 stack），全量跑一轮
接近 400 KB；换掉之后全绿 36 字节，一条失败也就百来字节。**人往回翻不动、塞进 agent
上下文更是纯浪费**，这是换掉它的唯一理由——判定逻辑一点没动，退出码照旧。

想看原样输出用 `npm run test:verbose`。三个开关按需加：

| 环境变量 | 作用 |
|---|---|
| `NF_TEST_LOGS=1` | 连带打印失败文件里的 `console` 输出（默认丢弃） |
| `NF_TEST_STACK=1` | 每条失败附一行仓库内的调用位置 |
| `NF_TEST_MAX_FAILS=n` | 最多展开几条，超出只计数（默认 25，`0` 表示不限） |

两处刻意的取舍：**套件层的失败不报**（`failureType: 'subtestsFailed'` 只是子用例失败的回声，
叶子那条已经报过），所以总计里的失败数是**叶子数**，与展开的条数对得上，不等于
`counts.failed`；**两个长字符串只报第一处分歧**的位置与前后文，不把两份全文都印出来。

e2e 那组归 Bun 管，`bun test` 没有自定义 reporter 的接口——但它本来就只有一千多字节，不用管。

## 按测试类型分目录

| 目录 | 跑什么 | 依赖 |
|---|---|---|
| `unit/` | 纯函数，零 I/O | 无 |
| `integration/` | 真临时工程 + 假模型，跨模块编排 | 临时目录、SQLite |
| `dom/` | jsdom 跑 `dist/media/` 的前端产物 | jsdom、前端构建产物 |
| `e2e/` | 真 HTTP/WS 服务 | Bun |
| `contract/` | 架构不变式与夹具自洽 | 无 |

`helpers/` 放公共 harness，不是用例（不匹配 `*.test.js`，不会被收集）。

## 覆盖范围

每个测试文件开头的注释写了它测什么、为什么（多数带一张「断言 | 为什么」表），这里不再逐文件列一遍。
测试按被测模块分子目录（`unit/model/`、`integration/features/`、`dom/view/`……），找相关的测试按文件名找，
或 `grep -rl "关键字" tests/`。

## helpers/

| 模块 | 提供 |
|---|---|
| `load.js` | `loadModule(relPath)` / `loadBundle(entries)`——用 esbuild 把 **TS 源码** bundle 成 CJS 后 require，结果带缓存。**要用 Host 的模块必须打进同一个 bundle**：分开 bundle 会让每份产物各带一份 `host.ts` 的模块级状态，`initHost` 只作用于其中一份 |
| `tmpProject.js` | `makeTempProject()`（与作者点「初始化」同一条路：`Workspace.initializeProject`，固定目录 + 经网关写空模板 + manifest；网关单独 bundle 一份，工程实例仍由调用方的 `projectMod` 造）、`copyFixture()`（需要写盘时复制 `sample-novel/`）、`rel/write/read/has/remove` |
| `fakeHost.js` | 可编程假宿主：input/confirm/pick/reviewReplace 按**队列**取答案，没排队就当用户取消；录制 toasts/confirms/reviewed/opened，并能观察 `reviewReplace` 的并发峰值。`reviewReplace` 的回答也可以是一个函数（按这一次的两个版本算，比如交回 `{ merged }`），`reviewed` 里记着这一次有没有请求合并 |
| `fakeProvider.js` | 假模型，一律经 `registerProviderFactory` 且 `kind: 'vscode-lm'`——那是唯一不碰 SecretStore 的路径（其余 kind 会去要 API Key）。支持应答队列、函数应答、按模型注入 `unavailable`/`fail`/`cancel`、并发峰值观察；应答可以是 `{ text, stop, reasoning, chunks }`（测续写要靠 `stop: 'maxTokens'`），`filler(n, seed)` 造恰好 n 字、不同 seed 之间无公共 8-gram 的正文 |
| `vscodeStub.js` | 四档能力的 `vscode` 模块桩（`minimal`/`config`/`workspace`/`full`），`full` 带真实文件系统支撑的 `workspace.fs`。**返回 `restore()`，请挂到 `after()`** |
| `teardown.js` | `cleanup(dir, db)`——**先关库再删目录**：SQLite 连接开着时 Windows 上删不掉 `.novelforge/novelforge.db`，临时工程会全留在 temp 里 |
| `dom.js` | jsdom 挂载：从 `webviewHtml.ts` / `html.ts` 抠 `<body>`、`window.eval` 加载 `dist/media/*.js`、`acquireVsCodeApi` 桩与消息泵、视图数据的夹具工厂；`mirrorLayout` 这个补丁给高亮镜像层一份可预期的假排版（量位置那一份镜像里标记的 `offsetTop` 按换行数 × 行高算、textarea 的视口高固定，尺寸在 `MIRROR_LAYOUT`），测「滚动按量出来的位置走」用；`fakeTimers` 把窗口里的定时器换成手拨的（`window.__clock.tick(ms)`），测停笔 2 秒、10 秒没回音、去抖不必真等；编辑器页内对话框的 `dialog()` / `dialogButtons()` / `answer(label)`（点了按钮再等 Promise 后续跑完）与 `flush()`；`sampleChapterIndex(plots)` 从工程树样本投影出 `chapterIndex` 消息的那几个字段；`mount({ url })` 给页面一个地址——缺省的 `about:blank` 是不透明的源，`localStorage` 一碰就抛，要测「按工程记进 localStorage」时给 `http://localhost/?project=…`；`mount({ storage })` 在跑脚本之前把这几项写进 localStorage（没给 `url` 时挂在 `http://localhost/` 上），测刷新恢复用；`mac` 让 `navigator.platform` 是 `MacIntel`（快捷键按 ⌘ / ⌥ 写）；`previewLayout` 给预览一份假排版（带 `data-line` 的一块，顶 = 第几行 × `PREVIEW_LAYOUT.line`、随预览的 `scrollTop` 上移，高 = 占几行 × 同一个数），测切换时滚动对应用；`narrow` 这个补丁给一份 `matchMedia`，只有 `max-width: 900px` 那条成立（窄屏上的行为，脚本装载时就要问） |
| `ws.js` | e2e 的 WebSocket 客户端（收件箱 + `waitFor(match, label)` 超时） |
| `outline.js` | `outlineOf(to, { from, text, titles, heading })`：一章一条的情节大纲夹具（旧格式的区间分节不认了，要覆盖到第 20 章就得有第 1–20 章各一条）；`text: { 1: '原句' }` 把被断言引用的那句放进对应章。`writeOutline(t, text)`：情节大纲没有文件（各章细纲梗概的汇总），照一份大纲写各章细纲——没有细纲的建只有梗概的空壳（有正文落正文的镜像），已有的只换「梗概」一节 |

## 约定

- **一条断言一个 `test()`**，名字用中文写清「验的是什么行为」——失败时那一行就是报告。
- 用 `assert.equal` / `deepEqual` 而不是 `assert.ok(a === b)`：前者失败时会打印实际值与期望值。
- 同一文件内的用例**默认串行**，多步流程（建文件 → 改名 → 断言）照原样写即可。
- 每个文件一个独立进程，`Module._load` 打的 `vscode` 桩与 `host.ts` 的模块级状态天然隔离。
- 临时目录一律走 `helpers/tmpProject.js`，收尾一律走 `helpers/teardown.js`——**碰过工程库的必须传 `db` 模块**。
- `sample-novel/` **只读**（`contract/sampleNovel.test.js` 对它有 hash 断言）；要写盘的用 `copyFixture()`。

改动 `src/core/` 后务必跑一遍 `npm test`——这是 CI 之外唯一的回归防线。
