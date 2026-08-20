/**
 * agent 的上下文：**状态注入** + **消息压缩**。
 *
 * ## 状态注入：agent 与界面说同一套话
 *
 * 每回合往 system 消息里拼一段约 150 token 的现场描述：
 *
 * ```
 * # 当前工程
 * 《青云志》· 已发布 99 章 · 31.2 万字
 * 当前目标：第 100 章（.novelforge/plots/100.md）
 * 本章状态：待写剧情
 * 下一步（由状态机算出，不要另做判断）：写剧情
 *   先把这一章的剧情脉络排出来：发生什么、因果怎么串、收在什么局面上。
 * 提醒：第 12、13 章的上游产物改过（⟳）
 * ```
 *
 * **判据一个都不在这里重新实现**：`buildPipelineIndex` 取数、`deriveStage` /
 * `deriveNextStep` / `deriveBookStage` 判断，与创作页主按钮吃的是同一份输出
 * （AGENTS 第 20 条）。两处各判各的，界面上就会出现「徽章说待拆场景，agent
 * 让你写正文」——而那种分叉没有任何测试拦得住，只会让作者不再相信界面。
 *
 * 这同时解释了为什么**没有 `status` 工具**：状态每回合免费送到，不花一次
 * 往返、不给模型「要不要查一下」的选择。
 *
 * ## 消息压缩：agent 自己的历史会涨
 *
 * 工具结果一条条累积，十几步之后 system 之外全是 `read` 的回显。策略四条：
 *
 * 1. **system 与最后 K 轮永不压缩**（K 默认 6）。刚发生的事必须完整。
 * 2. 更早的 `tool` 消息只留**第一行** + 一句「（结果已省略，需要可重新调用）」。
 *    留第一行是因为读工具的第一行恰好是「路径 + 总量」那句话——模型据此知道
 *    自己看过什么、值不值得再读一次。
 * 3. 压缩发生时**记一条 warn**（第 2 条：不静默截断）。
 * 4. 压到底仍然超预算时**报出来让循环停下**，不默默丢掉用户最初那句要求——
 *    丢了的话 agent 会开始回答一个谁也没问过的问题。
 */
import { AgentMessage } from '../llm/provider';
import { estimateTokens } from '../context/tokenizer';
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import {
  CreationTarget,
  PLOT_STAGE_LABEL,
  chapterLabel,
  deriveBookNextStep,
  deriveBookStage,
  deriveNextStep,
  plotOfTarget,
  segmentLabel,
} from '../model/pipeline';
import { buildPipelineIndex, factsOf } from '../views/pipeline';
import type { PlotPipeline } from '../views/pipeline';

const log = scoped('Agent');

/** 「⟳ 上游改过」最多点名几章，超了写「等 N 章」。 */
export const STALE_LIST_LIMIT = 5;

/** 永不压缩的最近轮数。一轮 = 一次模型回复 + 它引出的那批工具结果。 */
export const KEEP_ROUNDS = 6;

// ---------------------------------------------------------------- 状态注入

/**
 * 拼一份「现在这本书走到哪了」。**只取数，判断全在 `model/pipeline.ts`。**
 *
 * `target` 缺席（作者还没选章）时只报全书那一层的下一步——那正是
 * `deriveBookNextStep` 的职责，与创作页在全书大纲阶段显示的是同一句话。
 *
 * 代价是一次 `buildPipelineIndex`，与工程页刷新同一趟活。调用方（循环）每回合
 * 调一次：三期的工具一个字都不写盘，状态其实变不了，但作者可能正在另一个窗口
 * 里改文件——照着一份开跑时的旧快照往下走，比多读一次盘糟得多。
 */
export async function buildStateBrief(
  project: NovelProject,
  target?: CreationTarget
): Promise<string> {
  const { pipelines, segments, chapters, volumes, manifest, outline } =
    await buildPipelineIndex(project);
  const all = [...pipelines.values()];

  const words =
    chapters.reduce((sum, c) => sum + c.wordCount, 0) +
    segments.reduce((sum, p) => sum + p.manuscript.words, 0);

  const lines: string[] = ['# 当前工程'];
  lines.push(
    `《${manifest.title || '未命名'}》· ${volumes.length} 卷 · 已发布 ${chapters.length} 章 · ` +
      `${formatWords(words)}（还没交付的剧情段 ${segments.length} 个）`
  );

  const current = target ? findPipeline(all, target) : undefined;
  if (current) {
    const where = current.plot.relPath || current.chapter.relPath || plotOfTarget(target!) || '';
    // 已经交付的段报「第 N 章」（它就是那几章），还没交付的报「剧情 N」——
    // 与工程页、与主按钮同一份说法（第 20 条：文案只有一份）。
    const head = current.consumed
      ? chapterLabel(current.no, current.title)
      : segmentLabel(current.displayNo, current.title);
    lines.push(`当前目标：${head}（${where}）`);
    lines.push(`状态：${PLOT_STAGE_LABEL[current.stage]}`);

    const next = deriveNextStep(current.stage, factsOf(current));
    lines.push(
      ...describeNext(next, '这一段都做完了，不必再往下推进——需要改动的话作者会说。')
    );
  } else {
    // 还没选：走全书那一层。没有大纲就写大纲，有大纲没卷就拆卷，有卷没段就
    // 去拆段，都齐了 `deriveBookNextStep` 就不给下一步——那时该挑哪一段是
    // **作者的选择**，不是系统能替他定的，所以照实说，不要造一个假的下一步。
    const bookStage = deriveBookStage({
      outlineFilled: outline.trim().length > 0,
      volumeCount: volumes.length,
      // **已发布的章也算数**：老工程写了 99 章、一份卷纲都没有，把它拉回
      // 「先把大纲拆成卷」是荒唐的（第 8 条：已发布的正文天生就算数）。
      plotCount: segments.length + chapters.length,
    });
    lines.push('当前目标：还没选定某一段');
    lines.push(
      ...describeNext(
        deriveBookNextStep(bookStage),
        '大纲、分卷与剧情段都有了。具体做哪一段要看作者这一轮说的是什么，不要自己挑一段开工。'
      )
    );
  }

  const stale = segments.filter(
    (p) => p.plot.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale)
  );
  if (stale.length > 0) {
    const named = stale.slice(0, STALE_LIST_LIMIT).map((p) => `剧情 ${p.displayNo}`).join('、');
    const rest = stale.length > STALE_LIST_LIMIT ? `等 ${stale.length} 段` : '';
    lines.push(`提醒：${named}${rest}的上游产物改过，现有内容可能已经对不上（⟳）`);
  }
  return lines.join('\n');
}

/**
 * 「下一步」那两行。**label 与 hint 逐字来自状态机**，不在这里改写措辞——
 * 界面上的主按钮写着「拆成场景」，agent 却说「去写场景卡」，作者会以为
 * 它们是两件事。
 *
 * 状态机不给下一步时**照实说**（第 20 条 (c)：做完了就不给下一步）。造一个假的
 * 出来，agent 会自作主张挑一章开始烧钱。
 */
function describeNext(next: { label: string; hint: string } | undefined, done: string): string[] {
  if (!next) {
    return [`下一步：${done}`];
  }
  return [`下一步（由状态机算出，不要另做判断）：${next.label}`, `  ${next.hint}`];
}

/**
 * target → 它属于哪一段的流水线。
 *
 * **按路径认**：细纲路径是段的身份。target 里记的可能是一份还不存在的细纲
 * （老工程里选中某一章那条路），那时退回「这一段拆出来的章里有它」——
 * 与 `selectPlot` 同一条判据。
 *
 * 从前这里还有一条「按章号兜底」：段号与章号同源时它成立，现在两者是两条轴，
 * 拿号去猜会指到一个毫不相干的段上。
 */
function findPipeline(all: PlotPipeline[], target: CreationTarget): PlotPipeline | undefined {
  const rel = plotOfTarget(target);
  if (!rel) {
    return undefined;
  }
  return all.find((p) => p.plot.relPath === rel || p.chapter.chapterPaths.includes(rel));
}

function formatWords(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`;
}

// ---------------------------------------------------------------- 消息压缩

/** 压缩后代替工具结果的那句话。 */
const OMITTED = '（结果已省略，需要可重新调用同一个工具）';

export interface BuiltAgentMessages {
  messages: AgentMessage[];
  /** 被压缩掉的工具结果条数。**必须报出来**，不静默截断。 */
  droppedCount: number;
  /**
   * 压到底仍然超预算。循环据此停下并如实告诉用户，
   * **不要默默丢掉他最初那句要求**。
   */
  overBudget: boolean;
  /** 估算出的输入 token。用户可见的用量说明吃它。 */
  tokens: number;
}

/**
 * system + 历史 → 发给模型的消息表。
 *
 * `turns` 是本次 agent 循环里累积的对话（user 的原始要求、assistant 的回复
 * 与工具调用、tool 的结果），**不含 system**——system 每回合重拼（状态会变），
 * 塞进历史里会攒下十几份互相矛盾的旧状态。
 */
export function buildAgentMessages(
  system: string,
  turns: AgentMessage[],
  budgetTokens: number
): BuiltAgentMessages {
  const head: AgentMessage = { role: 'system', content: system };
  const full = [head, ...turns];
  const fullTokens = tokensOf(full);
  if (fullTokens <= budgetTokens) {
    return { messages: full, droppedCount: 0, overBudget: false, tokens: fullTokens };
  }

  // 保护窗口：从后往前数 KEEP_ROUNDS 个 assistant 回复，那一条及其之后全留。
  const protectedFrom = protectedIndex(turns, KEEP_ROUNDS);
  let droppedCount = 0;
  const compressed = turns.map((msg, i) => {
    if (i >= protectedFrom || msg.role !== 'tool') {
      return msg;
    }
    const short = firstLine(msg.content);
    if (short.length + OMITTED.length >= msg.content.length) {
      // 本来就只有一行，压了也省不下什么，留着原样更有用。
      return msg;
    }
    droppedCount += 1;
    return { ...msg, content: `${short}\n${OMITTED}` };
  });

  const messages = [head, ...compressed];
  const tokens = tokensOf(messages);
  if (droppedCount > 0) {
    log.warn(
      `agent 上下文超预算，省略了 ${droppedCount} 条更早的工具结果`,
      `压缩前约 ${fullTokens} token，压缩后约 ${tokens}，上限 ${budgetTokens}；` +
        `最近 ${KEEP_ROUNDS} 轮完整保留，被省略的可以重新调用同一个工具取回`
    );
  }
  if (tokens > budgetTokens) {
    log.warn(
      'agent 上下文压到底仍然超预算，本轮不再继续',
      `约 ${tokens} token，上限 ${budgetTokens}。已停下并如实报告，未丢弃用户的原始要求`
    );
  }
  return { messages, droppedCount, overBudget: tokens > budgetTokens, tokens };
}

/**
 * 保护窗口的起点下标：从后往前数到第 `rounds` 个 assistant 回复。
 *
 * 数 assistant 而不是数消息条数：一轮里可能有一个工具调用，也可能有五个，
 * 按条数切会把某一轮切成两半——留下几条无源的工具结果，模型看不出它们
 * 回答的是哪一次调用。
 */
function protectedIndex(turns: AgentMessage[], rounds: number): number {
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      seen += 1;
      if (seen >= rounds) {
        return i;
      }
    }
  }
  return 0;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

function tokensOf(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
}
