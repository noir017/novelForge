import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, readText, writeText } from './fs';
import { NovelProject } from './project';
import {
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  DEFAULT_CAPABILITY,
  STAGE_CAPABILITIES,
  isCapability,
  isCreationStage,
  normalizeAction,
  normalizeTarget,
  stageOfTarget,
} from './pipeline';

/**
 * 会话存储：`.novelforge/sessions/<id>.json`。
 *
 * 这里用 JSON 而不是 Markdown——会话是机器记录（含 token 明细、附件快照），
 * 不像角色卡那样期待人工编写。但仍然是纯文本、可 Git、可手动删除。
 */

export type AttachmentKind = 'selection' | 'file' | 'chapter' | 'character' | 'lore' | 'summary';

/** 用户主动挂到某一轮对话上的上下文引用（Cursor 式）。 */
export interface Attachment {
  /** 稳定 id，用于装配器的排除名单与前端去重。 */
  id: string;
  kind: AttachmentKind;
  /** 展示名，如 `003-夜访.md:12-40`。 */
  label: string;
  /** 工作区相对路径。selection 也带，方便点开原文。 */
  relPath?: string;
  /** selection 的行范围，1-based 闭区间。 */
  range?: { start: number; end: number };
  /**
   * 选区快照。选区必须存快照——用户选的时候是那个样子，
   * 之后文件改了不该让历史对话跟着变。整文件引用则不存，每次读盘取最新。
   */
  text?: string;
}

/** 一轮对话中，装配器实际带上了什么——存下来供回看。 */
export interface ContextDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  items: DigestItem[];
}

export interface DigestItem {
  id: string;
  label: string;
  kind: string;
  priority: number;
  tokens: number;
  status: string;
  note?: string;
  source?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO 时间戳。 */
  at: string;
  /**
   * 仅 user 轮：这一轮下的是哪个命令，如 `落定剧情`。**只在不是「讨论」时记**——
   * 讨论是默认动作，每条消息都挂一枚「/讨论」的标签是纯噪声。
   *
   * 存的是标签而不是能力名：`labelOf` 是按阶段具体化过的（剧情阶段的 `split`
   * 叫「拆成场景」），而历史里那一轮当时在哪个阶段，事后未必还推得出来。
   *
   * 为什么不干脆写进 `content`：那句话会被当成作者的要求装进 prompt。
   * 「写剧情」这类命令本来就不需要作者说什么，凭空塞一句「请写剧情」
   * 进上下文，与旧界面逼他手打一句是同一个毛病。界面要显示的东西和要发给
   * 模型的东西是两件事。
   */
  command?: string;
  /** 仅 user 轮：本轮引用的附件。 */
  attachments?: Attachment[];
  /** 仅 user 轮：本轮被手动取消勾选的上下文条目 id。 */
  excludedIds?: string[];
  /** 仅 assistant 轮：本次装配明细。 */
  context?: ContextDigest;
  /** 仅 assistant 轮：已采纳写入的目标路径。 */
  acceptedTo?: string;
  /** 仅 assistant 轮：生成被用户中断。 */
  interrupted?: boolean;
  /** 仅 assistant 轮：本轮报错信息（保留在历史里，便于复查）。 */
  error?: string;
  /**
   * 仅 assistant 轮：推理模型的思考过程。
   * 不是正文——采纳写入章节时只取 content。
   */
  reasoning?: string;
  /**
   * 仅 assistant 轮：这一轮产出的是可落盘的产物时，它的落点与形状。
   *
   * **只是回放用的记录**：写不写盘在产出的当下就问过了（`controller/gate.ts`
   * 那张卡片），气泡上不再有任何能触发写入的按钮。写了的记在 `acceptedTo`
   * 上，作者当时没同意的这里标 `declined`——两样都留着，翻回来才看得出
   * 「这一轮产出过一份 4 场的场景清单，我没要」。
   */
  artifact?: {
    where: string;
    summary: string;
    overwrites: boolean;
    declined?: boolean;
  };
  /**
   * 仅 assistant 轮：这一轮 agent 调了哪些工具。
   *
   * **不存工具的完整返回值**——`read` 一章正文就是几千字，一轮下来几万字，
   * 会话文件会被它撑爆（与 `MAX_DRAFTS_PER_SESSION` 是同一条理由）。这里只存
   * 展示摘要（「142 行」「2 处命中」），够重开面板时把那串折叠条画回来。
   */
  toolCalls?: TurnToolCall[];
  /**
   * 仅 assistant 轮：这一轮 agent 的花销与结局。
   *
   * **落盘**（第 4 条）：只在跑的时候闪一下的话，作者第二天回来翻这一轮
   * 就看不出它花了多少钱。
   */
  agentRun?: TurnAgentRun;
}

/** 一轮 agent 的花销与结局。只够画一行。 */
export interface TurnAgentRun {
  steps: number;
  calls: number;
  tokens: number;
  stopReason: string;
  message?: string;
}

/** 一次工具调用在会话里留下的痕迹。只够画一行，不够回放。 */
export interface TurnToolCall {
  callId: string;
  name: string;
  /** 界面上那一行的标题，如 `search「北境」`。 */
  title: string;
  ok: boolean;
  /** 展示摘要，如「2 处命中」。那一行上只画这个。 */
  summary: string;
  elapsedMs: number;
  /**
   * 模型这一次填的参数（JSON 文本，已截断）。折叠条展开后看得到。
   *
   * 存它是为了「查得出它读的是哪一章」——一行摘要说不清这个，而作者要核对
   * 结论的依据时，第一件想知道的事就是它当时看的是什么。
   */
  argsText?: string;
  /**
   * 回给模型的那段文本（已截断）。同样只在展开后画。
   *
   * **截断是必须的**：这份东西随会话落盘，一轮几十次调用的完整返回值会把
   * 会话文件撑成几兆。截断点在 `controller/agent.ts`，那里也是唯一知道
   * 「界面要画多长」的地方。
   */
  resultText?: string;
}

/**
 * 一份随会话落盘的草稿。
 *
 * 与 `generation/drafts.ts` 的 `Draft` 同形，只是 `artifact` 在这一层是
 * **不透明的**：数据层不认识 `Artifact`（那是 `features/artifact.ts` 的类型，
 * 依赖方向不允许反过来），而这份快照只用于画卡片——采纳时会拿气泡里当下的
 * 文本重新解析。
 */
export interface SessionDraft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原样输出（正文层已过 `cleanOutput`）。 */
  raw: string;
  /** 解析出的结构化产物。讨论（唯一的 text 类能力）没有。 */
  artifact?: unknown;
  /** 一句话形状描述，如「剧情 · 4/4 节」。 */
  summary?: string;
  words: number;
  /** 推理模型的思考过程。不是正文，采纳时不取。 */
  reasoning?: string;
  createdAt: string;
}

export interface ChatSession {
  /** 等于文件名（不含扩展名）。 */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 当前在改哪个产物。会话跟着目标走——切到另一章的细纲通常意味着
   * 换个话题，但**不强制新建会话**：作者可能正想拿这一章跟上一章比。
   */
  target: CreationTarget;
  /** 当前阶段与能力。切阶段时能力回落到该阶段的默认值（一律 discuss）。 */
  stage: CreationStage;
  capability: Capability;
  /** 本会话默认写入的章号。目标章尚未落盘时用它定位「前文」边界。 */
  targetNo?: number;
  /** 目标字数，跟着会话走，省得每次重填。 */
  targetWords?: number;
  turns: ChatTurn[];
  /**
   * 本会话里尚未采纳的草稿。
   *
   * 跟着会话落盘的理由与 `ChatTurn.artifact` 是同一条：**刷新网页后采纳
   * 按钮还在**，不然刚生成的四个场景就只剩一段谁也用不上的 JSON。
   * 不进 SQLite（第 17 条：库只放可丢弃的痕迹）。
   */
  drafts: SessionDraft[];
}

/** 列表视图用的轻量摘要，不含 turns 全文。 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  /** 最后一条用户消息的开头，用作副标题。 */
  preview: string;
}

export class SessionStore {
  constructor(private readonly project: NovelProject) {}

  private filePath(id: string): string {
    return path.join(this.project.sessionsDir, `${id}.json`);
  }

  /** 按更新时间倒序列出所有会话。损坏的文件跳过，不让一个坏文件废掉整个历史。 */
  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.project.sessionsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map((e) => e.name);
    } catch {
      return [];
    }

    const out: SessionSummary[] = [];
    for (const name of names) {
      const session = await this.read(name.replace(/\.json$/i, ''));
      if (session) {
        out.push(summarize(session));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async read(id: string): Promise<ChatSession | undefined> {
    const file = this.filePath(id);
    if (!(await exists(file))) {
      return undefined;
    }
    try {
      return normalize(id, JSON.parse(await readText(file)));
    } catch {
      // 手改坏了或写到一半断电——当作不存在，别抛给用户。
      return undefined;
    }
  }

  async write(session: ChatSession): Promise<void> {
    await writeText(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  /** core 无系统回收站能力：移到 .novelforge/.trash/ 下（保留原文件名可手动找回）。 */
  async delete(id: string): Promise<void> {
    const file = this.filePath(id);
    if (!(await exists(file))) {
      return;
    }
    const trashDir = this.project.trashDir;
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(file, path.join(trashDir, `${id}.json`));
  }

  async rename(id: string, title: string): Promise<ChatSession | undefined> {
    const session = await this.read(id);
    if (!session) {
      return undefined;
    }
    session.title = title.trim() || session.title;
    session.updatedAt = nowIso();
    await this.write(session);
    return session;
  }

  /**
   * 新建一个空会话（尚未落盘——没有内容的会话不该在历史里占位）。
   *
   * `seed` 让新会话继承上一个的落点：作者点「新对话」多半是想换个话题
   * 接着在**同一个地方**写，把他弹回全书大纲纯属添乱。
   */
  create(seed?: { target?: CreationTarget; stage?: CreationStage; targetNo?: number }): ChatSession {
    const at = nowIso();
    const target = seed?.target ?? { kind: 'outline' };
    const stage = seed?.stage ?? stageOfTarget(target);
    return {
      id: makeSessionId(),
      title: '新对话',
      createdAt: at,
      updatedAt: at,
      target,
      stage,
      capability: DEFAULT_CAPABILITY[stage],
      targetNo: seed?.targetNo,
      turns: [],
      drafts: [],
    };
  }
}

// ---------------------------------------------------------------- 工具

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `20260802-143012-4f2a1b`：可读、可排序、够唯一。
 *
 * 时间戳只精确到秒，所以随机位之外还带一个进程内计数器：
 * 同一秒里连开几个会话（连点＋）必须保证不撞——id 就是文件名，
 * 撞了会直接覆盖掉另一个会话。计数器保证同进程内不撞，
 * 随机位负责把不同窗口/进程分开。
 */
let sessionCounter = 0;
export function makeSessionId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  sessionCounter = (sessionCounter + 1) % 0x100;
  return `${stamp}-${rand}${sessionCounter.toString(16).padStart(2, '0')}`;
}

/**
 * 轮次 id。
 *
 * 用递增计数器而非纯随机：turnId 是 DOM 查找和历史映射的键，
 * 同一毫秒内连续建两条（插入用户消息后紧接着插空回复）必须保证不撞。
 */
let turnCounter = 0;
export function makeTurnId(): string {
  turnCounter += 1;
  return `t${Date.now().toString(36)}-${turnCounter.toString(36)}`;
}

/** 从首条用户消息生成会话标题。 */
export function deriveTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
    .find((s) => s.length > 0);
  if (!line) {
    return '新对话';
  }
  const clipped = line.split(/[。！？；,，.!?;]/)[0].trim();
  return (clipped || line).slice(0, 24);
}

/**
 * 一轮对话拿什么当「它说了什么」——历史列表的预览与会话标题都用这一份。
 *
 * 命令类的轮次（写剧情、拆成场景）content 本来就是空的：该说的都在剧情和
 * 大纲里了，作者一个字都不必打。空串会让历史列表出现一排「新对话」，也让
 * 消息流里出现一个空白气泡——两处都得能说出这一轮到底干了什么。
 */
export function turnPreview(turn: ChatTurn): string {
  const text = turn.content.trim();
  if (text) {
    return text;
  }
  return turn.command ? `/${turn.command}` : '';
}

function summarize(session: ChatSession): SessionSummary {
  const lastUser = [...session.turns].reverse().find((t) => t.role === 'user');
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    preview: (lastUser ? turnPreview(lastUser) : '').replace(/\s+/g, ' ').slice(0, 60),
  };
}

/**
 * 容错读取：字段缺失或类型不对时补默认值，绝不抛。
 *
 * 认不出的 target 一律回落到全书大纲——它是唯一一个不依赖任何细纲就一定
 * 存在的产物。换轴之前的会话记的是章节路径，那些路径现在指不到任何东西，
 * 归一化时会落回大纲；作者重新选一章就好，比把它指到一个错的章上强。
 */
function normalize(id: string, raw: unknown): ChatSession {
  const o = (raw ?? {}) as Partial<ChatSession>;
  const at = typeof o.createdAt === 'string' ? o.createdAt : nowIso();
  const target = normalizeTarget(o.target);
  // 阶段认不出、或该阶段不支持记下来的那个能力时，都回落到该阶段的默认值。
  const stage: CreationStage = isCreationStage(o.stage) ? o.stage : stageOfTarget(target);
  const capability: Capability =
    isCapability(o.capability) && STAGE_CAPABILITIES[stage].includes(o.capability)
      ? o.capability
      : DEFAULT_CAPABILITY[stage];
  const drafts = normalizeDrafts(o.drafts);
  return {
    id,
    title: typeof o.title === 'string' && o.title.trim() ? o.title : '未命名对话',
    createdAt: at,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : at,
    target,
    stage,
    capability,
    targetNo: typeof o.targetNo === 'number' ? o.targetNo : undefined,
    targetWords: typeof o.targetWords === 'number' ? o.targetWords : undefined,
    turns: Array.isArray(o.turns) ? o.turns.filter(isTurn) : [],
    drafts,
  };
}

/**
 * 会话文件的 `drafts` 字段 → 一批草稿。不是数组就当空。
 *
 * **只要 `id` 在就不整体作废**：坏掉的字段按默认值补，气泡上那一轮至少还
 * 认得出产出过什么。`target` 走 `normalizeTarget`（认不出回落全书大纲），
 * `action` 走 `normalizeAction`，两者都不抛。
 *
 * `artifact` 原样收下不重新校验：它只是生成那一刻的展示快照，采纳时会拿
 * 气泡里当下的文本重新解析（用户可能改过）。
 */
function normalizeDrafts(raw: unknown): SessionDraft[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionDraft[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const o = entry as Partial<SessionDraft>;
    if (typeof o.id !== 'string' || !o.id.trim()) {
      continue;
    }
    out.push({
      id: o.id,
      action: normalizeAction(o.action),
      target: normalizeTarget(o.target),
      raw: typeof o.raw === 'string' ? o.raw : '',
      artifact: o.artifact,
      summary: typeof o.summary === 'string' ? o.summary : undefined,
      words: typeof o.words === 'number' && Number.isFinite(o.words) ? o.words : 0,
      reasoning: typeof o.reasoning === 'string' ? o.reasoning : undefined,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}

function isTurn(t: unknown): t is ChatTurn {
  const o = t as Partial<ChatTurn>;
  return !!o && (o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string';
}
