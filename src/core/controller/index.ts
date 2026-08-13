import { listAttachmentChoices } from '../files/attachments';
import { readConfig } from '../config';
import { closeDatabase, installLogPersistence, readLogHistory } from '../runtime/db';
import { CreationSession } from '../features/creation';
import { syncSummaries } from '../features/summarize';
import { getHost } from '../host';
import { addLogSink, clearLogs, describeError, recentLogs, scoped } from '../runtime/logger';
import { activeTasks, cancelTask, onTasksChanged } from '../runtime/progress';
import { clearApiKey, promptForApiKey } from '../llm/registry';
import { NovelProject } from '../model/project';
import {
  describeModelIssue,
  listModelChoices,
} from '../model/providers';
import {
  Attachment,
  ChatSession,
  SessionStore,
} from '../model/session';
import {
  chapterOfTarget,
  normalizeTarget,
} from '../model/pipeline';
import {
  InMessage,
  OutMessage,
  Tab,
  ViewState,
} from '../protocol';
import { buildChapterSummaryView, buildProjectTree } from '../views/projectView';
import {
  accept,
  acceptArtifact,
  focusWithTarget as focusWithTargetFn,
  pushPipeline,
  retry,
  selectChapter,
  send,
  setTarget,
} from './chat';
import { fileAction, openDraft, pushDirListings } from './files';
import { characterAction, projectAction } from './project';
import {
  deleteSession,
  newSession,
  openSession,
  renameSession,
} from './session';
import { persist } from './persist';
import {
  describeProvider,
  serializeAttachment,
  serializeSession,
} from './serialize';
import { pushSettings, saveSettings, selectModel, testConnection } from './settings';

export { describeProvider } from './serialize';

/** Webview 宿主需要提供的能力。侧边栏与编辑器面板各实现一份。 */
export interface ViewHost {
  readonly kind: 'sidebar' | 'editor';
  post(message: OutMessage): void;
  reveal(): void;
}

const log = scoped('面板');

/** 「加载更早」一次翻多少条日志。与前端的行数上限同量级。 */
const LOG_HISTORY_PAGE = 200;

/**
 * 对话面板的全部逻辑。
 *
 * 有意与宿主解耦：同一个 controller 既可以挂在侧边栏的 WebviewView 上，
 * 也可以挂在编辑器里的 WebviewPanel 上，两边看到的是同一个会话。
 *
 * 同包字段（无 private）只给 `controller/` 下的模块用，壳不要读。
 */
export class ChatController {
  /** @internal controller/ 同包用；壳不要读。 */
  readonly project: NovelProject;
  /** @internal controller/ 同包用；壳不要读。 */
  readonly store: SessionStore;
  /** @internal controller/ 同包用；壳不要读。 */
  readonly session: CreationSession;
  /** @internal controller/ 同包用；壳不要读。 */
  current: ChatSession;
  /** @internal controller/ 同包用；壳不要读。 */
  tab: Tab = 'chat';
  /** @internal controller/ 同包用；壳不要读。 */
  busy = false;
  /** 尚未落盘的附件（用户已经 @ 了，但还没发送）。@internal 同包用。 */
  pending: Attachment[] = [];
  /** @internal controller/ 同包用；壳不要读。 */
  readonly hosts = new Set<ViewHost>();
  /** 日志与任务的订阅，dispose 时要解掉——否则重开面板会留下往死通道推的 sink。 */
  private readonly subscriptions: { dispose(): void }[] = [];
  /**
   * 资源管理器里当前展开着的目录（工程内相对路径，空串是工程根）。
   *
   * 记在后端是为了让**工程变动时能主动重推**：作者在编辑器里新建一章、
   * 或在外面动了盘上的文件，watcher 触发 pushState，这份集合让资源管理器
   * 跟着刷新，不必等用户手动点一下折叠再展开。
   * 前端每次发 `listDir` 都带全量，这里整体替换。
   * @internal controller/ 同包用；壳不要读。
   */
  watchedDirs: string[] = [];
  /** dispose 过了。异步挂载的订阅据此就地退订，不往死通道上挂。 */
  private disposed = false;

  constructor(project: NovelProject) {
    this.project = project;
    this.store = new SessionStore(project);
    this.session = new CreationSession(project);
    this.current = this.store.create();

    // 日志实时推给前端：日志页在跑长任务时要跟着滚，不能只在切页时拉一次。
    this.subscriptions.push(addLogSink((entry) => this.post({ type: 'log', entry })));
    // 任务表变化 → 推快照。工程页的进度条与工具栏的忙碌标记都吃这一条。
    this.subscriptions.push(onTasksChanged(() => this.post({ type: 'tasks', tasks: activeTasks() })));
    // 日志再落一份进工程库，重启之后仍查得到「昨晚那 76 章卡在哪」。
    // 开库是异步的，而 controller 可能在开完之前就被 dispose 掉（用户刚打开
    // 侧边栏又立刻关掉窗口）——那时必须就地退订，否则这个 sink 会永远挂着
    // 往一个已经关掉的库里写。
    void installLogPersistence(project).then((sub) => {
      if (this.disposed) {
        sub.dispose();
      } else {
        this.subscriptions.push(sub);
      }
    });
  }

  attach(host: ViewHost): void {
    this.hosts.add(host);
  }

  detach(host: ViewHost): void {
    this.hosts.delete(host);
  }

  dispose(): void {
    this.disposed = true;
    this.session.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
    // 关库要在退订之后：日志 sink 的 dispose 会把攒着的最后一批 flush 掉，
    // 反过来的话那几条就丢了——而崩溃前的最后几条恰恰最想看。
    closeDatabase(this.project);
  }

  /** 广播给所有已挂载的宿主，两个视图始终一致。@internal 同包用。 */
  post(message: OutMessage): void {
    for (const host of this.hosts) {
      host.post(message);
    }
  }

  /** @internal controller/ 同包用；壳不要读。 */
  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'toast', message, level });
  }

  // ---------------------------------------------------------------- 消息入口

  async handle(msg: InMessage): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (err) {
      this.busy = false;
      this.post({ type: 'busy', value: false });
      // 未被下层接住的异常一律进日志：toast 五秒就没了，日志页留得住。
      log.error(`处理消息 ${msg.type} 时出错：${describeError(err)}`, err);
      this.toast(describeError(err), 'error');
    }
  }

  /**
   * 重放当前页签的全部数据。新前端连接挂上来时调用——
   * webview 被销毁重建或网页刷新/重连后，靠这一套消息即可恢复。
   */
  async resendFullState(): Promise<void> {
    this.post({ type: 'init', state: await this.buildState() });
    this.post({ type: 'tab', tab: this.tab });
    this.post({ type: 'session', session: serializeSession(this.current) });
    this.post({ type: 'attachments', items: this.pending.map(serializeAttachment) });
    this.post({ type: 'busy', value: this.busy });
    // 刷新页面时长任务多半还在跑，进度条必须立刻接上，别让人以为任务没了。
    this.post({ type: 'tasks', tasks: activeTasks() });
    await this.pushTabData();
  }

  async dispatch(msg: InMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.resendFullState();
        return;

      case 'switchTab':
        this.tab = msg.tab;
        await this.pushTabData();
        return;

      case 'send':
        await send(this, msg.payload);
        return;

      case 'retry':
        await retry(this, msg.turnId, msg.payload);
        return;

      case 'stop':
        this.session.stop();
        return;

      case 'accept':
        await accept(this, msg.turnId, msg.mode, msg.order, msg.title, msg.text);
        return;

      case 'acceptArtifact':
        await acceptArtifact(this, msg.turnId, normalizeTarget(msg.target), msg.text);
        return;

      case 'setTarget':
        await setTarget(this, normalizeTarget(msg.target));
        return;

      case 'selectChapter':
        await selectChapter(this, msg.chapterRelPath);
        return;

      case 'requestPipeline':
        // 指名要某一章的，就先切过去（那正是「点开另一章」的意思）；
        // 不指名的是纯刷新，照当前目标推一份。
        if (msg.chapterRelPath && msg.chapterRelPath !== chapterOfTarget(this.current.target)) {
          await selectChapter(this, msg.chapterRelPath);
        } else {
          await pushPipeline(this);
        }
        return;

      case 'editTurn': {
        const turn = this.current.turns.find((t) => t.id === msg.turnId);
        if (turn) {
          turn.content = msg.text;
          await persist(this);
        }
        return;
      }

      case 'deleteTurn': {
        const idx = this.current.turns.findIndex((t) => t.id === msg.turnId);
        if (idx === -1) {
          return;
        }
        // 删用户消息时连同它的回复一起删——留着一条无源的回复没有意义。
        const drop = this.current.turns[idx].role === 'user' &&
          this.current.turns[idx + 1]?.role === 'assistant' ? 2 : 1;
        this.current.turns.splice(idx, drop);
        await persist(this);
        this.post({ type: 'session', session: serializeSession(this.current) });
        return;
      }

      case 'openSession':
        await openSession(this, msg.id);
        return;

      case 'deleteSession':
        await deleteSession(this, msg.id);
        return;

      case 'renameSession':
        await renameSession(this, msg.id);
        return;

      case 'pickAttachment': {
        const choices = await listAttachmentChoices(this.project);
        const picked = await getHost().pick(choices, '引用到上下文');
        if (picked) {
          this.addAttachment(picked);
        }
        return;
      }

      case 'addSelection': {
        const att = await getHost().selectionAttachment(this.project);
        if (!att) {
          this.toast('没有可加入的文本。', 'error');
          return;
        }
        this.addAttachment(att);
        return;
      }

      case 'openFile':
        await getHost().openFile(msg.path);
        return;

      case 'openEditor':
      case 'reloadFile': {
        // 有内置编辑器的宿主（独立版）走内置编辑器；插件壳没有，
        // 回落到 openFile —— 那边打开的本来就是 VS Code 真正的编辑器。
        const host = getHost();
        if (host.openInEditor) {
          // reloadFile 不带 pane：重载哪一块由前端按 path 自己认。
          await host.openInEditor(msg.path, msg.type === 'openEditor' ? msg.pane : undefined);
        } else {
          await host.openFile(msg.path);
        }
        return;
      }

      case 'openDraft':
        await openDraft(this, msg.path);
        return;

      case 'saveFile': {
        const host = getHost();
        if (!host.saveFromEditor) {
          this.toast('当前环境没有内置编辑器。', 'error');
          return;
        }
        await host.saveFromEditor(msg.path, msg.text, msg.baseHash);
        // 保存的可能是章节正文，字数/摘要新鲜度都会变。
        await this.pushState();
        return;
      }

      case 'openExternal':
        await (getHost().openExternal ?? getHost().openFile)(msg.path);
        return;

      case 'listDir':
        await pushDirListings(this, msg.dirs);
        return;

      case 'syncSummaries':
        await syncSummaries(this.project);
        await this.pushState();
        return;

      case 'requestSummary':
        // 只回给发问的那个前端就够了，但 post 是广播——多开一个面板时
        // 另一边收到一份用不上的摘要，代价只是一次无害的缓存写入。
        this.post({ type: 'summary', summary: await buildChapterSummaryView(this.project, msg.order) });
        return;

      case 'projectAction':
        await projectAction(this, msg.action, msg.order, msg.dir);
        return;

      case 'fileAction':
        await fileAction(this, msg);
        return;

      case 'characterAction':
        await characterAction(this, msg.action, msg.name, msg.relPath);
        return;

      case 'selectModel':
        await selectModel(this, msg.ref);
        return;

      case 'saveSettings':
        await saveSettings(this, msg.settings);
        return;

      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await pushSettings(this);
        await this.pushState();
        return;

      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await pushSettings(this);
        return;

      case 'testConnection':
        await testConnection(this, msg.ref, msg.provider);
        return;

      case 'openNativeSettings':
        await getHost().openNativeSettings?.();
        return;

      case 'cancelTask':
        if (!cancelTask(msg.id)) {
          // 任务刚好在这一刻结束：推一份新快照让前端把进度条收掉。
          this.post({ type: 'tasks', tasks: activeTasks() });
        }
        return;

      case 'requestLogs':
        this.post({ type: 'logs', entries: recentLogs() });
        return;

      case 'requestLogHistory': {
        // 只有这一条会查库。默认进日志页仍然只看内存缓冲，一次查询都不做。
        const entries = await readLogHistory(this.project, LOG_HISTORY_PAGE, msg.before);
        // 取回来的比页大小少，说明再往前没有了——前端据此收掉按钮。
        this.post({ type: 'logHistory', entries, exhausted: entries.length < LOG_HISTORY_PAGE });
        return;
      }

      case 'clearLogs':
        clearLogs();
        this.post({ type: 'logs', entries: recentLogs() });
        return;

      case 'promptResult':
        // 由独立版壳在进入 controller 前截获（解弹窗）；插件永远不会收到。
        return;
    }
  }

  // ---------------------------------------------------------------- 状态

  /** @internal controller/ 同包用；壳不要读。 */
  async buildState(): Promise<ViewState> {
    const initialized = await this.project.isInitialized();
    const config = readConfig();
    const host = getHost();
    const models = listModelChoices(config.providers, host.supportsVscodeLm).map((c) => ({
      ref: c.ref,
      label: c.label,
      group: c.group,
    }));
    // 当前模型若是 vscode-lm 而宿主不支持（独立版），下拉里已过滤，需明确提示切换。
    const lmOnlyIssue =
      config.active?.profile.kind === 'vscode-lm' && !host.supportsVscodeLm
        ? '当前模型仅在 VS Code 内可用（Copilot），请在设置页切换到自建 API 的模型。'
        : undefined;

    if (!initialized) {
      return {
        initialized: false,
        chapters: [],
        nextOrder: 1,
        staleCount: 0,
        model: config.model,
        modelLabel: '',
        models,
        contextWindow: 0,
        maxOutputTokens: 0,
      };
    }
    const chapters = await this.project.listChapters();
    return {
      initialized: true,
      chapters: chapters.map((ch) => ({
        order: ch.order,
        title: ch.title,
        wordCount: ch.wordCount,
        relPath: ch.relPath,
      })),
      nextOrder: await this.project.nextChapterOrder(),
      staleCount: (await this.project.staleChapters()).length,
      model: config.model,
      modelLabel: describeProvider(config),
      // 只在解析失败时给出说明——正常情况下不要在输入框下方堆红字。
      modelIssue:
        lmOnlyIssue ?? (config.active ? undefined : describeModelIssue(config.providers, config.model)),
      models,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
    };
  }

  /** 工程内容变化时刷新（由 FileSystemWatcher 触发）。 */
  async pushState(): Promise<void> {
    this.project.invalidate();
    for (const host of this.hosts) {
      host.post({ type: 'state', state: await this.buildState() });
    }
    await this.pushTabData();
  }

  /**
   * 补齐当前页签需要的数据。
   * 只推可见页签的——工程页要遍历全部章节算摘要新鲜度，
   * 每保存一次正文都跑一遍没必要。
   * @internal controller/ 同包用；壳不要读。
   */
  async pushTabData(): Promise<void> {
    if (this.tab === 'project') {
      await this.pushProject();
    } else if (this.tab === 'files') {
      // 资源管理器只重推前端说过它关心的那些目录；一个都没登记（刚切过来、
      // 前端还没发 listDir）时什么也不做，等那条消息到了自然会推。
      await pushDirListings(this, this.watchedDirs);
    } else if (this.tab === 'history') {
      await this.pushSessions();
    } else if (this.tab === 'settings') {
      await pushSettings(this);
    } else if (this.tab === 'logs') {
      // 切到日志页时补一份全量；此后靠 sink 增量追加。
      this.post({ type: 'logs', entries: recentLogs() });
    }
  }

  /** @internal controller/ 同包用；壳不要读。 */
  async pushProject(): Promise<void> {
    this.post({ type: 'project', tree: await buildProjectTree(this.project) });
  }

  /** @internal controller/ 同包用；壳不要读。 */
  async pushSessions(): Promise<void> {
    const list = await this.store.list();
    this.post({
      type: 'sessions',
      list: list.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        turnCount: s.turnCount,
        preview: s.preview,
        active: s.id === this.current.id,
      })),
    });
  }

  // ---------------------------------------------------------------- 附件

  /** @internal controller/ 同包用；壳不要读。 */
  addAttachment(att: Attachment): void {
    if (this.pending.some((a) => a.id === att.id)) {
      this.toast('已经引用过这一项了。');
      return;
    }
    this.pending.push(att);
    this.post({ type: 'attachments', items: this.pending.map(serializeAttachment) });
  }

  /** 供命令直接调用：把当前选区加入待发送上下文。 */
  async addSelectionFromCommand(): Promise<boolean> {
    const att = await getHost().selectionAttachment(this.project);
    if (!att) {
      return false;
    }
    this.addAttachment(att);
    for (const host of this.hosts) {
      host.reveal();
    }
    return true;
  }

  /**
   * 供命令直接调用：预设创作目标并聚焦。
   *
   * 命令面板给的是序号（它只有这个）；查不到那一章时退回大纲——
   * 拿一个空 relPath 去装配，等于把「前文」的边界搞错。
   */
  async focusWithTarget(order: number): Promise<void> {
    await focusWithTargetFn(this, order);
  }

  /** 供命令直接调用：切到某个页签。 */
  async showTab(tab: Tab): Promise<void> {
    this.tab = tab;
    this.post({ type: 'tab', tab });
    await this.pushTabData();
    for (const host of this.hosts) {
      host.reveal();
    }
  }

  /** 供命令直接调用：新建会话。 */
  async newSessionFromCommand(): Promise<void> {
    await newSession(this);
    for (const host of this.hosts) {
      host.reveal();
    }
  }
}
