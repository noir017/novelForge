/**
 * 存档点（工程页「存档点…」弹窗）的消息负载。设计见 `docs/design/plans/2026-10-20-checkpoints.md`。
 *
 * - 列表：前端发 `listCheckpoints`，后端回 `checkpoints`（新的在前）。存一个（`createCheckpoint`）、写备注并留住
 *   （`noteCheckpoint`）之后也重推它。
 * - 跟现在比：前端发 `checkpointDiff`，后端逐份比 sha，回 `checkpointDiff`。每份带此刻磁盘上那一份的 hash（`hashNow`），
 *   退回时原样带回来当乐观锁。
 * - 退回：前端发 `restoreCheckpoint`（要退回哪几份、要搬进回收站哪几份、乐观锁、编辑器里有未保存修改的那几份），
 *   后端先存一个「退回之前」、逐份写回，toast 汇总，然后重推 `checkpoints` 与这个存档点的 `checkpointDiff`。
 *
 * 存储在 `workspace/checkpoints.ts`，退回的编排在 `features/checkpoint.ts`，消息在 `controller/checkpoints.ts`。
 */
import type { ArtifactKind } from '../workspace/kind';

/** 列表里的一个存档点。 */
export interface CheckpointView {
  /** 清单的文件名去掉 `.json`（`2026-10-20_22-30-05+0800`），比、退回、写备注时认它。 */
  id: string;
  /** 存下的那一刻（毫秒时间戳）。 */
  time: number;
  /** 手动的是作者写的（可以空），自动的是机器写的「批量写章之前（第 12–20 章）」。 */
  note: string;
  /** 自动存的：只留最近 30 个；写了备注就留住（变成手动）。 */
  auto: boolean;
  /** 存了几份文件。 */
  files: number;
  /** 其中几章正文、正文一共多少字。 */
  chapters: number;
  chapterWords: number;
  /** 超过大小上限、没存进去的那几份（第 2 条：说出来）。 */
  skipped: string[];
}

/** 跟现在比，一份文件的情形。 */
export type CheckpointFileStatus =
  /** 存档点里有、现在也有，内容不一样。 */
  | 'changed'
  /** 存档点里有、现在没有了（之后删掉或搬走了）。 */
  | 'deleted'
  /** 现在有、存档点里没有（之后新建或搬过来的）。 */
  | 'added';

export interface CheckpointDiffEntry {
  path: string;
  kind: ArtifactKind;
  status: CheckpointFileStatus;
  /** 存档点里那一份的字数（`added` 没有）。 */
  wordsThen?: number;
  /** 磁盘上现在这一份的字数（`deleted` 没有）。 */
  wordsNow?: number;
  /** 磁盘上现在这一份的 hash（网关乐观锁的口径，`model/fs.ts` 的 `hash`）。`deleted` 没有。 */
  hashNow?: string;
}

export interface CheckpointDiffView {
  id: string;
  /** 内容一模一样的有几份（不逐份列）。 */
  unchanged: number;
  /** 按路径排；一模一样的不在里面。 */
  entries: CheckpointDiffEntry[];
}

/** 退回：要退回的、要搬进回收站的，都是 `checkpointDiff` 里列过的。 */
export interface RestoreCheckpointRequest {
  id: string;
  /** 退回成存档点里那一份（`changed` / `deleted`）。 */
  paths: string[];
  /** 搬进回收站（`added`：存档点之后新建的，作者勾了才有）。 */
  trash: string[];
  /**
   * 乐观锁：每份在面板上看到时的 hash（`hashNow`），`null` 表示当时磁盘上没有它。对不上就跳过这一份——
   * 这期间别处又改过，不拿存档点里的旧稿盖掉新改的。
   */
  expect: Record<string, string | null>;
  /** 编辑器里开着、有未保存修改的文件：跳过（同全书替换）。 */
  dirty: string[];
}
