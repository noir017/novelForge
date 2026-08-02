// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    tabbar: $('tabbar'),
    newSessionBtn: $('newSessionBtn'),
    openInEditorBtn: $('openInEditorBtn'),
    staleBanner: $('staleBanner'),
    staleText: $('staleText'),
    syncBtn: $('syncBtn'),
    messages: $('messages'),
    emptyHint: $('emptyHint'),
    chips: $('chips'),
    input: $('input'),
    atBtn: $('atBtn'),
    selBtn: $('selBtn'),
    modelSelect: $('modelSelect'),
    modeSelect: $('modeSelect'),
    targetSelect: $('targetSelect'),
    targetWords: $('targetWords'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    providerMeta: $('providerMeta'),
    historyMeta: $('historyMeta'),
    sessionList: $('sessionList'),
    providerList: $('providerList'),
    providerCount: $('providerCount'),
    addProviderBtn: $('addProviderBtn'),
    presets: $('presets'),
    toast: $('toast'),
  };

  const store = {
    state: null,
    session: { id: '', title: '', turns: [] },
    attachments: [],
    busy: false,
    /** turnId -> 该轮被取消勾选的上下文条目 id 集合 */
    excluded: new Set(),
    /** 正在流式接收的那条消息 id */
    streamingId: null,
  };

  // 侧边栏折叠再展开时不丢草稿。
  const saved = vscode.getState();
  if (saved) {
    el.input.value = saved.draft || '';
    if (saved.mode) el.modeSelect.value = saved.mode;
    if (saved.targetWords) el.targetWords.value = saved.targetWords;
  }

  function persist() {
    vscode.setState({
      draft: el.input.value,
      mode: el.modeSelect.value,
      targetWords: el.targetWords.value,
    });
  }

  function fmt(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  function countWords(text) {
    return text.replace(/\s/g, '').length;
  }

  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', !!isError);
    el.toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.toast.classList.add('hidden'), isError ? 9000 : 3500);
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  }

  // ---------------------------------------------------------------- tabbar

  function showTab(tab) {
    for (const btn of el.tabbar.querySelectorAll('.tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    for (const pane of document.querySelectorAll('.pane')) {
      pane.classList.toggle('active', pane.id === `pane-${tab}`);
    }
    if (tab === 'chat') el.input.focus();
  }

  el.tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    showTab(btn.dataset.tab);
    vscode.postMessage({ type: 'switchTab', tab: btn.dataset.tab });
  });

  // ---------------------------------------------------------------- 状态

  function renderState(state) {
    store.state = state;
    el.openInEditorBtn.classList.toggle('hidden', state.host !== 'sidebar');
    renderModelSelect(state);

    if (!state.initialized) {
      el.providerMeta.textContent = '当前工作区还不是小说工程，先运行「Novel: 初始化小说工程」。';
      el.sendBtn.disabled = true;
      return;
    }
    el.sendBtn.disabled = store.busy;
    el.providerMeta.textContent = state.modelIssue
      ? state.modelIssue
      : `${state.modelLabel} · 窗口 ${fmt(state.contextWindow)} / 输出 ${fmt(state.maxOutputTokens)}`;
    el.providerMeta.classList.toggle('warn', !!state.modelIssue);

    const prev = el.targetSelect.value;
    el.targetSelect.innerHTML = '';
    const newOpt = document.createElement('option');
    newOpt.value = String(state.nextOrder);
    newOpt.textContent = `新建第 ${state.nextOrder} 章`;
    newOpt.dataset.mode = 'new';
    el.targetSelect.appendChild(newOpt);
    for (const c of [...state.chapters].reverse()) {
      const opt = document.createElement('option');
      opt.value = String(c.order);
      opt.textContent = `追加到第 ${c.order} 章《${c.title}》`;
      opt.dataset.mode = 'append';
      el.targetSelect.appendChild(opt);
    }
    const want = prev || String(store.session.targetOrder ?? state.nextOrder);
    el.targetSelect.value = [...el.targetSelect.options].some((o) => o.value === want)
      ? want
      : String(state.nextOrder);

    if (state.staleCount > 0) {
      el.staleText.textContent = `有 ${state.staleCount} 章摘要缺失或已过期，这些章节的剧情不会进入上下文。`;
      el.staleBanner.classList.remove('hidden');
    } else {
      el.staleBanner.classList.add('hidden');
    }
  }

  /** 输入框旁的模型下拉框，按服务商分组。 */
  function renderModelSelect(state) {
    el.modelSelect.innerHTML = '';
    const models = state.models || [];
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未配置模型';
      el.modelSelect.appendChild(opt);
      el.modelSelect.disabled = true;
      return;
    }
    el.modelSelect.disabled = false;

    let group = null;
    for (const m of models) {
      if (m.group !== group) {
        group = m.group;
        const og = document.createElement('optgroup');
        og.label = group;
        el.modelSelect.appendChild(og);
      }
      const opt = document.createElement('option');
      opt.value = m.ref;
      // 显示完整引用，因为它才是用户在别处（配置文件、文档）看到的东西。
      opt.textContent = m.ref;
      opt.title = `${m.group} · ${m.label}`;
      el.modelSelect.lastElementChild.appendChild(opt);
    }

    // 当前引用可能指向一个已被删掉的模型，这时补一条占位项，
    // 否则下拉框会静默跳到第一个模型，用户以为自己在用另一个。
    if (state.model && !models.some((m) => m.ref === state.model)) {
      const opt = document.createElement('option');
      opt.value = state.model;
      opt.textContent = `${state.model}（未配置）`;
      el.modelSelect.appendChild(opt);
    }
    el.modelSelect.value = state.model || models[0].ref;
  }

  function setBusy(value) {
    store.busy = value;
    el.sendBtn.classList.toggle('hidden', value);
    el.stopBtn.classList.toggle('hidden', !value);
    el.atBtn.disabled = value;
    el.selBtn.disabled = value;
  }

  // ---------------------------------------------------------------- 附件

  function renderChips() {
    el.chips.innerHTML = '';
    for (const att of store.attachments) {
      const chip = document.createElement('span');
      chip.className = 'chip';

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = att.label;
      label.title = att.relPath || att.label;
      chip.appendChild(label);

      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = '移除';
      x.addEventListener('click', () => {
        store.attachments = store.attachments.filter((a) => a.id !== att.id);
        renderChips();
      });
      chip.appendChild(x);

      el.chips.appendChild(chip);
    }
  }

  // ---------------------------------------------------------------- 消息流

  function renderSession(session) {
    store.session = session;
    store.excluded = new Set();
    el.messages.innerHTML = '';
    if (session.turns.length === 0) {
      el.messages.appendChild(el.emptyHint);
      el.emptyHint.classList.remove('hidden');
    }
    for (const turn of session.turns) {
      el.messages.appendChild(buildTurn(turn));
    }
    if (session.targetWords) el.targetWords.value = session.targetWords;
    if (store.state && session.targetOrder !== undefined) {
      const want = String(session.targetOrder);
      if ([...el.targetSelect.options].some((o) => o.value === want)) {
        el.targetSelect.value = want;
      }
    }
    scrollToBottom();
  }

  function upsertTurn(turn) {
    el.emptyHint.classList.add('hidden');
    const existing = el.messages.querySelector(`[data-turn="${turn.id}"]`);
    const node = buildTurn(turn);
    if (existing) {
      existing.replaceWith(node);
    } else {
      el.messages.appendChild(node);
    }
    const idx = store.session.turns.findIndex((t) => t.id === turn.id);
    if (idx === -1) store.session.turns.push(turn);
    else store.session.turns[idx] = turn;
    scrollToBottom();
  }

  function buildTurn(turn) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${turn.role}`;
    wrap.dataset.turn = turn.id;
    if (turn.error) wrap.classList.add('msg-error');

    const head = document.createElement('div');
    head.className = 'msg-head';
    const role = document.createElement('span');
    role.className = 'msg-role';
    role.textContent = turn.role === 'user' ? '我' : '模型';
    head.appendChild(role);
    const time = document.createElement('span');
    time.textContent = timeLabel(turn.at);
    head.appendChild(time);
    if (turn.role === 'assistant' && turn.content) {
      const wc = document.createElement('span');
      wc.textContent = `· ${countWords(turn.content)} 字`;
      head.appendChild(wc);
    }
    if (turn.interrupted) {
      const flag = document.createElement('span');
      flag.textContent = '· 已中断';
      head.appendChild(flag);
    }
    wrap.appendChild(head);

    if (turn.attachments && turn.attachments.length > 0) {
      const box = document.createElement('div');
      box.className = 'msg-attachments';
      for (const att of turn.attachments) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const label = document.createElement('span');
        label.className = 'chip-label';
        label.textContent = att.label;
        chip.appendChild(label);
        if (att.relPath) {
          chip.style.cursor = 'pointer';
          chip.title = att.relPath;
          chip.addEventListener('click', () =>
            vscode.postMessage({ type: 'openFile', path: att.relPath })
          );
        }
        box.appendChild(chip);
      }
      wrap.appendChild(box);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = turn.error ? turn.error : turn.content;
    if (turn.role === 'assistant' && !turn.error) {
      // 结果可以就地改完再采纳。
      body.contentEditable = 'true';
      body.spellcheck = false;
      body.addEventListener('blur', () => {
        if (body.textContent !== turn.content) {
          turn.content = body.textContent;
          vscode.postMessage({ type: 'editTurn', turnId: turn.id, text: turn.content });
        }
      });
    }
    wrap.appendChild(body);

    if (turn.context) {
      wrap.appendChild(buildContextDetails(turn.context));
    }

    wrap.appendChild(buildActions(turn));
    return wrap;
  }

  function buildActions(turn) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';

    if (turn.role === 'assistant' && turn.content && !turn.error) {
      if (turn.acceptedTo) {
        const note = document.createElement('span');
        note.className = 'accepted';
        note.textContent = `✓ 已写入 ${turn.acceptedTo}`;
        bar.appendChild(note);
        bar.appendChild(
          linkBtn('打开', () => vscode.postMessage({ type: 'openFile', path: turn.acceptedTo }))
        );
      } else {
        const accept = document.createElement('button');
        accept.className = 'chip-btn';
        accept.textContent = '采纳写入';
        accept.addEventListener('click', () => {
          const opt = el.targetSelect.selectedOptions[0];
          const body = document.querySelector(`[data-turn="${turn.id}"] .msg-body`);
          vscode.postMessage({
            type: 'accept',
            turnId: turn.id,
            mode: opt && opt.dataset.mode === 'new' ? 'new' : 'append',
            order: Number(el.targetSelect.value),
            title: '',
            text: body ? body.textContent : turn.content,
          });
        });
        bar.appendChild(accept);
      }
      bar.appendChild(
        linkBtn('复制', () => {
          const body = document.querySelector(`[data-turn="${turn.id}"] .msg-body`);
          void navigator.clipboard.writeText(body ? body.textContent : turn.content);
          toast('已复制到剪贴板。');
        })
      );
    }

    if (turn.role === 'user') {
      bar.appendChild(
        linkBtn('重新生成', () => {
          if (store.busy) {
            toast('正在生成，请先停止。', true);
            return;
          }
          vscode.postMessage({ type: 'retry', turnId: turn.id, payload: payload() });
        })
      );
    }

    bar.appendChild(
      linkBtn('删除', () => vscode.postMessage({ type: 'deleteTurn', turnId: turn.id }))
    );
    return bar;
  }

  function linkBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildContextDetails(digest) {
    const det = document.createElement('details');
    det.className = 'ctx';

    const sum = document.createElement('summary');
    const over = digest.usedTokens > digest.budget;
    sum.textContent = `上下文 ${fmt(digest.usedTokens)} / ${fmt(digest.budget)} token${
      digest.clamped ? '（已按模型配额压缩）' : ''
    } · ${digest.items.filter((i) => i.status === 'included' || i.status === 'degraded').length} 项`;
    if (over) sum.classList.add('over-budget');
    det.appendChild(sum);

    const ul = document.createElement('ul');
    for (const item of digest.items) {
      const li = document.createElement('li');
      li.className = item.status;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `P${item.priority}`;
      li.appendChild(badge);

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;
      li.appendChild(label);

      if (item.source) {
        li.appendChild(
          linkBtn('打开', () => vscode.postMessage({ type: 'openFile', path: item.source }))
        );
      }

      const tokens = document.createElement('span');
      tokens.className = 'tokens';
      tokens.textContent = item.tokens > 0 ? `${fmt(item.tokens)} tk` : '—';
      li.appendChild(tokens);

      if (item.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = item.note;
        li.appendChild(note);
      }
      ul.appendChild(li);
    }
    det.appendChild(ul);
    return det;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  // ---------------------------------------------------------------- 发送

  function payload() {
    return {
      text: el.input.value,
      mode: el.modeSelect.value,
      targetOrder: Number(el.targetSelect.value) || 1,
      targetWords: Number(el.targetWords.value) || 0,
      attachments: store.attachments,
      excludedIds: [...store.excluded],
    };
  }

  function send() {
    if (store.busy) return;
    if (!el.input.value.trim()) {
      toast('请先输入内容。', true);
      el.input.focus();
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'send', payload: payload() });
    el.input.value = '';
    store.attachments = [];
    renderChips();
    persist();
  }

  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  el.atBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  el.selBtn.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
  el.syncBtn.addEventListener('click', () => vscode.postMessage({ type: 'syncSummaries' }));
  el.newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  el.openInEditorBtn.addEventListener('click', () => vscode.postMessage({ type: 'openInEditor' }));

  el.input.addEventListener('input', persist);
  el.modeSelect.addEventListener('change', persist);
  el.targetWords.addEventListener('input', persist);
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
  );

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    // 输入 @ 直接打开引用选择器，跟 Cursor 一致。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
    }
  });

  // ---------------------------------------------------------------- 历史

  function renderSessions(list) {
    el.sessionList.innerHTML = '';
    el.historyMeta.textContent = `${list.length} 个会话`;
    if (list.length === 0) {
      const hint = document.createElement('li');
      hint.className = 'hint';
      hint.textContent = '还没有保存的对话。发出第一条消息后会自动保存。';
      el.sessionList.appendChild(hint);
      return;
    }
    for (const s of list) {
      const li = document.createElement('li');
      li.className = s.active ? 'active' : '';
      li.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        vscode.postMessage({ type: 'openSession', id: s.id });
      });

      const head = document.createElement('div');
      head.className = 's-head';
      const title = document.createElement('span');
      title.className = 's-title';
      title.textContent = s.title;
      head.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${s.turnCount} 条 · ${timeLabel(s.updatedAt)}`;
      head.appendChild(meta);

      const actions = document.createElement('span');
      actions.className = 's-actions';
      actions.appendChild(
        linkBtn('重命名', () => vscode.postMessage({ type: 'renameSession', id: s.id }))
      );
      actions.appendChild(
        linkBtn('删除', () => vscode.postMessage({ type: 'deleteSession', id: s.id }))
      );
      head.appendChild(actions);
      li.appendChild(head);

      if (s.preview) {
        const preview = document.createElement('div');
        preview.className = 's-preview';
        preview.textContent = s.preview;
        li.appendChild(preview);
      }
      el.sessionList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- 设置

  const BUDGET_FIELDS = {
    contextWindow: 'setContextWindow',
    maxOutputTokens: 'setMaxOutputTokens',
    temperature: 'setTemperature',
    recentChaptersFullText: 'setRecentChaptersFullText',
    prevChapterTailChars: 'setPrevChapterTailChars',
    summaryBatchSize: 'setSummaryBatchSize',
    requestTimeoutMs: 'setRequestTimeoutMs',
  };

  const KIND_LABEL = {
    openai: 'OpenAI 兼容',
    anthropic: 'Anthropic',
    'vscode-lm': 'VS Code 语言模型',
  };

  /**
   * 常用服务商预设。点一下添加一整个服务商（含几个常用模型），
   * 而不是覆盖当前配置——多服务商并存本来就是重点。
   */
  const PRESETS = [
    {
      id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
      models: [{ name: 'gpt-4o', contextWindow: 128000 }, { name: 'gpt-4o-mini', contextWindow: 128000 }],
    },
    {
      id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
      models: [{ name: 'deepseek-chat', contextWindow: 64000 }, { name: 'deepseek-reasoner', contextWindow: 64000 }],
    },
    {
      id: 'glm', label: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [{ name: 'glm-4-plus', contextWindow: 128000 }, { name: 'glm-4-air', contextWindow: 128000 }],
    },
    {
      id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
      models: [{ name: 'moonshot-v1-128k', contextWindow: 128000 }],
    },
    {
      id: 'qwen', label: '通义千问', kind: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ name: 'qwen-max', contextWindow: 32000 }, { name: 'qwen-long', contextWindow: 1000000 }],
    },
    {
      id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      // OpenRouter 的模型名自带斜杠，正好验证「只切第一个斜杠」。
      models: [{ name: 'z-ai/glm-4.6', contextWindow: 200000 }, { name: 'anthropic/claude-sonnet-4.5', contextWindow: 200000 }],
    },
    {
      id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: [{ name: 'claude-sonnet-4-5', contextWindow: 200000 }],
    },
    {
      id: 'ollama', label: '本地 Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1',
      models: [{ name: 'qwen2.5:14b', contextWindow: 32000 }],
    },
    {
      id: 'copilot', label: 'VS Code 语言模型', kind: 'vscode-lm',
      models: [{ name: 'gpt-4o' }, { name: 'claude-3.5-sonnet' }],
    },
  ];

  /**
   * 设置页的本地编辑状态。保存前不回传，允许自由增删。
   *
   * `dirty` 是必要的：FileSystemWatcher 一刷新就会推一份新设置过来，
   * 如果无条件重渲染，用户正在填的 baseUrl 会被磁盘上的旧值冲掉。
   */
  const draft = { providers: [], model: '', keys: {}, dirty: false };

  function touch() {
    draft.dirty = true;
  }

  function renderSettings(settings, keys, ack) {
    const nextKeys = keys || {};

    // 保存成功的回执：磁盘上已是用户的版本，可以清掉本地编辑状态。
    // 被拒（ack === 'rejected'）则保持 dirty，别把用户刚填的东西冲掉。
    if (ack === 'saved') {
      draft.dirty = false;
    }

    if (draft.dirty) {
      // 有未保存的编辑，不能拿磁盘上的值覆盖。
      // 但 Key 状态得更新——用户刚在弹窗里输完 Key 就等着看这个。
      if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) {
        draft.keys = nextKeys;
        renderProviders();
      }
      return;
    }

    draft.providers = JSON.parse(JSON.stringify(settings.providers || []));
    draft.model = settings.model || '';
    draft.keys = nextKeys;
    for (const [key, id] of Object.entries(BUDGET_FIELDS)) {
      const node = $(id);
      if (node) node.value = String(settings[key]);
    }
    renderProviders();
  }

  function renderProviders() {
    el.providerList.innerHTML = '';
    const modelCount = draft.providers.reduce((n, p) => n + p.models.length, 0);
    el.providerCount.textContent = `${draft.providers.length} 个服务商 · ${modelCount} 个模型`;

    if (draft.providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '还没有服务商。点下面的预设快速添加一个，或手动添加。';
      el.providerList.appendChild(empty);
      return;
    }
    for (const p of draft.providers) {
      el.providerList.appendChild(buildProviderCard(p));
    }
  }

  function buildProviderCard(p) {
    const card = document.createElement('div');
    card.className = 'provider-block';

    const head = document.createElement('div');
    head.className = 'provider-head';
    const title = document.createElement('span');
    title.className = 'provider-title';
    title.textContent = p.label || p.id;
    head.appendChild(title);
    const kindTag = document.createElement('span');
    kindTag.className = 'meta';
    kindTag.textContent = KIND_LABEL[p.kind] || p.kind;
    head.appendChild(kindTag);
    head.appendChild(
      linkBtn('删除服务商', () => {
        draft.providers = draft.providers.filter((x) => x !== p);
        touch();
        renderProviders();
      })
    );
    card.appendChild(head);

    const row = document.createElement('div');
    row.className = 'grid';
    row.appendChild(
      textField('前缀 id', p.id, '不能含斜杠', (v) => {
        p.id = v.trim();
        title.textContent = p.label || p.id;
        touch();
        renderModelRows();
      })
    );
    row.appendChild(
      textField('显示名', p.label || '', '可留空', (v) => {
        p.label = v.trim() || undefined;
        title.textContent = p.label || p.id;
        touch();
      })
    );
    card.appendChild(row);

    if (p.kind !== 'vscode-lm') {
      card.appendChild(
        textField('接口地址 baseUrl', p.baseUrl || '', 'https://…', (v) => {
          p.baseUrl = v.trim() || undefined;
          touch();
        })
      );
    }

    // ---- 模型清单
    const modelsHead = document.createElement('div');
    modelsHead.className = 'provider-head';
    const ml = document.createElement('span');
    ml.className = 'meta';
    ml.textContent = p.kind === 'vscode-lm' ? '模型 family' : '模型';
    modelsHead.appendChild(ml);
    modelsHead.appendChild(
      linkBtn('＋ 添加模型', () => {
        p.models.push({ name: '' });
        touch();
        renderModelRows();
      })
    );
    card.appendChild(modelsHead);

    const modelBox = document.createElement('div');
    modelBox.className = 'model-list';
    card.appendChild(modelBox);

    function renderModelRows() {
      modelBox.innerHTML = '';
      for (const m of p.models) {
        modelBox.appendChild(buildModelRow(p, m, renderModelRows));
      }
    }
    renderModelRows();

    if (p.kind === 'vscode-lm') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '复用 GitHub Copilot 订阅，无需 API Key。模型有硬性输入配额，装配器会自动收紧预算。';
      card.appendChild(hint);
    } else {
      const keyRow = document.createElement('div');
      keyRow.className = 'key-row';
      const status = document.createElement('span');
      status.className = 'key-status';
      const has = !!draft.keys[p.id];
      status.textContent = has ? '✓ 已保存 API Key' : '未设置 API Key';
      status.classList.toggle('set', has);
      keyRow.appendChild(status);
      keyRow.appendChild(
        secondaryBtn('设置 Key', () => vscode.postMessage({ type: 'setApiKey', providerId: p.id }))
      );
      keyRow.appendChild(
        secondaryBtn('清除', () => vscode.postMessage({ type: 'clearApiKey', providerId: p.id }))
      );
      card.appendChild(keyRow);
    }

    return card;
  }

  function buildModelRow(p, m, rerender) {
    const row = document.createElement('div');
    row.className = 'model-row';

    const ref = document.createElement('code');
    ref.className = 'model-ref';
    const updateRef = () => {
      ref.textContent = m.name ? `${p.id}/${m.name}` : `${p.id}/…`;
    };
    updateRef();

    row.appendChild(
      compactField('模型名', m.name, p.kind === 'vscode-lm' ? 'gpt-4o' : 'glm-4-plus', (v) => {
        m.name = v.trim();
        touch();
        updateRef();
      })
    );
    row.appendChild(
      compactField('显示名', m.label || '', '可留空', (v) => {
        m.label = v.trim() || undefined;
        touch();
      })
    );
    row.appendChild(
      compactNumber('窗口', m.contextWindow, '默认', (v) => {
        m.contextWindow = v;
        touch();
      })
    );
    row.appendChild(
      compactNumber('输出上限', m.maxOutputTokens, '默认', (v) => {
        m.maxOutputTokens = v;
        touch();
      })
    );

    const tail = document.createElement('div');
    tail.className = 'model-tail';
    tail.appendChild(ref);
    tail.appendChild(
      linkBtn('测试', () => {
        if (!m.name) {
          toast('先填模型名。', true);
          return;
        }
        if (draft.dirty) {
          toast('测试用的是已保存的配置，刚改的内容请先保存。');
        }
        vscode.postMessage({ type: 'testConnection', ref: `${p.id}/${m.name}` });
      })
    );
    tail.appendChild(
      linkBtn('删除', () => {
        p.models = p.models.filter((x) => x !== m);
        touch();
        rerender();
      })
    );
    row.appendChild(tail);
    return row;
  }

  function textField(label, value, placeholder, onInput) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    wrap.appendChild(input);
    return wrap;
  }

  function compactField(label, value, placeholder, onInput) {
    const wrap = textField(label, value, placeholder, onInput);
    wrap.classList.add('compact');
    return wrap;
  }

  function compactNumber(label, value, placeholder, onInput) {
    const wrap = document.createElement('label');
    wrap.className = 'field compact';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1000';
    input.value = value === undefined || value === null ? '' : String(value);
    input.placeholder = placeholder;
    input.addEventListener('input', () => {
      const n = Number(input.value);
      onInput(input.value.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function secondaryBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /** 生成一个不与现有服务商冲突的 id。 */
  function uniqueId(base) {
    if (!draft.providers.some((p) => p.id === base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}${i}`;
      if (!draft.providers.some((p) => p.id === candidate)) return candidate;
    }
  }

  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.textContent = preset.label;
    btn.title = preset.baseUrl || KIND_LABEL[preset.kind];
    btn.addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(preset));
      copy.id = uniqueId(preset.id);
      draft.providers.push(copy);
      touch();
      renderProviders();
      toast(`已添加「${copy.label}」，模型引用前缀为 ${copy.id}/，记得保存。`);
    });
    el.presets.appendChild(btn);
  }

  el.addProviderBtn.addEventListener('click', () => {
    draft.providers.push({
      id: uniqueId('provider'),
      kind: 'openai',
      baseUrl: '',
      models: [{ name: '' }],
    });
    touch();
    renderProviders();
  });

  for (const id of Object.values(BUDGET_FIELDS)) {
    const node = $(id);
    if (node) node.addEventListener('input', touch);
  }

  $('saveSettingsBtn').addEventListener('click', () => {
    const settings = { providers: draft.providers, model: draft.model };
    for (const [key, id] of Object.entries(BUDGET_FIELDS)) {
      settings[key] = Number($(id).value);
    }
    if (!Number.isFinite(settings.contextWindow) || settings.contextWindow < 4000) {
      toast('上下文窗口至少 4000。', true);
      return;
    }
    if (settings.maxOutputTokens >= settings.contextWindow) {
      toast('最大输出 token 必须小于上下文窗口，否则装配器没有可用预算。', true);
      return;
    }

    const problem = validateProviders(draft.providers);
    if (problem) {
      toast(problem, true);
      return;
    }

    // 当前选中的模型如果已经被删掉了，退回第一个可用的，
    // 而不是保存一个指向空气的引用。
    const refs = draft.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m.name}`));
    if (!refs.includes(settings.model)) {
      settings.model = refs[0] || '';
    }
    vscode.postMessage({ type: 'saveSettings', settings });
  });

  /** 保存前挡住会让引用无法解析的配置。返回错误信息，没问题返回空。 */
  function validateProviders(providers) {
    const ids = new Set();
    for (const p of providers) {
      const id = (p.id || '').trim();
      if (!id) return '服务商的前缀 id 不能为空。';
      if (id.includes('/')) return `前缀「${id}」不能含斜杠，否则模型引用无法切分。`;
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return `前缀「${id}」只能用字母、数字、点、下划线和连字符。`;
      if (ids.has(id)) return `前缀「${id}」重复了，每个服务商的前缀必须唯一。`;
      ids.add(id);

      if (p.models.length === 0) return `服务商「${id}」下没有模型。`;
      const names = new Set();
      for (const m of p.models) {
        const name = (m.name || '').trim();
        if (!name) return `服务商「${id}」下有模型名为空。`;
        if (names.has(name)) return `服务商「${id}」下的模型「${name}」重复了。`;
        names.add(name);
        if (m.contextWindow && m.maxOutputTokens && m.maxOutputTokens >= m.contextWindow) {
          return `${id}/${name} 的输出上限必须小于它的窗口。`;
        }
      }
    }
    return '';
  }

  $('nativeSettingsBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );

  // ---------------------------------------------------------------- 消息

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
      case 'state':
        renderState(msg.state);
        break;
      case 'tab':
        showTab(msg.tab);
        break;
      case 'session':
        renderSession(msg.session);
        break;
      case 'sessions':
        renderSessions(msg.list);
        break;
      case 'attachments':
        store.attachments = msg.items;
        renderChips();
        break;
      case 'delta': {
        store.streamingId = msg.turnId;
        const node = el.messages.querySelector(`[data-turn="${msg.turnId}"]`);
        if (node) {
          node.classList.add('streaming');
          const body = node.querySelector('.msg-body');
          if (body) body.textContent += msg.text;
          scrollToBottom();
        }
        break;
      }
      case 'turnDone':
        store.streamingId = null;
        upsertTurn(msg.turn);
        break;
      case 'context': {
        const node = el.messages.querySelector(`[data-turn="${msg.turnId}"]`);
        if (node && !node.querySelector('details.ctx')) {
          node.insertBefore(buildContextDetails(msg.digest), node.querySelector('.msg-actions'));
        }
        break;
      }
      case 'busy':
        setBusy(msg.value);
        break;
      case 'settings':
        renderSettings(msg.settings, msg.keys, msg.ack);
        break;
      case 'toast':
        toast(msg.message, msg.level === 'error');
        break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
