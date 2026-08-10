/**
 * 上下文装配器。
 *
 * 这里只剩三件事：**算预算、按配方跑一遍层、把存活的条目拼成 messages**。
 * 「带什么」在 [recipes.ts](recipes.ts)，「怎么取」在 [layers.ts](layers.ts)。
 *
 * 装配顺序即优先级：配方靠前的层先拿预算，靠后的可能被降级或丢弃。
 * 任何装不下的条目都会以 dropped/degraded 的形式留在 items 里——
 * **绝不静默丢弃**，作者需要知道这次没带上什么。
 */
import { ChatMessage } from '../llm/provider';
import { NovelProject } from '../model/project';
import { NovelConfig } from '../model/types';
import { estimateTokens } from './tokenizer';
import { LAYERS, resolveFocus } from './layers';
import type { Assembly } from './layers';
import { askHeading, buildOutputContract } from './prompts';
import { recipeFor } from './recipes';
import { BuildRequest, BuiltContext, ContextItem, ItemKind } from './types';

export * from './types';

const SAFETY_MARGIN = 512;

export async function buildContext(
  project: NovelProject,
  request: BuildRequest,
  config: NovelConfig
): Promise<BuiltContext> {
  const excluded = new Set(request.excludedIds ?? []);
  const items: ContextItem[] = [];

  const hardLimit = Math.min(
    config.contextWindow,
    request.providerMaxInputTokens ?? Number.POSITIVE_INFINITY
  );
  const budget = Math.max(1000, hardLimit - config.maxOutputTokens - SAFETY_MARGIN);
  const budgetClampedByProvider =
    request.providerMaxInputTokens !== undefined && request.providerMaxInputTokens < config.contextWindow;

  const recipe = recipeFor(request.action.stage);
  const focus = await resolveFocus(project, request, recipe);

  const assembly: Assembly = {
    project,
    request,
    config,
    focus,
    budget,
    remaining: budget,
    items,
    excluded,

    /** 尝试把一条内容放进预算。放不下就按 note 记为 dropped。 */
    admit(item, opts = {}) {
      if (excluded.has(item.id)) {
        const rejected: ContextItem = { ...item, text: '', tokens: 0, status: 'excluded', note: '已被手动排除' };
        items.push(rejected);
        return rejected;
      }
      const tokens = estimateTokens(item.text);
      if (!opts.force && tokens > assembly.remaining) {
        const dropped: ContextItem = {
          ...item,
          text: '',
          tokens: 0,
          status: 'dropped',
          note: `预算不足（需 ${tokens} token，剩 ${Math.max(0, assembly.remaining)}）`,
        };
        items.push(dropped);
        return dropped;
      }
      assembly.remaining -= tokens;
      const included: ContextItem = { ...item, tokens, status: 'included' };
      items.push(included);
      return included;
    },

    accept(item, tokens) {
      assembly.remaining -= tokens;
      items.push({ ...item, tokens });
    },

    reject(item, status, note) {
      items.push({ ...item, text: '', tokens: 0, status, note });
    },

    scratch: { fullTextOrders: new Set<number>() },
  };

  // 强制项可能已经吃掉全部预算，后续条目自然会被判 dropped——这是有意的：
  // 系统提示、用户这句话、本层产物本来就比「早前第 3 章的摘要」重要。
  for (const spec of recipe) {
    await LAYERS[spec.layer](assembly, spec);
  }

  const messages = assembleMessages(items, request, config);
  const usedTokens = items.reduce((sum, i) => sum + i.tokens, 0);

  return { messages, items, usedTokens, budget, budgetClampedByProvider };
}

// ---------------------------------------------------------------- 组装

/**
 * 条目 → messages。
 *
 * 段落顺序即「读的顺序」：背景知识在前，本层产物在中间，用户这一轮的要求
 * 与输出契约压在最后——模型对末尾的指令最敏感，把「现在请你做什么」放在
 * 十万字前文之前，等于让它读完全书再回头猜要干嘛。
 */
function assembleMessages(items: ContextItem[], request: BuildRequest, config: NovelConfig): ChatMessage[] {
  const live = items.filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim());
  const pick = (kind: ItemKind): ContextItem[] => live.filter((i) => i.kind === kind);
  const join = (list: ContextItem[]): string => list.map((i) => i.text.trim()).join('\n\n');

  const { stage, capability } = request.action;
  /** 正文出稿：只有这一种情况才谈「接下去写」「目标字数」。 */
  const writing = stage === 'manuscript' && (capability === 'generate' || capability === 'rewrite');

  const messages: ChatMessage[] = [];
  const system = pick('system')[0];
  if (system) {
    messages.push({ role: 'system', content: system.text });
  }

  // 历史对话作为真正的多轮消息发出，而不是塞进一段文本里——
  // 模型对 role 交替的理解远好于「以下是我们之前的对话」。
  const historyById = new Map((request.history ?? []).map((t) => [`history:${t.id}`, t]));
  for (const item of pick('history')) {
    const turn = historyById.get(item.id);
    if (turn) {
      messages.push({ role: turn.role, content: item.text });
    }
  }

  const sections: string[] = [];
  const section = (heading: string, list: ContextItem[]): void => {
    if (list.length > 0) {
      sections.push(`${heading}\n\n${join(list)}`);
    }
  };

  section('# 文风指南（务必贴合）', pick('style'));
  section('# 全书前情提要', pick('globalSummary'));
  section('# 全书大纲', pick('outlineDoc'));
  section('# 相关角色设定', pick('character'));
  section('# 相关世界观设定', pick('lore'));
  // 章节摘要与正文都由远及近排列，读起来是正序的时间线。
  section('# 早前章节摘要（由远及近）', pick('chapterSummary').slice().sort(byOrderAsc));

  const fullChapters = pick('chapterFull').slice().sort(byOrderAsc);
  section('# 最近章节正文', fullChapters);

  const prevTail = pick('prevTail')[0];
  if (prevTail) {
    sections.push(
      writing
        ? `# 上一章结尾原文（你要从这里无缝接下去）\n\n${prevTail.text}`
        : `# 上一章结尾原文\n\n${prevTail.text}`
    );
  } else if (writing && fullChapters.length > 0) {
    // 结尾片段被整章原文取代时，仍要点明接续位置。
    const last = fullChapters[fullChapters.length - 1];
    sections.push(`你要从上面「${last.label.replace(' · 原文', '')}」的结尾处无缝接下去。`);
  }

  // 本层产物紧挨着指令：这一章的细纲、这一幕的场景卡才是这一轮真正要动的东西。
  section('# 章节细纲', pick('plan'));
  section('# 场景设计', pick('scene'));

  // 用户 @ 的引用也紧挨着他的指令放——他多半正是要针对这些内容提要求。
  section('# 我引用的内容（请针对这些内容作答）', pick('attachment'));

  const requirements: string[] = [`${askHeading(request.action)}\n\n${pick('ask')[0]?.text ?? request.ask}`];
  if (writing && request.targetWords && request.targetWords > 0) {
    requirements.push(`目标字数：约 ${request.targetWords} 字（±15% 均可）。`);
  }
  if (request.extraInstruction?.trim()) {
    requirements.push(`额外要求：${request.extraInstruction.trim()}`);
  }
  sections.push(requirements.join('\n\n'));

  const revision = pick('revision')[0];
  if (revision) {
    sections.push(`# 修订要求\n\n${revision.text}\n\n请基于上一版重写，采纳修改意见，保留其中写得好的部分。`);
  }

  const contract = buildOutputContract(request.action, request.targetWords);
  sections.push(
    writing && config.recentChaptersFullText > 0
      ? `${contract}注意与上文的语气、称谓、时态保持一致。`
      : contract
  );

  messages.push({ role: 'user', content: sections.join('\n\n---\n\n') });
  return messages;
}

function byOrderAsc(a: ContextItem, b: ContextItem): number {
  return orderOf(a) - orderOf(b);
}

function orderOf(item: ContextItem): number {
  const m = /:(\d+)$/.exec(item.id);
  return m ? Number(m[1]) : 0;
}
