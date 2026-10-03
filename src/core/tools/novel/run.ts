/**
 * `run` —— 工程动作。**既有流程的一个口子，不是新的实现。**
 *
 * ## 为什么要有它
 *
 * 批量排细纲、批量写正文、定稿、同步摘要这些动作背着一批 agent 不该知道的
 * 不变量：批量路径要**跳过已有产物**、要用不带全文兜底的严格解析（第 19 条）；
 * 正文落盘要在细纲上记 `writtenFrom`（第 18 条）。让它拿着 `write` 自己拼，等于把
 * 这些不变量交给一个每次都可能记错的东西去执行。
 *
 * 所以这里是**白名单 + 转发**：每个 action 就是工程页那颗按钮背后的同一个
 * 函数，一个字都不重写。
 *
 * ## 确认框照弹，不给 agent 绕过去的快路
 *
 * 批量动作自带的确认框（写明「有 N 章还没排细纲，需要调用 N 次模型」）在
 * agent 这条路上**照样弹**（第 4 条）。**这一期没有为 agent 加任何一条绕过它
 * 的路。** 那些数字同时经 `usage.record` 报给调用方——弹窗写着 7 次、账上记 1 次，
 * 正是第 4 条要防的事，所以次数只在 feature 自己那里算一次，由返回值带回来。
 *
 * ## 明确不给的动作
 *
 * | 不给 | 为什么 |
 * |---|---|
 * | `delete` / `remove`（任何形式） | 作者要删东西会自己删。给 agent 一个删除工具，收益接近零而风险是丢内容——即使进了 `.trash/`，作者也未必知道它删过什么 |
 * | `rename` / `move` | 细纲的文件名由章号与标题决定、章节是作者的文件（第 7 条），一次误操作的收拾成本远高于收益 |
 * | `initProject` | 一个空工程被 agent 初始化一遍，作者的配置就没了 |
 * | `newChapter` | 正常路径上章节是写正文时生成的，不该由 agent 直接建一个空文件 |
 * | 卸载技能 | 与删除同理；作者在设置页「技能」里自己卸 |
 *
 * ## 写作技能的四个动作
 *
 * 移植自 AI-Novel-Writer 的三个工具（`inspect_writing_skill` / `install_writing_skill` /
 * `bind_writing_skill`），**并进这里而不是另加工具**——工具数是硬约束（`index.ts`）。多了一个
 * `listSkills`：上游的模型从工具列表里就看得见内置技能，这里看不见，得有个地方查 id。
 *
 * 闸门按动作分（`intent` 里）：查与检查是 `auto`（不花钱、不写东西）；**安装与绑定是 `always`**，
 * 动手前先问一句——上游这两个都 `requiresConfirmation`，而它们改的东西（我的技能库、这个
 * 工程往后每一次生成的提示词）下游没有任何 diff 可看。检查结果来自不受信任的第三方文档，
 * 回给模型的话里说清这一点。
 *
 * ## 拆书的三个动作
 *
 * `importManuscript` / `deriveFromText` / `learnFromReference` 都是工程页那颗按钮背后的同一个函数。
 * `importManuscript` 会新建章节文件——与上面不给的 `newChapter` 不同，它建的是作者自己那本 txt 里的
 * 章，切分结果先在确认框里给作者看，同名一律不覆盖。两个要 `path` 的动作只认工程里的 txt
 * （`features/bookText.ts` 的那张清单），不认章节文件、隐藏目录与工程外的路径。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { bool, int, objectSchema, str } from '../schema';
import { clip, text } from './naming';
import { newPlotFlow } from '../../actions';
import { completeSettings, generatePlots, writeManuscripts } from '../../features/pipelineBatch';
import { chapterForSummary, syncSummaries } from '../../features/summarize';
import { describeFinalize, finalizeChapter } from '../../features/finalize';
import { createCardForCast, updateCharacterCard } from '../../features/characterCard';
import { extractStyle } from '../../features/style';
import { importManuscript } from '../../features/importManuscript';
import { deriveFromText } from '../../features/derive';
import { learnFromReference } from '../../features/reference';
import { generateLore } from '../../features/lore';
import { generateThreads } from '../../features/threads';
import { describeError } from '../../runtime/logger';
import { PLOT_BATCH, WRITE_BATCH_DEFAULT, WriteBatchMode, isWriteBatchMode } from '../../model/pipeline';
import {
  SKILL_SOURCE_LABEL,
  SKILL_STAGES,
  SKILL_STAGE_LABEL,
  SkillStage,
  describeIncompat,
  isSkillStage,
  skillLabel,
} from '../../model/writingSkill';
import {
  inspectGitHubSkill,
  inspectedGitHubSkill,
  installGitHubSkill,
  listSkills,
  readSkillBindings,
  saveSkillBinding,
} from '../../skills';

/** 一次动作的结果：说给模型听的一句话 + 这一下花了几次模型调用。 */
interface ActionResult {
  text: string;
  /** 报给调用方记账的次数。0 = 一次模型都没调（取消 / 无事可做）。 */
  calls: number;
}

interface ActionSpec {
  /** 界面上与错误提示里的说法。 */
  label: string;
  /** 会不会调模型。只用于工具描述，闸门由 feature 自己的确认框把。 */
  costly: boolean;
  /** 这个动作要哪个参数（缺了就当场报错，不放它跑一趟空的）。 */
  needsField?: 'path' | 'name' | 'url';
  /** 参数说明，进工具描述。 */
  needs?: string;
  /**
   * 认哪几个可选参数。没列的给了就当场报错——模型以为自己传了一个区间、其实被忽略，
   * 比多一次往返更糟（`objectSchema` 的 `additionalProperties: false` 同一个道理）。
   */
  takes?: { range?: number; mode?: boolean; stage?: boolean };
  run(ctx: ToolContext, args: RunArgs): Promise<ActionResult>;
}

interface RunArgs {
  path: string;
  name: string;
  /** 技能的 GitHub 地址（inspectSkill / installSkill）。 */
  url: string;
  /** 技能绑到哪个阶段（bindSkill）。 */
  stage?: SkillStage;
  /** 章号区间。只给了 `from` 时按动作的缺省长度补齐 `to`（`takes.range`）。 */
  range?: { from: number; to: number };
  mode?: WriteBatchMode;
  review?: boolean;
}

const ACTIONS: Record<string, ActionSpec> = {
  // ---- 不花钱的
  newPlot: {
    label: '新建一章的细纲骨架（接在最后一章之后）',
    costly: false,
    async run(ctx) {
      const rel = await newPlotFlow(ctx.project);
      return { text: `已新建 ${rel}（空骨架，还没有细纲内容）。`, calls: 0 };
    },
  },

  // ---- 花钱的：确认框全在 feature 自己那里，这里只转发
  completeSettings: {
    label: '补齐故事架构（小说配置 / 故事前提 / 角色图谱 / 世界观，只补空白）',
    costly: true,
    async run(ctx) {
      return countedBy(await completeSettings(ctx.project), '补齐故事架构', '四件都已经有了，或者小说配置还没有「一句话」可以展开');
    },
  },
  summarize: {
    label: '给某一章定稿（摘要与连续性事实，再更新出场角色的当前状态、记下本章推进了哪几条叙事线）',
    costly: true,
    needsField: 'path',
    needs: 'path=那一章的章节路径或细纲路径',
    async run(ctx, args) {
      const chapter = await chapterForSummary(ctx.project, args.path);
      if (!chapter) {
        throw new Error(`${args.path} 这一章还没有正文，没有可定稿的东西。摘要描述的是写出来的那一章。`);
      }
      const outcome = await finalizeChapter(ctx.project, chapter, { signal: ctx.signal });
      return outcome
        ? { text: describeFinalize(chapter.order, outcome), calls: outcome.calls }
        : {
            text: `第 ${chapter.order} 章没有定稿（没有可用的模型，或这一章是空的）。`,
            calls: 0,
          };
    },
  },
  syncSummaries: {
    label: '补齐所有缺失/过期的摘要',
    costly: true,
    async run(ctx) {
      return countedBy(await syncSummaries(ctx.project), '摘要同步');
    },
  },
  batchPlots: {
    label: `批量拆细纲（缺省从下一个该写的章起 ${PLOT_BATCH} 章；已有细纲的章跳过）`,
    costly: true,
    takes: { range: PLOT_BATCH },
    async run(ctx, args) {
      return countedBy(await generatePlots(ctx.project, { range: args.range }), '批量拆细纲');
    },
  },
  batchManuscripts: {
    label: `批量写章，一章一章串行写（缺省从下一个该写的章起 ${WRITE_BATCH_DEFAULT} 章、只写正文；已有正文的章跳过）`,
    costly: true,
    takes: { range: WRITE_BATCH_DEFAULT, mode: true },
    async run(ctx, args) {
      return countedBy(
        await writeManuscripts(ctx.project, { range: args.range, mode: args.mode, review: args.review }),
        '批量写章'
      );
    },
  },
  generateThreads: {
    label: '从细纲排出叙事线（跨章的伏笔与线索，追加到 .novelforge/threads.md 末尾；已有的不动、同名跳过）',
    costly: true,
    async run(ctx) {
      return countedBy(await generateThreads(ctx.project), '排叙事线', '还没有细纲可排');
    },
  },
  updateCard: {
    label: '按新出场的章增量更新一张角色卡',
    costly: true,
    needsField: 'path',
    needs: 'path=那张角色卡的路径',
    async run(ctx, args) {
      await updateCharacterCard(ctx.project, args.path, 'incremental');
      return { text: `已处理角色卡 ${args.path}（实际调用次数见确认框与日志）。`, calls: 1 };
    },
  },
  createCard: {
    label: '给一位还没有卡的出场人物建卡',
    costly: true,
    needsField: 'name',
    needs: 'name=那个人的名字（与摘要里的出场人物一致）',
    async run(ctx, args) {
      await createCardForCast(ctx.project, args.name);
      return { text: `已处理「${args.name}」的角色卡（实际调用次数见确认框与日志）。`, calls: 1 };
    },
  },
  extractStyle: {
    label: '从已写的正文里提取文风指南',
    costly: true,
    async run(ctx) {
      await extractStyle(ctx.project);
      return { text: '文风指南已处理（覆盖前会先问作者）。', calls: 1 };
    },
  },
  generateLore: {
    label: '通读正文生成设定条目',
    costly: true,
    async run(ctx) {
      await generateLore(ctx.project);
      return { text: '设定生成已处理（实际调用次数见确认框与日志）。', calls: 1 };
    },
  },

  // ---- 拆书（导入原稿、从已写正文补齐、从参考书学写法）
  importManuscript: {
    label: '导入原稿：把工程里的一本 txt 按章标题切成章节，接在已有章节之后（切分结果先给作者看；导入本身不调模型，导入完作者可以选择接着从已写正文补齐）',
    costly: true,
    needsField: 'path',
    needs: 'path=工程里那本 txt 的相对路径',
    async run(ctx, args) {
      const r = await importManuscript(ctx.project, { path: args.path });
      if (r.imported === 0) {
        return {
          text: '这一次没有导入：要么作者取消了，要么认不出章节标题（每章开头要有单独一行「第一章 xxx」）。不要重试同一个动作——先问作者。',
          calls: 0,
        };
      }
      return {
        text:
          `已导入 ${r.imported} 章。` +
          (r.calls > 0 ? `作者接着从已写正文补齐了，调用模型 ${r.calls} 次，结果见工程页。` : '作者没有接着补齐；需要时用 deriveFromText。'),
        calls: r.calls,
      };
    },
  },
  deriveFromText: {
    label: '从已写正文补齐：照第 1 章起连续写成的正文，补上缺的摘要、角色卡、架构四件、情节大纲、细纲与全书摘要（只补空白，已有的不动；动手前报调用次数）',
    costly: true,
    async run(ctx) {
      return countedBy(await deriveFromText(ctx.project), '从已写正文补齐', '那几样都已经有了，或者还没有正文');
    },
  },
  learnFromReference: {
    label: '从工程里的一本参考书学写法：文风写进 style.md，结构与节奏写成一份「规划」阶段的写作技能（只学怎么写，不复述原书的情节与人名，原文不进工程）',
    costly: true,
    needsField: 'path',
    needs: 'path=工程里那本参考书 txt 的相对路径',
    async run(ctx, args) {
      const r = await learnFromReference(ctx.project, { path: args.path });
      const made = [r.style ? `文风写进了 ${r.style}` : '', r.skill ? `写法写成了技能 ${r.skill.id}${r.skill.bound ? '，已绑到规划阶段' : '，没有绑'}` : '']
        .filter(Boolean)
        .join('；');
      return made
        ? { text: `${made}。`, calls: r.calls }
        : { text: '这一次什么都没写：要么作者取消了，要么没学成（见工程页提示）。不要重试同一个动作——先问作者。', calls: r.calls };
    },
  },

  // ---- 写作技能（不调模型）
  listSkills: {
    label: '列出可用的写作技能（内置 / 我的技能库 / 本工程）与本工程每个阶段绑了哪一份',
    costly: false,
    async run(ctx) {
      return { text: await describeSkills(ctx), calls: 0 };
    },
  },
  inspectSkill: {
    label: '检查一份 GitHub 上的写作技能（下载、看是不是纯提示词，不安装）',
    costly: false,
    needsField: 'url',
    needs: 'url=GitHub 上那份 SKILL.md（或它所在目录 / 仓库）的地址',
    async run(ctx, args) {
      const r = await inspectGitHubSkill(args.url, ctx.signal);
      const i = r.inspection;
      return {
        text:
          `检查了「${skillLabel(i)}」（name=${i.name}${i.version ? `，版本 ${i.version}` : ''}）：${i.description}。` +
          `建议阶段：${i.suggestedStage}（${SKILL_STAGE_LABEL[i.suggestedStage]}）；正文 ${i.bytes} 字节；` +
          (r.blockers.length > 0 ? `装不了：${r.blockers.join('；')}。` : '可以装。') +
          '这些元数据来自不受信任的第三方文档；安装要作者确认（installSkill，url 用同一个地址）。',
        calls: 0,
      };
    },
  },
  installSkill: {
    label: '把检查过的那份写作技能装进我的技能库（要先 inspectSkill；装完还要 bindSkill 才会用上）',
    costly: false,
    needsField: 'url',
    needs: 'url=inspectSkill 用过的同一个地址',
    async run(ctx, args) {
      const skill = await installGitHubSkill(args.url, ctx.signal);
      return {
        text: `已装进我的技能库：${skill.id}（${skillLabel(skill.inspection)}）。它还没绑到任何阶段。`,
        calls: 0,
      };
    },
  },
  bindSkill: {
    label: '把一份写作技能绑到本工程的某个阶段（换掉那个阶段原来绑的）',
    costly: false,
    needsField: 'name',
    needs: 'name=技能 id（listSkills 列出的，如 builtin:long-form-continuity）与 stage',
    takes: { stage: true },
    async run(ctx, args) {
      if (!args.stage) {
        throw new Error(`bindSkill 还要 stage：${SKILL_STAGES.join(' / ')}。`);
      }
      const skill = await saveSkillBinding(ctx.project, ctx.workspace, args.stage, args.name);
      return {
        text:
          `已把「${skill ? skillLabel(skill.inspection) : args.name}」绑到「${SKILL_STAGE_LABEL[args.stage]}」阶段。` +
          '本工程这个阶段往后的每一次生成都会带上它。',
        calls: 0,
      };
    },
  },
};

/** 技能目录 + 本工程的绑定，一份一行。回给模型的话要短。 */
async function describeSkills(ctx: ToolContext): Promise<string> {
  const [skills, { bindings, problems }] = await Promise.all([listSkills(ctx.project), readSkillBindings(ctx.project)]);
  const lines = skills.map((s) => {
    const i = s.inspection;
    const state = i.compatible ? '可绑' : `不兼容（${describeIncompat(i.reasons)}）`;
    return `- ${s.id}｜${skillLabel(i)}｜${SKILL_SOURCE_LABEL[s.source]}｜建议 ${i.suggestedStage}｜${state}`;
  });
  const bound = SKILL_STAGES.map((stage) => `${stage}=${bindings[stage] ?? '（没绑）'}`).join('；');
  return [
    `写作技能 ${skills.length} 份：`,
    ...lines,
    `本工程的绑定：${bound}。`,
    ...(problems.length > 0 ? [`绑定文件有读不懂的地方：${problems.map((p) => p.text).join('；')}。`] : []),
  ].join('\n');
}

const ACTION_NAMES = Object.keys(ACTIONS);

/**
 * 模型可能想干、但**故意不给**的动作。认出来单独回一句为什么，
 * 好过让它在「可用动作」里翻半天再猜一个。
 */
const REFUSED: Record<string, string> = {
  delete: '删除',
  remove: '删除',
  trash: '删除',
  rename: '改名',
  move: '移动',
  initProject: '初始化工程',
  newChapter: '直接新建章节文件',
  split: '拆分正文',
  uninstallSkill: '卸载技能',
  deleteSkill: '卸载技能',
};

export const runTool: ToolDef = {
  name: 'run',
  // 大多数动作会调模型（而且是几十次那种）。
  costly: true,
  mutating: true,

  /**
   * 常规的「动手前问一句」。**框里要提醒他后面还有一个框**：批量动作自带的
   * 那个写着「预计调用 N 次」，在任何策略下都弹（第 25 条），作者在那一步
   * 仍然可以不同意。
   */
  intent(args): ToolIntent {
    const action = text(args.action);
    const skillIntent = skillIntentOf(action, args);
    if (skillIntent) {
      return skillIntent;
    }
    const target = text(args.path) || text(args.name);
    // 区间与模式写进框里：「批量写章」与「把第 5–8 章写完并定稿」是两件分量很不一样的事。
    const from = toInt(args.from);
    const to = toInt(args.to);
    const scope = [
      from !== undefined ? (to !== undefined && to !== from ? `第 ${from}–${to} 章` : `从第 ${from} 章起`) : '',
      args.mode === 'finalize' ? '写完即定稿' : '',
      args.review === true ? '写完即审稿' : '',
    ]
      .filter(Boolean)
      .join('，');
    return {
      gate: 'mutating',
      title: `执行工程动作 ${action}`,
      detail: [target, scope, '要调模型的动作随后还会告诉你预计调用几次，那一步你也可以不同意。']
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '执行一个工程动作。这些动作背着一批固定流程（批量动作只补空白不覆盖已有产物、' +
    '正文落盘要在细纲上记指纹），所以走这个口子，不要自己用 write 拼。' +
    '可用的 action：' +
    ACTION_NAMES.map((a) => `${a}=${ACTIONS[a].label}${ACTIONS[a].costly ? '（调模型）' : '（不调模型）'}`).join('；') +
    '。' +
    '要参数的几个：' +
    ACTION_NAMES.filter((a) => ACTIONS[a].needs).map((a) => `${a} 要 ${ACTIONS[a].needs}`).join('；') +
    '。' +
    '**连续多章的同类工作用这里的批量动作**（batchPlots / batchManuscripts），' +
    '比一章一章 generate 省钱，而且有进度条、能停、失败的会挂在那一章上。' +
    '这两个可以用 from / to 指定章号区间（只给 from 时按缺省章数往后数）；' +
    'batchManuscripts 另可给 mode=finalize（每写完一章就定稿）与 review=true（每写完一章先审稿，报告放进一个新会话）。' +
    '调模型的动作会先弹一个确认框告诉作者要调用几次，他可以不同意。' +
    '写作技能：listSkills 查有哪些、每个阶段绑了哪份；装 GitHub 上的一份要先 inspectSkill 再 installSkill（同一个 url），' +
    '装完用 bindSkill（name=技能 id，stage=阶段）绑上才会用上。安装与绑定每次都会先问作者。' +
    '作者有写好的稿子要接上来：txt 放在工程里，用 importManuscript（path=那本 txt）导入，再 deriveFromText 从已写正文补齐；' +
    '要学别人的书怎么写：learnFromReference（path=那本 txt）。' +
    '删除、改名、移动、新建空章节文件、卸载技能都没有——那些由作者自己做。',

  parameters: objectSchema(
    {
      action: str('要执行哪个动作。', ACTION_NAMES),
      path: str('动作的作用对象，工程内相对路径。只有部分动作要（importManuscript / learnFromReference 要那本 txt 的路径）。'),
      name: str('createCard 要人物名字；bindSkill 要技能 id（listSkills 列出的）。'),
      url: str('写作技能的 GitHub 地址，只有 inspectSkill / installSkill 要。'),
      stage: str(
        '技能绑到哪个阶段，只有 bindSkill 要：planning=架构 / 大纲 / 细纲，drafting=写正文，review=审稿，refinement=修稿。',
        [...SKILL_STAGES]
      ),
      from: int('章号区间的起点，只有 batchPlots / batchManuscripts 认。留空从下一个该写的章起。'),
      to: int('章号区间的终点（含），只有 batchPlots / batchManuscripts 认。要给就同时给 from。'),
      mode: str(
        '批量写章的模式，只有 batchManuscripts 认：draft=只写正文（缺省），finalize=每写完一章就定稿（摘要 + 出场角色的当前状态）。',
        ['draft', 'finalize']
      ),
      review: bool('每写完一章先审稿，只有 batchManuscripts 认。缺省 false。'),
    },
    ['action']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (!action) {
      return { text: '', error: `action 是必填的。可用的是：${ACTION_NAMES.join(' / ')}。` };
    }
    if (REFUSED[action]) {
      return {
        text: '',
        error:
          `没有${REFUSED[action]}这个动作，而且这是有意的——那类操作由作者自己做。` +
          `可用的是：${ACTION_NAMES.join(' / ')}。`,
      };
    }
    const spec = ACTIONS[action];
    if (!spec) {
      return {
        text: '',
        error: `认不出动作「${action}」。可用的是：${ACTION_NAMES.join(' / ')}。`,
      };
    }

    const runArgs: RunArgs = {
      path: typeof args.path === 'string' ? args.path.trim() : '',
      name: typeof args.name === 'string' ? args.name.trim() : '',
      url: typeof args.url === 'string' ? args.url.trim() : '',
    };
    if (spec.needsField && !runArgs[spec.needsField]) {
      return { text: '', error: `${action} 需要参数：${spec.needs}。` };
    }
    const extra = readExtras(action, spec, args);
    if ('error' in extra) {
      return { text: '', error: extra.error };
    }
    Object.assign(runArgs, extra);

    try {
      const r = await spec.run(ctx, runArgs);
      // 次数由 feature 自己算一次再报回来。弹窗写着 7 次、账上记 1 次，
      // 正是第 4 条要防的事。
      ctx.usage.record(r.calls);
      if (r.calls > 0) {
        ctx.report(`${spec.label}：调用模型 ${r.calls} 次`);
      }
      return {
        text: r.text,
        display: { title: `run ${action}`, detail: r.calls > 0 ? `${r.calls} 次调用` : '未调模型' },
      };
    } catch (err) {
      return { text: '', error: `${spec.label}失败：${describeError(err)}` };
    }
  },
};

/**
 * 区间与模式这几个可选参数：只给认它们的动作，值不对当场说清楚。
 *
 * 区间不在这里截到总章数、大纲覆盖或批量上限——那些由 feature 自己按磁盘算，确认框里写着
 * 实际要处理哪几章（同一个 `planPlotBatches` / `planWriteBatch`）。
 */
function readExtras(
  action: string,
  spec: ActionSpec,
  args: Record<string, unknown>
): Pick<RunArgs, 'range' | 'mode' | 'review' | 'stage'> | { error: string } {
  const from = toInt(args.from);
  const to = toInt(args.to);
  const hasRange = args.from !== undefined || args.to !== undefined;
  const hasMode = args.mode !== undefined || args.review !== undefined;
  if (hasRange && !spec.takes?.range) {
    return { error: `${action} 不认 from / to，只有 batchPlots / batchManuscripts 认。` };
  }
  if (hasMode && !spec.takes?.mode) {
    return { error: `${action} 不认 mode / review，只有 batchManuscripts 认。` };
  }
  if (args.stage !== undefined && !spec.takes?.stage) {
    return { error: `${action} 不认 stage，只有 bindSkill 认。` };
  }
  if (args.url !== undefined && spec.needsField !== 'url') {
    return { error: `${action} 不认 url，只有 inspectSkill / installSkill 认。` };
  }

  const out: Pick<RunArgs, 'range' | 'mode' | 'review' | 'stage'> = {};
  if (args.stage !== undefined) {
    if (!isSkillStage(args.stage)) {
      return { error: `stage 只能是 ${SKILL_STAGES.join(' / ')}。` };
    }
    out.stage = args.stage;
  }
  if (hasRange) {
    if (from === undefined) {
      return {
        error: args.from === undefined ? '给了 to 就要同时给 from（章号区间的起点）。' : 'from / to 要填章号（正整数）。',
      };
    }
    if (args.to !== undefined && to === undefined) {
      return { error: 'from / to 要填章号（正整数）。' };
    }
    const end = to ?? from + spec.takes!.range! - 1;
    if (from < 1 || end < from) {
      return { error: `章号区间不对：第 ${from}–${end} 章。from 从 1 起，to 不能小于 from。` };
    }
    out.range = { from, to: end };
  }
  if (args.mode !== undefined) {
    if (!isWriteBatchMode(args.mode)) {
      return { error: 'mode 只能是 draft（只写正文）或 finalize（写完即定稿）。' };
    }
    out.mode = args.mode;
  }
  if (args.review !== undefined) {
    out.review = args.review === true;
  }
  return out;
}

/**
 * 技能动作的确认框。**零 I/O**：检查结果在进程里那张表上（`inspectedGitHubSkill`），确认框据此
 * 说清装的是哪一份、写了什么——上游的确认卡只显示一个地址。
 */
function skillIntentOf(action: string, args: Record<string, unknown>): ToolIntent | undefined {
  switch (action) {
    case 'listSkills':
      return { gate: 'auto', title: '查看有哪些写作技能、本工程每个阶段绑了哪一份' };
    case 'inspectSkill':
      return { gate: 'auto', title: '检查一份 GitHub 上的写作技能（只下载来看，不安装）', detail: text(args.url) };
    case 'installSkill': {
      const url = text(args.url);
      const seen = inspectedGitHubSkill(url);
      if (!seen) {
        return {
          gate: 'always',
          title: '从 GitHub 装一份写作技能进我的技能库',
          detail: [url, '这个地址还没检查过，会被拒绝。'].join('\n'),
        };
      }
      const i = seen.inspection;
      return {
        gate: 'always',
        title: `把写作技能「${skillLabel(i)}」装进我的技能库`,
        detail: [
          url,
          `${i.description}（建议阶段：${SKILL_STAGE_LABEL[i.suggestedStage]}；${i.bytes} 字节）`,
          seen.blockers.length > 0 ? `装不了：${seen.blockers.join('；')}` : '',
          `正文开头：${clip(i.body, 200)}`,
          '装完还不会用上：要再绑到某个阶段。',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'bindSkill': {
      const stage = isSkillStage(args.stage) ? SKILL_STAGE_LABEL[args.stage] : text(args.stage) || '（没给阶段）';
      return {
        gate: 'always',
        title: `把写作技能 ${text(args.name) || '（没给 id）'} 绑到「${stage}」阶段`,
        detail: '本工程这个阶段往后的每一次生成（对话页、agent、工程页批量）都会带上它；原来绑的那一份会被换掉。',
      };
    }
    default:
      return undefined;
  }
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * feature 报回来的「计划调用几次」→ 一句话 + 记账。
 *
 * **0 次要说清楚**：作者取消了，或者压根没有待处理的东西。不说的话模型会以为
 * 是自己参数填错了，然后原地再发一遍——那正是无进展检测要拦的事。
 */
function countedBy(calls: number, what: string, idle = '没有待处理的章'): ActionResult {
  if (calls <= 0) {
    return {
      text:
        `${what}这一次没有调用模型：要么作者在确认框里取消了，要么${idle}。` +
        '不要重试同一个动作——先用 list 或 read 看看现在的状态。',
      calls: 0,
    };
  }
  return { text: `${what}已执行，计划调用模型 ${calls} 次。结果见工程页与日志。`, calls };
}
