/**
 * 独立版 Web 服务的端到端：进程内起服务 → HTTP 拿页面/资源 → WS 握手拿 init →
 * 目录列举、状态机选章、内置编辑器与章节草稿的读写往返。
 * 迁自 scripts/smoke-server.js（57 个 check 调用点 → 62 条用例，静态资源那条
 * 在 6 个产物上循环）。
 *
 * **只在 Bun 下跑**：`bun test tests/e2e/`。ESM、直接 import TypeScript、
 * `import.meta.dir`、全局 WebSocket/fetch、`Bun.serve` —— 一样都不迁就 Node。
 * `bun test` 实现了 node:test 的接口，所以写法与其余测试一致。
 * 跑之前需要 `node scripts/embed-media.js`（生成 src/standalone/mediaAssets.ts
 * 与 dist/media/，都已 gitignore），否则 html.ts 的 import 直接炸。
 *
 * 不另起子进程：避免 Windows 上子进程杀不干净留下占用端口的孤儿。
 *
 * ## 迁移修掉的一个 harness 缺陷（不是断言缺陷）
 *
 * 原脚本是 `try { …57 条断言… } finally { process.exit(failures === 0 ? 0 : 1) }`。
 * `waitFor` 的 5 秒超时是 reject：异常沿顶层 await 抛出，但 `finally` 先执行，
 * 而此时 `failures` 仍是 0 —— **于是超时、崩溃、连不上一律以退出码 0 收场**。
 * 这条绿灯长期是部分失效的。断言本身没问题，逐条原样迁过来了；
 * 换到 node:test 之后，被拒绝的异步用例就是一条失败，这个坑由结构本身堵上。
 *
 * ## 已知限制：两个服务关不掉
 *
 * `startServer()` 只返回端口号（src/standalone/server.ts:30,146），拿不到
 * `Bun.serve` 句柄，所以 after() 只能关 WebSocket，HTTP 服务会挂到进程退出为止。
 * 原脚本靠 process.exit 收尾。真要修得改 startServer 的返回值，超出本次范围。
 *
 * ## 顺序是硬约束
 *
 * `startServer` 里调的 `initHost()` 是模块级单例：3998 的服务一起，全局 host
 * 就被换掉。所以 3999 的用例必须**全部跑完**，才能进临时工程那两节。
 * describe 按源码顺序执行，setup 放各自的 before()，这条约束自然成立。
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer } from '../../../src/standalone/server';
import { connect } from '../../helpers/ws.js';

const PORT = 3999;
// 写入类用例不能碰 sample-novel（tests/contract/sampleNovel.test.js 对它有 hash
// 断言），另开临时工程。
const EDIT_PORT = 3998;
const root = path.join(import.meta.dir, '..', '..', '..', 'sample-novel');
const base = `http://127.0.0.1:${PORT}`;

const nameOf = (list) => list.map((e) => e.name);

let conn;

before(async () => {
  startServer({ root, port: PORT });
  conn = connect(PORT);
  await conn.ready;
});

// ---------------------------------------------------------------------------

describe('静态资源', () => {
  const assets = ['view.js', 'bridge.js', 'editor.js', 'explorer.js', 'view.css', 'standalone.css'];
  let html;
  const status = {};

  before(async () => {
    html = await (await fetch(`${base}/`)).text();
    for (const asset of assets) {
      status[asset] = (await fetch(`${base}/media/${asset}`)).status;
    }
  });

  test('首页含 view.js', () => {
    assert.ok(html.includes('view.js'));
  });

  test('首页含 editor.js', () => {
    assert.ok(html.includes('editor.js'));
  });

  test('首页含 explorer.js', () => {
    assert.ok(html.includes('explorer.js'));
  });

  test('首页含 standalone.css', () => {
    assert.ok(html.includes('standalone.css'));
  });

  test('首页含编辑器容器', () => {
    assert.ok(html.includes('id="wbEditor"'));
  });

  test('首页含资源管理器容器', () => {
    assert.ok(html.includes('id="filesBody"'));
  });

  test('首页标题带工程名', () => {
    assert.ok(html.includes('sample-novel'));
  });

  for (const asset of assets) {
    test(`${asset} 可取`, () => {
      assert.equal(status[asset], 200);
    });
  }
});

// ---------------------------------------------------------------------------

describe('WebSocket 与 Origin 校验', () => {
  let first;
  let bad;
  let good;

  before(async () => {
    first = await conn.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');
    // 浏览器发得出跨源 WS 请求，所以 Origin 必须在服务端挡。
    bad = await fetch(`${base}/ws`, {
      headers: { origin: 'http://evil.example.com', upgrade: 'websocket', connection: 'Upgrade' },
    });
    good = await fetch(`${base}/ws`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  });

  test('首条消息是 init/state', () => {
    assert.ok(first.type === 'init' || first.type === 'state', first.type);
  });

  test('跨源 Origin 被拒 403', () => {
    assert.equal(bad.status, 403);
  });

  test('同源 Origin 不被 403', () => {
    assert.notEqual(good.status, 403);
  });
});

// ---------------------------------------------------------------------------

describe('内置编辑器：只读用例', () => {
  let opened;
  let escaped;
  let json;

  before(async () => {
    conn.send({ type: 'openEditor', path: 'chapters/001-楔子.md' });
    opened = await conn.waitFor((m) => m.type === 'editorOpen', 'editorOpen');

    conn.send({ type: 'openEditor', path: '../../../package.json' });
    escaped = await conn.waitFor((m) => m.type === 'editorError', '越界 editorError');

    conn.send({ type: 'openEditor', path: '.novelforge/project.json' });
    json = await conn.waitFor((m) => m.type === 'editorOpen', 'json editorOpen');
  });

  test('打开章节返回内容', () => {
    assert.ok(opened.file.text.length > 0);
  });

  test('带 hash 基线', () => {
    assert.ok(typeof opened.file.hash === 'string' && opened.file.hash.length > 0);
  });

  test('path 用正斜杠', () => {
    assert.ok(!opened.file.path.includes('\\'), opened.file.path);
  });

  test('越界路径被拒', () => {
    assert.ok(escaped.message.includes('超出工程目录'), escaped.message);
  });

  test('工程内 json 可打开', () => {
    assert.equal(json.file.name, 'project.json');
  });
});

// ---------------------------------------------------------------------------

describe('资源管理器：目录列举', () => {
  let rootEntries;
  let multi;
  let chapters;
  let outside;
  let gone;

  before(async () => {
    conn.send({ type: 'listDir', dirs: [''] });
    const rootList = await conn.waitFor((m) => m.type === 'dirListings', 'dirListings');
    rootEntries = rootList.listings.find((l) => l.relPath === '').entries;

    // 一次多个目录：前端展开好几层时不该来回好几趟。
    conn.send({ type: 'listDir', dirs: ['', 'chapters', '.novelforge'] });
    multi = await conn.waitFor((m) => m.type === 'dirListings' && m.listings.length === 3, '多目录 dirListings');
    chapters = multi.listings.find((l) => l.relPath === 'chapters');

    // 越界不能靠前端自觉：路径是前端传上来的。
    conn.send({ type: 'listDir', dirs: ['../..'] });
    outside = await conn.waitFor(
      (m) => m.type === 'dirListings' && m.listings[0].relPath === '../..',
      '越界 dirListings'
    );

    // 不存在的目录降级成 error，不让常驻侧栏跟着炸。
    conn.send({ type: 'listDir', dirs: ['没有这个目录'] });
    gone = await conn.waitFor(
      (m) => m.type === 'dirListings' && m.listings[0].relPath === '没有这个目录',
      '缺目录 dirListings'
    );
  });

  // 这一条是「文件」页存在的理由：工程页永远看不见 .novelforge。
  test('列出点开头的目录', () => {
    assert.ok(nameOf(rootEntries).includes('.novelforge'), nameOf(rootEntries).join(','));
  });

  test('列出章节目录', () => {
    assert.ok(nameOf(rootEntries).includes('chapters'), nameOf(rootEntries).join(','));
  });

  test('目录排在文件之前', () => {
    assert.ok(
      rootEntries.findIndex((e) => e.kind === 'file') > rootEntries.findLastIndex((e) => e.kind === 'dir'),
      nameOf(rootEntries).join(',')
    );
  });

  test('目录不标 editable', () => {
    assert.ok(rootEntries.every((e) => e.kind !== 'dir' || e.editable === false));
  });

  test('.md 标为可编辑', () => {
    assert.ok(rootEntries.filter((e) => e.name.endsWith('.md')).every((e) => e.editable === true));
  });

  test('一次返回三个目录', () => {
    assert.equal(multi.listings.length, 3);
  });

  test('章节目录列得出文件', () => {
    assert.ok(chapters.entries.some((e) => e.name.endsWith('.md')), nameOf(chapters.entries).join(','));
  });

  test('子项 relPath 带父目录', () => {
    assert.ok(
      chapters.entries.every((e) => e.relPath.startsWith('chapters/')),
      nameOf(chapters.entries).join(',')
    );
  });

  test('越界目录被拒', () => {
    assert.ok(!!outside.listings[0].error, JSON.stringify(outside.listings[0]));
  });

  test('越界不返回任何条目', () => {
    assert.equal(outside.listings[0].entries.length, 0);
  });

  test('不存在的目录给出人话原因', () => {
    assert.ok(gone.listings[0].error.includes('目录不存在'), gone.listings[0].error);
  });
});

// ---------------------------------------------------------------------------

// 这是**唯一一条**跑真控制器状态机的用例：前端只知道「我点了第 3 章」，
// 落在哪一层由后端算。别的用例要么测纯函数、要么测前端。
describe('选中章节 → 状态机决定落在哪一层', () => {
  let session;
  let pipe;
  let outlinePipe;
  let toasted;

  before(async () => {
    // 连上时后端推过一轮全量状态，里面就有一条 session。不清掉的话
    // 下面的 waitFor 会立刻拿到那条旧的，而不是这次切目标的结果。
    conn.drain();
    conn.send({ type: 'selectChapter', chapterRelPath: 'chapters/003-夜访.md' });
    session = await conn.waitFor((m) => m.type === 'session', 'session');
    pipe = await conn.waitFor((m) => m.type === 'pipeline', 'pipeline');

    // 全书大纲层没有「这一章的四段」，但一样要有工作区卡与下一步。
    conn.send({ type: 'setTarget', target: { kind: 'outline' } });
    await conn.waitFor((m) => m.type === 'session', 'session（大纲）');
    outlinePipe = await conn.waitFor((m) => m.type === 'pipeline', 'pipeline（大纲）');

    // 章节刚被改名/删掉时不能让整条推送失败。
    conn.send({ type: 'selectChapter', chapterRelPath: 'chapters/不存在.md' });
    toasted = await conn.waitFor((m) => m.type === 'toast', 'toast');
  });

  // sample-novel 没有 plans/，所以每一章都停在「待写细纲」——
  // 旧版这里一律落到 manuscript，作者一进来就被丢进正文层。
  test('没细纲的章节落到细纲层', () => {
    assert.equal(session.session.stage, 'plan');
  });

  test('目标指向那一章', () => {
    assert.equal(session.session.target.chapterRelPath, 'chapters/003-夜访.md');
  });

  test('推来流水线', () => {
    assert.equal(pipe.pipeline?.order, 3);
  });

  test('推来工作区卡', () => {
    assert.ok(!!pipe.workbench, JSON.stringify(pipe.workbench));
  });

  test('没细纲时工作区卡说明缺什么', () => {
    assert.ok(!!pipe.workbench.empty, JSON.stringify(pipe.workbench));
  });

  test('下一步是生成细纲', () => {
    assert.ok(
      pipe.next?.stage === 'plan' && pipe.next?.capability === 'generate',
      JSON.stringify(pipe.next)
    );
  });

  test('下一步带上落点', () => {
    assert.equal(pipe.next?.target.chapterRelPath, 'chapters/003-夜访.md');
  });

  test('大纲层不带章节流水线', () => {
    assert.equal(outlinePipe.pipeline, undefined);
  });

  test('大纲层仍有工作区卡', () => {
    assert.equal(outlinePipe.workbench?.stage, 'outline');
  });

  test('选不存在的章节给提示而非崩', () => {
    assert.equal(toasted.level, 'error', JSON.stringify(toasted));
  });
});

// ---------------------------------------------------------------------------

// 从这里起换到临时工程（3998）：写入类用例一个字节都不能落到 sample-novel 上。
// startServer 里的 initHost 是单例，所以 3999 的用例必须已经全部跑完。
describe('临时工程（写入类用例）', () => {
  const rel = 'chapters/001-测试.md';
  let work;
  let edit;
  let f1;

  before(async () => {
    conn.ws.close();

    work = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-server-'));
    fs.mkdirSync(path.join(work, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(work, rel), '# 测试\n\n初始内容。\n', 'utf8');
    startServer({ root: work, port: EDIT_PORT });

    edit = connect(EDIT_PORT);
    await edit.ready;
    await edit.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');

    edit.send({ type: 'openEditor', path: rel });
    f1 = await edit.waitFor((m) => m.type === 'editorOpen', 'editorOpen');
  });

  after(() => {
    edit?.ws.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  describe('内置编辑器：读写往返', () => {
    let saved;
    let conflict;
    let diskAfterSave;
    let diskAfterConflict;
    let diskAfterForce;
    let badSave;
    let escapeCreated;
    let badExt;
    let bare;

    before(async () => {
      edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n改过的内容。\n', baseHash: f1.file.hash });
      saved = await edit.waitFor((m) => m.type === 'editorSaved', 'editorSaved');
      diskAfterSave = fs.readFileSync(path.join(work, rel), 'utf8');

      // 用过期的 baseHash 再存一次，模拟「文件已被别处改过」。
      edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n第三版。\n', baseHash: f1.file.hash });
      conflict = await edit.waitFor((m) => m.type === 'editorConflict', 'editorConflict');
      diskAfterConflict = fs.readFileSync(path.join(work, rel), 'utf8');

      // 用户明确选择强制覆盖：不带 baseHash。
      edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n第三版。\n' });
      await edit.waitFor((m) => m.type === 'editorSaved', '强制保存 editorSaved');
      diskAfterForce = fs.readFileSync(path.join(work, rel), 'utf8');

      edit.send({ type: 'saveFile', path: '../escape.md', text: 'x' });
      badSave = await edit.waitFor((m) => m.type === 'editorError', '越界保存 editorError');
      escapeCreated = fs.existsSync(path.join(path.dirname(work), 'escape.md'));

      edit.send({ type: 'openEditor', path: 'chapters/nope.png' });
      badExt = await edit.waitFor((m) => m.type === 'editorError', '扩展名 editorError');

      // 章节可以没有扩展名——白名单挡不住它，章节判定规则得放它过去。
      fs.writeFileSync(path.join(work, 'chapters/002-无扩展名'), '没有扩展名的一章。\n', 'utf8');
      edit.send({ type: 'openEditor', path: 'chapters/002-无扩展名' });
      bare = await edit.waitFor((m) => m.type === 'editorOpen', '无扩展名 editorOpen');
    });

    test('保存落盘', () => {
      assert.ok(diskAfterSave.includes('改过的内容'));
    });

    test('回传新 hash', () => {
      assert.notEqual(saved.file.hash, f1.file.hash);
    });

    test('过期基线触发冲突', () => {
      assert.equal(conflict.path, rel);
    });

    test('冲突时不覆盖磁盘', () => {
      assert.ok(diskAfterConflict.includes('改过的内容'));
    });

    test('冲突带回磁盘版本', () => {
      assert.ok(conflict.diskText.includes('改过的内容'));
    });

    test('强制保存生效', () => {
      assert.ok(diskAfterForce.includes('第三版'));
    });

    test('越界保存被拒', () => {
      assert.ok(badSave.message.includes('超出工程目录'), badSave.message);
    });

    test('越界文件未创建', () => {
      assert.ok(!escapeCreated);
    });

    test('非文本扩展名被拒', () => {
      assert.ok(badExt.message.includes('不是可编辑的文本文件'), badExt.message);
    });

    test('无扩展名的章节可打开', () => {
      assert.ok(bare.file.text.includes('没有扩展名的一章'), bare.file.text);
    });

    test('无扩展名章节也带 draftPath', () => {
      assert.equal(bare.file.draftPath, 'drafts/002-无扩展名');
    });
  });

  describe('章节草稿', () => {
    let draft;
    let draftOnDisk;
    let draft2;
    let missing;
    let phantomDraft;

    before(async () => {
      edit.send({ type: 'openDraft', path: rel });
      draft = await edit.waitFor(
        (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/'),
        'draft editorOpen'
      );
      draftOnDisk = fs.existsSync(path.join(work, 'drafts/001-测试.md'));

      // 作者在草稿里写了东西，再点一次不能被抹掉。
      fs.writeFileSync(path.join(work, 'drafts/001-测试.md'), '# 测试 · 草稿\n\n手写的内容。\n', 'utf8');
      edit.send({ type: 'openDraft', path: rel });
      draft2 = await edit.waitFor(
        (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/') && m.file.text.includes('手写'),
        '第二次 draft editorOpen'
      );

      edit.send({ type: 'openDraft', path: 'chapters/不存在.md' });
      missing = await edit.waitFor((m) => m.type === 'toast' && m.level === 'error', '缺章 toast');
      phantomDraft = fs.existsSync(path.join(work, 'drafts/不存在.md'));
    });

    test('正文带 draftPath', () => {
      assert.equal(f1.file.draftPath, 'drafts/001-测试.md');
    });

    test('草稿开在第二块编辑区', () => {
      assert.equal(draft.pane, 'draft');
    });

    test('草稿路径镜像章节', () => {
      assert.equal(draft.file.path, 'drafts/001-测试.md');
    });

    test('草稿已落盘', () => {
      assert.ok(draftOnDisk);
    });

    test('markdown 草稿带模板头', () => {
      assert.ok(draft.file.text.startsWith('# 测试 · 草稿'), draft.file.text);
    });

    test('草稿自己不再有 draftPath', () => {
      assert.equal(draft.file.draftPath, undefined);
    });

    test('第二次打开不覆盖草稿', () => {
      assert.ok(draft2.file.text.includes('手写的内容'), draft2.file.text);
    });

    test('对不存在的章节报错而非建文件', () => {
      assert.ok(missing.message.includes('找不到这一章'), missing.message);
    });

    test('没有凭空造出草稿', () => {
      assert.ok(!phantomDraft);
    });
  });
});
