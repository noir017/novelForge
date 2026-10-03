import type { LlmTask, ModelTier } from '../model/tiers';
import type { ThinkingDepth } from '../model/thinking';
import type { ReviewIssueEdit } from '../model/review';
import type {
  Capability,
  CreationStage,
  CreationTarget,
} from '../model/pipeline';
import type { SerializedProvider } from './out';
import type { SkillStage } from '../model/writingSkill';

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
  | { type: 'openSession'; id: string }
  | { type: 'newSession' }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  | { type: 'openEditor'; path: string; pane?: EditorPane }
  | { type: 'openDraft'; path: string }
  /**
   * 打开一章（W6 章节工作台）：正文在主区、这一章的细纲并排在旁边。宿主没有「并排打开」
   * 这一项能力时只开一份。收的是这一章的细纲路径（还没有细纲时是它应该在的位置）。
   */
  | { type: 'openChapter'; plotRelPath: string }
  /**
   * 章节工作台工具条上的按钮：对这一章做一件事。`write` / `continue` / `rewrite` 等于对这一章
   * 按下主按钮（切到它的正文层、按那种写法发一轮生成），`finalize` 走定稿。
   */
  | { type: 'chapterAction'; plotRelPath: string; action: ChapterAction }
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
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  | { type: 'reloadFile'; path: string }
  | { type: 'listDir'; dirs: string[]; ephemeral?: boolean }
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  | { type: 'requestSummary'; plotRelPath: string }
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
  | { type: 'bindSkill'; stage: SkillStage; id: string | null };

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
  | 'generateLore'
  | 'extractStyle'
  | 'generateThreads'
  /** 拆书 A：把工程里的一本 txt 切成章节（零调用；后端弹框挑文件、报切分结果）。 */
  | 'importManuscript'
  /** 拆书 A：从已写正文补齐摘要、角色卡、架构、大纲、细纲（只补空白，两次确认）。 */
  | 'deriveFromText'
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
  recentChaptersFullText: number;
  prevChapterTailChars: number;
  summaryBatchSize: number;
  requestTimeoutMs: number;
  concurrency: number;
  fallbackAttempts: number;
  /** 写完正文删修饰。 */
  trimModifiers: boolean;
  /** 新窗口中打开项目（独立版）。插件的设置页没有这一项，不带就保持原值。 */
  openInNewWindow?: boolean;
}
