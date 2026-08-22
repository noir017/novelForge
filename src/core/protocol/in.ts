import type { LlmTask, ModelTier } from '../model/tiers';
import type { AgentPolicy } from '../model/agentPolicy';
import type { SkillModes } from '../model/skillMode';
import type { ThinkingDepth } from '../model/thinking';
import type { CreationTarget } from '../model/pipeline';
import type { SerializedProvider } from './out';

export type Tab = 'chat' | 'project' | 'files' | 'history' | 'settings' | 'logs';

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
}
