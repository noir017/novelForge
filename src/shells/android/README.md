# android — Android 壳

手机上的 Novel Forge。和桌面壳一样是**一层纯壳**：页面就是独立版的那一个（`src/shells/standalone/page.ts` 吐出来的，
窄屏布局），壳只决定打开哪个地址，没有一行 TS。

两种模式，第一次打开时选，之后按返回键 →「服务端设置…」随时换：

- **本机**（内置服务）：app 里带着独立版打成的 node 单文件和 Termux 编的 node，起在 `127.0.0.1` 上，带每台设备随机生成的令牌，
  壳替作者走 `/login` 登录（`WebView.postUrl`），再打开首页。
- **远程**：不起内置服务，打开设置里填的服务器地址（Docker 版，或 `--host` 绑出去的独立版）。填了令牌就替作者登录，空着就在网页上登录。

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

- `.github/workflows/android.yml`：手动点出 debug 包（artifact `android`）。
- 发版时 `release.yml` 调它出发版签名的包，附件名 `NovelForge-<版本>-android-arm64.apk`。发版密钥在仓库 secrets
  `NOVELFORGE_KEYSTORE_BASE64` / `NOVELFORGE_KEYSTORE_PASSWORD` 里（别名 `novelforge`），**缺了整个 Release 停下**——
  退回 debug 签名的话，装过的人升不了级（签名不同不能覆盖安装）。

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
  代价是服务端设置只能做成原生对话框（远程那台的页面不认识这个壳），入口是返回键——页面是单页，返回键没有「上一页」可回。
- **书放在哪**：node 只认文件路径、不认 `content://`，所以放公共目录要「所有文件访问」（Android 11+）或写存储权限（10 及以下，
  靠 `requestLegacyExternalStorage`）。第一次用本机模式时问一次，不给就放 `Android/data/<包名>/files/books`（卸载时一起删）。
  换了位置（之后才授权）服务会以新的家目录重起，最近打开的书记的是绝对路径，照样打得开。
- **前台服务**：写一章要几分钟，切到别的 app 时系统会把后台 app 连同它起的子进程一起冻住（Android 11+ 的 cached apps freezer），
  模型的流断在半路。有前台服务的 app 不算后台。只在本机模式起；从最近任务里划掉 app 时连同 node 一起收掉。
- **令牌只走登录页**：壳不自己算 cookie（那是 `standalone/auth.ts` 的事），用 `postUrl` 交令牌，cookie 由服务端种。

## 限制与待实机验证

- 只支持 arm64 手机，Android 8 起。APK 估计 40 MB 上下（node 与 ICU 数据占大头，解压后 90 MB）。
- 页面是为鼠标写的：右键菜单在手机上靠长按（Chromium 长按会发 `contextmenu`，待实机确认）；悬停浮窗（名词、章节）手机上看不到；
  「在外部打开」（`xdg-open`）在手机上什么都不做。
- Android 12+ 有 phantom process killer：后台子进程吃 CPU 多了会被杀。node 大部分时间在等模型的网络流，待实机确认。
