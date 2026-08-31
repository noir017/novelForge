import type { ChatController } from './index';
import {
  normalizeAgentPolicy,
  normalizeModelList,
  normalizeSkillModes,
  normalizeTaskTiers,
  normalizeTierModels,
  promoteModel,
  updateSettings,
  readConfig,
} from '../config';
import { describeTierConfig } from '../model/tiers';
import { AGENT_POLICY_LABEL } from '../model/agentPolicy';
import { SKILL_MODE_LABEL } from '../model/skillMode';
import type { SkillModes } from '../model/skillMode';
import type { NovelProject } from '../model/project';
import { listSkillRows, withDescriptions } from './skills';
import { apiKeyStatus, pruneApiKeys } from '../llm/registry';
import {
  describeModelIssue,
  normalizeProviders,
  resolveModelRef,
} from '../model/providers';
import { OutMessage, SerializedProvider, SettingsPayload } from '../protocol';
import { testConnection as runConnectionTest } from '../features/creation';
import { scoped } from '../runtime/logger';

const log = scoped('面板');

/** 设置读写不依赖 NovelProject：空窗口也能打开设置页。 */
export interface SettingsSink {
  post(message: OutMessage): void;
  toast(message: string, level?: 'info' | 'error'): void;
}

/** 设置页。字段只给 controller/ 同包用。 */

/**
 * 推一份设置。
 *
 * `project` 只用来扫**工程技能**（`.novelforge/skills/`）——设置本身与工程无关
 * （存在 `~/.novelforge/config.json`），空窗口里那一段就只有内置技能。
 */
export async function pushSettingsTo(
  sink: SettingsSink,
  ack?: 'saved' | 'rejected',
  project?: NovelProject
): Promise<void> {
  const cfg = readConfig();
  sink.post({
    type: 'settings',
    ack,
    settings: {
      providers: cfg.providers.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl,
        thinkingStyle: p.thinkingStyle,
        models: p.models.map((m) => ({
          name: m.name,
          label: m.label,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
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
      skillModes: cfg.skillModes,
      debug: cfg.debug,
    },
    keys: await apiKeyStatus(cfg.providers),
    // 技能那张表**每次都重扫**：作者可能刚在 `.novelforge/skills/` 下加了一份。
    // 描述在这里一并补齐（`listSkills` 只给 `full` 档读盘，而这张表每一行都要
    // 显示描述——那正是作者判断某份技能值不值得开到「完整」的依据）。
    skills: await withDescriptions(project, await listSkillRows(project, cfg.skillModes)),
  });
}

export async function pushSettings(c: ChatController, ack?: 'saved' | 'rejected'): Promise<void> {
  await pushSettingsTo(c, ack, c.project);
}

export async function saveSettingsFrom(
  s: SettingsPayload,
  sink: SettingsSink,
  afterSave?: () => Promise<void>,
  project?: NovelProject
): Promise<void> {
  const before = readConfig().providers.map((p) => p.id);
  const providers = normalizeProviders(s.providers);
  if (s.providers.length > 0 && providers.length === 0) {
    log.error(
      '设置未保存：服务商配置不合法',
      'id 不能为空或含斜杠，且每个服务商至少要有一个模型。前端已收到 rejected 回执，编辑内容保留。'
    );
    sink.toast('服务商配置不合法：id 不能为空或含斜杠，且每个服务商至少要有一个模型。', 'error');
    // 回执必须发——前端据此知道这次没落盘，从而保住未保存的编辑。
    await pushSettingsTo(sink, 'rejected', project);
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
    // 技能档位同样容错：认不出的档位名丢弃，那一项回落缺省（仅用户）。
    skillModes: normalizeSkillModes(s.skillModes),
    // 与 readConfig 同一条规矩：只认真正的 true。
    debug: s.debug === true,
  });

  // 删掉的服务商不该在钥匙串里留下孤儿 Key。
  await pruneApiKeys(providers, before);

  log.info(
    '设置已保存',
    `${providers.length} 个服务商｜默认模型 ${models.join('、') || '（未选）'}｜` +
      `${describeTierConfig(tierModels, taskTiers)}｜` +
      `温度 ${s.temperature}｜超时 ${s.requestTimeoutMs}ms｜` +
      `并发 ${s.concurrency}｜换模型重试 ${s.fallbackAttempts} 次｜` +
      `Agent 策略 ${AGENT_POLICY_LABEL[normalizeAgentPolicy(s.agentPolicy)]}｜` +
      describeSkillModes(normalizeSkillModes(s.skillModes)) +
      // 单独说一句而不是混进上面那串：它开着的时候工程里会多出一批文件，
      // 这件事值得在日志里一眼看见。
      `${s.debug === true ? '｜调试模式已开启（完整上下文会落盘）' : ''}`
  );
  await pushSettingsTo(sink, 'saved', project);
  if (afterSave) {
    await afterSave();
  }
  sink.toast('设置已保存。');
}

/**
 * 技能档位那一句日志。**只说与缺省不同的那几个**——缺省是「仅用户」，而绝大多数
 * 技能都停在那一档，全列出来只会把这行日志撑成一屏。
 */
function describeSkillModes(modes: SkillModes): string {
  const entries = Object.entries(modes);
  if (entries.length === 0) {
    return '技能全部按缺省（仅用户）';
  }
  return `技能 ${entries.map(([name, mode]) => `${name}=${SKILL_MODE_LABEL[mode]}`).join('、')}`;
}

export async function saveSettings(c: ChatController, s: SettingsPayload): Promise<void> {
  await saveSettingsFrom(s, c, () => c.pushState(), c.project);
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
  await testConnectionTo(c, ref, provider, () => c.pushState());
}

export async function testConnectionTo(
  sink: SettingsSink,
  ref?: string,
  provider?: SerializedProvider,
  after?: () => Promise<void>
): Promise<void> {
  const target = ref ?? readConfig().model;
  const draft = provider ? normalizeProviders([provider])[0] : undefined;
  sink.toast(`正在测试 ${target}…`);
  const result = await runConnectionTest(ref, draft);
  sink.toast(result.message, result.ok ? 'info' : 'error');
  if (after) {
    await after();
  }
}
