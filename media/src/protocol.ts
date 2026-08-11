/**
 * 前端与后端的唯一契约：直接从 core 的协议定义里取类型。
 *
 * 改造前这是一句注释约定（「改协议要同时改 view.js」），漏改只能靠手测发现；
 * 现在 `npm run typecheck` 会替我们盯着——后端往 `OutMessage` 里加一个分支、
 * 改一个字段名，前端对不上就编译不过。
 *
 * 全部走 `import type`：只有类型跨过这条边界，一行运行时代码都不会被打包进来
 * （core 是 Node 侧的，带进浏览器会立刻炸）。
 */
export type {
  CastConflictView,
  CastEntry,
  CastSummary,
  ChapterPipelineView,
  ChapterSummaryView,
  CharacterAction,
  DirListing,
  EditorFileView,
  EditorPane,
  FailureView,
  FileAction,
  FileOpResult,
  FsEntry,
  InMessage,
  LogEntry,
  LogLevel,
  OutMessage,
  ProjectAction,
  ProjectChapterNode,
  ProjectDirNode,
  ProjectFile,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
  ScenePipelineView,
  SendPayload,
  SerializedArtifact,
  SerializedAttachment,
  SerializedDigest,
  SerializedModel,
  SerializedProvider,
  SerializedSession,
  SerializedTurn,
  SessionListItem,
  SettingsPayload,
  Tab,
  TaskSnapshot,
  ViewState,
} from '../../src/core/protocol';

/**
 * 创作流水线的类型与那几张对照表。
 *
 * 与 `tiers.ts` 同一套理由：**标签和「哪个阶段有哪些能力」必须与后端同源**。
 * 前端自己抄一份的话，界面上会出现一个后端不认的能力按钮，点了什么都不发生。
 * `model/pipeline.ts` 是纯类型 + 纯函数、**零 import**，打进浏览器产物是安全的。
 */
export {
  CAPABILITIES,
  CAPABILITY_HINT,
  CAPABILITY_LABEL,
  CHAPTER_STAGE_LABEL,
  CREATION_STAGES,
  DEFAULT_CAPABILITY,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterOfTarget,
  outputKindOf,
  targetKey,
} from '../../src/core/model/pipeline';
export type {
  Capability,
  ChapterStage,
  CreationAction,
  CreationStage,
  CreationTarget,
  PipelineProgress,
} from '../../src/core/model/pipeline';

/**
 * 模型分档的类型与那几张对照表。
 *
 * 标签（档位名、任务名、内置默认映射）**必须与后端同源**：设置页上写着
 * 「单章摘要 → 快速档」，跑起来却是另一档，作者就再也不信这张表了。
 * 所以这里连值一起 import（不是 `import type`）——`tiers.ts` 是纯数据 +
 * 纯函数，没有任何 Node 依赖，打进浏览器产物是安全的。
 */
export {
  DEFAULT_TASK_TIERS,
  LLM_TASKS,
  MODEL_TIERS,
  TASK_HINT,
  TASK_LABEL,
  TIER_HINT,
  TIER_LABEL,
} from '../../src/core/model/tiers';
export type { LlmTask, ModelTier } from '../../src/core/model/tiers';
