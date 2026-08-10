import { dirBaseName, initProjectFlow, newChapterFlow } from './actions';
import { listAttachmentChoices } from './attachments';
import { normalizeModelList, promoteModel, updateSettings, readConfig, readGlobalBudget } from './config';
import { BuiltContext, ContextItem } from './context/builder';
import { deleteEntry, moveEntry, newFolder, renameEntry, Section, sectionOf, sectionRoots } from './fileOps';
import { listDirs } from './fileTree';
import { copyInto, moveInto, renameAny } from './projectFiles';
import { extractCharacters, newCharacter, newLore } from './features/characters';
import {
  createCardForCast,
  createCardsForAllCast,
  updateAllCharacterCards,
  updateCharacterCard,
} from './features/characterCard';
import { cleanCharacterAliases, mergeDuplicateCharacterCards } from './features/characterMaintenance';
import { ContinueSession } from './features/continueWriting';
import { extractStyle } from './features/style';
import { rebuildGlobalSummary, summarizeChapter, syncSummaries } from './features/summarize';
import { getHost } from './host';
import { addLogSink, clearLogs, describeError, recentLogs, scoped } from './logger';
import { activeTasks, cancelTask, onTasksChanged, runTask } from './progress';
import { apiKeyStatus, clearApiKey, promptForApiKey, pruneApiKeys } from './llm/registry';
import { NovelProject } from './model/project';
import {
  describeModelIssue,
  listModelChoices,
  modelLabel,
  normalizeProviders,
  providerLabel,
  resolveModelRef,
} from './model/providers';
import {
  Attachment,
  ChatSession,
  ChatTurn,
  SessionStore,
  deriveTitle,
  makeTurnId,
  nowIso,
} from './model/session';
import { NovelConfig } from './model/types';
import {
  CharacterAction,
  FileOpResult,
  InMessage,
  OutMessage,
  ProjectAction,
  SendPayload,
  SerializedAttachment,
  SerializedDigest,
  SerializedProvider,
  SerializedSession,
  SerializedTurn,
  SettingsPayload,
  Tab,
  ViewState,
} from './protocol';
import { buildChapterSummaryView, buildProjectTree } from './projectView';

/** Webview 宿主需要提供的能力。侧边栏与编辑器面板各实现一份。 */
export interface ViewHost {
  readonly kind: 'sidebar' | 'editor';
  post(message: OutMessage): void;
  reveal(): void;
}

const log = scoped('面板');

/**
 * 对话面板的全部逻辑。
 *
 * 有意与宿主解耦：同一个 controller 既可以挂在侧边栏的 WebviewView 上，
 * 也可以挂在编辑器里的 WebviewPanel 上，两边看到的是同一个会话。
 */
export class ChatController {
  private readonly store: SessionStore;
  private readonly session: ContinueSession;
  private current: ChatSession;
  private tab: Tab = 'chat';
  private busy = false;
  /** 尚未落盘的附件（用户已经 @ 了，但还没发送）。 */
  private pending: Attachment[] = [];
  private readonly hosts = new Set<ViewHost>();
  /** 日志与任务的订阅，dispose 时要解掉——否则重开面板会留下往死通道推的 sink。 */
  private readonly subscriptions: { dispose(): void }[] = [];
  /**
   * 资源管理器里当前展开着的目录（工程内相对路径，空串是工程根）。
   *
   * 记在后端是为了让**工程变动时能主动重推**：作者在编辑器里新建一章、
   * 或在外面动了盘上的文件，watcher 触发 pushState，这份集合让资源管理器
   * 跟着刷新，不必等用户手动点一下折叠再展开。
   * 前端每次发 `listDir` 都带全量，这里整体替换。
   */
  private watchedDirs: string[] = [];

  constructor(private readonly project: NovelProject) {
    this.store = new SessionStore(project);
    this.session = new ContinueSession(project);
    this.current = this.store.create();

    // 日志实时推给前端：日志页在跑长任务时要跟着滚，不能只在切页时拉一次。
    this.subscriptions.push(addLogSink((entry) => this.post({ type: 'log', entry })));
    // 任务表变化 → 推快照。工程页的进度条与工具栏的忙碌标记都吃这一条。
    this.subscriptions.push(onTasksChanged(() => this.post({ type: 'tasks', tasks: activeTasks() })));
  }

  attach(host: ViewHost): void {
    this.hosts.add(host);
  }

  detach(host: ViewHost): void {
    this.hosts.delete(host);
  }

  dispose(): void {
    this.session.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** 广播给所有已挂载的宿主，两个视图始终一致。 */
  private post(message: OutMessage): void {
    for (const host of this.hosts) {
      host.post(message);
    }
  }

  private toast(message: string, level: 'info' | 'error' = 'info'): void {
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
        await this.send(msg.payload);
        return;

      case 'retry':
        await this.retry(msg.turnId, msg.payload);
        return;

      case 'stop':
        this.session.stop();
        return;

      case 'accept':
        await this.accept(msg.turnId, msg.mode, msg.order, msg.title, msg.text);
        return;

      case 'editTurn': {
        const turn = this.current.turns.find((t) => t.id === msg.turnId);
        if (turn) {
          turn.content = msg.text;
          await this.persist();
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
        await this.persist();
        this.post({ type: 'session', session: serializeSession(this.current) });
        return;
      }

      case 'openSession':
        await this.openSession(msg.id);
        return;

      case 'deleteSession':
        await this.deleteSession(msg.id);
        return;

      case 'renameSession':
        await this.renameSession(msg.id);
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
        await this.openDraft(msg.path);
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
        await this.pushDirListings(msg.dirs);
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
        await this.projectAction(msg.action, msg.order, msg.dir);
        return;

      case 'fileAction':
        await this.fileAction(msg);
        return;

      case 'characterAction':
        await this.characterAction(msg.action, msg.name, msg.relPath);
        return;

      case 'selectModel':
        await this.selectModel(msg.ref);
        return;

      case 'saveSettings':
        await this.saveSettings(msg.settings);
        return;

      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await this.pushSettings();
        await this.pushState();
        return;

      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await this.pushSettings();
        return;

      case 'testConnection':
        await this.testConnection(msg.ref, msg.provider);
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

  private async buildState(): Promise<ViewState> {
    const initialized = await this.project.isInitialized();
    const config = readConfig();
    const host = getHost();
    const standalone = host.name === 'standalone';
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
        standalone,
      };
    }
    const chapters = await this.project.listChapters();
    return {
      initialized: true,
      chapters: chapters.map((c) => ({ order: c.order, title: c.title, wordCount: c.wordCount })),
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
      standalone,
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
   */
  private async pushTabData(): Promise<void> {
    if (this.tab === 'project') {
      await this.pushProject();
    } else if (this.tab === 'files') {
      // 资源管理器只重推前端说过它关心的那些目录；一个都没登记（刚切过来、
      // 前端还没发 listDir）时什么也不做，等那条消息到了自然会推。
      await this.pushDirListings(this.watchedDirs);
    } else if (this.tab === 'history') {
      await this.pushSessions();
    } else if (this.tab === 'settings') {
      await this.pushSettings();
    } else if (this.tab === 'logs') {
      // 切到日志页时补一份全量；此后靠 sink 增量追加。
      this.post({ type: 'logs', entries: recentLogs() });
    }
  }

  /**
   * 列举资源管理器要的目录并广播。
   *
   * 顺带把 `dirs` 记成新的关注集合——工程有变动时 `pushTabData` 会照着
   * 再推一遍。空数组是合法输入（前端把树全折叠了），此时只更新集合。
   */
  private async pushDirListings(dirs: string[]): Promise<void> {
    this.watchedDirs = dirs;
    if (dirs.length === 0) {
      return;
    }
    this.post({ type: 'dirListings', listings: await listDirs(this.project.root, dirs) });
  }

  private async pushProject(): Promise<void> {
    this.post({ type: 'project', tree: await buildProjectTree(this.project) });
  }

  private async pushSessions(): Promise<void> {
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

  private async pushSettings(ack?: 'saved' | 'rejected'): Promise<void> {
    const c = readConfig();
    // 预算字段回显全局默认值，而不是被当前模型覆盖后的值——
    // 否则用户在设置页看到的数字会随选中模型漂移，一保存就把默认值改掉了。
    const budget = readGlobalBudget();
    this.post({
      type: 'settings',
      ack,
      settings: {
        providers: c.providers.map((p) => ({
          id: p.id,
          label: p.label,
          kind: p.kind,
          baseUrl: p.baseUrl,
          models: p.models.map((m) => ({
            name: m.name,
            label: m.label,
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
          })),
        })),
        models: c.models,
        contextWindow: budget.contextWindow,
        maxOutputTokens: budget.maxOutputTokens,
        temperature: c.temperature,
        recentChaptersFullText: c.recentChaptersFullText,
        prevChapterTailChars: c.prevChapterTailChars,
        summaryBatchSize: c.summaryBatchSize,
        requestTimeoutMs: c.requestTimeoutMs,
        concurrency: c.concurrency,
        fallbackAttempts: c.fallbackAttempts,
      },
      keys: await apiKeyStatus(c.providers),
    });
  }

  // ---------------------------------------------------------------- 附件

  private addAttachment(att: Attachment): void {
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

  /** 供命令直接调用：预设写入目标并聚焦。 */
  async focusWithTarget(order: number): Promise<void> {
    this.current.targetOrder = order;
    this.tab = 'chat';
    this.post({ type: 'tab', tab: 'chat' });
    this.post({ type: 'session', session: serializeSession(this.current) });
    for (const host of this.hosts) {
      host.reveal();
    }
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
    await this.newSession();
    for (const host of this.hosts) {
      host.reveal();
    }
  }

  // ---------------------------------------------------------------- 会话

  private async persist(): Promise<void> {
    // 空会话不落盘——历史列表里不该出现一堆没说过话的占位。
    if (this.current.turns.length === 0) {
      return;
    }
    this.current.updatedAt = nowIso();
    await this.store.write(this.current);
    if (this.tab === 'history') {
      await this.pushSessions();
    }
  }

  private async newSession(): Promise<void> {
    if (this.busy) {
      this.toast('正在生成，请先停止。', 'error');
      return;
    }
    await this.persist();
    this.current = this.store.create(this.current.targetOrder);
    this.pending = [];
    this.tab = 'chat';
    this.post({ type: 'tab', tab: 'chat' });
    this.post({ type: 'session', session: serializeSession(this.current) });
    this.post({ type: 'attachments', items: [] });
  }

  private async openSession(id: string): Promise<void> {
    if (this.busy) {
      this.toast('正在生成，请先停止。', 'error');
      return;
    }
    const loaded = await this.store.read(id);
    if (!loaded) {
      this.toast('这个会话读不出来，可能已被删除或损坏。', 'error');
      await this.pushSessions();
      return;
    }
    await this.persist();
    this.current = loaded;
    this.pending = [];
    this.tab = 'chat';
    this.post({ type: 'tab', tab: 'chat' });
    this.post({ type: 'session', session: serializeSession(this.current) });
    this.post({ type: 'attachments', items: [] });
  }

  private async deleteSession(id: string): Promise<void> {
    const target = await this.store.read(id);
    const pick = await getHost().confirm(
      `删除对话「${target?.title ?? id}」？`,
      ['删除'],
      { modal: true, detail: '会移到 .novelforge/.trash/，可手动找回。' }
    );
    if (pick !== '删除') {
      return;
    }
    await this.store.delete(id);
    if (id === this.current.id) {
      this.current = this.store.create(this.current.targetOrder);
      this.post({ type: 'session', session: serializeSession(this.current) });
    }
    await this.pushSessions();
  }

  private async renameSession(id: string): Promise<void> {
    const target = await this.store.read(id);
    if (!target) {
      return;
    }
    const title = await getHost().input({
      title: '重命名对话',
      value: target.title,
      validate: (v) => (v.trim() ? undefined : '不能为空'),
    });
    if (!title) {
      return;
    }
    const updated = await this.store.rename(id, title);
    if (updated && id === this.current.id) {
      this.current.title = updated.title;
      this.post({ type: 'session', session: serializeSession(this.current) });
    }
    await this.pushSessions();
  }

  // ---------------------------------------------------------------- 生成

  private async send(payload: SendPayload): Promise<void> {
    if (this.busy) {
      this.toast('已有一个生成任务在进行中。', 'error');
      return;
    }
    if (!payload.text.trim()) {
      this.toast('请先输入内容。', 'error');
      return;
    }

    const userTurn: ChatTurn = {
      id: makeTurnId(),
      role: 'user',
      content: payload.text.trim(),
      at: nowIso(),
      attachments: this.pending.length > 0 ? [...this.pending] : undefined,
      excludedIds: payload.excludedIds.length > 0 ? payload.excludedIds : undefined,
    };
    this.current.turns.push(userTurn);
    if (this.current.turns.length === 1) {
      this.current.title = deriveTitle(userTurn.content);
    }
    this.current.targetOrder = payload.targetOrder;
    this.current.targetWords = payload.targetWords;
    this.pending = [];

    this.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
    this.post({ type: 'attachments', items: [] });
    await this.persist();

    await this.runTurn(payload, userTurn);
  }

  /** 重来一轮：丢掉旧回复，用同一条用户消息重新生成。 */
  private async retry(turnId: string, payload: SendPayload): Promise<void> {
    if (this.busy) {
      this.toast('已有一个生成任务在进行中。', 'error');
      return;
    }
    const idx = this.current.turns.findIndex((t) => t.id === turnId);
    if (idx === -1) {
      return;
    }
    const userTurn = this.current.turns[idx];
    if (userTurn.role !== 'user') {
      return;
    }
    // 丢掉这条用户消息之后的所有轮次——重来意味着从这里分叉。
    this.current.turns.splice(idx + 1);
    this.post({ type: 'session', session: serializeSession(this.current) });
    await this.runTurn({ ...payload, text: userTurn.content }, userTurn);
  }

  private async runTurn(payload: SendPayload, userTurn: ChatTurn): Promise<void> {
    this.busy = true;
    this.post({ type: 'busy', value: true });

    const assistantTurn: ChatTurn = {
      id: makeTurnId(),
      role: 'assistant',
      content: '',
      at: nowIso(),
    };
    // 先插一条空回复，前端好挂流式内容。
    this.current.turns.push(assistantTurn);
    this.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });

    // 历史是本轮之前的所有轮次（不含刚插入的两条）。
    const history = this.current.turns.slice(0, -2).filter((t) => t.content.trim());

    const built = await this.session.generate(
      {
        targetOrder: payload.targetOrder,
        outline: userTurn.content,
        targetWords: payload.targetWords > 0 ? payload.targetWords : undefined,
        excludedIds: userTurn.excludedIds,
        attachments: userTurn.attachments,
        history,
        mode: payload.mode,
      },
      {
        onDelta: (delta) => this.post({ type: 'delta', turnId: assistantTurn.id, text: delta }),
        // 推理模型可能先思考几十秒才开始吐正文。把思考也推给前端，
        // 否则那段时间气泡是空的，看起来就像卡住、最后一次性蹦出来。
        onReasoning: (delta, full) => {
          assistantTurn.reasoning = full;
          this.post({ type: 'reasoning', turnId: assistantTurn.id, text: delta });
        },
        onDone: (full) => {
          assistantTurn.content = full;
        },
        onError: (message) => {
          assistantTurn.error = message;
        },
        onCancelled: () => {
          assistantTurn.interrupted = true;
        },
      }
    );

    this.busy = false;
    this.post({ type: 'busy', value: false });

    if (built) {
      assistantTurn.context = serializeDigest(built);
      this.post({ type: 'context', turnId: assistantTurn.id, digest: assistantTurn.context });
    }
    if (assistantTurn.error) {
      this.toast(assistantTurn.error, 'error');
    }
    this.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
    await this.persist();
  }

  private async accept(
    turnId: string,
    mode: 'append' | 'new',
    order: number,
    title: string,
    text: string
  ): Promise<void> {
    const turn = this.current.turns.find((t) => t.id === turnId);
    if (!turn) {
      return;
    }
    if (!text.trim()) {
      this.toast('内容是空的。', 'error');
      return;
    }
    // 前端可能改过草稿，以传上来的为准。
    turn.content = text;

    const relPath =
      mode === 'append'
        ? await this.session.accept(text, { mode: 'append', order })
        : await this.session.accept(text, {
            mode: 'new',
            order,
            title: title.trim() || ContinueSession.suggestTitle(text, order),
          });

    turn.acceptedTo = relPath;
    await this.persist();
    this.post({ type: 'turnDone', turn: serializeTurn(turn) });
    this.toast(`已写入 ${turn.acceptedTo}`);

    await getHost().openFile(turn.acceptedTo);
    await this.pushState();
  }

  // ---------------------------------------------------------------- 草稿

  /**
   * 打开某章的草稿。首次点击按需创建，已存在原样打开（绝不覆盖）。
   *
   * **必须先在真实章节列表里查到这一章**：这条路径会写盘，拿前端传上来的
   * 任意相对路径去拼 `drafts/<任意>` 就等于开了一个绕过区守卫的写入口子。
   * 别为了省一次扫描把这一步优化掉。
   */
  private async openDraft(chapterRelPath: string): Promise<void> {
    const chapter = (await this.project.listChapters()).find((c) => c.relPath === chapterRelPath);
    if (!chapter) {
      log.warn(`找不到章节 ${chapterRelPath}，可能刚被改名或删除`);
      this.toast('找不到这一章，可能刚被改名或删除。', 'error');
      await this.pushState();
      return;
    }
    const rel = await this.project.ensureDraft(chapter);
    log.info(`打开第 ${chapter.order} 章的草稿`, rel);
    const host = getHost();
    if (host.openBeside) {
      await host.openBeside(rel);
    } else {
      await host.openFile(rel);
    }
    // 刚建出来的草稿要让 hasDraft 立刻翻过来，菜单文案跟着变。
    await this.pushState();
  }

  // ---------------------------------------------------------------- 工程页

  /**
   * 工程页的按钮直调 core 流程，webview 不直接碰文件系统。
   * 插件的命令面板也复用同一批 core 流程，行为不会分叉。
   *
   * `dir` 是「在某个文件夹上点＋」时的落点目录；从工具栏点则不带，落在区根目录。
   */
  private async projectAction(action: ProjectAction, order?: number, dir?: string): Promise<void> {
    // refresh 每次切页/刷盘都来一趟，记了只会淹掉别的；其余动作都值得留痕。
    if (action !== 'refresh') {
      log.info(
        `工程页动作：${action}`,
        [order !== undefined ? `章节 ${order}` : '', dir ? `落点 ${dir}` : ''].filter(Boolean).join('｜') || undefined
      );
    }
    switch (action) {
      case 'initProject':
        await initProjectFlow(this.project, dirBaseName(this.project));
        break;
      case 'refresh':
        break; // pushState 本身就是刷新
      case 'newChapter':
        await newChapterFlow(this.project, dir);
        break;
      case 'newCharacter':
        await newCharacter(this.project, dir);
        break;
      case 'newLore':
        await newLore(this.project, dir);
        break;
      case 'newFolder': {
        // 落点目录决定建到哪个区；没给就问用户。
        const section = dir ? sectionOf(this.project, dir)?.section : await this.pickSection();
        if (!section) {
          break;
        }
        await newFolder(this.project, section, dir);
        break;
      }
      case 'continueFrom':
        // 与原语义一致：从某章续写 = 目标设为下一章
        this.current.targetOrder = (order ?? (await this.project.nextChapterOrder() - 1)) + 1;
        await this.showTab('chat');
        break;
      case 'summarizeChapter': {
        if (order === undefined) {
          break;
        }
        const chapter = await this.project.getChapter(order);
        if (!chapter) {
          log.warn(`找不到第 ${order} 章，可能刚被改名或删除`);
          break;
        }
        await runTask(
          `总结第 ${chapter.order} 章`,
          async ({ signal, report }) => {
            report({ message: `《${chapter.title}》`, current: 0, total: 1 });
            const ok = await summarizeChapter(this.project, chapter, undefined, signal);
            report({ message: ok ? '完成' : '未生成', current: 1, total: 1 });
            if (ok) {
              getHost().toast(`第 ${chapter.order} 章摘要已生成。`);
            }
          },
          { scope: '摘要' }
        );
        break;
      }
      case 'syncSummaries':
        await syncSummaries(this.project);
        break;
      case 'rebuildGlobalSummary':
        await rebuildGlobalSummary(this.project);
        break;
      case 'extractCharacters':
        await extractCharacters(this.project);
        break;
      case 'extractStyle':
        await extractStyle(this.project);
        break;
    }

    // 这些流程大多会改动磁盘，且不一定触发 watcher（比如刚初始化的空工程）。
    // pushState 会顺带刷新当前页签。
    await this.pushState();
  }

  /** 工具栏上的「＋ 文件夹」没有落点，先问建到哪个区。 */
  private async pickSection(): Promise<Section | undefined> {
    return getHost().pick<Section>(
      sectionRoots(this.project).map((s) => ({ label: s.label, detail: `${s.root}/`, value: s.section })),
      '在哪个区新建文件夹？'
    );
  }

  /**
   * 类文件操作。工程页的 rename/move/delete 走 core/fileOps（三区锁定），
   * 文件页的 renameAny/paste 走 core/projectFiles（根范围）。
   * 有逐项结果的动作额外推 filesOpDone，前端据此 remap 编辑器标签。
   */
  private async fileAction(msg: Extract<InMessage, { type: 'fileAction' }>): Promise<void> {
    const { action, relPath, relPaths, op, targetDir } = msg;
    log.info(
      `文件动作：${action}`,
      [relPath ?? '', relPaths ? relPaths.join('、') : '', targetDir !== undefined ? `目标目录 ${targetDir || '（根）'}` : '']
        .filter(Boolean)
        .join('｜') || undefined
    );
    let results: FileOpResult[] | undefined;
    switch (action) {
      case 'rename':
        if (relPath) {
          await renameEntry(this.project, relPath);
        }
        break;
      case 'renameAny':
        if (relPath) {
          results = [await renameAny(this.project, relPath)];
        }
        break;
      case 'move':
        if (relPath) {
          await moveEntry(this.project, relPath, targetDir);
        }
        break;
      case 'delete':
        if (relPath) {
          await deleteEntry(this.project, relPath);
        }
        break;
      case 'paste':
        results =
          op === 'copy'
            ? await copyInto(this.project, relPaths ?? [], targetDir ?? '')
            : await moveInto(this.project, relPaths ?? [], targetDir ?? '');
        break;
    }
    if (results && results.length > 0) {
      this.post({
        type: 'filesOpDone',
        op: action === 'renameAny' ? 'rename' : op === 'copy' ? 'copy' : 'move',
        results,
      });
    }
    await this.pushState();
  }

  /**
   * 角色卡动作。作用对象是**一个角色**（用名字标识），不是文件或章节，
   * 因此与 fileAction / projectAction 分开走。
   */
  private async characterAction(action: CharacterAction, name: string, relPath?: string): Promise<void> {
    log.info(`角色动作：${action} ${name}`, relPath);
    switch (action) {
      case 'updateCard':
      case 'rebuildCard':
        if (!relPath) {
          log.warn(`${action} 缺少角色卡路径，忽略`);
          break;
        }
        await updateCharacterCard(
          this.project,
          relPath,
          action === 'updateCard' ? 'incremental' : 'full'
        );
        break;
      case 'createCard':
        await createCardForCast(this.project, name);
        break;
      case 'createAllCards':
        await createCardsForAllCast(this.project);
        break;
      case 'updateAllCards':
        await updateAllCharacterCards(this.project, 'incremental');
        break;
      case 'rebuildAllCards':
        await updateAllCharacterCards(this.project, 'full');
        break;
      case 'cleanAliases':
        await cleanCharacterAliases(this.project);
        break;
      case 'mergeDuplicates':
        await mergeDuplicateCharacterCards(this.project);
        break;
    }
    await this.pushState();
  }

  // ---------------------------------------------------------------- 设置

  private async saveSettings(s: SettingsPayload): Promise<void> {
    const before = readConfig().providers.map((p) => p.id);
    const providers = normalizeProviders(s.providers);
    if (s.providers.length > 0 && providers.length === 0) {
      log.error(
        '设置未保存：服务商配置不合法',
        'id 不能为空或含斜杠，且每个服务商至少要有一个模型。前端已收到 rejected 回执，编辑内容保留。'
      );
      this.toast('服务商配置不合法：id 不能为空或含斜杠，且每个服务商至少要有一个模型。', 'error');
      // 回执必须发——前端据此知道这次没落盘，从而保住未保存的编辑。
      await this.pushSettings('rejected');
      return;
    }

    const models = normalizeModelList(s.models);
    await updateSettings({
      providers,
      // 列表是唯一真相；updateSettings 会顺手把 model 对齐到首项。
      models,
      model: models[0] ?? '',
      contextWindow: s.contextWindow,
      maxOutputTokens: s.maxOutputTokens,
      temperature: s.temperature,
      recentChaptersFullText: s.recentChaptersFullText,
      prevChapterTailChars: s.prevChapterTailChars,
      summaryBatchSize: s.summaryBatchSize,
      requestTimeoutMs: s.requestTimeoutMs,
      concurrency: s.concurrency,
      fallbackAttempts: s.fallbackAttempts,
    });

    // 删掉的服务商不该在钥匙串里留下孤儿 Key。
    await pruneApiKeys(providers, before);

    log.info(
      '设置已保存',
      `${providers.length} 个服务商｜默认模型 ${models.join('、') || '（未选）'}｜` +
        `窗口 ${s.contextWindow}／输出 ${s.maxOutputTokens}｜温度 ${s.temperature}｜超时 ${s.requestTimeoutMs}ms｜` +
        `并发 ${s.concurrency}｜换模型重试 ${s.fallbackAttempts} 次`
    );
    await this.pushSettings('saved');
    await this.pushState();
    this.toast('设置已保存。');
  }

  /**
   * 输入框旁边的模型下拉框。只改选中项，不动服务商列表。
   *
   * 「默认模型列表」是唯一真相，所以这里不是覆盖某个字段，而是**把选中的
   * 模型提到列表头**——设置页里排的顺序其余部分原样保留。
   */
  private async selectModel(ref: string): Promise<void> {
    const config = readConfig();
    if (!resolveModelRef(config.providers, ref)) {
      const issue = describeModelIssue(config.providers, ref);
      log.error(`切换模型失败：${issue}`, `请求的引用 ${ref}`);
      this.toast(issue, 'error');
      await this.pushState();
      return;
    }
    const models = await promoteModel(ref);
    log.info(`已切换到模型 ${ref}`, models.length > 1 ? `默认模型列表：${models.join('、')}` : undefined);
    await this.pushState();
    // 设置页开着时，列表顺序变了要立刻看得见。
    await this.pushSettings();
  }

  private async testConnection(ref?: string, provider?: SerializedProvider): Promise<void> {
    const target = ref ?? readConfig().model;
    // 设置页传来的草稿同样走一遍容错归一化——手改过的字段不该让测试崩掉。
    const draft = provider ? normalizeProviders([provider])[0] : undefined;
    this.toast(`正在测试 ${target}…`);
    const result = await this.session.testConnection(ref, draft);
    this.toast(result.message, result.ok ? 'info' : 'error');
    await this.pushState();
  }
}

// ---------------------------------------------------------------- 序列化

function serializeSession(s: ChatSession): SerializedSession {
  return {
    id: s.id,
    title: s.title,
    targetOrder: s.targetOrder,
    targetWords: s.targetWords,
    turns: s.turns.map(serializeTurn),
  };
}

function serializeTurn(t: ChatTurn): SerializedTurn {
  return {
    id: t.id,
    role: t.role,
    content: t.content,
    at: t.at,
    attachments: t.attachments?.map(serializeAttachment),
    context: t.context,
    acceptedTo: t.acceptedTo,
    interrupted: t.interrupted,
    error: t.error,
    reasoning: t.reasoning,
  };
}

function serializeAttachment(a: Attachment): SerializedAttachment {
  return { id: a.id, kind: a.kind, label: a.label, relPath: a.relPath, range: a.range, text: a.text };
}

function serializeDigest(built: BuiltContext): SerializedDigest {
  return {
    usedTokens: built.usedTokens,
    budget: built.budget,
    clamped: built.budgetClampedByProvider,
    items: built.items.map(serializeItem),
  };
}

function serializeItem(i: ContextItem) {
  return {
    id: i.id,
    label: i.label,
    kind: i.kind,
    priority: i.priority,
    tokens: i.tokens,
    status: i.status,
    note: i.note,
    source: i.source,
  };
}

export function describeProvider(config: NovelConfig = readConfig()): string {
  if (!config.active) {
    return config.model || '未选择模型';
  }
  const { profile, model } = config.active;
  return `${providerLabel(profile)} · ${modelLabel(model)}`;
}
