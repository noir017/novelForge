/**
 * 设置页的装配：收后端推来的设置、渲染、保存。
 */
import { byId, maybeById } from '../../dom';
import { MODEL_TIERS } from '../../protocol';
import type { SettingsPayload } from '../../protocol';
import { vscode } from '../store';
import { toast } from '../toast';
import { allRefs, draft, touch, validateProviders } from './draft';
import { BUDGET_FIELDS } from './presets';
import type { BudgetField } from './presets';
import { bindOpenModal, renderProviders } from './providerList';
import { installProviderModal, openProviderModal, refreshProviderModal } from './providerModal';
import { renderTaskTiers } from './taskTiers';

/** 上下文窗口的下限，与 package.json 里的 minimum 一致。 */
const MIN_CONTEXT_WINDOW = 4000;

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
  for (const [key, id] of Object.entries(BUDGET_FIELDS)) {
    const node = maybeById<HTMLInputElement>(id);
    if (node) {
      node.value = String(settings[key as BudgetField]);
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
  for (const [key, id] of Object.entries(BUDGET_FIELDS)) {
    settings[key as BudgetField] = Number(byId<HTMLInputElement>(id).value);
  }

  if (!Number.isFinite(settings.contextWindow) || settings.contextWindow < MIN_CONTEXT_WINDOW) {
    toast(`上下文窗口至少 ${MIN_CONTEXT_WINDOW}。`, true);
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

  for (const id of Object.values(BUDGET_FIELDS)) {
    maybeById(id)?.addEventListener('input', touch);
  }

  byId('saveSettingsBtn').addEventListener('click', save);
  byId('nativeSettingsBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );
}
