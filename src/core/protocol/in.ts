import type { LlmTask, ModelTier } from '../model/tiers';
import type { AgentPolicy } from '../model/agentPolicy';
import type { SkillModes } from '../model/skillMode';
import type { ThinkingDepth } from '../model/thinking';
import type { CreationJob, CreationTarget } from '../model/pipeline';
import type { SerializedProvider } from './out';

export type Tab = 'chat' | 'generate' | 'project' | 'files' | 'history' | 'settings' | 'logs';

export interface SerializedAttachment {
  id: string;
  kind: string;
  label: string;
  relPath?: string;
  range?: { start: number; end: number };
  text?: string;
}

export type EditorPane = 'main' | 'draft';

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  /**
   * 让 agent 跑一轮：它自己决定查什么、生成什么。**对话只有这一条路。**
   *
   * 只吃作者那一句话——它没有「在哪一层、干什么」的概念，那两件事由它
   * 自己按每回合注入的状态机结论决定（第 20 条）。前端捎一份过去等于让它
   * 也参与判断，两处迟早分叉。
   *
   * `limits` 留给日后的设置页，缺省走 `budget.ts` 的三条。
   */
  | { type: 'sendAgent'; text: string; limits?: { steps?: number; calls?: number; tokens?: number } }
  | { type: 'stop' }
  /**
   * 「生成」页：换了 job，要这一层的落点候选与这一层会用哪个模型。
   *
   * 候选由后端按层列（`kindOfPath` 认得的那些），**不让作者去拼路径**——
   * 工具收裸路径是因为模型手上只有路径，而作者手上是「第 12 章」。
   *
   * `model` 是下拉框里此刻选中的那个（空 = 按层自动）。**必须带上**：回话里
   * 那份「这一次会用哪个模型」要按它算，否则作者显式挑了一个模型，界面回显的
   * 却还是自动档那一个——而这一行正是他按下花钱按钮之前唯一的依据。
   */
  | { type: 'genTargets'; job: CreationJob; model?: string }
  /**
   * 「生成」页：手动调一次 `generate`。
   *
   * 与 `sendAgent` 是两条完全独立的路：这一条不进会话、不进 agent 循环、
   * 不碰 `DraftStore` 与闸门表（见 controller/generate.ts 的文件头）。
   *
   * `model` 缺席 = 按层自动（照抄 `tools/novel/generate.ts` 那张表）；
   * 给了就严格用它、不走池。`thinking` 缺席 = 不带思考参数。
   */
  | {
      type: 'genRun';
      job: CreationJob;
      target: string;
      ask: string;
      targetWords?: number;
      skills: string[];
      model?: string;
      thinking?: ThinkingDepth;
    }
  /** 「生成」页：停掉正在跑的那一次。 */
  | { type: 'genStop' }
  /**
   * 「生成」页：把这份产出落盘。
   *
   * `text` 是**输出框里当下的文本**，不是生成那一刻的原文——作者可以在采纳
   * 之前改。落盘时按它重新解析（`parseDraftArtifact`）。
   */
  | { type: 'genAdopt'; draftId: string; text: string }
  /** 「生成」页：丢掉这份产出。磁盘不动。 */
  | { type: 'genDiscard'; draftId: string }
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
  /**
   * 重扫一遍技能名单（`/` 面板打开时发一条）。后端回一条 `skillList`。
   *
   * **不搭车在 `pushState` 上**：那条路由文件监听触发（作者每存一次盘就跑一次），
   * 而补描述要按份读盘。面板打开是个明确的时刻，那时多读几个文件不心疼。
   */
  | { type: 'requestSkills' }
  /**
   * 呼出一份技能：作者在 `/` 面板里挑中了它。
   *
   * 后端读出**整份正文**攒着（`ChatController.pendingSkills`），记成输入框上方
   * 一枚标签，随下一次 `sendAgent` 折进作者那句话的前面。
   *
   * 名字来自前端手上那份名单，但后端仍要自己核一遍档位：那份名单可能是几分钟前
   * 推的，作者刚在设置页把这一份改成了「禁用」。
   */
  | { type: 'useSkill'; name: string }
  /** 摘掉输入框上方那枚技能标签。名字是带前缀的全名。 */
  | { type: 'dropSkill'; name: string }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  | { type: 'openEditor'; path: string; pane?: EditorPane }
  | { type: 'openDraft'; path: string }
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  | { type: 'reloadFile'; path: string }
  | { type: 'listDir'; dirs: string[]; ephemeral?: boolean }
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  | { type: 'requestSummary'; plotRelPath: string }
  | { type: 'projectAction'; action: ProjectAction; relPath?: string; dir?: string }
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
  | { type: 'requestLogs' }
  | { type: 'requestLogHistory'; before?: string }
  | { type: 'clearLogs' }
  | { type: 'promptResult'; requestId: string; value?: string }
  /**
   * 作者在对话页那张权限卡片上点了一颗按钮（`gate` 的回答）。**只有两个值**
   * ——叫停整轮走的是 `stop`，不在这张卡上。
   *
   * 认不出的 `requestId` 静默丢弃：重连之后前端可能还留着一张早就结束了的
   * 卡片，为它报错只会让作者莫名其妙。
   */
  | { type: 'gateResult'; requestId: string; verdict: 'proceed' | 'skip' }
  /**
   * 本机列一层目录（绝对路径）。独立版空窗口选工程用；插件不会发。
   * `path` 为空表示根层（Unix 的 `/`，Windows 的盘符列表）。
   */
  | { type: 'listHostDir'; path: string }
  | { type: 'createHostDir'; parent: string; name: string }
  | { type: 'openFolder'; path: string; mode?: 'replace' | 'add' }
  | { type: 'closeFolder'; id?: string }
  | { type: 'activateWorkspace'; id: string }
  | { type: 'openLogDir' }
  /** 有工程时经 workspace 写文件；已存在拒绝。`text` 缺省为空。 */
  | { type: 'createFile'; relPath: string; text?: string }
  /** 打开使用说明：工程内 README，否则仓库根 README。 */
  | { type: 'openReadme' };

export type ProjectAction =
  | 'initProject'
  | 'refresh'
  | 'newVolume'
  | 'newPlot'
  | 'newChapter'
  | 'newCharacter'
  | 'newLore'
  | 'newFolder'
  | 'summarizePlot'
  | 'splitManuscript'
  | 'syncSummaries'
  | 'rebuildGlobalSummary'
  | 'generatePlots'
  | 'writeManuscripts'
  | 'extractCharacters'
  | 'generateLore'
  | 'extractStyle';

export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards'
  | 'createAllCards'
  | 'cleanAliases'
  | 'mergeDuplicates';

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
  /** Agent 的确认策略：careful / default / bold。 */
  agentPolicy: AgentPolicy;
  /**
   * 每份技能的注入方式，键是带前缀的全名。**只带与缺省不同的那几项**
   * （缺省是「仅用户」）。
   */
  skillModes: SkillModes;
  /** 调试模式：完整上下文落盘 + 会话记更全。缺省关。 */
  debug: boolean;
}
