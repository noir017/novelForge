/**
 * 把前端资源 base64 内嵌进生成文件，
 * 使 bun build --compile 出的单文件可执行文件不依赖外部资源。
 *
 * 资源分两处：`.js` / `.css` 是 `media/src/` 的构建产物（在 `dist/media/`，
 * 不入库），`icon.svg` 是仓库里的静态文件（在 `media/`）。所以这里先跑一次
 * 构建再读盘——克隆下来直接 `npm run standalone` 的人不该撞上「找不到
 * view.js」，也不该内嵌到一份过期的产物。
 *
 * **顺手把内置技能也烘一遍**（`build-skills.js`）。它是另一份生成文件、另一批
 * 输入，本来不该挤在这里；放这儿只是因为这个脚本已经是全部构建路径的公共前置
 * （`pretypecheck` / `pretest:e2e` / `standalone` / `dist` / `build-sidecar`），
 * 而 `builtin.ts` **被 `core/` import**——少生成一次不是「资源过期」，是编译
 * 直接失败。两份各自幂等，跑两遍不会互相踩。
 *
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');
const { buildMedia, MEDIA_OUT_DIR } = require('./build-media');
const { buildSkills } = require('./build-skills');

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
  buildSkills({ quiet: true });

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
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${assets.length} 个资源）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
