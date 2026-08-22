const esbuild = require('esbuild');
const { buildMedia } = require('./scripts/build-media');
const { buildSkills } = require('./scripts/build-skills');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // 前端资源（media/src → dist/media/）与扩展主体一起构建：
  // F5 调试前只跑 `npm run compile`，漏了这一步 webview 会 404。
  await buildMedia({ watch });
  // 内置技能烘成 src/core/skills/builtin.ts。它被 core/ import，
  // 少了这一步 esbuild 直接报「找不到模块」。
  buildSkills({ quiet: true });

  const ctx = await esbuild.context({
    entryPoints: ['src/shells/vscode/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
