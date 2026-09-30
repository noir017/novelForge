/**
 * 上下文装配器。
 *
 * 这里只剩三件事：**算预算、按配方跑一遍层、把存活的条目拼成 messages**。
 * 「带什么」在 [recipes.ts](recipes.ts)，「怎么取」在 [layers/](layers/index.ts)。
 *
 * 装配顺序即优先级：配方靠前的层先拿预算，靠后的可能被降级或丢弃。
 * 任何装不下的条目都会以 dropped/degraded 的形式留在 items 里——
 * **绝不静默丢弃**，作者需要知道这次没带上什么。
 */
import { AgentMessage } from '../llm/provider';
import { NovelProject } from '../model/project';
import { NovelConfig } from '../model/types';
import { estimateTokens } from './tokenizer';
import { LAYERS, resolveFocus, type Assembly } from './layers';
import { promptFactsOf } from './layers/dialog';
import { PromptFacts, askHeading, buildOutputContract } from './prompts';
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

  const recipe = recipeFor(request.action.stage, request.action.capability, request.step);
  const [focus, book] = await Promise.all([resolveFocus(project, request, recipe), project.readBookConfig()]);

  const assembly: Assembly = {
    project,
    request,
    config,
    focus,
    book,
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

    scratch: { fullTextNos: new Set<number>() },
  };

  // 强制项可能已经吃掉全部预算，后续条目自然会被判 dropped——这是有意的：
  // 系统提示、用户这句话、本层产物本来就比「早前第 3 章的摘要」重要。
  for (const spec of recipe) {
    await LAYERS[spec.layer](assembly, spec);
  }

  const messages = assembleMessages(items, request, promptFactsOf(assembly));
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
function assembleMessages(
  items: ContextItem[],
  request: BuildRequest,
  facts: PromptFacts
): AgentMessage[] {
  const live = items.filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim());
  const pick = (kind: ItemKind): ContextItem[] => live.filter((i) => i.kind === kind);
  const join = (list: ContextItem[]): string => list.map((i) => i.text.trim()).join('\n\n');

  const { stage, capability } = request.action;
  /** 正文出稿：只有这一种情况才谈「接下去写」「目标字数」。 */
  const writing = stage === 'manuscript' && capability === 'generate';

  const messages: AgentMessage[] = [];
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
  section('# 全局要求（每一章都要遵守）', pick('guidance'));
  section('# 故事架构', pick('setting'));
  section('# 全书前情提要', pick('globalSummary'));
  section('# 情节大纲', pick('outlineDoc'));
  section('# 故事结构指导', pick('guide'));
  section('# 相关角色设定', pick('character'));
  section('# 相关世界观设定', pick('lore'));
  // 摘要与正文都由远及近排列，读起来是正序的时间线。
  section('# 早前剧情摘要（由远及近）', pick('plotSummary').slice().sort(byNoAsc));

  const fullText = pick('manuscriptFull').slice().sort(byNoAsc);
  section('# 前文正文', fullText);

  const prevTail = pick('prevTail')[0];
  if (prevTail) {
    // 「不可重演」：上游的说法是「只作边界，不可重演」（PT:810）。模型拿到上一章结尾之后
    // 最常见的失败不是接不上，是从那里把最后一场重新演一遍（context/replay.ts 写完再查一次）。
    sections.push(
      writing
        ? `# 上一章结尾原文（只作边界，不可重演）\n\n这是上一章已经写完的结尾。本章从它的最终状态之后无缝接下去，不要重写、摘要或回放这一段。\n\n${prevTail.text}`
        : `# 上一章结尾原文\n\n${prevTail.text}`
    );
  } else if (writing && fullText.length > 0 && items.some((i) => i.kind === 'prevTail' && i.status === 'dropped')) {
    // 结尾片段被整章正文取代时，仍要点明接续位置。**只在确实被取代时说**：上一章
    // 根本没有正文（只排了细纲）时这里没有结尾片段可言，最后一份全文是更早的某一章，
    // 说「从它的结尾接下去」等于让模型跳过中间那一章的事件。
    const last = fullText[fullText.length - 1];
    sections.push(
      `你要从上面「${last.label.replace(' · 正文', '')}」结尾的最终状态之后无缝接下去，不要重演它的结尾。`
    );
  }

  // 已经排好的目录进度：细纲批次要紧接着它的最后一章往下排。
  section('# 前序细纲一览（已生成的目录进度）', pick('plotList'));

  // 本层产物紧挨着指令：这一章的细纲才是这一轮真正要动的东西。
  section('# 细纲', pick('plot'));

  // 写正文的边界：后面几章要发生的事。紧跟在本章细纲后面，读的时候就是「这一章写到这为止」。
  section('# 后续章节预告（仅供了解后续剧情发力点，绝对不要在本章提前写出这些内容）', pick('boundary'));

  // 「接着写」从这里往下接：离指令最近，接的是哪一句一眼看得到。
  section('# 本章已写正文（末尾，你要从这里接着写）', pick('chapterSoFar'));

  // 用户 @ 的引用也紧挨着他的指令放——他多半正是要针对这些内容提要求。
  section('# 我引用的内容（请针对这些内容作答）', pick('attachment'));

  const askText = pick('ask')[0]?.text ?? request.ask;
  const requirements: string[] = [
    `${askHeading(request.action, facts)}\n\n${askText.trim() || '（没有额外要求，按上面的设定与契约来。）'}`,
  ];
  if (request.extraInstruction?.trim()) {
    requirements.push(`额外要求：${request.extraInstruction.trim()}`);
  }
  sections.push(requirements.join('\n\n'));

  const revision = pick('revision')[0];
  if (revision) {
    sections.push(`# 修订要求\n\n${revision.text}\n\n请基于上一版重写，采纳修改意见，保留其中写得好的部分。`);
  }

  // target 也要给：架构层四件同属一个阶段，契约要看是哪一件。写正文时目标字数也在契约里
  // （篇幅合同 ±20%），从前这里另有一行「约 N 字（±15%）」，两个比例作者与模型都分不清哪个算数。
  sections.push(buildOutputContract(request.action, facts));

  messages.push({ role: 'user', content: sections.join('\n\n---\n\n') });
  return messages;
}

function byNoAsc(a: ContextItem, b: ContextItem): number {
  return noOf(a) - noOf(b);
}

function noOf(item: ContextItem): number {
  const m = /:(\d+)$/.exec(item.id);
  return m ? Number(m[1]) : 0;
}
