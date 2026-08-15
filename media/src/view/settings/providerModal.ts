/**
 * 服务商配置弹窗。
 *
 * 两种模式：
 * - `edit` 直接改 draft 里已有的那个对象（改完即生效，关窗只是收起来）；
 * - `add` 编辑一个临时对象，**确认后才写入 draft**——半路取消不该留下残骸。
 *
 * 因此 `editorTouch()` 只在 edit 模式下把 draft 标脏：add 模式下改临时对象
 * 与磁盘上的配置无关，标脏了 dirty 就再也清不掉。
 */
import { el as mk, setHidden } from '../../dom';
import type { SerializedModel, SerializedProvider } from '../../protocol';
import { linkBtn, primaryBtn, secondaryBtn } from '../buttons';
import { el } from '../refs';
import { vscode } from '../store';
import { toast } from '../toast';
import { draft, touch, uniqueId, validateProviders } from './draft';
import { compactCheck, compactField, compactNumber, textField } from './fields';
import { KIND_LABEL, PRESETS } from './presets';
import { renderProviders } from './providerList';

type ModalMode = 'edit' | 'add' | null;

let mode: ModalMode = null;
/** edit 模式下正在编辑的服务商 id。 */
let editingId: string | null = null;
/** add 模式下的临时服务商，确认添加后才进 draft。 */
let temp: SerializedProvider | null = null;

export function openProviderModal(id: string): void {
  const p = draft.providers.find((x) => x.id === id);
  if (!p) {
    return;
  }
  mode = 'edit';
  editingId = id;
  fill(p);
  setHidden(el.providerModal, false);
}

export function openAddModal(): void {
  mode = 'add';
  temp = { id: uniqueId('provider'), kind: 'openai', baseUrl: '', models: [{ name: '' }] };
  fill(temp);
  setHidden(el.providerModal, false);
}

export function closeProviderModal(): void {
  if (mode === null) {
    return;
  }
  mode = null;
  editingId = null;
  temp = null;
  setHidden(el.providerModal, true);
  el.providerModalBody.innerHTML = '';
  // 弹窗里改过的名字、模型数要反映回卡片。
  renderProviders();
}

/** draft.providers 被整体替换后（外部刷新 / Key 变更），把弹窗重绑到新对象上。 */
export function refreshProviderModal(): void {
  if (mode === 'edit') {
    const p = draft.providers.find((x) => x.id === editingId);
    if (p) {
      fill(p);
    } else {
      closeProviderModal();
    }
  } else if (mode === 'add' && temp) {
    // 临时对象不在 draft 里，原样重建，只刷新 Key 状态等。
    fill(temp);
  }
}

function fill(p: SerializedProvider): void {
  el.providerModalTitle.textContent = mode === 'add' ? '添加服务商' : `配置 · ${p.label || p.id}`;
  const body = el.providerModalBody;
  body.innerHTML = '';

  // 添加弹窗顶部放预设，点一下直接填入整套配置。
  if (mode === 'add') {
    body.appendChild(buildPresetRow());
  }
  body.appendChild(buildProviderEditor(p));

  const foot = mk('div', 'modal-foot');
  if (mode === 'add') {
    foot.appendChild(primaryBtn('确认添加', confirmAdd));
    foot.appendChild(secondaryBtn('取消', closeProviderModal));
  } else {
    foot.appendChild(secondaryBtn('完成', closeProviderModal));
  }
  body.appendChild(foot);
}

function buildPresetRow(): HTMLElement {
  const row = mk('div', 'modal-presets');
  row.appendChild(mk('span', 'meta', '从预设填入：'));
  for (const preset of PRESETS) {
    const btn = mk('button', 'chip-btn', preset.label ?? preset.id);
    btn.title = preset.baseUrl || KIND_LABEL[preset.kind];
    btn.addEventListener('click', () => applyPreset(preset));
    row.appendChild(btn);
  }
  return row;
}

/** 点预设：用预设配置替换临时对象内容，仍可继续微调。 */
function applyPreset(preset: SerializedProvider): void {
  if (!temp) {
    return;
  }
  const copy: SerializedProvider = JSON.parse(JSON.stringify(preset));
  temp.id = uniqueId(preset.id);
  temp.label = copy.label;
  temp.kind = copy.kind;
  temp.baseUrl = copy.baseUrl;
  temp.models = copy.models;
  fill(temp);
}

function confirmAdd(): void {
  const p = temp;
  if (!p) {
    return;
  }
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

/** add 模式下编辑的是临时对象，不能把 draft 标脏，否则 dirty 清不掉。 */
function editorTouch(): void {
  if (mode === 'edit') {
    touch();
  }
}

/** 弹窗里的完整编辑器。 */
function buildProviderEditor(p: SerializedProvider): HTMLElement {
  const card = mk('div', 'provider-block');

  const head = mk('div', 'provider-head');
  const title = mk('span', 'provider-title', p.label || p.id);
  head.appendChild(title);
  head.appendChild(mk('span', 'meta', KIND_LABEL[p.kind] || p.kind));
  card.appendChild(head);

  /** 名字一变，卡片标题与弹窗标题都要跟着走。 */
  const syncTitle = () => {
    title.textContent = p.label || p.id;
    if (mode === 'edit') {
      el.providerModalTitle.textContent = `配置 · ${p.label || p.id}`;
    }
  };

  const modelBox = mk('div', 'model-list');
  const renderModelRows = () => {
    modelBox.innerHTML = '';
    for (const m of p.models) {
      modelBox.appendChild(buildModelRow(p, m, renderModelRows));
    }
  };

  const row = mk('div', 'grid');
  row.appendChild(
    textField('前缀 id', p.id, '不能含斜杠', (v) => {
      p.id = v.trim();
      if (mode === 'edit') {
        editingId = p.id;
      }
      syncTitle();
      editorTouch();
      // 模型行上显示的是完整引用 `前缀/模型名`，前缀变了要一起刷新。
      renderModelRows();
    })
  );
  row.appendChild(
    textField('显示名', p.label || '', '可留空', (v) => {
      p.label = v.trim() || undefined;
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

  const modelsHead = mk('div', 'provider-head');
  modelsHead.appendChild(mk('span', 'meta', p.kind === 'vscode-lm' ? '模型 family' : '模型'));
  modelsHead.appendChild(
    linkBtn('＋ 添加模型', () => {
      p.models.push({ name: '' });
      editorTouch();
      renderModelRows();
    })
  );
  card.appendChild(modelsHead);

  card.appendChild(modelBox);
  renderModelRows();

  card.appendChild(p.kind === 'vscode-lm' ? buildLmHint() : buildKeyRow(p));
  return card;
}

function buildLmHint(): HTMLElement {
  return mk(
    'div',
    'hint',
    '复用 GitHub Copilot 订阅，无需 API Key。模型有硬性输入配额，装配器会自动收紧预算。'
  );
}

/** API Key 从不回显，这里只显示「有没有」，设置与清除都走宿主。 */
function buildKeyRow(p: SerializedProvider): HTMLElement {
  const keyRow = mk('div', 'key-row');
  const has = !!draft.keys[p.id];
  const status = mk('span', 'key-status', has ? '✓ 已保存 API Key' : '未设置 API Key');
  status.classList.toggle('set', has);
  keyRow.appendChild(status);
  keyRow.appendChild(
    secondaryBtn('设置 Key', () => vscode.postMessage({ type: 'setApiKey', providerId: p.id }))
  );
  keyRow.appendChild(
    secondaryBtn('清除', () => vscode.postMessage({ type: 'clearApiKey', providerId: p.id }))
  );
  return keyRow;
}

function buildModelRow(
  p: SerializedProvider,
  m: SerializedModel,
  rerender: () => void
): HTMLElement {
  const row = mk('div', 'model-row');

  const ref = mk('code', 'model-ref');
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
  // Agent 的调度模型只从勾过这一项的模型里挑。不做自动探测——探测要真发一次
  // 带 tools 的请求，那是在你没点任何东西的时候花钱。
  row.appendChild(
    compactCheck(
      '支持工具调用',
      m.supportsTools,
      '勾上这个模型才会被 Agent 用作调度模型。不支持工具调用的模型在 Agent 那条路上只会莫名其妙地失败。',
      (v) => {
        m.supportsTools = v;
        editorTouch();
      }
    )
  );

  const tail = mk('div', 'model-tail');
  tail.appendChild(ref);
  tail.appendChild(linkBtn('测试', () => testModel(p, m)));
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

/**
 * 把屏幕上这份服务商一起发过去，测的就是眼前这份配置——新加的模型、
 * 刚改的 baseUrl 不必先保存也能验。API Key 仍取已保存的：它从不回显，
 * 草稿里也就没有。
 */
function testModel(p: SerializedProvider, m: SerializedModel): void {
  if (!m.name) {
    toast('先填模型名。', true);
    return;
  }
  vscode.postMessage({
    type: 'testConnection',
    ref: `${p.id}/${m.name}`,
    provider: JSON.parse(JSON.stringify(p)),
  });
}

export function installProviderModal(): void {
  el.providerModalClose.addEventListener('click', closeProviderModal);
  el.providerModal.addEventListener('click', (e) => {
    // 只有点遮罩本身才算关闭，点弹窗内容不算。
    if (e.target === el.providerModal) {
      closeProviderModal();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeProviderModal();
    }
  });
  el.addProviderBtn.addEventListener('click', openAddModal);
}
