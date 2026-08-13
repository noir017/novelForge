/**
 * 工程数据库与失败记录。迁自 scripts/smoke-errorlog.js（全部 46 条）。
 *
 * 这套机制的存在理由是「日志与 toast 都要求用户恰好在看」，所以它自己必须满足三条：
 * 写记录绝不带崩正事、成功必须清标记、纯读取不建库。外加驱动适配层：语句用完即
 * finalize，否则 Windows 上库文件删不掉。
 *
 * 收尾必须 `cleanup(WORK, db)`——先 resetDatabases() 关连接再 rmSync，
 * 否则 SQLite 句柄开着会漏临时目录。
 *
 * 时序敏感：断言里凡是读「此刻磁盘上有没有库文件」的，都在操作后**当场**取布尔值存起来，
 * 断言只读变量。整段跑完再回头 existsSync 会全看到最终状态，早先那几条就废了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('errorLog · db', () => {
  let db;
  let errorLog;
  let logger;
  let projectMod;
  let projectView;
  let WORK;

  /** 与原脚本的 newProject 一致：WORK 下开子工程，不删示例文件（本文件无计数断言）。 */
  async function newProject(name) {
    const root = path.join(WORK, name);
    fs.mkdirSync(root, { recursive: true });
    const project = projectMod.NovelProject.open(root);
    await project.initialize({ title: name, author: '测试' });
    return project;
  }

  before(() => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      logger: './src/core/runtime/logger.ts',
      project: './src/core/model/project.ts',
      db: './src/core/runtime/db.ts',
      errorLog: './src/core/runtime/errorLog.ts',
      projectView: './src/core/views/projectView.ts',
    });
    ({ logger, project: projectMod, db, errorLog, projectView } = bundle);
    // 原脚本的 host 字面量里没有 reviewReplace，显式抹掉，与原 host 形状一致。
    bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);
    ({ dir: WORK } = makeTempDir('errorlog'));
  });

  after(() => cleanup(WORK, db));

  describe('驱动适配层', () => {
    let project;
    let dbFile;
    let handle;
    let rows;
    let nullRow;
    let cached;

    before(async () => {
      project = await newProject('driver');
      dbFile = path.join(project.root, '.novelforge', 'novelforge.db');
      handle = await db.openDatabase(project);

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
      rows = handle.all('SELECT target_key, message FROM errors');

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
      nullRow = handle.all("SELECT detail FROM errors WHERE target_key = 'b.md'")[0];

      // 同一个工程只开一个连接，不是每次查询都开一次。
      cached = await db.openDatabase(project);
    });

    test('开得出库', () => {
      assert.ok(handle);
    });

    test('库文件落在 .novelforge/ 下', () => {
      assert.ok(fs.existsSync(dbFile), dbFile);
    });

    test('写进去再读得回来', () => {
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].message, '往返测试', JSON.stringify(rows));
    });

    test('detail 可以为 NULL', () => {
      assert.ok(nullRow, JSON.stringify(nullRow));
      assert.equal(nullRow.detail, null, JSON.stringify(nullRow));
    });

    test('连接按工程根缓存', () => {
      assert.equal(cached, handle);
    });

    // ★ Windows 上不 finalize 语句就删不掉库文件。这条挂了的话，
    //   所有用临时工程的测试都会在收尾时 EBUSY。
    test('关库之后删得掉工程目录（语句已 finalize）', () => {
      db.closeDatabase(project);
      let removed = true;
      try {
        fs.rmSync(project.root, { recursive: true, force: true });
      } catch {
        removed = false;
      }
      assert.ok(removed);
    });
  });

  describe('纯读取不建库', () => {
    let project;
    let empty;
    let existsAfterQuery;
    let existsAfterClear;
    let history;
    let existsAfterHistory;
    let existsAfterRecord;

    before(async () => {
      project = await newProject('readonly');
      const dbFile = path.join(project.root, '.novelforge', 'novelforge.db');

      // 一个从没出过错的工程，光是刷新工程页不该生出 db 文件。
      empty = await errorLog.listActiveFailures(project);
      existsAfterQuery = fs.existsSync(dbFile);

      await errorLog.clearFailures(project, 'character', 'nobody.md');
      existsAfterClear = fs.existsSync(dbFile);

      history = await db.readLogHistory(project, 10);
      existsAfterHistory = fs.existsSync(dbFile);

      // 写入方才有理由建库。
      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: 'x.md',
        severity: 'error',
        op: 'updateCard',
        message: '第一条记录',
      });
      existsAfterRecord = fs.existsSync(dbFile);
    });

    after(() => db.closeDatabase(project));

    test('没有库时查询返回空', () => {
      assert.equal(Object.keys(empty).length, 0, JSON.stringify(empty));
    });

    test('查询不会建出库文件', () => {
      assert.ok(!existsAfterQuery);
    });

    test('清记录也不会建出库文件', () => {
      assert.ok(!existsAfterClear);
    });

    test('读日志历史不会建出库文件', () => {
      assert.equal(history.length, 0);
    });

    test('读历史后仍无库文件', () => {
      assert.ok(!existsAfterHistory);
    });

    test('记一条失败会建出库文件', () => {
      assert.ok(existsAfterRecord);
    });
  });

  describe('失败记录的生命周期', () => {
    const CARD = '.novelforge/characters/林昭.md';
    let project;
    let first;
    let afterRetries;
    let afterSecondOp;
    let afterClearOp;
    let afterClearAll;
    let afterSix;

    before(async () => {
      project = await newProject('lifecycle');

      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: CARD,
        severity: 'error',
        op: 'updateCard',
        message: '3 批全部解析失败，角色卡未改动',
        detail: '范围 第 1-5 章',
      });
      first = await errorLog.listActiveFailures(project);

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
      afterRetries = await errorLog.listActiveFailures(project);

      // 不同动作各留各的：同一章可能既摘要失败、又角色卡失败。
      await errorLog.recordFailure(project, {
        scope: '摘要',
        targetKind: 'chapter',
        targetKey: CARD,
        severity: 'warn',
        op: 'summarize',
        message: '摘要也失败了',
      });
      afterSecondOp = await errorLog.listActiveFailures(project);

      // 清某个动作不该顺手把别的动作的记录抹掉。
      await errorLog.clearFailures(project, 'character', CARD, 'updateCard');
      afterClearOp = await errorLog.listActiveFailures(project);

      // 不给 op 就清该目标全部。
      await errorLog.clearFailures(project, 'chapter', CARD);
      afterClearAll = await errorLog.listActiveFailures(project);

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
      afterSix = await errorLog.listActiveFailures(project);
    });

    after(() => db.closeDatabase(project));

    test('按 relPath 索引', () => {
      assert.ok(first[CARD], JSON.stringify(first));
    });

    test('带回 severity', () => {
      assert.equal(first[CARD][0].severity, 'error');
    });

    test('带回 message', () => {
      assert.ok(first[CARD][0].message.includes('未改动'));
    });

    test('带回 detail', () => {
      assert.equal(first[CARD][0].detail, '范围 第 1-5 章');
    });

    test('带回时间戳', () => {
      assert.equal(typeof first[CARD][0].at, 'string');
      assert.ok(first[CARD][0].at.length > 0);
    });

    test('同一动作只留最新一条', () => {
      assert.equal(afterRetries[CARD].length, 1, String(afterRetries[CARD].length));
    });

    test('留下的是最新那条', () => {
      assert.ok(afterRetries[CARD][0].message.includes('重试第 3 次'), afterRetries[CARD][0].message);
    });

    test('不同动作各留一条', () => {
      assert.equal(afterSecondOp[CARD].length, 2, String(afterSecondOp[CARD].length));
    });

    test('清掉了指定动作', () => {
      assert.equal(afterClearOp[CARD].length, 1, JSON.stringify(afterClearOp[CARD]));
    });

    test('别的动作的记录还在', () => {
      assert.equal(afterClearOp[CARD][0].message, '摘要也失败了', afterClearOp[CARD][0].message);
    });

    test('不给 op 则全清', () => {
      assert.ok(!afterClearAll[CARD], JSON.stringify(afterClearAll));
    });

    test('一个目标最多 3 条', () => {
      assert.equal(afterSix['lore.md'].length, 3, String(afterSix['lore.md'].length));
    });

    test('留下的是最近的 3 条', () => {
      assert.equal(afterSix['lore.md'][0].message, '第 5 条', afterSix['lore.md'][0].message);
    });
  });

  describe('工程页快照带上失败记录', () => {
    let project;
    let before1;
    let after1;

    before(async () => {
      project = await newProject('tree');
      fs.writeFileSync(
        path.join(project.root, '.novelforge', 'characters', '林昭.md'),
        '---\nname: 林昭\n---\n\n# 林昭\n',
        'utf8'
      );
      project.invalidate();

      before1 = await projectView.buildProjectTree(project);

      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: '.novelforge/characters/林昭.md',
        severity: 'error',
        op: 'updateCard',
        message: '解析失败，角色卡未改动',
      });
      after1 = await projectView.buildProjectTree(project);
    });

    after(() => db.closeDatabase(project));

    test('没有失败时 failures 是空对象', () => {
      assert.equal(Object.keys(before1.failures).length, 0, JSON.stringify(before1.failures));
    });

    test('失败记录进了工程页快照', () => {
      assert.ok(after1.failures['.novelforge/characters/林昭.md'], JSON.stringify(after1.failures));
    });
  });

  describe('日志持久化', () => {
    let project;
    let history;
    let batched;
    let tail;
    let earlier;
    let countBeforeDispose;
    let countAfterDispose;

    before(async () => {
      project = await newProject('logs');
      const log = logger.scoped('测试');
      // 挂 sink **之前**先打一条：core 的模块在 import 期就在打日志了
      // （配置读取、迁移检测），那段是排查启动问题要看的第一段，不能丢。
      log.info('挂载之前打的一条');

      const sub = await db.installLogPersistence(project);

      log.info('第一条', '带 detail');
      log.error('第二条');
      // 攒批写入：立刻查是查不到的，等一拍或手动 flush。
      db.flushPendingLogs();
      history = await db.readLogHistory(project, 50);

      // 攒批：多条只写一次事务，但一条都不能少。
      for (let i = 0; i < 20; i++) {
        log.debug(`批量 ${i}`);
      }
      await sleep(300);
      batched = await db.readLogHistory(project, 100);

      // limit 生效，且取的是最近的那些。
      tail = await db.readLogHistory(project, 5);
      // 翻页：只取更早的。
      earlier = await db.readLogHistory(project, 5, tail[0].at);

      // ★ 日志写库失败绝不能再打日志——那会递归刷屏。这里退订后再打日志，
      //   验证 sink 已经摘干净（不再往库里写）。
      sub.dispose();
      countBeforeDispose = (await db.readLogHistory(project, 500)).length;
      log.info('退订之后的日志');
      db.flushPendingLogs();
      countAfterDispose = (await db.readLogHistory(project, 500)).length;
    });

    after(() => db.closeDatabase(project));

    test('日志落进了库', () => {
      assert.ok(history.length >= 2, String(history.length));
    });

    test('挂载之前的日志被补写进来', () => {
      assert.ok(
        history.some((e) => e.message === '挂载之前打的一条'),
        JSON.stringify(history.map((e) => e.message))
      );
    });

    test('按时间正序返回', () => {
      assert.ok(history[0].at <= history[history.length - 1].at);
    });

    test('detail 一并落盘', () => {
      const first = history.find((e) => e.message === '第一条');
      assert.ok(first, '没找到「第一条」');
      assert.equal(first.detail, '带 detail', first.detail);
    });

    test('level 原样保留', () => {
      assert.ok(history.some((e) => e.level === 'error'));
    });

    test('补写不产生重复条目', () => {
      const dup = history.filter((e) => e.message === '挂载之前打的一条').length;
      assert.equal(dup, 1, String(dup));
    });

    // 历史条目的 seq 取负：前端按 seq 去重，而库里的 seq 是各次进程的
    // 进程内序号，昨天的第 7 条会和今天的第 7 条撞车。
    test('历史条目的 seq 不与实时序号冲突', () => {
      assert.ok(history.every((e) => e.seq < 0), JSON.stringify(history.map((e) => e.seq)));
    });

    test('攒批写入不丢条', () => {
      assert.equal(batched.filter((e) => e.message.startsWith('批量')).length, 20);
    });

    test('limit 生效', () => {
      assert.equal(tail.length, 5, String(tail.length));
    });

    test('取的是最近的', () => {
      assert.equal(tail[tail.length - 1].message, '批量 19', tail[tail.length - 1].message);
    });

    test('翻页只取更早的', () => {
      assert.ok(
        earlier.every((e) => e.at < tail[0].at),
        JSON.stringify(earlier.map((e) => e.at))
      );
    });

    test('退订后不再写库', () => {
      assert.equal(countAfterDispose, countBeforeDispose, `${countBeforeDispose} → ${countAfterDispose}`);
    });
  });

  describe('库不可用时静默降级', () => {
    let threw = false;
    let thrown;
    let active;
    let history;
    let tree;
    let warned;

    before(async () => {
      const project = await newProject('broken');
      // 用一个**目录**占住库文件的位置：SQLite 打不开它，于是走降级路径。
      const dbFile = path.join(project.root, '.novelforge', 'novelforge.db');
      fs.mkdirSync(dbFile, { recursive: true });

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
        active = await errorLog.listActiveFailures(project);
        history = await db.readLogHistory(project, 10);
        // 工程页仍然渲染得出来——这是最要紧的一条：库坏了不能让工程页打不开。
        tree = await projectView.buildProjectTree(project);
      } catch (err) {
        threw = true;
        thrown = err;
      }

      // 开库失败只报一次，不该每次调用都重试并刷日志。
      warned = logger
        .recentLogs()
        .filter((e) => e.scope === '数据库' && e.message.includes('打不开工程数据库'));
    });

    // ↓ 下面四条沿用原脚本的语义：它们原本埋在 try 里，任一 API 抛异常就整段不执行。
    //   这里保留「不执行」而不是改成失败——改断言不是本次迁移该做的决定。
    //   区别只在可见性：抛了的话它们显示为 skipped，不再伪装成 pass。
    //   也就是说，这四条只在「一个 API 都没抛」的前提下才有结论；前提破了它们什么都不证明，
    //   真正会变红的是下面那条「库不可用时一个 API 都不抛」。
    test('库不可用时查询返回空', (t) => {
      if (threw) return t.skip(`前置 API 抛了：${thrown && thrown.message}`);
      assert.equal(Object.keys(active).length, 0, JSON.stringify(active));
    });

    test('库不可用时读历史返回空', (t) => {
      if (threw) return t.skip(`前置 API 抛了：${thrown && thrown.message}`);
      assert.equal(history.length, 0);
    });

    test('库不可用时工程页照常构建', (t) => {
      if (threw) return t.skip(`前置 API 抛了：${thrown && thrown.message}`);
      assert.equal(tree.initialized, true);
    });

    test('库不可用时 failures 为空对象', (t) => {
      if (threw) return t.skip(`前置 API 抛了：${thrown && thrown.message}`);
      assert.equal(Object.keys(tree.failures).length, 0);
    });

    test('库不可用时一个 API 都不抛', () => {
      assert.ok(!threw, thrown && thrown.message);
    });

    test('开库失败只 warn 一次', () => {
      assert.equal(warned.length, 1, String(warned.length));
    });

    test('开库失败只是 warn 不是 error', () => {
      assert.ok(warned.every((e) => e.level === 'warn'));
    });
  });
});
