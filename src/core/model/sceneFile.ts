/**
 * 场景文件（`.novelforge/scenes/<细纲名>/NN-标题.md`）的格式定义。
 *
 * **纯函数、零 I/O**，与 chapterFile.ts 同构：什么文件算场景、序号怎么来、
 * 怎么解析、怎么渲染，只在这里定义一次。
 *
 * 场景是「剧情 → 正文」之间缺的那一层。细纲说「林昭翻墙进入青云宗」，
 * 场景把它变成能直接下笔的东西：子时下着雨、青石墙泡胀了、巡逻的灯每隔一丈
 * 一盏、林昭赤脚踩上砖沿、墙那边两个弟子在说什么。到这一步才真正「可以写了」。
 *
 * ## 场景层产素材，不下约束
 *
 * 这一层**只提供正文可以直接用的材料**：环境、动作、对话、细节与意象。
 * 它不规定正文必须写到什么、不许写到什么——那种「这一幕一定要出现 A、绝不
 * 能出现 B」的清单曾经在这里，已经删掉，理由有两条：
 *
 * 1. **写小说不需要那么在乎逻辑严丝合缝。** 一张勾选表会压掉模型自己找到的
 *    好写法，换来一段逐条打钩、读着像施工验收的正文。
 * 2. **约束该在上一层。** 该发生什么、不该发生什么是**细纲**的事（这一章
 *    达成什么、埋什么收什么）。剧情已经定了走向，场景层的活是把那个走向
 *    落成可感的画面，不是把它重述一遍再加几条禁令。
 *
 * 所以这六节的写法是**具体、可感、能抄进正文**，而不是抽象的要求：
 * 「雨里只剩一团黄」是素材，「要营造压抑氛围」不是。
 *
 * 各节**都不是必填**：有些场就是一段过渡，环境与动作定了就能开写，硬逼作者
 * 填满六个格子只会让他去填废话。判「设计过没有」的规则见 {@link isSceneReady}。
 *
 * ## 序号规则
 *
 * 与章节同一套：**文件名的数字前缀决定顺序**（`02-翻越侧峰.md` 是第 2 场）。
 * 不发明第二套排序来源。区别只有一条：场景是插件自己的数据格式，因此
 * **只认 `.md`**——与角色卡 / 设定条目一致，与「章节不认扩展名」相反。
 * 章节要放宽是因为正文可能从别处导入；场景不存在这个问题。
 *
 * ## 场景的 characters 不进出场统计
 *
 * frontmatter 的 `characters` 是**计划出场**，摘要里的 `cast` 才是**实际出场**。
 * 把它混进 castIndex 会污染出场章节统计与角色卡语料（AGENTS.md 第 14 条：
 * 摘要是出场人物的唯一真相）。这条看起来很诱人——写在这里是为了别让人手滑。
 */
import * as path from 'node:path';
import {
  asArray,
  asNumber,
  asString,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';

/**
 * 六节素材。顺序即「写这一幕时读它们的顺序」：先知道为什么写（目的）、
 * 站在哪里（环境）、此刻各人什么状态，再看做什么、说什么、抓哪些细节。
 *
 * 「目的」是唯一一节**不是素材**的：它由拆场景那一步从细纲带过来，只用来
 * 定位这一幕在本章的位置。判 ready 时因此把它排除在外，见 {@link isSceneReady}。
 */
export const SCENE_SECTION_KEYS = ['目的', '环境', '人物状态', '动作', '对话', '细节与意象'] as const;

export type SceneSectionKey = (typeof SCENE_SECTION_KEYS)[number];

export type SceneSections = Record<SceneSectionKey, string>;

/**
 * 场景的写作状态。
 *
 * - `draft`：刚拆出来的壳，还没有素材
 * - `ready`：有素材了，可以写正文了
 * - `written`：正文已采纳写入章节
 *
 * 只有 `written` 是需要落盘的——前两个能由 {@link isSceneReady} 推出来，但
 * 落一份显式的状态让作者能手工把某一场标回 draft 重做，成本只有一行。
 */
export type SceneStatus = 'draft' | 'ready' | 'written';

export interface Scene {
  /** 场景文件的工作区相对路径。 */
  relPath: string;
  /** 归属细纲的工作区相对路径。 */
  plotRelPath: string;
  /** 场景号，来自文件名数字前缀。 */
  no: number;
  title: string;
  place: string;
  time: string;
  /** 计划出场人物。**不进 castIndex**，理由见文件头。 */
  characters: string[];
  targetWords?: number;
  /**
   * 生成这一场时所依据的**本章细纲**内容 hash。
   * 对不上 = 剧情改过，这一场的前置条件可能已经失效，界面上标脏。
   */
  upstreamHash: string;
  status: SceneStatus;
  sections: SceneSections;
  /** frontmatter 之外的正文全文，保留作者的自定义小节。 */
  body: string;
}

export type WritableScene = Omit<Scene, 'relPath' | 'body'>;

export interface SceneFileName {
  no: number;
  /** 去掉序号前缀与扩展名后的词干，可能为空（如 `02.md`）。 */
  stem: string;
}

/** 场景文件只认 markdown 家族。 */
const SCENE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 文件名 → 场景号与词干。不是 `.md`、或没有数字前缀，返回 undefined。
 *
 * 与 parseChapterFileName 一样**先剥扩展名再匹配前缀**：分隔符集合里含 `.`，
 * 直接对整个文件名跑正则的话 `02.md` 会被吃成「场景 02 + 词干 md」。
 */
export function parseSceneFileName(fileName: string): SceneFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (!SCENE_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = fileName.slice(0, fileName.length - ext.length);
  const m = /^(\d{1,3})[-_.\s]*(.*)$/.exec(base);
  if (!m) {
    return undefined;
  }
  const no = Number(m[1]);
  // 0 号场景没有意义，且会让「第 N 场」的文案错位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isSceneFileName(fileName: string): boolean {
  return parseSceneFileName(fileName) !== undefined;
}

/**
 * 场景号 + 标题 → 文件名。两位数前缀，与章节的三位数区分开——
 * 一章几十场已经很夸张，`01-` 读起来比 `001-` 更像「这一章里的第几场」。
 *
 * `sanitize` 由调用方（project.ts 的 sanitizeFileName）负责；这里只管拼，
 * 保持零 I/O 与零跨层依赖。
 */
export function sceneFileName(no: number, safeTitle: string): string {
  const prefix = String(Math.max(1, Math.trunc(no))).padStart(2, '0');
  return safeTitle ? `${prefix}-${safeTitle}.md` : `${prefix}.md`;
}

export function emptySceneSections(): SceneSections {
  return { 目的: '', 环境: '', 人物状态: '', 动作: '', 对话: '', 细节与意象: '' };
}

/**
 * 这一场有没有素材可写了。
 *
 * 判据是**除「目的」以外任意一节有内容**。不看「目的」是因为拆场景那一步
 * 就把细纲里的一句话填进去了，每一场一出生就带着它——拿它当判据的话，
 * 刚拆出来的空壳会全部立刻显示「可以写了」，进度条从此撒谎。
 *
 * 反过来也不指定某一节必填：有些场只需要环境与动作，有些场几乎全是对话。
 * 有任意一节素材就够正文层开工了。
 */
export function isSceneReady(sections: SceneSections): boolean {
  return SCENE_SECTION_KEYS.some((key) => key !== '目的' && meaningful(sections[key]));
}

/**
 * 解析场景文件。**绝不抛**。
 *
 * `no` 以文件名为准而不是 frontmatter 的 `scene`：文件名是身份（作者重排
 * 场景顺序的方式就是改文件名前缀），frontmatter 里那份只是给人看的。
 * 两者不一致时以文件名为准，与「章节顺序永远由文件名前缀决定」同源。
 */
export function parseSceneFile(text: string, relPath: string): Scene {
  const { frontmatter, body } = parseMarkdown(text);
  const sections = pickSections<SceneSectionKey>(body, SCENE_SECTION_KEYS) as SceneSections;
  const fromName = parseSceneFileName(path.basename(relPath));
  const status = asString(frontmatter.status).toLowerCase();
  return {
    relPath,
    plotRelPath: asString(frontmatter.plot),
    no: fromName?.no ?? asNumber(frontmatter.scene) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    place: asString(frontmatter.place),
    time: asString(frontmatter.time),
    characters: asArray(frontmatter.characters),
    targetWords: asNumber(frontmatter.targetWords),
    upstreamHash: asString(frontmatter.upstreamHash),
    // 认不出的状态按内容推：有素材就是 ready，否则 draft。
    status:
      status === 'written' || status === 'ready' || status === 'draft'
        ? (status as SceneStatus)
        : isSceneReady(sections)
          ? 'ready'
          : 'draft',
    sections,
    body,
  };
}

export function renderSceneFile(scene: WritableScene): string {
  const fm = stringifyFrontmatter({
    plot: scene.plotRelPath,
    scene: scene.no,
    title: scene.title,
    place: scene.place || undefined,
    time: scene.time || undefined,
    characters: scene.characters.length > 0 ? scene.characters : undefined,
    targetWords: scene.targetWords,
    upstreamHash: scene.upstreamHash || undefined,
    status: scene.status,
    generatedBy: 'novel-forge',
  });
  const body = stringifySections(scene.sections as unknown as Record<string, string>, SCENE_SECTION_KEYS, {
    keepEmpty: true,
  });
  return `${fm}\n\n# 场景 ${scene.no}${scene.title ? ` ${scene.title}` : ''}\n\n${body}\n`;
}

/**
 * 一行摘要，如「2. 翻越侧峰 · 青云宗侧峰 · 子时，暴雨」。
 *
 * 给三处共用：剧情阶段装配进 prompt 的场景清单、创作页的场景下拉、
 * 工程页的场景子节点。文案只有一份，三处不会分叉。
 */
export function describeScene(scene: Pick<Scene, 'no' | 'title' | 'place' | 'time'>): string {
  return [`${scene.no}. ${scene.title || '（未命名）'}`, scene.place, scene.time]
    .filter((s) => s && s.trim())
    .join(' · ');
}

function meaningful(text: string): boolean {
  const t = text.trim();
  return t !== '' && t !== '（待补充）' && t !== '(待补充)';
}
