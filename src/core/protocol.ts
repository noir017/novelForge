/** Webview ↔ 扩展 的消息协议。两个宿主（侧边栏 / 编辑器面板）共用。 */

import { DirListing } from './fileTree';
import { LogEntry } from './logger';
import { TaskSnapshot } from './progress';
import type { LlmTask, ModelTier } from './model/tiers';
import type {
  Capability,
  ChapterStage,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
} from './model/pipeline';

/**
 * 侧栏页签。`files` 是独立版专属的资源管理器（插件壳里由 VS Code 自己的
 * 资源管理器承担，活动栏上没有这个按钮），但类型放在共用协议里——
 * 后端对页签的处理是一份代码，多一个分支好过分叉出两套 Tab 定义。
 */
export type Tab = 'chat' | 'project' | 'files' | 'history' | 'settings' | 'logs';

/**
 * 发一轮请求。
 *
 * `stage` / `capability` / `target` 三个字段取代了原来的 `mode`。旧的
 * `'write' | 'discuss'` 按 **AI 的输出形式**划分，而作者的实际流程是四层
 * 产物——「讨论」在四层里都会发生，「续写」只是正文层的一个动作。
 *
 * `targetOrder` 留着，但只在**目标章节尚未落盘**时有用（要写第 4 章，
 * 磁盘上只有 3 章），装配器据此定位「前文」的边界。章节已存在时以
 * `target.chapterRelPath` 为准。
 */
export interface SendPayload {
  text: string;
  stage: CreationStage;
  capability: Capability;
  target: CreationTarget;
  targetOrder: number;
  targetWords: number;
  attachments: SerializedAttachment[];
  excludedIds: string[];
}

export interface SerializedAttachment {
  id: string;
  kind: string;
  label: string;
  relPath?: string;
  range?: { start: number; end: number };
  text?: string;
}

/**
 * 独立版的两块编辑区：主区放正文，草稿区放草稿，左右并列。
 * 缺省 `main`——插件壳与旧消息都当主区处理。
 */
export type EditorPane = 'main' | 'draft';

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  /**
   * 采纳一段正文。**只用于正文**：追加到已有章节，或新建一章。
   *
   * 结构化产物（细纲、场景、章节清单）走 `acceptArtifact`——那边不需要
   * order/title，落点由 target 完全决定。
   */
  | { type: 'accept'; turnId: string; mode: 'append' | 'new'; order: number; title: string; text: string }
  /**
   * 采纳一份结构化产物，写进 target 指向的位置。
   *
   * `text` 是**当前气泡里的内容**（用户可能改过），后端重新解析一遍再落盘——
   * 不缓存上一次的解析结果，那份可能对不上用户眼前看到的东西。
   */
  | { type: 'acceptArtifact'; turnId: string; target: CreationTarget; text: string }
  /**
   * 切换当前创作目标（点流水线条、点工程页的场景、点面包屑）。
   *
   * 后端回一条 `session` 与一条 `pipeline`：前者让输入区的能力按钮组跟着
   * 换（每个阶段可用的能力不同），后者给出这一章各层产物的新鲜度。
   */
  | { type: 'setTarget'; target: CreationTarget }
  /**
   * 进入某一章。**由后端决定落在哪一层**——这是状态机在协议上的落点。
   *
   * 前端只有当前那一章的 pipeline，不知道别的章处于什么状态；而「选中一章
   * 就该进它当前该做的那一层」正是这次改造的核心。旧的做法是前端一律发
   * `setTarget({kind:'manuscript'})`，于是选中一个连细纲都没有的章节，
   * 界面直接把作者丢进正文层。
   */
  | { type: 'selectChapter'; chapterRelPath: string }
  /** 要某一章的流水线状态（切目标、工程页展开章节时）。不带则给当前目标那一章。 */
  | { type: 'requestPipeline'; chapterRelPath?: string }
  | { type: 'editTurn'; turnId: string; text: string }
  | { type: 'deleteTurn'; turnId: string }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  /**
   * 在内置编辑器里打开一个文本文件（仅独立版；插件壳收到会转成 openFile）。
   * 与 `openFile` 分开是为了让「点章节名」在两个壳里各自做对的事：
   * 插件开 VS Code 的 tab，独立版开自己的编辑器。
   *
   * `pane` 只有独立版用得上：刷新后恢复标签页时要说清楚开在哪一块。
   */
  | { type: 'openEditor'; path: string; pane?: EditorPane }
  /**
   * 打开某章的草稿。`path` 是**章节**的工作区相对路径，草稿路径由后端推导。
   *
   * 首次点击时按需创建（已存在则原样打开，绝不覆盖）；
   * 独立版开在第二块编辑区，插件壳开在正文旁边一栏。
   */
  | { type: 'openDraft'; path: string }
  /** 保存编辑器里的内容。`baseHash` 为空表示用户已确认强制覆盖。 */
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  /** 重新从磁盘读一份（放弃本地修改 / 冲突后取磁盘版）。 */
  | { type: 'reloadFile'; path: string }
  /**
   * 资源管理器：要这些目录的直接子项（仅独立版）。
   *
   * `dirs` 是前端**当前展开着的全部目录**（空串表示工程根），不是增量——
   * 后端据此记住该关注哪些目录，工程有变动时原样重推一遍。
   * 一次带全量比每展开一个目录发一条要省事：折叠也不必再发一条撤销消息。
   */
  | { type: 'listDir'; dirs: string[] }
  /** 用系统默认程序打开（编辑器里「在外部打开」）。 */
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  /**
   * 要一章的摘要正文（工程页悬停浮窗用）。
   *
   * 摘要正文不进 `ProjectTree`：那棵树每次文件变动都全量重推，
   * 一本两百章的书每章带上一千多字摘要，等于每保存一次正文就推几百 KB。
   * 悬停时单章去取一次，前端按 order 缓存，收到新的树时整体作废。
   */
  | { type: 'requestSummary'; order: number }
  /** `dir` 为新建类动作指定落点目录（工作区相对路径），缺省落在该区的根目录。 */
  | { type: 'projectAction'; action: ProjectAction; order?: number; dir?: string }
  /**
   * 角色卡动作。`name` 是角色名（未建卡的人物只有名字）；
   * `relPath` 在更新已有卡时给出，指向那张卡。
   */
  | { type: 'characterAction'; action: CharacterAction; name: string; relPath?: string }
  /**
   * 类文件操作。工程页用 `relPath` 单数（rename/move/delete，锁在三个区内）；
   * 文件页用 `renameAny`（根范围重命名）与 `paste`（`relPaths` 源列表 +
   * `op` 区分移动/复制 + `targetDir` 落点）。
   */
  | {
      type: 'fileAction';
      action: FileAction;
      relPath?: string;
      relPaths?: string[];
      op?: 'cut' | 'copy';
      targetDir?: string;
    }
  | { type: 'selectModel'; ref: string }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  /**
   * 测试某个模型能不能用。
   *
   * `provider` 是设置页当前**屏幕上**的那份服务商配置（可能还没保存）。
   * 带上它，测试就测所见即所得的这一份——刚加的模型、刚改的 baseUrl
   * 不必先保存也能验。留空则退回已保存的配置。
   */
  | { type: 'testConnection'; ref?: string; provider?: SerializedProvider }
  | { type: 'openNativeSettings' }
  /** 取消一个正在跑的长任务（进度条上的「停止」）。 */
  | { type: 'cancelTask'; id: string }
  /** 日志页：要一份缓冲全量（切到该页 / 点刷新时发）。 */
  | { type: 'requestLogs' }
  /**
   * 日志页：要更早的历史（存在工程库里，跨会话留得住）。
   *
   * 与 `requestLogs` 分开是有意的：那条回的是进程内环形缓冲（实时、几百条），
   * 是默认路径，一次查询都不做；这条才碰数据库，只在用户点「加载更早」时发。
   * `before` 是当前已显示的最早那条的时间戳，用于继续往前翻。
   */
  | { type: 'requestLogHistory'; before?: string }
  /** 日志页：清空缓冲。 */
  | { type: 'clearLogs' }
  /** 网页弹窗的回执（仅独立版：host.input/confirm/pick 经 WebSocket 变成 modal）。 */
  | { type: 'promptResult'; requestId: string; value?: string };

/**
 * 工程页上可触发的动作。全部走命令，webview 只负责说「点了什么」。
 * `order` 只有章节相关的动作会带。
 */
export type ProjectAction =
  | 'initProject'
  | 'refresh'
  | 'newChapter'
  | 'newCharacter'
  | 'newLore'
  | 'newFolder'
  | 'continueFrom'
  | 'summarizeChapter'
  | 'syncSummaries'
  | 'rebuildGlobalSummary'
  /** 给所有还没有细纲的章节各生成一份（只补不改）。 */
  | 'generatePlans'
  /** 给所有「细纲写好了但没拆场景」的章节各拆一次（只补不改）。 */
  | 'breakdownScenes'
  | 'extractCharacters'
  | 'generateLore'
  | 'extractStyle';

/**
 * 角色相关的动作。与 `projectAction` 分开是因为它们的作用对象是**角色**，
 * 而不是一个文件或一个章节。
 *
 * - `updateCard` / `rebuildCard`：更新已有角色卡。前者增量、后者全量，`relPath` 指向那张卡。
 * - `createCard`：给摘要里出现但还没建卡的人物建卡。`name` 是摘要里的名字。
 * - `updateAllCards` / `rebuildAllCards`：批量更新全部角色卡（增量 / 全量），
 *   不需要 name/relPath。
 * - `createAllCards`：给「未建卡」那一组里的所有人建卡，同样不需要 name/relPath。
 * - `cleanAliases` / `mergeDuplicates`：两条维护动作——删掉不是专属称呼的别名、
 *   把同一个人的多张卡并成一张。都不调模型，也不需要 name/relPath。
 */
export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards'
  | 'createAllCards'
  | 'cleanAliases'
  | 'mergeDuplicates';

/**
 * 类文件操作。作用对象由 `relPath` / `relPaths` 给出，可以是文件也可以是目录。
 * `move` 另需 `targetDir`（工作区相对路径，空串表示所属区的根目录）。
 *
 * - `rename` / `move` / `delete`：工程页用，锁在章节/角色/设定三个区内（fileOps.ts）。
 * - `renameAny` / `paste`：文件页用，范围放宽到整个工程根（projectFiles.ts）。
 */
export type FileAction = 'rename' | 'renameAny' | 'move' | 'delete' | 'paste';

/** 设置页提交的全部内容。服务商列表整体替换。 */
export interface SettingsPayload {
  providers: SerializedProvider[];
  /**
   * 默认模型列表，按顺序，第一个是首选（形如 `glm/glm-4-plus`）。
   *
   * 这是「当前模型」的唯一真相：后端落盘时 `novel.model` 恒等于首项，
   * 对话页下拉框切换模型等于把那一项提到列表头。
   */
  models: string[];
  /**
   * 三档（快速 / 均衡 / 精标）各自的模型清单，与 `models` 同构。
   *
   * 某一档为空 = 归在该档的工程页任务沿用 `models`。三档都空 = 不分档，
   * 行为与分档之前完全一致。对话页续写永远只用 `models[0]`，不看档位。
   */
  tierModels: Record<ModelTier, string[]>;
  /** 任务 → 档位的覆盖。只带与内置默认不同的项。 */
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  temperature: number;
  recentChaptersFullText: number;
  prevChapterTailChars: number;
  summaryBatchSize: number;
  requestTimeoutMs: number;
  /** 工程页批量任务的并发请求数。1 表示串行。 */
  concurrency: number;
  /** 一次调用失败后，换用列表里其它模型重试的次数上限。 */
  fallbackAttempts: number;
}

export interface SerializedProvider {
  id: string;
  label?: string;
  kind: 'openai' | 'anthropic' | 'vscode-lm';
  baseUrl?: string;
  models: SerializedModel[];
}

export interface SerializedModel {
  name: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 扩展 → Webview */
export type OutMessage =
  | { type: 'init'; state: ViewState }
  | { type: 'state'; state: ViewState }
  | { type: 'tab'; tab: Tab }
  | { type: 'session'; session: SerializedSession }
  | { type: 'sessions'; list: SessionListItem[] }
  | { type: 'delta'; turnId: string; text: string }
  /** 推理模型的思考增量。前端折叠显示，不计入正文。 */
  | { type: 'reasoning'; turnId: string; text: string }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  /**
   * 一章摘要的正文，回应 `requestSummary`。
   *
   * `sections` 是摘要的固定小节（缺的为空串），前端据此分块渲染；
   * 摘要不存在时 `exists: false`，浮窗给出「还没有摘要」的说明而不是空白。
   * `stale` 说明这份摘要对不对得上当前正文——过期时浮窗要标出来，
   * 否则用户会照着一份写于三次修改之前的摘要做判断。
   */
  | { type: 'summary'; summary: ChapterSummaryView }
  /**
   * 创作页的全部现场：这一章走到哪一步、当前这一层的产物是什么、下一步该干什么。
   *
   * 三样东西一条消息推，因为它们**永远同时变**：切目标、采纳产物、跑完一轮
   * 都会让三者一起过期。分三条推只会多两次往返，还得在前端处理「工作区卡
   * 已经换到新目标、下一步还是上一个目标的」这种中间态。
   *
   * 与 `ProjectTree` 分开推：那棵树每次文件变动都全量重推，而这一份只关心
   * 当前这一章。全书的流水线徽章走 `ProjectChapterNode` 上的精简字段。
   */
  | {
      type: 'pipeline';
      /** 目标是全书大纲时缺席——那时没有「这一章的四段」可言。 */
      pipeline?: ChapterPipelineView;
      /** 状态机算出的下一步。全部做完时缺席（不催）。 */
      next?: NextStepView;
      workbench: WorkbenchView;
    }
  /**
   * `ack` 标明这次推送是不是某次保存的回执：
   * `saved` 表示已落盘（前端可放心以磁盘为准），`rejected` 表示被拒
   * （前端必须保住用户的编辑）。普通刷新不带 ack。
   */
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  | { type: 'toast'; message: string; level: 'info' | 'error' }
  /**
   * 内置编辑器：打开/重载一份文件（仅独立版）。
   * `pane` 指明开在哪一块编辑区，缺省主区。
   */
  | { type: 'editorOpen'; file: EditorFileView; pane?: EditorPane }
  /** 内置编辑器：保存成功，带回新的 hash 基线。 */
  | { type: 'editorSaved'; file: EditorFileView }
  /** 内置编辑器：磁盘上已被改过，保存被拒。前端展示取舍界面，绝不静默覆盖。 */
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  /** 内置编辑器：打开/保存失败（越界、扩展名不符、过大等）。 */
  | { type: 'editorError'; path: string; message: string }
  /**
   * 资源管理器：若干目录的列举结果（仅独立版）。
   *
   * 每次推的是前端登记过的全部目录，前端整批替换即可——
   * 目录数只有个位数到几十，增量协议不值得让前端维护一份可能对不上的副本
   * （与 `tasks` 同一套取舍）。
   */
  | { type: 'dirListings'; listings: DirListing[] }
  /**
   * 文件页类文件操作（renameAny / paste）的逐项结果。
   * 前端据此 remap 开着的编辑器标签，失败项各自提示原因。
   */
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
  /**
   * 正在跑的长任务快照，全量替换。
   *
   * 任何变化（新增/进度/结束）都重推整份——列表最多两三项，
   * 增量协议换来的那点带宽不值得让前端维护一份可能对不上的副本。
   */
  | { type: 'tasks'; tasks: TaskSnapshot[] }
  /** 日志：增量一条（实时追加），或全量一批（日志页首次加载/清空后）。 */
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  /**
   * 日志：从库里取到的更早历史，回应 `requestLogHistory`。
   *
   * `exhausted` 说明再往前没有了——前端据此把「加载更早」按钮收掉，
   * 而不是让用户一直点一个什么都不会发生的按钮。
   */
  | { type: 'logHistory'; entries: LogEntry[]; exhausted: boolean }
  /** 要求前端弹一个 modal（仅独立版）。用户提交后回 `promptResult`。 */
  | {
      type: 'prompt';
      requestId: string;
      kind: 'input' | 'confirm' | 'pick';
      title: string;
      message?: string;
      placeholder?: string;
      value?: string;
      password?: boolean;
      multiline?: boolean;
      options?: string[];
    };

/** 文件操作的单项结果。失败时保持原路径并给出原因（toast 也会同时报）。 */
export interface FileOpResult {
  from: string;
  /** 操作成功后的新路径；失败时没有。 */
  to?: string;
  ok: boolean;
  error?: string;
}

/** 内置编辑器里一份文件的快照（core/fileEditing.ts 的 EditorFile 的线上形状）。 */
export interface EditorFileView {
  /** 工程内相对路径（正斜杠）。同时是前端标签页的 key。 */
  path: string;
  name: string;
  text: string;
  /** 保存时回传的乐观锁基线。 */
  hash: string;
  bytes: number;
  /**
   * 这份文件是某一章的正文时，给出它草稿的相对路径（文件不一定已存在）。
   * 前端据此决定要不要显示工具栏上的「草稿」按钮，不必自己复刻章节判定规则。
   */
  draftPath?: string;
}

export interface ViewState {
  initialized: boolean;
  /**
   * 章节清单（输入框旁的目标下拉框用）。
   *
   * 带 `relPath` 是因为**创作目标一律按路径标识**：序号会撞
   * （`001 序.txt` 与 `001 正文.txt` 并存是允许的），路径不会。
   */
  chapters: { order: number; title: string; wordCount: number; relPath: string }[];
  nextOrder: number;
  staleCount: number;
  /** 当前模型引用；未配置好时为空串。 */
  model: string;
  /** 当前模型的展示名，如「智谱 GLM · glm-4-plus」。 */
  modelLabel: string;
  /** 模型引用无效时的说明，直接显示在输入框下方。 */
  modelIssue?: string;
  /** 下拉框用的全部可选模型。 */
  models: { ref: string; label: string; group: string }[];
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * 工程页的全部内容。一次性推完——这些数据量很小（几十到几百行），
 * 分层懒加载换来的那点开销不值得让 webview 维护展开状态与请求往返。
 *
 * 三个区（章节/角色/设定）都是**任意深度的目录树**：`chapters` / `characters`
 * / `lore` 是各区根目录下的直接子节点，目录节点自带 `children`。
 * 展开/折叠状态仍然完全留在前端，按 relPath 记住。
 */
export interface ProjectTree {
  initialized: boolean;
  title: string;
  author: string;
  chapterCount: number;
  totalWords: number;
  staleCount: number;
  /**
   * 摘要已是最新的章节数。`staleCount + summarizedCount === chapterCount`。
   *
   * 与 staleCount 一起给，前端才画得出「已完成 N/M」的进度条——
   * 只有 staleCount 时，用户看到「76 章待总结」不知道分母是多少，
   * 同步跑到一半也说不清还剩几章。
   */
  summarizedCount: number;
  chapters: ProjectNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  /**
   * 摘要里出现、但还没有角色卡的人物，按出场章数降序。
   *
   * 与 `characters` 分开而不是混在一起：那棵树是**文件树**（能重命名、移动、
   * 删除），这些人还没有文件。混进去会让右键菜单上的「删除」无从谈起。
   */
  cast: CastEntry[];
  /**
   * 已建卡角色的出场统计，按角色卡的 relPath 索引。
   * 前端据此给角色行加「出场 12 章」的副标题，不必自己去翻摘要。
   */
  castByCard: Record<string, CastSummary>;
  /** 参与统计的摘要数。为 0 说明还没生成过摘要，前端据此改文案。 */
  summaryCount: number;
  /**
   * 未解决的失败记录，按目标的 relPath 索引（覆盖章节/角色/设定三个区）。
   *
   * 工程页据此在对应行上挂红色感叹号，悬停看原因。数据来自工程库
   * （`core/errorLog.ts`），成功一次就被清掉。
   *
   * 放进这棵树是有意的，尽管它每次文件变动都全量重推：一条记录只有几十字，
   * **且只有出错的目标才有**——正常工程这里是个空对象，撑不爆推送。
   * 这一点与「摘要正文不进 ProjectTree」不冲突（那是每章上千字、人人都有）。
   */
  failures: Record<string, FailureView[]>;
  /**
   * 多张角色卡抢同一个称呼。
   *
   * 出场统计按称呼归属，一个称呼只能算给一张卡，所以有冲突就必然有一张的
   * 出场章节是错的——而这件事从数据上完全看不出来，必须说出来。
   */
  castConflicts: CastConflictView[];
  /** 各区的根目录相对路径，供「在此新建」与「移动到根」用。 */
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  /** 全书摘要覆盖到第几章；0 表示还没生成。 */
  globalSummaryThrough: number;
  styleGuidePath: string;
  outlinePath: string;
  globalSummaryPath: string;
}

/**
 * 树上的一个节点：目录、章节，或角色/设定文件。
 * 目录节点只有 `label` / `relPath` / `children`；文件节点按 kind 带各自的字段。
 */
export type ProjectNode = ProjectDirNode | ProjectChapterNode | ProjectFileNode;

export interface ProjectDirNode {
  kind: 'dir';
  label: string;
  relPath: string;
  children: ProjectNode[];
  /** 子树里的文件数（含各级子目录），用于目录行的副标题。 */
  fileCount: number;
}

export interface ProjectChapterNode extends ProjectChapter {
  kind: 'chapter';
}

export interface ProjectFileNode extends ProjectFile {
  kind: 'file';
}

export interface ProjectChapter {
  order: number;
  title: string;
  relPath: string;
  wordCount: number;
  /** 摘要缺失或过期。 */
  stale: boolean;
  /** 摘要文件路径；没生成过则为空。 */
  summaryPath: string;
  /** 这一章草稿的工作区相对路径；不在章节根下时为空串。文件不一定已存在。 */
  draftPath: string;
  /** 草稿文件已经存在。决定菜单文案（打开草稿 / 新建草稿）与行上的标记。 */
  hasDraft: boolean;
  /**
   * 流水线状态的**精简版**：这一章现在该做哪一步、四层各自的完成度。
   *
   * 只带这两个字段，不带完整的 `ChapterPipelineView`——那棵树每次文件变动
   * 都全量重推，五百章各带一份场景清单就是几百 KB。要看细节点开那一章，
   * 走 `requestPipeline`。
   */
  stage: ChapterStage;
  progress: PipelineProgress;
  /** 有任何一层的上游变过（大纲改了/细纲改了/场景改了）。行上挂一个提示点。 */
  upstreamStale: boolean;
}

/**
 * 一章流水线的完整视图。创作页的流水线条与场景列表吃这一份。
 *
 * 与数据层的 `ChapterPipeline` 几乎同形，但**是线上形状**：这里不出现
 * 数据层才用得上的 hash，只出现「界面要显示什么」。
 */
export interface ChapterPipelineView {
  chapterRelPath: string;
  order: number;
  title: string;
  /** 细纲；没规划过时缺席。 */
  plan?: { relPath: string; filled: boolean; upstreamStale: boolean };
  scenes: ScenePipelineView[];
  manuscript: { words: number; beatsStale: boolean };
  summary: { exists: boolean; stale: boolean };
  stage: ChapterStage;
  progress: PipelineProgress;
}

export interface ScenePipelineView {
  no: number;
  title: string;
  relPath: string;
  /** 一行摘要（`2. 翻越侧峰 · 侧峰 · 子时`），后端生成，前端直接显示。 */
  detail: string;
  status: 'draft' | 'ready' | 'written';
  /** 「必须发生」已填，可以写正文了。 */
  ready: boolean;
  /** 生成这一场之后本章细纲改过——前置条件可能已经失效。 */
  upstreamStale: boolean;
}

/**
 * 状态机算出的下一步，加上它落在哪个具体产物上。
 *
 * `NextStepPlan` 是纯判断（在 model/pipeline.ts 里，可单测）；`target` 与
 * `order` 由控制器补上——纯函数查不了章节列表，也不该查。
 */
export interface NextStepView extends NextStepPlan {
  target: CreationTarget;
  /**
   * 章节序号。只有 `projectAction` 那一支用得上（工程动作按序号寻址）。
   *
   * 不让前端拿会话里的 `targetOrder` 顶替：那份可能还没同步（旧会话、
   * 刚改过名），而 `summarizeChapter` 收到 undefined 会**静默什么都不做**。
   */
  order?: number;
}

/** 工作区卡里的一条。`key` 是小节名（「必须发生」），`text` 是它的内容。 */
export interface WorkbenchSection {
  key: string;
  text: string;
}

/**
 * 「我现在正在改的那份东西」。创作页顶部那张卡吃这一份。
 *
 * 刻意**不带正文全文**：正文层只给字数与场景写入进度（见 core/workbench.ts）。
 */
export interface WorkbenchView {
  stage: CreationStage;
  /** 卡片标题，如「细纲 · 第 12 章《夜入青云》」。后端生成，文案只有一份。 */
  title: string;
  /** 「打开」按钮的落点；空串表示这一层还没有文件。 */
  relPath: string;
  sections: WorkbenchSection[];
  /** 上游变更之类的提示，一句人话。 */
  warning?: string;
  /** 这一层还没有产物时的说明。有它就不该再画 sections。 */
  empty?: string;
}

export interface ProjectFile {
  label: string;
  relPath: string;
  /** 副标题，如角色别名、设定关键词。 */
  detail: string;
}

/** 摘要里出现、尚未建卡的一位人物。 */
export interface CastEntry {
  name: string;
  /** 摘要里见过的其它称呼。 */
  aliases: string[];
  /** 出场章节序号，升序。 */
  chapters: number[];
  /** 人类可读的出场描述，如「第 3、7、12 章」。后端生成，两处文案不会分叉。 */
  detail: string;
}

/** 一位已建卡角色的出场统计。 */
export interface CastSummary {
  chapters: number[];
  detail: string;
  /** 上次更新角色卡时读到第几章；0 表示从未更新过。 */
  updatedThrough: number;
  /** 上次更新之后新增的出场章节数。>0 时前端在行上给个提示点。 */
  pending: number;
}

/**
 * 一条未解决的失败记录（工程页行上的红色感叹号 + 悬停浮窗）。
 *
 * 刻意不带 `targetKind` / `op` / `id`：前端只需要「显示什么」——那些字段
 * 是库里用来筛选与清除的，摊到线上只会让每次全量推树多带一份没人读的数据。
 */
export interface FailureView {
  /** ISO 时间戳。浮窗里显示成 `12:03:41`，用户才对得上日志页。 */
  at: string;
  /**
   * - `error`：整体失败，目标一字未改（红色感叹号）。
   * - `warn`：部分成功，但有一块没成、下次会重来（黄色感叹号）。
   */
  severity: 'error' | 'warn';
  /** 一句人话，浮窗标题行。 */
  message: string;
  /** 多行补充：失败的批次/章节、水位线停在哪、建议怎么办。 */
  detail?: string;
}

/** 多张角色卡抢同一个称呼。 */
export interface CastConflictView {
  /** 被抢的称呼。 */
  name: string;
  /**
   * - `name`：两张卡的**正式名**一模一样，多半是同一个人建了两张卡。
   * - `alias`：一个称呼被多张卡当成自己的（别名撞别名，或别名撞上别人的正式名）。
   */
  kind: 'name' | 'alias';
  /** 卷入的角色卡，供前端显示与跳转。第一个是当前占着这个称呼的那张。 */
  cards: { name: string; relPath: string }[];
}

/**
 * 一章摘要的线上形状（工程页悬停浮窗用）。
 *
 * 刻意不复用 `ChapterSummary`：那是数据层的结构，带着 `sourceHash` 这种
 * 前端用不上的字段；这里给的是「浮窗要显示什么」——章号章名、有没有、
 * 新不新鲜、分好块的小节。
 */
export interface ChapterSummaryView {
  order: number;
  /** 章节标题，浮窗标题行用。 */
  title: string;
  /** 摘要文件存在。为 false 时 `sections` 全空，浮窗显示「还没有摘要」。 */
  exists: boolean;
  /** 摘要与当前正文对不上（正文改过或摘要缺失）。浮窗要标出来。 */
  stale: boolean;
  /** 摘要文件路径；不存在时为空串。 */
  relPath: string;
  /** 固定小节，顺序即展示顺序。空小节由前端跳过。 */
  sections: { name: string; text: string }[];
}

export interface SerializedSession {
  id: string;
  title: string;
  /** 当前在改哪个产物。前端的面包屑与能力按钮组吃它。 */
  target: CreationTarget;
  /** 当前选中的阶段。多数时候等于 `target.kind`，但可以不等——在正文页上
   *  讨论这一章的细纲是合理的（stage=plan，target 仍指着这一章）。 */
  stage: CreationStage;
  capability: Capability;
  targetOrder?: number;
  targetWords?: number;
  turns: SerializedTurn[];
}

export interface SerializedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  attachments?: SerializedAttachment[];
  context?: SerializedDigest;
  acceptedTo?: string;
  interrupted?: boolean;
  error?: string;
  /** 推理模型的思考过程。折叠展示，不属于正文，采纳时不写入章节。 */
  reasoning?: string;
  /**
   * 仅 assistant 轮：这一轮产出的是可采纳的产物时，给出它的形状。
   *
   * 前端据此渲染采纳卡片（「拆出了 4 场，采纳？」）而不是一个光秃秃的
   * 「写入章节」按钮。缺席 = 这是一次讨论，没有可落盘的东西。
   */
  artifact?: SerializedArtifact;
}

/**
 * 一份可采纳产物的**展示形状**。
 *
 * 刻意不带解析后的结构：真正落盘时后端会拿气泡里的文本重新解析一遍
 * （用户可能改过），所以线上只需要「显示什么、按钮写什么」。
 */
export interface SerializedArtifact {
  /** 落点描述，如「第 12 章 · 细纲」。后端生成，文案只有一份。 */
  where: string;
  /** 产物摘要，如「4 场」「细纲 · 5/5 节」。 */
  summary: string;
  /** 目标位置已有内容——采纳会触发覆盖审阅。按钮文案据此改成「覆盖…」。 */
  overwrites: boolean;
}

export interface SerializedDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  items: {
    id: string;
    label: string;
    kind: string;
    priority: number;
    tokens: number;
    status: string;
    note?: string;
    source?: string;
  }[];
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
  active: boolean;
}

/** 日志与任务的形状定义在各自模块里，这里转出去供前端与壳统一从协议引用。 */
export type { LogEntry, LogLevel } from './logger';
export type { TaskSnapshot } from './progress';
/** 资源管理器的目录列举结果，形状定义在 fileTree.ts。 */
export type { DirListing, FsEntry } from './fileTree';
/**
 * 创作流水线的领域类型。定义在 `model/pipeline.ts`（纯函数、零 I/O），
 * 从协议转出去——前端的命令面板直接读 `commandsFor`，两边共用一份定义
 * 才不会出现「界面上有这个命令，后端不认这个能力」。
 */
export type {
  Capability,
  ChapterStage,
  CreationAction,
  CreationStage,
  CreationTarget,
  NextStepFacts,
  NextStepPlan,
  PipelineProgress,
  StageCommand,
} from './model/pipeline';

/** CSP 用的一次性 nonce。 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
