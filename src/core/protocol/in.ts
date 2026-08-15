import type { LlmTask, ModelTier } from '../model/tiers';
import type {
  Capability,
  CreationStage,
  CreationTarget,
} from '../model/pipeline';
import type { SerializedProvider } from './out';

export type Tab = 'chat' | 'project' | 'files' | 'history' | 'settings' | 'logs';

export interface SendPayload {
  text: string;
  stage: CreationStage;
  capability: Capability;
  target: CreationTarget;
  targetNo: number;
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

export type EditorPane = 'main' | 'draft';

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  | { type: 'acceptArtifact'; turnId: string; target: CreationTarget; text: string }
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
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  | { type: 'reloadFile'; path: string }
  | { type: 'listDir'; dirs: string[] }
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
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  | { type: 'testConnection'; ref?: string; provider?: SerializedProvider }
  | { type: 'openNativeSettings' }
  | { type: 'cancelTask'; id: string }
  | { type: 'requestLogs' }
  | { type: 'requestLogHistory'; before?: string }
  | { type: 'clearLogs' }
  | { type: 'promptResult'; requestId: string; value?: string };

export type ProjectAction =
  | 'initProject'
  | 'refresh'
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
  | 'breakdownScenes'
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
}
