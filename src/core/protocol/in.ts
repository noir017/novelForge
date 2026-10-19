import type { LlmTask, ModelTier } from '../model/tiers';
import type { ThinkingDepth } from '../model/thinking';
import type { ContextDetail } from '../model/contextDetail';
import type { ReviewIssueEdit } from '../model/review';
import type {
  Capability,
  CreationStage,
  CreationTarget,
} from '../model/pipeline';
import type { SerializedProvider } from './out';
import type { SkillStage } from '../model/writingSkill';
import type { ParagraphStyle } from '../model/paragraphFormat';
import type { BookFindQuery, BookReplaceRequest } from './bookFind';

export type Tab = 'chat' | 'project' | 'files' | 'history' | 'settings' | 'logs';

export interface SendPayload {
  text: string;
  stage: CreationStage;
  capability: Capability;
  target: CreationTarget;
  targetNo: number;
  /**
   * 这一步覆盖的章号区间（主按钮「拆细纲（第 6–10 章）」「续写情节大纲（第 21–40 章）」
   * 带过来的）。细纲给了区间就是一批（一次出几章，最多 5 章），大纲按它只写那一段。
   *
   * 从前这里还有一个 `targetWords`（输入框下面那个，默认 2000）。它和细纲里的
   * `targetWords` 两处都能写，作者分不清哪个生效——现在只认细纲（W1）。
   */
  range?: { from: number; to: number };
  /**
   * 一句话弹窗带过来的规模（W4）。给了就是「从一句话生成小说配置」：作者那句话写进
   * 「一句话」一节，总章数与每章字数以这里为准，`config.md` 已有内容时保留原文、追加生成。
   */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /**
   * 写正文的写法（主按钮「接着写」「重写第 N 章」、章节工作台带过来的）。`continue` 只写新增的
   * 那一段并追加；其余在这一章已有正文时整章重写、覆盖前审阅。不给就按磁盘定。
   */
  writeMode?: 'continue' | 'rewrite';
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

export type EditorPane = 'main' | 'draft';

/**
 * 打开文件时前端带上、后端在 `editorOpen` 里**原样带回**的两个标记。后端不看它们，内置编辑器据此决定
 * 新开一个标签还是复用一个（`media/src/editor/pane.ts` 的 `upsertFile`）。插件壳没有内置编辑器，带了也只是被忽略。
 */
export interface EditorOpenIntent {
  /**
   * 单击打开（工程页 / 文件页的一行）：临时标签——每块编辑区最多一个，下一次单击打开别的文件时换掉它；
   * 在里面编辑、保存，或双击就转正。不带 = 正常标签（落盘后自动打开、点引文、「并排看细纲」、双击那一行）。
   */
  preview?: boolean;
  /** 没改过就在原位置换掉这一份（上一章 / 下一章）：新的一份占它的位置。改过了就另开一个标签。 */
  replace?: string;
}

/** `checkEditorFiles` 的一项：编辑器里开着的一份文件，以及编辑器知道的它在磁盘上的 hash。 */
export interface EditorFileCheck {
  path: string;
  hash: string;
}

/** 章节工作台工具条上的按钮。`review` 是五期的审稿：只出报告，不写文件。 */
export type ChapterAction = 'write' | 'continue' | 'rewrite' | 'finalize' | 'review';

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  | { type: 'setTarget'; target: CreationTarget }
  | { type: 'selectPlot'; plotRelPath: string }
  | { type: 'requestPipeline'; plotRelPath?: string }
  | { type: 'editTurn'; turnId: string; text: string }
  | { type: 'deleteTurn'; turnId: string }
  /**
   * 「复制完整上下文」：要这一轮发给模型的完整消息（`ChatTurn.contextMessages`）。回的是
   * `contextText`，带同一个 `requestId`——回复是广播，两个视图都收得到，只有点的那一边认它。
   */
  | { type: 'copyContext'; turnId: string; requestId: string }
  | { type: 'openSession'; id: string }
  | { type: 'newSession' }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  /** `preview` / `replace` 见 {@link EditorOpenIntent}：后端原样带回 `editorOpen`。 */
  | { type: 'openEditor'; path: string; pane?: EditorPane; preview?: boolean; replace?: string }
  | { type: 'openDraft'; path: string }
  /**
   * 打开一章（W6 章节工作台）：正文在主区、这一章的细纲并排在旁边。宿主没有「并排打开」
   * 这一项能力时只开一份。收的是这一章的细纲路径（还没有细纲时是它应该在的位置）。
   * `preview`：工程页单击那一行的名字，两份都开成临时标签（原样带回 `editorOpen`）。
   */
  | { type: 'openChapter'; plotRelPath: string; preview?: boolean }
  /**
   * 章节工作台工具条上的按钮：对这一章做一件事。`write` / `continue` / `rewrite` 等于对这一章
   * 按下主按钮（切到它的正文层、按那种写法发一轮生成），`finalize` 走定稿。
   */
  | { type: 'chapterAction'; plotRelPath: string; action: ChapterAction }
  /**
   * 工程页「故事架构」那几行右键「重写…」：先问一句重写要求（可留空），再对那一件发一轮生成。
   * 与 `setTarget` 分开——那条只是进入这一层（讨论），不花钱。
   */
  | { type: 'rewriteArchitecture'; target: CreationTarget }
  /**
   * 工程页设定条目、「待完善」那一行右键「展开…」（完善设定，2026-10-19）：先问一句要求（可留空），
   * 再把对话页的目标换成这一条设定、发一轮生成（展开）——同 `rewriteArchitecture` 那条路。
   * `relPath` 是已有条目；还没有条目时给 `name` 与 `category`（细纲第九节里的名字与分类），
   * 后端先按分类建空条目再展开。
   */
  | { type: 'expandLore'; relPath?: string; name?: string; category?: string }
  /**
   * 审稿报告卡底部「按勾选的 n 条修稿」（五期 W10）：报告在哪一轮、勾了哪几条（条目 id）。
   * 后端按那一轮的报告拼清单、按磁盘上此刻的正文重新定位引文，发一轮修稿。
   */
  | { type: 'reviseChapter'; turnId: string; picks: string[] }
  /**
   * 报告卡编辑模式点了「保存」（五期补遗 §3）：那一轮报告的整张问题表。模型给的不能删（表里漏了
   * 就原样留着），作者加的不带 `id`。后端校验之后写回那一轮、落盘、推回。
   */
  | { type: 'editReview'; turnId: string; issues: ReviewIssueEdit[] }
  /**
   * 点报告卡上的引文：在编辑器里打开那一章、选中那一句（五期 W10）。宿主没有「定位」这一项
   * 能力时只打开文件，并提示那一句。
   */
  | { type: 'revealQuote'; relPath: string; quote: string }
  /**
   * 内置编辑器保存。`baseHash` 是乐观锁基线（不带 = 作者明确选了强制保存）。带了基线而磁盘上已经没有这个
   * 文件（被删、被改名）时**不在原路径重建**，回 `editorDiskGone`；作者答应重建之后才带 `recreate: true` 再发一次。
   */
  | { type: 'saveFile'; path: string; text: string; baseHash?: string; recreate?: boolean }
  | { type: 'reloadFile'; path: string }
  /**
   * 内置编辑器核对磁盘：两块编辑区里打开着的每份文件，带编辑器知道的那份磁盘版本的 hash（已经标成
   * 「磁盘上没了」的给空串）。后端只读这几份：对不上的回 `editorDiskChanged`，读不到的回 `editorDiskGone`，
   * 对得上的不回。前端在每条 `state` 之后去抖、窗口重新拿到焦点 / 页面重新可见时发。
   * **不复用 `editorOpen`**——那条会把标签切成当前的、抢焦点。
   */
  | { type: 'checkEditorFiles'; files: EditorFileCheck[] }
  /**
   * 内置编辑器冲突条「对比合并…」：编辑器里的这一份（`text`）与磁盘上此刻的那一份逐段挑（左边磁盘上的、
   * 右边编辑器里的，`Host.mergeTexts`）。采纳后回 `editorReplace`（带 `base`：乐观锁基线换成磁盘那份）；
   * 放弃什么都不回。宿主没有合并视图时只回一句说明。
   */
  | { type: 'mergeWithDisk'; path: string; text: string; requestId: string }
  /** 历史版本（`workspace/history.ts`）：列出这份文件的快照，回 `versions`。 */
  | { type: 'listVersions'; path: string }
  /** 读某一个快照的全文，回 `versionText`（同一个 `requestId`）。 */
  | { type: 'readVersion'; path: string; id: string; requestId: string }
  /**
   * 快照 ↔ 编辑器里当前的这一份（`text`）逐段挑；采纳后回 `editorReplace`（不带 `base`：基线不变）。
   * 恢复与对比都**不写盘**，换进编辑区之后存不存由作者。
   */
  | { type: 'compareVersion'; path: string; id: string; text: string; requestId: string }
  /**
   * 「现在存一版」：把**磁盘上当前**这份强制存一个快照（编辑器里没保存的修改不算），之后重推 `versions`。
   * `quiet`：「恢复这一版」放回编辑区之前顺手发的那一次——不说话（成了、一样不重复存都不弹提示），只保证
   * 换进来的内容存下去之前，被它盖掉的那一份已经在历史里（节流拦不住它）。
   */
  | { type: 'saveVersion'; path: string; quiet?: boolean }
  /**
   * 全书查找替换（独立版「编辑 → 全书查找替换…」，`protocol/bookFind.ts`）：按范围逐份读盘找，回 `bookFindResult`
   * （同一个 `requestId`）。带 `query.replacement` 就是「预览替换」：每一处多带换成什么、每份文件带读到时的 hash。
   * 前端在输入停顿之后才发，新的一次发出之前先 `cancelBookFind` 上一次（后端在两份文件之间看一眼，叫停了就不回话）。
   */
  | { type: 'bookFind'; requestId: string; query: BookFindQuery }
  | { type: 'cancelBookFind'; requestId: string }
  /**
   * 「替换所选」：预览里勾着的那几处，经网关逐份写（`review: false`，带预览时的 hash 当乐观锁，每份先强制存一版历史；
   * `dirty` 里的那几份——编辑器里有未保存的修改——跳过）。回 `bookReplaceDone`（汇总）。
   */
  | { type: 'bookReplace'; requestId: string; request: BookReplaceRequest }
  | { type: 'listDir'; dirs: string[]; ephemeral?: boolean }
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  | { type: 'requestSummary'; plotRelPath: string }
  /**
   * 「转到…」（独立版 Ctrl+P）打开时要一份索引：章节、角色卡、设定、架构几件与大纲 / 文风 / 叙事线 /
   * 全书摘要、草稿（`views/quickOpen.ts`）。回 `quickOpenIndex`，带同一个 `requestId`——回复是广播，
   * 两个视图都收得到，只有发问的那一边认它。按需要，不常驻推送。
   */
  | { type: 'requestQuickOpen'; requestId: string }
  /**
   * 内置编辑器「编辑敏感词表…」（体检面板、「视图 → 体检」）：`.novelforge/sensitive.txt` 不在就经网关新建一份
   * 带说明注释的模板（`mode: 'create'`，同名不覆盖），然后在编辑器里打开它。还不是小说工程时只说一句。
   */
  | { type: 'editSensitiveWords' }
  /**
   * 内置编辑器「名词补全」要名词表（角色卡的名字与别名、设定条目的标题与关键词、名录里出现过还没建条目的名字，
   * `views/nameIndex.ts`）。回 `nameIndex`，带同一个 `requestId`（回复是广播，只有发问的那一边认它）。`have` 是前端
   * 手上那一份的 `sig`：对得上就只回 `sig`、不带表。按需要，不常驻推送。
   */
  | { type: 'requestNameIndex'; requestId: string; have?: string }
  /**
   * `range` 只有「批量拆细纲」用：弹窗里选的区间（W5）。`confirmed` 表示弹窗已经把
   * 调用次数写给作者看过了，后端不再弹第二个确认框（弹窗与确认框算的是同一个
   * `planPlotBatches`，不叠弹窗）。「批量写章」（W9）同样带 `range` / `confirmed`，另带
   * `mode`：只写正文，还是写完一章就定稿（`planWriteBatch`）；`review`：写完一章先审一遍，
   * 报告放进一个新会话（五期补遗 §4）。
   */
  | {
      type: 'projectAction';
      action: ProjectAction;
      relPath?: string;
      dir?: string;
      range?: { from: number; to: number };
      confirmed?: boolean;
      mode?: 'draft' | 'finalize';
      review?: boolean;
      /** `newLore`：预填的标题（「出现过 · 未建条目」那一行右键新建时带上），给了就不再问；`buildLore`：建哪一条。 */
      name?: string;
    }
  | { type: 'characterAction'; action: CharacterAction; name: string; relPath?: string }
  | {
      type: 'fileAction';
      action: FileAction;
      relPath?: string;
      relPaths?: string[];
      op?: 'cut' | 'copy';
      targetDir?: string;
    }
  | { type: 'selectModel'; ref: string }
  /**
   * 换这个会话的思考深度。**跟着会话走**（见 model/session.ts），所以不是
   * 设置项：它与「这件事有多难」绑在一起，而那是每个会话各自的事。
   */
  | { type: 'setThinking'; depth: ThinkingDepth }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  | { type: 'testConnection'; ref?: string; provider?: SerializedProvider }
  | { type: 'openNativeSettings' }
  | { type: 'cancelTask'; id: string }
  /**
   * 「写完这一章就停」（W8）：批量写章只在章与章之间停——正在写的那一章照常写完、落盘，
   * 然后收。与 `cancelTask`（中断正在写的）是两回事。
   */
  | { type: 'stopAfterItem'; id: string }
  | { type: 'requestLogs' }
  | { type: 'requestLogHistory'; before?: string }
  | { type: 'clearLogs' }
  | { type: 'promptResult'; requestId: string; value?: string }
  /**
   * 作者在对话页那张权限卡片上点了一颗按钮（`gate` 的回答）。**只有两个值**
   * ——叫停整轮走的是 `stop`，不在这张卡上。卡片带 `remember` 时，点那第三颗按钮也是
   * `proceed`，另带上作者填的理由。
   *
   * 认不出的 `requestId` 静默丢弃：重连之后前端可能还留着一张早就结束了的
   * 卡片，为它报错只会让作者莫名其妙。
   */
  | { type: 'gateResult'; requestId: string; verdict: 'proceed' | 'skip'; remember?: string }
  /**
   * 本机列一层目录（绝对路径）。独立版空窗口选工程用；插件不会发。
   * `path` 为空表示根层（Unix 的 `/`，Windows 的盘符列表）。
   */
  | { type: 'listHostDir'; path: string }
  | { type: 'createHostDir'; parent: string; name: string }
  | { type: 'openFolder'; path: string; mode?: 'replace' | 'add' }
  | { type: 'closeFolder'; id?: string }
  | { type: 'activateWorkspace'; id: string }
  /** 独立版：这个窗口拿到了焦点。没指定工程的 MCP 调用落到最近操作的窗口上。 */
  | { type: 'windowFocus' }
  | { type: 'openLogDir' }
  /** 有工程时经 workspace 写文件；已存在拒绝。`text` 缺省为空。 */
  | { type: 'createFile'; relPath: string; text?: string }
  /** 打开使用说明：工程内 README，否则仓库根 README。 */
  | { type: 'openReadme' }
  // ---- 设置页「技能」（写作技能）。没打开工程时只有前四条有用：绑定跟着工程走。
  | { type: 'requestSkills' }
  /** 下载并检查一份 GitHub 上的技能。不写任何文件。 */
  | { type: 'inspectSkill'; url: string }
  /** 装检查过的那一份。后端先弹确认框，再重新下载核对。 */
  | { type: 'installSkill'; url: string }
  /** 从我的技能库卸载（挪进回收站）。只认 `user:` 的。 */
  | { type: 'uninstallSkill'; id: string }
  /** 本工程某个阶段绑哪份；`id` 为 null 是不带。 */
  | { type: 'bindSkill'; stage: SkillStage; id: string | null }
  /**
   * 内置编辑器「编辑 → 段落格式」：切换正文的分段格式。后端只改 `config.md` frontmatter 的
   * `paragraphStyle` 这一个键（`Workspace.setParagraphStyle`），然后 `pushState`。
   */
  | { type: 'setParagraphStyle'; style: ParagraphStyle };

export type ProjectAction =
  | 'initProject'
  | 'refresh'
  | 'newPlot'
  | 'newChapter'
  | 'newCharacter'
  | 'newLore'
  | 'newFolder'
  | 'finalizeChapter'
  | 'syncSummaries'
  | 'rebuildGlobalSummary'
  | 'generatePlots'
  | 'completeSettings'
  | 'writeManuscripts'
  | 'extractCharacters'
  /**
   * 记设定（设定名录）：给了 `relPath`（章节或细纲）就单独记那一章，没给就补记全部还没记过设定的
   * 定稿章。动手前后端报调用次数。
   */
  | 'recordLore'
  /** 给「出现过 · 未建条目」建条目：给了 `name` 就建那一条，没给就建出现 ≥2 章的全部。 */
  | 'buildLore'
  /** 把定稿里的新内容并进条目：给了 `relPath`（条目）就整合那一条，没给就是挂 ＋N 的全部。 */
  | 'integrateLore'
  /** 按目录整理：模型出搬家清单，作者看过再搬（范围由后端问）。 */
  | 'organizeLore'
  | 'extractStyle'
  | 'generateThreads'
  /** 拆书 A：把工程里的一本 txt 切成章节（零调用；后端弹框挑文件、报切分结果）。 */
  | 'importManuscript'
  /** 拆书 A：从已写正文补齐细纲、角色卡、架构、大纲（只补空白，两次确认）。 */
  | 'deriveFromText'
  | 'chapterGap'
  /** 拆书 B：从工程里的一本参考书学文风与写法。 */
  | 'learnFromReference';

export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards'
  | 'createAllCards'
  | 'cleanAliases'
  | 'mergeDuplicates'
  /** 定稿时作者改过、没被覆盖的「当前状态」：拿机器给的那一版做一次对比（D15）。 */
  | 'reviewState';

export type FileAction = 'rename' | 'renameAny' | 'move' | 'delete' | 'paste';

export interface SettingsPayload {
  providers: SerializedProvider[];
  models: string[];
  tierModels: Record<ModelTier, string[]>;
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  temperature: number;
  /** 上下文详细度 1–4（model/contextDetail.ts）。 */
  contextDetail: ContextDetail;
  summaryBatchSize: number;
  requestTimeoutMs: number;
  concurrency: number;
  fallbackAttempts: number;
  /** 写完正文删修饰。 */
  trimModifiers: boolean;
  /** 新窗口中打开项目（独立版）。插件的设置页没有这一项，不带就保持原值。 */
  openInNewWindow?: boolean;
}
