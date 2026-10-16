/**
 * 把前端资源 base64 内嵌进生成文件，
 * 使 bun build --compile 出的单文件可执行文件不依赖外部资源。
 *
 * 资源分两处：`.js` / `.css` 是 `media/src/` 的构建产物（在 `dist/media/`，
 * 不入库），`icon.svg` 是仓库里的静态文件（在 `media/`）。所以这里先跑一次
 * 构建再读盘——克隆下来直接 `npm run standalone` 的人不该撞上「找不到
 * view.js」，也不该内嵌到一份过期的产物。
 *
 * 顺带写进去的还有**版本号**（`PRODUCT_VERSION`，取自仓库根 `package.json`）：单文件
 * 可执行旁边没有 `package.json`，运行时去读只能读到 0.0.0。每一条出单文件的路
 * （独立版、桌面 sidecar、release）都先跑这个脚本，所以版本号跟着资源一起进程序。
 *
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');
const { buildMedia, MEDIA_OUT_DIR } = require('./build-media');

const ROOT = path.join(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'src', 'shells', 'standalone', 'mediaAssets.ts');

/** 构建产物（在 dist/media/）。加新产物时这里与 build-media 的 entryPoints 同改。 */
const built = ['view.css', 'standalone.css', 'view.js', 'bridge.js', 'editor.js', 'explorer.js'];
/** 仓库里的静态资源（在 media/）。 */
const staticFiles = ['icon.svg'];

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function main() {
  await buildMedia({ quiet: true });

  const assets = [
    ...built.map((name) => [name, path.join(MEDIA_OUT_DIR, name)]),
    ...staticFiles.map((name) => [name, path.join(STATIC_DIR, name)]),
  ];

  const lines = [
    '// 由 scripts/embed-media.js 生成，勿手改。',
    'export const MEDIA_ASSETS: Record<string, { mime: string; base64: string }> = {',
  ];
  for (const [name, file] of assets) {
    const buf = fs.readFileSync(file);
    lines.push(`  '${name}': { mime: '${MIME[path.extname(name)]}', base64: '${buf.toString('base64')}' },`);
  }
  lines.push('};');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  lines.push('', '/** 仓库根 `package.json` 的版本号，「帮助 → 关于」显示它。 */');
  lines.push(`export const PRODUCT_VERSION = ${JSON.stringify(version)};`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${assets.length} 个资源，版本 ${version}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
