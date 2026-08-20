/**
 * `ViewState` 的渲染：输入框旁的模型下拉、写入目标下拉、活动栏上的待办圆点，
 * 以及生成中的按钮状态。
 *
 * 后端全量推 state，这里整块重画——数据量只有几十行，增量更新换来的那点
 * 开销不值得多维护一份状态。
 */
import { maybeById, setHidden } from '../dom';
import { THINKING_DEPTHS, THINKING_HINT, THINKING_LABEL, plotOfTarget } from '../protocol';
import type { ViewState } from '../protocol';
import { setCommandsDisabled } from './commands';
import { fmt } from './format';
import { el } from './refs';
import { store, hasWorkspace } from './store';

export function renderState(state: ViewState): void {
  store.state = state;
  // 这里从前有一段「如果是独立版就把 VS Code 专属入口 hidden 掉、把存储说明
  // 改一改」。现在那两处差异由壳在渲染页面时决定要不要产出（见
  // src/shells/shared/panes.ts 的 nativeSettings），前端不再认得环境。
  renderModelSelect(state);
  renderThinkingSelect();

  el.input.disabled = !hasWorkspace();
  if (!hasWorkspace()) {
    el.sendBtn.disabled = true;
  }

  if (!state.initialized) {
    el.providerMeta.textContent = '当前工作区还不是小说工程，先运行「Novel: 初始化小说工程」。';
    el.sendBtn.disabled = true;
    return;
  }

  el.sendBtn.disabled = store.busy || !hasWorkspace();
  el.providerMeta.textContent = state.modelIssue
    ? state.modelIssue
    : `${state.modelLabel} · 窗口 ${fmt(state.contextWindow)} / 输出 ${fmt(state.maxOutputTokens)}`;
  el.providerMeta.classList.toggle('warn', !!state.modelIssue);

  renderTargetSelect(state);

  // 过期摘要的提示只在工程页出现（那份横幅由 project/groups.ts 画，还带进度条）。
  // 对话页不再挂一份纯文字版——同一句话说两遍，占的却是消息流的地方。
  // 独立版的活动栏上给「工程」挂一个小圆点，切走了也看得见待办。
  const dot = maybeById('projectStaleDot');
  if (dot) {
    setHidden(dot, state.staleCount === 0);
  }
}

/**
 * 当前创作目标那一章剧情。
 *
 * 它不只是「采纳写到哪」了——装配的每一层都跟着它走，所以选项里带上
 * `relPath`（目标一律按路径标识，章号会撞）。「新建第 N 章」那一项没有
 * relPath：那一章还不存在。
 *
 * 列的是**已发布的章 + 还没交付的剧情段**，顺序即时间线的倒序（最近的在上面）。
 * 说法由后端给（`p.label`）——两种行的叫法完全不同，前端按 `no` 自己拼会把每个
 * 剧情段都叫成「第 N 章」。
 */
function renderTargetSelect(state: ViewState): void {
  el.targetSelect.innerHTML = '';

  const newOpt = document.createElement('option');
  newOpt.value = String(state.nextNo);
  // **不报序号**：新建出来的是一个剧情段，它显示成「剧情 几」是推导出来的
  // 位次（最新章号 + 位次），与 `nextNo` 那个文件名前缀不是一回事。
  newOpt.textContent = '新建剧情段';
  newOpt.dataset.mode = 'new';
  el.targetSelect.appendChild(newOpt);

  for (const p of [...state.plots].reverse()) {
    const opt = document.createElement('option');
    opt.value = String(p.no);
    // 文案由后端给：一行可能是已发布的章，也可能是还没交付的剧情段，
    // 两者的说法完全不同（「第 12 章《夜访》」/「剧情 4《楼道》」）。
    opt.textContent = p.label;
    opt.dataset.mode = 'append';
    opt.dataset.rel = p.relPath;
    el.targetSelect.appendChild(opt);
  }

  // 以会话里的目标为准（后端是唯一真相），它指向的那一章不在列表里
  // （刚被删/改名）时退回「新建下一章」。
  const relPath = plotOfTarget(store.session.target);
  const matched = relPath
    ? [...el.targetSelect.options].find((o) => o.dataset.rel === relPath)
    : undefined;
  el.targetSelect.value = matched?.value ?? String(store.session.targetNo ?? state.nextNo);
  if (!matched && !state.plots.some((p) => p.no === store.session.targetNo)) {
    el.targetSelect.value = String(state.nextNo);
  }
}

/** 输入框旁的模型下拉框，按服务商分组。 */
function renderModelSelect(state: ViewState): void {
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

  let group: string | null = null;
  let optgroup: HTMLOptGroupElement | null = null;
  for (const m of models) {
    if (m.group !== group) {
      group = m.group;
      optgroup = document.createElement('optgroup');
      optgroup.label = group;
      el.modelSelect.appendChild(optgroup);
    }
    const opt = document.createElement('option');
    opt.value = m.ref;
    // 显示完整引用，因为它才是用户在别处（配置文件、文档）看到的东西。
    opt.textContent = m.ref;
    opt.title = `${m.group} · ${m.label}`;
    optgroup?.appendChild(opt);
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

/**
 * 输入框旁的思考深度下拉框。
 *
 * 选项是**固定五档**（后端那张表，前端直接打包同一份），所以只在首次渲染
 * 时建；当前值跟着会话走，由 `syncThinkingSelect` 在每次收到 session 时回填。
 */
function renderThinkingSelect(): void {
  if (el.thinkSelect.options.length === 0) {
    for (const depth of THINKING_DEPTHS) {
      const opt = document.createElement('option');
      opt.value = depth;
      opt.textContent = THINKING_LABEL[depth];
      opt.title = THINKING_HINT[depth];
      el.thinkSelect.appendChild(opt);
    }
  }
  syncThinkingSelect();
}

/** 把会话里那一档回显到下拉框上。后端是唯一真相，这里只是画它。 */
export function syncThinkingSelect(): void {
  el.thinkSelect.value = store.session.thinking;
}

export function setBusy(value: boolean): void {
  store.busy = value;
  setHidden(el.sendBtn, value);
  setHidden(el.stopBtn, !value);
  const locked = !hasWorkspace();
  el.sendBtn.disabled = value || locked;
  el.atBtn.disabled = value || locked;
  el.selBtn.disabled = value || locked;
  el.newSessionBtn.disabled = value || locked;
  // 生成期间不给改名：改名会动这一章的路径，而正在跑的那一轮攥着旧路径，
  // 采纳时会写到一个已经不存在的地方去。
  el.renamePlotBtn.disabled = value || locked;
  // 主按钮与命令面板在生成期间都禁用：两者都会发起新的一轮。面板要是正开着
  // 也一并收掉——一个点不动的候选列表挂在输入框上方只会挡住消息流。
  el.nextStepBtn.disabled = value || locked;
  setCommandsDisabled(value || locked);
}
