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
    modeSelect: $('modeSelect'),
    targetSelect: $('targetSelect'),
    targetWords: $('targetWords'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    providerMeta: $('providerMeta'),
    historyMeta: $('historyMeta'),
    sessionList: $('sessionList'),
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

    if (!state.initialized) {
      el.providerMeta.textContent = '当前工作区还不是小说工程，先运行「Novel: 初始化小说工程」。';
      el.sendBtn.disabled = true;
      return;
    }
    el.sendBtn.disabled = store.busy;
    el.providerMeta.textContent = `${state.providerLabel} · 窗口 ${fmt(state.contextWindow)} / 输出 ${fmt(
      state.maxOutputTokens
    )}`;

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

  const SETTING_FIELDS = {
    provider: 'setProvider',
    openaiBaseUrl: 'setOpenaiBaseUrl',
    openaiModel: 'setOpenaiModel',
    anthropicBaseUrl: 'setAnthropicBaseUrl',
    anthropicModel: 'setAnthropicModel',
    vscodeLmFamily: 'setVscodeLmFamily',
    contextWindow: 'setContextWindow',
    maxOutputTokens: 'setMaxOutputTokens',
    temperature: 'setTemperature',
    recentChaptersFullText: 'setRecentChaptersFullText',
    prevChapterTailChars: 'setPrevChapterTailChars',
    summaryBatchSize: 'setSummaryBatchSize',
    requestTimeoutMs: 'setRequestTimeoutMs',
  };

  const NUMERIC = new Set([
    'contextWindow',
    'maxOutputTokens',
    'temperature',
    'recentChaptersFullText',
    'prevChapterTailChars',
    'summaryBatchSize',
    'requestTimeoutMs',
  ]);

  // 常见 OpenAI 兼容服务，省得手敲 baseUrl。窗口大小按各家公开文档填。
  const PRESETS = [
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', window: 128000 },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', window: 64000 },
    { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', window: 128000 },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', window: 32000 },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', window: 128000 },
    { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', window: 32000 },
  ];

  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.textContent = p.name;
    btn.title = `${p.baseUrl} · ${p.model}`;
    btn.addEventListener('click', () => {
      $('setOpenaiBaseUrl').value = p.baseUrl;
      $('setOpenaiModel').value = p.model;
      $('setContextWindow').value = String(p.window);
      toast(`已填入 ${p.name} 的默认参数，记得保存。`);
    });
    el.presets.appendChild(btn);
  }

  function renderSettings(settings, keys) {
    for (const [key, id] of Object.entries(SETTING_FIELDS)) {
      const node = $(id);
      if (node) node.value = String(settings[key]);
    }
    updateProviderBlocks(settings.provider);

    const mark = (node, has, label) => {
      node.textContent = has ? `✓ 已保存 ${label} 的 Key` : `未设置 ${label} 的 Key`;
      node.classList.toggle('set', has);
    };
    mark($('openaiKeyStatus'), keys.openai, 'OpenAI 兼容接口');
    mark($('anthropicKeyStatus'), keys.anthropic, 'Anthropic');
  }

  function updateProviderBlocks(provider) {
    for (const id of ['openai', 'anthropic', 'vscode-lm']) {
      $(`block-${id}`).classList.toggle('hidden', id !== provider);
    }
  }

  $('setProvider').addEventListener('change', (e) => updateProviderBlocks(e.target.value));

  $('saveSettingsBtn').addEventListener('click', () => {
    const settings = {};
    for (const [key, id] of Object.entries(SETTING_FIELDS)) {
      const raw = $(id).value;
      settings[key] = NUMERIC.has(key) ? Number(raw) : raw;
    }
    if (!Number.isFinite(settings.contextWindow) || settings.contextWindow < 4000) {
      toast('上下文窗口至少 4000。', true);
      return;
    }
    if (settings.maxOutputTokens >= settings.contextWindow) {
      toast('最大输出 token 必须小于上下文窗口，否则装配器没有可用预算。', true);
      return;
    }
    vscode.postMessage({ type: 'saveSettings', settings });
  });

  $('testConnBtn').addEventListener('click', () => vscode.postMessage({ type: 'testConnection' }));
  $('nativeSettingsBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );
  $('setOpenaiKey').addEventListener('click', () =>
    vscode.postMessage({ type: 'setApiKey', provider: 'openai' })
  );
  $('clearOpenaiKey').addEventListener('click', () =>
    vscode.postMessage({ type: 'clearApiKey', provider: 'openai' })
  );
  $('setAnthropicKey').addEventListener('click', () =>
    vscode.postMessage({ type: 'setApiKey', provider: 'anthropic' })
  );
  $('clearAnthropicKey').addEventListener('click', () =>
    vscode.postMessage({ type: 'clearApiKey', provider: 'anthropic' })
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
        renderSettings(msg.settings, msg.keys);
        break;
      case 'toast':
        toast(msg.message, msg.level === 'error');
        break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
