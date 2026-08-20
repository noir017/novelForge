/**
 * `edit` —— 定点替换一段文字。`Workspace.edit` 的薄包装。
 *
 * ## 为什么需要它
 *
 * 改一个人名、修一句台词、调一个数字——用 `generate` 重写整份产物是浪费
 * （一次调用、几百上千 token，还会把作者改过的别处一起换掉），用 `write` 全文
 * 覆盖则要求模型把整份内容重新吐一遍（既慢又容易漏）。标准 edit 工具的形状
 * （`old` / `new` / `all`）任何支持工具调用的模型都见过，不必另教。
 *
 * ## 四条硬约束
 *
 * 1. **`old` 命中多处且没给 `all` 时报错，不改。** 错误里说清命中了几处，
 *    让它自己去加上下文把 `old` 变唯一——猜「他大概想改第一处」，改错的那次
 *    作者要读完整章才发现。
 * 2. **`old` 找不到时报错**，并指路「先 read 一遍确认当前内容」。模型凭记忆
 *    拼出来的 `old` 常常差一个标点。
 * 3. **仍然走 `ws.edit` → guard**：越界、回收站、保护路径、大小上限照样拦。
 *    这里一行新的路径检查都没有。
 * 4. **编辑产物类文件后照样记账**：`ws.edit` 内部走 `write` → handler 的
 *    `after`，`upstreamHash` / `beatsHash` 一期就下沉到写入路径本身了。
 *
 * ## 不做多处批量编辑
 *
 * 不收 `edits: [{old,new}]` 数组。一次一处，出错时状态清楚（网关那一层虽然
 * 支持「要么全成要么全不成」，但模型拿到「第 3 条对不上，整批没落盘」之后
 * 往往会重发一份改了一半的批次）。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { bool, objectSchema, str } from '../schema';
import { clip, describePath, text } from './naming';
import { WsError, kindOfPath } from '../../workspace';
import { clearFailures, recordFailure } from '../../runtime/errorLog';
import { describeError } from '../../runtime/logger';
import { WRITE_OP } from './write';

export const editTool: ToolDef = {
  name: 'edit',
  mutating: true,

  /**
   * **`always`：任何策略下都要问一句。**
   *
   * 它改的也是已有内容，但 `ws.edit` 走的是「拿这份内容和自己 diff」那条路
   * （`review: false`，理由见 `workspace/index.ts`），所以覆盖审阅在这里落成
   * 确认框——框里写出的 old → new 两段原文**就是它的 diff**。放开它，
   * 「覆盖已有内容一律过一遍人」就有了一个例外（第 25(a) 条）。
   */
  intent(args, project): ToolIntent {
    const target = text(args.path);
    return {
      gate: 'always',
      title: `改「${describePath(target, project)}」里的一段文字`,
      detail: [
        target,
        `原文：${clip(text(args.old))}`,
        `改成：${clip(text(args.new)) || '（删掉）'}`,
        args.all === true ? '文件里所有出现的地方都改。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      proceed: '替换',
    };
  },

  description:
    '把一份文件里的一段文字换成另一段。path 是工程内相对路径、用正斜杠。' +
    'old 必须与文件里的现有内容**逐字相同**（含标点与空格），' +
    '并且在这份文件里**唯一**——命中多处会报错并告诉你几处，' +
    '这时把 old 写长一点（带上前后文）让它唯一，或者传 all=true 全部替换。' +
    '改一个名字、修一句话、调一个数字用它，比重新 generate 整份产物省得多。' +
    '拿不准现在写的是什么就先 read 一遍。',

  parameters: objectSchema(
    {
      path: str('要改的文件，工程内相对路径。'),
      old: str('要被替换掉的原文，逐字相同且在文件里唯一。'),
      new: str('替换成什么。留空表示删掉这段。'),
      all: bool('命中多处时是否全部替换。缺省 false：不唯一就报错，不猜改哪一处。'),
    },
    ['path', 'old', 'new']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rel) {
      return { text: '', error: 'path 是必填的：给一个工程内相对路径。' };
    }
    const oldText = typeof args.old === 'string' ? args.old : '';
    if (!oldText) {
      return {
        text: '',
        error: 'old 是必填的，而且不能是空串：给一段文件里现有的、逐字相同的文字。',
      };
    }
    // `new` 允许是空串（删掉这一段），所以只校验类型不校验长度。
    if (typeof args.new !== 'string') {
      return { text: '', error: 'new 是必填的：要替换成什么。删掉这一段就传空字符串。' };
    }
    const newText = args.new;
    const all = args.all === true;

    const path = kindOfPath(ctx.project, rel);

    try {
      const r = await ctx.workspace.edit(rel, [{ old: oldText, new: newText, all }]);
      if (path.plotRelPath) {
        await clearFailures(ctx.project, 'plot', path.plotRelPath, WRITE_OP);
      }
      const side = r.side && r.side.length > 0 ? `\n连带：${r.side.join('；')}` : '';
      return {
        text: `${r.message}${side}`,
        display: { title: `edit ${r.rel}`, detail: r.message.replace(/：.*$/, '') },
      };
    } catch (err) {
      const message = describe(err, rel);
      if (path.plotRelPath) {
        await noteFailure(ctx, path.plotRelPath, `编辑 ${rel} 失败：${message}`);
      }
      return { text: '', error: message };
    }
  },
};

/**
 * 异常 → 一句模型能照着改的话。
 *
 * 两条最常见的（找不到、不唯一）各补一句「接下来该怎么办」——只回一句
 * 「找不到」，它多半会原地把同一个 `old` 再发一遍。
 */
function describe(err: unknown, rel: string): string {
  if (err instanceof WsError) {
    switch (err.code) {
      case 'notFound':
        return (
          `${err.message}。先 read ${rel} 看一眼当前内容，照着上面的原文（含标点与空格）再来一次。`
        );
      case 'notUnique':
        return `${err.message} 把 old 写长一点带上前后文让它唯一，或者传 all=true 全部替换。`;
      case 'outOfRoot':
        return `${err.message}。只能改工程目录之内的相对路径。`;
      default:
        return err.message;
    }
  }
  return `编辑 ${rel} 失败：${describeError(err)}`;
}

async function noteFailure(
  ctx: ToolContext,
  plotRelPath: string,
  message: string
): Promise<void> {
  await recordFailure(ctx.project, {
    scope: 'Agent',
    targetKind: 'plot',
    targetKey: plotRelPath,
    severity: 'error',
    op: WRITE_OP,
    message,
    detail: '这一次编辑没有落盘，磁盘上那份未改动。',
  });
}
