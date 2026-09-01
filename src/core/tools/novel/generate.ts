/**
 * `generate` —— 「agent 只做上层调度，实际生成通过工具调用」的落点。
 *
 * ## 五件必须做对的事
 *
 * 1. **产物绝不回灌 agent 上下文**。返回文本里只有形状与 draftId，**没有
 *    正文**。一份三千字的正文塞回循环，agent 每走一步就重烧一遍——十步之后
 *    这一份正文被算了十次钱。要看内容让它显式 `read`。
 * 2. **`history` 传空数组**。agent 的工具调用不是作者的讨论，混进装配器会被
 *    当成创作要求装进 prompt（「用户刚才说：list .novelforge/plots」）。
 * 3. **哪一层用哪个模型**，AGENTS 第 12 条的延伸：
 *
 *    | 层 | 用哪个模型 | 为什么 |
 *    |---|---|---|
 *    | `manuscript` | **对话页选定的那个**，不走池 | 中途换人会让文风断掉 |
 *    | `outline` | 同上 | 一次定调，而且没有对应档位 |
 *    | `volume` | 同上 | 一卷定调，同样没有对应档位 |
 *    | `plot` | `plotOutline` 档 | 与工程页「批量写剧情」同一个模型 |
 *
 *    表按**层**列（`stageOfJob` 算出来的那个），不按 job：拆卷与写大纲同属
 *    大纲层，用哪个模型这件事上它们没有分别。
 *
 *    走池时**必须把池的 `primaryBudget` 一起传下去**（第 13 条）：
 *    `config.contextWindow` 跟着对话页那个模型走，拿 200k 的窗口给快速档的
 *    32k 模型装配上下文会稳定超窗。
 * 4. **流式内容照旧推给前端**：作者看得见 agent 在写什么，而不是盯着一个
 *    「正在生成」转十几秒（第 11 条：不闷着干活）。
 * 5. **发请求之前先 `usage.record(1)`**（第 4 条：不偷偷烧 token）。记在前面是
 *    因为**请求发出去钱就花了**——中途抛异常、被取消，那一次照样收费。等函数
 *    返回再记，异常那条路上的钱就丢账了。**这里只报数，不判断触没触顶**：
 *    上限是调用方的事，工具连「上限是多少」都不知道。
 *
 * 6. **写作方法由这里读，不在装配器里读**。`skills` 参数收到的是几个名字，
 *    正文在这一层读好、递进 `BuildRequest.skills`。放在这里而不是往下推一层，
 *    是因为**名字错了要在花钱之前就说**：到了装配器，这一次生成已经开始了。
 *    读不到就整次拒绝，不静默丢掉——agent 是刻意点名的，默默不带等于让作者
 *    付了钱却没用上他要的写法。
 *
 * ## 落点从路径反推，产出什么由 job 说
 *
 * `kindOfPath` 一次给出 `stage` 与 `target`，不必让模型填 `{kind, chapterNo}`
 * 那种嵌套结构——路径是产物在这个工程里的身份，作者在文件管理器里看到的
 * 就是它。
 *
 * 两个参数各管一件事，**并且互相校验**：`job` 说产出什么形状的东西，`target`
 * 说落在哪。两者必须落在同一层——`job=plotSegment` 是从一卷的卷纲里拆段，
 * 给它一个细纲路径就是矛盾的，那时报错而不是猜。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { int, objectSchema, str, strArray } from '../schema';
import { clip, describePath, text } from './naming';
import { generate } from '../../generation/generate';
import type { SkillText } from '../../context/types';
import { readConfig } from '../../config';
import { listGenerateSkills, listSkills, readSkill, skillRelPath } from '../../skills';
import { createModelPool } from '../../llm/pool';
import type { LlmProvider } from '../../llm/provider';
import { scoped } from '../../runtime/logger';
import type { LlmTask } from '../../model/tiers';
import { kindOfPath } from '../../workspace';
import {
  CREATION_JOBS,
  CreationJob,
  CreationStage,
  JOB_HINT,
  JOB_LABEL,
  STAGE_LABEL,
  isCreationJob,
  stageOfJob,
} from '../../model/pipeline';

const log = scoped('Agent');

/**
 * 哪一层走哪一档。**列在这里的才走池**——不在表里的（正文、大纲、卷纲）严格用
 * 对话页选定的那个模型，不走池、不 fallback（第 12 条）。
 *
 * 导出是给「生成」页用的（`controller/generate.ts`）：那一页是这个工具的手动
 * 入口，两处必须用同一张表——各写一份的话，手动生成与 agent 生成会在某一天
 * 悄悄用上不同的模型，而账单上看不出是谁决定的。
 */
export const STAGE_TIER_TASK: Partial<Record<CreationStage, LlmTask>> = {
  plot: 'plotOutline',
};

export const generateTool: ToolDef = {
  name: 'generate',
  costly: true,

  /**
   * 花钱但不写盘 → `costly`。调用方据此决定问不问（谨慎模式问，平时不问）。
   *
   * 卡片上必须写清**会花钱**与**产出还会再问一次**：「Agent 想调用 generate，
   * 允许吗」作者答不上来，他不知道会写到哪、花多少。**这一问是「要不要花钱
   * 生成」，落盘是另一问**——产出之后当场还有一张卡（第 19 条）。
   */
  intent(args, project): ToolIntent {
    const target = text(args.target);
    const named = toNames(args.skills);
    return {
      gate: 'costly',
      title: `为「${describePath(target, project)}」调一次创作模型`,
      detail: [
        target,
        text(args.ask) && `要求：${clip(text(args.ask))}`,
        // 卡片上要写清带了哪几套写法：它们会进创作上下文，也会占掉预算，
        // 作者点头之前该看得见（第 4 条的同一面）。
        named.length > 0 && `写作方法：${named.join('、')}`,
        '这一步会花钱。产出之后还会再问你一次要不要落盘。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '调用创作模型产出一份内容。job 说产出什么，target 说落在哪，两者必须落在同一层。\n' +
    describeJobs() +
    '\ntarget 是那份产物的工程内相对路径：.novelforge/outline.md 是全书大纲，' +
    '.novelforge/volumes/ 下是卷纲，.novelforge/plots/ 下是剧情段的细纲，' +
    '.novelforge/manuscripts/ 与已发布的章是正文。\n' +
    'volumeList 要给 outline.md；plotSegment 要给某一卷的卷纲（一次只拆一段，' +
    '拆下一段就再调一次）。\n' +
    '**返回的只有形状与 draftId，没有正文**——正文会直接流给作者看；' +
    '你要看内容就等它落盘之后再 read。' +
    '产出之后会当场请作者点头，同意才落盘，结果写在返回里；不必也不要再用 write 写同一份。' +
    '这个工具会真的调模型花钱，每次调用都会记账，不要重复生成同一份东西。\n' +
    'skills 填 system 里「可交给创作模型的写作方法」下面那些名字（逐字照抄，含前缀）：' +
    '它们的正文会直接进创作模型的上下文，你不必也读不到。按这一次产出什么挑，' +
    '对不上就留空。',

  parameters: objectSchema(
    {
      job: str('要产出什么。', CREATION_JOBS),
      target: str('落点：那份产物的工程内相对路径。'),
      ask: str('补充要求，可留空。留空时按上一层的产物照常生成。'),
      targetWords: int('目标字数，只对 job=manuscript 有意义。留空不限。'),
      skills: strArray(
        '这一次要让创作模型按哪几套写法做。名字照抄「可交给创作模型的写作方法」那一段，' +
          '含 project: / builtin: 前缀。可以填多份，不需要就留空。'
      ),
    },
    ['job', 'target']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.target === 'string' ? args.target.trim() : '';
    const job = args.job;

    if (!isCreationJob(job)) {
      return { text: '', error: `job 只能是：${CREATION_JOBS.join(' / ')}。` };
    }

    const path = kindOfPath(ctx.project, rel);
    if (!path.stage || !path.target) {
      return {
        text: '',
        error:
          `认不出「${rel}」是哪一层的产物。` +
          '全书大纲给 .novelforge/outline.md，卷纲给 .novelforge/volumes/<卷号>-<卷名>.md，' +
          '细纲给 .novelforge/plots/<卷词干>/<段号>-<标题>.md，' +
          '正文给 .novelforge/manuscripts/<细纲在 plots/ 之下的整段路径>.md。' +
          '可以先用 list 看看那个目录下实际有什么。',
      };
    }

    // job 与落点必须落在同一层。**报错而不是猜**：`job=plotSegment` 配一个细纲
    // 路径，猜哪一边都会写错文件——拆段本该往那一卷里加一份新细纲，猜成
    // 「按 job 走」会去改一份不该动的卷纲，猜成「按路径走」会把作者要的骨架
    // 变成一份完整细纲盖掉现有内容。
    const wantStage = stageOfJob(job);
    if (wantStage !== path.stage) {
      return {
        text: '',
        error:
          `job=${job} 要的是${STAGE_LABEL[wantStage]}层的落点，而「${rel}」是` +
          `${STAGE_LABEL[path.stage]}层的产物。` +
          expectedPathHint(job),
      };
    }

    // 写作方法在花钱之前读好。名字错了整次拒绝——这一步不花一分钱，
    // 而默默不带等于让作者付了钱却没用上他要的写法。
    const picked = await resolveSkills(ctx, args.skills);
    if (!picked.ok) {
      return { text: '', error: picked.error };
    }

    // 记在发请求之前：请求发出去钱就花了，抛异常也一样。
    ctx.usage.record(1);
    let failure: string | undefined;
    const model = await pickModel(path.stage);

    const { draft } = await generate(
      ctx.project,
      {
        job,
        target: path.target,
        targetNo: path.no,
        ask: typeof args.ask === 'string' ? args.ask : '',
        targetWords: toPositiveInt(args.targetWords),
        // 空数组，见文件头第 2 条。**不要改成 ctx 里的什么历史。**
        history: [],
        skills: picked.skills,
      },
      {
        // 正文流给前端气泡，不进 agent 上下文。
        onDelta: (delta) => ctx.onDelta?.(delta),
        onDone: () => undefined,
        onError: (message) => {
          failure = message;
        },
        onCancelled: () => {
          failure = '生成被取消。';
        },
      },
      // provider 留空 = 用对话页选定的那个模型（第 12 条）。
      //
      // **不带 thinking**（第 26 条）：作者选的那一档是给「他自己在跟模型讨论
      // 这件事」的，而这里是 agent 在一轮里顺手产出一份产物——它可能一轮里调
      // 好几次，每次都按极限档想一遍，等于把那个下拉框变成一个倍率不明的开关。
      // 循环本身仍然按那一档想（`controller/agent.ts` 递给 runAgent）。
      //
      // `sessionId` 只给调试模式用：开着时这一次的完整上下文落在那个会话的
      // 调试目录里，与循环每回合的快照排在一起（按文件名就是发生顺序）。
      { signal: ctx.signal, ...model, sessionId: ctx.sessionId }
    );

    if (!draft) {
      return { text: '', error: failure ?? '这次生成没有产出内容。' };
    }
    ctx.drafts.put(draft, ctx.sessionId);

    const what = JOB_LABEL[job];
    const shape = draft.summary ?? `${draft.words} 字`;
    // 只说发生了什么。「已用 3/10 次生成」那半句是调用方的账，它才知道上限。
    ctx.report(`已生成 ${what}：${shape}`);

    const usedSkills = picked.skills.length > 0 ? `｜写作方法 ${picked.skills.map((s) => s.name).join('、')}` : '';
    return {
      draftIds: [draft.id],
      // 只有形状与 id。**这里出现正文就是 bug。**
      text:
        `已生成：${what} · ${shape}，${draft.words} 字\n` +
        `draftId: ${draft.id}\n` +
        `落点：${rel}\n` +
        `内容已经流给作者看了。要不要落盘正在问他，结论就在下面。` +
        `你不需要复述它的内容。`,
      display: { title: `generate ${what}`, detail: `${shape} · ${draft.words} 字${usedSkills}` },
    };
  },
};

/**
 * 这一层该用哪个模型。
 *
 * 返回空对象 = 用对话页选定的那个（`generate` 的缺省）。这也是池建不出来时的
 * 退路：报一条 warn 然后照常跑，好过让 agent 在这里硬失败——作者已经在对话页
 * 选了一个能用的模型。
 *
 * **只取 `pool.primary`，不用 `pool.run` 的失败换人**：`generate` 是流式的，
 * 换一个模型重跑会把半份产物再冲一遍进作者的气泡。串行恒用该档首选本来就是
 * 池的行为，这里少的只有 fallback 那一半，而且**绝不跨档**。
 */
async function pickModel(
  stage: CreationStage
): Promise<{ provider?: LlmProvider; budget?: { contextWindow: number; maxOutputTokens: number } }> {
  const task = STAGE_TIER_TASK[stage];
  if (!task) {
    return {};
  }
  const pool = await createModelPool({ task });
  if (!pool) {
    log.warn(`${STAGE_LABEL[stage]}层没有可用的分档模型，改用对话页选定的那个`);
    return {};
  }
  // 窗口必须跟着干活那个模型走（第 13 条）。
  return { provider: pool.primary, budget: pool.primaryBudget };
}

/** job 与落点对不上时，指一条正确的路。 */
function expectedPathHint(job: CreationJob): string {
  switch (job) {
    case 'outline':
    case 'volumeList':
      return ' 给 .novelforge/outline.md。';
    case 'volume':
    case 'plotSegment':
      return ' 给 .novelforge/volumes/ 下那一卷的卷纲。';
    case 'plot':
      return ' 给 .novelforge/plots/ 下那一段的细纲。';
    case 'manuscript':
      return ' 给 .novelforge/manuscripts/ 下那一段的正文，或一个已发布的章。';
  }
}

/** 六个 job 各一行，说清产出什么。工具描述吃它——模型不该先查表再选。 */
function describeJobs(): string {
  return CREATION_JOBS.map((j) => `- ${j}：${JOB_HINT[j]}`).join('\n');
}

/**
 * `skills` 参数 → 几个名字。**容错读一手**：schema 说的是字符串数组，而模型
 * 时不时会给一个裸字符串或者一串顿号/逗号分隔的名字。这一层认下来比让它
 * 白跑一次往返便宜。
 *
 * 名字本身**不做模糊匹配**（与 `skill` 工具同一条）：猜错时创作模型会拿到一份
 * 没人想要的写法，而且谁都不会知道。
 */
function toNames(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .flatMap((item) => (typeof item === 'string' ? item.split(/[、,，]/) : []))
    .map((name) => name.trim())
    .filter(Boolean);
}

type ResolvedSkills = { ok: true; skills: SkillText[] } | { ok: false; error: string };

/**
 * 名字 → 正文。**一个对不上就整次拒绝。**
 *
 * 判据是「此刻真能带上的那些」（`listGenerateSkills`），不是索引里那一份：
 * 作者可能刚把某一份改成了「禁用」，而模型手上还有上一轮的索引。
 *
 * 把 `agent` 类的名字填进来也走这条错误路径，并且**单独指一句**——那一类
 * 该用 `skill` 工具自己读，回一句泛泛的「没有这个名字」它只会照着再试一次。
 */
async function resolveSkills(ctx: ToolContext, value: unknown): Promise<ResolvedSkills> {
  const names = toNames(value);
  if (names.length === 0) {
    return { ok: true, skills: [] };
  }
  const all = await listSkills(ctx.project, readConfig().skillModes);
  const usable = listGenerateSkills(all);

  const skills: SkillText[] = [];
  for (const name of names) {
    if (!usable.some((s) => s.name === name)) {
      const mine = all.find((s) => s.name === name && s.audience === 'agent');
      if (mine) {
        return {
          ok: false,
          error:
            `${name} 是给你自己用的技能，不是给创作模型的写法——用 skill 工具读它。` +
            available(usable),
        };
      }
      return { ok: false, error: `没有叫 ${name} 的写作方法。${available(usable)}` };
    }
    const got = await readSkill(ctx.project, usable, name);
    if (!got.ok) {
      return { ok: false, error: got.error };
    }
    skills.push({ name: got.ref.name, text: got.text, source: skillRelPath(got.ref) });
  }
  return { ok: true, skills };
}

/** 「可用的是」那半句。名单从**实际扫到的那一份**来，写死一串就会开始撒谎。 */
function available(usable: { name: string }[]): string {
  return usable.length > 0
    ? `可交给创作模型的是：${usable.map((s) => s.name).join(' / ')}。名字要逐字照抄，含前缀。`
    : '这个工程里没有可交给创作模型的写作方法，把 skills 留空。';
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}
