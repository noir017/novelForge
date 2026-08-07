// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    tabbar: $('tabbar'),
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
    projectToolbar: $('projectToolbar'),
    projectBody: $('projectBody'),
    taskList: $('taskList'),
    historyMeta: $('historyMeta'),
    sessionList: $('sessionList'),
    logBody: $('logBody'),
    logLevel: $('logLevel'),
    logFilter: $('logFilter'),
    logFollow: $('logFollow'),
    logMeta: $('logMeta'),
    logCopyBtn: $('logCopyBtn'),
    logClearBtn: $('logClearBtn'),
    providerList: $('providerList'),
    providerCount: $('providerCount'),
    providerModal: $('providerModal'),
    providerModalTitle: $('providerModalTitle'),
    providerModalBody: $('providerModalBody'),
    providerModalClose: $('providerModalClose'),
    addProviderBtn: $('addProviderBtn'),
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

  // 独立版的 editor.js 复用同一个 toast，避免两套提示条互相盖住。
  window.__nfToast = toast;

  /**
   * 「打开某个文件」。独立版有内置编辑器，走 openEditor 在右侧开标签页；
   * 插件里没有这块 DOM，仍走 openFile 开 VS Code 的编辑器 tab。
   */
  const hasBuiltInEditor = !!document.getElementById('wbEditor');
  function openPath(path) {
    if (!path) return;
    vscode.postMessage({ type: hasBuiltInEditor ? 'openEditor' : 'openFile', path });
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
    if (tab === 'logs') {
      // 看过了就把红点收掉。
      unseenErrors = 0;
      syncLogsDot();
    }
  }

  el.tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    showTab(btn.dataset.tab);
    vscode.postMessage({ type: 'switchTab', tab: btn.dataset.tab });
  });

  // ---------------------------------------------------------------- 状态

  // 独立版的环境差异只应用一次（隐藏 VS Code 专属入口、改存储提示文案）。
  let standaloneApplied = false;

  function renderState(state) {
    store.state = state;
    if (state.standalone && !standaloneApplied) {
      standaloneApplied = true;
      $('nativeSettingsBtn').classList.add('hidden');
      const hint = $('settingsStorageHint');
      if (hint) {
        hint.textContent = '设置写入 ~/.novelforge/config.json；API Key 存在 ~/.novelforge/secrets.json。';
      }
    }
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
    // 独立版的活动栏上给「工程」挂一个小圆点，切走了也看得见待办。
    const dot = $('projectStaleDot');
    if (dot) dot.classList.toggle('hidden', state.staleCount === 0);
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
    // 低频且有破坏性的操作（重新生成/删除）收进右上角的 ...，
    // 不和「采纳写入」「复制」挤在一起。
    head.appendChild(document.createElement('span')).className = 'spacer';
    head.appendChild(buildMenuBtn(turn));
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
            openPath(att.relPath)
          );
        }
        box.appendChild(chip);
      }
      wrap.appendChild(box);
    }

    // 思考过程放在正文上方，默认折叠——它不是正文，但正文迟迟不来时
    // 它是唯一的进度反馈。用户展开后的状态由 details 自己维持。
    if (turn.reasoning) {
      wrap.appendChild(buildReasoningDetails(turn.reasoning));
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = turn.error ? turn.error : turn.content;
    // 生成中不允许改：contentEditable 的光标会被后续 delta 追加冲掉，
    // 用户改到一半的内容也会被 turnDone 的整体重建覆盖。
    // 结束后（turnDone 会重建这个节点）才放开就地编辑。
    const streaming = store.streamingId === turn.id;
    if (turn.role === 'assistant' && !turn.error && !streaming) {
      // 结果可以就地改完再采纳。
      body.setAttribute('contenteditable', 'true');
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
          linkBtn('打开', () => openPath(turn.acceptedTo))
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

    return bar;
  }

  // ---------------------------------------------------------------- 菜单

  /**
   * 一套菜单引擎，两个入口：气泡右上角的 ⋯ 按钮（贴着按钮定位），
   * 以及任意位置的右键（跟着光标定位）。
   *
   * 菜单项是 `{ label, run, danger, disabled }`；`{ sep: true }` 是分隔线。
   */

  /** 当前打开的菜单（同时只允许一个）。 */
  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    if (openMenu.btn) openMenu.btn.classList.remove('active');
    openMenu = null;
  }

  /** 由菜单项数组建出菜单 DOM。两个入口共用，差别只在挂到哪儿、怎么定位。 */
  function buildMenuElement(items, className) {
    const menu = document.createElement('div');
    menu.className = className;
    for (const item of items) {
      if (item.sep) {
        // 首尾的分隔线没有意义（构建方按需拼接，这里兜一下）。
        if (menu.lastElementChild && !menu.lastElementChild.classList.contains('menu-sep')) {
          const hr = document.createElement('div');
          hr.className = 'menu-sep';
          menu.appendChild(hr);
        }
        continue;
      }
      const b = document.createElement('button');
      b.textContent = item.label;
      if (item.danger) b.classList.add('danger');
      if (item.disabled) b.disabled = true;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (item.disabled) return;
        closeMenu();
        item.run();
      });
      menu.appendChild(b);
    }
    // 拼完后可能落下一条尾部分隔线。
    const tail = menu.lastElementChild;
    if (tail && tail.classList.contains('menu-sep')) tail.remove();
    return menu;
  }

  /**
   * 在视口坐标 (x, y) 处弹出菜单。挂在 body 上、position: fixed——
   * 右键可能发生在任何容器里（含内部滚动的工程页），跟着容器走会被裁掉。
   * 贴近右边缘/下边缘时向左/向上翻转，不让菜单掉出屏幕。
   */
  function showContextMenu(items, x, y) {
    closeMenu();
    if (items.length === 0) return;

    const menu = buildMenuElement(items, 'ctx-menu');
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);
    openMenu = { btn: null, menu };

    // jsdom 里 offsetWidth 恒为 0，翻转逻辑自动退化为「贴光标」，不影响断言。
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const left = w > 0 && x + w > vw ? Math.max(0, x - w) : x;
    const top = h > 0 && y + h > vh ? Math.max(0, y - h) : y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  /**
   * 「这个元素上右键给什么菜单」的登记表。
   *
   * 用 WeakMap 而不是在右键时按 relPath 反查 `lastTree`：菜单项在构建那一行时
   * 就已经知道全部上下文（节点、所属区、落点目录），反查得把这些再拼一遍。
   * 行被重渲染丢弃后条目自动回收。
   */
  const menuProviders = new WeakMap();

  /** 给一个元素登记右键菜单。`provide` 返回菜单项数组，右键那一刻才调用。 */
  function onContextMenu(node, provide) {
    menuProviders.set(node, provide);
    return node;
  }

  // 独立版的 explorer.js 复用同一套菜单引擎：全局 contextmenu 监听在这里，
  // 另起一套只会两层菜单一起弹。
  window.__nfContextMenu = onContextMenu;

  /** 从事件目标往上找第一个登记过菜单的祖先。 */
  function resolveMenuItems(target) {
    for (let node = target; node && node !== document; node = node.parentElement) {
      const provide = menuProviders.get(node);
      if (provide) return provide();
    }
    return null;
  }

  /** 所有页面都有的兜底菜单：一个刷新。 */
  function baseMenuItems() {
    return [{ label: '刷新', run: () => projectAction('refresh') }];
  }

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 在已弹出的菜单上右键：收起就好，不要再叠一层兜底菜单。
    if (openMenu && openMenu.menu.contains(e.target)) {
      closeMenu();
      return;
    }
    const items = resolveMenuItems(e.target) || baseMenuItems();
    // 键盘的「菜单键」触发时 clientX/Y 为 0，改用目标元素的位置，
    // 否则菜单会跑到屏幕左上角。
    let { clientX: x, clientY: y } = e;
    if (!x && !y && e.target && e.target.getBoundingClientRect) {
      const rect = e.target.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom;
    }
    showContextMenu(items, x, y);
  });

  // ------------------------------------------------- 气泡右上角的 ... 菜单

  /** 这条消息在 ... 菜单里能做什么。 */
  function menuItemsFor(turn) {
    const items = [];
    // 「重新生成」只对用户消息有意义：重来是从那一条分叉，
    // 丢掉它之后的所有轮次再跑一遍。
    if (turn.role === 'user') {
      items.push({
        label: '重新生成',
        run: () => {
          if (store.busy) {
            toast('正在生成，请先停止。', true);
            return;
          }
          vscode.postMessage({ type: 'retry', turnId: turn.id, payload: payload() });
        },
      });
    }
    items.push({
      label: '删除',
      danger: true,
      run: () => vscode.postMessage({ type: 'deleteTurn', turnId: turn.id }),
    });
    return items;
  }

  function buildMenuBtn(turn) {
    const btn = document.createElement('button');
    btn.className = 'msg-menu-btn';
    btn.textContent = '⋯';
    btn.title = '更多操作';
    btn.setAttribute('aria-label', '更多操作');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 再点一次同一个按钮就是收起。
      if (openMenu && openMenu.btn === btn) {
        closeMenu();
        return;
      }
      closeMenu();

      // 菜单挂在按钮的容器里，用绝对定位贴住右上角——
      // 挂到 body 上就得手算坐标，还要跟着 .messages 滚动。
      const menu = buildMenuElement(menuItemsFor(turn), 'msg-menu');
      btn.parentElement.appendChild(menu);
      btn.classList.add('active');
      openMenu = { btn, menu };
    });
    return btn;
  }

  // 点别处、按 Esc 都要收起菜单。
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  // 右键菜单是 fixed 定位的，内容一滚它就和目标行脱节了，收起来。
  // 只收右键菜单：⋯ 菜单挂在气泡里会跟着滚，而且流式输出每来一段
  // 都会 scrollToBottom()，一起收会让它刚点开就消失。捕获阶段才收得到
  // 内部容器（.messages / .project-body）的滚动。
  document.addEventListener(
    'scroll',
    () => {
      if (openMenu && !openMenu.btn) closeMenu();
    },
    true
  );

  function linkBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * 思考过程的折叠块。
   *
   * 推理模型（gemma/gemini thinking、DeepSeek reasoner 等）可能先想几十秒
   * 才开始吐正文。这段内容不是正文——采纳写入时不会带上它——但把它显示
   * 出来，用户才知道模型在动，而不是界面卡住了。
   */
  function buildReasoningDetails(text) {
    const det = document.createElement('details');
    det.className = 'reasoning';

    const sum = document.createElement('summary');
    sum.textContent = `思考过程 · ${countWords(text)} 字`;
    det.appendChild(sum);

    const pre = document.createElement('div');
    pre.className = 'reasoning-body';
    pre.textContent = text;
    det.appendChild(pre);
    return det;
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
          linkBtn('打开', () => openPath(item.source))
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

  // ---------------------------------------------------------------- 长任务

  /**
   * 正在跑的长任务。后端每次进度变化都全量重推 `tasks`，这里整块重画——
   * 列表最多两三项，增量更新换来的那点开销不值得多维护一份状态。
   *
   * 秒数由前端自己走：后端只在有进度时才推，一次模型调用能安静一分钟，
   * 那期间计时器停住会让人以为卡死了。
   */
  let tasks = [];
  let taskTimer = null;

  function renderTasks(list) {
    tasks = list || [];
    el.taskList.innerHTML = '';
    el.taskList.classList.toggle('hidden', tasks.length === 0);

    if (tasks.length === 0) {
      if (taskTimer) {
        clearInterval(taskTimer);
        taskTimer = null;
      }
      return;
    }
    // 每项各自记住「收到快照时的本地时刻」，好在两次推送之间自己走秒。
    const now = Date.now();
    for (const t of tasks) {
      t._baseAt = now - (t.elapsedMs || 0);
      el.taskList.appendChild(buildTaskRow(t));
    }
    if (!taskTimer) {
      taskTimer = setInterval(tickTasks, 1000);
    }
  }

  function buildTaskRow(t) {
    const box = document.createElement('div');
    box.className = 'task';
    box.dataset.task = t.id;

    const head = document.createElement('div');
    head.className = 'task-head';

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = t.title;
    head.appendChild(title);

    const counter = document.createElement('span');
    counter.className = 'meta task-counter';
    counter.textContent = taskCounterText(t);
    head.appendChild(counter);

    head.appendChild(document.createElement('span')).className = 'spacer';

    const time = document.createElement('span');
    time.className = 'meta task-time';
    time.textContent = durationText(t.elapsedMs || 0);
    head.appendChild(time);

    head.appendChild(
      linkBtn('停止', () => vscode.postMessage({ type: 'cancelTask', id: t.id }))
    );
    box.appendChild(head);

    // 有 total 才画进度条；只有一句文案的任务（单章总结的准备阶段）留空。
    const bar = document.createElement('div');
    bar.className = 'task-bar';
    const fill = document.createElement('div');
    fill.className = 'task-fill';
    if (t.total > 0) {
      fill.style.width = `${Math.min(100, Math.round(((t.current || 0) / t.total) * 100))}%`;
    } else {
      // 不知道总量时走一条来回扫的条，至少表明还活着。
      bar.classList.add('indeterminate');
      fill.style.width = '35%';
    }
    bar.appendChild(fill);
    box.appendChild(bar);

    const msg = document.createElement('div');
    msg.className = 'task-msg';
    msg.textContent = t.message || '';
    box.appendChild(msg);
    return box;
  }

  function taskCounterText(t) {
    if (!(t.total > 0)) return '';
    const current = Math.min(t.current || 0, t.total);
    const percent = Math.round((current / t.total) * 100);
    return `${current}/${t.total} · ${percent}%`;
  }

  /** 每秒只改计时文本，不重建 DOM——重建会打断「停止」按钮上的点击。 */
  function tickTasks() {
    for (const t of tasks) {
      const row = el.taskList.querySelector(`[data-task="${t.id}"] .task-time`);
      if (row) row.textContent = durationText(Date.now() - t._baseAt);
    }
  }

  function durationText(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    return m > 0 ? `${m}:${String(total % 60).padStart(2, '0')}` : `${total}s`;
  }

  // ---------------------------------------------------------------- 日志

  const LOG_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
  const LOG_LABEL = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
  /** 全量缓冲的前端副本；筛选纯在本地做，不往后端要。 */
  let logs = [];
  /** 只在日志页之外累计，切过去就清零——徽标是「有没有没看过的错」。 */
  let unseenErrors = 0;

  function logLevelValue() {
    return LOG_ORDER[el.logLevel.value] || LOG_ORDER.info;
  }

  function logMatches(entry) {
    if ((LOG_ORDER[entry.level] || 0) < logLevelValue()) return false;
    const needle = el.logFilter.value.trim().toLowerCase();
    if (!needle) return true;
    return `${entry.scope} ${entry.message} ${entry.detail || ''}`.toLowerCase().includes(needle);
  }

  function renderLogs(entries) {
    logs = entries || [];
    el.logBody.innerHTML = '';
    const shown = logs.filter(logMatches);
    for (const entry of shown) el.logBody.appendChild(buildLogRow(entry));
    updateLogMeta(shown.length);
    if (el.logFollow.checked) el.logBody.scrollTop = el.logBody.scrollHeight;
  }

  /** 增量追加一条。不重画整表——长任务每秒好几条，重画会让滚动位置乱跳。 */
  function appendLog(entry) {
    logs.push(entry);
    // 与后端 MAX_ENTRIES 同量级，避免网页开一整天后攒下几万个节点。
    if (logs.length > 800) logs.splice(0, logs.length - 800);

    if (entry.level === 'error' && !isTabActive('logs')) {
      unseenErrors++;
      syncLogsDot();
    }
    if (!logMatches(entry)) return;

    // 只在原本就贴着底时才跟着滚：用户翻上去看东西时不该被拽回来。
    const atBottom =
      el.logBody.scrollHeight - el.logBody.scrollTop - el.logBody.clientHeight < 40;
    el.logBody.appendChild(buildLogRow(entry));
    while (el.logBody.childElementCount > 800) el.logBody.removeChild(el.logBody.firstChild);
    updateLogMeta(el.logBody.childElementCount);
    if (el.logFollow.checked && atBottom) el.logBody.scrollTop = el.logBody.scrollHeight;
  }

  function buildLogRow(entry) {
    const row = document.createElement('div');
    row.className = `log-row log-${entry.level}`;

    const head = document.createElement('div');
    head.className = 'log-head';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = logTime(entry.at);
    head.appendChild(time);

    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = LOG_LABEL[entry.level] || entry.level;
    head.appendChild(level);

    const scope = document.createElement('span');
    scope.className = 'log-scope';
    scope.textContent = entry.scope;
    head.appendChild(scope);

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.message;
    head.appendChild(msg);
    row.appendChild(head);

    if (entry.detail) {
      // detail 默认收起：一次同步几十条，摊开就没法扫了。
      const det = document.createElement('details');
      det.className = 'log-detail';
      const sum = document.createElement('summary');
      sum.textContent = '详情';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = entry.detail;
      det.appendChild(pre);
      row.appendChild(det);
    }
    return row;
  }

  function logTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function updateLogMeta(shown) {
    el.logMeta.textContent =
      shown === logs.length ? `${logs.length} 条` : `${shown} / ${logs.length} 条`;
  }

  /** 独立版活动栏上的红点：有没看过的错误就亮着。插件里没这个节点。 */
  function syncLogsDot() {
    const dot = $('logsErrorDot');
    if (dot) dot.classList.toggle('hidden', unseenErrors === 0);
  }

  function isTabActive(tab) {
    const pane = $(`pane-${tab}`);
    return !!pane && pane.classList.contains('active');
  }

  el.logLevel.addEventListener('change', () => renderLogs(logs));
  el.logFilter.addEventListener('input', () => renderLogs(logs));
  el.logClearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearLogs' }));
  el.logCopyBtn.addEventListener('click', () => {
    const text = logs
      .filter(logMatches)
      .map((e) => {
        const head = `[${logTime(e.at)}] ${(LOG_LABEL[e.level] || e.level)} ${e.scope}｜${e.message}`;
        return e.detail ? `${head}\n${e.detail.split('\n').map((l) => `    ${l}`).join('\n')}` : head;
      })
      .join('\n');
    if (!text) {
      toast('没有可复制的日志。');
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => toast('日志已复制到剪贴板。'))
      .catch(() => toast('复制失败，可手动选中复制。', true));
  });

  // ---------------------------------------------------------------- 工程

  /**
   * 折叠状态。放在模块级，重渲染后不会把用户折叠的东西又展开。
   * 四个顶层分组默认展开；文件夹默认折叠——一进工程页就摊开整棵树反而看不清。
   */
  const openGroups = { chapters: true, characters: true, lore: true, meta: true };
  /** 展开着的文件夹（relPath 集合）。 */
  const openFolders = new Set();

  function projectAction(action, order, dir) {
    vscode.postMessage({ type: 'projectAction', action, order, dir });
  }

  function fileAction(action, relPath) {
    vscode.postMessage({ type: 'fileAction', action, relPath });
  }

  /** 打开某章的草稿。传的是**章节**路径，草稿路径由后端推导并按需创建。 */
  function openDraft(relPath) {
    vscode.postMessage({ type: 'openDraft', path: relPath });
  }

  /**
   * 最近一次收到的树。展开/折叠文件夹只是本地状态变化，
   * 拿这份快照重画即可，不必往后端要一次。
   */
  let lastTree = null;

  function rerenderProject() {
    if (lastTree) renderProject(lastTree);
  }

  el.projectToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) projectAction(btn.dataset.action);
  });

  function renderProject(tree) {
    lastTree = tree;
    el.projectBody.innerHTML = '';
    // 全部行都被换掉了，开着的浮窗指向的是已丢弃的节点。
    hideSummaryTip();
    // 还不是小说工程时，工具栏上的「新建章节」等按钮点了只会报错。
    el.projectToolbar.classList.toggle('hidden', !tree.initialized);

    if (!tree.initialized) {
      el.projectBody.appendChild(buildInitPrompt());
      return;
    }

    el.projectBody.appendChild(buildProjectHead(tree));
    el.projectBody.appendChild(
      buildGroup('chapters', '章节', `${tree.chapterCount} 章 · ${formatWords(tree.totalWords)}`, {
        section: SECTIONS.chapters,
        root: tree.chaptersRoot,
        build: () =>
          tree.chapters.length === 0
            ? [emptyRow('还没有章节。点上方「＋ 新建章节」开始。')]
            : renderNodes(tree.chapters, 0, SECTIONS.chapters),
      })
    );
    el.projectBody.appendChild(
      buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
        section: SECTIONS.characters,
        root: tree.charactersRoot,
        build: () =>
          tree.characters.length === 0
            ? [emptyRow('还没有角色卡。可运行「提取/更新角色卡」从正文抽取。')]
            : renderNodes(tree.characters, 0, SECTIONS.characters),
      })
    );
    el.projectBody.appendChild(
      buildGroup('lore', '设定', countLabel(tree.lore, '条'), {
        section: SECTIONS.lore,
        root: tree.loreRoot,
        build: () =>
          tree.lore.length === 0
            ? [emptyRow('还没有设定条目。keywords 命中纲要时会自动注入上下文。')]
            : renderNodes(tree.lore, 0, SECTIONS.lore),
      })
    );
    el.projectBody.appendChild(
      buildGroup('meta', '文风与摘要', summaryGroupLabel(tree), {
        build: () => buildMetaRows(tree),
      })
    );
  }

  /** 分组副标题：待办数与总量一起给，不必展开就知道摘要覆盖到什么程度。 */
  function summaryGroupLabel(tree) {
    if (tree.chapterCount === 0) return '还没有章节';
    return tree.staleCount > 0
      ? `已总结 ${tree.summarizedCount}/${tree.chapterCount} 章 · ${tree.staleCount} 章待总结`
      : `${tree.chapterCount} 章已全部同步`;
  }

  /**
   * 三个可管理区各自的差异：新建什么、菜单上怎么称呼、文件行用什么图标。
   * 与 core/fileOps.ts 的 Section 一一对应。
   */
  const SECTIONS = {
    chapters: { newAction: 'newChapter', newLabel: '在此新建章节', icon: '📄' },
    characters: { newAction: 'newCharacter', newLabel: '在此新建角色卡', icon: '👤' },
    lore: { newAction: 'newLore', newLabel: '在此新建设定', icon: '🌐' },
  };

  /** 「在此新建 X / 在此新建文件夹」两项，落点是 `dir`。 */
  function newItemsIn(section, dir) {
    return [
      { label: section.newLabel, run: () => projectAction(section.newAction, undefined, dir) },
      { label: '在此新建文件夹', run: () => projectAction('newFolder', undefined, dir) },
    ];
  }

  /** 重命名 / 移动 / 删除——文件与文件夹都是这三个。 */
  function entryItems(relPath) {
    return [
      { label: '重命名', run: () => fileAction('rename', relPath) },
      { label: '移动到…', run: () => fileAction('move', relPath) },
      { label: '删除（移到回收站）', danger: true, run: () => fileAction('delete', relPath) },
    ];
  }

  /** 顶层分组的副标题：文件总数（含子文件夹里的）。 */
  function countLabel(nodes, unit) {
    let files = 0;
    let folders = 0;
    const walk = (list) => {
      for (const n of list) {
        if (n.kind === 'dir') {
          folders++;
          walk(n.children);
        } else {
          files++;
        }
      }
    };
    walk(nodes);
    return folders > 0 ? `${files} ${unit} · ${folders} 个文件夹` : `${files} ${unit}`;
  }

  /**
   * 递归渲染一层节点。返回扁平的行数组——树的层级靠 depth 缩进表达，
   * 而不是嵌套 DOM：折叠一个文件夹只需要重建它所在的分组。
   *
   * `section` 是 SECTIONS 里的那一项，决定文件图标与「在此新建」建什么。
   */
  function renderNodes(nodes, depth, section) {
    const rows = [];
    for (const node of nodes) {
      if (node.kind === 'dir') {
        rows.push(buildFolderRow(node, depth, section));
        if (openFolders.has(node.relPath)) {
          if (node.children.length === 0) {
            rows.push(emptyRow('（空文件夹）', depth + 1));
          } else {
            rows.push(...renderNodes(node.children, depth + 1, section));
          }
        }
      } else if (node.kind === 'chapter') {
        rows.push(buildChapterRow(node, depth));
      } else {
        rows.push(buildFileRow(node, section.icon, depth));
      }
    }
    return rows;
  }


  function buildInitPrompt() {
    const box = document.createElement('div');
    box.className = 'project-empty';
    const p = document.createElement('p');
    p.textContent = '当前工作区还不是 Novel Forge 小说工程。';
    box.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '初始化小说工程';
    btn.addEventListener('click', () => projectAction('initProject'));
    box.appendChild(btn);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '会创建 chapters/ 与 .novelforge/ 目录及模板文件。';
    box.appendChild(hint);
    return box;
  }

  function buildProjectHead(tree) {
    const head = document.createElement('div');
    head.className = 'project-head';

    const title = document.createElement('div');
    title.className = 'project-title';
    title.textContent = tree.title || '未命名';
    head.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [tree.author, `${tree.chapterCount} 章`, formatWords(tree.totalWords)]
      .filter(Boolean)
      .join(' · ');
    head.appendChild(meta);

    if (tree.staleCount > 0) {
      head.appendChild(buildSummaryBanner(tree));
    }
    return head;
  }

  /**
   * 摘要进度横幅。
   *
   * 改造前这里只有一句「76 章摘要缺失或已过期」——用户不知道分母，
   * 也看不出同步跑到哪了。现在给出「已完成 N/M」与一条进度条，
   * 同步过程中每章刷新一次（后端 pushState 会重推整棵树）。
   */
  function buildSummaryBanner(tree) {
    const banner = document.createElement('div');
    banner.className = 'banner banner-summary';

    const line = document.createElement('div');
    line.className = 'banner-line';
    const text = document.createElement('span');
    text.textContent = `${tree.staleCount} 章摘要缺失或已过期，这些章节的剧情不会进入上下文。`;
    line.appendChild(text);
    line.appendChild(document.createElement('span')).className = 'spacer';
    // 同步在跑时不再显示「立即同步」——点第二次只会撞上「已有任务在进行」。
    if (!hasTask('同步章节摘要')) {
      line.appendChild(linkBtn('立即同步', () => projectAction('syncSummaries')));
    }
    banner.appendChild(line);

    const done = tree.summarizedCount;
    const total = tree.chapterCount;
    if (total > 0) {
      const bar = document.createElement('div');
      bar.className = 'sum-bar';
      const fill = document.createElement('div');
      fill.className = 'sum-fill';
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      bar.appendChild(fill);
      banner.appendChild(bar);

      const meta = document.createElement('div');
      meta.className = 'meta sum-meta';
      meta.textContent = `已总结 ${done} / ${total} 章（${Math.round((done / total) * 100)}%）`;
      banner.appendChild(meta);
    }
    return banner;
  }

  /** 某个标题的长任务是否在跑。用于避免重复触发同一个动作。 */
  function hasTask(title) {
    return tasks.some((t) => t.title === title);
  }

  /**
   * 可折叠分组。`opts.build` 惰性调用，折叠时不生成行。
   *
   * 三个可管理区（给了 `opts.section` + `opts.root`）在标题栏与分组空白处
   * 右键能「在此新建」，落点是该区根目录；行上的右键各自登记，会先命中。
   */
  function buildGroup(id, label, description, opts) {
    const box = document.createElement('div');
    box.className = 'group';

    const head = document.createElement('div');
    head.className = 'group-head';

    const toggle = document.createElement('button');
    toggle.className = 'group-toggle';
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = openGroups[id] ? '▾' : '▸';
    toggle.appendChild(caret);
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = label;
    toggle.appendChild(name);
    const desc = document.createElement('span');
    desc.className = 'meta';
    desc.textContent = description;
    toggle.appendChild(desc);
    head.appendChild(toggle);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'group-body';
    box.appendChild(body);

    if (opts.section) {
      // 登记在整个分组上：标题栏、分组内的空白、空提示行都能右键新建。
      onContextMenu(box, () => [
        ...newItemsIn(opts.section, opts.root),
        { sep: true },
        ...baseMenuItems(),
      ]);
    }

    const sync = () => {
      caret.textContent = openGroups[id] ? '▾' : '▸';
      body.innerHTML = '';
      if (!openGroups[id]) return;
      for (const row of opts.build()) body.appendChild(row);
    };
    toggle.addEventListener('click', () => {
      openGroups[id] = !openGroups[id];
      sync();
    });
    sync();
    return box;
  }

  /**
   * 文件夹行。点行体展开/折叠，其余操作走右键。
   * 折叠状态由前端自己记，不进后端。
   */
  function buildFolderRow(node, depth, section) {
    const row = document.createElement('div');
    row.className = 'row row-dir';
    row.style.paddingLeft = `${indentOf(depth)}px`;

    const open = openFolders.has(node.relPath);

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = open ? '▾' : '▸';
    row.appendChild(caret);

    const label = document.createElement('span');
    label.className = 'row-label row-dir-label';
    label.textContent = `${open ? '📂' : '📁'} ${node.label}`;
    label.title = node.relPath;
    row.appendChild(label);

    const count = document.createElement('span');
    count.className = 'meta';
    count.textContent = node.fileCount > 0 ? `${node.fileCount} 项` : '空';
    row.appendChild(count);

    const toggle = () => {
      if (openFolders.has(node.relPath)) openFolders.delete(node.relPath);
      else openFolders.add(node.relPath);
      rerenderProject();
    };
    caret.addEventListener('click', toggle);
    label.addEventListener('click', toggle);

    // 「在此新建」的落点是这个文件夹自己，不是区根目录。
    onContextMenu(row, () => [
      { label: open ? '折叠' : '展开', run: toggle },
      { sep: true },
      ...newItemsIn(section, node.relPath),
      { sep: true },
      ...entryItems(node.relPath),
    ]);
    return row;
  }

  /** 每层缩进 14px，第 0 层与改造前的行保持同样的左内边距。 */
  function indentOf(depth) {
    return 16 + depth * 14;
  }

  function buildChapterRow(c, depth) {
    const row = document.createElement('div');
    // row-chapter + data-order 是悬停浮窗的抓手：事件委托在 projectBody 上，
    // 行被重渲染丢弃也不会留下失效的监听器。
    row.className = 'row row-chapter';
    row.dataset.order = String(c.order);
    row.style.paddingLeft = `${indentOf(depth)}px`;

    const dot = document.createElement('span');
    dot.className = `dot${c.stale ? ' stale' : ''}`;
    dot.textContent = c.stale ? '○' : '●';
    dot.title = c.stale ? '摘要缺失或已过期' : '摘要为最新';
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = `${String(c.order).padStart(3, '0')} ${c.title}`;
    label.title = c.relPath;
    label.addEventListener('click', () => openPath(c.relPath));
    row.appendChild(label);

    const words = document.createElement('span');
    words.className = 'meta';
    // 「有草稿」跟在字数后面，不新增 DOM——树行一律不挂行内按钮。
    words.textContent = formatWords(c.wordCount) + (c.hasDraft ? ' · 草稿' : '');
    row.appendChild(words);

    onContextMenu(row, () => {
      const items = [
        { label: '打开', run: () => openPath(c.relPath) },
        // 从第 N 章续写意味着写第 N+1 章。
        { label: '在此续写', run: () => projectAction('continueFrom', c.order) },
        // 草稿按需创建：没有就建一个再打开，文案据此区分。
        { label: c.hasDraft ? '打开草稿' : '新建草稿', run: () => openDraft(c.relPath) },
        {
          label: c.stale ? '总结本章' : '重新总结',
          run: () => projectAction('summarizeChapter', c.order),
        },
      ];
      if (c.summaryPath) {
        items.push({ label: '看摘要', run: () => openPath(c.summaryPath) });
      }
      items.push({ sep: true }, ...entryItems(c.relPath));
      return items;
    });
    return row;
  }

  // ------------------------------------------------- 章节摘要的悬停浮窗

  /**
   * 摘要浮窗。
   *
   * 摘要此前只能在 `.novelforge/summaries/` 里手动翻，或右键「看摘要」开一个
   * 编辑器标签页——想快速回忆「第 37 章讲了什么」代价太大。悬停浮窗把这件事
   * 变成不打断写作的一瞥。
   *
   * 四条设计取舍：
   * - **摘要正文不进 `ProjectTree`**：那棵树每次文件变动都全量重推，两百章
   *   每章上千字等于每保存一次就推几百 KB。改成悬停时按 order 单章去取。
   * - **前端缓存、收到新树即作废**：同一章反复扫过去只请求一次；正文一改
   *   （后端会重推树）缓存整体清掉，不会拿旧摘要糊弄人。
   * - **半秒延迟**：鼠标从工具栏划到某一行的路上会扫过好几行，立刻弹会闪。
   * - **浮窗可以进得去**：摘要有六个小节、可能上千字，一瞥看不完。鼠标移上去
   *   浮窗就一直留着（可滚动、可选中复制），移开才收。为此收起要延迟一点——
   *   从行挪到浮窗中间要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，
   *   立刻收会让浮窗永远够不着。
   */
  const HOVER_DELAY_MS = 450;
  /** 收起的宽限期：够鼠标从行跨到浮窗，又不至于让它赖着不走。 */
  const CLOSE_DELAY_MS = 200;
  /** 浮窗与目标行之间的缝，以及与视口边缘的留白。 */
  const TIP_GAP = 4;
  const TIP_MARGIN = 8;
  /** 压高度时的下限：再挤也得看得见一行字，否则等于浮窗没弹。 */
  const MIN_TIP_HEIGHT = 48;
  /** order -> ChapterSummaryView。收到新的树时整体作废。 */
  const summaryCache = new Map();
  /** 已经发出请求、还没等到回音的 order，避免同一章连发好几次。 */
  const summaryPending = new Set();
  let hoverTimer = null;
  /** 收起的宽限计时。与 hoverTimer 是两件事，别合并。 */
  let closeTimer = null;
  /** 当前浮窗：{ order, box }。 */
  let hoverTip = null;
  /** 正在等延迟的那一行（延迟到点时用它定位）。 */
  let hoverRow = null;

  /** 立刻收起。滚动 / Esc / 右键 / 重渲染用这个，不给宽限。 */
  function hideSummaryTip() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    cancelScheduledHide();
    hoverRow = null;
    if (hoverTip) {
      hoverTip.box.remove();
      hoverTip = null;
    }
  }

  /** 鼠标离开行或浮窗：给一点宽限再收，好让鼠标能挪到浮窗上去。 */
  function scheduleHideSummaryTip() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      hideSummaryTip();
    }, CLOSE_DELAY_MS);
  }

  /** 鼠标回到行上或进了浮窗：撤销待执行的收起。 */
  function cancelScheduledHide() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  /** 悬停在某一行上：延迟后弹浮窗，数据没有就先要一份。 */
  function scheduleSummaryTip(row) {
    const order = Number(row.dataset.order);
    if (!Number.isFinite(order)) return;
    // mouseover 在行内子元素之间移动时也会冒泡上来。已经为这一行开着浮窗、
    // 或已经在为它计时了，就什么都别做——否则光标在行上微动一下就重置延迟，
    // 浮窗永远弹不出来。
    if (hoverTip && hoverTip.order === order) return;
    if (hoverRow === row) return;
    hideSummaryTip();
    hoverRow = row;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      // 延迟期间行可能被重渲染丢弃，那就不弹了。
      if (!hoverRow || !hoverRow.isConnected) return;
      showSummaryTip(hoverRow, order);
      if (!summaryCache.has(order) && !summaryPending.has(order)) {
        summaryPending.add(order);
        vscode.postMessage({ type: 'requestSummary', order });
      }
    }, HOVER_DELAY_MS);
  }

  /** 建出浮窗并贴在行的下方/上方。数据还没到就先显示「读取中」。 */
  function showSummaryTip(row, order) {
    const box = document.createElement('div');
    box.className = 'summary-tip';
    box.appendChild(buildSummaryTipBody(summaryCache.get(order)));
    // 鼠标进了浮窗就别收——用户正在读，或者要滚动、选中复制。
    // 监听挂在 box 上，box 每次都是新建的，收起时随元素一起回收。
    box.addEventListener('mouseenter', cancelScheduledHide);
    box.addEventListener('mouseleave', scheduleHideSummaryTip);
    document.body.appendChild(box);
    hoverTip = { order, box };
    placeSummaryTip(row, box);
  }

  /**
   * 定位浮窗，并保证它整个落在视口内。
   *
   * 挂在 body 上 `position: fixed`——工程页有内部滚动，挂在行里会被容器裁掉
   * （与右键菜单同一套理由）。代价是位置得自己算：
   *
   * - 横向左对齐目标行，右边溢出就往左收，最左不越过边距。
   * - 纵向优先放行下方（顺着视线），放不下翻到上方；**两边都放不下时选空间
   *   大的那一侧，并把高度压进那点空间**——摘要可以滚，但绝不能长到屏幕外面
   *   去。只翻转不压高度的话，一份长摘要在矮窗口里会有一截永远够不到。
   */
  function placeSummaryTip(row, box) {
    const r = row.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    // 先撤掉上一次的限制再量，否则会一直沿用之前那个更矮的值。
    // 量到的「自然高度」已经含 CSS 里 60vh 的可读性上限。
    box.style.maxHeight = '';
    const natural = box.offsetHeight;

    const below = vh - r.bottom - TIP_GAP - TIP_MARGIN;
    const above = r.top - TIP_GAP - TIP_MARGIN;
    const putBelow = natural <= below || below >= above;
    // 窗口特别矮时算出来的空间可能是 0 甚至负数，直接拿去当 max-height
    // 会得到一个看不见的浮窗。给一个下限，宁可稍微出界一点也得留得住内容。
    const room = Math.max(MIN_TIP_HEIGHT, putBelow ? below : above);
    if (natural > room) {
      box.style.maxHeight = `${room}px`;
    }

    // 压过高度之后才量得到最终高度，上翻时要用它算 top。
    const h = box.offsetHeight;
    const top = putBelow ? r.bottom + TIP_GAP : Math.max(TIP_MARGIN, r.top - h - TIP_GAP);

    const w = box.offsetWidth;
    let left = r.left;
    if (w > 0 && left + w > vw - TIP_MARGIN) {
      left = vw - w - TIP_MARGIN;
    }
    if (left < TIP_MARGIN) {
      left = TIP_MARGIN;
    }

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  /** 浮窗内容。`view` 为 undefined 表示还在等后端。 */
  function buildSummaryTipBody(view) {
    const frag = document.createDocumentFragment();

    if (!view) {
      const loading = document.createElement('div');
      loading.className = 'hint';
      loading.textContent = '读取摘要…';
      frag.appendChild(loading);
      return frag;
    }

    const head = document.createElement('div');
    head.className = 'summary-tip-head';
    const title = document.createElement('span');
    title.className = 'summary-tip-title';
    title.textContent = `第 ${view.order} 章 ${view.title}`.trim();
    head.appendChild(title);
    // 过期必须说出来：照着一份写于三次修改之前的摘要做判断比没有摘要更糟。
    if (view.exists && view.stale) {
      const tag = document.createElement('span');
      tag.className = 'summary-tip-stale';
      tag.textContent = '已过期';
      head.appendChild(tag);
    }
    frag.appendChild(head);

    if (!view.exists) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '这一章还没有摘要。右键「总结本章」可以生成。';
      frag.appendChild(empty);
      return frag;
    }

    for (const section of view.sections) {
      const name = document.createElement('div');
      name.className = 'summary-tip-section';
      name.textContent = section.name;
      frag.appendChild(name);
      const text = document.createElement('div');
      text.className = 'summary-tip-text';
      // textContent 而非 innerHTML：摘要是模型写的，里面可能有任何字符。
      text.textContent = section.text;
      frag.appendChild(text);
    }
    if (view.sections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '摘要文件是空的。';
      frag.appendChild(empty);
    }
    return frag;
  }

  /** 摘要到了：填进缓存，正开着的浮窗就地换掉内容（不重建，免得闪）。 */
  function applySummary(view) {
    summaryPending.delete(view.order);
    summaryCache.set(view.order, view);
    if (!hoverTip || hoverTip.order !== view.order) return;
    hoverTip.box.innerHTML = '';
    hoverTip.box.appendChild(buildSummaryTipBody(view));
    const row = el.projectBody.querySelector(`.row-chapter[data-order="${view.order}"]`);
    // 内容换了尺寸也变了，重新定位一次。
    if (row) placeSummaryTip(row, hoverTip.box);
  }

  // 事件委托挂在 projectBody 上：树每次重渲染都换掉全部行，
  // 逐行 addEventListener 会随重渲染次数堆积。
  el.projectBody.addEventListener('mouseover', (e) => {
    const row = e.target.closest && e.target.closest('.row-chapter');
    if (row) {
      // 回到行上就撤销待执行的收起（从浮窗挪回行上时会走到这儿）。
      cancelScheduledHide();
      scheduleSummaryTip(row);
    } else if (hoverTip) {
      // 挪到了别的行/空白处：给宽限而不是立刻收——鼠标要去浮窗的话，
      // 半路会先扫过行下方的那道缝。
      scheduleHideSummaryTip();
    } else if (hoverTimer) {
      hideSummaryTip();
    }
  });
  el.projectBody.addEventListener('mouseleave', () => {
    // 往浮窗方向移出去也会触发这里，同样给宽限。
    if (hoverTip) scheduleHideSummaryTip();
    else hideSummaryTip();
  });
  // 右键菜单弹出来时浮窗该让路，两个都是 fixed 会叠在一起。
  el.projectBody.addEventListener('contextmenu', hideSummaryTip);
  // 浮窗是 fixed 的，页面一滚就和目标行脱节（与右键菜单同一个理由）。
  // 但**浮窗自己内部的滚动不算**——摘要有六个小节，滚动是要给用户用的，
  // 一滚就把浮窗收掉等于这个滚动条形同虚设。捕获阶段才收得到内部容器
  // （.project-body）的滚动。
  document.addEventListener(
    'scroll',
    (e) => {
      if (hoverTip && hoverTip.box.contains(e.target)) return;
      hideSummaryTip();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSummaryTip();
  });

  /**
   * 角色/设定/元数据行。
   * `depth` 为 undefined 时不设缩进，也不挂类文件操作的右键菜单——
   * 「文风与摘要」那几行是工程的固定文件，不能重命名/移动/删除。
   */
  function buildFileRow(f, icon, depth) {
    const row = document.createElement('div');
    row.className = 'row';
    if (depth !== undefined) {
      row.style.paddingLeft = `${indentOf(depth)}px`;
    }

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = icon;
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = f.label;
    label.title = f.relPath;
    label.addEventListener('click', () => openPath(f.relPath));
    row.appendChild(label);

    if (f.detail) {
      const detail = document.createElement('span');
      detail.className = 'meta row-detail';
      detail.textContent = f.detail;
      row.appendChild(detail);
    }

    if (depth !== undefined) {
      onContextMenu(row, () => [
        { label: '打开', run: () => openPath(f.relPath) },
        { sep: true },
        ...entryItems(f.relPath),
      ]);
    }
    return row;
  }

  function buildMetaRows(tree) {
    const rows = [];

    const global = buildFileRow(
      {
        label: '全书摘要',
        relPath: tree.globalSummaryPath,
        detail:
          tree.globalSummaryThrough > 0
            ? `覆盖至第 ${tree.globalSummaryThrough} 章${
                tree.globalSummaryThrough < tree.chapterCount ? ' ⚠ 落后于正文' : ''
              }`
            : '未生成',
      },
      '📖'
    );
    const globalActions = document.createElement('span');
    globalActions.className = 'row-actions';
    globalActions.appendChild(linkBtn('重建', () => projectAction('rebuildGlobalSummary')));
    global.appendChild(globalActions);
    onContextMenu(global, () => [
      { label: '打开', run: () => openPath(tree.globalSummaryPath) },
      { label: '重建全书摘要', run: () => projectAction('rebuildGlobalSummary') },
      { sep: true },
      ...baseMenuItems(),
    ]);
    rows.push(global);

    const style = buildFileRow({ label: '文风指南', relPath: tree.styleGuidePath, detail: '' }, '🎨');
    const styleActions = document.createElement('span');
    styleActions.className = 'row-actions';
    styleActions.appendChild(linkBtn('从正文提取', () => projectAction('extractStyle')));
    style.appendChild(styleActions);
    onContextMenu(style, () => [
      { label: '打开', run: () => openPath(tree.styleGuidePath) },
      { label: '从正文提取文风', run: () => projectAction('extractStyle') },
      { sep: true },
      ...baseMenuItems(),
    ]);
    rows.push(style);

    const outline = buildFileRow({ label: '全书大纲', relPath: tree.outlinePath, detail: '人工维护' }, '🗂');
    onContextMenu(outline, () => [
      { label: '打开', run: () => openPath(tree.outlinePath) },
      { sep: true },
      ...baseMenuItems(),
    ]);
    rows.push(outline);

    const tools = document.createElement('div');
    tools.className = 'row row-tools';
    tools.appendChild(
      linkBtn(
        tree.staleCount > 0 ? `同步 ${tree.staleCount} 章过期摘要` : '同步过期摘要',
        () => projectAction('syncSummaries')
      )
    );
    tools.appendChild(linkBtn('提取/更新角色卡', () => projectAction('extractCharacters')));
    onContextMenu(tools, () => [
      { label: '同步过期摘要', run: () => projectAction('syncSummaries') },
      { label: '提取/更新角色卡', run: () => projectAction('extractCharacters') },
      { sep: true },
      ...baseMenuItems(),
    ]);
    rows.push(tools);
    return rows;
  }

  function emptyRow(text, depth) {
    const row = document.createElement('div');
    row.className = 'hint row-empty';
    if (depth !== undefined) {
      row.style.paddingLeft = `${indentOf(depth)}px`;
    }
    row.textContent = text;
    return row;
  }

  function formatWords(n) {
    return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
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
        refreshProviderModal();
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
    refreshProviderModal();
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

  /** 列表里的信息卡片：只放概要，点「配置」进弹窗改细节。 */
  function buildProviderCard(p) {
    const card = document.createElement('div');
    card.className = 'provider-card';

    const head = document.createElement('div');
    head.className = 'provider-head';
    const title = document.createElement('span');
    title.className = 'provider-title';
    title.textContent = p.label || p.id;
    title.title = `模型引用前缀 ${p.id}/`;
    head.appendChild(title);
    const kindTag = document.createElement('span');
    kindTag.className = 'meta';
    kindTag.textContent = KIND_LABEL[p.kind] || p.kind;
    head.appendChild(kindTag);
    head.appendChild(smallBtn('配置', () => openProviderModal(p.id)));
    head.appendChild(buildDeleteProviderBtn(p));
    card.appendChild(head);

    const url = document.createElement('div');
    url.className = 'provider-url';
    url.textContent =
      p.kind === 'vscode-lm' ? '内置 · 无需接口地址' : p.baseUrl || '未设置接口地址';
    url.title = p.baseUrl || '';
    card.appendChild(url);

    const models = document.createElement('div');
    models.className = 'provider-models';
    if (p.models.length === 0) {
      const none = document.createElement('span');
      none.className = 'meta';
      none.textContent = '还没有模型';
      models.appendChild(none);
    }
    for (const m of p.models.slice(0, 5)) {
      const chip = document.createElement('span');
      chip.className = 'model-chip';
      chip.textContent = m.name || '…';
      chip.title = `${p.id}/${m.name}`;
      models.appendChild(chip);
    }
    if (p.models.length > 5) {
      const more = document.createElement('span');
      more.className = 'meta';
      more.textContent = `… 共 ${p.models.length} 个`;
      models.appendChild(more);
    }
    card.appendChild(models);
    return card;
  }

  /** 卡片上的删除按钮：第一次点击进入确认态，三秒内再点才真删。 */
  function buildDeleteProviderBtn(p) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = '删除';
    let timer = null;
    b.addEventListener('click', () => {
      if (timer) {
        clearTimeout(timer);
        draft.providers = draft.providers.filter((x) => x !== p);
        touch();
        renderProviders();
        toast(`已删除服务商「${p.label || p.id}」，记得保存。`);
      } else {
        b.textContent = '确认删除？';
        b.classList.add('danger');
        timer = setTimeout(() => {
          timer = null;
          b.textContent = '删除';
          b.classList.remove('danger');
        }, 3000);
      }
    });
    return b;
  }

  // ---------------------------------------------------------------- 配置弹窗

  /** 弹窗模式：'edit' 改 draft 里已有服务商；'add' 编辑临时对象，确认后才写入 draft。 */
  let modalMode = null;
  /** edit 模式下正在编辑的服务商 id。 */
  let modalProviderId = null;
  /** add 模式下的临时服务商，确认添加后才进 draft。 */
  let modalTemp = null;

  function openProviderModal(id) {
    const p = draft.providers.find((x) => x.id === id);
    if (!p) return;
    modalMode = 'edit';
    modalProviderId = id;
    fillProviderModal(p);
    el.providerModal.classList.remove('hidden');
  }

  /** 添加服务商：弹窗里先编辑临时对象，确认后才进列表。 */
  function openAddModal() {
    modalMode = 'add';
    modalTemp = { id: uniqueId('provider'), kind: 'openai', baseUrl: '', models: [{ name: '' }] };
    fillProviderModal(modalTemp);
    el.providerModal.classList.remove('hidden');
  }

  function fillProviderModal(p) {
    el.providerModalTitle.textContent =
      modalMode === 'add' ? '添加服务商' : `配置 · ${p.label || p.id}`;
    const body = el.providerModalBody;
    body.innerHTML = '';

    // 添加弹窗顶部放预设，点一下直接填入整套配置。
    if (modalMode === 'add') {
      const presetRow = document.createElement('div');
      presetRow.className = 'modal-presets';
      const label = document.createElement('span');
      label.className = 'meta';
      label.textContent = '从预设填入：';
      presetRow.appendChild(label);
      for (const preset of PRESETS) {
        const btn = document.createElement('button');
        btn.className = 'chip-btn';
        btn.textContent = preset.label;
        btn.title = preset.baseUrl || KIND_LABEL[preset.kind];
        btn.addEventListener('click', () => applyPreset(preset));
        presetRow.appendChild(btn);
      }
      body.appendChild(presetRow);
    }

    body.appendChild(buildProviderEditor(p));

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    if (modalMode === 'add') {
      foot.appendChild(primaryBtn('确认添加', confirmAddProvider));
      foot.appendChild(secondaryBtn('取消', closeProviderModal));
    } else {
      foot.appendChild(secondaryBtn('完成', closeProviderModal));
    }
    body.appendChild(foot);
  }

  /** 点预设：用预设配置替换临时对象内容，仍可继续微调。 */
  function applyPreset(preset) {
    const copy = JSON.parse(JSON.stringify(preset));
    copy.id = uniqueId(preset.id);
    modalTemp.id = copy.id;
    modalTemp.label = copy.label;
    modalTemp.kind = copy.kind;
    modalTemp.baseUrl = copy.baseUrl;
    modalTemp.models = copy.models;
    fillProviderModal(modalTemp);
  }

  function confirmAddProvider() {
    const p = modalTemp;
    const problem = validateProviders([p]);
    if (problem) {
      toast(problem, true);
      return;
    }
    if (draft.providers.some((x) => x.id === p.id)) {
      toast(`前缀「${p.id}」与已有服务商重复。`, true);
      return;
    }
    draft.providers.push(p);
    touch();
    closeProviderModal();
    toast(`已添加「${p.label || p.id}」，模型引用前缀为 ${p.id}/，记得保存。`);
  }

  function closeProviderModal() {
    if (modalMode === null) return;
    modalMode = null;
    modalProviderId = null;
    modalTemp = null;
    el.providerModal.classList.add('hidden');
    el.providerModalBody.innerHTML = '';
    // 弹窗里改过的名字、模型数要反映回卡片。
    renderProviders();
  }

  /** draft.providers 被整体替换后（外部刷新/Key 变更），把弹窗重绑到新对象上。 */
  function refreshProviderModal() {
    if (modalMode === 'edit') {
      const p = draft.providers.find((x) => x.id === modalProviderId);
      if (!p) {
        closeProviderModal();
        return;
      }
      fillProviderModal(p);
    } else if (modalMode === 'add') {
      // 临时对象不在 draft 里，原样重建，只刷新 Key 状态等。
      fillProviderModal(modalTemp);
    }
  }

  el.providerModalClose.addEventListener('click', closeProviderModal);
  el.providerModal.addEventListener('click', (e) => {
    if (e.target === el.providerModal) closeProviderModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProviderModal();
  });

  /** add 模式下编辑的是临时对象，不能把 draft 标脏，否则 dirty 清不掉。 */
  function editorTouch() {
    if (modalMode === 'edit') touch();
  }

  /** 弹窗里的完整编辑器。 */
  function buildProviderEditor(p) {
    const card = document.createElement('div');
    card.className = 'provider-block';

    const syncTitle = () => {
      if (modalMode === 'edit') {
        el.providerModalTitle.textContent = `配置 · ${p.label || p.id}`;
      }
    };

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
    card.appendChild(head);

    const row = document.createElement('div');
    row.className = 'grid';
    row.appendChild(
      textField('前缀 id', p.id, '不能含斜杠', (v) => {
        p.id = v.trim();
        if (modalMode === 'edit') modalProviderId = p.id;
        title.textContent = p.label || p.id;
        syncTitle();
        editorTouch();
        renderModelRows();
      })
    );
    row.appendChild(
      textField('显示名', p.label || '', '可留空', (v) => {
        p.label = v.trim() || undefined;
        title.textContent = p.label || p.id;
        syncTitle();
        editorTouch();
      })
    );
    card.appendChild(row);

    if (p.kind !== 'vscode-lm') {
      card.appendChild(
        textField('接口地址 baseUrl', p.baseUrl || '', 'https://…', (v) => {
          p.baseUrl = v.trim() || undefined;
          editorTouch();
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
        editorTouch();
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
        editorTouch();
        updateRef();
      })
    );
    row.appendChild(
      compactField('显示名', m.label || '', '可留空', (v) => {
        m.label = v.trim() || undefined;
        editorTouch();
      })
    );
    row.appendChild(
      compactNumber('窗口', m.contextWindow, '默认', (v) => {
        m.contextWindow = v;
        editorTouch();
      })
    );
    row.appendChild(
      compactNumber('输出上限', m.maxOutputTokens, '默认', (v) => {
        m.maxOutputTokens = v;
        editorTouch();
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
        // 把屏幕上这份服务商一起发过去，测的就是眼前这份配置——
        // 新加的模型、刚改的 baseUrl 不必先保存也能验。
        // API Key 仍取已保存的：它从不回显，草稿里也就没有。
        vscode.postMessage({
          type: 'testConnection',
          ref: `${p.id}/${m.name}`,
          provider: JSON.parse(JSON.stringify(p)),
        });
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

  function primaryBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /** 卡片头部用的小号按钮。 */
  function smallBtn(text, onClick) {
    const b = secondaryBtn(text, onClick);
    b.classList.add('small');
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

  el.addProviderBtn.addEventListener('click', openAddModal);

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

  // ---------------------------------------------------------------- 弹窗（独立版）

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  /**
   * 独立版把 host.input/confirm/pick 变成这里的 modal：
   * 复用 providerModal 遮罩层，body 换成临时内容，提交后回 promptResult。
   */
  function renderPrompt(msg) {
    const overlay = el.providerModal;
    const body = el.providerModalBody;
    el.providerModalTitle.textContent = msg.title;
    let inputEl;

    if (msg.kind === 'confirm') {
      body.innerHTML = `<p class="hint">${escapeHtml(msg.message ?? '')}</p>
        <div class="actions"><button class="primary" id="pmOk">确定</button>
        <button class="secondary" id="pmCancel">取消</button></div>`;
    } else if (msg.kind === 'pick') {
      body.innerHTML = `<div class="picklist" id="pmList"></div>
        <div class="actions"><button class="secondary" id="pmCancel">取消</button></div>`;
      const list = $('pmList');
      (msg.options ?? []).forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'pick-item';
        btn.textContent = opt;
        btn.addEventListener('click', () => reply(opt));
        list.appendChild(btn);
      });
    } else {
      const tag = msg.multiline ? 'textarea' : 'input';
      body.innerHTML = `${msg.message ? `<p class="hint">${escapeHtml(msg.message)}</p>` : ''}
        <${tag} id="pmInput" ${msg.multiline ? 'rows="6"' : ''} ${msg.password ? 'type="password"' : ''}
          placeholder="${escapeHtml(msg.placeholder ?? '')}" style="width:100%"></${tag}>
        <div class="actions"><button class="primary" id="pmOk">确定</button>
        <button class="secondary" id="pmCancel">取消</button></div>`;
      inputEl = $('pmInput');
      inputEl.value = msg.value ?? '';
      inputEl.focus();
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !msg.multiline) {
          e.preventDefault();
          reply(inputEl.value);
        }
        if (e.key === 'Escape') reply(undefined);
      });
    }

    $('pmOk')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'yes' : inputEl.value));
    $('pmCancel')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'no' : undefined));
    overlay.classList.remove('hidden');

    function reply(value) {
      overlay.classList.add('hidden');
      body.innerHTML = '';
      vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
    }
  }

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
      case 'project':
        // 后端推树 = 磁盘上有东西变了（可能正是某一章的正文或摘要）。
        // 缓存一律作废，宁可再取一次也不拿旧摘要糊弄人。折叠文件夹走的是
        // rerenderProject()，不经这里，缓存留着。
        summaryCache.clear();
        summaryPending.clear();
        renderProject(msg.tree);
        break;
      case 'summary':
        applySummary(msg.summary);
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
      case 'reasoning': {
        // 思考增量：气泡里没有折叠块就建一个（默认收起），有就往里追加。
        // 就地追加而不是重建节点——重建会把用户展开的状态和滚动位置弄丢。
        const node = el.messages.querySelector(`[data-turn="${msg.turnId}"]`);
        if (node) {
          node.classList.add('streaming');
          let det = node.querySelector('details.reasoning');
          if (!det) {
            det = buildReasoningDetails('');
            node.insertBefore(det, node.querySelector('.msg-body'));
          }
          const box = det.querySelector('.reasoning-body');
          if (box) {
            box.textContent += msg.text;
            det.querySelector('summary').textContent = `思考过程 · ${countWords(box.textContent)} 字`;
            // 展开着看的时候，让它跟着滚到最新。
            if (det.open) box.scrollTop = box.scrollHeight;
          }
          scrollToBottom();
        }
        break;
      }
      case 'turnDone':
        // 生成开始时控制器先插一条空回复，后续 delta 都挂在它上面。
        // 必须在这一刻就标成 streaming：否则气泡会以「可编辑」建出来，
        // 用户在生成途中的改动会被随后的 delta 追加和收尾重建冲掉。
        // 收尾的那次 turnDone 带着完整内容、busy 已为 false，于是解锁。
        store.streamingId =
          store.busy && msg.turn.role === 'assistant' && !msg.turn.content && !msg.turn.error
            ? msg.turn.id
            : null;
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
      case 'tasks':
        renderTasks(msg.tasks);
        break;
      case 'logs':
        renderLogs(msg.entries);
        break;
      case 'log':
        appendLog(msg.entry);
        break;
      case 'toast':
        toast(msg.message, msg.level === 'error');
        break;
      case 'prompt':
        renderPrompt(msg);
        break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
