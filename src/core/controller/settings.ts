import type { ChatController } from './index';
import {
  normalizeAgentPolicy,
  normalizeModelList,
  normalizeTaskTiers,
  normalizeTierModels,
  promoteModel,
  updateSettings,
  readConfig,
} from '../config';
import { describeTierConfig } from '../model/tiers';
import { AGENT_POLICY_LABEL } from '../model/agentPolicy';
import { apiKeyStatus, pruneApiKeys } from '../llm/registry';
import {
  describeModelIssue,
  normalizeProviders,
  resolveModelRef,
} from '../model/providers';
import { SerializedProvider, SettingsPayload } from '../protocol';
import { testConnection as runConnectionTest } from '../features/creation';
import { scoped } from '../runtime/logger';

const log = scoped('面板');

/** 设置页。字段只给 controller/ 同包用。 */

export async function pushSettings(c: ChatController, ack?: 'saved' | 'rejected'): Promise<void> {
  const cfg = readConfig();
  c.post({
    type: 'settings',
    ack,
    settings: {
      providers: cfg.providers.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => ({
          name: m.name,
          label: m.label,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          supportsTools: m.supportsTools,
        })),
      })),
      models: cfg.models,
      tierModels: cfg.tierModels,
      taskTiers: cfg.taskTiers,
      temperature: cfg.temperature,
      recentChaptersFullText: cfg.recentChaptersFullText,
      prevChapterTailChars: cfg.prevChapterTailChars,
      summaryBatchSize: cfg.summaryBatchSize,
      requestTimeoutMs: cfg.requestTimeoutMs,
      concurrency: cfg.concurrency,
      fallbackAttempts: cfg.fallbackAttempts,
      agentPolicy: cfg.agentPolicy,
    },
    keys: await apiKeyStatus(cfg.providers),
  });
}

export async function saveSettings(c: ChatController, s: SettingsPayload): Promise<void> {
  const before = readConfig().providers.map((p) => p.id);
  const providers = normalizeProviders(s.providers);
  if (s.providers.length > 0 && providers.length === 0) {
    log.error(
      '设置未保存：服务商配置不合法',
      'id 不能为空或含斜杠，且每个服务商至少要有一个模型。前端已收到 rejected 回执，编辑内容保留。'
    );
    c.toast('服务商配置不合法：id 不能为空或含斜杠，且每个服务商至少要有一个模型。', 'error');
    // 回执必须发——前端据此知道这次没落盘，从而保住未保存的编辑。
    await pushSettings(c, 'rejected');
    return;
  }

  const models = normalizeModelList(s.models);
  // 档位清单与 models 同样容错：去空、去重、保序，认不出的档位名丢弃。
  const tierModels = normalizeTierModels(s.tierModels);
  const taskTiers = normalizeTaskTiers(s.taskTiers);
  await updateSettings({
    providers,
    // 列表是唯一真相；updateSettings 会顺手把 model 对齐到首项。
    models,
    model: models[0] ?? '',
    tierModels,
    taskTiers,
    temperature: s.temperature,
    recentChaptersFullText: s.recentChaptersFullText,
    prevChapterTailChars: s.prevChapterTailChars,
    summaryBatchSize: s.summaryBatchSize,
    requestTimeoutMs: s.requestTimeoutMs,
    concurrency: s.concurrency,
    fallbackAttempts: s.fallbackAttempts,
    // 认不出的策略名回落默认，与其它字段一样容错。
    agentPolicy: normalizeAgentPolicy(s.agentPolicy),
  });

  // 删掉的服务商不该在钥匙串里留下孤儿 Key。
  await pruneApiKeys(providers, before);

  log.info(
    '设置已保存',
    `${providers.length} 个服务商｜默认模型 ${models.join('、') || '（未选）'}｜` +
      `${describeTierConfig(tierModels, taskTiers)}｜` +
      `温度 ${s.temperature}｜超时 ${s.requestTimeoutMs}ms｜` +
      `并发 ${s.concurrency}｜换模型重试 ${s.fallbackAttempts} 次｜` +
      `Agent 策略 ${AGENT_POLICY_LABEL[normalizeAgentPolicy(s.agentPolicy)]}`
  );
  await pushSettings(c, 'saved');
  await c.pushState();
  c.toast('设置已保存。');
}

/**
 * 输入框旁边的模型下拉框。只改选中项，不动服务商列表。
 *
 * 「默认模型列表」是唯一真相，所以这里不是覆盖某个字段，而是**把选中的
 * 模型提到列表头**——设置页里排的顺序其余部分原样保留。
 */
export async function selectModel(c: ChatController, ref: string): Promise<void> {
  const config = readConfig();
  if (!resolveModelRef(config.providers, ref)) {
    const issue = describeModelIssue(config.providers, ref);
    log.error(`切换模型失败：${issue}`, `请求的引用 ${ref}`);
    c.toast(issue, 'error');
    await c.pushState();
    return;
  }
  const models = await promoteModel(ref);
  log.info(`已切换到模型 ${ref}`, models.length > 1 ? `默认模型列表：${models.join('、')}` : undefined);
  await c.pushState();
  // 设置页开着时，列表顺序变了要立刻看得见。
  await pushSettings(c);
}

export async function testConnection(
  c: ChatController,
  ref?: string,
  provider?: SerializedProvider
): Promise<void> {
  const target = ref ?? readConfig().model;
  // 设置页传来的草稿同样走一遍容错归一化——手改过的字段不该让测试崩掉。
  const draft = provider ? normalizeProviders([provider])[0] : undefined;
  c.toast(`正在测试 ${target}…`);
  const result = await runConnectionTest(ref, draft);
  c.toast(result.message, result.ok ? 'info' : 'error');
  await c.pushState();
}
