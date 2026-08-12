/**
 * 把 TypeScript 源码 bundle 成 CJS 后 require 出来——测试跑的是**源码**，不是构建产物。
 *
 * 两个入口的区别是**模块级状态**：
 * - `loadModule` 每次调用各自 bundle 一份，彼此不共享状态。
 * - `loadBundle` 把多个模块塞进同一个 bundle，于是它们共享 `host.ts` / `registry.ts` /
 *   `logger.ts` 的模块级单例。**要用 Host 的模块必须走这条路**：分开 bundle 会让每份产物
 *   各带一份 `host.ts`，`initHost` 只作用于其中一份，其余的仍然「宿主尚未初始化」。
 *
 * `external: ['vscode']` 是安全的，因为 tests/contract/corePurity.test.js 保证了
 * `src/core/` 永不 import vscode；真需要 vscode 的（builder / providers / session）
 * 另经 helpers/vscodeStub.js 打桩。
 */
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

/** bundle 一次要几十毫秒，同一个进程内重复加载同一组入口时直接复用。 */
const cache = new Map();

function compile(key, buildOptions, sourcefile) {
  if (cache.has(key)) return cache.get(key);
  const result = esbuild.buildSync({
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
    ...buildOptions,
  });
  const m = new Module(sourcefile, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, sourcefile));
  cache.set(key, m.exports);
  return m.exports;
}

/**
 * 加载单个模块。
 * @param {string} relPath 相对仓库根的路径，如 `src/core/model/markdown.ts`
 */
function loadModule(relPath) {
  return compile(
    `module:${relPath}`,
    { entryPoints: [path.join(ROOT, relPath)] },
    relPath
  );
}

/**
 * 把多个模块打进同一个 bundle，返回 `{ 别名: 模块 }`。
 * @param {Record<string, string>} entries 形如 `{ host: './src/core/host.ts' }`
 */
function loadBundle(entries) {
  const names = Object.keys(entries).sort();
  const key = `bundle:${names.map((n) => `${n}=${entries[n]}`).join(',')}`;
  // Windows 上传进来的路径可能带反斜杠，import 说明符里必须是正斜杠。
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath.replace(/\\/g, '/')}';`)
    .join('\n');
  return compile(
    key,
    { stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' } },
    'bundle.ts'
  );
}

module.exports = { ROOT, loadModule, loadBundle };
