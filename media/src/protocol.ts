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
  CastEntry,
  CastSummary,
  ChapterSummaryView,
  CharacterAction,
  DirListing,
  EditorFileView,
  EditorPane,
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
  SendPayload,
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
