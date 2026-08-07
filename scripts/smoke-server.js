// 进程内起独立服务 → HTTP 拿页面/资源 → WS 握手拿 init 消息 → 内置编辑器的读写往返。
// 用法：bun scripts/smoke-server.js
// 不另起子进程：避免 Windows 上子进程杀不干净留下占用端口的孤儿。
import { startServer } from '../src/standalone/server';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PORT = 3999;
// 写入类用例不能碰 sample-novel（smoke.js 对它有 hash 断言），另开临时工程。
const EDIT_PORT = 3998;
const root = path.join(import.meta.dir, '..', 'sample-novel');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-server-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 开一条 WS，把收到的消息按类型排队，供 waitFor 消费。 */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      waiters.splice(idx, 1)[0].resolve(msg);
    } else {
      inbox.push(msg);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    setTimeout(() => reject(new Error('WS 连不上')), 5000);
  });
  const waitFor = (match, label) =>
    new Promise((resolve, reject) => {
      const idx = inbox.findIndex(match);
      if (idx >= 0) {
        resolve(inbox.splice(idx, 1)[0]);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`等不到 ${label}`)), 5000);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  return { ws, ready, waitFor, send: (m) => ws.send(JSON.stringify(m)) };
}

startServer({ root, port: PORT });

const base = `http://127.0.0.1:${PORT}`;
try {
  console.log('\n== 静态资源 ==');
  const html = await (await fetch(`${base}/`)).text();
  check('首页含 view.js', html.includes('view.js'));
  check('首页含 editor.js', html.includes('editor.js'));
  check('首页含 standalone.css', html.includes('standalone.css'));
  check('首页含编辑器容器', html.includes('id="wbEditor"'));
  check('首页标题带工程名', html.includes('sample-novel'));
  for (const asset of ['view.js', 'bridge.js', 'editor.js', 'view.css', 'standalone.css']) {
    check(`${asset} 可取`, (await fetch(`${base}/media/${asset}`)).status === 200);
  }

  console.log('\n== WebSocket 与 Origin 校验 ==');
  const conn = connect(PORT);
  await conn.ready;
  const first = await conn.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');
  check('首条消息是 init/state', first.type === 'init' || first.type === 'state', first.type);

  // 浏览器发得出跨源 WS 请求，所以 Origin 必须在服务端挡。
  const bad = await fetch(`${base}/ws`, {
    headers: { origin: 'http://evil.example.com', upgrade: 'websocket', connection: 'Upgrade' },
  });
  check('跨源 Origin 被拒 403', bad.status === 403, String(bad.status));
  const good = await fetch(`${base}/ws`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  check('同源 Origin 不被 403', good.status !== 403, String(good.status));

  console.log('\n== 内置编辑器：只读用例 ==');
  conn.send({ type: 'openEditor', path: 'chapters/001-楔子.md' });
  const opened = await conn.waitFor((m) => m.type === 'editorOpen', 'editorOpen');
  check('打开章节返回内容', opened.file.text.length > 0);
  check('带 hash 基线', typeof opened.file.hash === 'string' && opened.file.hash.length > 0);
  check('path 用正斜杠', !opened.file.path.includes('\\'), opened.file.path);

  conn.send({ type: 'openEditor', path: '../../../package.json' });
  const escaped = await conn.waitFor((m) => m.type === 'editorError', '越界 editorError');
  check('越界路径被拒', escaped.message.includes('超出工程目录'), escaped.message);

  conn.send({ type: 'openEditor', path: '.novelforge/project.json' });
  const json = await conn.waitFor((m) => m.type === 'editorOpen', 'json editorOpen');
  check('工程内 json 可打开', json.file.name === 'project.json');

  conn.ws.close();

  console.log('\n== 内置编辑器：读写往返 ==');
  fs.mkdirSync(path.join(work, 'chapters'), { recursive: true });
  const rel = 'chapters/001-测试.md';
  fs.writeFileSync(path.join(work, rel), '# 测试\n\n初始内容。\n', 'utf8');
  startServer({ root: work, port: EDIT_PORT });

  const edit = connect(EDIT_PORT);
  await edit.ready;
  await edit.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');

  edit.send({ type: 'openEditor', path: rel });
  const f1 = await edit.waitFor((m) => m.type === 'editorOpen', 'editorOpen');

  edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n改过的内容。\n', baseHash: f1.file.hash });
  const saved = await edit.waitFor((m) => m.type === 'editorSaved', 'editorSaved');
  check('保存落盘', fs.readFileSync(path.join(work, rel), 'utf8').includes('改过的内容'));
  check('回传新 hash', saved.file.hash !== f1.file.hash);

  // 用过期的 baseHash 再存一次，模拟「文件已被别处改过」。
  edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n第三版。\n', baseHash: f1.file.hash });
  const conflict = await edit.waitFor((m) => m.type === 'editorConflict', 'editorConflict');
  check('过期基线触发冲突', conflict.path === rel);
  check('冲突时不覆盖磁盘', fs.readFileSync(path.join(work, rel), 'utf8').includes('改过的内容'));
  check('冲突带回磁盘版本', conflict.diskText.includes('改过的内容'));

  // 用户明确选择强制覆盖：不带 baseHash。
  edit.send({ type: 'saveFile', path: rel, text: '# 测试\n\n第三版。\n' });
  await edit.waitFor((m) => m.type === 'editorSaved', '强制保存 editorSaved');
  check('强制保存生效', fs.readFileSync(path.join(work, rel), 'utf8').includes('第三版'));

  edit.send({ type: 'saveFile', path: '../escape.md', text: 'x' });
  const badSave = await edit.waitFor((m) => m.type === 'editorError', '越界保存 editorError');
  check('越界保存被拒', badSave.message.includes('超出工程目录'), badSave.message);
  check('越界文件未创建', !fs.existsSync(path.join(path.dirname(work), 'escape.md')));

  edit.send({ type: 'openEditor', path: 'chapters/nope.png' });
  const badExt = await edit.waitFor((m) => m.type === 'editorError', '扩展名 editorError');
  check('非文本扩展名被拒', badExt.message.includes('不是可编辑的文本文件'), badExt.message);

  // 章节可以没有扩展名——白名单挡不住它，章节判定规则得放它过去。
  fs.writeFileSync(path.join(work, 'chapters/002-无扩展名'), '没有扩展名的一章。\n', 'utf8');
  edit.send({ type: 'openEditor', path: 'chapters/002-无扩展名' });
  const bare = await edit.waitFor((m) => m.type === 'editorOpen', '无扩展名 editorOpen');
  check('无扩展名的章节可打开', bare.file.text.includes('没有扩展名的一章'), bare.file.text);
  check('无扩展名章节也带 draftPath', bare.file.draftPath === 'drafts/002-无扩展名', bare.file.draftPath);

  console.log('\n== 章节草稿 ==');
  check('正文带 draftPath', f1.file.draftPath === 'drafts/001-测试.md', String(f1.file.draftPath));

  edit.send({ type: 'openDraft', path: rel });
  const draft = await edit.waitFor(
    (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/'),
    'draft editorOpen'
  );
  check('草稿开在第二块编辑区', draft.pane === 'draft', String(draft.pane));
  check('草稿路径镜像章节', draft.file.path === 'drafts/001-测试.md', draft.file.path);
  check('草稿已落盘', fs.existsSync(path.join(work, 'drafts/001-测试.md')));
  check('markdown 草稿带模板头', draft.file.text.startsWith('# 测试 · 草稿'), draft.file.text);
  check('草稿自己不再有 draftPath', draft.file.draftPath === undefined, String(draft.file.draftPath));

  // 作者在草稿里写了东西，再点一次不能被抹掉。
  fs.writeFileSync(path.join(work, 'drafts/001-测试.md'), '# 测试 · 草稿\n\n手写的内容。\n', 'utf8');
  edit.send({ type: 'openDraft', path: rel });
  const draft2 = await edit.waitFor(
    (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/') && m.file.text.includes('手写'),
    '第二次 draft editorOpen'
  );
  check('第二次打开不覆盖草稿', draft2.file.text.includes('手写的内容'), draft2.file.text);

  edit.send({ type: 'openDraft', path: 'chapters/不存在.md' });
  const missing = await edit.waitFor((m) => m.type === 'toast' && m.level === 'error', '缺章 toast');
  check('对不存在的章节报错而非建文件', missing.message.includes('找不到这一章'), missing.message);
  check('没有凭空造出草稿', !fs.existsSync(path.join(work, 'drafts/不存在.md')));

  edit.ws.close();

  console.log(failures === 0 ? '\n✓ smoke-server 通过' : `\n✗ smoke-server ${failures} 项失败`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  // 服务是进程内的 Bun.serve，直接退出即可，不会留孤儿。
  process.exit(failures === 0 ? 0 : 1);
}
