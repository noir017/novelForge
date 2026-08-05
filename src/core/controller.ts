import { dirBaseName, initProjectFlow, newChapterFlow } from './actions';
import { listAttachmentChoices } from './attachments';
import { updateSettings, readConfig, readGlobalBudget } from './config';
import { BuiltContext, ContextItem } from './context/builder';
import { extractCharacters, newCharacter, newLore } from './features/characters';
import { ContinueSession } from './features/continueWriting';
import { extractStyle } from './features/style';
import { rebuildGlobalSummary, summarizeChapter, syncSummaries } from './features/summarize';
import { getHost } from './host';
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
  InMessage,
  OutMessage,
  ProjectAction,
  SendPayload,
  SerializedAttachment,
  SerializedDigest,
  SerializedSession,
  SerializedTurn,
  SettingsPayload,
  Tab,
  ViewState,
} from './protocol';
import { buildProjectTree } from './projectView';

/** Webview 宿主需要提供的能力。侧边栏与编辑器面板各实现一份。 */
export interface ViewHost {
  readonly kind: 'sidebar' | 'editor';
  post(message: OutMessage): void;
  reveal(): void;
}

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

  constructor(private readonly project: NovelProject) {
    this.store = new SessionStore(project);
    this.session = new ContinueSession(project);
    this.current = this.store.create();
  }

  attach(host: ViewHost): void {
    this.hosts.add(host);
  }

  detach(host: ViewHost): void {
    this.hosts.delete(host);
  }

  dispose(): void {
    this.session.dispose();
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
      this.toast(err instanceof Error ? err.message : String(err), 'error');
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

      case 'syncSummaries':
        await syncSummaries(this.project);
        await this.pushState();
        return;

      case 'projectAction':
        await this.projectAction(msg.action, msg.order);
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
        await this.testConnection(msg.ref);
        return;

      case 'openNativeSettings':
        await getHost().openNativeSettings?.();
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
    const standalone = getHost().name === 'standalone';
    const models = listModelChoices(config.providers).map((c) => ({
      ref: c.ref,
      label: c.label,
      group: c.group,
    }));

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
      modelIssue: config.active ? undefined : describeModelIssue(config.providers, config.model),
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
    } else if (this.tab === 'history') {
      await this.pushSessions();
    } else if (this.tab === 'settings') {
      await this.pushSettings();
    }
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
        model: c.model,
        contextWindow: budget.contextWindow,
        maxOutputTokens: budget.maxOutputTokens,
        temperature: c.temperature,
        recentChaptersFullText: c.recentChaptersFullText,
        prevChapterTailChars: c.prevChapterTailChars,
        summaryBatchSize: c.summaryBatchSize,
        requestTimeoutMs: c.requestTimeoutMs,
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

  // ---------------------------------------------------------------- 工程页

  /**
   * 工程页的按钮直调 core 流程，webview 不直接碰文件系统。
   * 插件的命令面板也复用同一批 core 流程，行为不会分叉。
   */
  private async projectAction(action: ProjectAction, order?: number): Promise<void> {
    const host = getHost();
    switch (action) {
      case 'initProject':
        await initProjectFlow(this.project, dirBaseName(this.project));
        break;
      case 'refresh':
        break; // pushState 本身就是刷新
      case 'newChapter':
        await newChapterFlow(this.project);
        break;
      case 'newCharacter':
        await newCharacter(this.project);
        break;
      case 'newLore':
        await newLore(this.project);
        break;
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
          break;
        }
        await host.progress(`Novel Forge：总结第 ${chapter.order} 章`, async (signal) => {
          const ok = await summarizeChapter(this.project, chapter, undefined, signal);
          if (ok) {
            host.toast(`第 ${chapter.order} 章摘要已生成。`);
          }
        });
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

  // ---------------------------------------------------------------- 设置

  private async saveSettings(s: SettingsPayload): Promise<void> {
    const before = readConfig().providers.map((p) => p.id);
    const providers = normalizeProviders(s.providers);
    if (s.providers.length > 0 && providers.length === 0) {
      this.toast('服务商配置不合法：id 不能为空或含斜杠，且每个服务商至少要有一个模型。', 'error');
      // 回执必须发——前端据此知道这次没落盘，从而保住未保存的编辑。
      await this.pushSettings('rejected');
      return;
    }

    await updateSettings({
      providers,
      model: s.model.trim(),
      contextWindow: s.contextWindow,
      maxOutputTokens: s.maxOutputTokens,
      temperature: s.temperature,
      recentChaptersFullText: s.recentChaptersFullText,
      prevChapterTailChars: s.prevChapterTailChars,
      summaryBatchSize: s.summaryBatchSize,
      requestTimeoutMs: s.requestTimeoutMs,
    });

    // 删掉的服务商不该在钥匙串里留下孤儿 Key。
    await pruneApiKeys(providers, before);

    await this.pushSettings('saved');
    await this.pushState();
    this.toast('设置已保存。');
  }

  /** 输入框旁边的模型下拉框。只改选中项，不动服务商列表。 */
  private async selectModel(ref: string): Promise<void> {
    const config = readConfig();
    if (!resolveModelRef(config.providers, ref)) {
      this.toast(describeModelIssue(config.providers, ref), 'error');
      await this.pushState();
      return;
    }
    await updateSettings({ model: ref });
    await this.pushState();
  }

  private async testConnection(ref?: string): Promise<void> {
    const target = ref ?? readConfig().model;
    this.toast(`正在测试 ${target}…`);
    const result = await this.session.testConnection(ref);
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
