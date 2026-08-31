/**
 * 调试模式：把平时**故意不留**的东西留下来。
 *
 * ## 为什么需要它
 *
 * 出问题时最想看的那份东西，恰好是日志里永远不会有的那份：**这一次到底发给
 * 模型了什么**。第 11 条把 prompt 全文挡在日志之外是对的——一次续写的上下文
 * 有十万字，进了那个 800 条的环形缓冲会把此前所有线索挤没，复制进 issue 还
 * 可能带走整本书。于是排查一次「它为什么没按细纲写」只能靠猜：装配明细上写着
 * 「细纲 · 1200 token」，可那 1200 token 里到底是哪一版细纲，谁也说不出。
 *
 * 调试模式换一条路：**全文进文件，日志里只给路径。**
 *
 * ```
 * .novelforge/sessions/20260831-143012-4f2a.debug/
 *   20260831-143015-071-agent-step1.md
 *   20260831-143042-072-generate-manuscript.md
 * ```
 *
 * 日志页上那一条是
 *
 * ```
 * [14:30:42] INFO  调试｜已存下完整上下文：写正文
 *     /home/…/.novelforge/sessions/20260831-143012-4f2a.debug/20260831-143042-072-generate-manuscript.md
 * ```
 *
 * detail 那一段在日志页里可以直接选中复制，第 11 条那句「日志里绝不出现 prompt
 * 全文」一个字都不用改。
 *
 * ## 三条约定
 *
 * 1. **没开就什么都不做。** 每个调用点都是 `const at = await dumpContext(…)`，
 *    关着时拿到 `undefined`，后面的 `appendDump` 也就是空转。调用点不必自己
 *    判断开没开——那种判断写在五个地方就会有一个漏掉。
 * 2. **绝不因转储抛错。** 磁盘满了、目录只读，都只留一条 warn。调试是排查
 *    手段，不能自己变成故障源。
 * 3. **落在会话旁边。** `<会话 id>.debug/` 与 `<会话 id>.json` 同级：一次排查
 *    要的两样东西挨着放，删会话时一起搬进回收站（`SessionStore.delete`），
 *    整个工程要清干净就删掉这一批目录，不牵动任何别的东西。
 *    `SessionStore.list()` 只认 `*.json` 文件，多出来的目录它看不见。
 *
 * ## 它**不**脱敏
 *
 * 转储的是发给模型的原文。API Key 不在其中（那在 HTTP 头上，`llm/http.ts`
 * 才碰得到），但作者自己写进设定里的东西会原样落盘。这些文件在工程目录内，
 * 与小说正文同级——**贴进 issue 之前请自己看一眼**。日志那一条只有路径，
 * 不会替他把内容带出去。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readConfig } from '../config';
import { AgentMessage, ToolCall } from '../llm/provider';
import { NovelProject } from '../model/project';
import { describeError, scoped } from './logger';

const log = scoped('调试');

/**
 * 调试模式开着吗。
 *
 * 每次都重读配置而不是缓存：作者在设置页勾上之后，**下一次生成就该留下东西**，
 * 而不是重启之后才生效——排查时他多半已经复现过一次了，让他再复现一次是
 * 这个功能最容易被放弃的地方。读的是内存里的一份 JSON，不值得为它做缓存。
 */
export function debugEnabled(): boolean {
  try {
    return readConfig().debug;
  } catch {
    // 配置后端还没初始化（早期启动路径）：当作没开。
    return false;
  }
}

/** 某个会话的调试目录：`.novelforge/sessions/<id>.debug/`。 */
export function debugDirOf(project: NovelProject, sessionId: string): string {
  return path.join(project.sessionsDir, `${sessionId}.debug`);
}

/** 一次转储的原料。除 `messages` 外都是为了让文件自己说得清它是哪一次。 */
export interface ContextDump {
  /**
   * 落在哪个会话下。**缺席就不转储**——没有会话的调用（工程页的批量任务）
   * 没有一个天然的落点，硬造一个目录只会在工程里留下没人认领的垃圾。
   */
  sessionId?: string;
  /** 文件名里那一段，如 `agent-step3`、`generate-manuscript`。 */
  slug: string;
  /** 文件第一行的标题，直接给人看，如「agent 第 3 步」。 */
  title: string;
  /** 「模型 / 预算 / 消息数」那几行。值为 undefined 的项自动略过。 */
  facts?: Array<[string, string | number | undefined]>;
  /** 发给模型的全部消息，原样。 */
  messages: AgentMessage[];
  /** 附加段落（装配明细、工具清单），排在消息之前。 */
  sections?: Array<{ heading: string; body: string }>;
}

/**
 * 写一份完整上下文快照，并在日志里留下可复制的路径。
 *
 * 返回文件绝对路径；未开调试、无会话、写失败时返回 undefined
 * （调用方**不必判断**，`appendDump` 收到 undefined 就什么都不做）。
 *
 * **在发请求之前写**：请求可能超时、可能把进程拖住，那时最该看的就是这一份。
 * 等回答到了再写，卡住的那一次反而什么都不留。回答随后由 `appendDump` 补在
 * 同一个文件末尾。
 */
export async function dumpContext(
  project: NovelProject,
  dump: ContextDump
): Promise<string | undefined> {
  if (!debugEnabled() || !dump.sessionId) {
    return undefined;
  }
  const file = path.join(debugDirOf(project, dump.sessionId), `${stamp()}-${safeSlug(dump.slug)}.md`);
  const text = renderDump(dump);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  } catch (err) {
    // 第 2 条：调试不能自己变成故障源。
    log.warn(`完整上下文没写下来：${describeError(err)}`, file);
    return undefined;
  }
  log.info(
    `已存下完整上下文：${dump.title}`,
    // detail 就是路径本身：日志页上可以直接选中复制，粘进编辑器就能打开。
    `${file}\n${dump.messages.length} 条消息，${countChars(dump.messages)} 字`
  );
  return file;
}

/**
 * 往同一份快照末尾补一段（模型的回答、用量、停因）。
 *
 * `at` 是 {@link dumpContext} 的返回值——undefined 时静默跳过，所以调用点
 * 不必写 `if (debug)`。**不再记日志**：路径那一条已经报过，一次调用在日志里
 * 只该占一行。
 */
export async function appendDump(
  at: string | undefined,
  heading: string,
  body: string
): Promise<void> {
  if (!at) {
    return;
  }
  try {
    await fs.appendFile(at, `\n${sectionOf(heading, body)}`, 'utf8');
  } catch (err) {
    log.warn(`补写调试快照失败：${describeError(err)}`, at);
  }
}

/**
 * 会话被删时把它的调试目录一并搬进回收站（第 6 条：不真删）。
 *
 * 目录不存在是常态（没开过调试），静默返回。
 */
export async function trashDebugDir(project: NovelProject, sessionId: string): Promise<void> {
  const from = debugDirOf(project, sessionId);
  try {
    await fs.stat(from);
  } catch {
    return;
  }
  const to = path.join(project.trashDir, `${sessionId}.debug`);
  try {
    await fs.mkdir(project.trashDir, { recursive: true });
    await fs.rm(to, { recursive: true, force: true });
    await fs.rename(from, to);
  } catch (err) {
    log.warn(`调试目录没能搬进回收站：${describeError(err)}`, from);
  }
}

// ---------------------------------------------------------------- 排版

/**
 * `20260831-143042-071`：日期 + 时分秒 + 毫秒。
 *
 * 时间打头是为了**按文件名排序就是按发生顺序**——排查时那一串文件要一路读
 * 下来。毫秒不是装饰：agent 一个回合里可能连着转储两份（循环一份、它顺手
 * 调的 `generate` 一份），秒级精度会撞名，撞了就是覆盖掉前一份。
 */
let dumpCounter = 0;
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  // 毫秒之外再加一个进程内计数器：同一毫秒内连开两份也不撞。
  dumpCounter = (dumpCounter + 1) % 1000;
  return `${date}-${time}-${p(d.getMilliseconds(), 3)}${p(dumpCounter, 3)}`;
}

/** 文件名里那一段：只留字母数字连字符，别的一律换成 `-`。 */
function safeSlug(slug: string): string {
  const cleaned = slug.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'dump';
}

function renderDump(dump: ContextDump): string {
  const out: string[] = [`# ${dump.title}`, ''];
  out.push(`- 时间：${new Date().toISOString()}`);
  if (dump.sessionId) {
    out.push(`- 会话：${dump.sessionId}`);
  }
  for (const [key, value] of dump.facts ?? []) {
    if (value !== undefined && value !== '') {
      out.push(`- ${key}：${value}`);
    }
  }
  out.push('');
  for (const section of dump.sections ?? []) {
    out.push(sectionOf(section.heading, section.body));
  }
  out.push(`## 发给模型的消息（${dump.messages.length} 条）`, '');
  dump.messages.forEach((m, i) => out.push(renderMessage(m, i + 1)));
  return out.join('\n');
}

/**
 * 一条消息。**正文不加代码围栏**：里面本来就常有 ``` （细纲、JSON 产物），
 * 套一层围栏只会让编辑器把后半段当成正文之外的东西。分隔靠标题行，
 * 内容原样——这份文件的用处就是「原样」。
 */
function renderMessage(m: AgentMessage, no: number): string {
  const head =
    m.role === 'tool'
      ? `### [${no}] tool · ${m.name}（${m.toolCallId}）`
      : `### [${no}] ${m.role}`;
  const parts = [head, '', m.content ?? '', ''];
  if (m.role === 'assistant' && m.toolCalls?.length) {
    parts.push(`#### 它这一步要调的工具（${m.toolCalls.length} 个）`, '', renderToolCalls(m.toolCalls), '');
  }
  if (m.role === 'assistant' && m.traces?.length) {
    // 思考凭据的**正文不落盘**：那是 provider 要原样交回去的不透明数据，
    // 有些服务商给的是加密串，写进来只是几屏乱码。记一句它在就够了。
    parts.push(`（另带 ${m.traces.length} 份思考凭据，原样交回给模型）`, '');
  }
  return parts.join('\n');
}

function renderToolCalls(calls: ToolCall[]): string {
  return calls
    .map((c) => {
      let args: string;
      try {
        args = JSON.stringify(c.args ?? {}, null, 2);
      } catch {
        args = '（参数序列化失败）';
      }
      return `- ${c.name}（${c.id}）\n${indent(args)}`;
    })
    .join('\n');
}

function sectionOf(heading: string, body: string): string {
  return `## ${heading}\n\n${body}\n`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function countChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
}
