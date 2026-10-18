/**
 * 临时工程夹具。
 *
 * 写入类用例一律在临时目录里跑——`sample-novel/` 有 hash 断言
 * （tests/contract/sampleNovel.test.js），任何写入都会把它弄红。需要拿真实夹具
 * 内容做写入实验的，用 `copyFixture()` 复制一份出来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, loadModule } = require('./load');

const SAMPLE = path.join(ROOT, 'sample-novel');

/**
 * 开一个空的临时目录，并返回一组绑定了该目录的路径助手。
 * @param {string} prefix 形如 `fileops`，最终目录名是 `novelforge-fileops-XXXX`
 */
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `novelforge-${prefix}-`));
  return { dir, ...pathHelpers(dir) };
}

function pathHelpers(dir) {
  const rel = (...p) => path.join(dir, ...p);
  return {
    rel,
    write(relPath, text) {
      fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
      fs.writeFileSync(rel(relPath), text, 'utf8');
    },
    read: (relPath) => fs.readFileSync(rel(relPath), 'utf8'),
    has: (relPath) => fs.existsSync(rel(relPath)),
    remove: (relPath) => fs.rmSync(rel(relPath), { recursive: true, force: true }),
  };
}

/**
 * 建一个初始化过的空工程：与作者点「初始化」走同一条路（`Workspace.initializeProject`：固定目录 → 经网关写空模板 →
 * manifest），而不是只建骨架。
 *
 * 网关单独 bundle 一份（`loadModule`），工程实例仍由调用方的 `projectMod` 造——用例后面拿 `t.project` 去调的全是自己
 * bundle 里的模块。网关只认实例上的路径与方法，不做 instanceof，两份 bundle 之间没有共享状态要对齐（模板只走
 * `mode: 'create'`，用不到宿主）。
 *
 * `keepExamples` 是从前 `initialize()` 还撒示例角色与示例设定时留下的开关：现在已经不撒了，删的是两个本来就不在的文件。
 *
 * @param {object} projectMod 载入的 `src/core/model/project.ts`
 * @param {object} [opts]
 * @param {string} [opts.prefix] 临时目录前缀
 * @param {string} [opts.title]
 * @param {boolean} [opts.keepExamples] 不删示例文件
 */
async function makeTempProject(projectMod, opts = {}) {
  const { prefix = 'project', title = '测试工程', keepExamples = false } = opts;
  const t = makeTempDir(prefix);
  const project = projectMod.NovelProject.open(t.dir);
  const { Workspace } = loadModule('src/core/workspace/index.ts');
  await new Workspace(project).initializeProject({ title, author: '测试' });
  if (!keepExamples) {
    fs.rmSync(t.rel('.novelforge/characters/example-protagonist.md'), { force: true });
    fs.rmSync(t.rel('.novelforge/lore/example-setting.md'), { force: true });
  }
  return { ...t, project };
}

/**
 * 把 `sample-novel/` 整个复制到临时目录，用于**需要写盘**的夹具用例。
 * 只读断言直接读 SAMPLE 即可，不必复制。
 */
function copyFixture(prefix = 'fixture') {
  const t = makeTempDir(prefix);
  fs.cpSync(SAMPLE, t.dir, { recursive: true });
  return t;
}

module.exports = { SAMPLE, makeTempDir, makeTempProject, copyFixture, pathHelpers };
