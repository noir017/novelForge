/**
 * 小说配置的生成结果：JSON 合同 → `config.md` 的七节与 frontmatter，外加一段给
 * `style.md` 的文风。
 *
 * **纯函数、绝不抛**。合同、「全局要求」质检与「保留作者原文」的合并规则移植自
 * AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 * `commands/architecture.command.ts` 的 `buildNovelConfigJSONContract` /
 * `decodeCompleteNovelConfig`，以及 `novel-config-expansion.ts`。
 *
 * ## 模型面向的键沿用上游的英文名
 *
 * `coreOutline`、`goldenFinger` 这些键是上游调过的提示词的一部分，换成中文键就得
 * 重新试错一遍。解码时映射到 `config.md` 的七节；「一句话」一节不让模型写——
 * 它就是作者的原话。
 *
 * ## 比上游宽松
 *
 * 上游缺任何一个字段、枚举写错一个都整份作废。这里缺的字段记进 `missing`、认不出的
 * 枚举丢掉并记一条 warning，其余照收：配置是一次一份、摊在落盘卡片上的产物，
 * 作者看得见缺了什么，手补一节比再花一轮钱便宜。
 */
import { hasContent } from '../model/markdown';
import {
  BookConfig,
  CONFIG_SECTION_KEYS,
  GUIDANCE_MAX_CHARS,
  GUIDANCE_MAX_RULES,
  GUIDANCE_MIN_RULES,
  ConfigSectionKey,
  NARRATIVE_POVS,
  NarrativePov,
  PLOT_STRUCTURES,
  PlotStructure,
  WritableBookConfig,
  renderBookConfig,
} from '../model/settingFile';
import { parseJson, singleJsonObject } from './structuredJson';
import { toSectionText } from './summarize';

export { GUIDANCE_MAX_CHARS, GUIDANCE_MAX_RULES, GUIDANCE_MIN_RULES };

/** 「第 3 章」「第 1–20 章」「Chapter 5」开头的一行——那是在逐章列大纲。 */
const CHAPTER_OUTLINE_LINE =
  /^(?:[-*+]\s*|\d+[.)、]\s*)?(?:第\s*[0-9一二三四五六七八九十百零〇两]+\s*(?:[-–—~～至到]\s*[0-9一二三四五六七八九十百零〇两]+\s*)?章|chapters?\s+\d+(?:\s*[-–—~]\s*\d+)?)/iu;

function guidanceRules(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** 「全局要求」哪里不合格；合格返回 undefined。 */
export function guidanceProblem(text: string): string | undefined {
  const rules = guidanceRules(text);
  const length = Array.from(text.trim()).length;
  const chapterLines = rules.filter((l) => CHAPTER_OUTLINE_LINE.test(l)).length;
  if (length > GUIDANCE_MAX_CHARS) {
    return `全局要求有 ${length} 字，超过 ${GUIDANCE_MAX_CHARS} 字`;
  }
  if (rules.length < GUIDANCE_MIN_RULES || rules.length > GUIDANCE_MAX_RULES) {
    return `全局要求有 ${rules.length} 条，合同要求 ${GUIDANCE_MIN_RULES}–${GUIDANCE_MAX_RULES} 条`;
  }
  if (chapterLines >= 2) {
    return '全局要求在逐章列大纲';
  }
  return undefined;
}

export function isGuidanceValid(text: string): boolean {
  return guidanceProblem(text) === undefined;
}

/** 模型那边的键 → `config.md` 的小节。 */
const SECTION_OF: Record<string, Exclude<ConfigSectionKey, '一句话'>> = {
  coreOutline: '核心梗概',
  worldSetting: '世界观要点',
  goldenFinger: '金手指',
  protagonistProfile: '主角档案',
  globalGuidance: '全局要求',
  referenceWorks: '参考作品',
};

/** 上游合同里必填的九个文本字段（`REQUIRED_CONFIG_TEXT_FIELDS`）。缺了记进 `missing`。 */
const REQUIRED = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const;

/** 模型产出的那一份，还没和磁盘上的合并。 */
export interface GeneratedConfig {
  genre?: string;
  subGenre?: string;
  audience?: string;
  structure?: PlotStructure;
  pov?: NarrativePov;
  totalChapters?: number;
  wordsPerChapter?: number;
  sections: Partial<Record<ConfigSectionKey, string>>;
  /** 给 `style.md` 的文风。不进 `config.md`（D14）。 */
  writingStyle?: string;
}

export type ConfigDecode =
  | { ok: true; value: GeneratedConfig; missing: string[]; warnings: string[] }
  | { ok: false; reason: string };

function pickEnum<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return values.find((x) => x === s);
}

function positive(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * 解码模型给的配置 JSON。中文键（`核心梗概`）也认：模型偶尔会照着工程里的文件写。
 * 整段不是 JSON 对象才算失败。
 */
export function decodeNovelConfig(text: string): ConfigDecode {
  const whole = parseJson(text);
  let obj: Record<string, unknown> | undefined =
    whole && typeof whole === 'object' && !Array.isArray(whole) ? (whole as Record<string, unknown>) : undefined;
  if (!obj) {
    const single = singleJsonObject(text);
    if (!single.ok) {
      return { ok: false, reason: single.reason === 'truncated' ? '配置 JSON 没有写完' : '输出不是一个 JSON 对象' };
    }
    obj = single.value;
  }

  const warnings: string[] = [];
  const sections: GeneratedConfig['sections'] = {};
  for (const [key, section] of Object.entries(SECTION_OF)) {
    const value = toSectionText(obj[key] ?? obj[section]);
    if (value) {
      sections[section] = value;
    }
  }
  const text2 = (key: string, alias: string) => {
    const v = obj![key] ?? obj![alias];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const structure = pickEnum<PlotStructure>(obj.plotStructure ?? obj.structure, PLOT_STRUCTURES);
  const pov = pickEnum<NarrativePov>(obj.narrativePOV ?? obj.pov, NARRATIVE_POVS);
  if ((obj.plotStructure ?? obj.structure) !== undefined && !structure) {
    warnings.push(`故事结构「${String(obj.plotStructure ?? obj.structure)}」不在六种结构里，没有采用`);
  }
  if ((obj.narrativePOV ?? obj.pov) !== undefined && !pov) {
    warnings.push(`叙事视角「${String(obj.narrativePOV ?? obj.pov)}」认不出，没有采用`);
  }

  const value: GeneratedConfig = {
    genre: text2('genre', '类型'),
    subGenre: text2('subGenre', '子类型'),
    audience: text2('targetAudience', 'audience'),
    structure,
    pov,
    totalChapters: positive(obj.totalChapters),
    wordsPerChapter: positive(obj.wordsPerChapter),
    sections,
    writingStyle: toSectionText(obj.writingStyle ?? obj.文风) || undefined,
  };

  const present: Record<(typeof REQUIRED)[number], boolean> = {
    genre: !!value.genre,
    targetAudience: !!value.audience,
    subGenre: !!value.subGenre,
    coreOutline: !!sections.核心梗概,
    worldSetting: !!sections.世界观要点,
    goldenFinger: !!sections.金手指,
    protagonistProfile: !!sections.主角档案,
    globalGuidance: !!sections.全局要求,
    writingStyle: !!value.writingStyle,
  };
  const missing = REQUIRED.filter((k) => !present[k]);
  return { ok: true, value, missing, warnings };
}

/**
 * 作者写过的长文本保留原文、生成的追加在后；生成的已经包含原文就用生成的
 * （上游 `preserveAuthorText`）。
 */
export function preserveAuthorText(existing: string | undefined, generated: string | undefined): string {
  const author = existing?.trim() ?? '';
  const fresh = generated?.trim() ?? '';
  if (!author) {
    return fresh;
  }
  if (!fresh || fresh.includes(author)) {
    return fresh || author;
  }
  return `${author}\n\n${fresh}`;
}

export interface MergeOptions {
  /** 作者这一次给的那句话（一句话弹窗里的脑洞）。 */
  idea?: string;
  /** 作者定的规模。给了就以它为准——总章数与每章字数是作者的权威设置，模型改不得。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /**
   * 「保留原文，追加生成」：从一句话弹窗发起、而 `config.md` 已经写过东西时开。
   * 关着的时候（作者在对话里说「重写金手指」）生成的那一份就是修改后的版本，
   * 只有它漏掉的小节才沿用磁盘那份。
   */
  preserve: boolean;
}

/** 生成结果并进磁盘上那份，得到将要落盘的配置（上游 `mergeExpandedNovelConfig` 的规则）。 */
export function mergeWithAuthor(existing: BookConfig, generated: GeneratedConfig, opts: MergeOptions): WritableBookConfig {
  const sections = { ...existing.sections };
  for (const key of CONFIG_SECTION_KEYS) {
    const fresh = key === '一句话' ? opts.idea?.trim() : generated.sections[key];
    const old = hasContent(existing.sections[key]) ? existing.sections[key] : '';
    sections[key] = opts.preserve ? preserveAuthorText(old, fresh) : fresh?.trim() || old;
  }
  // 作者选过的类型 / 受众 / 结构 / 视角：保留原文时一律不改；否则生成的优先。
  const choose = <T>(author: T | undefined, model: T | undefined): T | undefined =>
    opts.preserve ? (author || model) : (model || author);
  return {
    genre: choose(existing.genre, generated.genre) ?? '',
    subGenre: choose(existing.subGenre, generated.subGenre) ?? '',
    audience: choose(existing.audience, generated.audience) ?? '',
    structure: choose(existing.structure, generated.structure),
    pov: choose(existing.pov, generated.pov),
    totalChapters: opts.setup?.totalChapters ?? existing.totalChapters ?? generated.totalChapters,
    wordsPerChapter: opts.setup?.wordsPerChapter ?? existing.wordsPerChapter ?? generated.wordsPerChapter,
    sections,
  };
}

/** 草稿里那一节文风的标题。落盘时它不进 `config.md`，只在 `style.md` 空着时写过去。 */
export const STYLE_DRAFT_HEADING = '文风';

/**
 * 规范化输出：将要落盘的 `config.md` 全文，后面接一节「文风」。
 *
 * 气泡里看到的就是会写下去的那一份；作者改完再点写入，采纳时按 `config.md` 的格式
 * 重新解析（artifact.ts）。
 */
export function renderConfigDraft(config: WritableBookConfig, style?: string): string {
  const doc = renderBookConfig(config).trimEnd();
  return style?.trim() ? `${doc}\n\n## ${STYLE_DRAFT_HEADING}\n\n${style.trim()}\n` : `${doc}\n`;
}
