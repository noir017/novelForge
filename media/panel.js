// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const el = {
    providerMeta: $('providerMeta'),
    staleBanner: $('staleBanner'),
    staleText: $('staleText'),
    syncBtn: $('syncBtn'),
    targetSelect: $('targetSelect'),
    targetWords: $('targetWords'),
    titleField: $('titleField'),
    newTitle: $('newTitle'),
    outline: $('outline'),
    extra: $('extra'),
    previewBtn: $('previewBtn'),
    generateBtn: $('generateBtn'),
    stopBtn: $('stopBtn'),
    budgetMeta: $('budgetMeta'),
    itemList: $('itemList'),
    draft: $('draft'),
    draftMeta: $('draftMeta'),
    acceptBtn: $('acceptBtn'),
    rewriteBtn: $('rewriteBtn'),
    discardBtn: $('discardBtn'),
    feedbackField: $('feedbackField'),
    feedback: $('feedback'),
    doRewriteBtn: $('doRewriteBtn'),
    cancelRewriteBtn: $('cancelRewriteBtn'),
    prevVer: $('prevVer'),
    nextVer: $('nextVer'),
    verLabel: $('verLabel'),
    toast: $('toast'),
  };

  /** @type {{excluded: Set<string>, state: any, versions: string[], current: number, busy: boolean}} */
  const store = {
    excluded: new Set(),
    state: null,
    versions: [],
    current: -1,
    busy: false,
  };

  // 恢复上次填写的内容（面板被隐藏再显示时不丢草稿）。
  const saved = vscode.getState();
  if (saved) {
    el.outline.value = saved.outline || '';
    el.extra.value = saved.extra || '';
    if (saved.targetWords) el.targetWords.value = saved.targetWords;
    store.versions = saved.versions || [];
    store.current = store.versions.length - 1;
    if (store.current >= 0) {
      el.draft.value = store.versions[store.current];
    }
  }

  function persist() {
    vscode.setState({
      outline: el.outline.value,
      extra: el.extra.value,
      targetWords: el.targetWords.value,
      versions: store.versions,
    });
  }

  function payload() {
    const targetOrder = Number(el.targetSelect.value);
    return {
      outline: el.outline.value,
      targetOrder,
      targetWords: Number(el.targetWords.value) || 0,
      extraInstruction: el.extra.value,
      excludedIds: [...store.excluded],
    };
  }

  function isNewChapter() {
    const opt = el.targetSelect.selectedOptions[0];
    return opt && opt.dataset.mode === 'new';
  }

  function updateTitleField() {
    el.titleField.classList.toggle('hidden', !isNewChapter());
  }

  function setBusy(value) {
    store.busy = value;
    el.generateBtn.classList.toggle('hidden', value);
    el.stopBtn.classList.toggle('hidden', !value);
    el.previewBtn.disabled = value;
    el.doRewriteBtn.disabled = value;
  }

  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', !!isError);
    el.toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.toast.classList.add('hidden'), isError ? 8000 : 3500);
  }

  function countWords(text) {
    return text.replace(/\s/g, '').length;
  }

  function refreshDraftUi() {
    const has = el.draft.value.trim().length > 0;
    el.acceptBtn.disabled = !has || store.busy;
    el.rewriteBtn.disabled = !has || store.busy;
    el.discardBtn.disabled = !has || store.busy;
    el.draftMeta.textContent = has ? `${countWords(el.draft.value)} 字` : '';

    const multi = store.versions.length > 1;
    el.prevVer.classList.toggle('hidden', !multi);
    el.nextVer.classList.toggle('hidden', !multi);
    el.verLabel.textContent = multi ? `第 ${store.current + 1}/${store.versions.length} 版` : '';
    el.prevVer.disabled = store.current <= 0;
    el.nextVer.disabled = store.current >= store.versions.length - 1;
  }

  function showVersion(index) {
    if (index < 0 || index >= store.versions.length) return;
    store.current = index;
    el.draft.value = store.versions[index];
    refreshDraftUi();
  }

  // ---------------------------------------------------------------- 渲染

  function renderState(state) {
    store.state = state;
    el.providerMeta.textContent = `${state.providerLabel} · 窗口 ${fmt(state.contextWindow)} / 输出 ${fmt(
      state.maxOutputTokens
    )}`;

    const prevValue = el.targetSelect.value;
    el.targetSelect.innerHTML = '';

    const newOpt = document.createElement('option');
    newOpt.value = String(state.nextOrder);
    newOpt.textContent = `新建第 ${state.nextOrder} 章`;
    newOpt.dataset.mode = 'new';
    el.targetSelect.appendChild(newOpt);

    for (const c of [...state.chapters].reverse()) {
      const opt = document.createElement('option');
      opt.value = String(c.order);
      opt.textContent = `追加到第 ${c.order} 章《${c.title}》（${c.wordCount} 字）`;
      opt.dataset.mode = 'append';
      el.targetSelect.appendChild(opt);
    }

    const want = prevValue || String(state.defaultTargetOrder);
    el.targetSelect.value = [...el.targetSelect.options].some((o) => o.value === want)
      ? want
      : String(state.nextOrder);
    updateTitleField();

    if (state.staleCount > 0) {
      el.staleText.textContent = `有 ${state.staleCount} 章摘要缺失或已过期，这些章节的剧情不会进入上下文。`;
      el.staleBanner.classList.remove('hidden');
    } else {
      el.staleBanner.classList.add('hidden');
    }
  }

  function renderContext(msg) {
    el.itemList.innerHTML = '';
    const over = msg.usedTokens > msg.budget;
    el.budgetMeta.textContent = `${fmt(msg.usedTokens)} / ${fmt(msg.budget)} token${
      msg.clamped ? '（已按模型配额压缩）' : ''
    }`;
    el.budgetMeta.classList.toggle('over-budget', over);

    for (const item of msg.items) {
      const li = document.createElement('li');
      li.className = `${item.status} p${item.priority}`;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.status !== 'excluded';
      box.disabled = item.priority === 0;
      box.title = item.priority === 0 ? '必需项，不可排除' : '取消勾选可临时排除该项';
      box.addEventListener('change', () => {
        if (box.checked) store.excluded.delete(item.id);
        else store.excluded.add(item.id);
        vscode.postMessage({ type: 'preview', payload: payload() });
      });
      li.appendChild(box);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `P${item.priority}`;
      li.appendChild(badge);

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;
      li.appendChild(label);

      if (item.source) {
        const link = document.createElement('span');
        link.className = 'source-link';
        link.textContent = '打开';
        link.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: item.source }));
        li.appendChild(link);
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

      el.itemList.appendChild(li);
    }
  }

  function fmt(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  // ---------------------------------------------------------------- 事件

  el.targetSelect.addEventListener('change', updateTitleField);
  el.outline.addEventListener('input', persist);
  el.extra.addEventListener('input', persist);
  el.targetWords.addEventListener('input', persist);
  el.draft.addEventListener('input', () => {
    if (store.current >= 0) store.versions[store.current] = el.draft.value;
    refreshDraftUi();
    persist();
  });

  el.previewBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'preview', payload: payload() });
  });

  el.generateBtn.addEventListener('click', () => {
    if (!el.outline.value.trim()) {
      toast('请先填写剧情纲要。', true);
      el.outline.focus();
      return;
    }
    el.draft.value = '';
    setBusy(true);
    refreshDraftUi();
    vscode.postMessage({ type: 'generate', payload: payload() });
  });

  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  el.acceptBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'accept',
      draft: el.draft.value,
      mode: isNewChapter() ? 'new' : 'append',
      order: Number(el.targetSelect.value),
      title: el.newTitle.value,
    });
  });

  el.rewriteBtn.addEventListener('click', () => {
    el.feedbackField.classList.remove('hidden');
    el.feedback.focus();
  });

  el.cancelRewriteBtn.addEventListener('click', () => {
    el.feedbackField.classList.add('hidden');
  });

  el.doRewriteBtn.addEventListener('click', () => {
    const feedback = el.feedback.value.trim();
    if (!feedback) {
      toast('请填写修改意见。', true);
      return;
    }
    const previousDraft = el.draft.value;
    el.feedbackField.classList.add('hidden');
    el.draft.value = '';
    setBusy(true);
    refreshDraftUi();
    vscode.postMessage({
      type: 'generate',
      payload: { ...payload(), revisionFeedback: feedback, previousDraft },
    });
  });

  el.discardBtn.addEventListener('click', () => {
    if (store.current >= 0) {
      store.versions.splice(store.current, 1);
      store.current = Math.min(store.current, store.versions.length - 1);
    }
    el.draft.value = store.current >= 0 ? store.versions[store.current] : '';
    refreshDraftUi();
    persist();
  });

  el.prevVer.addEventListener('click', () => showVersion(store.current - 1));
  el.nextVer.addEventListener('click', () => showVersion(store.current + 1));
  el.syncBtn.addEventListener('click', () => vscode.postMessage({ type: 'syncSummaries' }));

  // ---------------------------------------------------------------- 消息

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
      case 'state':
        renderState(msg.state);
        break;
      case 'context':
        renderContext(msg);
        break;
      case 'delta':
        el.draft.value += msg.text;
        el.draft.scrollTop = el.draft.scrollHeight;
        el.draftMeta.textContent = `${countWords(el.draft.value)} 字 · 生成中`;
        break;
      case 'done':
        el.draft.value = msg.text;
        store.versions.push(msg.text);
        store.current = store.versions.length - 1;
        setBusy(false);
        refreshDraftUi();
        persist();
        toast('生成完成，可直接编辑后采纳。');
        break;
      case 'cancelled':
        setBusy(false);
        if (el.draft.value.trim()) {
          store.versions.push(el.draft.value);
          store.current = store.versions.length - 1;
        }
        refreshDraftUi();
        toast('已停止生成，已生成的部分保留在下方。');
        break;
      case 'error':
        setBusy(false);
        refreshDraftUi();
        toast(msg.message, true);
        break;
      case 'busy':
        setBusy(msg.value);
        refreshDraftUi();
        break;
      case 'accepted':
        toast(`已写入 ${msg.path}`);
        store.versions = [];
        store.current = -1;
        el.draft.value = '';
        el.outline.value = '';
        el.newTitle.value = '';
        refreshDraftUi();
        persist();
        break;
    }
  });

  refreshDraftUi();
  vscode.postMessage({ type: 'ready' });
})();
