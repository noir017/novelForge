/**
 * 内置编辑器「写作体检」的后端一半：推词表（`checkTerms`），以及「编辑敏感词表…」。
 *
 * 两件事都**不调模型**（第 4 条：体检只是在正文里按词表找字）。
 *
 * - **推词表**：`pushState` 每跑一次就现算一份（`views/checkTerms.ts`：`style.md` 的禁用词表、小说配置、
 *   `.novelforge/sensitive.txt`），与上一次推的一样就不推——与 `chapterIndex` 同一个做法；新连上的前端不论变没变
 *   都推一份。只给有内置编辑器的宿主推（`Host.openInEditor` 这个能力），插件壳用不上，也就不为它多读两个文件。
 * - **编辑敏感词表…**：文件不在就经网关新建一份带说明注释的模板（`workspace.write`，`mode: 'create'`：同名报错、
 *   不覆盖），然后在编辑器里打开它；作者保存也走网关（编辑器那条路，乐观锁、存历史版本）。
 *
 * 敏感词表在指纹链之外：种类是 `sensitive`（`workspace/kind.ts`），没有创作阶段、不进装配器、不记 `upstreamHash` /
 * `writtenFrom`，改了它不会让任何一章挂 ⟳；新建是作者点的那一下（文件本来不在，没有可覆盖的），保存是编辑器的
 * 乐观锁，所以都不弹覆盖审阅（第 3 条的那一问由这两样担着）。
 */
import type { ChatController } from './index';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { exists } from '../model/fs';
import { SENSITIVE_TEMPLATE } from '../model/sensitiveWords';
import type { BookConfig } from '../model/settingFile';
import { buildCheckTerms } from '../views/checkTerms';
import { WsError } from '../workspace/guard';

const log = scoped('体检');

/** 每个 controller 上一次推出去的词表（JSON）。 */
const lastSig = new WeakMap<ChatController, string>();

/**
 * 推体检词表。内容与上一次推的一样就不推；`force` 给新连上的前端。`book` 是调用方手上已经读过的小说配置。
 * 失败只记 warn，不拖垮调用它的 `pushState`。
 */
export async function pushCheckTerms(c: ChatController, opts: { force?: boolean; book?: BookConfig } = {}): Promise<void> {
  if (!getHost().openInEditor) {
    return;
  }
  try {
    const terms = await buildCheckTerms(c.project, { book: opts.book });
    const sig = JSON.stringify(terms);
    if (!opts.force && lastSig.get(c) === sig) {
      return;
    }
    lastSig.set(c, sig);
    c.post({ type: 'checkTerms', terms });
  } catch (err) {
    log.warn(`算体检词表失败：${describeError(err)}`, err);
  }
}

/** 「编辑敏感词表…」：没有就新建模板，然后在编辑器里打开。 */
export async function editSensitiveWords(c: ChatController): Promise<void> {
  if (!(await c.project.isInitialized())) {
    c.toast('这个目录还不是小说工程（没有 .novelforge/），没有敏感词表可编辑。', 'error');
    return;
  }
  const rel = c.project.relPath(c.project.sensitivePath);
  if (!(await exists(c.project.sensitivePath))) {
    try {
      await c.workspace.write(rel, { text: SENSITIVE_TEMPLATE }, { mode: 'create' });
      log.info(`新建了敏感词表 ${rel}`, '全是注释的模板，一个词都还没生效');
      await pushCheckTerms(c);
    } catch (err) {
      // 刚好在这一刻别处建了它：照样打开那一份，不盖掉。
      if (!(err instanceof WsError && err.code === 'exists')) {
        throw err;
      }
    }
  }
  const host = getHost();
  await (host.openInEditor ? host.openInEditor(rel) : host.openFile(rel));
}
