/**
 * 把 media/src/ 下的前端源码打包成 dist/media/ 的四个 .js 与两个 .css。
 *
 * **产物落在 dist/，不入库**——和 `dist/extension.js` 同一个去处，仓库里只留
 * `media/src/` 的源码与 `media/icon.svg`。`media/` 根目录下不再有任何 `.js`
 * / `.css`，看见了就是上一版残留，删掉即可。
 *
 * 产物是 IIFE 格式的 classic script，不是 ES module：webview 的 CSP 用 nonce
 * 放行脚本，而 nonce 不传递给 `import` 进来的模块——原生模块要么得开
 * `strict-dynamic`，要么就打包，这里选打包。顺带 jsdom 的 `window.eval`
 * 也只吃得下 classic script，smoke-view.js 不必改加载方式。
 *
 * 用法：node scripts/build-media.js [--watch]
 */
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'media', 'src');
const OUT = path.join(ROOT, 'dist', 'media');

/** 产物名 → 入口。键就是最终的文件名（不含扩展名）。 */
const JS_ENTRIES = {
  view: path.join(SRC, 'view', 'index.ts'),
  editor: path.join(SRC, 'editor', 'index.ts'),
  explorer: path.join(SRC, 'explorer', 'index.ts'),
  bridge: path.join(SRC, 'bridge', 'index.ts'),
};

const CSS_ENTRIES = {
  view: path.join(SRC, 'css', 'view.css'),
  standalone: path.join(SRC, 'css', 'standalone.css'),
};

const NOTICE = '由 media/src/ 构建生成（node scripts/build-media.js），勿手改。';

/** 把 esbuild 的错误打成人读得懂的一行。watch 模式下每次重建都会走一遍。 */
const reporter = {
  name: 'media-reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [media] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const COMMON = {
  bundle: true,
  format: 'iife',
  outdir: OUT,
  // webview 是 Electron 的 Chromium，独立版是现代浏览器，两边都吃得下 ES2022。
  platform: 'browser',
  target: ['es2022'],
  // 不压缩：这几个文件要么被 base64 内嵌进单文件可执行文件，要么由 webview
  // 直接加载，体积从来不是瓶颈；出问题时能在 devtools 里读到人话更要紧。
  minify: false,
  logLevel: 'silent',
  plugins: [reporter],
};

/**
 * @param {{ watch?: boolean, quiet?: boolean }} [opts]
 */
async function buildMedia(opts = {}) {
  const { watch = false, quiet = false } = opts;

  const contexts = await Promise.all([
    esbuild.context({
      ...COMMON,
      entryPoints: JS_ENTRIES,
      banner: { js: `// ${NOTICE}` },
      // 只在 watch 时给一份内联 sourcemap，devtools 里能直接落到 media/src 的
      // 原文件；一次性构建不带，免得把源码整个塞进 base64 内嵌资源表。
      sourcemap: watch ? 'inline' : false,
    }),
    esbuild.context({
      ...COMMON,
      entryPoints: CSS_ENTRIES,
      banner: { css: `/* ${NOTICE} */` },
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }
  try {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
  if (!quiet) {
    const n = Object.keys(JS_ENTRIES).length + Object.keys(CSS_ENTRIES).length;
    console.log(`✓ 构建 dist/media/（${n} 个产物）`);
  }
}

/** 产物目录的绝对路径。下游（embed-media、smoke-view）从这里取，别各自拼。 */
const MEDIA_OUT_DIR = OUT;

module.exports = { buildMedia, MEDIA_OUT_DIR };

if (require.main === module) {
  buildMedia({ watch: process.argv.includes('--watch') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
