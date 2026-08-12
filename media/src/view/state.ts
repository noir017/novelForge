/**
 * `ViewState` 的渲染：输入框旁的模型下拉、写入目标下拉、过期摘要横幅，
 * 以及生成中的按钮状态。
 *
 * 后端全量推 state，这里整块重画——数据量只有几十行，增量更新换来的那点
 * 开销不值得多维护一份状态。
 */
import { maybeById, setHidden } from '../dom';
import type { ViewState } from '../protocol';
import { setCommandsDisabled } from './commands';
import { fmt } from './format';
import { el } from './refs';
import { store } from './store';

export function renderState(state: ViewState): void {
  store.state = state;
  // 这里从前有一段「如果是独立版就把 VS Code 专属入口 hidden 掉、把存储说明
  // 改一改」。现在那两处差异由壳在渲染页面时决定要不要产出（见
  // src/shells/shared/panes.ts 的 nativeSettings），前端不再认得环境。
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

  renderTargetSelect(state);

  if (state.staleCount > 0) {
    el.staleText.textContent = `有 ${state.staleCount} 章摘要缺失或已过期，这些章节的剧情不会进入上下文。`;
  }
  setHidden(el.staleBanner, state.staleCount === 0);

  // 独立版的活动栏上给「工程」挂一个小圆点，切走了也看得见待办。
  const dot = maybeById('projectStaleDot');
  if (dot) {
    setHidden(dot, state.staleCount === 0);
  }
}

/**
 * 当前创作目标那一章。
 *
 * 它不只是「采纳写到哪」了——装配的每一层都跟着它走，所以选项里带上
 * `relPath`（目标一律按路径标识，序号会撞）。「新建第 N 章」那一项没有
 * relPath：那一章还不存在。
 */
function renderTargetSelect(state: ViewState): void {
  el.targetSelect.innerHTML = '';

  const newOpt = document.createElement('option');
  newOpt.value = String(state.nextOrder);
  newOpt.textContent = `新建第 ${state.nextOrder} 章`;
  newOpt.dataset.mode = 'new';
  el.targetSelect.appendChild(newOpt);

  for (const c of [...state.chapters].reverse()) {
    const opt = document.createElement('option');
    opt.value = String(c.order);
    opt.textContent = `第 ${c.order} 章《${c.title}》`;
    opt.dataset.mode = 'append';
    opt.dataset.rel = c.relPath;
    el.targetSelect.appendChild(opt);
  }

  // 以会话里的目标为准（后端是唯一真相），它指向的那一章不在列表里
  // （刚被删/改名）时退回「新建下一章」。
  const target = store.session.target;
  const relPath = target.kind === 'outline' ? undefined : target.chapterRelPath;
  const matched = relPath
    ? [...el.targetSelect.options].find((o) => o.dataset.rel === relPath)
    : undefined;
  el.targetSelect.value = matched?.value ?? String(store.session.targetOrder ?? state.nextOrder);
  if (!matched && !state.chapters.some((c) => c.order === store.session.targetOrder)) {
    el.targetSelect.value = String(state.nextOrder);
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

export function setBusy(value: boolean): void {
  store.busy = value;
  setHidden(el.sendBtn, value);
  setHidden(el.stopBtn, !value);
  el.atBtn.disabled = value;
  el.selBtn.disabled = value;
  // 主按钮与命令面板在生成期间都禁用：两者都会发起新的一轮。面板要是正开着
  // 也一并收掉——一个点不动的候选列表挂在输入框上方只会挡住消息流。
  el.nextStepBtn.disabled = value;
  setCommandsDisabled(value);
}
