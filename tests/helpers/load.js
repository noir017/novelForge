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
 *
 * ## 磁盘缓存
 *
 * `node:test` **每个文件起一个进程**，而下面那个 Map 只在进程内有效——全量跑一轮
 * 七十来个文件各自 bundle 一遍，同一份 `src/core/` 被 esbuild 反复啃，合计近二十秒
 * CPU。所以 bundle 结果另存一份到磁盘，进程之间共享。
 *
 * 缓存**按输入文件的 mtime + 体积校验**：esbuild 的 metafile 给出这次 bundle 到底
 * 读了哪些文件，把它们的 mtime 记下来，下次全都没变才复用。改一个 `src/` 下的文件，
 * 凡是 bundle 到它的条目全部自动失效——不需要手动清缓存，也不会拿旧产物跑出假绿。
 * 校验本身只是几十个 `statSync`，比重新 bundle 便宜两个数量级。
 *
 * 缓存落在 `node_modules/.cache/`（已被 .gitignore 挡住，且 `npm ci` 会一并清掉）。
 * 读写全部包在 try 里：缓存是纯优化，坏了就当没有，绝不能让它把测试搞失败。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

/** bundle 一次要几十毫秒，同一个进程内重复加载同一组入口时直接复用。 */
const cache = new Map();

/** 跨进程的磁盘缓存目录。`NF_TEST_NO_BUNDLE_CACHE=1` 可整个关掉。 */
const DISK_CACHE = path.join(ROOT, 'node_modules', '.cache', 'nf-bundle', esbuild.version);
const DISK_ENABLED = process.env.NF_TEST_NO_BUNDLE_CACHE !== '1';

const cacheFile = (key) =>
  path.join(DISK_CACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json');

/** 输入文件的指纹：mtime 与体积，够挡住一切正常的编辑。 */
function stampOf(files) {
  const stamp = {};
  for (const rel of files) {
    const st = fs.statSync(path.join(ROOT, rel));
    stamp[rel] = `${st.mtimeMs}:${st.size}`;
  }
  return stamp;
}

/** 缓存里记的那些输入还都是原样吗。任何一个动过、少了，就算失效。 */
function stampMatches(stamp) {
  try {
    for (const [rel, want] of Object.entries(stamp)) {
      const st = fs.statSync(path.join(ROOT, rel));
      if (`${st.mtimeMs}:${st.size}` !== want) return false;
    }
    return true;
  } catch {
    // 输入文件没了（改名/删除）——重新 bundle 会给出真正的报错。
    return false;
  }
}

function readDisk(key) {
  if (!DISK_ENABLED) return null;
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
    return stampMatches(hit.stamp) ? hit.code : null;
  } catch {
    return null;
  }
}

function writeDisk(key, code, metafile) {
  if (!DISK_ENABLED) return;
  try {
    fs.mkdirSync(DISK_CACHE, { recursive: true });
    const stamp = stampOf(Object.keys(metafile.inputs));
    // 先写临时文件再 rename：并发的测试进程可能同时写同一个 key，
    // rename 是原子的，读到的要么是完整的旧版要么是完整的新版，不会是半截。
    const tmp = `${cacheFile(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ stamp, code }));
    fs.renameSync(tmp, cacheFile(key));
  } catch {
    /* 缓存写不进去不影响正确性 */
  }
}

function instantiate(code, sourcefile) {
  const m = new Module(sourcefile, null);
  m._compile(code, path.join(ROOT, sourcefile));
  return m.exports;
}

function compile(key, buildOptions, sourcefile) {
  if (cache.has(key)) return cache.get(key);

  let code = readDisk(key);
  if (code === null) {
    const result = esbuild.buildSync({
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      external: ['vscode'],
      // metafile 给出这次读了哪些文件，磁盘缓存拿它做失效判断。
      metafile: true,
      ...buildOptions,
    });
    code = result.outputFiles[0].text;
    writeDisk(key, code, result.metafile);
  }

  const exports = instantiate(code, sourcefile);
  cache.set(key, exports);
  return exports;
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
