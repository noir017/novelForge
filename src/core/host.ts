import { ConfigStore, initConfigFromHost } from './config';
import { NovelProject } from './model/project';
import { Attachment } from './model/session';
import { EditorPane } from './protocol';

/**
 * core 对宿主的唯一依赖面。VS Code 插件与独立 Web 服务各实现一份。
 * 所有交互类方法（input/confirm/pick）在独立版里经 WebSocket 变成网页弹窗。
 */

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  /** 多行文本输入（独立版渲染 textarea）。 */
  multiline?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface PickChoice<T = string> {
  label: string;
  description?: string;
  detail?: string;
  /** 分组标题，同组只出现一次。 */
  group?: string;
  value: T;
}

export interface Disposable { dispose(): void; }

export interface Host {
  readonly name: 'vscode' | 'standalone';
  /** 该宿主能否提供 vscode-lm（Copilot）模型。 */
  readonly supportsVscodeLm: boolean;
  /** 设置读写后端：插件暂用 settings.json，独立版用 ~/.novelforge/config.json。 */
  readonly config: ConfigStore;

  input(opts: InputOptions): Promise<string | undefined>;
  /** 返回用户点选的 action 文案；取消返回 undefined。 */
  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined>;
  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined>;
  /** 可取消的长任务。report 用于更新进度文案。 */
  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T>;
  /** 监听工程目录变化（章节/元数据）。onChange 的防抖由实现方负责。 */
  watch(project: NovelProject, onChange: () => void): Disposable;
  /** 打开某相对路径文件。独立版降级为 toast 提示路径。 */
  openFile(relPath: string): Promise<void>;
  toast(message: string, level?: 'info' | 'error'): void;

  /** 「加入选区」：插件取编辑器选区；独立版弹粘贴框。返回 undefined 表示放弃。 */
  selectionAttachment(project: NovelProject): Promise<Attachment | undefined>;
  /** 「浏览工作区文件」：插件弹文件对话框；独立版提示输入相对路径。可选。 */
  browseFile?(project: NovelProject): Promise<string | undefined>;
  /**
   * 在宿主自己的编辑器里打开一个文本文件。
   *
   * 独立版实现为「读文件 → 广播 editorOpen」，网页里开内置编辑器；
   * 插件壳不实现——那边 openFile 已经开的是 VS Code 真正的编辑器 tab，
   * controller 会自动回落到 openFile。
   *
   * `pane` 只有独立版认：指明开在主区还是草稿区。
   */
  openInEditor?(relPath: string, pane?: EditorPane): Promise<void>;
  /**
   * 「在旁边打开」：与当前正在编辑的文件并列显示。草稿走这一条。
   *
   * 插件用 ViewColumn.Beside 开第二栏，独立版开第二块编辑区。
   * 宿主不实现时 controller 回落到 openFile（退化为普通打开，不并列）。
   */
  openBeside?(relPath: string): Promise<void>;
  /** 保存内置编辑器的内容。只有提供 openInEditor 的宿主才需要实现。 */
  saveFromEditor?(relPath: string, text: string, baseHash?: string): Promise<void>;
  /** 用系统默认程序打开。独立版用它实现编辑器里的「在外部打开」。 */
  openExternal?(relPath: string): Promise<void>;
  /** 角色卡更新审阅：插件开 diff 编辑器；独立版弹确认框。返回 undefined=取消。 */
  reviewReplace?(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined>;
  /** 「在 VS Code 设置中打开」，仅插件实现。 */
  openNativeSettings?(): Promise<void>;
}

let current: Host | undefined;

export function initHost(host: Host): void {
  current = host;
  initConfigFromHost(host);
}

export function getHost(): Host {
  if (!current) {
    throw new Error('Host 尚未初始化');
  }
  return current;
}
