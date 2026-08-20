import { listAttachmentChoices } from '../files/attachments';
import { readConfig } from '../config';
import { closeDatabase, installLogPersistence, readLogHistory } from '../runtime/db';
import { DraftStore } from '../generation/drafts';
import { CancelledError } from '../llm/provider';
import { getHost } from '../host';
import { addLogSink, clearLogs, describeError, recentLogs, scoped } from '../runtime/logger';
import { activeTasks, cancelTask, onTasksChanged } from '../runtime/progress';
import { clearApiKey, promptForApiKey } from '../llm/registry';
import { NovelProject } from '../model/project';
import { Workspace } from '../workspace';
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
  chapterLabel,
  plotOfTarget,
  normalizeTarget,
  segmentLabel,
} from '../model/pipeline';
import {
  InMessage,
  OutMessage,
  Tab,
  ViewState,
} from '../protocol';
import { buildPlotSummaryView, buildProjectTree } from '../views/projectView';
import { buildPipelineIndex } from '../views/pipeline';
import {
  pushPipeline,
  retry,
  selectPlot,
  send,
  setTarget,
} from './chat';
import { sendAgent } from './agent';
import type { PendingGate } from './gate';
import { cancelGates, resendGates, resolveGate } from './gate';
import { fileAction, openDraft, pushDirListings } from './files';
import { characterAction, projectAction } from './project';
import {
  deleteSession,
  newSession,
  openSession,
  renameSession,
  setThinking,
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
  /**
   * 工程的唯一读写网关。agent 的只读工具吃它。
   *
   * 一个 controller 一份而不是每次现造：`Workspace` 本身无状态（它只是
   * `NovelProject` 的门面），但造一份要传 project，散在各处等于把这层依赖
   * 又复制了几遍。
   * @internal controller/ 同包用；壳不要读。
   */
  readonly workspace: Workspace;
  /** @internal controller/ 同包用；壳不要读。 */
  readonly store: SessionStore;
  /**
   * 尚未采纳的产物。**并发控制与它无关**——那是 `currentAbort` 的活。
   * @internal controller/ 同包用；壳不要读。
   */
  readonly drafts = new DraftStore();
  /** @internal controller/ 同包用；壳不要读。 */
  current: ChatSession;
  /** @internal controller/ 同包用；壳不要读。 */
  tab: Tab = 'chat';
  /**
   * 正在跑的那次生成。
   *
   * **并发控制是调度的责任**，不是生成的责任——从前它是 `CreationSession`
   * 的私有字段，于是同一个类既管「有没有在生成」又管装配与解析。搬到这里
   * 之后 `generation/` 整层无状态，agent 循环（三期）自己管自己那一份。
   *
   * 与从前的 `busy` 合成一个：两个独立状态（一个给前端画忙碌标记、一个控
   * 真正的取消）迟早会对不上，而对不上的表现是「停止按钮点了没反应」。
   */
  private currentAbort?: AbortController;
  /** 尚未落盘的附件（用户已经 @ 了，但还没发送）。@internal 同包用。 */
  pending: Attachment[] = [];
  /** @internal controller/ 同包用；壳不要读。 */
  readonly hosts = new Set<ViewHost>();
  /**
   * 等着作者点头的权限询问（agent 那条路的闸门，见 [gate.ts](gate.ts)）。
   *
   * 记在后端而不是前端，是因为**前端无状态**：网页刷新、webview 重建之后，
   * 这几张卡片要靠 `resendFullState` 原样再推一遍——不然循环就停在一个谁也
   * 看不见的等待上，界面只剩一个转不完的忙碌标记。
   * @internal controller/ 同包用；壳不要读。
   */
  readonly gates = new Map<string, PendingGate>();
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
    this.workspace = new Workspace(project);
    this.store = new SessionStore(project);
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

  // ---------------------------------------------------------------- 并发控制

  /**
   * 正在生成。前端的忙碌标记与「已有一个生成任务在进行中」都看这一个。
   * @internal controller/ 同包用；壳不要读。
   */
  get busy(): boolean {
    return this.currentAbort !== undefined;
  }

  /**
   * 占住生成位。已经有一个在跑就返回 undefined——调用方据此拒掉本次请求。
   *
   * 返回的 `release` 必须在 finally 里调：漏了的话这个 controller 从此
   * 再也发不出第二条消息，而界面上只是一句莫名其妙的「已有一个生成任务
   * 在进行中」。
   * @internal controller/ 同包用；壳不要读。
   */
  beginGeneration(): { signal: AbortSignal; abort: () => void; release: () => void } | undefined {
    if (this.currentAbort) {
      return undefined;
    }
    const abort = new AbortController();
    this.currentAbort = abort;
    return {
      signal: abort.signal,
      // 让占位方自己也能中断（agent 那条路要把 runTask 进度条上的「停止」
      // 转接进来）。只 abort 自己那一份，不碰别人的。
      abort: () => abort.abort(new CancelledError()),
      release: () => {
        // 只清自己那一份：release 晚到时（上一次生成的收尾）不该把
        // 刚开始的下一次取消掉。
        if (this.currentAbort === abort) {
          this.currentAbort = undefined;
        }
      },
    };
  }

  /** 用户点了停止。没有在跑的就什么也不做。 */
  stopGeneration(): void {
    if (this.currentAbort) {
      log.info('用户点了停止');
    }
    this.currentAbort?.abort(new CancelledError());
  }

  dispose(): void {
    this.disposed = true;
    this.currentAbort?.abort(new CancelledError());
    // 还在等回答的权限卡片：面板都没了，没人答得了它。
    cancelGates(this);
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
      // 兜底解锁：`runTurn` 自己有 finally，走到这里说明是它之外的地方炸了。
      // 不解的话这个面板从此发不出第二条消息，界面上只剩一句莫名其妙的
      // 「已有一个生成任务在进行中」。
      this.currentAbort = undefined;
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
    // 还没答的权限卡片也要跟着回来：它挂在会话的气泡上（上面那条 session 已经
    // 把气泡带回来了），循环这会儿正卡在那里等回答。
    resendGates(this);
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

      case 'sendAgent':
        await sendAgent(this, msg.text, msg.limits);
        return;

      case 'retry':
        await retry(this, msg.turnId, msg.payload);
        return;

      case 'stop':
        this.stopGeneration();
        return;

      case 'setTarget':
        await setTarget(this, normalizeTarget(msg.target));
        return;

      case 'selectPlot':
        await selectPlot(this, msg.plotRelPath);
        return;

      case 'requestPipeline':
        // 指名要某一章的，就先切过去（那正是「点开另一章」的意思）；
        // 不指名的是纯刷新，照当前目标推一份。
        if (msg.plotRelPath && msg.plotRelPath !== plotOfTarget(this.current.target)) {
          await selectPlot(this, msg.plotRelPath);
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

      case 'newSession':
        await newSession(this);
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
        await pushDirListings(this, msg.dirs, msg.ephemeral);
        return;

      case 'requestSummary':
        // 只回给发问的那个前端就够了，但 post 是广播——多开一个面板时
        // 另一边收到一份用不上的摘要，代价只是一次无害的缓存写入。
        this.post({ type: 'summary', summary: await buildPlotSummaryView(this.project, msg.plotRelPath) });
        return;

      case 'projectAction':
        await projectAction(this, msg.action, msg.relPath, msg.dir);
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

      case 'setThinking':
        await setThinking(this, msg.depth);
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

      case 'gateResult':
        // 作者在气泡里那张权限卡片上点了一颗按钮。认不出的 requestId 静默丢弃。
        resolveGate(this, msg.requestId, msg.verdict);
        return;

      // 工作区生命周期与本机目录：独立版由 WorkspaceHub 在进 controller
      // 之前拦下。插件不会发这些消息。空分支避免 InMessage 联合漏网。
      case 'listHostDir':
      case 'createHostDir':
      case 'openFolder':
      case 'closeFolder':
      case 'activateWorkspace':
      case 'openLogDir':
      case 'createFile':
      case 'openReadme':
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
        plots: [],
        nextNo: 1,
        staleCount: 0,
        model: config.model,
        modelLabel: '',
        models,
        contextWindow: 0,
        maxOutputTokens: 0,
      };
    }
    // 目标下拉框列的是**已发布的章 + 还没交付的剧情段**，顺序即时间线：
    // 前面是写完的，后面是待写的。只列后者的话，老工程打开后下拉框是空的。
    //
    // 两种行的说法完全不同（「第 12 章」/「剧情 4」），所以 `label` 由后端给，
    // 位次也由后端算——前端按 `no` 自己拼会拼错一半。
    const { segments, chapters } = await buildPipelineIndex(this.project);
    const rows: ViewState['plots'] = [
      ...chapters.map((chapter) => ({
        kind: 'chapter' as const,
        no: chapter.order,
        label: chapterLabel(chapter.order, chapter.title),
        title: chapter.title,
        wordCount: chapter.wordCount,
        // 已发布的章选中时落在**它的来源段**上（拆分时记下的落点）；找不到
        // 来源（老工程里每一章都是）就指向细纲**应该**在的位置——选中它就是
        // 「去给这一章补规划」，而 `readPlot` 读不到会如实退化成空壳。
        relPath:
          segments.find((p) => p.chapter.chapterPaths.includes(chapter.relPath))?.plot.relPath ||
          this.project.plotPathForNo(chapter.order, chapter.title),
      })),
      ...segments.map((p) => ({
        kind: 'segment' as const,
        no: p.displayNo,
        label: segmentLabel(p.displayNo, p.title),
        title: p.title,
        wordCount: p.manuscript.words,
        relPath: p.plot.relPath,
      })),
    ];
    return {
      initialized: true,
      plots: rows,
      nextNo: await this.project.nextPlotNo(),
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

  /**
   * 供命令直接调用：新建一章并进入它当前该做的那一步。
   *
   * 复用工程页那条 `projectAction` 分支而不是直接调 `newPlotFlow`：
   * 「建完落到剧情层」是这个动作的一部分，命令面板与页面按钮不该分叉。
   */
  async newPlotFromCommand(): Promise<void> {
    await projectAction(this, 'newPlot');
    for (const host of this.hosts) {
      host.reveal();
    }
  }
}
