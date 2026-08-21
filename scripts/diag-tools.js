/**
 * 排查「agent 一步就停、一个工具都不调」的现场脚本。
 *
 * agent 停下来的判据只有一条：**这一回合模型没有返回 tool_use**（`loop.ts` 里
 * `result.toolCalls.length === 0` 就当成「它给出了最终回答」）。所以一步就停有
 * 三种完全不同的成因，而界面上长得一模一样：
 *
 * 1. 我们**没把 tools 发出去**（本地 bug）；
 * 2. 发出去了，**上游把它吞了**（网关的协议转换、或模型压根不支持工具）；
 * 3. 发出去了、上游也认，但**返回里的 tool_use 我们没解析出来**（解析 bug）。
 *
 * 这个脚本把三种分开：它劫持 `fetch`，一边打印真实请求体里到底带没带
 * `tools` / `tool_choice`，一边把 SSE 原样计数（有几个 `content_block_start`、
 * 是什么类型的块），最后再看 provider 交出来的 `toolCall` 事件有几个。
 *
 * 走的是**真实的那条路**：真实 provider、真实 `AGENT_SYSTEM`、真实的七个工具
 * 规格。会真的花钱（每档一次请求，约三千 token 输入）。
 *
 * 用法：node scripts/diag-tools.js [模型引用] [思考深度]
 *   思考深度 = off | low | medium | high | max（缺省把 off 与 medium 都跑一遍）
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return { window: {}, workspace: {}, commands: {}, Uri: {} };
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const { ResponsesProvider } = loadModule('src/core/llm/responsesProvider.ts');
const { ChatCompletionsProvider } = loadModule('src/core/llm/chatCompletionsProvider.ts');
const { AnthropicProvider } = loadModule('src/core/llm/anthropicProvider.ts');
const P = loadModule('src/core/model/providers.ts');
const { NOVEL_TOOLS } = loadModule('src/core/tools/novel/index.ts');
const { AGENT_SYSTEM } = loadModule('src/core/agent/loop.ts');

const HOME = path.join(os.homedir(), '.novelforge');

/** 与 core/llm/registry.ts 的分发同源：一条协议一个分支，不写「不是 A 就是 B」。 */
function buildProvider(active, baseUrl, key) {
  switch (active.profile.kind) {
    case 'anthropic':
      return new AnthropicProvider(baseUrl, active.model.name, key);
    case 'openai-responses':
      return new ResponsesProvider(baseUrl, active.model.name, key);
    default:
      return new ChatCompletionsProvider(
        baseUrl,
        active.model.name,
        key,
        active.profile.thinkingStyle
      );
  }
}
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

/** 七个工具的规格，与 `ToolRegistry.specs()` 逐字段一致（不需要 ToolEnv）。 */
const SPECS = NOVEL_TOOLS.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));

/**
 * 劫持 fetch：请求体只报**形状**（工具名、字段名），不打正文与 Key；
 * 响应流原样透传给 provider，同时另抄一份数 SSE 事件。
 */
function spyFetch() {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const rec = {
      url: String(url),
      headers: Object.keys((init && init.headers) || {}).filter((h) => h.toLowerCase() !== 'x-api-key'),
      betaHeader: (init && init.headers && init.headers['anthropic-beta']) || undefined,
      bodyKeys: Object.keys(body),
      tools: Array.isArray(body.tools) ? body.tools.map((t) => t.name) : undefined,
      schemaField: Array.isArray(body.tools) && body.tools[0]
        ? Object.keys(body.tools[0]).join('+') : undefined,
      toolChoice: body.tool_choice,
      thinking: body.thinking,
      outputConfig: body.output_config,
      maxTokens: body.max_tokens,
      events: {},
      blocks: [],
      stopReason: undefined,
      status: 0,
    };
    seen.push(rec);
    const res = await real(url, init);
    rec.status = res.status;
    if (!res.ok || !res.body) return res;

    const [toProvider, toSpy] = res.body.tee();
    (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      const reader = toSpy.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          if (process.env.NF_DIAG_RAW) console.log(`      ‹raw› ${raw.slice(0, 400)}`);
          let ev;
          try { ev = JSON.parse(raw); } catch { continue; }
          const type = ev.type || ev.object || '?';
          rec.events[type] = (rec.events[type] || 0) + 1;
          if (ev.content_block) rec.blocks.push(ev.content_block.type);
          if (ev.delta && ev.delta.stop_reason) rec.stopReason = ev.delta.stop_reason;
          if (ev.item && ev.item.type) rec.blocks.push(ev.item.type);
        }
      }
    })().catch(() => {});
    return new Response(toProvider, { status: res.status, headers: res.headers });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const ASK = '看一下这个工程根目录里都有什么文件，然后告诉我大纲写到哪一步了。';

async function once(provider, label, options) {
  const spy = spyFetch();
  const out = { text: '', toolCalls: [], reasoning: 0, stop: undefined, error: undefined };
  try {
    for await (const ev of provider.stream(
      [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: ASK }],
      options
    )) {
      if (ev.type === 'text') out.text += ev.text;
      else if (ev.type === 'toolCall') out.toolCalls.push(ev.call);
      else if (ev.type === 'reasoning') out.reasoning += (ev.text || '').length;
      else if (ev.type === 'stop') out.stop = ev.reason;
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  // tee 出来那一份可能比 provider 晚收完最后几行。
  await new Promise((r) => setTimeout(r, 300));
  spy.restore();

  console.log('\n' + '━'.repeat(70));
  console.log(`【${label}】`);
  console.log('━'.repeat(70));
  spy.seen.forEach((rec, i) => {
    console.log(`  请求 ${i + 1} → HTTP ${rec.status}`);
    console.log(`    带 tools      ${rec.tools ? `${rec.tools.length} 个：${rec.tools.join(', ')}` : '✗ 没带'}`);
    console.log(`    工具字段      ${rec.schemaField ?? '—'}`);
    console.log(`    tool_choice   ${JSON.stringify(rec.toolChoice) ?? '—'}`);
    console.log(`    thinking      ${JSON.stringify(rec.thinking) ?? '—'}  effort ${JSON.stringify(rec.outputConfig) ?? '—'}`);
    console.log(`    max_tokens    ${rec.maxTokens}`);
    console.log(`    beta 头       ${rec.betaHeader ?? '—'}`);
    console.log(`    SSE 事件      ${JSON.stringify(rec.events)}`);
    console.log(`    内容块        ${rec.blocks.length ? rec.blocks.join(', ') : '（无）'}`);
    console.log(`    stop_reason   ${rec.stopReason ?? '—'}`);
  });
  console.log(`  provider 交出的 toolCall：${out.toolCalls.length} 个` +
    (out.toolCalls.length ? ` → ${out.toolCalls.map((c) => c.name).join(', ')}` : ''));
  // 这两个一对账就知道响应缺没缺半边（见 provider.ts 的 StopSignal）。
  console.log(`  归一后的收尾原因：${out.stop ?? '（上游没说）'}` +
    (out.stop === 'toolUse' && out.toolCalls.length === 0
      ? '  ← ⚠ 说要调工具却一个都没给：这一份响应缺了一半，循环会原样重发'
      : ''));
  console.log(`  思考 ${out.reasoning} 字 / 正文 ${out.text.length} 字`);
  if (out.error) console.log(`  出错：${out.error}`);
  console.log(`  正文开头：${out.text.slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
  return { out, seen: spy.seen };
}

(async () => {
  const cfg = readJson(path.join(HOME, 'config.json'));
  if (!cfg) {
    console.log(`读不到 ${path.join(HOME, 'config.json')}。先在设置页保存一次配置。`);
    process.exit(1);
  }
  const providers = P.normalizeProviders(cfg.providers ?? []);
  const ref = process.argv[2] || cfg.model || P.firstModelRef(providers);
  const active = P.resolveModelRef(providers, ref);
  if (!active) {
    console.log(P.describeModelIssue(providers, ref));
    process.exit(1);
  }
  const secrets = readJson(path.join(HOME, 'secrets.json')) ?? {};
  const key = secrets[`novel-forge.apiKey.provider.${active.profile.id}`]
    ?? secrets[`novel-forge.apiKey.${active.profile.id}`];
  if (!key && active.profile.kind !== 'vscode-lm') {
    console.log(`没找到「${active.profile.id}」的 API Key（~/.novelforge/secrets.json）。`);
    process.exit(1);
  }
  const baseUrl = active.profile.baseUrl || P.defaultBaseUrl(active.profile.kind);
  const provider = buildProvider(active, baseUrl, key);

  console.log(`模型 ${ref}（协议 ${active.profile.kind}）`);
  console.log(`地址 ${baseUrl}`);
  console.log(`工具 ${SPECS.length} 个：${SPECS.map((s) => s.name).join(', ')}`);

  const base = {
    // agent 循环发的就是这几个（loop.ts:317）。max_tokens 跟着模型配置，
    // 这里照抄——上游对超大 max_tokens 的反应也是可疑项之一。
    maxOutputTokens: active.model.maxOutputTokens ?? 4096,
    temperature: cfg.temperature ?? 0.8,
    timeoutMs: 180000,
    tools: SPECS,
    toolChoice: 'auto',
  };

  const depths = process.argv[3] ? [process.argv[3]] : ['off', 'medium'];
  for (const depth of depths) {
    await once(provider, `tools + auto + 思考 ${depth}`, {
      ...base,
      ...(depth === 'off' ? {} : { thinking: depth }),
    });
  }
  // 逼它必须调一次：这一档还不调，就跟提示词无关了。
  await once(provider, 'tools + required（逼它调）', { ...base, toolChoice: 'required' });

  console.log('\n' + '─'.repeat(70));
  console.log('怎么读这份输出：');
  console.log('  「带 tools ✗ 没带」          → 本地 bug，在 loop.ts / provider 里');
  console.log('  带了 tools，内容块里没 tool_use → 上游吞了（网关协议转换 / 模型不支持工具）');
  console.log('  内容块里有 tool_use，但 provider 交出 0 个 → 解析 bug，在 feedToolUse');
  console.log('  只有 required 那一档调得出            → 模型认工具但不主动用，得从提示词下手');
  console.log('  同一档反复跑，有时有 tool_use 有时没有 → 网关在抖，循环的重发（PROTOCOL_RETRIES）就是为它准备的');
})();
