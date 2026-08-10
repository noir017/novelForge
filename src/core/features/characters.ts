import * as path from 'node:path';
import { getHost } from '../host';
import { collectStream, ChatOptions } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { resolveSectionDir } from '../fileOps';
import { elapsed, scoped } from '../logger';
import { runTask } from '../progress';
import { NovelProject, emptyCharacterSections, exists, readText, renderCharacterCard, slugify, writeText } from '../model/project';
import { CHARACTER_SECTION_KEYS, CharacterCard, CharacterSections, Chapter } from '../model/types';
import { sanitizeAliases } from '../naming';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { pickChaptersByInput } from './pickChapters';
import { stripCodeFence } from './summarize';

const log = scoped('角色卡');

/**
 * 从选定章节提取/更新角色卡。
 *
 * 关键约束：**绝不静默覆盖作者手写的角色卡**。已存在的角色一律经
 * 宿主审阅（插件开 diff 编辑器，独立版弹确认框）；新角色则直接创建。
 */
export async function extractCharacters(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    log.warn('还没有章节，无法提取角色');
    getHost().toast('还没有章节。');
    return;
  }

  // 默认勾最近三章；选得越多越准，但消耗的 token 也越多。
  const picked = await pickChaptersByInput(
    chapters,
    '从哪些章节提取角色信息？',
    '输入章节序号，逗号分隔，如 1,2,3',
    chapters.slice(-3).map((c) => c.order)
  );
  if (!picked || picked.length === 0) {
    log.info('用户取消了章节选择');
    return;
  }

  // 一批章节一次调用，谈不上并发；走池是为了拿到「首选失败就换模型」。
  const pool = await createModelPool({ concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，提取中止');
    return;
  }
  const config = readConfig();
  const existing = await project.listCharacters();
  log.info(
    `准备从 ${picked.length} 章提取角色`,
    `章节 ${picked.map((c) => c.order).join('、')}｜已有角色卡 ${existing.length} 张｜模型 ${pool.label}`
  );

  await runTask(
    '提取角色信息',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      // 三步：读正文 → 调模型 → 合并。给 total 才画得出进度条。
      report({ message: '读取章节正文', current: 0, total: 3 });
      const selected = [...picked].sort((a, b) => a.order - b.order);
      const budget = config.contextWindow - config.maxOutputTokens - 2000;
      const corpus = await buildCorpus(project, selected, budget);
      log.debug('正文已读取', `${corpus.length} 字（约 ${estimateTokens(corpus)} token）`);

      const knownList =
        existing.length > 0
          ? existing.map((c) => `- ${c.name}${c.aliases.length ? `（别名：${c.aliases.join('、')}）` : ''}`).join('\n')
          : '（暂无已有角色卡）';

      report({ message: '调用模型分析人物', current: 1, total: 3 });
      const options: ChatOptions = {
        maxOutputTokens: config.maxOutputTokens,
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };
      const modelStart = Date.now();
      const raw = await pool.run('提取角色', (llm) =>
        collectStream(
          llm.chatStream(
            [
              { role: 'system', content: CHARACTER_SYSTEM },
              {
                role: 'user',
                content: `已有角色卡（同一人请沿用既有名字，不要另起新名）：\n${knownList}\n\n以下是正文：\n\n${corpus}`,
              },
            ],
            options
          )
        )
      );
      log.info('模型已返回', `${raw.length} 字，用时 ${elapsed(modelStart)}`);

      if (signal.aborted) {
        log.warn('提取被取消');
        return;
      }

      const parsed = parseCharacterResponse(raw);
      if (parsed.length === 0) {
        log.warn('没有解析出角色信息', `模型返回开头：${raw.slice(0, 300)}`);
        getHost().toast('没有从这些章节中解析出角色信息。');
        return;
      }

      report({ message: `解析出 ${parsed.length} 个角色，正在合并`, current: 2, total: 3 });
      log.info(`解析出 ${parsed.length} 个角色`, parsed.map((p) => p.name).join('、'));
      const lastOrder = selected[selected.length - 1].order;
      const firstOrder = selected[0].order;
      await mergeCharacters(project, parsed, existing, {
        firstOrder,
        lastOrder,
        orders: selected.map((c) => c.order),
      });
      report({ message: '完成', current: 3, total: 3 });
      log.info('提取结束', `总耗时 ${elapsed(startedAt)}`);
    },
    { scope: '角色卡' }
  );
}

interface ParsedCharacter {
  name: string;
  aliases: string[];
  tags: string[];
  sections: CharacterSections;
}

async function mergeCharacters(
  project: NovelProject,
  parsed: ParsedCharacter[],
  existing: CharacterCard[],
  range: { firstOrder: number; lastOrder: number; orders: number[] }
): Promise<void> {
  const byName = new Map<string, CharacterCard>();
  // 正式名先占位，别名后补：一张卡上写错的别名（模型给方源挂过 `方正`）
  // 抢不走另一张卡的正式名。泛称别名（`姐姐`/`她`）一律不进表——它们谁都能用。
  for (const card of existing) {
    byName.set(card.name, card);
  }
  for (const card of existing) {
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      if (!byName.has(alias)) {
        byName.set(alias, card);
      }
    }
  }

  const created: string[] = [];
  const pendingDiff: ParsedCharacter[] = [];

  for (const item of parsed) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (match) {
      pendingDiff.push(item);
      continue;
    }
    // 新角色：直接创建，没有可覆盖的人工内容。
    const slug = await uniqueSlug(project.charactersDir, slugify(item.name));
    const relPath = await project.writeCharacter({
      slug,
      name: item.name,
      aliases: item.aliases,
      tags: item.tags,
      firstAppear: range.firstOrder,
      lastSeen: range.lastOrder,
      // 这一批章节就是目前已知的出场记录。摘要索引之后会给出更完整的清单，
      // 这里先落一份，免得新卡在角色页上显示「未在摘要中出现」。
      appearsIn: range.orders,
      updatedThrough: range.lastOrder,
      sections: item.sections,
    });
    log.info(`新建角色卡「${item.name}」`, relPath);
    created.push(item.name);
  }

  if (created.length > 0) {
    getHost().toast(`新建角色卡 ${created.join('、')}。`);
  }

  if (pendingDiff.length === 0) {
    return;
  }

  const names = pendingDiff.map((p) => p.name).join('、');
  log.info(`${pendingDiff.length} 张已有角色卡有更新建议`, names);
  const choice = await getHost().confirm(
    `已有角色卡的更新：${names}。要逐个对比确认吗？`,
    ['逐个对比', '跳过更新'],
    { modal: true }
  );
  if (choice !== '逐个对比') {
    log.info('用户跳过了已有角色卡的更新');
    return;
  }

  for (const item of pendingDiff) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (!match) {
      continue;
    }
    await reviewCharacterUpdate(project, match, item, range);
  }
}

/**
 * 让作者对比「现有角色卡」与「模型建议」，确认后才写入。
 * 插件宿主开 diff 编辑器；独立版弹确认框（Host.reviewReplace）。
 */
async function reviewCharacterUpdate(
  project: NovelProject,
  existing: CharacterCard,
  proposed: ParsedCharacter,
  range: { lastOrder: number; orders: number[] }
): Promise<void> {
  // 合并策略：模型有内容的小节覆盖，模型留空的保留原文；别名/标签取并集。
  const merged: CharacterSections = { ...existing.sections };
  for (const key of CHARACTER_SECTION_KEYS) {
    const next = proposed.sections[key]?.trim();
    if (next && next !== '无' && next !== '（待补充）') {
      merged[key] = next;
    }
  }

  const appearsIn = [...new Set([...existing.appearsIn, ...range.orders])].sort((a, b) => a - b);
  const mergedCard = {
    slug: existing.slug,
    name: existing.name,
    aliases: unique(sanitizeAliases([...existing.aliases, ...proposed.aliases], existing.name)),
    tags: unique([...existing.tags, ...proposed.tags]),
    firstAppear: existing.firstAppear ?? appearsIn[0],
    lastSeen: Math.max(existing.lastSeen ?? 0, range.lastOrder) || range.lastOrder,
    appearsIn,
    // 这次读到了哪一章，下次「更新角色卡」的增量从这里接着走。
    updatedThrough: Math.max(existing.updatedThrough ?? 0, range.lastOrder),
    sections: merged,
  };

  const proposedText = renderCharacterCard(mergedCard);
  const currentAbs = project.pathOf(existing.relPath);
  const currentText = await readText(currentAbs);

  let verdict: 'apply' | 'discard' | undefined;
  const host = getHost();
  if (host.reviewReplace) {
    verdict = await host.reviewReplace(existing.name, currentText, proposedText);
  } else {
    // 宿主未实现审阅能力时退化为纯确认（不展示差异）。
    const pick = await getHost().confirm(
      `已生成对「${existing.name}」的更新（合并模型建议与现有内容）。直接采纳？`,
      ['采纳', '跳过'],
      { modal: true }
    );
    verdict = pick === '采纳' ? 'apply' : pick === '跳过' ? 'discard' : undefined;
  }

  if (verdict === 'apply') {
    await writeText(currentAbs, proposedText);
    log.info(`已更新角色卡「${existing.name}」`, `${existing.relPath}｜${currentText.length} 字 → ${proposedText.length} 字`);
    getHost().toast(`已更新「${existing.name}」。`);
  } else {
    log.info(`跳过角色卡「${existing.name}」`, verdict === 'discard' ? '用户放弃' : '用户取消');
  }
}

/**
 * 手动新建一张空角色卡。
 * `dir` 是落点目录（工作区相对路径，如 `.novelforge/characters/主角`）；
 * 缺省或越界时落在 characters/ 根下。
 */
export async function newCharacter(project: NovelProject, dir?: string): Promise<void> {
  const target = resolveSectionDir(project, 'characters', dir);
  const root = project.relPath(project.charactersDir);
  const name = await getHost().input({
    title: '新建角色卡',
    prompt: target === root ? '角色姓名' : `角色姓名（建到 ${target}/）`,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!name) {
    return;
  }
  // slug 带上子目录前缀，writeCharacter 会连中间目录一起建出来。
  const prefix = target === root ? '' : `${target.slice(root.length + 1)}/`;
  const slug = await uniqueSlug(project.charactersDir, `${prefix}${slugify(name)}`);
  const relPath = await project.writeCharacter({
    slug,
    name: name.trim(),
    aliases: [],
    tags: [],
    sections: emptyCharacterSections(),
  });
  await getHost().openFile(relPath);
}

/** 手动新建一条设定。`dir` 同 newCharacter。 */
export async function newLore(project: NovelProject, dir?: string): Promise<void> {
  const target = resolveSectionDir(project, 'lore', dir);
  const root = project.relPath(project.loreDir);
  const title = await getHost().input({
    title: '新建设定条目',
    prompt: target === root ? '设定标题（如「玄门七宗」）' : `设定标题（建到 ${target}/）`,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return;
  }
  const prefix = target === root ? '' : `${target.slice(root.length + 1)}/`;
  const slug = await uniqueSlug(project.loreDir, `${prefix}${slugify(title)}`);
  const abs = path.join(project.loreDir, `${slug}.md`);
  await writeText(
    abs,
    `---\ntitle: ${title.trim()}\nkeywords: [${title.trim()}]\n---\n\n# ${title.trim()}\n\n（在这里写设定内容。keywords 命中续写纲要时会自动注入上下文。）\n`
  );
  await getHost().openFile(project.relPath(abs));
}

// ---------------------------------------------------------------- 解析

/**
 * 解析模型返回。要求模型输出 JSON 数组；解析失败时返回空数组由调用方提示，
 * 不做「猜测式」兜底——角色卡写错比没写更麻烦。
 */
export function parseCharacterResponse(raw: string): ParsedCharacter[] {
  const text = stripCodeFence(raw);
  const jsonText = extractJsonArray(text);
  if (!jsonText) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }

  const out: ParsedCharacter[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      continue;
    }
    const sections = emptyCharacterSections();
    for (const key of CHARACTER_SECTION_KEYS) {
      const value = obj[key];
      if (typeof value === 'string') {
        sections[key] = value.trim();
      } else if (Array.isArray(value)) {
        sections[key] = value.filter((v) => typeof v === 'string').map((v) => `- ${v}`).join('\n');
      }
    }
    out.push({
      name,
      aliases: sanitizeAliases(toStringArray(obj.aliases), name),
      tags: toStringArray(obj.tags),
      sections,
    });
  }
  return out;
}

function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return unique(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean));
  }
  if (typeof v === 'string' && v.trim()) {
    return unique(v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean));
  }
  return [];
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

/** 在某个区目录下找一个没被占用的 slug。slug 可以带子目录前缀。 */
async function uniqueSlug(dirAbs: string, base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await exists(path.join(dirAbs, `${slug}.md`))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

async function buildCorpus(project: NovelProject, chapters: Chapter[], budget: number): Promise<string> {
  const parts: string[] = [];
  for (const chapter of chapters) {
    const text = await project.readChapterText(chapter);
    parts.push(`【第${chapter.order}章 ${chapter.title}】\n${text}`);
  }
  const joined = parts.join('\n\n');
  const clipped = takeHead(joined, Math.max(2000, budget));
  if (clipped.length < joined.length) {
    // 「不静默截断」：选了五章却只读进去两章半，作者必须知道。
    log.warn(
      '选中章节的正文超出输入预算，已截断',
      `${joined.length} 字 → ${clipped.length} 字。少选几章可让提取更完整。`
    );
  }
  return clipped;
}

// ---------------------------------------------------------------- 提示词

const CHARACTER_SYSTEM = `你是小说编辑，负责从正文中提取人物档案。

请输出一个 JSON 数组，除 JSON 外不要输出任何文字、解释或 Markdown 代码块以外的内容。

数组每个元素的结构：
{
  "name": "角色的正式姓名",
  "aliases": ["这个人**专属**的其它称呼"],
  "tags": ["主角" 或 "配角" 或 "反派" 等],
  "身份": "他/她是谁，在故事中的位置",
  "外貌": "外貌特征",
  "性格": "性格特点",
  "语言习惯": "说话的节奏、口癖、常用词——请从正文对白中总结，尽量具体",
  "人物关系": "与其他角色的关系，一行一条",
  "当前状态": "读到正文结尾时，此人身在何处、处于什么处境",
  "未收伏笔": "与此人相关、正文中提到但尚未解决的线索"
}

要求：
- 只提取正文中确实出现的人物，不要虚构信息；正文没交代的字段填空字符串 ""。
- 如果某个人物已在「已有角色卡」列表中，name 必须与列表中完全一致，不要改名。
- **aliases 只收专属称呼**：姓名的其它写法、绰号、独一无二的职称。
  **不要**代词（他/她）、亲属称谓（姐姐/舅父）、泛称（少女/丫头/小姐/公子）、
  带修饰语的描述（「满身血迹的少女」），也**绝不要填别人的名字**——
  程序拿 aliases 判断「谁是谁」，混进一个就会把两个角色认成同一个人。
- 只提取有名有姓、对剧情有作用的角色，路人甲不必收录。
- 所有内容用简体中文。`;
