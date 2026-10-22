/**
 * 全书查找替换的消息入口（独立版「编辑 → 全书查找替换…」）：`bookFind` / `cancelBookFind` / `bookReplace`。
 * 搜索在 `views/bookFind.ts`（只读），替换在 `features/bookReplace.ts`（经网关写）。
 *
 * - **回复是广播**（同一个工程开着两个窗口时两边都收到），前端认 `requestId`。
 * - **叫停按请求认，不按 controller 认**：独立版几个窗口开同一个工程时共用一个 controller，「新的一次顶掉上一次」要是记在
 *   controller 上，一个窗口打字会把另一个窗口正在搜的叫停。所以前端发新请求之前自己先 `cancelBookFind` 上一个，
 *   这里只记「哪几个 requestId 被叫停了」，搜索在两份文件之间看一眼。
 * - **同一时刻只有一次替换**（同一个 controller 上）：两次替换交错着写同一批文件，乐观锁会让后一次全部跳过，
 *   但汇总会说成「预览之后改过了」——不如直接说「上一次还没换完」。
 */
import type { ChatController } from './index';
import { scoped } from '../runtime/logger';
import { searchBook } from '../views/bookFind';
import { replaceInBook } from '../features/bookReplace';
import type { BookFindQuery, BookReplaceRequest, BookReplaceSummary } from '../protocol';

const log = scoped('全书查找');

/** 还在搜的请求 → 叫停了没有。搜完（不论结果）就删掉。 */
const running = new Map<string, { cancelled: boolean }>();
/** 先到的叫停（`cancelBookFind` 比 `bookFind` 先处理完的那种时序：独立版对每条消息并发处理）。只留最近几个。 */
const cancelledEarly = new Set<string>();
const EARLY_KEPT = 64;

/** 正在替换的 controller。 */
const replacing = new WeakSet<ChatController>();

export async function bookFind(c: ChatController, requestId: string, query: BookFindQuery): Promise<void> {
  if (typeof requestId !== 'string' || !requestId) {
    return;
  }
  if (cancelledEarly.delete(requestId)) {
    return;
  }
  const token = { cancelled: false };
  running.set(requestId, token);
  try {
    const result = await searchBook(c.project, query ?? { query: '', scopes: [] }, { cancelled: () => token.cancelled });
    if (result && !token.cancelled) {
      c.post({ type: 'bookFindResult', requestId, result });
    }
  } finally {
    running.delete(requestId);
  }
}

export function cancelBookFind(requestId: string): void {
  const token = running.get(requestId);
  if (token) {
    token.cancelled = true;
    return;
  }
  if (typeof requestId === 'string' && requestId) {
    cancelledEarly.add(requestId);
    if (cancelledEarly.size > EARLY_KEPT) {
      cancelledEarly.delete(cancelledEarly.values().next().value as string);
    }
  }
}

export async function bookReplace(c: ChatController, requestId: string, request: BookReplaceRequest): Promise<void> {
  if (typeof requestId !== 'string' || !requestId) {
    return;
  }
  if (replacing.has(c)) {
    c.post({ type: 'bookReplaceDone', requestId, summary: failed('上一次全书替换还没换完，等它换完再来。') });
    return;
  }
  replacing.add(c);
  try {
    const summary = await replaceInBook(c.project, request ?? ({} as BookReplaceRequest));
    c.post({ type: 'bookReplaceDone', requestId, summary });
  } catch (err) {
    // 前端正等着这一句：出错也要回话（已经换了的几份在磁盘上、各自留着历史版本，日志里有明细）。
    const message = err instanceof Error ? err.message : String(err);
    log.error(`全书替换出错：${message}`, err);
    c.post({ type: 'bookReplaceDone', requestId, summary: failed(`替换中途出错：${message}（已经换了的文件各自留着历史版本，日志里有明细）`) });
  } finally {
    replacing.delete(c);
    // 换过的文件：工程树、章节索引、出场索引、设定名录都从磁盘现算；state 一到，编辑器核对已开的标签
    // （没改过的就地换成新内容，改过的挂冲突条）。
    await c.pushState();
  }
}

function failed(error: string): BookReplaceSummary {
  return { files: 0, hits: 0, replaced: [], skipped: [], chainKept: [], plotOnly: [], bodyOnly: [], renamedCards: [], error };
}
