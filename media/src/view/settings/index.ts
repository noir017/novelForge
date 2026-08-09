/**
 * 设置页的装配：收后端推来的设置、渲染、保存。
 */
import { byId, maybeById } from '../../dom';
import type { SettingsPayload } from '../../protocol';
import { vscode } from '../store';
import { toast } from '../toast';
import { allRefs, draft, touch, validateProviders } from './draft';
import { BUDGET_FIELDS } from './presets';
import type { BudgetField } from './presets';
import { bindOpenModal, renderProviders } from './providerList';
import { installProviderModal, openProviderModal, refreshProviderModal } from './providerModal';

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
  draft.model = settings.model || '';
  draft.keys = nextKeys;
  for (const [key, id] of Object.entries(BUDGET_FIELDS)) {
    const node = maybeById<HTMLInputElement>(id);
    if (node) {
      node.value = String(settings[key as BudgetField]);
    }
  }
  renderProviders();
  refreshProviderModal();
}

function save(): void {
  const settings = { providers: draft.providers, model: draft.model } as SettingsPayload;
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

  // 当前选中的模型如果已经被删掉了，退回第一个可用的，
  // 而不是保存一个指向空气的引用。
  const refs = allRefs();
  if (!refs.includes(settings.model)) {
    settings.model = refs[0] || '';
  }
  vscode.postMessage({ type: 'saveSettings', settings });
}

export function installSettings(): void {
  bindOpenModal(openProviderModal);
  installProviderModal();

  const defaultModel = maybeById<HTMLSelectElement>('setDefaultModel');
  defaultModel?.addEventListener('change', () => {
    draft.model = defaultModel.value;
    touch();
  });

  for (const id of Object.values(BUDGET_FIELDS)) {
    maybeById(id)?.addEventListener('input', touch);
  }

  byId('saveSettingsBtn').addEventListener('click', save);
  byId('nativeSettingsBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );
}
