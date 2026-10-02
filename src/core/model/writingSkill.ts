/**
 * 写作技能（Skill）的纯函数部分：`SKILL.md` 怎么读、什么样的算兼容、绑定文件长什么样、
 * 一次装配算哪个阶段。**零 I/O、零运行时 import**（前端要直接用这里的常量，见 protocol/index.ts）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0）：解析与兼容检查逐条照搬 `src/shared/writing-skills.ts`
 * （`inspectWritingSkillMarkdown` / `parseGitHubWritingSkillUrl`），绑定文件的形状照搬
 * `src/services/agent/writing-skill-bindings.ts`，注入时那句话照搬 `base-command.ts:48-81`。
 * 上游的设计说明是它的 ADR 0015「写作 Skill 是按阶段冻结的补充指导」。
 *
 * ## 一份技能是什么
 *
 * 一个目录里一份 `SKILL.md`：frontmatter（`name` / `display_name` / `description` / `version` /
 * `stage`，一行一个）+ 正文。**只收纯提示词**：要跑脚本、装 hook、派子代理、调工具、读旁边
 * 别的文件的一律判「不兼容」——装不进来，也绑不上。它们在这里没有可执行的地方，装进来
 * 只会让模型以为自己能做一件做不了的事。
 *
 * ## 与上游不同的三处
 *
 * - **名字可以是中文**。上游只认 `[A-Za-z0-9._-]`，这里放宽到任意字母数字（`\p{L}\p{N}`）：
 *   作者给自己写的方法起「去AI味」这种名字再自然不过。
 * - **用户与工程技能的身份是目录名**（上游取 frontmatter 的 `name`、目录名只是回落）。
 *   一份手放进来的技能 frontmatter 写的名字与目录不一样时，上游按 frontmatter 认、按它去删，
 *   结果删了个空；这里只有一个名字，`display_name` 与 `name` 只用来显示。
 * - **没有中英双语**：novelForge 只写中文，`language` 字段不读。
 */
import type { CreationAction, WriteMode } from './pipeline';

// ---------------------------------------------------------------- 阶段与来源

/**
 * 四个阶段，照搬上游。一个工程每个阶段最多绑一份。
 *
 * 与 novelForge 的创作阶段对得上（{@link skillStageOf}）：规划 = 架构 / 大纲 / 细纲三层的
 * 生成与沉淀，写正文 = 写、接着写、重写与它们的续写，审稿与修稿各是正文层的一张配方。
 */
export const SKILL_STAGES = ['planning', 'drafting', 'review', 'refinement'] as const;
export type SkillStage = (typeof SKILL_STAGES)[number];

export const SKILL_STAGE_LABEL: Record<SkillStage, string> = {
  planning: '规划（架构 / 大纲 / 细纲）',
  drafting: '写正文',
  review: '审稿',
  refinement: '修稿',
};

export function isSkillStage(value: unknown): value is SkillStage {
  return typeof value === 'string' && (SKILL_STAGES as readonly string[]).includes(value);
}

/** 内置的随应用发布；我的技能库在 `~/.novelforge/skills/`；本工程的在 `.novelforge/skills/`。 */
export type SkillSource = 'builtin' | 'user' | 'project';

export const SKILL_SOURCES: readonly SkillSource[] = ['builtin', 'user', 'project'];

export const SKILL_SOURCE_LABEL: Record<SkillSource, string> = {
  builtin: '内置',
  user: '我的技能库',
  project: '本工程',
};

// ---------------------------------------------------------------- 兼容检查

export type SkillIncompat =
  | 'relative-reference'
  | 'script-dependency'
  | 'hook-dependency'
  | 'subagent-dependency'
  | 'tool-dependency'
  | 'content-too-large';

/** 说法照搬上游设置页的 `REASON_COPY`。 */
export const SKILL_INCOMPAT_LABEL: Record<SkillIncompat, string> = {
  'relative-reference': '包含相对引用',
  'script-dependency': '依赖脚本',
  'hook-dependency': '依赖 hook',
  'subagent-dependency': '依赖子代理',
  'tool-dependency': '依赖工具调用',
  'content-too-large': '内容超过 64 KiB',
};

/** 整份文件（含 frontmatter）的上限，与上游一样。下载时也按它拒。 */
export const MAX_SKILL_BYTES = 64 * 1024;

export interface SkillInspection {
  /** frontmatter 的 `name`；没写时是调用方给的回落名（目录名），再没有就是 `unnamed-writing-skill`。 */
  name: string;
  displayName?: string;
  description: string;
  version?: string;
  /** frontmatter 里写明的阶段。 */
  stage?: SkillStage;
  /** 写明了就是它，没写按名字、描述与正文开头猜一个（只是建议，任何阶段都能绑）。 */
  suggestedStage: SkillStage;
  compatible: boolean;
  reasons: SkillIncompat[];
  /** 正文（frontmatter 之后，去掉首尾空白）。 */
  body: string;
  /** 正文的 UTF-8 字节数。上限按整份文件算，见 {@link MAX_SKILL_BYTES}。 */
  bytes: number;
}

/** 界面与提示词里叫它什么：`display_name` → `name`。 */
export function skillLabel(s: Pick<SkillInspection, 'name' | 'displayName'>): string {
  return s.displayName?.trim() || s.name;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 上游那份手写的 frontmatter 解析：一行一个 `键: 值`，键转小写，值去一层引号。**不是 YAML**
 * ——没有列表、没有多行值，`allowed-tools: [read]` 原样是一串字。兼容检查要看作者声明了
 * 哪些键，所以这里不用 model/markdown.ts 那一份（它会把认不出的键丢掉）。
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; content: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return { fields: {}, content: raw.trim() };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\s*([^:#][^:]*):\s*(.*?)\s*$/);
    if (field) {
      fields[field[1].trim().toLowerCase()] = unquote(field[2]);
    }
  }
  return { fields, content: raw.slice(match[0].length).trim() };
}

function normalizedStage(value: string | undefined): SkillStage | undefined {
  return SKILL_STAGES.find((stage) => stage === value?.trim().toLowerCase());
}

function suggestStage(fields: Record<string, string>, content: string): SkillStage {
  const explicit = normalizedStage(fields.stage);
  if (explicit) {
    return explicit;
  }
  const searchable = `${fields.name ?? ''} ${fields.description ?? ''} ${content.slice(0, 1000)}`.toLowerCase();
  if (/review|critique|审稿|审阅|检查/.test(searchable)) return 'review';
  if (/refin|polish|prose|润色|修稿|改写/.test(searchable)) return 'refinement';
  if (/plan|outline|architect|规划|大纲|设定/.test(searchable)) return 'planning';
  return 'drafting';
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 读一份 `SKILL.md`。**绝不抛**：读不懂的 frontmatter 当成没有，正文就是整份文件。
 *
 * 兼容规则逐条照搬上游（`writing-skills.ts:110-125`），命中任何一条就不兼容。
 *
 * @param fallbackName 用户与工程技能传目录名：frontmatter 没写 `name` 时用它。
 */
export function inspectSkillMarkdown(raw: string, fallbackName?: string): SkillInspection {
  const text = typeof raw === 'string' ? raw : '';
  const { fields, content } = parseFrontmatter(text);
  const name = fields.name?.trim() || fallbackName?.trim() || 'unnamed-writing-skill';
  const reasons = new Set<SkillIncompat>();
  const body = content.toLowerCase();
  const declaredCapabilities = Object.keys(fields).join(' ');

  if (utf8Bytes(text) > MAX_SKILL_BYTES) {
    reasons.add('content-too-large');
  }
  if (
    /\]\(\s*(?:\.\.?[/\\]|(?:references?|assets?)[/\\])/i.test(content) ||
    /(?:^|[\s`'"(])(?:references?|assets?)[/\\][^\s`'")]+/im.test(content) ||
    /\$\{skill_dir\}/i.test(content)
  ) {
    reasons.add('relative-reference');
  }
  if (
    /(?:^|[\s`'"(])scripts?[/\\][^\s`'")]+/im.test(content) ||
    /\b(?:run|execute)\s+(?:the\s+)?script\b/i.test(content) ||
    /运行.{0,12}脚本/.test(content)
  ) {
    reasons.add('script-dependency');
  }
  if (
    /(?:^|[\s`'"(])hooks?[/\\][^\s`'")]+/im.test(content) ||
    /\b(?:install|run|execute)\s+(?:the\s+)?hook\b/i.test(content) ||
    /安装.{0,12}钩子/.test(content)
  ) {
    reasons.add('hook-dependency');
  }
  if (/\bsub-?agents?\b|\bdelegate\b.{0,30}\bagents?\b|子代理|子智能体/.test(body)) {
    reasons.add('subagent-dependency');
  }
  if (
    /\ballowed[-_ ]?tools?\b|\btools?\b|\bmcp\b|\bhooks?\b|\bscripts?\b|\bsub-?agents?\b/.test(declaredCapabilities) ||
    /\b(?:use|call|invoke)\s+(?:the\s+)?[a-z0-9_-]+\s+tools?\b/i.test(content) ||
    /(?:使用|调用).{0,24}工具/.test(content)
  ) {
    reasons.add('tool-dependency');
  }

  return {
    name,
    displayName: fields.display_name || fields['display-name'] || undefined,
    description: fields.description || `写作技能：${name}`,
    version: fields.version || undefined,
    stage: normalizedStage(fields.stage),
    suggestedStage: suggestStage(fields, content),
    compatible: reasons.size === 0,
    reasons: [...reasons],
    body: content,
    bytes: utf8Bytes(content),
  };
}

/** 不兼容的原因，一句话。 */
export function describeIncompat(reasons: readonly SkillIncompat[]): string {
  return reasons.map((r) => SKILL_INCOMPAT_LABEL[r] ?? r).join('、');
}

// ---------------------------------------------------------------- 身份

/**
 * 技能名：也是它在磁盘上的目录名。字母或数字开头，其后可以有 `.` `_` `-`，最长 64。
 * 中文算字母（与上游不同，见文件头）。没有斜杠、没有 `..`，拼成路径不会越界。
 */
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export function isSkillName(name: unknown): name is string {
  return typeof name === 'string' && SKILL_NAME.test(name);
}

/** 稳定 id：`来源:名字`。同名的技能可以在几个来源里各有一份，靠前缀分开。 */
export function skillId(source: SkillSource, name: string): string {
  return `${source}:${name}`;
}

export function parseSkillId(id: unknown): { source: SkillSource; name: string } | undefined {
  if (typeof id !== 'string') {
    return undefined;
  }
  const at = id.indexOf(':');
  const source = id.slice(0, at) as SkillSource;
  const name = id.slice(at + 1);
  if (at <= 0 || !SKILL_SOURCES.includes(source) || !isSkillName(name)) {
    return undefined;
  }
  return { source, name };
}

// ---------------------------------------------------------------- 绑定文件

/** 每个阶段绑了哪一份（技能 id）。没绑的阶段不出现。 */
export type SkillBindings = Partial<Record<SkillStage, string>>;

/**
 * `.novelforge/skills.json` 的内容。形状照搬上游的 `.vela/writing-skills.json`：
 * `{ "version": 1, "bindings": { "planning": "builtin:long-form-continuity" } }`。
 *
 * **容错**（第 1 条）：读不懂的整份当成没绑、认不出的那一项跳过，但都写进 `problems`——
 * 装配器拿它在明细里说一声（第 2 条），不让作者以为技能带上了。上游是读不懂就整个工作流
 * 起不来。
 */
export interface SkillBindingProblem {
  /** 出在哪个阶段的那一项上。整份读不懂时没有。 */
  stage?: string;
  text: string;
}

export function parseSkillBindings(raw: string): { bindings: SkillBindings; problems: SkillBindingProblem[] } {
  if (!raw.trim()) {
    return { bindings: {}, problems: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { bindings: {}, problems: [{ text: '不是合法的 JSON' }] };
  }
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1) {
    return { bindings: {}, problems: [{ text: '认不出的版本（应为 "version": 1）' }] };
  }
  const source = (data as { bindings?: unknown }).bindings;
  if (source === undefined) {
    return { bindings: {}, problems: [] };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { bindings: {}, problems: [{ text: '"bindings" 应该是一个对象' }] };
  }
  const bindings: SkillBindings = {};
  const problems: SkillBindingProblem[] = [];
  for (const [stage, id] of Object.entries(source as Record<string, unknown>)) {
    if (!isSkillStage(stage)) {
      problems.push({ stage, text: `认不出的阶段「${stage}」` });
    } else if (!parseSkillId(id)) {
      problems.push({ stage, text: `「${SKILL_STAGE_LABEL[stage]}」绑的不是合法的技能 id` });
    } else {
      bindings[stage] = id as string;
    }
  }
  return { bindings, problems };
}

/** 落盘的那份文本。阶段按固定顺序排，改一项不会让整份文件的 diff 乱跳。 */
export function renderSkillBindings(bindings: SkillBindings): string {
  const ordered: SkillBindings = {};
  for (const stage of SKILL_STAGES) {
    if (bindings[stage]) {
      ordered[stage] = bindings[stage];
    }
  }
  return `${JSON.stringify({ version: 1, bindings: ordered }, null, 2)}\n`;
}

// ---------------------------------------------------------------- 一次装配算哪个阶段

/**
 * 这一次装配该带哪个阶段的技能。`undefined` = 不带。
 *
 * 讨论（`discuss`）不带：那是作者在聊，不是一次产出——上游的 AI 助手对话同样不带阶段技能。
 * 定稿、摘要、文风提取、角色卡这些不经 `buildContext`，本来就带不到（上游的定稿与文风分析
 * 也不带）。
 */
export function skillStageOf(action: CreationAction, writeMode?: WriteMode): SkillStage | undefined {
  const { stage, capability } = action;
  if (capability === 'discuss') {
    return undefined;
  }
  if (stage === 'manuscript') {
    if (capability === 'review') {
      return 'review';
    }
    return writeMode === 'revise' ? 'refinement' : 'drafting';
  }
  return capability === 'generate' || capability === 'settle' ? 'planning' : undefined;
}

/**
 * 注入提示词的那一块。说法照搬上游（`base-command.ts:63`），去掉了「项目写作语言」——
 * 这里没有那个概念。**放在用户消息的最前面**，与上游一样：它是补充，作者事实与末尾的
 * 输出合同都排在它后面、说了算。
 */
export function renderSkillBlock(label: string, body: string): string {
  return `【补充写作 Skill：${label}】\n以下内容只能补充创作方法；作者事实和后续输出合同始终优先。\n${body.trim()}`;
}

// ---------------------------------------------------------------- GitHub 地址

export interface GitHubSkillLocation {
  owner: string;
  repo: string;
  /** 没给就是默认分支（下载前要问一次 GitHub）。 */
  ref?: string;
  /** 仓库里那份 `SKILL.md` 的路径。 */
  path: string;
  sourceUrl: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function safePart(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`GitHub 地址里的${label}不合法`);
  }
  if (!SAFE_SEGMENT.test(decoded) || decoded === '.' || decoded === '..') {
    throw new Error(`GitHub 地址里的${label}不合法`);
  }
  return decoded;
}

function safePath(parts: string[]): string {
  const decoded = parts.map((part, index) => safePart(part, `第 ${index + 1} 段路径`)).join('/');
  if (!decoded || !decoded.toLowerCase().endsWith('skill.md')) {
    throw new Error('GitHub 地址要指到一份 SKILL.md');
  }
  return decoded;
}

/**
 * 认四种地址（照搬上游）：仓库首页（取默认分支根下的 `SKILL.md`）、`/tree/<分支>/<目录>`、
 * `/blob/<分支>/<…SKILL.md>`、`raw.githubusercontent.com/<owner>/<repo>/<分支>/<…>`。
 * 只要公开的 https，不许带用户名、密码、端口。**错了就抛**，抛的那句就是给作者看的。
 */
export function parseGitHubSkillUrl(value: string): GitHubSkillLocation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('不是一个合法的地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('只支持公开的 https GitHub 地址');
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) {
      throw new Error('raw.githubusercontent.com 的地址不完整');
    }
    return {
      owner: safePart(parts[0], '用户名'),
      repo: safePart(parts[1].replace(/\.git$/i, ''), '仓库名'),
      ref: safePart(parts[2], '分支'),
      path: safePath(parts.slice(3)),
      sourceUrl: url.toString(),
    };
  }
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new Error('只支持 github.com 与 raw.githubusercontent.com');
  }

  const owner = safePart(parts[0], '用户名');
  const repo = safePart(parts[1].replace(/\.git$/i, ''), '仓库名');
  if (parts.length === 2) {
    return { owner, repo, path: 'SKILL.md', sourceUrl: url.toString() };
  }
  const kind = parts[2];
  if ((kind !== 'tree' && kind !== 'blob') || parts.length < 4) {
    throw new Error('请给仓库、目录（/tree/…）、文件（/blob/…）或 raw 的 SKILL.md 地址');
  }
  const ref = safePart(parts[3], '分支');
  const targetParts = parts.slice(4);
  if (kind === 'tree') {
    targetParts.push('SKILL.md');
  }
  return { owner, repo, ref, path: safePath(targetParts), sourceUrl: url.toString() };
}

/** 真正去下载的那个地址。 */
export function githubRawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const segments = [owner, repo, ref, ...filePath.split('/')].map(encodeURIComponent);
  return `https://raw.githubusercontent.com/${segments.join('/')}`;
}

/** 分支名是否可以照抄进下载地址（GitHub 返回的默认分支也要过一遍）。 */
export function isSafeRef(ref: unknown): ref is string {
  return typeof ref === 'string' && SAFE_SEGMENT.test(ref) && ref !== '.' && ref !== '..';
}
