/**
 * 「生成」页：**手动调一次 `generate` 工具**。
 *
 * 与对话页那条路彻底分开——不碰 `store.session`、不碰气泡、不碰闸门卡片。
 * 这一页自己的东西只有下面那个 `gen`：表单选了什么、当下有没有一份待采纳的
 * 产出。**其余一律来自后端的推送**（落点候选、模型、skills 名单），前端一个
 * 名字都不写死（前端无状态，见 ../README.md）。
 *
 * DOM 一律 `createElement + textContent` 造，**不拼 HTML 字符串**：这一页显示的
 * 大半是作者自己写的东西（技能描述、文件名、模型报的错），里面出现 `<script>`
 * 也只该是普通文字。
 */
import { byId, clear, el as make, setHidden } from '../dom';
import {
  CREATION_JOBS,
  JOB_HINT,
  JOB_LABEL,
  STAGE_LABEL,
  THINKING_DEPTHS,
  THINKING_LABEL,
} from '../protocol';
import type {
  CreationJob,
  CreationStage,
  GenDraftView,
  GenModelView,
  GenPhase,
  GenTargetItem,
  OutMessage,
  ThinkingDepth,
} from '../protocol';
import { fmt } from './format';
import { store, vscode } from './store';

const g = {
  job: byId<HTMLSelectElement>('genJob'),
  jobHint: byId('genJobHint'),
  stageBadge: byId('genStageBadge'),
  target: byId<HTMLSelectElement>('genTarget'),
  manualBtn: byId<HTMLButtonElement>('genManualBtn'),
  manualPath: byId<HTMLInputElement>('genManualPath'),
  check: byId('genCheck'),
  ask: byId<HTMLTextAreaElement>('genAsk'),
  wordsStep: byId('genWordsStep'),
  words: byId<HTMLInputElement>('genWords'),
  skills: byId('genSkills'),
  skillCount: byId('genSkillCount'),
  model: byId<HTMLSelectElement>('genModel'),
  thinking: byId<HTMLSelectElement>('genThinking'),
  resolved: byId('genResolved'),
  runBtn: byId<HTMLButtonElement>('genRunBtn'),
  stopBtn: byId<HTMLButtonElement>('genStopBtn'),
  cost: byId('genCost'),
  out: byId('genOut'),
  outEmpty: byId('genOutEmpty'),
  status: byId('genStatus'),
  statusText: byId('genStatusText'),
  copyBtn: byId<HTMLButtonElement>('genCopyBtn'),
  reasonFold: byId<HTMLDetailsElement>('genReasonFold'),
  reasonSummary: byId('genReasonSummary'),
  reasonBody: byId('genReasonBody'),
  layersFold: byId<HTMLDetailsElement>('genLayersFold'),
  layersSummary: byId('genLayersSummary'),
  layers: byId('genLayers'),
  text: byId<HTMLTextAreaElement>('genText'),
  shape: byId('genShape'),
  adopt: byId('genAdopt'),
  adoptWhere: byId('genAdoptWhere'),
  adoptBtn: byId<HTMLButtonElement>('genAdoptBtn'),
  discardBtn: byId<HTMLButtonElement>('genDiscardBtn'),
  rerunBtn: byId<HTMLButtonElement>('genRerunBtn'),
};

/** 这一页自己的状态。**只有纯 UI 的东西**，数据全在后端。 */
const gen: {
  /** 当前 job 所属的层。落点校验靠它。 */
  stage: CreationStage;
  targets: GenTargetItem[];
  model?: GenModelView;
  /** 勾中的 skill 全名（带前缀）。 */
  picked: Set<string>;
  /** 当下这一份待采纳的产出。没有就是没有。 */
  draft?: GenDraftView;
  running: boolean;
} = {
  stage: 'outline',
  targets: [],
  picked: new Set(),
  running: false,
};

// ---------------------------------------------------------------- 装配

export function installGenerate(): void {
  fillJobs();
  fillThinking();

  g.job.addEventListener('change', () => {
    applyJob();
    requestTargets();
  });
  g.target.addEventListener('change', validate);
  g.manualPath.addEventListener('input', validate);
  // 换模型也要重问一遍：那一行回显的是**这个模型**的窗口，前端算不出来。
  g.model.addEventListener('change', requestTargets);

  g.manualBtn.addEventListener('click', () => {
    const open = g.manualBtn.classList.toggle('open');
    setHidden(g.manualPath, !open);
    g.target.disabled = open;
    if (open) {
      g.manualPath.focus();
    }
    validate();
  });

  g.runBtn.addEventListener('click', run);
  g.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'genStop' }));
  g.rerunBtn.addEventListener('click', run);

  g.adoptBtn.addEventListener('click', () => {
    if (gen.draft) {
      vscode.postMessage({ type: 'genAdopt', draftId: gen.draft.draftId, text: g.text.value });
    }
  });
  g.discardBtn.addEventListener('click', () => {
    if (gen.draft) {
      vscode.postMessage({ type: 'genDiscard', draftId: gen.draft.draftId });
    }
  });
  g.copyBtn.addEventListener('click', () => void navigator.clipboard?.writeText(g.text.value));

  applyJob();
}

/** 切到这一页时调一次：名单与候选都可能在别处变过了。 */
export function refreshGenerate(): void {
  renderGenModels();
  requestTargets();
}

// ---------------------------------------------------------------- 表单

function currentJob(): CreationJob {
  return g.job.value as CreationJob;
}

/** 六个 job 的选项与提示语**都从后端那份常量来**，前端不另写一份。 */
function fillJobs(): void {
  clear(g.job);
  for (const job of CREATION_JOBS) {
    const opt = make('option', undefined, JOB_LABEL[job]);
    opt.value = job;
    g.job.appendChild(opt);
  }
}

function fillThinking(): void {
  clear(g.thinking);
  const none = make('option', undefined, '不指定');
  none.value = '';
  g.thinking.appendChild(none);
  for (const depth of THINKING_DEPTHS) {
    const opt = make('option', undefined, THINKING_LABEL[depth]);
    opt.value = depth;
    g.thinking.appendChild(opt);
  }
}

/** 换了 job：提示语跟着换，目标字数那一块只对正文渲染。 */
function applyJob(): void {
  const job = currentJob();
  g.jobHint.textContent = JOB_HINT[job];
  // 只对 job=manuscript 有意义。其余时候整块摘掉，不是灰着——一个灰着的输入框
  // 只会让人想知道怎么点亮它，而答案是「这个 job 下它没有意义」。
  setHidden(g.wordsStep, job !== 'manuscript');
}

function requestTargets(): void {
  vscode.postMessage({
    type: 'genTargets',
    job: currentJob(),
    ...(g.model.value ? { model: g.model.value } : {}),
  });
}

/** 后端回的落点候选 + 这一层用哪个模型。 */
export function renderGenTargets(msg: Extract<OutMessage, { type: 'genTargets' }>): void {
  // 回话可能是上一个 job 的（作者连着拨了两下下拉框）——那一份直接丢掉，
  // 否则界面会短暂地按上一层画。
  if (msg.job !== currentJob()) {
    return;
  }
  gen.stage = msg.stage;
  gen.targets = msg.items;
  gen.model = msg.model;
  g.stageBadge.textContent = `要一个${STAGE_LABEL[msg.stage]}层的落点`;

  const previous = g.target.value;
  clear(g.target);
  for (const item of msg.items) {
    const opt = make('option', undefined, item.label);
    opt.value = item.relPath;
    // 真实路径挂在 tooltip 上：选项里显示的是人话说法，而作者偶尔要确认
    // 它到底落在哪个文件上。
    opt.title = item.relPath;
    g.target.appendChild(opt);
  }
  if (msg.items.length === 0) {
    const opt = make('option', undefined, `这个工程里还没有${STAGE_LABEL[msg.stage]}层的产物`);
    opt.value = '';
    g.target.appendChild(opt);
  }
  // 换 job 之后旧落点多半不在新名单里；在的话保住作者的选择。
  if (msg.items.some((i) => i.relPath === previous)) {
    g.target.value = previous;
  }
  g.target.disabled = msg.items.length <= 1 || g.manualBtn.classList.contains('open');

  renderResolved();
  validate();
}

/** 模型下拉：「按层自动」+ 全部可用模型。名单来自 `ViewState`。 */
export function renderGenModels(): void {
  const previous = g.model.value;
  clear(g.model);
  const auto = make('option', undefined, '按层自动');
  auto.value = '';
  g.model.appendChild(auto);
  for (const m of store.state?.models ?? []) {
    const opt = make('option', undefined, m.label);
    opt.value = m.ref;
    g.model.appendChild(opt);
  }
  g.model.value = previous;
}

/**
 * 「这一次会用哪个模型」那一行。
 *
 * **必须回显**：不写清算到了谁，等于让作者在不知道用哪个模型的情况下按下
 * 花钱的按钮。解析不出模型时它是红的，并且「生成」按钮跟着禁掉。
 */
function renderResolved(): void {
  const m = gen.model;
  clear(g.resolved);
  g.resolved.classList.toggle('err', !!m?.issue);
  if (!m) {
    return;
  }
  if (m.issue) {
    g.resolved.textContent = m.issue;
    return;
  }
  if (m.tierNote) {
    g.resolved.append(`${m.tierNote}，这一次会用 `);
  } else {
    g.resolved.append('这一次会用 ');
  }
  g.resolved.appendChild(make('b', undefined, m.label));
  g.resolved.append(` · 窗口 ${fmt(m.contextWindow)} / 输出 ${fmt(m.maxOutputTokens)}`);
}

/** 当前落点：手填框开着就用它，否则用下拉框。 */
function targetPath(): string {
  return g.manualBtn.classList.contains('open') ? g.manualPath.value.trim() : g.target.value;
}

/**
 * 落点校验。**在花钱之前就说清**——工具那三条错误路径（认不出、层对不上、
 * 落点上有东西）在这一页是表单上的一行字。
 *
 * 手填的路径这里判不了「是哪一层」（那要 `kindOfPath`，在后端），所以只提示
 * 一句「点生成时会核」，真正的判断仍在后端那一遍。
 */
function validate(): void {
  const path = targetPath();
  const manual = g.manualBtn.classList.contains('open');
  const blocked = !!gen.model?.issue;

  if (!path) {
    setCheck('err', manual ? '填一个工程内相对路径。' : '这一层还没有可落的地方。');
    g.runBtn.disabled = true;
    return;
  }
  if (manual) {
    setCheck('warn', `会当成${STAGE_LABEL[gen.stage]}层的落点来核；对不上的话点「生成」时会拦下来，不会花钱。`);
    g.runBtn.disabled = blocked;
    return;
  }
  const item = gen.targets.find((i) => i.relPath === path);
  if (item?.hasContent) {
    setCheck('warn', `${STAGE_LABEL[gen.stage]}层 · 那里已经有内容了，采纳时会让你先比对一遍`);
  } else {
    setCheck('ok', `${STAGE_LABEL[gen.stage]}层 · 那里还是空的，这一次是新写`);
  }
  g.runBtn.disabled = blocked;
}

function setCheck(kind: 'ok' | 'warn' | 'err', text: string): void {
  g.check.className = `gen-check ${kind}`;
  g.check.textContent = text;
}

// ---------------------------------------------------------------- skills

/**
 * skills 那一列。**名单一份都不写死**：来自后端推的 `skillList`，
 * 这里只挑出能交给创作模型的那些（`audience: generate`）——与后端
 * `listGenerateSkills` 同一个判据。真正的判断仍在后端跑一遍。
 */
export function renderGenSkills(): void {
  const rows = store.skillList.filter((s) => s.audience === 'generate');
  clear(g.skills);

  if (rows.length === 0) {
    // 空名单是最常见的情况（绝大多数工程不会自己写技能）。不画一个空框，
    // 而是把唯一不显然的那一条说清：要在 frontmatter 里标 audience。
    const box = make('div', 'gen-skills-empty hint');
    box.append('这个工程还没有可交给创作模型的 skill。在 ');
    box.appendChild(make('code', undefined, '.novelforge/skills/<名字>/SKILL.md'));
    box.append(' 里写一份，frontmatter 标上 ');
    box.appendChild(make('code', undefined, 'audience: generate'));
    box.append('，它就会出现在这里。');
    g.skills.appendChild(box);
    // 名单空了，之前勾的那些也就不存在了。
    gen.picked.clear();
    updateSkillCount();
    return;
  }

  // 名单变过之后，勾中但已经没了的那几个要跟着掉——留着会在点「生成」时
  // 被后端整次拒绝，而作者看不出是哪一份的问题。
  for (const name of [...gen.picked]) {
    if (!rows.some((r) => r.name === name)) {
      gen.picked.delete(name);
    }
  }

  for (const row of rows) {
    const label = make('label', 'gen-skill');
    // 带前缀的全名在 tooltip 上：行里显示全名的话，每一行都顶着一截
    // `project:`，而作者要认的是后面那一半。
    label.title = row.name;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = gen.picked.has(row.name);
    box.addEventListener('change', () => {
      if (box.checked) {
        gen.picked.add(row.name);
      } else {
        gen.picked.delete(row.name);
      }
      updateSkillCount();
    });

    const text = make('span', 'gen-skill-text');
    const name = make('span', 'gen-skill-name', row.stem);
    name.appendChild(make('span', 'gen-skill-src', row.source === 'project' ? '工程' : '内置'));
    text.appendChild(name);
    if (row.description) {
      text.appendChild(make('span', 'gen-skill-desc', row.description));
    }

    label.append(box, text);
    g.skills.appendChild(label);
  }
  updateSkillCount();
}

function updateSkillCount(): void {
  g.skillCount.textContent = gen.picked.size > 0 ? `已选 ${gen.picked.size} 份` : '未选';
}

// ---------------------------------------------------------------- 跑一次

function run(): void {
  const path = targetPath();
  if (!path) {
    return;
  }
  const job = currentJob();
  const words = Number(g.words.value);
  const depth = g.thinking.value as ThinkingDepth | '';

  // 上一份的痕迹全清掉：输出框、思考、明细、采纳栏。留着的话作者会对着
  // 上一次的正文等这一次的结果。
  gen.draft = undefined;
  g.text.value = '';
  g.reasonBody.textContent = '';
  setHidden(g.reasonFold, true);
  setHidden(g.layersFold, true);
  g.shape.textContent = '';
  setHidden(g.adopt, true);
  setHidden(g.out, false);
  setHidden(g.outEmpty, true);

  vscode.postMessage({
    type: 'genRun',
    job,
    target: path,
    ask: g.ask.value,
    ...(job === 'manuscript' && words > 0 ? { targetWords: words } : {}),
    skills: [...gen.picked],
    ...(g.model.value ? { model: g.model.value } : {}),
    ...(depth ? { thinking: depth } : {}),
  });
}

const PHASE_TEXT: Record<GenPhase, string> = {
  idle: '',
  building: '正在装配上下文…',
  thinking: '模型在想…',
  writing: '正在写…',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
};

export function setGenPhase(phase: GenPhase, message?: string): void {
  gen.running = phase === 'building' || phase === 'thinking' || phase === 'writing';
  setHidden(g.runBtn, gen.running);
  setHidden(g.stopBtn, !gen.running);
  g.cost.textContent = gen.running ? '已经在调模型了' : '这一次会调一次模型';

  const kind = gen.running ? 'running' : phase === 'done' ? 'done' : phase === 'idle' ? '' : 'err';
  g.status.className = `gen-status${kind ? ` ${kind}` : ''}`;
  // 出错时把原因原样写在状态行上：它是这一次唯一的交代，塞进 toast 五秒就没了。
  g.statusText.textContent = message ? `${PHASE_TEXT[phase]} · ${message}` : PHASE_TEXT[phase];
  if (phase !== 'idle') {
    setHidden(g.out, false);
    setHidden(g.outEmpty, true);
  }
}

export function appendGenText(text: string): void {
  g.text.value += text;
  // 只在作者没自己滚上去看的时候跟着走——他往回翻正是为了读前面那段。
  if (g.text.scrollHeight - g.text.scrollTop - g.text.clientHeight < 40) {
    g.text.scrollTop = g.text.scrollHeight;
  }
  updateShape();
}

export function appendGenReasoning(text: string): void {
  setHidden(g.reasonFold, false);
  g.reasonBody.textContent += text;
  g.reasonSummary.textContent = `思考过程 · ${g.reasonBody.textContent.length} 字`;
}

/** 流的时候只报字数；形状（「剧情 · 4/4 节」）要等后端解析完才有。 */
function updateShape(): void {
  const chars = g.text.value.replace(/\s/g, '').length;
  g.shape.textContent = `${chars} 字`;
}

export function renderGenDone(draft?: GenDraftView): void {
  gen.draft = draft;
  if (!draft) {
    setHidden(g.adopt, true);
    return;
  }

  clear(g.shape);
  if (draft.artifact) {
    g.shape.append('形状：');
    g.shape.appendChild(make('b', undefined, draft.artifact.summary));
    g.shape.append(' · ');
  }
  g.shape.append(`${draft.words} 字`);

  renderLayers(draft);
  renderAdopt(draft);
}

function renderLayers(draft: GenDraftView): void {
  if (draft.layers.length === 0) {
    setHidden(g.layersFold, true);
    return;
  }
  setHidden(g.layersFold, false);
  g.layersSummary.textContent = `装配明细 · ${fmt(draft.usedTokens)} / ${fmt(draft.budget)} token`;
  clear(g.layers);
  for (const layer of draft.layers) {
    const row = make('div', 'gen-layer');
    row.appendChild(make('span', 'n', layer.label));
    row.appendChild(make('span', 't', String(layer.tokens)));
    row.appendChild(make('span', 's', layer.note ? `${layer.status}（${layer.note}）` : layer.status));
    g.layers.appendChild(row);
  }
}

/**
 * 采纳栏。
 *
 * 解析不出这一层要的结构时**不给采纳按钮**：写一个空产物比不写更糟，
 * 作者会以为存下了。
 */
function renderAdopt(draft: GenDraftView): void {
  setHidden(g.adopt, false);
  const overwrites = !!draft.artifact?.overwrites;
  g.adopt.classList.toggle('overwrite', overwrites);
  clear(g.adoptWhere);

  if (!draft.artifact) {
    setHidden(g.adoptBtn, true);
    setHidden(g.discardBtn, true);
    g.adoptWhere.textContent =
      '这份产出解析不出这一层要的结构，没法落盘。改一改上面的正文，或者换个要求重来一次。';
    return;
  }

  setHidden(g.adoptBtn, false);
  setHidden(g.discardBtn, false);
  g.adoptBtn.textContent = overwrites ? '覆盖并写入' : '采纳并写入';
  if (overwrites) {
    g.adoptWhere.append('将');
    g.adoptWhere.appendChild(make('b', undefined, '覆盖'));
    g.adoptWhere.append(' ');
    g.adoptWhere.appendChild(make('code', undefined, draft.relPath));
    g.adoptWhere.append('，写之前还会让你逐行比对一遍');
  } else {
    g.adoptWhere.append('将写入 ');
    g.adoptWhere.appendChild(make('code', undefined, draft.relPath));
  }
}

/** 落盘的结论。写成了就把采纳栏收掉——那一份已经不在手上了。 */
export function onGenAdopted(relPath: string | undefined, message: string): void {
  if (relPath) {
    gen.draft = undefined;
    setHidden(g.adopt, true);
    setGenPhase('done', message);
    return;
  }
  // 没写成（作者点了「不采纳」，或者解析不出、被网关拦下）。原样说一句就够，
  // 上面那份正文留着——他可能还想改改再试。
  g.adoptWhere.textContent = message;
  if (!gen.draft) {
    setHidden(g.adopt, true);
  }
}
