/**
 * 章节细纲文件（`.novelforge/plans/<镜像章节路径>.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts / markdown.ts 同类；路径规则与读写在
 * model/project.ts，解析与渲染只在这里定义一次。
 *
 * 细纲回答的是「这一章具体怎么发生」——它不是正文，是导演分镜 + 剧情施工图。
 * 大纲说「林昭进入青云宗」，细纲说清目标、开头、结尾、冲突强度与节奏、
 * 这一章埋什么收什么。
 *
 * ## 为什么没有「场景一览」小节
 *
 * 场景列表是 `scenes/` 目录的派生数据。写进细纲文件就会漂移：作者删了一个
 * 场景文件，细纲里那一行还在，而界面上看不出哪份是真的。要看场景列表就现算
 * （core/pipeline.ts）。这与「摘要是出场人物的唯一真相、角色卡的 appearsIn
 * 只是缓存」是同一个取舍——只是这次连缓存都不落盘。
 */
import { asNumber, asString, parseMarkdown, pickSections, stringifyFrontmatter, stringifySections } from './markdown';

export const PLAN_SECTION_KEYS = ['本章目标', '开头', '结尾', '冲突与节奏', '伏笔与回收'] as const;

export type PlanSectionKey = (typeof PLAN_SECTION_KEYS)[number];

export type PlanSections = Record<PlanSectionKey, string>;

export interface ChapterPlan {
  /** 细纲文件的工作区相对路径。 */
  relPath: string;
  /** 归属章节的工作区相对路径。frontmatter 里存一份，便于作者手工核对。 */
  chapterRelPath: string;
  order: number;
  title: string;
  /** 所属幕/卷，如「第一幕 · 入局」。先用一个字段表达，暂不单开 arcs/ 层。 */
  arc: string;
  targetWords?: number;
  /**
   * 生成这份细纲时所依据的 `outline.md` 内容 hash。
   * 与当前大纲对不上 = 上游已变更，界面上标脏。零模型调用的「变更影响」。
   */
  upstreamHash: string;
  /** 作者手工宣布这一章过了（frontmatter `status: done`）。只允许向前覆盖推导值。 */
  done: boolean;
  sections: PlanSections;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

/** 写盘时需要的字段（relPath / body 由调用方与渲染决定）。 */
export type WritableChapterPlan = Omit<ChapterPlan, 'relPath' | 'body'>;

export function emptyPlanSections(): PlanSections {
  return { 本章目标: '', 开头: '', 结尾: '', 冲突与节奏: '', 伏笔与回收: '' };
}

/**
 * 细纲有没有实质内容。
 *
 * 判据是「本章目标」或「冲突与节奏」至少有一个非空——这两节是细纲之所以
 * 存在的理由。只有开头结尾而没有目标的细纲，等于什么都没规划，流水线状态
 * 该停在 `plan` 而不是往下走。占位文字（`（待补充）`）不算内容。
 */
export function isPlanFilled(sections: PlanSections): boolean {
  return meaningful(sections.本章目标) || meaningful(sections.冲突与节奏);
}

/**
 * 解析细纲文件。**绝不抛**：作者会手改，frontmatter 写坏、小节改名、
 * 整份文件被换成大白话都只该退化为「解析出来的少一点」。
 */
export function parsePlanFile(text: string, relPath: string): ChapterPlan {
  const { frontmatter, body } = parseMarkdown(text);
  const sections = pickSections<PlanSectionKey>(body, PLAN_SECTION_KEYS) as PlanSections;
  return {
    relPath,
    chapterRelPath: asString(frontmatter.chapter),
    order: asNumber(frontmatter.order) ?? 0,
    title: asString(frontmatter.title),
    arc: asString(frontmatter.arc),
    targetWords: asNumber(frontmatter.targetWords),
    upstreamHash: asString(frontmatter.upstreamHash),
    done: asString(frontmatter.status).toLowerCase() === 'done',
    sections,
    body,
  };
}

/** 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。 */
export function renderPlanFile(plan: WritableChapterPlan): string {
  const fm = stringifyFrontmatter({
    chapter: plan.chapterRelPath,
    order: plan.order,
    title: plan.title,
    arc: plan.arc || undefined,
    targetWords: plan.targetWords,
    upstreamHash: plan.upstreamHash || undefined,
    status: plan.done ? 'done' : undefined,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(plan.sections as unknown as Record<string, string>, PLAN_SECTION_KEYS, {
    keepEmpty: true,
  });
  const heading = plan.order > 0 ? `# 第${plan.order}章 ${plan.title} · 细纲` : `# ${plan.title || '细纲'}`;
  return `${fm}\n\n${heading}\n\n${body}\n`;
}

/** 占位文字与空白都不算内容。与 markdown.ts 的 SECTION_PLACEHOLDER 对齐。 */
function meaningful(text: string): boolean {
  const t = text.trim();
  return t !== '' && t !== '（待补充）' && t !== '(待补充)';
}
