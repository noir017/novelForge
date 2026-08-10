/**
 * 失败记录：让「刚才那张卡没更新成功」这件事在界面上看得见。
 *
 * ## 为什么需要它
 *
 * 此前所有失败都只有两条出口：一条 `log.error`，和一条五秒就消失的 toast。
 * 两者都要求用户**恰好在看**。于是出现了这个 bug：角色卡的批次全部解析失败、
 * 卡一字未改（这个行为本身是对的），但工程页上那张卡跟成功的一模一样——
 * 作者以为更新过了，此后一直拿着一张旧卡续写。
 *
 * 更隐蔽的是「部分失败」：三批里有一批挂了，成果照写，但「已读到」水位线
 * 停在失败之前，下次增量会重来。这件事以前只有一条 `log.warn`，界面上
 * 完全无痕。
 *
 * 所以失败要**留在目标身上**，而不是留在时间线上：工程页那一行上挂个感叹号，
 * 一直挂到它成功为止。
 *
 * ## 三条约定
 *
 * 1. **写失败记录本身绝不会失败**：全部 API 内部吞掉异常。库打不开时
 *    整套机制静默退化成「只有日志」，一个功能都不受影响。
 * 2. **成功必须清记录**（{@link clearFailures}）。修好了还挂着感叹号，
 *    比一开始不报错更糟——用户会学会无视它。
 * 3. **`targetKey` 用 relPath 而不是名字**：名字会被作者改，路径才是当下的
 *    身份，而且前端的树本来就按 relPath 索引，能直接对上。代价是改名/移动
 *    之后旧记录对不上而不再显示；这可接受（重跑一次就有新记录），不为它
 *    去给 `fileOps.ts` 加联动。
 */

import { openDatabase } from './db';
import { NovelProject } from './model/project';
import { FailureView } from './protocol';

/** 失败挂在什么东西上。与工程页的三个区一一对应。 */
export type FailureTargetKind = 'character' | 'chapter' | 'lore';

/**
 * - `error`：这次动作整体没成，目标**一字未改**。
 * - `warn`：部分成了（成果已写回），但有一块没成，下次会重来。
 */
export type FailureSeverity = 'error' | 'warn';

export interface FailureRecord {
  /** 日志来源名，与 `scoped()` 用的那个一致（「角色卡」「摘要」「设定」）。 */
  scope: string;
  targetKind: FailureTargetKind;
  /** 目标的工作区相对路径。 */
  targetKey: string;
  severity: FailureSeverity;
  /** 哪个动作失败了，如 `updateCard` / `summarize`。清记录时按它筛。 */
  op: string;
  /** 一句人话，直接显示在浮窗的标题行。 */
  message: string;
  /** 多行补充：失败的批次/章节、水位线停在哪、建议怎么办。 */
  detail?: string;
}

/**
 * 一个目标最多显示几条。
 *
 * 浮窗里摊开五条以上就没人看了，而最近的那条才是当下的状态。
 * 在查询处限制，不在写入处删——历史留着，日志页将来要按目标翻。
 */
const MAX_PER_TARGET = 3;

/**
 * 记一条失败。
 *
 * 调用方**不必** try/catch：库不可用、盘满、表被手删，都只是这条记录没留下，
 * 绝不往上抛。失败路径上再抛一个异常，会把「更新失败」变成「更新崩溃」。
 */
export async function recordFailure(project: NovelProject, record: FailureRecord): Promise<void> {
  const db = await openDatabase(project);
  if (!db) {
    return;
  }
  try {
    // 同一个目标 + 同一个动作只保留最新一条未清除的：连着重试三次失败，
    // 用户要看的是「现在还错着」，不是三条一模一样的记录。
    db.run(
      "UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND op = ? AND cleared_at IS NULL",
      new Date().toISOString(),
      record.targetKind,
      record.targetKey,
      record.op
    );
    db.run(
      'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message, detail)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      record.scope,
      record.targetKind,
      record.targetKey,
      record.severity,
      record.op,
      record.message,
      record.detail ?? null
    );
  } catch {
    /* 见函数注释：记不下来也不能影响正事 */
  }
}

/**
 * 目标成功了，把它挂着的失败记录清掉。
 *
 * `op` 给了就只清那个动作的——「摘要成功了」不该顺手把「角色卡失败了」
 * 一起抹掉。不给则清该目标的全部。
 */
export async function clearFailures(
  project: NovelProject,
  targetKind: FailureTargetKind,
  targetKey: string,
  op?: string
): Promise<void> {
  // 没有库就没有要清的记录——别为了「清空」把库建出来。
  // 成功路径每章/每卡都会走一次，这是最热的调用点。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return;
  }
  try {
    const now = new Date().toISOString();
    if (op) {
      db.run(
        'UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND op = ? AND cleared_at IS NULL',
        now,
        targetKind,
        targetKey,
        op
      );
    } else {
      db.run(
        'UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND cleared_at IS NULL',
        now,
        targetKind,
        targetKey
      );
    }
  } catch {
    /* 同上 */
  }
}

/**
 * 全部未清除的失败记录，按 `targetKey` 聚合，每个目标最多 {@link MAX_PER_TARGET} 条（新的在前）。
 *
 * **一次查询拿全部**，不要按目标逐个查：工程页每次刷新都要为几十张卡、
 * 几百章各查一次的话，一次 `pushState` 就是几百条 SQL。
 */
export async function listActiveFailures(
  project: NovelProject
): Promise<Record<string, FailureView[]>> {
  // 纯读取：库还不存在就别建。工程页每次刷新都走这里，为一个从没出过错的
  // 工程凭空生出一个 db 文件是不该有的副作用。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return {};
  }
  try {
    const rows = db.all<{
      at: string;
      target_key: string;
      severity: string;
      message: string;
      detail: string | null;
    }>(
      'SELECT at, target_key, severity, message, detail FROM errors' +
        ' WHERE cleared_at IS NULL ORDER BY id DESC'
    );

    const out: Record<string, FailureView[]> = {};
    for (const row of rows) {
      const list = (out[row.target_key] ??= []);
      if (list.length >= MAX_PER_TARGET) {
        continue;
      }
      list.push({
        at: row.at,
        // 库是文件，作者可能拿别的工具改过；认不出的一律当 error（宁可多提醒）。
        severity: row.severity === 'warn' ? 'warn' : 'error',
        message: row.message,
        detail: row.detail ?? undefined,
      });
    }
    return out;
  } catch {
    // 读不出来就当没有失败记录——工程页照常显示，只是没有感叹号。
    return {};
  }
}
