/**
 * 从选定的几段正文批量提取 / 更新角色卡（缺省勾最近几章，随上下文详细度）。
 *
 * - 模型给的名字是剧作称谓的（「反派（别名：韩厉）」）换成真名、称谓挪进 tags，没有真名的不建卡。
 * - 同一批先 `mergeWithinBatch` 再和已有的卡比：同名的并成一条；别名是同批另一条正式名的只去掉那个别名、
 *   两人都留（同章共现即两人，第 14 条）。
 * - 按人物、按小标题写 1 次，转写那一档照抄成数组 1 次（`TRANSCRIBED_CALLS`，解码是 `parseCharacterResponse`）；
 *   转写没成同解析不出来。
 *
 * 系统提示词在 charactersPrompt.ts。
 */
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { contextLimitsOf, takeLast } from '../model/contextDetail';
import { resolveSectionDir } from '../files/fileOps';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { readText, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, emptyCharacterSections, renderCharacterCard } from '../model/project';
import { CHARACTER_SECTION_KEYS, Chapter, CharacterCard, CharacterSections } from '../model/types';
import { LORE_PLACEHOLDER_PREFIX } from '../model/loreFile';
import { normalizeName, resolveRoleLabelName, sanitizeAliases } from '../model/naming';
import { keepGender, normalizeGender } from '../model/gender';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { stampState } from '../model/characterState';
import { CHARACTER_JSON_CONTRACT, CHARACTER_SYSTEM } from './charactersPrompt';
import { extractJsonArray, stringArray, stripCodeFence, unique } from './parse';
import { pickPlotsByInput } from './pickPlots';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { TRANSCRIBED_CALLS, describeCalls } from '../model/pipeline';
import { poolTranscriber } from './poolIO';
import { TranscribeSpec, transcribeJson } from './transcribe';

const log = scoped('角色卡');

/**
 * 从选定的章节提取/更新角色卡。
 *
 * 读的是 `chapters/` 里的正文——人物怎么说话、什么脾气只有正文里看得出，
 * 细纲里没有。所以还没写正文（0 字）的章不在候选里。
 *
 * 关键约束：**绝不静默覆盖作者手写的角色卡**。已存在的角色一律经
 * 宿主审阅（插件开 diff 编辑器，独立版弹确认框）；新角色则直接创建。
 */
export async function extractCharacters(project: NovelProject): Promise<void> {
  const written = (await project.listChapters()).filter((c) => c.wordCount > 0);
  if (written.length === 0) {
    log.warn('还没有写过正文，无法提取角色');
    getHost().toast('还没有写过正文。');
    return;
  }

  // 默认勾最近几章（上下文详细度，缺省三章）；选得越多越准，但消耗的 token 也越多。
  const config = readConfig();
  const picked = await pickPlotsByInput(
    written.map((c) => ({ no: c.order, title: c.title, chapter: c })),
    '从哪几章提取角色信息？',
    '输入章号，逗号分隔，如 1,2,3',
    takeLast(written, contextLimitsOf(config).characterChapters).map((c) => c.order)
  );
  if (!picked || picked.length === 0) {
    log.info('用户取消了章节选择');
    return;
  }
  const answer = await askCall({
    message: `提取角色卡：读第 ${picked.map((p) => p.no).join('、')} 章正文，新角色直接建卡，已有角色的更新逐个对比后再写。${describeCalls(TRANSCRIBED_CALLS)}。`,
    actions: ['开始提取'],
    tasks: ['extractCharacters', 'transcribe'],
    // 读哪几章上一步已经选定了，详细度管不着这一次。
    contextDetail: false,
  });
  if (answer?.action !== '开始提取') {
    log.info('用户取消了提取角色');
    return;
  }
  return withCallChoice(answer.choice, () => runExtract(project, picked));
}

/** 问完之后：一次调用读选定的几章，建新卡、对比已有的。 */
async function runExtract(project: NovelProject, picked: { no: number; title: string; chapter: Chapter }[]): Promise<void> {
  // 确认框之后重新读：作者挑的模型与详细度在这之后才有（features/askCall.ts）。
  const config = readConfig();
  // 一批章节一次调用，谈不上并发；走池是为了拿到「首选失败就换模型」。
  const pool = await createModelPool({ task: 'extractCharacters', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，提取中止');
    return;
  }
  const existing = await project.listCharacters();
  log.info(
    `准备从 ${picked.length} 章提取角色`,
    `章节 ${picked.map((p) => p.no).join('、')}｜已有角色卡 ${existing.length} 张｜模型 ${pool.label}`
  );

  await runTask(
    '提取角色信息',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      // 三步：读正文 → 调模型 → 合并。给 total 才画得出进度条。
      report({ message: '读取正文', current: 0, total: 3 });
      const selected = [...picked].sort((a, b) => a.no - b.no);
      // 预算跟着实际干活的模型走，不是对话页选的那个。
      const budget = pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000;
      const corpus = await buildCorpus(project, selected, budget);
      log.debug('正文已读取', `${corpus.length} 字（约 ${estimateTokens(corpus)} token）`);

      const knownList =
        existing.length > 0
          ? existing.map((c) => `- ${c.name}${c.aliases.length ? `（别名：${c.aliases.join('、')}）` : ''}`).join('\n')
          : '（暂无已有角色卡）';

      report({ message: '调用模型分析人物', current: 1, total: 3 });
      const options: StreamOptions = {
        maxOutputTokens: pool.primaryBudget.maxOutputTokens,
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };
      const modelStart = Date.now();
      const raw = await pool.run('提取角色', (llm) =>
        collectText(
          llm.stream(
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

      // 2026-10-25 起改成转写：按人物、按小标题写的档案交给转写那一档照抄成 JSON（原文本身就是 JSON 的不转）。
      // 转写没成同从前解析不出来：一张卡都不动，说一声。
      const r = await transcribeJson(raw, CHARACTERS_SPEC, poolTranscriber(signal, pool));
      if (r.notes.length > 0) {
        log.info(`提取角色：转写 ${r.calls} 次`, r.notes.join('\n'));
      }
      if (!r.ok) {
        log.warn(`没有解析出角色信息（${r.message}）`, `模型返回开头：${raw.slice(0, 300)}`);
        getHost().toast('没有从这些章节中解析出角色信息。');
        return;
      }
      const parsed = r.value;

      report({ message: `解析出 ${parsed.length} 个角色，正在合并`, current: 2, total: 3 });
      log.info(`解析出 ${parsed.length} 个角色`, parsed.map((p) => p.name).join('、'));
      await mergeCharacters(project, parsed, existing, {
        firstNo: selected[0].no,
        lastNo: selected[selected.length - 1].no,
        nos: selected.map((p) => p.no),
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
  gender?: string;
  sections: CharacterSections;
}

async function mergeCharacters(
  project: NovelProject,
  parsed: ParsedCharacter[],
  existing: CharacterCard[],
  range: { firstNo: number; lastNo: number; nos: number[] }
): Promise<void> {
  const batch = mergeWithinBatch(parsed);
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

  for (const item of batch) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (match) {
      pendingDiff.push(item);
      continue;
    }
    // 新角色：直接创建，没有可覆盖的人工内容。
    const slug = await uniqueSlug(project.charactersDir, slugify(item.name));
    // 「当前状态」是从这几章里提取的：盖章归机器（D15），写到这一批的最后一章。
    const relPath = await new Workspace(project).writeCharacter(
      stampState(
        {
          slug,
          name: item.name,
          aliases: item.aliases,
          tags: item.tags,
          gender: item.gender,
          firstAppear: range.firstNo,
          lastSeen: range.lastNo,
          // 这一批章节就是目前已知的出场记录。出场索引（定稿过的细纲）之后会给出更完整的清单，
          // 这里先落一份，免得新卡在角色页上显示「未在定稿中出现」。
          appearsIn: range.nos,
          updatedThrough: range.lastNo,
          sections: item.sections,
        },
        range.lastNo
      )
    );
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
  range: { lastNo: number; nos: number[] }
): Promise<void> {
  // 合并策略：模型有内容的小节覆盖，模型留空的保留原文；别名/标签取并集；性别卡上写了的不动。
  const merged: CharacterSections = { ...existing.sections };
  for (const key of CHARACTER_SECTION_KEYS) {
    const next = proposed.sections[key]?.trim();
    if (next && next !== '无' && next !== '（待补充）') {
      merged[key] = next;
    }
  }

  const appearsIn = [...new Set([...existing.appearsIn, ...range.nos])].sort((a, b) => a - b);
  const baseCard = {
    ...existing,
    slug: existing.slug,
    name: existing.name,
    aliases: unique(sanitizeAliases([...existing.aliases, ...proposed.aliases], existing.name)),
    tags: unique([...existing.tags, ...proposed.tags]),
    gender: keepGender(existing.gender, proposed.gender),
    firstAppear: existing.firstAppear ?? appearsIn[0],
    lastSeen: Math.max(existing.lastSeen ?? 0, range.lastNo) || range.lastNo,
    appearsIn,
    // 这次读到了哪一章，下次「更新角色卡」的增量从这里接着走。
    updatedThrough: Math.max(existing.updatedThrough ?? 0, range.lastNo),
    sections: merged,
  };
  // 模型给了新的「当前状态」才盖章（D15）；没给就沿用旧卡那一节，连同旧卡的章。
  const nextState = proposed.sections.当前状态?.trim();
  const mergedCard = nextState && nextState !== '无' && nextState !== '（待补充）' ? stampState(baseCard, range.lastNo) : baseCard;

  const proposedText = renderCharacterCard(mergedCard);
  const currentAbs = project.pathOf(existing.relPath);
  const currentText = await readText(currentAbs);

  let verdict: 'apply' | 'discard' | undefined;
  const host = getHost();
  if (host.reviewReplace) {
    verdict = plainVerdict(await host.reviewReplace(existing.name, currentText, proposedText, existing.relPath));
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
    // 作者在上面那张审阅里点了采纳：经网关写回（守卫照过、旧内容先进历史版本），`review: false`——不问第二次。
    await new Workspace(project).write(existing.relPath, { text: proposedText }, { mode: 'overwrite', review: false });
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
  const relPath = await new Workspace(project).writeCharacter({
    slug,
    name: name.trim(),
    aliases: [],
    tags: [],
    sections: emptyCharacterSections(),
  });
  await getHost().openFile(relPath);
}

/**
 * 手动新建一条设定。`dir` 同 newCharacter（目录就是分类，还不存在就一并建出来）。
 * `name` 给了就不再问标题——工程页「出现过 · 未建条目」那一行右键新建时带着名字。
 */
export async function newLore(project: NovelProject, dir?: string, name?: string): Promise<void> {
  const target = resolveSectionDir(project, 'lore', dir);
  const root = project.relPath(project.loreDir);
  const title =
    name?.trim() ||
    (await getHost().input({
      title: '新建设定条目',
      prompt: target === root ? '设定标题（如「玄门七宗」）' : `设定标题（建到 ${target}/）`,
      validate: (v) => (v.trim() ? undefined : '不能为空'),
    }));
  if (!title) {
    return;
  }
  const prefix = target === root ? '' : `${target.slice(root.length + 1)}/`;
  const slug = await uniqueSlug(project.loreDir, `${prefix}${slugify(title)}`);
  const rel = `${root}/${slug}.md`;
  // 经网关新建（`create`：同名报错退出、不覆盖——上面挑过不撞名的 slug，撞上只可能是这一瞬间别处刚建了同名的）。
  await new Workspace(project).write(
    rel,
    {
      text:
        `---\ntitle: ${title.trim()}\nkeywords: [${title.trim()}]\n---\n\n# ${title.trim()}\n\n` +
        `${LORE_PLACEHOLDER_PREFIX}：它是什么、有什么规则与边界、现在是什么状态。frontmatter 里可以加一行 brief 写一句话简介，` +
        '名录里那一行显示它；keywords 写它的别称，正文或细纲里提到时会自动带进上下文。）\n',
    },
    { mode: 'create' }
  );
  await getHost().openFile(rel);
}

// ---------------------------------------------------------------- 解析

/**
 * 提取角色转写那一步（2026-10-25 起改成转写）：合同是 {@link CHARACTER_JSON_CONTRACT}，解码就是下面的
 * {@link parseCharacterResponse}（剧作称谓换真名那些后处理都在里面）。一个人都整理不出来算不合格；性别按对应关系填，
 * 不比原文；原文连「身份」「性格」这几节都没有的不转。
 */
const CHARACTERS_SPEC: TranscribeSpec<ParsedCharacter[]> = {
  label: '提取角色',
  contract: CHARACTER_JSON_CONTRACT,
  decode: (json) => {
    const list = parseCharacterResponse(json);
    return list.length > 0 ? { ok: true, value: list } : { ok: false, message: '一个人物都整理不出来：要一个数组，每项带 name' };
  },
  mapped: ['性别', 'gender'],
  looksLike: (source) => /身份|性格|语言习惯|当前状态/.test(source),
};

/**
 * 解析模型返回（转写出来的、或模型直接给的 JSON 数组）；解析失败时返回空数组由调用方提示，
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
    // 「反派（别名：韩厉）」：称谓不是名字，换成别名里的真名、称谓挪进 tags；别名里没有真名的不建卡。
    const resolved = resolveRoleLabelName(name, sanitizeAliases(unique(stringArray(obj.aliases)), name));
    if (!resolved) {
      log.warn(`「${name}」是剧作称谓，别名里也没有真名，不建卡`);
      continue;
    }
    if (resolved.label) {
      log.info(`「${resolved.label}」是剧作称谓，改用别名里的「${resolved.name}」`);
    }
    out.push({
      name: resolved.name,
      aliases: resolved.aliases,
      tags: unique([...stringArray(obj.tags), ...(resolved.label ? [resolved.label] : [])]),
      gender: normalizeGender(obj.性别 ?? obj.gender),
      sections,
    });
  }
  return out;
}

/**
 * 同一次返回里的条目先互相对一遍，再去和已有的卡比。
 *
 * - **同名的并成一条**：别名、标签取并集，小节以先出现的为准、空的用后一条补，性别同理。
 *   「反派（别名：韩厉）」换名之后就是第二个「韩厉」，不并会建出 `韩厉.md` 与 `韩厉-2.md`。
 * - **别名是同一批另一条的正式名，删掉这个别名，不并**：模型把两个人列成两条，就是认为
 *   他们是两个人（与「同章共现即两人」同一个道理，AGENTS 第 14 条）；那个别名才是错的——
 *   实战里方源的卡挂过孪生弟弟「方正」，按别名并会把方正整个人吞掉。
 */
export function mergeWithinBatch(parsed: readonly ParsedCharacter[]): ParsedCharacter[] {
  const out: ParsedCharacter[] = [];
  for (const item of parsed) {
    const same = out.find((p) => normalizeName(p.name) === normalizeName(item.name));
    if (!same) {
      out.push({ ...item, aliases: [...item.aliases], tags: [...item.tags], sections: { ...item.sections } });
      continue;
    }
    same.aliases = sanitizeAliases(unique([...same.aliases, ...item.aliases]), same.name);
    same.tags = unique([...same.tags, ...item.tags]);
    same.gender = keepGender(same.gender, item.gender);
    for (const key of CHARACTER_SECTION_KEYS) {
      if (!same.sections[key]?.trim() && item.sections[key]?.trim()) {
        same.sections[key] = item.sections[key];
      }
    }
    log.info(`同一批里「${item.name}」出现了两次，已并成一条`);
  }
  const names = new Set(out.map((p) => normalizeName(p.name)));
  for (const item of out) {
    const borrowed = item.aliases.filter((a) => names.has(normalizeName(a)) && normalizeName(a) !== normalizeName(item.name));
    if (borrowed.length > 0) {
      item.aliases = item.aliases.filter((a) => !borrowed.includes(a));
      log.warn(`「${item.name}」的别名 ${borrowed.join('、')} 是同一批另一个人的名字，已去掉`);
    }
  }
  return out;
}

async function buildCorpus(
  project: NovelProject,
  items: { no: number; title: string; chapter: Chapter }[],
  budget: number
): Promise<string> {
  const parts: string[] = [];
  for (const item of items) {
    const text = await project.readChapterText(item.chapter);
    parts.push(`【第${item.no}章 ${item.title}】\n${text}`);
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
