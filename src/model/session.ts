import * as vscode from 'vscode';
import { NovelProject, exists, readText, writeText } from './project';

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
}

export interface ChatSession {
  /** 等于文件名（不含扩展名）。 */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 本会话默认写入的章节序号。 */
  targetOrder?: number;
  /** 目标字数，跟着会话走，省得每次重填。 */
  targetWords?: number;
  turns: ChatTurn[];
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

  private uri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.project.sessionsDir, `${id}.json`);
  }

  /** 按更新时间倒序列出所有会话。损坏的文件跳过，不让一个坏文件废掉整个历史。 */
  async list(): Promise<SessionSummary[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.project.sessionsDir);
    } catch {
      return [];
    }

    const out: SessionSummary[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.json')) {
        continue;
      }
      const session = await this.read(name.replace(/\.json$/i, ''));
      if (session) {
        out.push(summarize(session));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async read(id: string): Promise<ChatSession | undefined> {
    const uri = this.uri(id);
    if (!(await exists(uri))) {
      return undefined;
    }
    try {
      return normalize(id, JSON.parse(await readText(uri)));
    } catch {
      // 手改坏了或写到一半断电——当作不存在，别抛给用户。
      return undefined;
    }
  }

  async write(session: ChatSession): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.project.sessionsDir);
    await writeText(this.uri(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  async delete(id: string): Promise<void> {
    const uri = this.uri(id);
    if (await exists(uri)) {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    }
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

  /** 新建一个空会话（尚未落盘——没有内容的会话不该在历史里占位）。 */
  create(targetOrder?: number): ChatSession {
    const at = nowIso();
    return {
      id: makeSessionId(),
      title: '新对话',
      createdAt: at,
      updatedAt: at,
      targetOrder,
      turns: [],
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

function summarize(session: ChatSession): SessionSummary {
  const lastUser = [...session.turns].reverse().find((t) => t.role === 'user');
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    preview: (lastUser?.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
  };
}

/** 容错读取：字段缺失或类型不对时补默认值，绝不抛。 */
function normalize(id: string, raw: unknown): ChatSession {
  const o = (raw ?? {}) as Partial<ChatSession>;
  const at = typeof o.createdAt === 'string' ? o.createdAt : nowIso();
  return {
    id,
    title: typeof o.title === 'string' && o.title.trim() ? o.title : '未命名对话',
    createdAt: at,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : at,
    targetOrder: typeof o.targetOrder === 'number' ? o.targetOrder : undefined,
    targetWords: typeof o.targetWords === 'number' ? o.targetWords : undefined,
    turns: Array.isArray(o.turns) ? o.turns.filter(isTurn) : [],
  };
}

function isTurn(t: unknown): t is ChatTurn {
  const o = t as Partial<ChatTurn>;
  return !!o && (o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string';
}
