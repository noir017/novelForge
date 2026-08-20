/**
 * `search` —— 全文检索。`workspace/search.ts` 的薄包装。
 *
 * 这是三期唯一的**新能力**：作者问「主角前面说过他没去过北境吗」，从前只能
 * 靠他自己手动 `@` 引用几章原文，跨章对账根本做不了。零模型调用的朴素扫描
 * 一上来就解决它——与「新鲜度只靠 hash 传播」（第 18 条）是同一条取舍：
 * 能用确定性方法算出来的，不花 token。
 *
 * 两件必须做对的事：
 *
 * 1. **`dropped > 0` 一定写进返回文本**（第 2 条）。搜索的丢弃尤其危险：
 *    模型看到「命中 2 处」会当成「全书只有 2 处」，然后据此断言主角从没提过
 *    北境——而真相是第 40 处被上限截掉了。
 * 2. **按章号升序**（`search.ts` 已经这么排了，这里只是不去打乱它）。作者问的
 *    是「他**前面**说过吗」，时间线顺序才有意义。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { bool, int, objectSchema, str, strArray } from '../schema';
import type { ArtifactKind } from '../../workspace';

/** 一次最多返回几条命中。 */
export const SEARCH_LIMIT = 40;
/** 每个文件最多几条，免得一份长文档吃掉全部名额。 */
export const SEARCH_PER_FILE = 4;

/** `kinds` 参数的候选值。与 `workspace/kind.ts` 的 `ArtifactKind` 同源。 */
const KINDS: ArtifactKind[] = [
  'outline',
  'style',
  'globalSummary',
  'plot',
  'scene',
  'manuscript',
  'chapter',
  'summary',
  'draft',
  'character',
  'lore',
  'other',
];

export const searchTool: ToolDef = {
  name: 'search',
  description:
    '在工程里全文检索，返回命中的行（带路径与行号），**按章号升序**。' +
    '默认按字面量搜（作者搜的多半是人名地名），regex=true 才当正则。' +
    'path 可限定目录，kinds 可限定产物种类（chapter=已发布的章，manuscript=尚未拆分的正文，' +
    'plot=细纲，scene=场景卡，summary=单章摘要，character=角色卡，lore=设定）。' +
    `一次最多返回 ${SEARCH_LIMIT} 条、每个文件最多 ${SEARCH_PER_FILE} 条；` +
    '有命中因为超上限被丢掉时会明确告诉你丢了几条——那时不要断言「全书只有这几处」。',
  parameters: objectSchema(
    {
      pattern: str('要找的字符串（或正则）。'),
      path: str('限定在这个目录下搜，工程内相对路径。留空搜全工程。'),
      kinds: strArray(`限定产物种类，可多个。可用值：${KINDS.join(' / ')}。`),
      regex: bool('把 pattern 当正则。缺省 false（按字面量搜）。'),
      limit: int(`最多返回几条，上限 ${SEARCH_LIMIT}。`),
    },
    ['pattern']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern.trim()) {
      return { text: '', error: 'pattern 是必填的：给一个要找的字符串。' };
    }
    const limit = Math.min(SEARCH_LIMIT, Math.max(1, toInt(args.limit) ?? SEARCH_LIMIT));

    const r = await ctx.workspace.search(pattern, {
      path: typeof args.path === 'string' ? args.path : undefined,
      kinds: pickKinds(args.kinds),
      regex: args.regex === true,
      perFile: SEARCH_PER_FILE,
      limit,
      // 上下文行不带：agent 拿到路径与行号之后可以自己 read 那一段，
      // 而前后文乘以 40 条就是几千 token 的重复内容。
      context: 0,
    });

    const lines = r.hits.map((h) => `${h.rel}:${h.line}  ${h.text.trim()}`);
    const foot = [`（命中 ${r.hits.length} 处，扫了 ${r.scanned} 个文件）`];
    if (r.dropped > 0) {
      // 不静默截断。模型据此知道「这不是全部」，别拿它当全书结论。
      foot.push(`⚠ 因超上限丢弃 ${r.dropped} 条——这不是全部命中，缩小 path 或 kinds 再搜一次。`);
    }
    if (r.note) {
      foot.push(`⚠ ${r.note}`);
    }
    if (r.hits.length === 0) {
      lines.push('（没有命中）');
    }

    return {
      text: [...lines, ...foot].join('\n'),
      display: {
        title: `search「${clip(pattern)}」`,
        detail: `${r.hits.length} 处命中${r.dropped > 0 ? `，丢弃 ${r.dropped}` : ''}`,
      },
    };
  },
};

/** 认不出的种类名一律丢掉，全丢光就当没限定——不因为一个错字搜出空结果。 */
function pickKinds(raw: unknown): ArtifactKind[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const known = raw.filter((k): k is ArtifactKind => (KINDS as string[]).includes(k as string));
  return known.length > 0 ? known : undefined;
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 20 ? `${one.slice(0, 20)}…` : one;
}
