import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ChatController, ViewHost } from '../../core/controller';
import {
  pushSettingsTo,
  saveSettingsFrom,
  SettingsSink,
  testConnectionTo,
} from '../../core/controller/settings';
import { Disposable } from '../../core/host';
import { clearApiKey, promptForApiKey } from '../../core/llm/registry';
import { InMessage, OutMessage, WorkspaceItem, WorkspaceRecent } from '../../core/protocol';
import { clearLogs, describeError, recentLogs, scoped } from '../../core/runtime/logger';
import { activeTasks, cancelTask } from '../../core/runtime/progress';
import { homeDir } from '../../core/stores';
import { FileHost } from './fileHost';
import { createHostDir, listHostDir } from './hostFs';
import { openWithSystem } from './systemOpen';
import {
  readWindowState,
  rememberClosed,
  rememberOpen,
  writeWindowState,
} from './windowState';

const log = scoped('工作区');

export interface WorkspaceHubOptions {
  broadcast: (msg: OutMessage) => void;
  host: FileHost;
  /** window.json 所在目录。测试注入，缺省为 ~/.novelforge。 */
  windowDir?: string;
}

interface BoundRuntime {
  id: string;
  root: string;
  name: string;
  controller: ChatController;
  watch: Disposable;
}

/**
 * 独立版进程里的工作区登记处。
 *
 * `ChatController` 仍然一对一绑一份 `NovelProject`；多开不进 core。
 * 这一版窗口里只有 0 或 1 个工程，`mode: 'add'` 回明确错误。
 */
export class WorkspaceHub {
  private current: BoundRuntime | undefined;
  private readonly broadcast: (msg: OutMessage) => void;
  private readonly host: FileHost;
  private readonly windowDir?: string;
  private readonly viewHost: ViewHost;

  constructor(opts: WorkspaceHubOptions) {
    this.broadcast = opts.broadcast;
    this.host = opts.host;
    this.windowDir = opts.windowDir;
    this.viewHost = {
      kind: 'editor',
      post: (msg) => this.broadcast(msg),
      reveal: () => undefined,
    };
  }

  private get sink(): SettingsSink {
    return {
      post: (msg) => this.broadcast(msg),
      toast: (message, level) => this.host.toast(message, level),
    };
  }

  activeController(): ChatController | undefined {
    return this.current?.controller;
  }

  snapshot(): {
    currentId: string | null;
    items: WorkspaceItem[];
    recents: WorkspaceRecent[];
  } {
    const recents = readWindowState(this.windowDir).recents.map((r) => ({
      root: r.root,
      name: r.name,
    }));
    return {
      currentId: this.current?.id ?? null,
      items: this.current
        ? [{ id: this.current.id, root: this.current.root, name: this.current.name }]
        : [],
      recents,
    };
  }

  pushSnapshot(): void {
    this.broadcast({ type: 'workspaces', ...this.snapshot() });
  }

  /**
   * 启动时绑定：CLI 给了目录就打开它；否则看 window.json 的 lastOpen。
   * 路径已经不在盘上则清掉该字段，保持空窗口。
   */
  async bootstrap(cliRoot?: string): Promise<void> {
    if (cliRoot) {
      await this.open(cliRoot);
      return;
    }
    const win = readWindowState(this.windowDir);
    if (!win.lastOpen) {
      return;
    }
    try {
      const st = await fsp.stat(win.lastOpen);
      if (st.isDirectory()) {
        await this.open(win.lastOpen);
        return;
      }
    } catch {
      // 目录没了
    }
    writeWindowState({ lastOpen: null, recents: win.recents }, this.windowDir);
  }

  /**
   * 重连 / 前端 ready：有工程则 workspaces + 全量状态；空窗口不发假 init。
   */
  async pushReady(): Promise<void> {
    this.pushSnapshot();
    if (this.current) {
      await this.current.controller.resendFullState();
      return;
    }
    await pushSettingsTo(this.sink);
    this.broadcast({ type: 'logs', entries: recentLogs() });
    this.broadcast({ type: 'tasks', tasks: activeTasks() });
  }

  /**
   * 吃掉 Hub 自己的消息。true = 已处理，server 不要再交给 controller。
   */
  async handle(msg: InMessage): Promise<boolean> {
    switch (msg.type) {
      case 'listHostDir':
        this.broadcast({ type: 'hostDir', ...(await listHostDir(msg.path)) });
        return true;
      case 'createHostDir':
        this.broadcast({ type: 'hostDir', ...(await createHostDir(msg.parent, msg.name)) });
        return true;
      case 'openFolder':
        await this.open(msg.path, msg.mode);
        return true;
      case 'closeFolder':
        await this.close(msg.id);
        return true;
      case 'activateWorkspace':
        this.activate(msg.id);
        return true;
      case 'openLogDir':
        openWithSystem(homeDir());
        return true;
      case 'saveSettings':
        await saveSettingsFrom(
          msg.settings,
          this.sink,
          this.current ? () => this.current!.controller.pushState() : undefined
        );
        return true;
      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await pushSettingsTo(this.sink);
        if (this.current) {
          await this.current.controller.pushState();
        }
        return true;
      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await pushSettingsTo(this.sink);
        return true;
      case 'testConnection':
        await testConnectionTo(
          this.sink,
          msg.ref,
          msg.provider,
          this.current ? () => this.current!.controller.pushState() : undefined
        );
        return true;
      case 'ready':
        await this.pushReady();
        return true;
      case 'openNativeSettings':
        // 独立版没有原生设置页：空窗口也要吃掉这条，避免落到「请先打开文件夹」。
        return true;
      default:
        break;
    }

    if (this.current) {
      return false;
    }

    // 空窗口仍要能切设置/日志、停任务。其余创作类消息由 server 拦。
    switch (msg.type) {
      case 'switchTab':
        this.broadcast({ type: 'tab', tab: msg.tab });
        if (msg.tab === 'settings') {
          await pushSettingsTo(this.sink);
        } else if (msg.tab === 'logs') {
          this.broadcast({ type: 'logs', entries: recentLogs() });
        }
        return true;
      case 'requestLogs':
        this.broadcast({ type: 'logs', entries: recentLogs() });
        return true;
      case 'requestLogHistory':
        this.broadcast({ type: 'logHistory', entries: [], exhausted: true });
        return true;
      case 'clearLogs':
        clearLogs();
        this.broadcast({ type: 'logs', entries: recentLogs() });
        return true;
      case 'cancelTask':
        if (!cancelTask(msg.id)) {
          this.broadcast({ type: 'tasks', tasks: activeTasks() });
        }
        return true;
      default:
        return false;
    }
  }

  async open(absPath: string, mode?: 'replace' | 'add'): Promise<void> {
    let resolved: string;
    try {
      const target = path.resolve(absPath);
      const st = await fsp.stat(target);
      if (!st.isDirectory()) {
        this.host.toast('不是目录', 'error');
        return;
      }
      resolved = await fsp.realpath(target);
    } catch {
      this.host.toast('目录不存在', 'error');
      return;
    }

    if (mode === 'add' && this.current && this.current.id !== resolved) {
      this.host.toast('本版本只支持一个工作区', 'error');
      return;
    }

    if (this.current?.id === resolved) {
      this.activate(resolved);
      return;
    }

    const previousRoot = this.current?.root;
    if (this.current) {
      this.teardown();
    }

    try {
      await this.bindNew(resolved);
    } catch (err) {
      this.host.toast(describeError(err), 'error');
      log.error(`打开工程失败：${describeError(err)}`, err);
      if (previousRoot) {
        try {
          await this.bindNew(previousRoot);
          return;
        } catch (restoreErr) {
          this.host.toast(describeError(restoreErr), 'error');
          log.error(`恢复上一工程失败：${describeError(restoreErr)}`, restoreErr);
        }
      }
      this.teardown();
      rememberClosed(this.windowDir);
      this.pushSnapshot();
    }
  }

  async close(id?: string): Promise<void> {
    if (!this.current) {
      return;
    }
    if (id && id !== this.current.id) {
      return;
    }
    this.teardown();
    rememberClosed(this.windowDir);
    this.pushSnapshot();
    log.info('已关闭文件夹');
  }

  activate(id: string): void {
    if (this.current?.id === id) {
      this.pushSnapshot();
      return;
    }
    this.host.toast('找不到这个工作区', 'error');
  }

  private async bindNew(resolved: string): Promise<void> {
    const project = this.host.bind(resolved);
    let watch: Disposable | undefined;
    try {
      const controller = new ChatController(project);
      controller.attach(this.viewHost);
      watch = this.host.watch(project, () => {
        project.invalidate();
        void controller.pushState();
      });
      this.current = {
        id: resolved,
        root: resolved,
        name: path.basename(resolved) || resolved,
        controller,
        watch,
      };
      rememberOpen(resolved, this.windowDir);
      this.pushSnapshot();
      await controller.resendFullState();
      log.info(`已打开工程：${resolved}`);
    } catch (err) {
      if (this.current) {
        this.teardown();
      } else {
        watch?.dispose();
        this.host.unbind();
      }
      throw err;
    }
  }

  /**
   * 停生成 → 关库 → 停 watcher → 卸 FileHost。
   * 先关库再停 watcher：反过来 Windows 上 sqlite 文件会 EBUSY。
   */
  private teardown(): void {
    const bound = this.current;
    this.current = undefined;
    if (bound) {
      try {
        bound.controller.stopGeneration();
        bound.controller.dispose();
      } finally {
        bound.watch.dispose();
      }
    }
    this.host.unbind();
  }
}
