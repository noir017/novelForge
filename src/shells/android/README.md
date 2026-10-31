# android — Android 壳

手机上的 Novel Forge。和桌面壳一样是**一层纯壳**：页面就是独立版的那一个（`src/shells/standalone/page.ts` 吐出来的，
窄屏布局），壳只决定打开哪个地址，没有一行 TS。

两种模式，缺省本机，要连远程在返回键弹的菜单里点「服务端设置…」换（返回键先交给页面收菜单、弹窗、正文，见下）：

- **本机**（内置服务）：app 里带着独立版打成的 node 单文件和 Termux 编的 node，起在 `127.0.0.1` 上，带每台设备随机生成的令牌，
  壳替作者走 `/login` 登录（`WebView.postUrl`），再打开首页。
- **远程**：不起内置服务，打开设置里填的服务器地址（Docker 版，或 `--host` 绑出去的独立版）。填了令牌就替作者登录；空着就在网页上登录，
  输对一次壳就记下（交表单时令牌进 sessionStorage，下一页不是登录页才取出来存），之后同样替作者登录，不靠只管 30 天的 cookie。

## 目录

| 路径 | 内容 |
|---|---|
| `app/src/main/java/…/MainActivity.java` | WebView、两种模式的启动、原生的服务端设置对话框、书放在哪（存储权限）、返回键菜单、连不上时的提示页 |
| `app/src/main/java/…/LocalServer.java` | 起停内置服务：从 assets 拷出 `server.cjs`、挑端口、配环境变量、等 `/login` 回 200、输出进 logcat 与 `files/server.log` |
| `app/src/main/java/…/ServerService.java` | 前台服务，只为挂一条常驻通知（理由见下） |
| `scripts/build.sh` | 打包：`scripts/build-android-server.js` 出 `assets/server.cjs` → 没有 node 就跑 `fetch-node.sh` → `gradlew assemble` |
| `scripts/fetch-node.sh` | 从 Termux 仓库取 `nodejs-lts` 与依赖库（校验 sha256），改名成 `lib*.so` 放进 `jniLibs/arm64-v8a`。取自望舒（wangshu-reader）的同名脚本，多一道检查：node 要的库既不在取下来的包里、也不是系统库就直接失败 |

`app/src/main/assets/` 与 `app/src/main/jniLibs/` 是构建时生成的，不入库。

## 构建

需要 Node 22+、JDK 17+、Android SDK（platform 34），以及 `curl` `dpkg-deb` `readelf` `python3`。在仓库根目录：

```bash
npm install
src/shells/android/scripts/build.sh            # debug 包：app/build/outputs/apk/debug/app-debug.apk
src/shells/android/scripts/build.sh release    # 设了 NOVELFORGE_KEYSTORE（路径）/ NOVELFORGE_KEYSTORE_PASSWORD / NOVELFORGE_KEY_ALIAS（缺省 novelforge）就用发版密钥签
```

日常在 CI 上编：Google 的 aapt2 只出 x86_64，arm64 的开发机要编得改用 Debian 13 的 `aapt` 包，并在 `~/.gradle/gradle.properties` 里设 `android.aapt2FromMavenOverride`。

- `.github/workflows/android.yml`：手动点出包（artifact `android`），发版时 `release.yml` 调它，附件名 `NovelForge-<版本>-android-arm64.apk`。
- 两种都用发版密钥签名（仓库 secrets `NOVELFORGE_KEYSTORE_BASE64` / `NOVELFORGE_KEYSTORE_PASSWORD`，别名 `novelforge`），
  手动点出来的包和 Release 里的可以互相覆盖安装。CI 上的 debug 签名每次构建都是新生成的一把，用它的话每试一次都得先卸载、
  app 私有目录里的配置与 API Key 跟着没了，所以只在手动点又没有密钥时退回它；**发版时缺密钥整个 Release 停下**。
- 密钥本体（`release.jks` 与口令）在 uniagent 的 `~/.config/novelforge-android/`，随 oracle 的 `~/apps` 每周进 unraid 备份；
  GitHub secrets 只写不可读，那里是唯一能取回的副本。丢了就没法给已装的人发升级包。

版本号取自仓库根 `package.json`（`0.2.8` → versionCode 208），`tests/contract/version.test.js` 守着。

## 运行时

内置服务这样起（`LocalServer.start`）：

```
libnode.so --use-bundled-ca --disable-warning=ExperimentalWarning files/server/server.cjs --port <端口> --no-open
```

| 环境变量 | 值 | 为什么 |
|---|---|---|
| `HOME` | 放书的目录 | 「新建一本书」的缺省位置、「打开文件夹」的起点都是家目录 |
| `NOVELFORGE_HOME` | `files/novelforge`（app 私有） | 配置与 API Key 不能跟着家目录落到别的 app 也读得到的公共目录（`src/core/stores.ts`） |
| `NOVELFORGE_TOKEN` | 每台设备随机 48 位 hex，存在 SharedPreferences | 手机上任何 app 都能连回环地址，包括 `/mcp` |
| `LD_LIBRARY_PATH` | `nativeLibraryDir` | node 依赖的 `libssl_3.so` 等都在那里 |
| `TMPDIR` / `TZ` | 缓存目录 / 系统时区 | node 在 Android 上取不到这两样 |

端口先试 36800（独立版的缺省），被占就随机。node 的输出进 logcat（tag `NovelForgeServer`）与 `files/server.log`（只留本次）。

## 设计取舍

- **为什么是 node 不是 Bun**：Bun 不出 Android 的构建，bionic 也跑不了 glibc 的二进制。独立版只有监听那一层用到 Bun
  （`Bun.serve`），收在 `standalone/serve.ts` 里，没有 Bun 时走 `standalone/nodeServe.ts`（`node:http` + `ws`）；
  SQLite 本来就有 `node:sqlite` 兜底。Termux 的 nodejs-lts 是 24，自带 `node:sqlite`。
- **为什么页面不打进 APK**：页面本来就由服务端吐，两种模式都只是打开一个网址；打进 APK 反而要和远程那台的版本对齐。
  代价是服务端设置只能做成原生对话框（远程那台的页面不认识这个壳），入口是返回键：先问页面 `window.nfBack()`（`media/src/view/mobileNav.ts`）
  收掉最上面一层（菜单、弹窗、盖在侧栏上的正文），页面说没什么可收了、或者开着的是壳自己的提示页，才弹「服务端设置… / 退出」。
- **书放在哪**：node 只认文件路径、不认 `content://`，所以放公共目录要「所有文件访问」（Android 11+）或写存储权限（10 及以下，
  靠 `requestLegacyExternalStorage`）。第一次用本机模式时问一次，不给就放 `Android/data/<包名>/files/books`（卸载时一起删）。
  换了位置（之后才授权）服务会以新的家目录重起，最近打开的书记的是绝对路径，照样打得开。
- **前台服务**：写一章要几分钟，切到别的 app 时系统会把后台 app 连同它起的子进程一起冻住（Android 11+ 的 cached apps freezer），
  模型的流断在半路。有前台服务的 app 不算后台。只在本机模式起；从最近任务里划掉 app 时连同 node 一起收掉。
- **令牌只走登录页**：壳不自己算 cookie（那是 `standalone/auth.ts` 的事），用 `postUrl` 交令牌，cookie 由服务端种。
- **系统栏跟页面主题**：页面换主题时把 `<meta name="theme-color">` 改成标题栏底色（`media/src/editor/shell.ts`），
  壳在页面加载完时注入一段 MutationObserver 盯住它，经 `addJavascriptInterface` 的 `NovelForgeShell.setBarColor` 染状态栏与导航栏、
  按深浅换图标颜色，并记下来供下次启动先用。这个口子只能换颜色，所以不怕页面里的 iframe 调到；没有这个 meta 的旧服务端照旧跟系统深浅色。

## 限制与待实机验证

- 只支持 arm64 手机，Android 8 起。APK 估计 40 MB 上下（node 与 ICU 数据占大头，解压后 90 MB）。
- 页面按触屏适配过（2026-10-24，Android 13 的 redroid 里实机走过一遍，做法见 [media/README.md「触屏与窄屏」](../../../media/README.md#触屏与窄屏手机android-壳)）：
  长按出右键菜单（WebView 长按会发 `contextmenu`，已实机确认）、菜单整个落在屏幕里、长按不选中界面上的字、软键盘弹出时
  输入框与光标那一行露得出来、名词 / 细纲 / 失败原因 / 叙事线总览的浮窗手指点或长按看得到。仍然看不到的：几处原生
  `title=` 提示（行上的小圆点、时间线卡片上的完整日期）。「在外部打开」（`xdg-open`）在手机上什么都不做，触屏上不显示这一项。
- 返回键先收页面里的层（2026-10-31）：只在无头浏览器与 jsdom 里验过 `nfBack()`，壳这一侧（`evaluateJavascript` 回调）没在真机上走过。
- redroid 里没有触屏设备，WebView 报的是 `(pointer: none)` 而不是 `(pointer: coarse)`；放大点击目标的样式两种都认，
  真手机上的 `coarse` 还没实测。
- Android 12+ 有 phantom process killer：后台子进程吃 CPU 多了会被杀。node 大部分时间在等模型的网络流，待实机确认。
