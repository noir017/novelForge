/**
 * 设置页的装配：收后端推来的设置、渲染、保存。
 */
import { byId, maybeById } from '../../dom';
import { MODEL_TIERS } from '../../protocol';
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
  renderProviders();
  renderTaskTiers();
  refreshProviderModal();
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

  byId('saveSettingsBtn').addEventListener('click', save);
  byId('nativeSettingsBtn').addEventListener('click', () =>
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
