/**
 * 会话存储的离线验证：在临时目录上跑 SessionStore 的读写、容错与列表。
 *
 * 用法：node scripts/smoke-session.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-session-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- vscode 桩

// project.ts 的 readConfig 仍读 vscode 配置（Task 4 后移除），这里给个最小桩。
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
  },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const projectMod = loadModule('src/core/model/project.ts');
const sessionMod = loadModule('src/core/model/session.ts');

const sessionsDir = path.join(WORK, '.novelforge', 'sessions');

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  const store = new sessionMod.SessionStore(project);

  console.log('\n== 目录与路径 ==');
  check('sessionsDir 指向 .novelforge/sessions',
    project.sessionsDir === sessionsDir, project.sessionsDir);
  check('空目录时列表为空数组', (await store.list()).length === 0);

  console.log('\n== 新建与写入 ==');
  const s = store.create({ target: { kind: 'manuscript', chapterRelPath: 'chapters/004-夜访.md' }, targetOrder: 4 });
  check('新会话有 id', /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(s.id), s.id);
  check('新会话记住写入目标', s.targetOrder === 4);
  check('新会话继承创作目标', s.target.chapterRelPath === 'chapters/004-夜访.md');
  check('阶段跟着目标走', s.stage === 'manuscript', s.stage);
  // 默认能力永远是讨论——默认就花钱产出一份要不要都不知道的产物是不对的。
  check('默认能力是讨论', s.capability === 'discuss', s.capability);
  check('新会话无轮次', s.turns.length === 0);
  check('新建不落盘', !fs.existsSync(sessionsDir) || fs.readdirSync(sessionsDir).length === 0);

  // 不给 seed 时落到全书大纲：它是唯一一个不依赖任何章节就一定存在的产物。
  const blank = store.create();
  check('无 seed 时落到全书大纲', blank.target.kind === 'outline' && blank.stage === 'outline');

  s.title = '青崖镇的夜';
  s.turns.push({
    id: 't1', role: 'user', content: '林昭夜访沈氏。', at: '2026-08-01T10:00:00.000Z',
    attachments: [{ id: 'a1', kind: 'selection', label: '003.md:5-9', relPath: 'chapters/003.md',
      range: { start: 5, end: 9 }, text: '选中的原文' }],
    excludedIds: ['style'],
  });
  s.turns.push({
    id: 't2', role: 'assistant', content: '三更，林昭醒了。', at: '2026-08-01T10:01:00.000Z',
    context: { usedTokens: 1200, budget: 60000, clamped: false,
      items: [{ id: 'style', label: '文风指南', kind: 'style', priority: 1, tokens: 0, status: 'excluded' }] },
    acceptedTo: 'chapters/004-夜访.md',
  });
  await store.write(s);
  check('写入后文件存在', fs.existsSync(path.join(sessionsDir, `${s.id}.json`)));
  check('文件是合法 JSON 且带换行结尾', (() => {
    const raw = fs.readFileSync(path.join(sessionsDir, `${s.id}.json`), 'utf8');
    JSON.parse(raw);
    return raw.endsWith('\n');
  })());

  console.log('\n== 读回（round-trip） ==');
  const back = await store.read(s.id);
  check('读回 id 一致', back.id === s.id);
  check('读回标题一致', back.title === '青崖镇的夜');
  check('读回 targetOrder', back.targetOrder === 4);
  check('读回创作目标', back.target.chapterRelPath === 'chapters/004-夜访.md');
  check('读回阶段与能力', back.stage === 'manuscript' && back.capability === 'discuss');
  check('读回两轮', back.turns.length === 2);
  check('读回用户消息原文', back.turns[0].content === '林昭夜访沈氏。');
  check('读回附件快照', back.turns[0].attachments[0].text === '选中的原文');
  check('读回附件行范围', back.turns[0].attachments[0].range.end === 9);
  check('读回排除名单', back.turns[0].excludedIds[0] === 'style');
  check('读回上下文明细', back.turns[1].context.usedTokens === 1200);
  check('读回采纳路径', back.turns[1].acceptedTo === 'chapters/004-夜访.md');
  check('不存在的 id 返回 undefined', (await store.read('nope')) === undefined);

  console.log('\n== 列表与排序 ==');
  const older = store.create();
  older.title = '更早的对话';
  older.createdAt = '2026-07-01T10:00:00.000Z';
  older.updatedAt = '2026-07-01T10:00:00.000Z';
  older.turns.push({ id: 'x1', role: 'user', content: '早先问的问题', at: older.updatedAt });
  await store.write(older);

  const list = await store.list();
  check('列出两个会话', list.length === 2, `got ${list.length}`);
  check('按更新时间倒序', list[0].id === s.id, `first=${list[0].title}`);
  check('列表带轮次数', list[0].turnCount === 2);
  check('列表 preview 取最后一条用户消息', list[0].preview === '林昭夜访沈氏。', list[0].preview);
  check('列表不含 turns 全文', list[0].turns === undefined);

  console.log('\n== 容错 ==');
  fs.writeFileSync(path.join(sessionsDir, 'broken.json'), '{ 这不是 JSON');
  check('损坏文件读出 undefined', (await store.read('broken')) === undefined);
  check('损坏文件不影响列表', (await store.list()).length === 2, '坏文件应被跳过');

  fs.writeFileSync(path.join(sessionsDir, 'partial.json'), JSON.stringify({
    title: '', turns: [{ role: 'user', content: '有效' }, { role: '天知道', content: '无效' }, 'garbage'],
  }));
  const partial = await store.read('partial');
  check('缺字段时补默认标题', partial.title === '未命名对话', partial.title);
  check('缺时间戳时补当前时间', typeof partial.createdAt === 'string' && partial.createdAt.length > 10);
  check('过滤掉非法轮次', partial.turns.length === 1, `got ${partial.turns.length}`);
  check('保留合法轮次', partial.turns[0].content === '有效');

  fs.writeFileSync(path.join(sessionsDir, 'notjson.txt'), 'ignore me');
  check('非 .json 文件被忽略', (await store.list()).every((x) => x.id !== 'notjson'));

  // ---- 旧会话（0.2.x 只有 targetOrder，没有 target/stage/capability）----
  // 这条路每个升级上来的用户都会走一遍，读不出来等于整个历史凭空消失。
  fs.writeFileSync(path.join(sessionsDir, 'legacy.json'), JSON.stringify({
    title: '旧对话', createdAt: '2026-01-01T00:00:00.000Z', targetOrder: 7,
    turns: [{ role: 'user', content: '续写第七章' }],
  }));
  const legacy = await store.read('legacy');
  check('旧会话读得出来', !!legacy && legacy.title === '旧对话');
  // 序号 → 路径要读盘，而 normalize 是纯的；这一步由 controller 补。
  check('旧会话回落到大纲', legacy.target.kind === 'outline', JSON.stringify(legacy.target));
  check('旧会话保留 targetOrder 供 controller 还原', legacy.targetOrder === 7);
  check('旧会话有合法的阶段与能力', legacy.stage === 'outline' && legacy.capability === 'discuss');

  // 手改坏的 target/能力：认不出的一律回落，绝不抛。
  fs.writeFileSync(path.join(sessionsDir, 'weird.json'), JSON.stringify({
    target: { kind: '天知道', chapterRelPath: 'x' }, stage: 'nope', capability: 'nope', turns: [],
  }));
  const weird = await store.read('weird');
  check('认不出的 target 回落到大纲', weird.target.kind === 'outline');
  check('认不出的阶段回落', weird.stage === 'outline');
  check('认不出的能力回落到默认', weird.capability === 'discuss');

  // 该阶段不支持的能力也要回落——正文阶段没有 split。
  fs.writeFileSync(path.join(sessionsDir, 'badcap.json'), JSON.stringify({
    target: { kind: 'manuscript', chapterRelPath: 'chapters/001-x.md' },
    stage: 'manuscript', capability: 'split', turns: [],
  }));
  const badcap = await store.read('badcap');
  check('阶段不支持的能力回落', badcap.capability === 'discuss', badcap.capability);
  check('但目标本身保留', badcap.target.chapterRelPath === 'chapters/001-x.md');

  console.log('\n== 重命名与删除 ==');
  const renamed = await store.rename(s.id, '  改个名字  ');
  check('重命名生效', renamed.title === '改个名字', renamed.title);
  check('重命名已落盘', (await store.read(s.id)).title === '改个名字');
  check('空标题不覆盖原名',
    (await store.rename(s.id, '   ')).title === '改个名字');
  check('重命名不存在的会话返回 undefined', (await store.rename('nope', 'x')) === undefined);

  await store.delete(older.id);
  check('删除后读不到', (await store.read(older.id)) === undefined);
  check('删除移入 .novelforge/.trash',
    fs.existsSync(path.join(WORK, '.novelforge', '.trash', `${older.id}.json`)));
  check('删除不存在的会话不报错', await store.delete('nope') === undefined);

  console.log('\n== 标题推导 ==');
  check('取首句', sessionMod.deriveTitle('林昭进城，被守卫拦下。然后呢') === '林昭进城');
  check('剥列表符号', sessionMod.deriveTitle('1. 沈氏出场') === '沈氏出场');
  check('跳过空行', sessionMod.deriveTitle('\n\n  \n真正的内容') === '真正的内容');
  check('空文本兜底', sessionMod.deriveTitle('   ') === '新对话');
  check('长句截断到 24 字',
    sessionMod.deriveTitle('这是一个非常非常非常非常非常非常非常非常长的没有标点的句子').length === 24);

  console.log('\n== id 唯一性 ==');
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(sessionMod.makeSessionId());
  check('200 次生成无碰撞', ids.size === 200, `got ${ids.size}`);
  const turnIds = new Set();
  for (let i = 0; i < 200; i++) turnIds.add(sessionMod.makeTurnId());
  check('turnId 200 次无碰撞', turnIds.size === 200, `got ${turnIds.size}`);

  console.log('\n== 旧目录迁移 ==');
  {
    // 只有 .novel/ 时应判定需要迁移；rename 后内容原样搬过去。
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-legacy-'));

    const legacyDir = path.join(legacyRoot, '.novel');
    fs.mkdirSync(path.join(legacyDir, 'summaries'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'project.json'), JSON.stringify({ version: 1, title: '旧工程', chapters: [] }));
    fs.writeFileSync(path.join(legacyDir, 'style.md'), '# 文风指南\n\n旧的内容。\n');
    fs.writeFileSync(path.join(legacyDir, 'summaries', '001.md'), '摘要内容');

    const legacy = projectMod.NovelProject.open(legacyRoot);
    check('检测到需要迁移', (await legacy.needsMigration()) === true);
    check('迁移前 isInitialized 为 false', (await legacy.isInitialized()) === false);

    await legacy.migrateLegacyDir();
    check('新目录已存在', fs.existsSync(path.join(legacyRoot, '.novelforge')));
    check('旧目录已消失', !fs.existsSync(legacyDir));
    check('manifest 搬过去了', fs.existsSync(path.join(legacyRoot, '.novelforge', 'project.json')));
    check('子目录一并搬过去', fs.existsSync(path.join(legacyRoot, '.novelforge', 'summaries', '001.md')));
    check('文件内容原样',
      fs.readFileSync(path.join(legacyRoot, '.novelforge', 'style.md'), 'utf8').includes('旧的内容'));
    check('迁移后 isInitialized 为 true', (await legacy.isInitialized()) === true);
    check('迁移后不再提示迁移', (await legacy.needsMigration()) === false);

    // 两个目录都在时不该动手——用户可能是有意保留的。
    fs.mkdirSync(path.join(legacyRoot, '.novel'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, '.novel', 'project.json'), '{}');
    check('新目录已存在时不判定为需迁移', (await legacy.needsMigration()) === false);

    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
