/**
 * 工程页流水线批量动作的离线验证：批量生成细纲、批量拆分场景。
 *
 * 这两条路的失败方式和单次生成完全不同——一次跑几十章，所以要钉住的是：
 *
 * 1. **只补不改**：已经有产物的章节一律跳过，不问、不覆盖。批量路径上没有
 *    逐个审阅的余地（一次弹 63 个 diff 没人看得完），跳过是唯一安全的做法。
 * 2. **部分失败不影响其余**：第 12 章拆不出场景，另外 63 章照样跑完。
 * 3. **失败留在那一章上**：toast 五秒就没了，而一次跑几十章失败三章是常态。
 * 4. **没有前置产物就不跑**：没有大纲还生成细纲，等于让模型凭空编四十章。
 *
 * 用假模型（vscode-lm 那条路，不必碰 SecretStore）真跑一遍全流程，
 * 因此磁盘上的结果就是真实结果。
 *
 * 用法：node scripts/smoke-pipeline-batch.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-batch-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  project: './src/core/model/project.ts',
  registry: './src/core/llm/registry.ts',
  provider: './src/core/llm/provider.ts',
  batch: './src/core/features/pipelineBatch.ts',
  errorLog: './src/core/errorLog.ts',
  db: './src/core/db.ts',
  logger: './src/core/logger.ts',
});

// ---------------------------------------------------------------- 假宿主

let settings = {};
/** 确认框的答案队列。空了就返回 undefined（= 用户取消）。 */
const answers = [];
const toasts = [];
const warns = [];

bundle.host.initHost({
  name: 'standalone',
  supportsVscodeLm: true,
  config: { read: () => settings, write: async () => {} },
  input: async () => undefined,
  confirm: async () => answers.shift(),
  pick: async () => undefined,
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: (m) => toasts.push(m),
  selectionAttachment: async () => undefined,
});
bundle.logger.addLogSink((e) => {
  if (e.level === 'warn' || e.level === 'error') {
    warns.push(`${e.message} ${e.detail ?? ''}`);
  }
});

// ---------------------------------------------------------------- 假模型

/** 第 N 次调用该返回什么。函数式：拿到 messages，返回一段文本或抛异常。 */
let reply = () => '';
const calls = [];

bundle.registry.registerProviderFactory((active) => ({
  id: 'vscode-lm',
  label: active.ref,
  maxInputTokens: async () => undefined,
  chatStream: async function* (messages) {
    calls.push(messages);
    yield reply(messages, calls.length - 1);
  },
}));

function configure(extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    ...extra,
  };
  calls.length = 0;
  toasts.length = 0;
  warns.length = 0;
  // 答案队列也清空：流程发现「没有可做的」时会在弹确认框之前就返回，
  // 留在队列里的那个答案会被下一个用例的确认框读到，串成一串假失败。
  answers.length = 0;
}

const rel = (...p) => path.join(WORK, ...p);
const has = (r) => fs.existsSync(rel(r));
const read = (r) => fs.readFileSync(rel(r), 'utf8');

const PLAN_JSON = JSON.stringify({
  本章目标: '进入宗门',
  开头: '雨里的山门',
  结尾: '藏书阁前',
  冲突与节奏: '三拍推进',
  伏笔与回收: '第三块令牌',
});
const SCENES_JSON = JSON.stringify({
  scenes: [
    { title: '踩点', place: '山门外', time: '戌时', characters: ['林昭'], goal: '摸清换岗' },
    { title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], goal: '进入宗门' },
  ],
});

async function main() {
  const project = bundle.project.NovelProject.open(WORK);
  await project.initialize({ title: '青云剑录', author: '测试' });
  for (const [order, title] of [[1, '楔子'], [2, '入镇'], [3, '夜访']]) {
    await project.createChapter(order, title, '正文若干。');
  }
  await project.syncManifest();

  console.log('\n== 批量生成细纲 · 前置检查 ==');
  {
    configure();
    // 大纲还是初始化模板（有内容但没写实质剧情）——这里要验的是**空大纲**，
    // 所以清空它。没有大纲就生成细纲，等于让模型凭空编三章。
    fs.writeFileSync(rel('.novelforge/outline.md'), '');
    answers.push('开始生成');
    await bundle.batch.generatePlans(project);
    check('大纲为空时不调模型', calls.length === 0, `调了 ${calls.length} 次`);
    check('大纲为空时说明原因', toasts.some((t) => t.includes('大纲')), toasts.join('|'));
    check('大纲为空时一份细纲都没写', !has('.novelforge/plans/001-楔子.md'));
  }

  console.log('\n== 批量生成细纲 ==');
  {
    fs.writeFileSync(rel('.novelforge/outline.md'), '# 大纲\n\n## 第一幕\n\n- 林昭进入青云宗\n');
    configure();

    // 先给第 2 章一份手写细纲——它必须原样保留。
    await project.writePlan('chapters/002-入镇.md', {
      chapterRelPath: 'chapters/002-入镇.md',
      order: 2,
      title: '入镇',
      arc: '',
      upstreamHash: '',
      done: false,
      sections: { 本章目标: '这是作者手写的', 开头: '', 结尾: '', 冲突与节奏: '', 伏笔与回收: '' },
    });

    reply = () => PLAN_JSON;
    answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    // 三章里第 2 章已有细纲 → 只该调两次。
    check('只为缺细纲的章节调模型', calls.length === 2, `调了 ${calls.length} 次`);
    check('第 1 章写出细纲', has('.novelforge/plans/001-楔子.md'));
    check('第 3 章写出细纲', has('.novelforge/plans/003-夜访.md'));
    check('细纲内容来自模型', read('.novelforge/plans/001-楔子.md').includes('三拍推进'));
    // 只补不改：手写的那一份一个字都不能动。
    check('手写的细纲原样保留',
      read('.novelforge/plans/002-入镇.md').includes('这是作者手写的'),
      read('.novelforge/plans/002-入镇.md').slice(0, 200));
    check('新细纲记下大纲指纹', /upstreamHash: \w+/.test(read('.novelforge/plans/001-楔子.md')));

    // 装配走的是同一个装配器 → 细纲阶段的配方里有大纲、没有整章正文。
    const sys = calls[0].find((m) => m.role === 'system').content;
    check('系统提示是剧情导演的身份', sys.includes('剧情导演'), sys.slice(0, 60));
    const user = calls[0].find((m) => m.role === 'user').content;
    check('装配带上了全书大纲', user.includes('林昭进入青云宗'));
    check('细纲阶段不带整章正文', !user.includes('# 最近章节正文'), user.slice(0, 200));

    // 再跑一次：全都有了，一次都不该调。
    configure();
    answers.push('开始生成');
    await bundle.batch.generatePlans(project);
    check('没有缺口时不调模型', calls.length === 0, `调了 ${calls.length} 次`);
    check('没有缺口时给出说明', toasts.some((t) => t.includes('已经有细纲')), toasts.join('|'));
  }

  console.log('\n== 批量生成细纲 · 部分失败 ==');
  {
    // 把第 1 章的细纲清空重来，验证「解析不出就不写盘」。
    fs.rmSync(rel('.novelforge/plans/001-楔子.md'));
    configure();
    // 模型返回一段废话——解析出的细纲是空的，绝不能写盘：
    // 界面上会显示「已规划」，而里面什么都没有。
    reply = () => '我不太确定这一章要写什么。';
    answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    check('解析不出内容时不写盘', !has('.novelforge/plans/001-楔子.md'));
    check('失败进日志', warns.some((w) => w.includes('第 1 章')), warns.join('|'));
    check('失败也给出汇总 toast', toasts.some((t) => t.includes('失败')), toasts.join('|'));
    // 失败挂在那一章上，第二天回来还看得见。
    // recordFailure 是 fire-and-forget（失败路径上再抛异常会把「更新失败」
    // 变成「更新崩溃」），所以这里让出一轮事件循环再查。
    await new Promise((r) => setTimeout(r, 50));
    const failures = await bundle.errorLog.listActiveFailures(project);
    check('失败记录挂在章节上', !!failures['chapters/001-楔子.md'], JSON.stringify(Object.keys(failures)));
  }

  console.log('\n== 批量拆分场景 ==');
  {
    // 补回第 1 章的细纲，三章齐活。
    configure();
    reply = () => PLAN_JSON;
    answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    configure();
    // 先给第 3 章手工拆一场——它必须原样保留。
    await project.writeScene('chapters/003-夜访.md', {
      chapterRelPath: 'chapters/003-夜访.md',
      no: 1,
      title: '作者手拆的',
      place: '',
      time: '',
      characters: [],
      upstreamHash: '',
      status: 'ready',
      sections: { 目的: '', 前置: '', 必须发生: '- 手写的骨架', 不能发生: '', 情绪曲线: '', 人物状态: '', 伏笔: '' },
    });

    reply = () => SCENES_JSON;
    answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);

    check('只为没拆过的章节调模型', calls.length === 2, `调了 ${calls.length} 次`);
    check('第 1 章拆出两场',
      has('.novelforge/scenes/001-楔子/01-踩点.md') && has('.novelforge/scenes/001-楔子/02-翻越侧峰.md'));
    check('第 2 章也拆了', has('.novelforge/scenes/002-入镇/01-踩点.md'));
    // 只补不改：作者花时间填过的「必须发生」被一次批量拆分抹掉，
    // 是这条路上最贵的错误。
    check('手工拆的场景原样保留',
      read('.novelforge/scenes/003-夜访/01-作者手拆的.md').includes('手写的骨架'));
    check('没有往第 3 章里塞新场景', !has('.novelforge/scenes/003-夜访/02-翻越侧峰.md'));

    const first = read('.novelforge/scenes/001-楔子/01-踩点.md');
    check('新拆的场景是 draft', first.includes('status: draft'));
    check('场景带上地点时间', first.includes('place: 山门外') && first.includes('time: 戌时'));
    check('场景记下细纲指纹', /upstreamHash: \w+/.test(first));

    // 拆场景用的是 plan·split 的契约。
    const user = calls[0].find((m) => m.role === 'user').content;
    check('拆场景要求输出 scenes JSON', user.includes('"scenes"'), user.slice(-300));
  }

  console.log('\n== 批量拆分场景 · 没细纲就不拆 ==');
  {
    // 新加一章，只有正文没有细纲。
    await project.createChapter(4, '追兵', '正文若干。');
    await project.syncManifest();
    configure();
    answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);

    // 三章都拆过了，第 4 章没细纲 → 没有可拆的，一次都不调。
    check('没细纲的章节不拆', calls.length === 0, `调了 ${calls.length} 次`);
    check('说明还有几章没写细纲',
      toasts.some((t) => t.includes('没写细纲')), toasts.join('|'));
    check('没有凭空造出场景目录', !has('.novelforge/scenes/004-追兵'));
  }

  console.log('\n== 用户取消 ==');
  {
    configure();
    fs.rmSync(rel('.novelforge/plans/001-楔子.md'));
    // answers 空着 = 用户点了 ×。
    await bundle.batch.generatePlans(project);
    check('取消后不调模型', calls.length === 0, `调了 ${calls.length} 次`);
    check('取消后不写盘', !has('.novelforge/plans/001-楔子.md'));
  }

  // 库开着的话 Windows 上删不掉临时目录。
  bundle.db.closeDatabase(project);
}

main()
  .then(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? '✓ smoke-pipeline-batch 通过' : `${failures} 项失败`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
