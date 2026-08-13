/**
 * 工程内的 SQLite 库（`.novelforge/novelforge.db`）。
 *
 * **Markdown 仍然是内容的唯一真相**。库里只放两类东西：
 * - `errors` —— 失败记录，驱动工程页上的红色感叹号（见 [errorLog.ts](errorLog.ts)）；
 * - `logs` —— 日志的持久副本，让日志页能跨会话回看。
 *
 * 两者都是「可丢弃的痕迹」：把 db 文件删掉，全部功能照常，只是丢历史。
 * 别往这里放角色卡/摘要/设定的正文——那些作者要手改、要 diff、要进 Git。
 *
 * ## 两个壳要两个驱动
 *
 * 这不是可选项，是实测结论：
 *
 * | 运行时 | `node:sqlite` | `bun:sqlite` |
 * |---|---|---|
 * | Node 22（跑 smoke） | ✓ | ✗ |
 * | VS Code / Electron（Node 24） | ✓ | ✗ |
 * | Bun（独立版） | ✗ 没有这个内置模块 | ✓ |
 *
 * 而 esbuild 解析不了 `bun:sqlite`（会直接构建失败），`bun build --compile`
 * 又能把 `node:sqlite` 打进去、跑起来才炸。所以模块名**拼接**出来再
 * `await import`：拼接让 esbuild 的静态分析看不见它，于是两条构建路径
 * 都不必配 external，运行时按谁能 import 成功来选。
 *
 * ## 语句必须显式 finalize（Windows 上不 finalize 就删不掉库文件）
 *
 * 两个驱动的另一处差异，比构造函数名要紧得多：`bun:sqlite` 的语句对象
 * 持有底层句柄，**不 finalize 就 `close()` 的话，Windows 上库文件仍被占着**
 * （`fs.rmSync` 报 EBUSY，临时工程清理不掉）；`node:sqlite` 的语句压根没有
 * `finalize` 方法，靠 GC。
 *
 * 所以对外只暴露 {@link SqlDatabase} 的 run/all/insertMany——它们内部
 * 「准备 → 执行 → 立刻 finalize」，调用方碰不到语句对象，也就不可能忘。
 *
 * ## 绝不因为库坏了而带崩正事
 *
 * 「容错优先」在这里的落法：{@link openDatabase} 把所有异常吞掉并只 warn
 * 一次，返回 `undefined`。库锁了、盘满了、驱动缺了，角色卡该更新照样更新，
 * 只是这次的失败记录留不下来。SQLite 是增强，不是新的失败源——一旦这条
 * 破了，「更新角色卡」就会因为一个日志表而失败，那比没有感叹号糟得多。
 */

import * as path from 'node:path';
import { addLogSink, LogEntry, LogLevel, recentLogs, scoped, Unsubscribe } from './logger';
import { exists } from '../model/fs';
import { NovelProject } from '../model/project';

const log = scoped('数据库');

/** 库文件名。放在 `.novelforge/` 下，与 summaries/ characters/ 平级。 */
const DB_FILE = 'novelforge.db';

/** 日志保留天数。超期的行在开库时删掉，库不会无限长。 */
const LOG_RETENTION_DAYS = 30;

/** 日志攒批写入的间隔。长任务每秒好几条，逐条一次事务会拖慢正事。 */
const LOG_FLUSH_MS = 200;

/** 能进 SQLite 的值。刻意不收 undefined——那多半是拼参数时漏了一个。 */
export type SqlValue = string | number | null;

// ---------------------------------------------------------------- 驱动适配

/** 两个驱动的语句对象的公共子集。`finalize` 只有 bun 有。 */
interface RawStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  finalize?(): void;
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

interface BunSqliteModule {
  Database: new (filename: string) => RawDatabase;
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => RawDatabase;
}

/**
 * 对外的库接口。**没有 prepare**——语句的生命周期全在这一层里管掉，
 * 见文件头「语句必须显式 finalize」。
 */
export interface SqlDatabase {
  exec(sql: string): void;
  /** 跑一条写语句。 */
  run(sql: string, ...params: SqlValue[]): void;
  /** 查一批行。 */
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** 同一条语句跑很多行，一次事务。日志攒批写入用它。 */
  insertMany(sql: string, rows: SqlValue[][]): void;
  close(): void;
}

/**
 * 按运行时挑一个驱动开库。
 *
 * 顺序是 bun 优先：独立版跑在 Bun 里，那儿 `node:sqlite` 根本不存在；
 * 插件与 smoke 跑在 Node/Electron 里，`bun:sqlite` import 会抛，落到第二条。
 *
 * **模块名必须是拼接出来的**（`'bun' + ':sqlite'`）。写成字面量的话
 * esbuild 会在打包 `dist/extension.js` 时试图解析 `bun:sqlite` 并直接
 * 构建失败——那个模块在 Node 侧不存在，也没法 external 掉（external 之后
 * 插件运行时会 require 一个不存在的模块）。
 */
async function openWithAnyDriver(filename: string): Promise<RawDatabase> {
  const bunSpec = 'bun' + ':sqlite';
  try {
    const mod = (await import(bunSpec)) as unknown as BunSqliteModule;
    return new mod.Database(filename);
  } catch {
    const nodeSpec = 'node' + ':sqlite';
    const mod = (await import(nodeSpec)) as unknown as NodeSqliteModule;
    return new mod.DatabaseSync(filename);
  }
}

/** 把裸驱动包成 {@link SqlDatabase}：语句一律用完即 finalize。 */
function wrap(raw: RawDatabase): SqlDatabase {
  /** 准备 → 用 → 收。`finalize` 只有 bun 有，node 侧是个空操作。 */
  const withStatement = <T>(sql: string, use: (stmt: RawStatement) => T): T => {
    const stmt = raw.prepare(sql);
    try {
      return use(stmt);
    } finally {
      try {
        stmt.finalize?.();
      } catch {
        /* 收不掉也不能让调用方看见——查询本身已经成了 */
      }
    }
  };

  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => withStatement(sql, (s) => void s.run(...params)),
    all: <T>(sql: string, ...params: SqlValue[]) =>
      withStatement(sql, (s) => s.all(...params) as T[]),
    insertMany: (sql, rows) => {
      if (rows.length === 0) {
        return;
      }
      withStatement(sql, (stmt) => {
        raw.exec('BEGIN');
        try {
          for (const row of rows) {
            stmt.run(...row);
          }
          raw.exec('COMMIT');
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* 回滚失败时原始异常更有价值，别用它盖掉 */
          }
          throw err;
        }
      });
    },
    close: () => raw.close(),
  };
}

// ---------------------------------------------------------------- 打开

/** 已打开的连接，按工程根缓存。一个工程一个连接，别每次查询都开一次。 */
const connections = new Map<string, SqlDatabase>();
/**
 * 开库失败过的工程根。
 *
 * 记住它才不会每查一次错误记录就重试一次开库——那会在盘满/无写权限时
 * 把日志刷满，而结论每次都一样。
 */
const failedRoots = new Set<string>();

/**
 * 拿这个工程的库连接；拿不到返回 `undefined`（调用方一律当「没有库」处理）。
 *
 * 首次调用时建表、设 PRAGMA、清理过期日志。
 *
 * `opts.create` 为 false 时**库文件不存在就直接返回 undefined，不建库**。
 * 纯读取的调用方（`listActiveFailures`，工程页每次刷新都走）必须用这一档：
 * 否则光是打开工程页就会在作者的 `.novelforge/` 里凭空生出一个 db 文件，
 * 而那个工程可能从来没出过错。写入方（记失败、写日志）才有理由建库。
 */
export async function openDatabase(
  project: NovelProject,
  opts: { create?: boolean } = {}
): Promise<SqlDatabase | undefined> {
  const key = project.root;
  const cached = connections.get(key);
  if (cached) {
    return cached;
  }
  if (failedRoots.has(key)) {
    return undefined;
  }

  const file = path.join(project.novelDir, DB_FILE);
  if (opts.create === false && !(await exists(file))) {
    // 刻意不记进 failedRoots：这不是失败，只是「还没有库」。
    // 之后某次写入把库建出来，读取方下一次就该看得见。
    return undefined;
  }

  try {
    const db = wrap(await openWithAnyDriver(file));
    // WAL：写日志时不阻塞工程页读错误记录。
    // busy_timeout：插件与独立版同开一个工程时，撞锁先等一会儿而不是直接报错。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(SCHEMA);
    pruneOldLogs(db);
    connections.set(key, db);
    log.debug('已打开工程数据库', `${project.relPath(project.novelDir)}/${DB_FILE}`);
    return db;
  } catch (err) {
    failedRoots.add(key);
    // 只 warn 不 error：这不影响任何功能，只是这个工程没有失败记录与日志历史。
    log.warn(
      '打不开工程数据库，本次会话不记录失败历史',
      `${(err as Error)?.message ?? String(err)}｜功能不受影响，只是工程页上不会显示错误标记`
    );
    return undefined;
  }
}

/**
 * 关掉某个工程的连接（壳销毁时调）。
 *
 * 顺带 flush 掉攒着还没写的日志——不然最后那一两百毫秒的日志会丢，
 * 而崩溃前的最后几条恰恰是最想看的。
 */
export function closeDatabase(project: NovelProject): void {
  flushPendingLogs();
  const db = connections.get(project.root);
  if (!db) {
    return;
  }
  connections.delete(project.root);
  if (db === logDb) {
    logDb = undefined;
  }
  try {
    db.close();
  } catch {
    /* 关不掉也没什么可做的，进程退出时系统会收 */
  }
}

/** 仅供测试：关掉全部连接、忘掉失败记忆，让下一次 openDatabase 重新来。 */
export function resetDatabases(): void {
  flushPendingLogs();
  for (const db of connections.values()) {
    try {
      db.close();
    } catch {
      /* 同上 */
    }
  }
  connections.clear();
  failedRoots.clear();
  logDb = undefined;
  logWriteBroken = false;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  target_kind TEXT    NOT NULL,
  target_key  TEXT    NOT NULL,
  severity    TEXT    NOT NULL,
  op          TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  detail      TEXT,
  cleared_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_target ON errors(target_kind, target_key, cleared_at);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- logger 那边的进程内序号。**不是主键**——它每次进程重启都从 1 开始，
  -- 做主键会让今天的日志覆盖昨天的。留着它是因为前端按 seq 去重：
  -- 内存缓冲与库里那份必然重叠（同一条既进了缓冲也写了库）。
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  level   TEXT NOT NULL,
  scope   TEXT NOT NULL,
  message TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
`;

function pruneOldLogs(db: SqlDatabase): void {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString();
  try {
    db.run('DELETE FROM logs WHERE at < ?', cutoff);
  } catch {
    /* 清不掉只是库大一点，不值得打扰用户 */
  }
}

// ---------------------------------------------------------------- 日志持久化

/**
 * 待写的日志。
 *
 * 攒批而不是逐条写：一次摘要同步会打几百条，每条一次事务足以让长任务
 * 明显变慢。200ms 一批，用户感知不到，写入次数降两个数量级。
 */
let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let logDb: SqlDatabase | undefined;
/**
 * 写库失败过了。
 *
 * **写日志失败绝不能再打日志**——那会递归刷屏（`logger.ts` 的重入保护只挡
 * 转发，不挡入缓冲）。所以只在第一次往 stderr 说一句，此后彻底静默。
 */
let logWriteBroken = false;

/**
 * 把日志落进库里。返回的 dispose 必须在壳销毁时调用。
 *
 * 不写在 `logger.ts` 里是有意的：那个模块是 core 里唯一的零依赖模块
 * （连 host.ts 都不引），而这里要 import `model/project`，反向 import
 * 会成环。用它现成的 `addLogSink` 从外面挂，是同一件事的干净做法。
 *
 * 开库是异步的，而 core 的模块在 import 期就已经在打日志了（配置读取、
 * 迁移检测）。所以挂上 sink 之后**先把环形缓冲里已有的补写一遍**——
 * 否则「启动时到底加载了什么」这段永远进不了库，而那正是排查启动问题
 * 要看的第一段。
 */
export async function installLogPersistence(project: NovelProject): Promise<Unsubscribe> {
  const db = await openDatabase(project);
  if (!db) {
    // 没有库就什么都不做，但仍然给一个可 dispose 的对象——
    // 让调用方不必区分「挂上了」和「没挂上」。
    return { dispose: () => undefined };
  }
  logDb = db;

  const sink = addLogSink((entry) => {
    if (logWriteBroken) {
      return;
    }
    pendingLogs.push(entry);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingLogs, LOG_FLUSH_MS);
    }
  });

  // 补上挂载之前的那些。sink 已经装好了，所以这里塞进同一个缓冲，
  // 由同一次 flush 写掉；重复的那几条由 seq 去重（前端与这里都按 seq 认）。
  const backlog = recentLogs();
  if (backlog.length > 0) {
    pendingLogs.unshift(...backlog);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingLogs, LOG_FLUSH_MS);
    }
  }

  return {
    dispose: () => {
      sink.dispose();
      flushPendingLogs();
      logDb = undefined;
    },
  };
}

/** 把攒着的日志一次事务写完。库坏了就丢掉这一批并从此静默。 */
export function flushPendingLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const batch = pendingLogs;
  pendingLogs = [];
  if (batch.length === 0 || !logDb || logWriteBroken) {
    return;
  }

  try {
    // 按 seq 去重：补写启动前的缓冲时，同一条可能既在 backlog 里
    // 又被 sink 收到过（`installLogPersistence` 的补写与实时推送会重叠）。
    const seen = new Set<number>();
    const rows: SqlValue[][] = [];
    for (const e of batch) {
      if (seen.has(e.seq)) {
        continue;
      }
      seen.add(e.seq);
      rows.push([e.seq, e.at, e.level, e.scope, e.message, e.detail ?? null]);
    }
    logDb.insertMany(
      'INSERT INTO logs (seq, at, level, scope, message, detail) VALUES (?, ?, ?, ?, ?, ?)',
      rows
    );
  } catch (err) {
    logWriteBroken = true;
    // 刻意用 console 而不是 log.warn：见 logWriteBroken 的注释。
    console.error('[novel-forge] 日志写入数据库失败，已停止持久化：', (err as Error)?.message ?? err);
  }
}

/**
 * 库里存着的历史日志，按时间正序返回最近的 `limit` 条。
 *
 * 日志页默认仍然显示内存缓冲（那是实时的），这条只在用户点「加载更早」
 * 时才走——默认路径一次查询都不做。`before` 给了就只取更早的，供翻页。
 */
export async function readLogHistory(
  project: NovelProject,
  limit: number,
  before?: string
): Promise<LogEntry[]> {
  // 纯读取，不建库：没有库就是没有历史。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return [];
  }
  try {
    // 先取最近的 N 条（倒序 + LIMIT 才用得上索引），再翻回正序给前端。
    // 排序用 id（库内自增、跨会话单调）而不是 seq——seq 每次进程重启都从 1
    // 开始，按它排会把昨天和今天的日志交错在一起。
    const rows = before
      ? db.all<LogRow>(
          'SELECT * FROM logs WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?',
          before,
          limit
        )
      : db.all<LogRow>('SELECT * FROM logs ORDER BY at DESC, id DESC LIMIT ?', limit);
    return rows.map(toLogEntry).reverse();
  } catch (err) {
    log.warn('读取日志历史失败', (err as Error)?.message ?? String(err));
    return [];
  }
}

interface LogRow {
  id: number;
  seq: number;
  at: string;
  level: string;
  scope: string;
  message: string;
  detail: string | null;
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function toLogEntry(row: LogRow): LogEntry {
  return {
    /**
     * **负数**，取库内自增 id 的相反数。
     *
     * 前端按 seq 去重，而库里存的 `seq` 是各次进程的进程内序号——昨天的
     * 第 7 条与本次会话的第 7 条 seq 一样，直接用它会让「加载更早」把昨天
     * 那条当成重复的丢掉。取负的库内 id 则永不与实时序号（从 1 递增）撞车，
     * 而真正防重复显示的是查询里的 `at < before`（只取比已显示的更早的）。
     */
    seq: -row.id,
    at: row.at,
    // 库里的 level 是自由文本，读回来时收一次口——手改过库的人不该让日志页崩。
    level: LEVELS.includes(row.level as LogLevel) ? (row.level as LogLevel) : 'info',
    scope: row.scope,
    message: row.message,
    detail: row.detail ?? undefined,
  };
}
