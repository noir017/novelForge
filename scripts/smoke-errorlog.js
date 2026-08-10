/**
 * 工程数据库与失败记录的离线验证。
 *
 * 这套机制的存在理由是「日志与 toast 都要求用户恰好在看」，所以它自己
 * 必须满足三条，任何一条破了都比没有它更糟：
 *
 *   1. **写记录绝不带崩正事**：库打不开/写不进时全部 API 静默降级。
 *      角色卡不该因为一张日志表而更新失败。
 *   2. **成功必须清标记**：修好了还挂着感叹号，用户会学会无视它。
 *   3. **纯读取不建库**：光是打开工程页不该在作者的 .novelforge/ 里
 *      凭空生出一个 db 文件。
 *
 * 另外验证驱动适配层：两个壳用两个不同的 SQLite 驱动（Node 侧 `node:sqlite`，
 * Bun 侧 `bun:sqlite`），语句必须用完即 finalize——不 finalize 的话
 * Windows 上库文件删不掉，临时工程会全留在 temp 里。
 *
 * 用法：node scripts/smoke-errorlog.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-errorlog-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 与其它 smoke 同一套：打进同一个 bundle，共享 host/logger 的模块级状态。 */
function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  logger: './src/core/logger.ts',
  project: './src/core/model/project.ts',
  db: './src/core/db.ts',
  errorLog: './src/core/errorLog.ts',
  projectView: './src/core/projectView.ts',
});

const { host: hostMod, logger, project: projectMod, db, errorLog, projectView } = bundle;

hostMod.initHost({
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({}), write: async () => {} },
  input: async () => undefined,
  confirm: async () => undefined,
  pick: async () => undefined,
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: () => {},
  selectionAttachment: async () => undefined,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newProject(name) {
  const root = path.join(WORK, name);
  fs.mkdirSync(root, { recursive: true });
  const project = projectMod.NovelProject.open(root);
  await project.initialize({ title: name, author: '测试' });
  return project;
}

async function main() {
  console.log('\n== 驱动适配层 ==');
  {
    const project = await newProject('driver');
    const dbFile = path.join(project.root, '.novelforge', 'novelforge.db');

    const handle = await db.openDatabase(project);
    check('开得出库', !!handle);
    check('库文件落在 .novelforge/ 下', fs.existsSync(dbFile), dbFile);

    // 建表是幂等的：每次开库都会跑一遍 CREATE TABLE IF NOT EXISTS。
    handle.run(
      'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      '角色卡',
      'character',
      'a.md',
      'error',
      'updateCard',
      '往返测试'
    );
    const rows = handle.all('SELECT target_key, message FROM errors');
    check('写进去再读得回来', rows.length === 1 && rows[0].message === '往返测试', JSON.stringify(rows));

    // NULL 要能存也能读回来（detail 常常是空的）。
    handle.run(
      'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      '摘要',
      'chapter',
      'b.md',
      'error',
      'summarize',
      '无详情',
      null
    );
    const nullRow = handle.all("SELECT detail FROM errors WHERE target_key = 'b.md'")[0];
    check('detail 可以为 NULL', nullRow && nullRow.detail === null, JSON.stringify(nullRow));

    // 同一个工程只开一个连接，不是每次查询都开一次。
    check('连接按工程根缓存', (await db.openDatabase(project)) === handle);

    // ★ Windows 上不 finalize 语句就删不掉库文件。这条挂了的话，
    //   所有用临时工程的 smoke 都会在收尾时 EBUSY。
    db.closeDatabase(project);
    let removed = true;
    try {
      fs.rmSync(project.root, { recursive: true, force: true });
    } catch {
      removed = false;
    }
    check('关库之后删得掉工程目录（语句已 finalize）', removed);
  }

  console.log('\n== 纯读取不建库 ==');
  {
    const project = await newProject('readonly');
    const dbFile = path.join(project.root, '.novelforge', 'novelforge.db');

    // 一个从没出过错的工程，光是刷新工程页不该生出 db 文件。
    const empty = await errorLog.listActiveFailures(project);
    check('没有库时查询返回空', Object.keys(empty).length === 0, JSON.stringify(empty));
    check('查询不会建出库文件', !fs.existsSync(dbFile));

    await errorLog.clearFailures(project, 'character', 'nobody.md');
    check('清记录也不会建出库文件', !fs.existsSync(dbFile));

    check('读日志历史不会建出库文件', (await db.readLogHistory(project, 10)).length === 0);
    check('读历史后仍无库文件', !fs.existsSync(dbFile));

    // 写入方才有理由建库。
    await errorLog.recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: 'x.md',
      severity: 'error',
      op: 'updateCard',
      message: '第一条记录',
    });
    check('记一条失败会建出库文件', fs.existsSync(dbFile));
    db.closeDatabase(project);
  }

  console.log('\n== 失败记录的生命周期 ==');
  {
    const project = await newProject('lifecycle');
    const CARD = '.novelforge/characters/林昭.md';

    await errorLog.recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: CARD,
      severity: 'error',
      op: 'updateCard',
      message: '3 批全部解析失败，角色卡未改动',
      detail: '范围 第 1-5 章',
    });

    let active = await errorLog.listActiveFailures(project);
    check('按 relPath 索引', !!active[CARD], JSON.stringify(active));
    check('带回 severity', active[CARD][0].severity === 'error');
    check('带回 message', active[CARD][0].message.includes('未改动'));
    check('带回 detail', active[CARD][0].detail === '范围 第 1-5 章');
    check('带回时间戳', typeof active[CARD][0].at === 'string' && active[CARD][0].at.length > 0);

    // 同一目标 + 同一动作只留最新一条：连着重试三次失败，用户要看的是
    // 「现在还错着」，不是三条一模一样的记录。
    for (let i = 0; i < 3; i++) {
      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: CARD,
        severity: 'error',
        op: 'updateCard',
        message: `重试第 ${i + 1} 次仍失败`,
      });
    }
    active = await errorLog.listActiveFailures(project);
    check('同一动作只留最新一条', active[CARD].length === 1, String(active[CARD].length));
    check('留下的是最新那条', active[CARD][0].message.includes('重试第 3 次'), active[CARD][0].message);

    // 不同动作各留各的：同一章可能既摘要失败、又角色卡失败。
    await errorLog.recordFailure(project, {
      scope: '摘要',
      targetKind: 'chapter',
      targetKey: CARD,
      severity: 'warn',
      op: 'summarize',
      message: '摘要也失败了',
    });
    active = await errorLog.listActiveFailures(project);
    check('不同动作各留一条', active[CARD].length === 2, String(active[CARD].length));

    // 清某个动作不该顺手把别的动作的记录抹掉。
    await errorLog.clearFailures(project, 'character', CARD, 'updateCard');
    active = await errorLog.listActiveFailures(project);
    check('清掉了指定动作', active[CARD].length === 1, JSON.stringify(active[CARD]));
    check('别的动作的记录还在', active[CARD][0].message === '摘要也失败了', active[CARD][0].message);

    // 不给 op 就清该目标全部。
    await errorLog.clearFailures(project, 'chapter', CARD);
    active = await errorLog.listActiveFailures(project);
    check('不给 op 则全清', !active[CARD], JSON.stringify(active));

    // 一个目标最多显示 3 条（浮窗里摊开更多没人看）。
    for (let i = 0; i < 6; i++) {
      await errorLog.recordFailure(project, {
        scope: '设定',
        targetKind: 'lore',
        targetKey: 'lore.md',
        severity: 'error',
        op: `op-${i}`,
        message: `第 ${i} 条`,
      });
    }
    active = await errorLog.listActiveFailures(project);
    check('一个目标最多 3 条', active['lore.md'].length === 3, String(active['lore.md'].length));
    check('留下的是最近的 3 条', active['lore.md'][0].message === '第 5 条', active['lore.md'][0].message);

    db.closeDatabase(project);
  }

  console.log('\n== 工程页快照带上失败记录 ==');
  {
    const project = await newProject('tree');
    fs.writeFileSync(
      path.join(project.root, '.novelforge', 'characters', '林昭.md'),
      '---\nname: 林昭\n---\n\n# 林昭\n',
      'utf8'
    );
    project.invalidate();

    let tree = await projectView.buildProjectTree(project);
    check('没有失败时 failures 是空对象', Object.keys(tree.failures).length === 0, JSON.stringify(tree.failures));

    await errorLog.recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: '.novelforge/characters/林昭.md',
      severity: 'error',
      op: 'updateCard',
      message: '解析失败，角色卡未改动',
    });
    tree = await projectView.buildProjectTree(project);
    check(
      '失败记录进了工程页快照',
      !!tree.failures['.novelforge/characters/林昭.md'],
      JSON.stringify(tree.failures)
    );
    db.closeDatabase(project);
  }

  console.log('\n== 日志持久化 ==');
  {
    const project = await newProject('logs');
    const log = logger.scoped('测试');
    // 挂 sink **之前**先打一条：core 的模块在 import 期就在打日志了
    // （配置读取、迁移检测），那段是排查启动问题要看的第一段，不能丢。
    log.info('挂载之前打的一条');

    const sub = await db.installLogPersistence(project);

    log.info('第一条', '带 detail');
    log.error('第二条');
    // 攒批写入：立刻查是查不到的，等一拍或手动 flush。
    db.flushPendingLogs();

    let history = await db.readLogHistory(project, 50);
    check('日志落进了库', history.length >= 2, String(history.length));
    check(
      '挂载之前的日志被补写进来',
      history.some((e) => e.message === '挂载之前打的一条'),
      JSON.stringify(history.map((e) => e.message))
    );
    check('按时间正序返回', history[0].at <= history[history.length - 1].at);
    const first = history.find((e) => e.message === '第一条');
    check('detail 一并落盘', first && first.detail === '带 detail', first && first.detail);
    check('level 原样保留', history.some((e) => e.level === 'error'));
    // 补写与实时推送会重叠，同一条不能进去两遍。
    const dup = history.filter((e) => e.message === '挂载之前打的一条').length;
    check('补写不产生重复条目', dup === 1, String(dup));
    // 历史条目的 seq 取负：前端按 seq 去重，而库里的 seq 是各次进程的
    // 进程内序号，昨天的第 7 条会和今天的第 7 条撞车。
    check('历史条目的 seq 不与实时序号冲突', history.every((e) => e.seq < 0), JSON.stringify(history.map((e) => e.seq)));

    // 攒批：多条只写一次事务，但一条都不能少。
    for (let i = 0; i < 20; i++) {
      log.debug(`批量 ${i}`);
    }
    await sleep(300);
    history = await db.readLogHistory(project, 100);
    check('攒批写入不丢条', history.filter((e) => e.message.startsWith('批量')).length === 20);

    // limit 生效，且取的是最近的那些。
    const tail = await db.readLogHistory(project, 5);
    check('limit 生效', tail.length === 5, String(tail.length));
    check('取的是最近的', tail[tail.length - 1].message === '批量 19', tail[tail.length - 1].message);

    // 翻页：只取更早的。
    const earlier = await db.readLogHistory(project, 5, tail[0].at);
    check('翻页只取更早的', earlier.every((e) => e.at < tail[0].at), JSON.stringify(earlier.map((e) => e.at)));

    // ★ 日志写库失败绝不能再打日志——那会递归刷屏。这里退订后再打日志，
    //   验证 sink 已经摘干净（不再往库里写）。
    sub.dispose();
    const before = (await db.readLogHistory(project, 500)).length;
    log.info('退订之后的日志');
    db.flushPendingLogs();
    const after = (await db.readLogHistory(project, 500)).length;
    check('退订后不再写库', after === before, `${before} → ${after}`);

    db.closeDatabase(project);
  }

  console.log('\n== 库不可用时静默降级 ==');
  {
    const project = await newProject('broken');
    // 用一个**目录**占住库文件的位置：SQLite 打不开它，于是走降级路径。
    const dbFile = path.join(project.root, '.novelforge', 'novelforge.db');
    fs.mkdirSync(dbFile, { recursive: true });

    let threw = false;
    try {
      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: 'x.md',
        severity: 'error',
        op: 'updateCard',
        message: '库坏了也不能抛',
      });
      await errorLog.clearFailures(project, 'character', 'x.md');
      const active = await errorLog.listActiveFailures(project);
      check('库不可用时查询返回空', Object.keys(active).length === 0, JSON.stringify(active));
      check('库不可用时读历史返回空', (await db.readLogHistory(project, 10)).length === 0);
      // 工程页仍然渲染得出来——这是最要紧的一条：库坏了不能让工程页打不开。
      const tree = await projectView.buildProjectTree(project);
      check('库不可用时工程页照常构建', tree.initialized === true);
      check('库不可用时 failures 为空对象', Object.keys(tree.failures).length === 0);
    } catch (err) {
      threw = true;
      console.log('    抛出：', err && err.message);
    }
    check('库不可用时一个 API 都不抛', !threw);

    // 开库失败只报一次，不该每次调用都重试并刷日志。
    const warned = logger
      .recentLogs()
      .filter((e) => e.scope === '数据库' && e.message.includes('打不开工程数据库'));
    check('开库失败只 warn 一次', warned.length === 1, String(warned.length));
    check('开库失败只是 warn 不是 error', warned.every((e) => e.level === 'warn'));
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

/** 先关全部连接再删目录：连接开着时 Windows 上删不掉库文件。 */
function cleanup() {
  try {
    db.resetDatabases();
  } catch {
    /* 关不掉也要接着删 */
  }
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
