/**
 * 把独立版打成**node 跑的单文件**（`server.cjs`），给 Android 壳当内置服务端。
 *
 * 别的出单文件的路都是 `bun build --compile`（独立版、桌面 sidecar、Docker），Android 上没有 Bun：
 * 壳里带的是 Termux 编的 node，所以这里用 esbuild 按 node 平台打包，`ws` 一起打进去
 * （它的两个可选加速模块 bufferutil / utf-8-validate 是原生模块，不带，`ws` 自己会退回纯 JS）。
 * 服务端在 node 上怎么监听见 src/shells/standalone/serve.ts。
 *
 * 用法：node scripts/build-android-server.js <输出文件>
 *   先跑 embed-media（前端资源与版本号进程序），再打包。
 *
 * tests/integration/shells/nodeServer.test.js 也调 `bundleServer`，但传 `stubMedia`：
 * 测试并行跑，重新构建 dist/media 会和读它的 dom 测试撞车，而那组用例不看前端资源。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { embedSkills } = require('./embed-skills');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'shells', 'standalone', 'main.ts');

/**
 * @param {{ outfile: string, stubMedia?: boolean }} opts
 */
async function bundleServer({ outfile, stubMedia = false }) {
  embedSkills({ quiet: true });
  const plugins = stubMedia
    ? [
        {
          name: 'stub-media',
          setup(build) {
            build.onResolve({ filter: /\/mediaAssets$/ }, () => ({ path: 'mediaAssets', namespace: 'stub-media' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-media' }, () => ({
              contents: "export const MEDIA_ASSETS = {};\nexport const PRODUCT_VERSION = '0.0.0';\n",
              loader: 'ts',
            }));
          },
        },
      ]
    : [];
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Termux 的 nodejs-lts 眼下是 24；CI 与测试跑在 22 上，取低的那个。
    target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
    plugins,
  });
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node scripts/build-android-server.js <输出文件>');
    process.exit(1);
  }
  const embed = spawnSync(process.execPath, [path.join(__dirname, 'embed-media.js')], { stdio: 'inherit' });
  if (embed.status !== 0) {
    process.exit(embed.status ?? 1);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  bundleServer({ outfile: path.resolve(out) })
    .then(() => {
      const size = fs.statSync(out).size / 1e6;
      console.log(`✓ 生成 ${path.relative(ROOT, path.resolve(out))}（${size.toFixed(1)} MB）`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { bundleServer };
