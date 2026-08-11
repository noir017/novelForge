/**
 * 各层的取数与注入。**装配器的每一段 P0/P1/P2 现在都是这里的一个函数。**
 *
 * 拆开的理由不是「文件太长」，而是：旧的 `buildContext` 把「带什么」和
 * 「怎么在预算里排队」焊死在一条直线上，于是四个阶段只能共用同一份装配。
 * 拆成「层（这里）× 配方（recipes.ts）」之后，细纲阶段不带正文原文这种事
 * 就是配方里少写一行，而不是在装配器里加一个 if。
 *
 * 每一层拿到的是同一个 [Assembly]：共享余额、共享明细数组。层与层之间
 * 只通过 `scratch` 传两件事（上一章结尾片段、已整章注入的序号），
 * 那是原来就有的两处跨段耦合，照搬过来，没有新增。
 */
import { estimateTokens, takeHead, takeTail } from './tokenizer';
import { BuildRequest, ContextItem, LayerId, LayerSpec } from './types';
import { buildSystemPrompt } from './prompts';
import { NovelProject, exists, readText } from '../model/project';
import { stringifySections } from '../model/markdown';
import { ChapterPlan, PLAN_SECTION_KEYS } from '../model/planFile';
import { SCENE_SECTION_KEYS, Scene, describeScene } from '../model/sceneFile';
import { CreationTarget, STAGE_ROLE, chapterOfTarget } from '../model/pipeline';
import { Attachment } from '../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
  NovelConfig,
} from '../model/types';

/** 历史里单条消息的上限，超出取结尾（越靠后越相关）。 */
const HISTORY_TURN_CAP_RATIO = 0.12;

// ---------------------------------------------------------------- 焦点

/**
 * 这一次装配围绕哪个产物转。
 *
 * 先一次性把要读的文件读齐，再交给各层——否则「本章细纲」会被
 * planSelf 读一遍、characters 为了取出场人物再读一遍。
 */
export interface Focus {
  target: CreationTarget;
  /** 目标章节。尚未落盘时为 undefined（正要写全书的下一章）。 */
  chapter?: Chapter;
  /** 「前文」的边界序号。全书大纲阶段为 +∞，即全书都算前文。 */
  order: number;
  previous: Chapter[];
  /** 目标章节的细纲。 */
  plan?: ChapterPlan;
  /** 上一章的细纲。 */
  prevPlan?: ChapterPlan;
  /** 目标章节的全部场景，按 no 升序。 */
  scenes: Scene[];
  /** 当前这一场。target 没指定场号时为 undefined。 */
  scene?: Scene;
  /** 场景 frontmatter 里写明的出场人物——角色卡据此精确取，不靠子串匹配。 */
  castNames: string[];
}

/**
 * 按配方**只读用得上的文件**。
 *
 * 正文阶段每生成一次就多读一份用不上的上一章细纲，看着不多，
 * 但它落在每一次生成的关键路径上。
 */
export async function resolveFocus(
  project: NovelProject,
  request: BuildRequest,
  recipe: LayerSpec[]
): Promise<Focus> {
  const wants = (id: LayerId): boolean => recipe.some((s) => s.layer === id);
  const target = request.target;
  const chapters = await project.listChapters();
  const chapterRelPath = chapterOfTarget(target);
  const chapter = chapterRelPath ? chapters.find((c) => c.relPath === chapterRelPath) : undefined;

  // 大纲阶段谈的是全书，没有「前文」边界；其余阶段以目标章节为界。
  // 章节还没落盘时退回调用方给的序号——「写第 4 章」时磁盘上只有 3 章是常态。
  const order =
    target.kind === 'outline'
      ? Number.POSITIVE_INFINITY
      : (chapter?.order ?? request.targetOrder ?? Number.POSITIVE_INFINITY);
  const previous = chapters.filter((c) => c.order < order);
  const prevChapter = previous[previous.length - 1];

  const plan = chapterRelPath && wants('planSelf') ? await project.readPlan(chapterRelPath) : undefined;
  const prevPlan = prevChapter && wants('planPrev') ? await project.readPlan(prevChapter.relPath) : undefined;
  const scenes =
    chapterRelPath && (wants('sceneSelf') || wants('sceneSiblings'))
      ? await project.listScenes(chapterRelPath)
      : [];

  const sceneNo = target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;
  const scene = sceneNo === undefined ? undefined : scenes.find((s) => s.no === sceneNo);

  return {
    target,
    chapter,
    order,
    previous,
    plan,
    prevPlan,
    scenes,
    scene,
    castNames: scene ? scene.characters : [],
  };
}

// ---------------------------------------------------------------- 装配上下文

/** 各层共享的可变状态。预算是一条流水线上的余额，层按配方顺序扣。 */
export interface Assembly {
  readonly project: NovelProject;
  readonly request: BuildRequest;
  readonly config: NovelConfig;
  readonly focus: Focus;
  readonly budget: number;
  /** 剩余预算。**层可以直接改它**——降级路径需要自己算完再扣。 */
  remaining: number;
  readonly items: ContextItem[];
  readonly excluded: ReadonlySet<string>;
  /** 常规注入：算 token、判余额、登记。放不下就记为 dropped。 */
  admit(item: Omit<ContextItem, 'tokens' | 'status'>, opts?: { force?: boolean }): ContextItem;
  /** 已自行算好 token 的条目（降级路径）：登记并扣余额。 */
  accept(item: Omit<ContextItem, 'tokens'>, tokens: number): void;
  /** 装不下 / 被排除：登记原因，不扣余额。**绝不静默丢弃。** */
  reject(item: Omit<ContextItem, 'tokens' | 'status'>, status: 'dropped' | 'excluded', note: string): void;
  /** 跨层协调的便签，只有两处用得上。 */
  scratch: { prevTail?: ContextItem; fullTextOrders: Set<number> };
}

export type LayerFn = (a: Assembly, spec: LayerSpec) => Promise<void>;

// ---------------------------------------------------------------- 层实现

export const LAYERS: Record<LayerId, LayerFn> = {
  // ------------------------------------------------------------ 系统提示
  async system(a, spec) {
    a.admit(
      {
        id: 'system',
        kind: 'system',
        priority: spec.priority,
        label: `系统提示 · ${STAGE_ROLE[a.request.action.stage]}`,
        text: buildSystemPrompt(a.request.action, a.config, a.request.targetWords),
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 用户这一轮说的话
  async ask(a, spec) {
    const { stage, capability } = a.request.action;
    const isDraftOrder = stage === 'manuscript' && (capability === 'generate' || capability === 'rewrite');
    a.admit(
      {
        id: 'ask',
        kind: 'ask',
        priority: spec.priority,
        label: isDraftOrder ? '本章剧情纲要' : '我的要求',
        text: a.request.ask.trim(),
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 用户 @ 的引用
  // 用户手动挂上来的东西优先级仅次于纲要——他既然特意点了，就不该被自动装配挤掉。
  // 但也不能无限制：单条超过预算的 cap 就从头部截断，并在 note 里说明。
  async attachments(a, spec) {
    const attachmentCap = Math.floor(a.budget * (spec.cap ?? 1));
    for (const att of a.request.attachments ?? []) {
      const id = `attachment:${att.id}`;
      const base = {
        id,
        kind: 'attachment' as const,
        priority: spec.priority,
        label: att.label,
        source: att.relPath,
      };
      if (a.excluded.has(id)) {
        a.admit({ ...base, text: '' });
        continue;
      }
      const body = await resolveAttachment(a.project, att);
      if (!body.trim()) {
        a.reject({ ...base, text: '' }, 'dropped', '内容为空或文件已不存在');
        continue;
      }

      const raw = `【引用 · ${att.label}】\n${body}`;
      const rawTokens = estimateTokens(raw);
      const cap = Math.min(attachmentCap, Math.max(0, a.remaining));
      if (rawTokens <= cap) {
        a.accept({ ...base, text: raw, status: 'included', note: ATTACHMENT_NOTE[att.kind] }, rawTokens);
        continue;
      }
      if (cap < 200) {
        a.reject(
          { ...base, text: '' },
          'dropped',
          `预算不足（需 ${rawTokens} token，剩 ${Math.max(0, a.remaining)}）`
        );
        continue;
      }
      const clipped = `【引用 · ${att.label}】\n${takeHead(body, cap - 40)}`;
      const clippedTokens = estimateTokens(clipped);
      a.accept(
        {
          ...base,
          text: clipped,
          status: 'degraded',
          note: `原文需 ${rawTokens} token，已截断至 ${clippedTokens}`,
        },
        clippedTokens
      );
    }
  },

  // ------------------------------------------------------------ 本会话历史对话
  // 历史整体封顶（配方给的 cap）：一段长对话不该把文风指南和前文正文全挤出去。
  // 由近及远填充——最近几轮才是模型真正需要接住的语境。
  async history(a, spec) {
    const history = a.request.history ?? [];
    if (history.length === 0) {
      return;
    }
    const historyCap = Math.floor(a.budget * (spec.cap ?? 1));
    const turnCap = Math.floor(a.budget * HISTORY_TURN_CAP_RATIO);
    let historyRemaining = Math.min(historyCap, Math.max(0, a.remaining));

    // 先从最新往回收，最后再按时间正序还原。
    const kept: ContextItem[] = [];
    const skipped: ContextItem[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      const id = `history:${turn.id}`;
      const base = {
        id,
        kind: 'history' as const,
        priority: spec.priority,
        label: `${turn.role === 'user' ? '我' : '模型'} · 第 ${i + 1} 轮`,
      };

      if (a.excluded.has(id) || !turn.content.trim()) {
        skipped.push({
          ...base,
          text: '',
          tokens: 0,
          status: a.excluded.has(id) ? 'excluded' : 'dropped',
          note: a.excluded.has(id) ? '已被手动排除' : '空消息',
        });
        continue;
      }

      // 单轮过长时取结尾：一段长草稿里，越靠后越接近当前进度。
      const content = takeTail(turn.content, turnCap);
      const tokens = estimateTokens(content);
      if (tokens > historyRemaining) {
        skipped.push({
          ...base,
          text: '',
          tokens: 0,
          status: 'dropped',
          note: '历史对话预算已满，更早的轮次不再注入',
        });
        continue;
      }
      historyRemaining -= tokens;
      a.remaining -= tokens;
      kept.push({
        ...base,
        text: content,
        tokens,
        status: content.length < turn.content.length ? 'degraded' : 'included',
        note: content.length < turn.content.length ? '过长，仅注入结尾部分' : undefined,
      });
    }
    // 明细按时间正序展示，读起来才是一段对话。
    a.items.push(...kept.reverse(), ...skipped.reverse());
  },

  // ------------------------------------------------------------ 全书大纲原文
  async outlineDoc(a, spec) {
    const outline = await a.project.readOutline();
    if (!outline.trim() || isPlaceholder(outline)) {
      return;
    }
    a.admit(
      {
        id: 'outlineDoc',
        kind: 'outlineDoc',
        priority: spec.priority,
        label: '全书大纲',
        source: a.project.relPath(a.project.outlinePath),
        text: outline,
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 本章细纲
  async planSelf(a, spec) {
    const plan = a.focus.plan;
    if (!plan) {
      return;
    }
    a.admit(
      {
        id: `plan:${plan.chapterRelPath}`,
        kind: 'plan',
        priority: spec.priority,
        label: `${chapterLabel(a.focus.chapter, plan)} · 细纲`,
        source: plan.relPath,
        text: renderPlan(plan),
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 上一章细纲
  // 写这一章的细纲时，「上一章是怎么收的」比「上一章的正文长什么样」有用得多，
  // 也便宜得多——这正是细纲阶段不带正文原文还不丢信息的原因。
  async planPrev(a, spec) {
    const plan = a.focus.prevPlan;
    if (!plan) {
      return;
    }
    const prev = a.focus.previous[a.focus.previous.length - 1];
    a.admit(
      {
        id: `plan:${plan.chapterRelPath}`,
        kind: 'plan',
        priority: spec.priority,
        label: `${chapterLabel(prev, plan)} · 细纲`,
        source: plan.relPath,
        text: renderPlan(plan),
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 本场场景卡
  async sceneSelf(a, spec) {
    const scene = a.focus.scene;
    if (!scene) {
      return;
    }
    a.admit(
      {
        id: `scene:${scene.relPath}`,
        kind: 'scene',
        priority: spec.priority,
        label: `场景 ${describeScene(scene)}`,
        source: scene.relPath,
        text: renderScene(scene),
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 前后两场
  // 「前置条件」与「不能发生」都是相对邻居才成立的：这一场能不能直接开打，
  // 取决于上一场结束时人在哪；这一场不能泄露什么，取决于下一场要抖什么包袱。
  // 没指定场号时（在场景阶段泛泛地讨论），给全章的场景一览。
  async sceneSiblings(a, spec) {
    const self = a.focus.scene;
    const siblings = self
      ? a.focus.scenes.filter((s) => s.no === self.no - 1 || s.no === self.no + 1)
      : a.focus.scenes;
    for (const scene of siblings) {
      const relation = !self ? '' : scene.no < self.no ? '（上一场）' : '（下一场）';
      a.admit({
        id: `scene:${scene.relPath}`,
        kind: 'scene',
        priority: spec.priority,
        label: `场景 ${describeScene(scene)}${relation}`,
        source: scene.relPath,
        text: renderSceneBrief(scene, relation),
      });
    }
  },

  // ------------------------------------------------------------ 文风指南
  async style(a, spec) {
    const style = await a.project.readStyleGuide();
    if (!style.trim()) {
      return;
    }
    a.admit(
      {
        id: 'style',
        kind: 'style',
        priority: spec.priority,
        label: '文风指南',
        source: a.project.relPath(a.project.stylePath),
        text: style,
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 全书滚动摘要
  async globalSummary(a, spec) {
    const globalSummary = await a.project.readGlobalSummary();
    if (!globalSummary.trim() || isPlaceholder(globalSummary)) {
      return;
    }
    a.admit(
      {
        id: 'globalSummary',
        kind: 'globalSummary',
        priority: spec.priority,
        label: '全书滚动摘要',
        source: a.project.relPath(a.project.globalSummaryPath),
        text: globalSummary,
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 相关角色卡
  async characters(a, spec) {
    const all = await a.project.listCharacters();
    const relevant = await selectCharacters(a.project, all, a.request.ask, a.focus);
    for (const { card, reason } of relevant) {
      const id = `character:${card.slug}`;
      const base = {
        id,
        kind: 'character' as const,
        priority: spec.priority,
        label: `角色 · ${card.name}`,
        source: card.relPath,
      };
      if (a.excluded.has(id)) {
        a.admit({ ...base, text: '' });
        continue;
      }
      const fullText = renderCharacter(card, false);
      const fullTokens = estimateTokens(fullText);
      if (fullTokens <= a.remaining) {
        a.admit({ ...base, text: fullText, note: reason });
        continue;
      }
      // 降级：只保留身份 / 当前状态 / 未收伏笔
      const essential = renderCharacter(card, true);
      const essentialTokens = estimateTokens(essential);
      if (essentialTokens <= a.remaining) {
        a.accept(
          {
            ...base,
            text: essential,
            status: 'degraded',
            note: `${reason}；预算不足，仅保留身份/当前状态/未收伏笔`,
          },
          essentialTokens
        );
      } else {
        a.reject({ ...base, text: '' }, 'dropped', `${reason}；预算不足`);
      }
    }
  },

  // ------------------------------------------------------------ 相关设定条目
  // 关键词在「用户这句话 + 本层产物」里找。只看用户那一句的话，
  // 写场景时明明地点就是青崖镇，设定却因为他没打这三个字而不注入。
  async lore(a, spec) {
    const haystack = [a.request.ask, focusText(a.focus)].join('\n');
    const lore = await a.project.listLore();
    for (const entry of lore) {
      const hit = matchesKeywords(haystack, [entry.title, ...entry.keywords]);
      if (!hit) {
        continue;
      }
      a.admit({
        id: `lore:${entry.slug}`,
        kind: 'lore',
        priority: spec.priority,
        label: `设定 · ${entry.title}`,
        source: entry.relPath,
        text: `【${entry.title}】\n${entry.body}`,
        note: `上下文中出现「${hit}」`,
      });
    }
  },

  // ------------------------------------------------------------ 上一章结尾原文
  async prevTail(a, spec) {
    const prevChapter = a.focus.previous[a.focus.previous.length - 1];
    if (!prevChapter || a.config.prevChapterTailChars <= 0) {
      return;
    }
    const full = await a.project.readChapterText(prevChapter);
    a.scratch.prevTail = a.admit(
      {
        id: `prevTail:${prevChapter.order}`,
        kind: 'prevTail',
        priority: spec.priority,
        label: `第 ${prevChapter.order} 章《${prevChapter.title}》· 结尾原文`,
        source: prevChapter.relPath,
        text: tailByChars(full, a.config.prevChapterTailChars),
        note: '原文注入，保证语气与场景衔接',
      },
      { force: spec.force }
    );
  },

  // ------------------------------------------------------------ 最近 N 章完整原文
  async chapterFull(a, spec) {
    const previous = a.focus.previous;
    const prevChapter = previous[previous.length - 1];
    const fullTextCount = Math.max(0, a.config.recentChaptersFullText);
    const fullTextChapters = previous.slice(-fullTextCount);
    for (const c of fullTextChapters) {
      a.scratch.fullTextOrders.add(c.order);
    }

    for (const chapter of [...fullTextChapters].reverse()) {
      const id = `chapterFull:${chapter.order}`;
      const base = {
        id,
        kind: 'chapterFull' as const,
        priority: spec.priority,
        label: `第 ${chapter.order} 章《${chapter.title}》· 原文`,
        source: chapter.relPath,
      };
      if (a.excluded.has(id)) {
        a.admit({ ...base, text: '' });
        continue;
      }

      const text = await a.project.readChapterText(chapter);
      const block = `【第${chapter.order}章 ${chapter.title}】\n${text}`;
      const tokens = estimateTokens(block);

      // 上一章的结尾片段已经注入过。若整章原文能完整放下，就把那份撤掉，
      // 避免同一段文字在 prompt 里出现两次（既浪费预算，也容易让模型复读）。
      const tail = a.scratch.prevTail;
      if (tail && chapter.order === prevChapter?.order && tail.status === 'included') {
        if (tokens - tail.tokens <= a.remaining) {
          a.remaining += tail.tokens - tokens;
          tail.status = 'dropped';
          tail.note = '整章原文已完整注入，无需重复结尾片段';
          tail.tokens = 0;
          tail.text = '';
          a.items.push({
            ...base,
            text: block,
            tokens,
            status: 'included',
            note: '含上一章结尾，续写将从此处接续',
          });
          continue;
        }
      }

      if (tokens <= a.remaining) {
        a.accept({ ...base, text: block, status: 'included' }, tokens);
        continue;
      }

      // 降级链：原文 → 该章摘要 → 省略
      const summary = await a.project.readSummary(chapter);
      if (summary?.content.trim()) {
        const summaryBlock = `【第${chapter.order}章 ${chapter.title} · 摘要】\n${summary.content}`;
        const summaryTokens = estimateTokens(summaryBlock);
        if (summaryTokens <= a.remaining) {
          a.accept(
            {
              ...base,
              source: summary.relPath,
              text: summaryBlock,
              status: 'degraded',
              note: `原文需 ${tokens} token 放不下，已降级为摘要`,
            },
            summaryTokens
          );
          continue;
        }
      }
      a.reject(
        { ...base, text: '' },
        'dropped',
        summary ? '原文与摘要都放不下' : `原文需 ${tokens} token 放不下，且该章尚无摘要`
      );
    }
  },

  // ------------------------------------------------------------ 中距离章节摘要
  async chapterSummary(a, spec) {
    // 由近及远填充：预算见底时丢的是最早的章节，那也是最不相关的。
    const candidates = a.focus.previous.filter((c) => !a.scratch.fullTextOrders.has(c.order)).reverse();
    for (const chapter of candidates) {
      const id = `chapterSummary:${chapter.order}`;
      const base = {
        id,
        kind: 'chapterSummary' as const,
        priority: spec.priority,
        label: `第 ${chapter.order} 章《${chapter.title}》· 摘要`,
        source: chapter.relPath,
      };
      if (a.excluded.has(id)) {
        a.admit({ ...base, source: undefined, text: '' });
        continue;
      }
      const summary = await a.project.readSummary(chapter);
      if (!summary?.content.trim()) {
        a.reject({ ...base, text: '' }, 'dropped', '该章尚无摘要，运行「同步所有过期摘要」后可纳入');
        continue;
      }
      const block = `【第${chapter.order}章 ${chapter.title}】\n${summary.content}`;
      const tokens = estimateTokens(block);
      if (tokens > a.remaining) {
        a.reject({ ...base, source: summary.relPath, text: '' }, 'dropped', '预算已满，更早的章节不再注入');
        continue;
      }
      a.accept(
        {
          ...base,
          source: summary.relPath,
          text: block,
          status: 'included',
          note: summary.sourceHash !== chapter.contentHash ? '⚠ 该摘要已过期（正文有改动）' : undefined,
        },
        tokens
      );
    }
  },

  // ------------------------------------------------------------ 重写反馈
  async revision(a, spec) {
    const revision = a.request.revision;
    if (!revision) {
      return;
    }
    a.admit(
      {
        id: 'revision',
        kind: 'revision',
        priority: spec.priority,
        label: '上一版草稿与修改意见',
        text: `【上一版草稿】\n${takeTail(revision.previousDraft, 3000)}\n\n【修改意见】\n${revision.feedback.trim()}`,
      },
      { force: spec.force }
    );
  },
};

// ---------------------------------------------------------------- 渲染

function chapterLabel(chapter: Chapter | undefined, plan: ChapterPlan): string {
  const order = chapter?.order ?? plan.order;
  const title = chapter?.title || plan.title;
  return `第 ${order} 章${title ? `《${title}》` : ''}`;
}

function renderPlan(plan: ChapterPlan): string {
  const head = `【第${plan.order}章 ${plan.title} · 细纲${plan.arc ? ` ｜ ${plan.arc}` : ''}】`;
  const body = stringifySections(plan.sections as unknown as Record<string, string>, PLAN_SECTION_KEYS as readonly string[]);
  return `${head}\n${body || '（尚未填写）'}`;
}

function renderScene(scene: Scene): string {
  const head = `【场景 ${describeScene(scene)}】`;
  const who = scene.characters.length > 0 ? `\n在场人物：${scene.characters.join('、')}` : '';
  const words = scene.targetWords ? `\n目标篇幅：约 ${scene.targetWords} 字` : '';
  const body = stringifySections(
    scene.sections as unknown as Record<string, string>,
    SCENE_SECTION_KEYS as readonly string[]
  );
  return `${head}${who}${words}\n${body || '（尚未填写）'}`;
}

/**
 * 邻居场景的简写：只要「目的 / 必须发生 / 不能发生」。
 *
 * 邻居给的是约束，不是让模型照着写的稿子——把整张卡塞进去，
 * 五场戏就能把这一场自己的卡挤没。
 */
function renderSceneBrief(scene: Scene, relation: string): string {
  const lines = [`【场景 ${describeScene(scene)}${relation}】`];
  for (const key of ['目的', '必须发生', '不能发生'] as const) {
    const value = scene.sections[key]?.trim();
    if (value) {
      lines.push(`${key}：${value}`);
    }
  }
  return lines.join('\n');
}

/** 本层产物的文本，供设定关键词匹配。 */
function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.scene) {
    parts.push(focus.scene.place, focus.scene.time, focus.scene.characters.join('、'));
    parts.push(...Object.values(focus.scene.sections));
  }
  if (focus.plan) {
    parts.push(...Object.values(focus.plan.sections));
  }
  return parts.filter(Boolean).join('\n');
}

function renderCharacter(card: CharacterCard, essentialOnly: boolean): string {
  const keys = essentialOnly ? CHARACTER_ESSENTIAL_KEYS : CHARACTER_SECTION_KEYS;
  const header = card.aliases.length > 0 ? `【${card.name}（又称 ${card.aliases.join('、')}）】` : `【${card.name}】`;
  const body = stringifySections(card.sections as unknown as Record<string, string>, keys as readonly string[]);
  return `${header}\n${body || '（暂无设定）'}`;
}

/** 按字符数取结尾，并对齐到段落边界。 */
export function tailByChars(text: string, chars: number): string {
  if (text.length <= chars) {
    return text;
  }
  let slice = text.slice(-chars);
  const br = slice.indexOf('\n');
  if (br !== -1 && br < chars * 0.25) {
    slice = slice.slice(br + 1);
  }
  return `……（前略）\n\n${slice.trimStart()}`;
}

export function isPlaceholder(text: string): boolean {
  return /尚未生成|（待补充）/.test(text) && text.replace(/[#\s（）()]/g, '').length < 80;
}

// ---------------------------------------------------------------- 附件

const ATTACHMENT_NOTE: Record<Attachment['kind'], string> = {
  selection: '编辑器选中片段',
  file: '整文件引用',
  chapter: '章节原文引用',
  character: '角色卡引用',
  lore: '设定条目引用',
  summary: '摘要引用',
};

/**
 * 取附件正文。
 *
 * 选区带快照，直接用快照——用户当时选的是那个样子，之后文件改了
 * 不该让历史对话跟着变。整文件引用则每次读盘，取最新内容。
 */
async function resolveAttachment(project: NovelProject, att: Attachment): Promise<string> {
  if (att.text !== undefined) {
    return att.text;
  }
  if (!att.relPath) {
    return '';
  }
  const abs = project.pathOf(att.relPath);
  if (!(await exists(abs))) {
    return '';
  }
  try {
    return (await readText(abs)).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 角色筛选

interface CharacterHit {
  card: CharacterCard;
  reason: string;
}

/**
 * 角色卡筛选，按以下顺序取并集去重：
 *
 * 1. **场景卡里写明的在场人物**——这一条是最准的：frontmatter 明写了这一幕有谁，
 *    不必去用户那一句话里做子串匹配。主角在场却因为用户没打他的名字而漏掉，
 *    正是旧筛选最常见的失手方式。
 * 2. 用户这一轮提到姓名或别名的角色
 * 3. 最近两章出场的角色（依据摘要「出场人物」一节）
 * 4. 标签含「主角」的角色
 */
async function selectCharacters(
  project: NovelProject,
  cards: CharacterCard[],
  ask: string,
  focus: Focus
): Promise<CharacterHit[]> {
  const hits = new Map<string, CharacterHit>();

  for (const name of focus.castNames) {
    const needle = name.trim();
    if (!needle) {
      continue;
    }
    const card = cards.find((c) => c.name === needle || c.aliases.includes(needle));
    if (card && !hits.has(card.slug)) {
      hits.set(card.slug, { card, reason: '本场出场人物' });
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    const hit = matchesKeywords(ask, [card.name, ...card.aliases]);
    if (hit) {
      hits.set(card.slug, { card, reason: `纲要中出现「${hit}」` });
    }
  }

  for (const chapter of focus.previous.slice(-2)) {
    const summary = await project.readSummary(chapter);
    const cast = summary?.sections.出场人物 ?? '';
    if (!cast.trim()) {
      continue;
    }
    for (const card of cards) {
      if (hits.has(card.slug)) {
        continue;
      }
      if (matchesKeywords(cast, [card.name, ...card.aliases])) {
        hits.set(card.slug, { card, reason: `第 ${chapter.order} 章出场` });
      }
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    if (card.tags.some((t) => /主角|主要人物|main/i.test(t))) {
      hits.set(card.slug, { card, reason: '主角，始终注入' });
    }
  }

  return [...hits.values()];
}

/** 返回命中的关键词，未命中返回 undefined。 */
function matchesKeywords(text: string, keywords: string[]): string | undefined {
  const haystack = text.toLowerCase();
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (needle.length >= 2 && haystack.includes(needle)) {
      return kw.trim();
    }
  }
  return undefined;
}
