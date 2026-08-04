import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CancelledError, collectStream, ChatOptions } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { NovelProject, emptyCharacterSections, exists, readConfig, renderCharacterCard, slugify, writeText } from '../model/project';
import { CHARACTER_SECTION_KEYS, CharacterCard, CharacterSections, Chapter } from '../model/types';
import { takeHead } from '../context/tokenizer';
import { stripCodeFence } from './summarize';

/**
 * 从选定章节提取/更新角色卡。
 *
 * 关键约束：**绝不静默覆盖作者手写的角色卡**。已存在的角色一律走
 * diff 编辑器让作者确认；新角色则直接创建（无可覆盖的内容）。
 */
export async function extractCharacters(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    void vscode.window.showWarningMessage('Novel Forge：还没有章节。');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    chapters.map((c) => ({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      chapter: c,
      picked: c.order > chapters.length - 3, // 默认勾最近三章
    })),
    {
      title: '从哪些章节提取角色信息？',
      canPickMany: true,
      placeHolder: '可多选。选得越多越准，但消耗的 token 也越多。',
    }
  );
  if (!picked || picked.length === 0) {
    return;
  }

  const provider = await resolveProvider();
  if (!provider) {
    return;
  }
  const config = readConfig();
  const existing = await project.listCharacters();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novel Forge：提取角色信息', cancellable: true },
    async (progress, token) => {
      // TODO(Task 5): 换成 getHost().progress(signal, report) 后删掉此桥接
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort(new CancelledError()));
      progress.report({ message: '读取章节正文' });
      const selected = picked.map((p) => p.chapter).sort((a, b) => a.order - b.order);
      const corpus = await buildCorpus(project, selected, config.contextWindow - config.maxOutputTokens - 2000);

      const knownList =
        existing.length > 0
          ? existing.map((c) => `- ${c.name}${c.aliases.length ? `（别名：${c.aliases.join('、')}）` : ''}`).join('\n')
          : '（暂无已有角色卡）';

      progress.report({ message: '调用模型分析人物' });
      const options: ChatOptions = {
        maxOutputTokens: config.maxOutputTokens,
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal: abort.signal,
      };
      const raw = await collectStream(
        provider.chatStream(
          [
            { role: 'system', content: CHARACTER_SYSTEM },
            {
              role: 'user',
              content: `已有角色卡（同一人请沿用既有名字，不要另起新名）：\n${knownList}\n\n以下是正文：\n\n${corpus}`,
            },
          ],
          options
        )
      );

      if (abort.signal.aborted) {
        return;
      }

      const parsed = parseCharacterResponse(raw);
      if (parsed.length === 0) {
        void vscode.window.showWarningMessage('Novel Forge：没有从这些章节中解析出角色信息。');
        return;
      }

      progress.report({ message: `解析出 ${parsed.length} 个角色，正在合并` });
      const lastOrder = selected[selected.length - 1].order;
      const firstOrder = selected[0].order;
      await mergeCharacters(project, parsed, existing, { firstOrder, lastOrder });
    }
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
  range: { firstOrder: number; lastOrder: number }
): Promise<void> {
  const byName = new Map<string, CharacterCard>();
  for (const card of existing) {
    byName.set(card.name, card);
    for (const alias of card.aliases) {
      byName.set(alias, card);
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
    const slug = await uniqueSlug(project, slugify(item.name));
    await project.writeCharacter({
      slug,
      name: item.name,
      aliases: item.aliases,
      tags: item.tags,
      firstAppear: range.firstOrder,
      lastSeen: range.lastOrder,
      sections: item.sections,
    });
    created.push(item.name);
  }

  if (created.length > 0) {
    void vscode.window.showInformationMessage(`Novel Forge：新建角色卡 ${created.join('、')}。`);
  }

  if (pendingDiff.length === 0) {
    return;
  }

  const names = pendingDiff.map((p) => p.name).join('、');
  const choice = await vscode.window.showInformationMessage(
    `已有角色卡的更新：${names}。要逐个对比确认吗？`,
    { modal: true },
    '逐个对比',
    '跳过更新'
  );
  if (choice !== '逐个对比') {
    return;
  }

  for (const item of pendingDiff) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (!match) {
      continue;
    }
    await reviewCharacterUpdate(project, match, item, range.lastOrder);
  }
}

/**
 * 打开 diff 编辑器让作者对比「现有角色卡」与「模型建议」，确认后才写入。
 * 建议内容写到临时文件（untitled scheme 不支持 diff 保存，故用真实临时文件）。
 */
async function reviewCharacterUpdate(
  project: NovelProject,
  existing: CharacterCard,
  proposed: ParsedCharacter,
  lastSeen: number
): Promise<void> {
  // 合并策略：模型有内容的小节覆盖，模型留空的保留原文；别名/标签取并集。
  const merged: CharacterSections = { ...existing.sections };
  for (const key of CHARACTER_SECTION_KEYS) {
    const next = proposed.sections[key]?.trim();
    if (next && next !== '无' && next !== '（待补充）') {
      merged[key] = next;
    }
  }

  const mergedCard = {
    slug: existing.slug,
    name: existing.name,
    aliases: unique([...existing.aliases, ...proposed.aliases]),
    tags: unique([...existing.tags, ...proposed.tags]),
    firstAppear: existing.firstAppear,
    lastSeen: Math.max(existing.lastSeen ?? 0, lastSeen) || lastSeen,
    sections: merged,
  };

  const proposedText = renderCharacterCard(mergedCard);
  const currentAbs = project.pathOf(existing.relPath);
  const previewAbs = path.join(project.novelDir, '.tmp', `${existing.slug}.proposed.md`);

  await fs.mkdir(path.join(project.novelDir, '.tmp'), { recursive: true });
  await writeText(previewAbs, proposedText);

  // TODO(Task 6): 换成 Host.reviewReplace，并删除 .tmp 预览文件流程
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(currentAbs),
    vscode.Uri.file(previewAbs),
    `${existing.name}：现有 ↔ 建议`,
    { preview: true }
  );

  const apply = await vscode.window.showInformationMessage(
    `是否采纳对「${existing.name}」的更新？（可先在右侧编辑器里手动调整，再点采纳）`,
    { modal: true },
    '采纳右侧内容',
    '跳过'
  );

  if (apply === '采纳右侧内容') {
    // 读回预览文件——作者可能在 diff 里改过。
    const finalText = await fs.readFile(previewAbs, 'utf8');
    await writeText(currentAbs, finalText);
    void vscode.window.showInformationMessage(`Novel Forge：已更新「${existing.name}」。`);
  }

  try {
    await fs.rm(previewAbs, { force: true });
  } catch {
    /* 临时文件删不掉不影响主流程 */
  }
}

/** 手动新建一张空角色卡。 */
export async function newCharacter(project: NovelProject): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: '新建角色卡',
    prompt: '角色姓名',
    validateInput: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!name) {
    return;
  }
  const slug = await uniqueSlug(project, slugify(name));
  const relPath = await project.writeCharacter({
    slug,
    name: name.trim(),
    aliases: [],
    tags: [],
    sections: emptyCharacterSections(),
  });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(project.pathOf(relPath))));
}

/** 手动新建一条设定。 */
export async function newLore(project: NovelProject): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: '新建设定条目',
    prompt: '设定标题（如「玄门七宗」）',
    validateInput: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) {
    return;
  }
  const slug = slugify(title);
  const abs = path.join(project.loreDir, `${slug}.md`);
  await writeText(
    abs,
    `---\ntitle: ${title.trim()}\nkeywords: [${title.trim()}]\n---\n\n# ${title.trim()}\n\n（在这里写设定内容。keywords 命中续写纲要时会自动注入上下文。）\n`
  );
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(abs)));
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
      aliases: toStringArray(obj.aliases),
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

async function uniqueSlug(project: NovelProject, base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await exists(path.join(project.charactersDir, `${slug}.md`))) {
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
  return takeHead(parts.join('\n\n'), Math.max(2000, budget));
}

// ---------------------------------------------------------------- 提示词

const CHARACTER_SYSTEM = `你是小说编辑，负责从正文中提取人物档案。

请输出一个 JSON 数组，除 JSON 外不要输出任何文字、解释或 Markdown 代码块以外的内容。

数组每个元素的结构：
{
  "name": "角色的正式姓名",
  "aliases": ["别名/称呼/绰号"],
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
- 只提取有名有姓、对剧情有作用的角色，路人甲不必收录。
- 所有内容用简体中文。`;
