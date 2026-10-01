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

  const recipe = recipeFor(request.action.stage, request.action.capability, request.step, request.writeMode);
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

    scratch: { fullTextNos: new Set<number>(), evidence: new Map<number, ContextItem>() },
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
  /** 审稿（五期）：几段材料的标题要说清哪些是已经发生的事、哪些不是。 */
  const reviewing = capability === 'review';
  /** 按审稿意见修稿（五期）。 */
  const revising = writing && request.writeMode === 'revise';

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
  // 证据原文排在摘要后面、前文正文前面：读的时候是「摘要这么说 → 原文是这样写的 → 紧挨着的那几章」。
  // 说法移植自上游 chapter-materials.ts:223-227（「索引、摘要和 currentState 都不是作者事实」）。
  section(
    '# 定稿原文片段（前情以这些原文为准；摘要、角色状态与它有出入时信原文）',
    pick('evidence').slice().sort(byNoAsc)
  );
  // 审稿对照的前情：上游标的是「已确认定稿历史｜唯一已发生事实源」（RV:212-227）。
  section('# 前几章的连续性事实（已定稿，已经发生的事）', pick('facts').slice().sort(byNoAsc));

  // 叙事线（七期）：一条一行，按要紧程度排（层里排好了，不按章号）。排在前情后面、前文正文前面：
  // 读的时候是「前面发生了什么 → 哪几条线还开着 → 紧挨着的那几章」。说法的后半句是这一层存在的
  // 另一半理由——模型知道第 8 章要揭开什么，写第 3 章时最顺手的就是提前揭开。
  const threadLines = pick('thread');
  if (threadLines.length > 0) {
    sections.push(
      `# 进行中的叙事线（只作提醒：以本章细纲为准，细纲没写到的线不要硬塞；没到回收章的线不许提前揭开）\n\n${threadLines
        .map((i) => i.text.trim())
        .join('\n')}`
    );
  }

  const fullText = pick('manuscriptFull').slice().sort(byNoAsc);
  section('# 前文正文', fullText);

  const prevTail = pick('prevTail')[0];
  if (prevTail) {
    // 「不可重演」：上游的说法是「只作边界，不可重演」（PT:810）。模型拿到上一章结尾之后
    // 最常见的失败不是接不上，是从那里把最后一场重新演一遍（context/replay.ts 写完再查一次）。
    sections.push(
      writing && !revising
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
  // 审稿时同一份东西换个说法（上游 `planningMaterial` 的「当前及未来蓝图/计划｜非既定历史」）。
  section(
    reviewing
      ? '# 后续章节计划（非既定历史：这些事还没有发生，只用来判断本章有没有提前写掉）'
      : '# 后续章节预告（仅供了解后续剧情发力点，绝对不要在本章提前写出这些内容）',
    pick('boundary')
  );

  // 审的就是它：紧挨着契约，引文从这里逐字摘。
  section('# 待审正文', pick('chapterFull'));

  // 「接着写」从这里往下接：离指令最近，接的是哪一句一眼看得到。
  section(
    revising ? '# 已修订正文（末尾，从这里接着输出）' : '# 本章已写正文（末尾，你要从这里接着写）',
    pick('chapterSoFar')
  );

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
    // 修稿不说「重写」：它要的是清单指到的那几处改掉、其余一字不动（契约里说清）。
    sections.push(
      revising
        ? `# 待修稿原文与审稿意见\n\n${revision.text}`
        : `# 修订要求\n\n${revision.text}\n\n请基于上一版重写，采纳修改意见，保留其中写得好的部分。`
    );
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
