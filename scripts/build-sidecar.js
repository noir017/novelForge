/**
 * 把独立版编译成**带 target triple 后缀**的单文件可执行，放进 `src-tauri/binaries/`，
 * 供桌面壳（Tauri）当 sidecar 打包。
 *
 * 与 `npm run dist` 是同一件事、同一份产物，只有落点和文件名不同：Tauri 的
 * `externalBin` 约定「同名 + `-<target triple>` 后缀」，找不到就直接构建失败。
 *
 * 交叉编译由 Bun 自己完成（`--target=bun-windows-x64` 等），所以在 WSL2 里也能
 * 出 Windows 的 sidecar。但**Tauri 的 Rust 壳不能这样交叉编译**——Windows 安装包
 * 仍要在 Windows 上（或 CI 的 windows runner 上）构建，见 .github/workflows/app.yml。
 *
 * 用法：
 *   node scripts/build-sidecar.js            # 当前平台
 *   node scripts/build-sidecar.js linux
 *   node scripts/build-sidecar.js windows
 *   node scripts/build-sidecar.js all
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join('src', 'standalone', 'main.ts');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'binaries');

/** sidecar 的基名。必须与 tauri.conf.json 的 `externalBin` 末段一致。 */
const BASE = 'novelforge';

/**
 * 目标平台表。加一个平台就在这里加一行，同时记得在 CI 的 matrix 里加一台 runner
 * ——sidecar 能交叉编译，Rust 壳不能。
 */
const TARGETS = {
  linux: {
    bunTarget: 'bun-linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    ext: '',
    nativeOnlyArgs: [],
  },
  windows: {
    bunTarget: 'bun-windows-x64',
    triple: 'x86_64-pc-windows-msvc',
    ext: '.exe',
    // sidecar 是后台进程，不该闪出命令行窗口。这两个开关 Bun 只在**Windows 上
    // 编译时**接受（在 Linux 上交叉编译会直接报错），所以只有原生构建才加。
    // 少了它也无妨：Tauri spawn sidecar 时本来就带 CREATE_NO_WINDOW，这只是
    // 第二道保险（顺带让手动双击时不至于莫名弹窗）。CI 的 windows runner 是
    // 原生构建，所以正式产物里这两个开关是生效的。
    nativeOnlyArgs: ['--windows-hide-console', '--windows-title=Novel Forge 服务'],
  },
};

function hostKey() {
  if (process.platform === 'win32') {
    return 'windows';
  }
  if (process.platform === 'linux') {
    return 'linux';
  }
  throw new Error(`当前平台还没有 sidecar 目标：${process.platform}（在 TARGETS 里加一行）`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
  }
}

function buildOne(key) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`未知目标 "${key}"，可选：${Object.keys(TARGETS).join(' / ')} / all`);
  }
  const outfile = path.join(OUT_DIR, `${BASE}-${target.triple}${target.ext}`);
  const native = key === hostKey();
  if (!native && target.nativeOnlyArgs.length > 0) {
    console.log(`  （交叉编译，跳过 ${target.nativeOnlyArgs.join(' ')}——Bun 只在原生构建时接受）`);
  }
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    ...(native ? target.nativeOnlyArgs : []),
    `--outfile=${outfile}`,
    ENTRY,
  ]);
  const mb = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${path.relative(ROOT, outfile)}（${mb} MB）`);
}

function main() {
  const arg = process.argv[2] ?? 'host';
  const keys = arg === 'all' ? Object.keys(TARGETS) : [arg === 'host' ? hostKey() : arg];

  // 前端资源要先内嵌进 mediaAssets.ts，否则编出来的可执行文件找不到 view.js。
  // 与 `npm run dist` 同一条前置，不能省。
  run(process.execPath, [path.join('scripts', 'embed-media.js')]);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const key of keys) {
    buildOne(key);
  }
}

try {
  main();
} catch (err) {
  console.error(`✘ ${err.message}`);
  process.exit(1);
}
