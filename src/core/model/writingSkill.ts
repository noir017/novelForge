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
 * **常规的技能目录**：一份 `SKILL.md`（YAML frontmatter + 正文），旁边可以带它引用的文本文件
 * （`references/*.md` 这类，叫「附带文件」）。frontmatter 只读顶层的 `name` / `display_name` /
 * `description` / `version` / `stage`，别的键（`allowed-tools`、`metadata`……）读得过去、不碍事。
 *
 * **只收纯提示词**：要跑脚本、装 hook、派子代理、调工具的一律判「不兼容」——装不进来，也绑不上。
 * 它们在这里没有可执行的地方，装进来只会让模型以为自己能做一件做不了的事。附带文件不一样：
 * 这里的生成是一次调用、模型没有读文件的工具，所以引用到的整份接在正文后面一起带；引用了却
 * 带不上的（找不到、在技能目录外、不是文本）才判「包含相对引用」。
 *
 * ## 与上游不同的几处
 *
 * - **名字可以是中文**。上游只认 `[A-Za-z0-9._-]`，这里放宽到任意字母数字（`\p{L}\p{N}`）：
 *   作者给自己写的方法起「去AI味」这种名字再自然不过。
 * - **用户与工程技能的身份是目录名**（上游取 frontmatter 的 `name`、目录名只是回落）。
 *   一份手放进来的技能 frontmatter 写的名字与目录不一样时，上游按 frontmatter 认、按它去删，
 *   结果删了个空；这里只有一个名字，`display_name` 与 `name` 只用来显示。
 * - **没有中英双语**：novelForge 只写中文，`language` 字段不读。
 * - **认常规技能格式**（2026-10-21）：上游一行一个键地读 frontmatter、引用旁边的文件就判不兼容、
 *   声明了 `allowed-tools` 就判依赖工具。这里 frontmatter 按 YAML 读顶层键，附带文件一起带，
 *   `allowed-tools` 不算——上游原样的技能目录放进来就能用。见
 *   docs/design/plans/2026-10-21-skill-dirs.md。
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

/**
 * 一份技能注入的上限：`SKILL.md` 整份（含 frontmatter）加上它带的附带文件，合起来，与上游
 * 的 64 KiB 同一个数。下载时也按它拒。
 */
export const MAX_SKILL_BYTES = 64 * 1024;

/** 一份技能最多带几份附带文件。 */
export const MAX_SKILL_ATTACHMENTS = 32;

/**
 * 附带文件：技能目录里被 `SKILL.md`（或被别的附带文件）引用到的文本文件，比如常规技能的
 * `references/*.md`。这里的生成是一次调用、模型没有读文件的工具，没法「按需去读」，所以
 * 引用到的整份接在正文后面一起带；没被引用的（README、CHANGELOG、LICENSE）不带。
 */
export interface SkillAttachment {
  /** 技能目录里的相对路径，`/` 分隔。 */
  path: string;
  text: string;
}

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
  /** 引用到、一起带的附带文件，按引用的先后。 */
  attachments: SkillAttachment[];
  /** 明确引用了、却带不上的文件（找不到、在技能目录外、不是文本），就是「包含相对引用」的那几处。 */
  unresolved: string[];
  /** 注入的字节数：正文加附带文件（UTF-8）。上限按整份 `SKILL.md` 加附带文件算，见 {@link MAX_SKILL_BYTES}。 */
  bytes: number;
}

/** 界面与提示词里叫它什么：`display_name` → `name`。 */
export function skillLabel(s: Pick<SkillInspection, 'name' | 'displayName'>): string {
  return s.displayName?.trim() || s.name;
}

// ---------------------------------------------------------------- frontmatter（YAML 的一个子集）

/**
 * 常规技能的 frontmatter 是 YAML：列表（`allowed-tools:\n  - Read`）、嵌套块（`metadata:` 下面
 * 缩进的几行）、多行的 `description: |`。项目不引入 yaml 依赖，这里只读**顶层的键**：
 *
 * - 顶层 `键: 值`，值可以加单引号 / 双引号（双引号认常见转义），行尾 ` # 注释` 去掉；
 *   不加引号的值可以折到下面缩进的几行（YAML 的多行纯量）。
 * - `|` / `>` 块标量（带 `-` / `+`），缩进的那几行是它的内容。
 * - 值为空的键下面缩进的几行（列表、嵌套映射）**整块归它，不展开**——从前一行一个键的读法会把
 *   `metadata:` 下面的 `name:` / `version:` 拍平到顶层、盖掉真的那个。
 * - 列表（`[a, b]` 或 `- a`）只记有这个键，值不读：这里用不到。
 *
 * 键一律转小写。BOM、CRLF、`---` 后面的空白都认。**绝不抛**：读不懂的行跳过。
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; keys: string[]; content: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = text.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
  if (!match) {
    return { fields: {}, keys: [], content: text.trim() };
  }
  const fields: Record<string, string> = {};
  const lines = (match[1] ?? '').split('\n');
  const indented = (line: string): boolean => /^[ \t]/.test(line) || line.trim() === '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    const kv = line.match(/^([^\s#:'"\-[{][^:]*?)[ \t]*:[ \t]*(.*?)[ \t]*$/);
    if (!kv) {
      // 空行、注释、顶层的 `- 列表项`、上一个键的缩进内容（列表、嵌套映射）：都不是一个新的顶层键。
      continue;
    }
    const key = kv[1].trim().toLowerCase();
    const value = kv[2];
    // 这个键下面缩进的那几行（空行夹在中间也算）。末尾的空行不算它的。
    let end = i;
    while (end < lines.length && indented(lines[end])) {
      end++;
    }
    while (end > i && lines[end - 1].trim() === '') {
      end--;
    }
    const block = lines.slice(i, end);
    i = end;

    const blockScalar = value.match(/^([|>])([+-]?)\d?([+-]?)(?:[ \t]+#.*)?$/);
    if (blockScalar) {
      fields[key] = blockScalarValue(block, blockScalar[1] === '>', blockScalar[2] || blockScalar[3]);
    } else if (value === '') {
      fields[key] = '';
    } else if (value.startsWith('"') || value.startsWith("'")) {
      fields[key] = quotedValue([value, ...block.map((l) => l.trim())].join(' '));
    } else {
      fields[key] = [value, ...block.map((l) => l.trim())]
        .filter((l) => l !== '')
        .join(' ')
        .replace(/[ \t]+#.*$/, '');
    }
  }
  return { fields, keys: Object.keys(fields), content: text.slice(match[0].length).trim() };
}

function blockScalarValue(block: string[], folded: boolean, chomp: string): string {
  const indent = Math.min(
    ...block.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
    Number.MAX_SAFE_INTEGER
  );
  const lines = block.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
  let out = folded
    ? lines.reduce((acc, l, k) => (k === 0 ? l : l === '' || lines[k - 1] === '' ? `${acc}\n${l}` : `${acc} ${l}`), '')
    : lines.join('\n');
  out = chomp === '+' ? `${out}\n` : chomp === '-' ? out.replace(/\n+$/, '') : `${out.replace(/\n+$/, '')}\n`;
  return out.trim();
}

/** 引号里的值：双引号认 `\"` `\\` `\n` `\t` `\uXXXX`，单引号认 `''`。引号外的 ` # 注释` 去掉。 */
function quotedValue(value: string): string {
  const quote = value[0];
  let out = '';
  for (let k = 1; k < value.length; k++) {
    const ch = value[k];
    if (quote === "'" && ch === "'") {
      if (value[k + 1] === "'") {
        out += "'";
        k++;
        continue;
      }
      return out;
    }
    if (quote === '"' && ch === '"') {
      return out;
    }
    if (quote === '"' && ch === '\\' && k + 1 < value.length) {
      const next = value[++k];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(k + 1, k + 5))) {
        out += String.fromCharCode(parseInt(value.slice(k + 1, k + 5), 16));
        k += 4;
      } else {
        out += ({ n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[next] ?? next;
      }
      continue;
    }
    out += ch;
  }
  // 没有收尾的引号：照原样（去掉开头那个）。
  return out;
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

// ---------------------------------------------------------------- 附带文件

/** 能当附带文件带的：文本。图片这类带不进提示词。 */
const TEXT_FILE = /\.(?:md|markdown|txt)$/i;

export interface SkillReference {
  /** 规范成技能根下的相对路径（`/` 分隔）；越出技能目录的是 undefined。 */
  path?: string;
  /** 原文里写的那个目标。 */
  target: string;
  /**
   * 明确指向旁边文件的写法（`./`、`../`、`references/`、`assets/`）：带不上就不兼容。
   * 普通的 `[示例](a.md)` 找不到只是不带，与从前一样。
   */
  strong: boolean;
  /** 是文本、能带进提示词。 */
  text: boolean;
}

function joinSkillPath(fromPath: string, target: string): string | undefined {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

/**
 * 一份 Markdown 里引用了技能目录里的哪些文件：Markdown 链接的目标（不含网址、锚点、绝对路径），
 * 加上正文里裸写的 `references/…`、`assets/…`。`fromPath` 是这份文件自己的相对路径，引用按它
 * 所在的目录解析。去重，按出现的先后。
 */
export function skillReferences(markdown: string, fromPath = 'SKILL.md'): SkillReference[] {
  const found: SkillReference[] = [];
  const seen = new Set<string>();
  const add = (rawTarget: string, bare: boolean): void => {
    let target = rawTarget.trim().replace(/^<|>$/g, '').replace(/[#?].*$/, '');
    try {
      target = decodeURI(target);
    } catch {
      // 解不开就按原样。
    }
    target = target.replace(/\\/g, '/');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || seen.has(target)) {
      return;
    }
    seen.add(target);
    const strong = bare || /^\.\.?\//.test(target) || /^(?:references?|assets?)\//i.test(target);
    found.push({ path: joinSkillPath(fromPath, target), target, strong, text: TEXT_FILE.test(target) });
  };
  // 两种写法各找一遍，再按在原文里出现的先后排：说「带不上哪几个」时顺着原文说。
  const hits: { at: number; target: string; bare: boolean }[] = [];
  for (const m of markdown.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g)) {
    hits.push({ at: m.index, target: m[1], bare: false });
  }
  for (const m of markdown.matchAll(
    /(?:^|[\s`'"(（「《：:、，])((?:\.\.?\/)*(?:references?|assets?)\/[^\s`'"()（）「」《》[\]，。、；：！？]+)/gim
  )) {
    hits.push({ at: m.index, target: m[1].replace(/[.,;:!?]+$/, ''), bare: true });
  }
  hits.sort((x, y) => x.at - y.at);
  for (const hit of hits) {
    add(hit.target, hit.bare);
  }
  return found;
}

/**
 * 从 `SKILL.md` 正文出发、按引用一层层找附带文件（附带文件里再引用的也算）。只在给的 `files` 里找：
 * 读盘与下载由调用方按 {@link skillReferences} 先做，这里零 I/O。
 */
function resolveAttachments(
  body: string,
  files: Readonly<Record<string, string>>
): { attachments: SkillAttachment[]; unresolved: string[]; tooMany: boolean } {
  const attachments: SkillAttachment[] = [];
  const unresolved: string[] = [];
  const taken = new Set<string>(['SKILL.md']);
  const queue: SkillReference[] = skillReferences(body);
  let tooMany = false;
  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (ref.path && taken.has(ref.path)) {
      continue;
    }
    const text = ref.path && ref.text ? files[ref.path] : undefined;
    if (text === undefined) {
      if (ref.strong && !unresolved.includes(ref.path ?? ref.target)) {
        unresolved.push(ref.path ?? ref.target);
      }
      continue;
    }
    if (attachments.length >= MAX_SKILL_ATTACHMENTS) {
      tooMany = true;
      break;
    }
    taken.add(ref.path!);
    attachments.push({ path: ref.path!, text });
    queue.push(...skillReferences(text, ref.path));
  }
  return { attachments, unresolved, tooMany };
}

// ---------------------------------------------------------------- 兼容检查

/**
 * 读一份技能。**绝不抛**：读不懂的 frontmatter 当成没有，正文就是整份文件。
 *
 * 兼容规则照搬上游（`writing-skills.ts:110-125`），命中任何一条就不兼容，有两处放宽（常规技能
 * 格式）：
 * - 引用旁边的文件：带得上（`files` 里有、是文本、在技能目录里）就当附带文件一起带，带不上的
 *   才算「包含相对引用」。
 * - frontmatter 里的 `allowed-tools` / `tools` 不算依赖工具调用：那是给 Claude Code 一类 agent
 *   预先放行的权限，不是这份技能要调的东西；`metadata` 这类块也不看。声明了 `hooks` / `mcp` /
 *   `scripts` / `sub-agents` 的照旧不兼容，正文与附带文件里要调工具、跑脚本、派子代理的也照旧。
 *
 * @param fallbackName 用户与工程技能传目录名：frontmatter 没写 `name` 时用它。
 * @param files 技能目录里读到的文件（相对路径 → 文本），附带文件从这里取。不给就是只有一份 `SKILL.md`。
 */
export function inspectSkillMarkdown(
  raw: string,
  fallbackName?: string,
  files: Readonly<Record<string, string>> = {}
): SkillInspection {
  const text = typeof raw === 'string' ? raw : '';
  const { fields, keys, content } = parseFrontmatter(text);
  const name = fields.name?.trim() || fallbackName?.trim() || 'unnamed-writing-skill';
  const reasons = new Set<SkillIncompat>();
  const { attachments, unresolved, tooMany } = resolveAttachments(content, files);
  // 内容类的规则在正文与每一份附带文件上各查一遍：它们一样会进提示词。
  const texts = [content, ...attachments.map((a) => a.text)];
  const anyText = (pattern: RegExp): boolean => texts.some((t) => pattern.test(t));
  const bytes = utf8Bytes(content) + attachments.reduce((sum, a) => sum + utf8Bytes(a.text), 0);

  if (tooMany || utf8Bytes(text) + attachments.reduce((sum, a) => sum + utf8Bytes(a.text), 0) > MAX_SKILL_BYTES) {
    reasons.add('content-too-large');
  }
  if (unresolved.length > 0 || anyText(/\$\{skill_dir\}/i)) {
    reasons.add('relative-reference');
  }
  if (
    anyText(/(?:^|[\s`'"(])scripts?[/\\][^\s`'")]+/im) ||
    anyText(/\b(?:run|execute)\s+(?:the\s+)?script\b/i) ||
    anyText(/运行.{0,12}脚本/)
  ) {
    reasons.add('script-dependency');
  }
  if (
    anyText(/(?:^|[\s`'"(])hooks?[/\\][^\s`'")]+/im) ||
    anyText(/\b(?:install|run|execute)\s+(?:the\s+)?hook\b/i) ||
    anyText(/安装.{0,12}钩子/)
  ) {
    reasons.add('hook-dependency');
  }
  if (anyText(/\bsub-?agents?\b|\bdelegate\b.{0,30}\bagents?\b|子代理|子智能体/i)) {
    reasons.add('subagent-dependency');
  }
  if (
    keys.some((k) => /\bmcp\b|\bhooks?\b|\bscripts?\b|\bsub-?agents?\b/.test(k)) ||
    anyText(/\b(?:use|call|invoke)\s+(?:the\s+)?[a-z0-9_-]+\s+tools?\b/i) ||
    anyText(/(?:使用|调用).{0,24}工具/)
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
    attachments,
    unresolved,
    bytes,
  };
}

/** 不兼容的原因，一句话。给了带不上的那几个文件就跟在「包含相对引用」后面。 */
export function describeIncompat(reasons: readonly SkillIncompat[], unresolved: readonly string[] = []): string {
  return reasons
    .map((r) =>
      r === 'relative-reference' && unresolved.length > 0
        ? `${SKILL_INCOMPAT_LABEL[r]}（带不上：${unresolved.join('、')}）`
        : (SKILL_INCOMPAT_LABEL[r] ?? r)
    )
    .join('、');
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
export function renderSkillBlock(label: string, body: string, attachments: readonly SkillAttachment[] = []): string {
  const parts = [`【补充写作 Skill：${label}】\n以下内容只能补充创作方法；作者事实和后续输出合同始终优先。\n${body.trim()}`];
  // 附带文件接在后面，标出路径：正文里「按需读取 references/x.md」说的就是这一份。
  for (const a of attachments) {
    parts.push(`【附带文件：${a.path}】\n${a.text.replace(/\r\n?/g, '\n').trim()}`);
  }
  return parts.join('\n\n');
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

/** 仓库里的一个文件路径能不能照抄进下载地址：每一段都与分支名同一条规矩。附带文件下载前过一遍。 */
export function isSafeGitHubPath(filePath: string): boolean {
  return filePath.split('/').every((seg) => isSafeRef(seg));
}
