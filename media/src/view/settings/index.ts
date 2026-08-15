/**
 * 设置页的装配：收后端推来的设置、渲染、保存。
 */
import { byId, maybeById } from '../../dom';
import { DEFAULT_AGENT_POLICY, MODEL_TIERS, isAgentPolicy } from '../../protocol';
import type { SettingsPayload } from '../../protocol';
import { vscode } from '../store';
import { toast } from '../toast';
import { allRefs, draft, touch, validateProviders } from './draft';
import { NUMERIC_FIELDS } from './presets';
import type { NumericField } from './presets';
import { bindOpenModal, renderProviders } from './providerList';
import { installProviderModal, openProviderModal, refreshProviderModal } from './providerModal';
import { renderTaskTiers } from './taskTiers';

type SettingsCategory = 'models' | 'context';

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = ['models', 'context'];

export function renderSettings(
  settings: SettingsPayload,
  keys: Record<string, boolean> | undefined,
  ack: 'saved' | 'rejected' | undefined
): void {
  const nextKeys = keys || {};

  // 保存成功的回执：磁盘上已是用户的版本，可以清掉本地编辑状态。
  // 被拒（ack === 'rejected'）则保持 dirty，别把用户刚填的东西冲掉。
  if (ack === 'saved') {
    draft.dirty = false;
  }

  if (draft.dirty) {
    // 有未保存的编辑，不能拿磁盘上的值覆盖。但 Key 状态得更新——
    // 用户刚在弹窗里输完 Key 就等着看这个。
    if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) {
      draft.keys = nextKeys;
      renderProviders();
      refreshProviderModal();
    }
    return;
  }

  draft.providers = JSON.parse(JSON.stringify(settings.providers || []));
  draft.models = [...(settings.models || [])];
  draft.tierModels = {
    fast: [...(settings.tierModels?.fast || [])],
    balanced: [...(settings.tierModels?.balanced || [])],
    quality: [...(settings.tierModels?.quality || [])],
  };
  draft.taskTiers = { ...(settings.taskTiers || {}) };
  draft.keys = nextKeys;
  for (const [key, id] of Object.entries(NUMERIC_FIELDS)) {
    const node = maybeById<HTMLInputElement>(id);
    if (node) {
      node.value = String(settings[key as NumericField]);
    }
  }
  const policy = maybeById<HTMLSelectElement>(AGENT_POLICY_FIELD);
  if (policy) {
    policy.value = isAgentPolicy(settings.agentPolicy) ? settings.agentPolicy : DEFAULT_AGENT_POLICY;
  }
  renderProviders();
  renderTaskTiers();
  renderAgentModelHint();
  refreshProviderModal();
}

/** 设置页上那个策略下拉框的 id。读、写、绑事件三处共用。 */
const AGENT_POLICY_FIELD = 'setAgentPolicy';

/**
 * 「哪些模型能给 Agent 当调度」那一行。
 *
 * 一个都没勾时**说清楚该去哪勾**，而不是只报一句「没有可用模型」——那句话
 * 作者读完还是不知道要做什么。回落行为也一并说明：它会用对话页那个模型，
 * 所以 Agent 现在就能跑，勾选只是让他能挑一个更合适的。
 */
function renderAgentModelHint(): void {
  const box = maybeById<HTMLElement>('agentModelHint');
  if (!box) {
    return;
  }
  const capable = draft.providers.flatMap((p) =>
    p.models.filter((m) => m.supportsTools === true).map((m) => `${p.id}/${m.name}`)
  );
  box.textContent =
    capable.length > 0
      ? `可用作 Agent 调度的模型：${capable.join('、')}。实际用哪个由「任务档位」里的「Agent 调度」那一档决定。`
      : '还没有标记为支持工具调用的模型。在上面的服务商配置里给模型勾上「支持工具调用」，Agent 才能挑它当调度模型；' +
        '在此之前 Agent 会沿用对话页选定的那个模型。';
}

function save(): void {
  const settings = {
    providers: draft.providers,
    models: draft.models,
    tierModels: draft.tierModels,
    taskTiers: draft.taskTiers,
  } as SettingsPayload;
  for (const [key, id] of Object.entries(NUMERIC_FIELDS)) {
    settings[key as NumericField] = Number(byId<HTMLInputElement>(id).value);
  }
  // 认不出的值回落默认——后端也会再兜一次，两边都不因为一个手改坏的值而炸。
  const picked = maybeById<HTMLSelectElement>(AGENT_POLICY_FIELD)?.value;
  settings.agentPolicy = isAgentPolicy(picked) ? picked : DEFAULT_AGENT_POLICY;
  const problem = validateProviders(draft.providers);
  if (problem) {
    toast(problem, true);
    return;
  }

  // 列表里指向已删模型的项要摘掉，而不是保存一串指向空气的引用；
  // 全摘光了退回第一个可用的，别让工程页任务无模型可用。
  const refs = allRefs();
  settings.models = draft.models.filter((m) => refs.includes(m));
  if (settings.models.length === 0 && refs.length > 0) {
    settings.models = [refs[0]];
  }
  if (settings.models.length !== draft.models.length) {
    toast('默认模型列表里有已删除的模型，已自动摘掉。');
  }

  // 档位清单同样摘掉指向已删模型的项，但**摘空了就让它空着**——
  // 空档位是有意义的（沿用默认模型），不该像默认模型那样兜底塞一个进去。
  let droppedFromTiers = 0;
  settings.tierModels = { fast: [], balanced: [], quality: [] };
  for (const tier of MODEL_TIERS) {
    const kept = draft.tierModels[tier].filter((m) => refs.includes(m));
    droppedFromTiers += draft.tierModels[tier].length - kept.length;
    settings.tierModels[tier] = kept;
  }
  if (droppedFromTiers > 0) {
    toast(`档位里有 ${droppedFromTiers} 个已删除的模型，已自动摘掉。`);
  }

  vscode.postMessage({ type: 'saveSettings', settings });
}

export function installSettings(): void {
  bindOpenModal(openProviderModal);
  installProviderModal();
  installCategoryTabs();
  installAdvancedToggle();

  for (const id of Object.values(NUMERIC_FIELDS)) {
    maybeById(id)?.addEventListener('input', touch);
  }
  maybeById(AGENT_POLICY_FIELD)?.addEventListener('change', touch);

  byId('saveSettingsBtn').addEventListener('click', save);
  // 能力探测：只有带原生设置界面的宿主（VS Code）才渲染这颗按钮，
  // 独立版的页面里根本没有它——不是渲染出来再 hidden 掉。
  maybeById('nativeSettingsBtn')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );
}

/**
 * 「高级设置」折叠开关：默认收起模型分档/任务档位/请求与调度。
 * 展开状态是纯 UI 状态，留在前端；重启后回到默认折叠。
 */
function installAdvancedToggle(): void {
  const toggle = maybeById<HTMLButtonElement>('settingsAdvancedToggle');
  const box = maybeById('settingsAdvanced');
  if (!toggle || !box) {
    return;
  }
  const sync = () => {
    const open = !box.hidden;
    toggle.setAttribute('aria-expanded', String(open));
    const caret = toggle.querySelector('.caret');
    if (caret) {
      caret.textContent = open ? '▾' : '▸';
    }
  };
  toggle.addEventListener('click', () => {
    box.hidden = !box.hidden;
    sync();
  });
  sync();
}

function showCategory(category: SettingsCategory, focus = false): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
    const active = button.dataset.settingsTab === category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) {
      button.focus();
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    const active = panel.dataset.settingsPanel === category;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
}

function installCategoryTabs(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')];
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const category = button.dataset.settingsTab as SettingsCategory | undefined;
      if (category && SETTINGS_CATEGORIES.includes(category)) {
        showCategory(category);
      }
    });
    button.addEventListener('keydown', (event) => {
      const current = SETTINGS_CATEGORIES.indexOf(button.dataset.settingsTab as SettingsCategory);
      let next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
      if (event.key === 'ArrowRight') next = (current + 1) % SETTINGS_CATEGORIES.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = SETTINGS_CATEGORIES.length - 1;
      if (next !== current) {
        event.preventDefault();
        showCategory(SETTINGS_CATEGORIES[next], true);
      }
    });
  }
  showCategory('models');
}
