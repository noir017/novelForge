/**
 * 工具层的契约。**这一份是 tools 与调用方之间唯一的约定**，两边都只认它。
 *
 * ## 为什么工具不认识 agent
 *
 * 从前工具住在 `agent/` 里，`ToolContext` 上挂着 agent 的 `Budget`（工具自己
 * `budget.calls += 1`，还读 `limits` 拼「已用 3/10 次生成」那句话），闸门反过来
 * 又按工具名 switch。两层互相伸手，结果是**谁都搬不动**：想把工具端出去做
 * MCP，得先把 agent 的预算对象一起端出去。
 *
 * 现在的分工：
 *
 * | 谁 | 管什么 |
 * |---|---|
 * | 工具 | 做那件事，回一段模型读得动的文本；**报出自己花了几次模型调用** |
 * | 调用方 | 上限、账、闸门、循环。工具花了钱它记账，工具要动磁盘它决定问不问 |
 *
 * 于是工具不认识「上限」这回事——它只会说「我调了 2 次模型」。谁在乎这个数字，
 * 谁自己去比对上限。
 *
 * ## 与 MCP 的对应
 *
 * 这套形状是照着 MCP 的 `tools/list` + `tools/call` 摆的，将来把它端出去时
 * **不必改工具体**：
 *
 * | 这里 | MCP |
 * |---|---|
 * | {@link ToolDef.name} / `description` / `parameters` | `tools/list` 的一条 |
 * | {@link ToolInvoker.invoke} → {@link ToolInvocation} | `tools/call` 的请求与结果 |
 * | {@link ToolDef.mutating} / `costly` | `readOnlyHint` / 那类注解 |
 * | {@link ToolIntent} | MCP 没有对应物——**确认是宿主的事**，所以工具只描述意图，不自己弹框 |
 *
 * 缺的那一半（传输、鉴权、会话）不在这一层，见 [README](README.md)。
 */
import type { NovelProject } from '../model/project';
import type { Workspace } from '../workspace';
import type { DraftStore } from '../generation/drafts';
import type { ToolSpec } from '../llm/provider';

/**
 * 发给模型的一条工具声明。**沿用 `llm/provider` 那一份，不另定义一个同形的**
 * ——两份迟早会差一个字段，而差的那一天没有任何测试会红。
 */
export type { ToolSpec };

// ---------------------------------------------------------------- 执行环境

/**
 * 工具够得着的工程那一面。**由调用方绑定一次**（面板一轮 agent、或将来一条
 * MCP 会话），此后每次调用都是同一份。
 *
 * **没有 `history`**：工具调用不是作者的讨论，混进装配器会被当成创作要求
 * （见 [novel/generate.ts](novel/generate.ts)）。
 */
export interface ToolEnv {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  /** 草稿按会话分桶存：`write draftId=…` 与产出后那一问都靠它找回来。 */
  sessionId: string;
}

/**
 * 花钱记账口。**工具只报数，不判断触没触顶**——上限是调用方的事。
 *
 * 为什么是回调而不是返回值：`generate` 在**发请求之前**就该记上这一笔，
 * 请求发出去钱就花了，中途抛异常也一样。等函数返回再记，异常那条路上的钱
 * 就丢账了。
 */
export interface UsageMeter {
  /** 记 n 次模型调用。 */
  record(calls: number): void;
}

/** 一次调用那一面：能不能停、说给谁听、账记到哪。 */
export interface ToolRun {
  signal: AbortSignal;
  /** 工具想说点什么给用户看（进气泡，**不进模型上下文**）。 */
  report(message: string): void;
  /** 正文增量推给前端。同样不进模型上下文。 */
  onDelta?(delta: string): void;
  usage: UsageMeter;
}

/** 工具体拿到的一切 = 环境 + 这一次调用。 */
export type ToolContext = ToolEnv & ToolRun;

// ---------------------------------------------------------------- 工具定义

/** 界面画的那一行摘要，**不进模型上下文**。 */
export interface ToolDisplay {
  title: string;
  detail?: string;
}

export interface ToolResult {
  /**
   * 回给模型看的文本。**必须简短**——它会留在调用方的上下文里，每走一步
   * 重烧一遍。三千字正文塞回这里，十步之后就是三万字的重复账单。
   */
  text: string;
  display?: ToolDisplay;
  /** 出错了。**模型看得到**，据此重试或换路——所以要写成它能照着改的话。 */
  error?: string;
  /** 这一次产出的草稿 id。调用方据此当场问一句「写不写」，不必去翻 store。 */
  draftIds?: string[];
}

/**
 * 动手之前的意图：**这一步是什么性质、要问的话该怎么说**。
 *
 * 工具自己报，而不是让调用方按名字猜——猜的那一版长这样：
 *
 * ```ts
 * switch (tool.name) { case 'write': …; case 'edit': … }
 * ```
 *
 * 加一个工具就要回来改一次，而且忘了改不会红，只会在某一天静默地少问一句。
 */
export interface ToolIntent {
  gate: GateKind;
  /**
   * **动词短语**，调用方在前面加主语（「Agent 要」/「远端要」）：
   * `为「第 12 章的细纲」调一次创作模型`。
   *
   * 不写成「调用 write」——作者答不上来，他不知道 write 会写到哪。
   */
  title: string;
  /** 展开说这一步会发生什么。`edit` 的 old → new 两段原文就写在这里。 */
  detail?: string;
  /** 同意那颗按钮上的字（「写入」「替换」「执行」「生成」）。 */
  proceed?: string;
}

/**
 * 这一步的性质。**五个值，判定表在调用方**（agent 的
 * [policy.ts](../agent/policy.ts)）。
 *
 * | 值 | 什么样的动作 | 为什么单独一档 |
 * |---|---|---|
 * | `auto` | 查询 | 不花钱不改东西，问一句只是让人麻木 |
 * | `costly` | 花钱但不写盘 | 谨慎模式下值得问，平时不必 |
 * | `mutating` | 写盘 | 常规的「动手前问一句」 |
 * | `reviewed` | 写盘，但**下游自己会请人过目** | 再问一句是纯噪声：diff 本身就是答案 |
 * | `always` | 写盘，且**下游不过目** | 那一句确认就是它的 diff，任何模式都不能免 |
 *
 * `reviewed` 与 `always` 是**产品承诺**（AGENTS 第 3 / 19 / 25 条）落在类型上的
 * 形状：覆盖已有内容一律过一遍人，区别只在过的是 diff 还是确认框。
 */
export type GateKind = 'auto' | 'costly' | 'mutating' | 'reviewed' | 'always';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema，原样透传给各家 API。 */
  parameters: Record<string, unknown>;
  /**
   * 会花钱。**只是一条事实**（对应 MCP 的注解），闸门怎么判在 {@link intent}。
   */
  costly?: boolean;
  /**
   * 会写盘。同上，只是事实。
   *
   * **它不是保护**：八条守卫与覆盖前审阅在 `workspace/` 那一层，和这个标记无关。
   */
  mutating?: boolean;
  /**
   * 这一次调用的意图。**零 I/O 纯函数**——它算出来的名字要与随后 diff 上的
   * 名字逐字一致，所以两边都走 `kindOfPath` 那条纯路径。
   *
   * 不实现时由 {@link ToolRegistry} 按 `costly` / `mutating` 兜一个通用的。
   */
  intent?(args: Record<string, unknown>, project?: NovelProject): ToolIntent;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------- 调用口

/** 一次调用的结果。**绝不抛**：出错也是一条正常返回。 */
export interface ToolInvocation {
  ok: boolean;
  /** 回给模型的文本（出错时就是那句错误说明）。 */
  text: string;
  error?: string;
  display?: ToolDisplay;
  draftIds: string[];
  elapsedMs: number;
}

/**
 * 调用方眼里的工具集。**agent 只认这个接口**，不认识 `ToolDef`、不认识
 * `Workspace`、不认识 `DraftStore`。
 *
 * 于是换一套工具（另一个领域、或者将来一个 MCP 客户端）只要另实现一份
 * 这四个方法，循环一行都不用改。
 */
export interface ToolInvoker {
  /** 发给模型的工具清单。顺序即模型看到的顺序。 */
  specs(): ToolSpec[];
  /** 已注册的名字。用来跟模型说「可用的是：…」。 */
  names(): string[];
  /** 这一步的意图。名字不认识时返回 undefined。 */
  intent(name: string, args: Record<string, unknown>): ToolIntent | undefined;
  /** 执行。**绝不抛**，认不出名字也回一条能让模型换路的结果。 */
  invoke(
    name: string,
    args: Record<string, unknown>,
    run: ToolRun
  ): Promise<ToolInvocation>;
}
