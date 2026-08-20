/**
 * `read` —— 读一份文件，带行号。`Workspace.read` 的薄包装。
 *
 * 两条上限**取先到的那一个**：400 行 / 20000 字符。行数管的是散文式的
 * markdown（细纲、场景卡），字符数管的是「一行三千字」的正文——只按行数
 * 截的话，一章正文常常是三行，一次就把整章塞进 agent 上下文了。
 *
 * 截断必须写在返回文本里（AGENTS 第 2 条）：模型不知道自己只看了一半，会
 * 拿着半份正文去下结论，而它下的结论看起来跟读全了一模一样。
 *
 * **越界与不存在都返回 `error` 而不是抛**：模型看得到 error，据此换个路径
 * 重试；抛出去只会让这一轮循环炸掉，而它本来只是猜错了一个文件名。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { int, objectSchema, str } from '../schema';
import { WsError } from '../../workspace';

/** 一次最多读几行。 */
export const READ_LINE_LIMIT = 400;
/** 一次最多读多少字符。正文常常一行几千字，只按行数截等于不截。 */
export const READ_CHAR_LIMIT = 20000;

export const readTool: ToolDef = {
  name: 'read',
  description:
    '读一份文件的内容，返回带行号的文本。path 是工程内相对路径、用正斜杠。' +
    `一次最多返回 ${READ_LINE_LIMIT} 行或 ${READ_CHAR_LIMIT} 字符（取先到的），` +
    '截断时会告诉你还剩多少行，用 offset 接着读下一段。' +
    'offset 是起始行号（从 1 开始），limit 是最多读几行。',
  parameters: objectSchema(
    {
      path: str('要读的文件，工程内相对路径。'),
      offset: int('从第几行开始读，从 1 开始。留空从头读。'),
      limit: int(`最多读几行。留空按上限 ${READ_LINE_LIMIT} 行。`),
    },
    ['path']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rel) {
      return { text: '', error: 'path 是必填的：给一个工程内相对路径。' };
    }
    // 行号对模型是 1-based（返回值里就是这么标的），Workspace 收的是 0-based。
    const from = Math.max(1, toInt(args.offset) ?? 1);
    const want = Math.min(READ_LINE_LIMIT, Math.max(1, toInt(args.limit) ?? READ_LINE_LIMIT));

    let file;
    try {
      file = await ctx.workspace.read(rel, { offset: from - 1, limit: want });
    } catch (err) {
      return { text: '', error: describe(err, rel) };
    }

    const lines = file.text === '' ? [] : file.text.split('\n');
    const total = file.truncated?.total ?? from - 1 + lines.length;

    // 字符上限：逐行累加，超了就停在上一行——切在行中间会让最后一行看起来
    // 像是原文就那么短。
    const kept: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (chars + line.length > READ_CHAR_LIMIT && kept.length > 0) {
        break;
      }
      kept.push(line);
      chars += line.length + 1;
    }

    const numbered = kept.map((line, i) => `${from + i}\t${line}`).join('\n');
    const lastRead = from - 1 + kept.length;
    const note =
      lastRead < total
        ? `\n（第 ${lastRead + 1}–${total} 行未读，共 ${total} 行。用 offset=${lastRead + 1} 接着读）`
        : '';

    return {
      text: `${rel}${numbered ? `\n${numbered}` : '\n（空文件）'}${note}`,
      display: { title: `read ${rel}`, detail: `${kept.length} 行` },
    };
  },
};

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * 异常 → 一句模型能照着改的话。
 *
 * `WsError` 的 message 本来就是人话（「文件不存在：…」「路径超出工程目录：…」），
 * 原样转述就够；意外异常给一句通用的，不把调用栈喂给模型。
 */
function describe(err: unknown, rel: string): string {
  if (err instanceof WsError) {
    return err.code === 'notFound'
      ? `${err.message}。可以用 list 看看那个目录下有什么，或用 search 找找。`
      : err.message;
  }
  return `读 ${rel} 失败：${err instanceof Error ? err.message : String(err)}`;
}
