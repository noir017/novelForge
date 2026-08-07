/**
 * 把 media/ 下的静态资源 base64 内嵌进生成文件，
 * 使 bun build --compile 出的单文件可执行文件不依赖外部资源。
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'src', 'standalone', 'mediaAssets.ts');

const files = ['view.css', 'standalone.css', 'view.js', 'bridge.js', 'editor.js', 'explorer.js', 'icon.svg'];
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const lines = [
  '// 由 scripts/embed-media.js 生成，勿手改。',
  'export const MEDIA_ASSETS: Record<string, { mime: string; base64: string }> = {',
];
for (const name of files) {
  const buf = fs.readFileSync(path.join(MEDIA, name));
  lines.push(`  '${name}': { mime: '${MIME[path.extname(name)]}', base64: '${buf.toString('base64')}' },`);
}
lines.push('};');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${files.length} 个资源）`);
