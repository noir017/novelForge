import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ChatController, ViewHost, createMcpBackend } from '../../core/controller';
import type { NovelProject } from '../../core/model/project';
import { Workspace } from '../../core/workspace';
import { readConfig } from '../../core/config';
import {
  pushSettingsTo,
  saveSettingsFrom,
  SettingsSink,
  testConnectionTo,
} from '../../core/controller/settings';
import {
  bindSkillFrom,
  inspectSkillFrom,
  installSkillFrom,
  pushSkillsTo,
  uninstallSkillFrom,
} from '../../core/controller/skills';
import { Disposable } from '../../core/host';
import { clearApiKey, promptForApiKey } from '../../core/llm/registry';
import type { McpBackend } from '../../core/mcp';
import { InMessage, OutMessage, WorkspaceItem, WorkspaceRecent } from '../../core/protocol';
import { clearLogs, describeError, recentLogs, scoped } from '../../core/runtime/logger';
import { activeTasks, cancelTask } from '../../core/runtime/progress';
import { homeDir } from '../../core/stores';
import { FileHost } from './fileHost';
import { createHostDir, listHostDir } from './hostFs';
import { runInScope, WindowScope } from './scopedHost';
import { openWithSystem } from './systemOpen';
import {
  readWindowState,
  rememberClosed,
  rememberOpen,
  writeWindowState,
} from './windowState';

const log = scoped('工作区');

/** 最后一个窗口离开之后，工程再留多久才关（刷新页面、断线重连都在这段时间里回来）。 */
const IDLE_MS = 60_000;

export interface WorkspaceHubOptions {
  /** 所有窗口共用的设置读写。 */
  config: FileHost['config'];
  /** window.json 所在目录。测试注入，缺省为 ~/.novelforge。 */
  windowDir?: string;
  /** 没有窗口的工程多久之后关。测试注入。 */
  idleMs?: number;
}

/** 一个网页窗口（一条 WebSocket）。 */
export interface WindowConn {
  send(msg: OutMessage): void;
  /** 这个窗口开着的工程。空窗口没有。 */
  runtime?: Runtime;
  /** 空窗口自己的宿主：弹窗、toast 只回这个窗口。 */
  readonly host: FileHost;
  readonly scope: WindowScope;
  /** 连接时绑定工程的那一步。之后的消息要等它做完。 */
  ready: Promise<void>;
}

/** 一个打开着的工程。几个窗口开同一个工程时共用这一份。 */
export interface Runtime {
  id: string;
  root: string;
  name: string;
  project: NovelProject;
  controller: ChatController;
  watch: Disposable;
  host: FileHost;
  scope: WindowScope;
  clients: Set<WindowConn>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 独立版进程里的工作区登记处。
 *
 * 一个进程同时开着几个工程，每个窗口（WebSocket 连接）各自绑一个，或者是空窗口。
 * `ChatController` 仍然一对一绑一份 `NovelProject`；同一个工程开在几个窗口里，它们共用一份。
 * 广播只发给开着这个工程的那几个窗口，设置与最近打开的列表是全局的。
 *
 * core 里的 `getHost()` 靠 {@link runInScope} 落到对应窗口：处理哪个窗口的消息、跑哪个工程的
 * 监听与 MCP 调用，就在哪个上下文里跑。
 */
export class WorkspaceHub {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly conns = new Set<WindowConn>();
  /** 最近操作的那个工程：没指定工程的 MCP 调用、不带 `?project=` 的新窗口都落到它上面。 */
  private lastActive: Runtime | undefined;
  private readonly config: FileHost['config'];
  private readonly windowDir?: string;
  private readonly idleMs: number;

  constructor(opts: WorkspaceHubOptions) {
    this.config = opts.config;
    this.windowDir = opts.windowDir;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  // ---------------------------------------------------------------- 连接

  /**
   * 一个窗口连上来。`requested` 是它网址上的 `?project=`：给了就开那个工程（已经开着就共用），
   * 没给就落到最近操作的那个工程上；都没有是空窗口。
   */
  connect(send: (msg: OutMessage) => void, requested?: string): WindowConn {
    const host = new FileHost(this.config, send);
    const conn: WindowConn = { send, host, scope: { host }, ready: Promise.resolve() };
    this.conns.add(conn);
    conn.ready = (async () => {
      if (requested) {
        await this.openIn(conn, requested, { quiet: true });
      } else if (this.lastActive) {
        this.attach(conn, this.lastActive);
      }
      await this.pushReady(conn);
    })().catch((err) => log.error(`窗口连接失败：${describeError(err)}`, err));
    return conn;
  }

  disconnect(conn: WindowConn): void {
    this.conns.delete(conn);
    conn.host.prompts.cancelAll();
    this.detach(conn);
  }

  /** 网页发来的一条消息。 */
  async receive(conn: WindowConn, msg: InMessage): Promise<void> {
    await conn.ready;
    if (msg.type === 'promptResult') {
      (conn.runtime?.host ?? conn.host).prompts.resolve(msg.requestId, msg.value);
      return;
    }
    this.touch(conn);
    const scope = conn.runtime?.scope ?? conn.scope;
    await runInScope(scope, async () => {
      try {
        if (await this.handle(conn, msg)) {
          return;
        }
        if (!conn.runtime) {
          conn.send({ type: 'toast', message: '请先打开文件夹', level: 'error' });
          return;
        }
        await conn.runtime.controller.handle(msg);
      } catch (err) {
        log.error(`处理网页消息失败：${describeError(err)}`, err);
        conn.send({ type: 'toast', message: describeError(err), level: 'error' });
      }
    });
  }

  // ---------------------------------------------------------------- 查询

  /** 某个窗口眼里的工作区：它自己开着的那一个，加上全局的最近打开。 */
  snapshot(conn?: WindowConn): {
    currentId: string | null;
    items: WorkspaceItem[];
    recents: WorkspaceRecent[];
    openInNewWindow: boolean;
  } {
    const recents = readWindowState(this.windowDir).recents.map((r) => ({
      root: r.root,
      name: r.name,
    }));
    const rt = conn ? conn.runtime : this.lastActive;
    return {
      currentId: rt?.id ?? null,
      items: rt ? [{ id: rt.id, root: rt.root, name: rt.name }] : [],
      recents,
      openInNewWindow: readConfig().openInNewWindow,
    };
  }

  /** 不带 `?project=` 的窗口会落到哪个工程上。 */
  defaultRoot(): string | undefined {
    return this.lastActive?.root;
  }

  /** 现在开着的所有工程根。 */
  openRoots(): string[] {
    return [...this.runtimes.keys()];
  }

  /**
   * MCP 的执行端。`project` 给了就找那个工程（必须开着），没给用最近操作的那个窗口的工程。
   * 调用在那个工程的上下文里跑：确认框、写入审阅弹在开着它的窗口上。
   */
  mcpBackend(project?: string): McpBackend | undefined {
    const rt = project ? this.findRuntime(project) : this.lastActive;
    if (!rt) {
      return undefined;
    }
    const backend = createMcpBackend(rt.controller);
    return {
      call: (name, args, signal) => runInScope(rt.scope, () => backend.call(name, args, signal)),
      brief: () => runInScope(rt.scope, () => backend.brief()),
    };
  }

  /** 测试与 server 用：某个工程的 controller。不给就是最近操作的那个。 */
  controllerOf(root?: string): ChatController | undefined {
    return (root ? this.findRuntime(root) : this.lastActive)?.controller;
  }

  // ---------------------------------------------------------------- 启动

  /**
   * 启动时打开：CLI 给了目录就打开它；否则看 window.json 的 lastOpen。
   * 路径已经不在盘上则清掉该字段。还没有窗口连上来，它成为「最近操作」的那个。
   */
  async bootstrap(cliRoot?: string): Promise<void> {
    const target = cliRoot ?? readWindowState(this.windowDir).lastOpen;
    if (!target) {
      return;
    }
    if (!cliRoot) {
      try {
        if (!(await fsp.stat(target)).isDirectory()) {
          throw new Error('not a directory');
        }
      } catch {
        const win = readWindowState(this.windowDir);
        writeWindowState({ lastOpen: null, recents: win.recents }, this.windowDir);
        return;
      }
    }
    const resolved = await this.resolveDir(target, (m) => log.warn(m, target));
    if (!resolved) {
      return;
    }
    try {
      const rt = await this.ensureRuntime(resolved);
      this.lastActive = rt;
      rememberOpen(resolved, this.windowDir);
    } catch (err) {
      log.error(`打开工程失败：${describeError(err)}`, err);
    }
  }

  // ---------------------------------------------------------------- 消息

  /**
   * 重连 / 前端 ready：有工程则 workspaces + 全量状态；空窗口不发假 init。
   */
  async pushReady(conn: WindowConn): Promise<void> {
    conn.send({ type: 'workspaces', ...this.snapshot(conn) });
    if (conn.runtime) {
      await runInScope(conn.runtime.scope, () => conn.runtime!.controller.resendFullState());
      return;
    }
    await pushSettingsTo(this.sinkOf(conn));
    await pushSkillsTo(this.sinkOf(conn), {});
    conn.send({ type: 'logs', entries: recentLogs() });
    conn.send({ type: 'tasks', tasks: activeTasks(null) });
  }

  /**
   * 吃掉 Hub 自己的消息。true = 已处理，不要再交给 controller。
   */
  async handle(conn: WindowConn, msg: InMessage): Promise<boolean> {
    const rt = conn.runtime;
    const sink = this.sinkOf(conn);
    switch (msg.type) {
      case 'listHostDir':
        conn.send({ type: 'hostDir', ...(await listHostDir(msg.path)) });
        return true;
      case 'createHostDir':
        conn.send({ type: 'hostDir', ...(await createHostDir(msg.parent, msg.name)) });
        return true;
      case 'openFolder':
        await this.openIn(conn, msg.path, { mode: msg.mode });
        return true;
      case 'closeFolder':
        this.closeIn(conn, msg.id);
        return true;
      case 'activateWorkspace':
        this.activate(conn, msg.id);
        return true;
      case 'windowFocus':
        // touch() 已经记下了。
        return true;
      case 'openLogDir':
        openWithSystem(homeDir());
        return true;
      case 'createFile':
        await this.createFile(conn, msg.relPath, msg.text);
        return true;
      case 'openReadme':
        await this.openReadme(conn);
        return true;
      case 'saveSettings':
        // 设置是全局的：所有窗口都收新设置，开着的工程都刷新一遍（模型清单在工程状态里）。
        await saveSettingsFrom(msg.settings, this.globalSink(conn), () => this.refreshAll());
        this.pushSnapshots();
        return true;
      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await pushSettingsTo(this.globalSink(conn));
        await this.refreshAll();
        return true;
      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await pushSettingsTo(this.globalSink(conn));
        return true;
      case 'testConnection':
        await testConnectionTo(sink, msg.ref, msg.provider, rt ? () => rt.controller.pushState() : undefined);
        return true;
      case 'ready':
        await this.pushReady(conn);
        return true;
      case 'openNativeSettings':
        // 独立版没有原生设置页：空窗口也要吃掉这条，避免落到「请先打开文件夹」。
        return true;
      default:
        break;
    }

    if (rt) {
      return false;
    }

    // 空窗口仍要能切设置/日志、停任务。其余创作类消息由 receive 拦。
    switch (msg.type) {
      case 'switchTab':
        conn.send({ type: 'tab', tab: msg.tab });
        if (msg.tab === 'settings') {
          await pushSettingsTo(sink);
          await pushSkillsTo(sink, {});
        } else if (msg.tab === 'logs') {
          conn.send({ type: 'logs', entries: recentLogs() });
        }
        return true;
      case 'requestLogs':
        conn.send({ type: 'logs', entries: recentLogs() });
        return true;
      case 'requestLogHistory':
        conn.send({ type: 'logHistory', entries: [], exhausted: true });
        return true;
      case 'clearLogs':
        clearLogs();
        conn.send({ type: 'logs', entries: recentLogs() });
        return true;
      case 'cancelTask':
        if (!cancelTask(msg.id)) {
          conn.send({ type: 'tasks', tasks: activeTasks(null) });
        }
        return true;
      // 设置页「技能」：技能库与工程无关，空窗口也能看、能装、能卸；绑定要工程（bindSkillFrom 会说）。
      case 'requestSkills':
        await pushSkillsTo(sink, {});
        return true;
      case 'inspectSkill':
        await inspectSkillFrom(sink, msg.url);
        return true;
      case 'installSkill':
        await installSkillFrom(sink, {}, msg.url);
        return true;
      case 'uninstallSkill':
        await uninstallSkillFrom(sink, {}, msg.id);
        return true;
      case 'bindSkill':
        await bindSkillFrom(sink, {}, msg.stage, msg.id);
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- 打开 / 关闭

  /**
   * 这个窗口打开一个工程（换掉它原来的那个）。别的窗口不受影响；原来那个工程没有窗口了就按
   * 空闲回收。打不开时窗口保持原样。`quiet`：连接时按网址打开，不另外推一遍状态（connect 会推）。
   */
  async openIn(
    conn: WindowConn,
    absPath: string,
    opts: { mode?: 'replace' | 'add'; quiet?: boolean } = {}
  ): Promise<void> {
    const resolved = await this.resolveDir(absPath, (m) => conn.host.toast(m, 'error'));
    if (!resolved) {
      return;
    }

    if (opts.mode === 'add' && conn.runtime && conn.runtime.id !== resolved) {
      conn.host.toast('一个窗口只能开一个工程', 'error');
      return;
    }

    if (conn.runtime?.id === resolved) {
      this.activate(conn, resolved);
      return;
    }

    let rt: Runtime;
    try {
      rt = await this.ensureRuntime(resolved);
    } catch (err) {
      conn.host.toast(describeError(err), 'error');
      log.error(`打开工程失败：${describeError(err)}`, err);
      return;
    }
    this.detach(conn);
    this.attach(conn, rt);
    this.lastActive = rt;
    rememberOpen(resolved, this.windowDir);
    if (!opts.quiet) {
      await this.pushReady(conn);
    }
    // 最近打开的列表变了，别的窗口的欢迎页也要跟着变。
    this.pushSnapshots(conn);
  }

  /** 这个窗口关掉它的工程。没有别的窗口开着它就当场关（停生成、关库）。 */
  closeIn(conn: WindowConn, id?: string): void {
    const rt = conn.runtime;
    if (!rt || (id && id !== rt.id)) {
      return;
    }
    this.detach(conn, { immediate: true });
    this.pushSnapshots();
    log.info('已关闭文件夹');
  }

  /** 测试用：关掉所有工程，所有窗口回到空窗口。 */
  async closeAll(): Promise<void> {
    for (const conn of this.conns) {
      conn.runtime = undefined;
    }
    for (const rt of [...this.runtimes.values()]) {
      this.teardown(rt);
    }
    rememberClosed(this.windowDir);
  }

  activate(conn: WindowConn, id: string): void {
    if (conn.runtime?.id === id) {
      conn.send({ type: 'workspaces', ...this.snapshot(conn) });
      return;
    }
    conn.host.toast('找不到这个工作区', 'error');
  }

  // ---------------------------------------------------------------- 内部

  private attach(conn: WindowConn, rt: Runtime): void {
    conn.runtime = rt;
    rt.clients.add(conn);
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
  }

  /**
   * 窗口离开它的工程。那个工程没有窗口了：`immediate` 当场关；否则等一会儿（刷新、重连会回来），
   * 到时还没人、也没在跑东西才关。最近操作的那个不关——没指定工程的 MCP 调用还要落到它上面。
   */
  private detach(conn: WindowConn, opts: { immediate?: boolean } = {}): void {
    const rt = conn.runtime;
    if (!rt) {
      return;
    }
    conn.runtime = undefined;
    rt.clients.delete(conn);
    if (rt.clients.size > 0) {
      return;
    }
    // 没人答得了的弹窗按取消处理（与从前「全部网页断开」同一条规矩）。
    rt.host.prompts.cancelAll();
    if (opts.immediate) {
      this.teardown(rt);
      if (this.lastActive) {
        rememberOpen(this.lastActive.root, this.windowDir);
      } else {
        rememberClosed(this.windowDir);
      }
      return;
    }
    this.scheduleIdle(rt);
  }

  private scheduleIdle(rt: Runtime): void {
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
    }
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = undefined;
      if (rt.clients.size > 0 || !this.runtimes.has(rt.id) || rt === this.lastActive) {
        return;
      }
      if (rt.controller.busy || activeTasks(rt.id).length > 0) {
        this.scheduleIdle(rt);
        return;
      }
      log.info(`工程已没有窗口，关闭：${rt.root}`);
      this.teardown(rt);
    }, this.idleMs);
    // 不要因为这个计时器拖住进程退出。
    (rt.idleTimer as { unref?: () => void }).unref?.();
  }

  /** 记下这个窗口在操作。它开着的工程成为「最近操作」的那个。 */
  private touch(conn: WindowConn): void {
    const rt = conn.runtime;
    if (!rt || rt === this.lastActive) {
      return;
    }
    this.lastActive = rt;
    rememberOpen(rt.root, this.windowDir);
  }

  private async ensureRuntime(resolved: string): Promise<Runtime> {
    const existing = this.runtimes.get(resolved);
    if (existing) {
      return existing;
    }
    const clients = new Set<WindowConn>();
    const broadcast = (msg: OutMessage): void => {
      for (const c of clients) {
        c.send(msg);
      }
    };
    const host = new FileHost(this.config, broadcast);
    const scope: WindowScope = { host, owner: resolved };
    const viewHost: ViewHost = { kind: 'editor', post: broadcast, reveal: () => undefined };
    return runInScope(scope, () => {
      const project = host.bind(resolved);
      const controller = new ChatController(project);
      controller.attach(viewHost);
      let watch: Disposable | undefined;
      try {
        watch = host.watch(project, () =>
          runInScope(scope, () => {
            project.invalidate();
            void controller.pushState();
          })
        );
      } catch (err) {
        controller.dispose();
        host.unbind();
        throw err;
      }
      const rt: Runtime = {
        id: resolved,
        root: resolved,
        name: path.basename(resolved) || resolved,
        project,
        controller,
        watch,
        host,
        scope,
        clients,
      };
      this.runtimes.set(resolved, rt);
      log.info(`已打开工程：${resolved}`);
      return rt;
    });
  }

  /**
   * 停生成 → 关库 → 停 watcher → 卸 FileHost。
   * 先关库再停 watcher：反过来 Windows 上 sqlite 文件会 EBUSY。
   */
  private teardown(rt: Runtime): void {
    this.runtimes.delete(rt.id);
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
    for (const c of rt.clients) {
      c.runtime = undefined;
    }
    rt.clients.clear();
    if (this.lastActive === rt) {
      this.lastActive = [...this.runtimes.values()].pop();
    }
    try {
      rt.controller.stopGeneration();
      rt.controller.dispose();
    } finally {
      rt.watch.dispose();
      rt.host.prompts.cancelAll();
      rt.host.unbind();
    }
  }

  private findRuntime(root: string): Runtime | undefined {
    const direct = this.runtimes.get(root);
    if (direct) {
      return direct;
    }
    const want = [normalizePath(root)];
    try {
      want.push(normalizePath(fsSync.realpathSync.native(path.resolve(root))));
    } catch {
      // 不在盘上就只按字面比
    }
    for (const rt of this.runtimes.values()) {
      if (want.includes(normalizePath(rt.id))) {
        return rt;
      }
    }
    return undefined;
  }

  private async resolveDir(absPath: string, fail: (message: string) => void): Promise<string | undefined> {
    try {
      const target = path.resolve(absPath);
      const st = await fsp.stat(target);
      if (!st.isDirectory()) {
        fail('不是目录');
        return undefined;
      }
      return await fsp.realpath(target);
    } catch {
      fail('目录不存在');
      return undefined;
    }
  }

  /** 这个窗口自己的回执：设置页、技能页的推送与提示只回它。 */
  private sinkOf(conn: WindowConn): SettingsSink {
    return { post: (msg) => conn.send(msg), toast: (message, level) => conn.host.toast(message, level) };
  }

  /** 设置改了：新设置推给所有窗口，提示只给发起的那个。 */
  private globalSink(conn: WindowConn): SettingsSink {
    return {
      post: (msg) => {
        for (const c of this.conns) {
          c.send(msg);
        }
      },
      toast: (message, level) => conn.host.toast(message, level),
    };
  }

  private async refreshAll(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      await runInScope(rt.scope, () => rt.controller.pushState());
    }
  }

  /** 每个窗口各推一份它眼里的 workspaces。`except` 那个刚推过。 */
  private pushSnapshots(except?: WindowConn): void {
    for (const c of this.conns) {
      if (c !== except) {
        c.send({ type: 'workspaces', ...this.snapshot(c) });
      }
    }
  }

  /** 经 workspace 网关新建文件；已存在拒绝，不覆盖。 */
  private async createFile(conn: WindowConn, relPath: string, text?: string): Promise<void> {
    const rt = conn.runtime;
    if (!rt) {
      conn.host.toast('请先打开文件夹', 'error');
      return;
    }
    const rel = (relPath ?? '').trim();
    if (!rel) {
      rt.host.toast('路径不能为空', 'error');
      return;
    }
    try {
      await new Workspace(rt.project).write(rel, { text: text ?? '' }, { mode: 'create', review: false });
      await rt.host.openInEditor(rel);
    } catch (err) {
      rt.host.toast(describeError(err), 'error');
    }
  }

  /**
   * 有工程且根下有 README → 内置编辑器打开。
   * 否则找产品仓库根的 README 交给系统打开。都没有则 toast。
   */
  private async openReadme(conn: WindowConn): Promise<void> {
    const rt = conn.runtime;
    if (rt) {
      for (const name of README_NAMES) {
        const abs = path.join(rt.root, name);
        try {
          const st = await fsp.stat(abs);
          if (st.isFile()) {
            await rt.host.openInEditor(name);
            return;
          }
        } catch {
          // 下一候选
        }
      }
    }
    const product = findProductReadme();
    if (product) {
      openWithSystem(product);
      return;
    }
    conn.host.toast('找不到使用说明', 'error');
  }
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const README_NAMES = ['README.md', 'README.markdown'];

function findProductReadme(): string | undefined {
  const starts = [__dirname, process.cwd(), path.dirname(process.execPath)];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      try {
        if (fsSync.existsSync(path.join(dir, 'package.json'))) {
          for (const name of README_NAMES) {
            const readme = path.join(dir, name);
            if (fsSync.existsSync(readme)) {
              return readme;
            }
          }
        }
      } catch {
        // 下一层
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}
