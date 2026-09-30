/**
 * 架构层的三份文档：小说配置 `config.md`、故事前提 `premise.md`、世界观 `world.md`。
 *
 * **纯函数、零 I/O**，与 plotFile.ts / chapterFile.ts 同类；路径在 model/project.ts，
 * 解析与渲染只在这里定义一次。
 *
 * ## 为什么要一层「架构」
 *
 * 从前没有前置设定：角色卡与设定条目都是写完正文之后从摘要里反推的，等于拿模型
 * 上一次的发挥去约束它下一次的发挥。第一章动笔时没有角色名单、没有世界规则、
 * 没有金手指的机制，人物和设定全靠边写边编。
 *
 * 现在的顺序是 **配置 → 前提 → 角色图谱 → 世界观 → 情节大纲**，每一步都吃上一步
 * 的产出（思路来自 AI-Novel-Writer，GPL-3.0，源自 AI_NovelGenerator）。角色图谱
 * 没有自己的文件，它就是 `characters/` 下那一组角色卡；这里只管另外三份。
 *
 * ## `config.md` 的两个硬性规模参数
 *
 * `totalChapters` 与 `wordsPerChapter` 是整条链的长度锚点：大纲按总章数算章号
 * 区间，细纲没写 `targetWords` 时正文按每章字数判「写够没有」。**两者都可以不写**
 * ——不写就没有这条锚点，状态机会如实退化（「有字就算写够」），不拿一个猜出来的
 * 数字骗人。
 *
 * ## 文风不在这里
 *
 * 文风的唯一出处是 `style.md`（D14）。配置里再写一份，作者就不知道该信哪一份。
 */
import {
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';

/** 有自己文件的三件。第四件「角色图谱」就是 `characters/` 目录。 */
export type SettingFileDoc = 'config' | 'premise' | 'world';

export const SETTING_FILE_DOCS: readonly SettingFileDoc[] = ['config', 'premise', 'world'];

/**
 * 小说配置的七节。顺序即「读它们的顺序」：先是作者的那句话，再是展开后的梗概，
 * 然后是世界、金手指、主角，最后是跨章的规则与参考。
 *
 * 「全局要求」只写**跨章**的规则（≤600 字、4–8 行），禁止逐章列大纲——那是
 * 大纲与细纲的活，写在这里会被每一章都读一遍。
 */
export const CONFIG_SECTION_KEYS = [
  '一句话',
  '核心梗概',
  '世界观要点',
  '金手指',
  '主角档案',
  '全局要求',
  '参考作品',
] as const;

/** 故事前提四节：一句话前提（当[身份]遭遇[事件]，必须[行动]否则[后果]）、冲突链、金手指定位、悬念骨架。 */
export const PREMISE_SECTION_KEYS = ['一句话前提', '核心冲突链', '金手指定位', '悬念骨架'] as const;

/** 世界观三节：规则与它的漏洞、阶层与资源、深层危机。 */
export const WORLD_SECTION_KEYS = ['规则与漏洞', '阶层与资源', '深层危机'] as const;

export const SETTING_SECTION_KEYS: Record<SettingFileDoc, readonly string[]> = {
  config: CONFIG_SECTION_KEYS,
  premise: PREMISE_SECTION_KEYS,
  world: WORLD_SECTION_KEYS,
};

/**
 * 判「填过没有」看哪几节——任意一节有内容就算。
 *
 * 配置只看「核心梗概」：只写了「一句话」的配置是作者刚把脑洞丢进来，还没展开，
 * 主按钮仍该是「生成小说配置」。前提看冲突链：那是它的主体，一句话前提只是标题。
 */
const FILLED_BY: Record<SettingFileDoc, readonly string[]> = {
  config: ['核心梗概'],
  premise: ['核心冲突链'],
  world: WORLD_SECTION_KEYS,
};

/** 文档标题行。渲染时写，解析时忽略（身份由路径决定）。 */
export const SETTING_DOC_HEADING: Record<SettingFileDoc, string> = {
  config: '小说配置',
  premise: '故事前提',
  world: '世界观',
};

// ---------------------------------------------------------------- 故事结构与视角

/**
 * 故事结构。大纲那一步按它算章号区间（三幕 20/55/25 等）。
 * 值是英文枚举（与 AI-Novel-Writer 的配置合同一致，便于移植提示词），界面显示中文。
 */
export const PLOT_STRUCTURES = [
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
] as const;

export type PlotStructure = (typeof PLOT_STRUCTURES)[number];

export const PLOT_STRUCTURE_LABEL: Record<PlotStructure, string> = {
  three_act: '三幕结构',
  heros_journey: '英雄之旅',
  save_the_cat: '节拍表',
  kishotenketsu: '起承转合',
  multi_thread: '多线叙事',
  freeform: '自由结构',
};

export const NARRATIVE_POVS = ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'] as const;

export type NarrativePov = (typeof NARRATIVE_POVS)[number];

export const NARRATIVE_POV_LABEL: Record<NarrativePov, string> = {
  third_limited: '第三人称限知',
  first_person: '第一人称',
  third_omniscient: '第三人称全知',
  multi_pov: '多视角',
};

/**
 * 枚举字段的容错取值：英文值、中文标签都认，认不出就是 undefined（不猜）。
 * 作者手改 frontmatter 时写「三幕结构」比写 `three_act` 自然得多。
 */
function pickEnum<T extends string>(raw: string, values: readonly T[], labels: Record<T, string>): T | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  const byValue = values.find((v) => v === s.toLowerCase());
  if (byValue) {
    return byValue;
  }
  return values.find((v) => labels[v] === s);
}

// ---------------------------------------------------------------- 小说配置

export type ConfigSectionKey = (typeof CONFIG_SECTION_KEYS)[number];

export interface BookConfig {
  relPath: string;
  /** 类型（玄幻 / 都市 / 悬疑……）。自由文本。 */
  genre: string;
  subGenre: string;
  /** 目标读者（男频 / 女频 / 出版……）。自由文本。 */
  audience: string;
  structure?: PlotStructure;
  pov?: NarrativePov;
  /** 全书计划多少章。大纲按它算章号区间。 */
  totalChapters?: number;
  /** 每章目标字数。细纲没写 `targetWords` 时正文按它判写够没有。 */
  wordsPerChapter?: number;
  sections: Record<ConfigSectionKey, string>;
  /** frontmatter 之外的正文全文。作者可能加了自定义小节，读回来时保留。 */
  body: string;
}

export type WritableBookConfig = Omit<BookConfig, 'relPath' | 'body'>;

/** 只接受正整数；`0`、负数、小数、`三千` 一律当没写。 */
function positiveInt(v: string | string[] | undefined): number | undefined {
  const n = asNumber(v);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * 按小节表抽取，**占位文字读回来就是空串**。
 *
 * 渲染时空小节写成 `（待补充）`（作者手改时知道该往哪填），读回来要认得它：
 * 不然这行字会被当成内容一路送进 prompt，模型读到的是「金手指：（待补充）」。
 */
function pickFilled<K extends string>(body: string, keys: readonly K[]): Record<K, string> {
  const raw = pickSections<K>(body, keys);
  for (const key of keys) {
    if (!hasContent(raw[key])) {
      raw[key] = '';
    }
  }
  return raw;
}

/** 解析 `config.md`。**绝不抛**：frontmatter 写坏只让对应字段退化成缺席。 */
export function parseBookConfig(text: string, relPath: string): BookConfig {
  const { frontmatter, body } = parseMarkdown(text);
  return {
    relPath,
    genre: asString(frontmatter.genre).trim(),
    subGenre: asString(frontmatter.subGenre).trim(),
    audience: asString(frontmatter.audience).trim(),
    structure: pickEnum(asString(frontmatter.structure), PLOT_STRUCTURES, PLOT_STRUCTURE_LABEL),
    pov: pickEnum(asString(frontmatter.pov), NARRATIVE_POVS, NARRATIVE_POV_LABEL),
    totalChapters: positiveInt(frontmatter.totalChapters),
    wordsPerChapter: positiveInt(frontmatter.wordsPerChapter),
    sections: pickFilled<ConfigSectionKey>(body, CONFIG_SECTION_KEYS),
    body,
  };
}

/**
 * 渲染成落盘的 Markdown。空小节保留占位，作者手改时知道该往哪填。
 *
 * 字符串字段是空串时**也写出这一行**（`genre: `）：这份文件是给人填的表，
 * 空着的键正好告诉作者「这里可以写」。数字与枚举缺席就不写。
 */
export function renderBookConfig(config: WritableBookConfig): string {
  const fm = stringifyFrontmatter({
    genre: config.genre,
    subGenre: config.subGenre,
    audience: config.audience,
    structure: config.structure,
    pov: config.pov,
    totalChapters: config.totalChapters,
    wordsPerChapter: config.wordsPerChapter,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(config.sections, CONFIG_SECTION_KEYS, { keepEmpty: true });
  return `${fm}\n\n# ${SETTING_DOC_HEADING.config}\n\n${body}\n`;
}

// ---------------------------------------------------------------- 前提 / 世界观

export interface SettingDocFile {
  doc: SettingFileDoc;
  relPath: string;
  sections: Record<string, string>;
  body: string;
}

/**
 * 解析任意一份架构文档，按它自己的小节表抽取。**绝不抛**。
 *
 * 配置也能走这条路（只取小节，不管 frontmatter）——判「填过没有」时用得上。
 */
export function parseSettingDoc(doc: SettingFileDoc, text: string, relPath: string): SettingDocFile {
  const { body } = parseMarkdown(text);
  return { doc, relPath, sections: pickFilled(body, SETTING_SECTION_KEYS[doc]), body };
}

/** 渲染前提或世界观。配置有 frontmatter 字段，走 {@link renderBookConfig}。 */
export function renderSettingDoc(doc: Exclude<SettingFileDoc, 'config'>, sections: Record<string, string>): string {
  const fm = stringifyFrontmatter({ generatedBy: 'novel-forge' });
  const body = stringifySections(sections, SETTING_SECTION_KEYS[doc], { keepEmpty: true });
  return `${fm}\n\n# ${SETTING_DOC_HEADING[doc]}\n\n${body}\n`;
}

/** 这份文档填过没有。判据见 `FILLED_BY`；占位文字不算内容。 */
export function isSettingFilled(doc: SettingFileDoc, sections: Record<string, string>): boolean {
  return FILLED_BY[doc].some((key) => hasContent(sections[key]));
}

/** 初始化工程时写入的空模板：结构完整、全是占位，`isSettingFilled` 为 false。 */
export function settingTemplate(doc: SettingFileDoc): string {
  if (doc === 'config') {
    return renderBookConfig({
      genre: '',
      subGenre: '',
      audience: '',
      sections: Object.fromEntries(CONFIG_SECTION_KEYS.map((k) => [k, ''])) as Record<ConfigSectionKey, string>,
    });
  }
  return renderSettingDoc(doc, {});
}
