/**
 * 会话存储 SessionStore 的读写、容错、列表与旧目录迁移。
 * 迁自 scripts/smoke-session.js（全部 70 条）。
 *
 * 两点与别的集成用例不同：
 *
 * 1. **不 initialize 工程**。原脚本只 `NovelProject.open(WORK)`，
 *    `新建不落盘` 那条断言的正是 `.novelforge/sessions` 压根不存在，
 *    所以这里用 makeTempDir 而不是 makeTempProject。
 * 2. **vscode 桩必须在 loadModule 之前装**。bundle 是 `external: ['vscode']`，
 *    模块体在 _compile 时就会 require('vscode')。原脚本装完从不还原，
 *    这里挂 restore() 到 after()。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModule } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { cleanup } = require('../../helpers/teardown');

describe('session.ts · SessionStore', () => {
  let projectMod;
  let sessionMod;
  let stub;
  let WORK;
  let sessionsDir;
  let store;
  /** 第一个会话，跨小节复用。 */
  let s;
  /** 更早的那个会话，列表与删除都要用。 */
  let older;

  before(() => {
    // project.ts 的 readConfig 仍读 vscode 配置，给个最小桩（原脚本 L27-42）。
    stub = installVscodeStub({ level: 'config' });
    projectMod = loadModule('src/core/model/project.ts');
    sessionMod = loadModule('src/core/model/session.ts');

    ({ dir: WORK } = makeTempDir('session'));
    sessionsDir = path.join(WORK, '.novelforge', 'sessions');
    const project = projectMod.NovelProject.open(WORK);
    store = new sessionMod.SessionStore(project);
  });

  after(() => {
    cleanup(WORK);
    stub.restore();
  });

  describe('目录与路径', () => {
    let project;

    before(() => {
      project = projectMod.NovelProject.open(WORK);
    });

    test('sessionsDir 指向 .novelforge/sessions', () => {
      assert.equal(project.sessionsDir, sessionsDir, project.sessionsDir);
    });

    test('空目录时列表为空数组', async () => {
      assert.equal((await store.list()).length, 0);
    });
  });

  describe('新建与写入', () => {
    let turnsAtCreate;
    let notPersisted;
    let blank;
    let raw;

    before(async () => {
      s = store.create({
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/004-夜访.md' },
        targetNo: 4,
      });
      // 「新会话无轮次」「新建不落盘」都必须在 push / write 之前取值。
      turnsAtCreate = s.turns.length;
      notPersisted = !fs.existsSync(sessionsDir) || fs.readdirSync(sessionsDir).length === 0;

      // 不给 seed 时落到全书大纲：它是唯一一个不依赖任何章节就一定存在的产物。
      blank = store.create();

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
      raw = fs.readFileSync(path.join(sessionsDir, `${s.id}.json`), 'utf8');
    });

    test('新会话有 id', () => {
      assert.ok(/^\d{8}-\d{6}-[0-9a-f]{6}$/.test(s.id), s.id);
    });

    test('新会话记住写入目标', () => {
      assert.equal(s.targetNo, 4);
    });

    test('新会话继承创作目标', () => {
      assert.equal(s.target.plotRelPath, '.novelforge/plots/004-夜访.md');
    });

    test('阶段跟着目标走', () => {
      assert.equal(s.stage, 'manuscript', s.stage);
    });

    // 默认能力永远是讨论——默认就花钱产出一份要不要都不知道的产物是不对的。
    test('默认能力是讨论', () => {
      assert.equal(s.capability, 'discuss', s.capability);
    });

    test('新会话无轮次', () => {
      assert.equal(turnsAtCreate, 0);
    });

    test('新建不落盘', () => {
      assert.ok(notPersisted);
    });

    test('无 seed 时落到全书大纲', () => {
      assert.equal(blank.target.kind, 'outline');
      assert.equal(blank.stage, 'outline');
    });

    test('写入后文件存在', () => {
      assert.ok(fs.existsSync(path.join(sessionsDir, `${s.id}.json`)));
    });

    test('文件是合法 JSON 且带换行结尾', () => {
      JSON.parse(raw);
      assert.ok(raw.endsWith('\n'));
    });
  });

  describe('读回（round-trip）', () => {
    let back;
    let ghost;

    before(async () => {
      back = await store.read(s.id);
      ghost = await store.read('nope');
    });

    test('读回 id 一致', () => {
      assert.equal(back.id, s.id);
    });

    test('读回标题一致', () => {
      assert.equal(back.title, '青崖镇的夜');
    });

    test('读回 targetNo', () => {
      assert.equal(back.targetNo, 4);
    });

    test('读回创作目标', () => {
      assert.equal(back.target.plotRelPath, '.novelforge/plots/004-夜访.md');
    });

    test('读回阶段与能力', () => {
      assert.equal(back.stage, 'manuscript');
      assert.equal(back.capability, 'discuss');
    });

    test('读回两轮', () => {
      assert.equal(back.turns.length, 2);
    });

    test('读回用户消息原文', () => {
      assert.equal(back.turns[0].content, '林昭夜访沈氏。');
    });

    test('读回附件快照', () => {
      assert.equal(back.turns[0].attachments[0].text, '选中的原文');
    });

    test('读回附件行范围', () => {
      assert.equal(back.turns[0].attachments[0].range.end, 9);
    });

    test('读回排除名单', () => {
      assert.equal(back.turns[0].excludedIds[0], 'style');
    });

    test('读回上下文明细', () => {
      assert.equal(back.turns[1].context.usedTokens, 1200);
    });

    test('读回采纳路径', () => {
      assert.equal(back.turns[1].acceptedTo, 'chapters/004-夜访.md');
    });

    test('不存在的 id 返回 undefined', () => {
      assert.equal(ghost, undefined);
    });
  });

  describe('列表与排序', () => {
    let list;

    before(async () => {
      older = store.create();
      older.title = '更早的对话';
      older.createdAt = '2026-07-01T10:00:00.000Z';
      older.updatedAt = '2026-07-01T10:00:00.000Z';
      older.turns.push({ id: 'x1', role: 'user', content: '早先问的问题', at: older.updatedAt });
      await store.write(older);

      list = await store.list();
    });

    test('列出两个会话', () => {
      assert.equal(list.length, 2, `got ${list.length}`);
    });

    test('按更新时间倒序', () => {
      assert.equal(list[0].id, s.id, `first=${list[0].title}`);
    });

    test('列表带轮次数', () => {
      assert.equal(list[0].turnCount, 2);
    });

    test('列表 preview 取最后一条用户消息', () => {
      assert.equal(list[0].preview, '林昭夜访沈氏。', list[0].preview);
    });

    test('列表不含 turns 全文', () => {
      assert.equal(list[0].turns, undefined);
    });
  });

  describe('容错', () => {
    let brokenRead;
    let listAfterBroken;
    let partial;
    let listAfterNotJson;
    let legacy;
    let weird;
    let badcap;

    before(async () => {
      fs.writeFileSync(path.join(sessionsDir, 'broken.json'), '{ 这不是 JSON');
      brokenRead = await store.read('broken');
      listAfterBroken = await store.list();

      fs.writeFileSync(path.join(sessionsDir, 'partial.json'), JSON.stringify({
        title: '', turns: [{ role: 'user', content: '有效' }, { role: '天知道', content: '无效' }, 'garbage'],
      }));
      partial = await store.read('partial');

      fs.writeFileSync(path.join(sessionsDir, 'notjson.txt'), 'ignore me');
      listAfterNotJson = await store.list();

      // 旧会话（0.2.x 只有 targetNo，没有 target/stage/capability）。
      // 这条路每个升级上来的用户都会走一遍，读不出来等于整个历史凭空消失。
      fs.writeFileSync(path.join(sessionsDir, 'legacy.json'), JSON.stringify({
        title: '旧对话', createdAt: '2026-01-01T00:00:00.000Z', targetNo: 7,
        turns: [{ role: 'user', content: '续写第七章' }],
      }));
      legacy = await store.read('legacy');

      // 手改坏的 target/能力：认不出的一律回落，绝不抛。
      fs.writeFileSync(path.join(sessionsDir, 'weird.json'), JSON.stringify({
        target: { kind: '天知道', plotRelPath: 'x' }, stage: 'nope', capability: 'nope', turns: [],
      }));
      weird = await store.read('weird');

      // 该阶段不支持的能力也要回落——正文阶段没有 split。
      fs.writeFileSync(path.join(sessionsDir, 'badcap.json'), JSON.stringify({
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/001-x.md' },
        stage: 'manuscript', capability: 'split', turns: [],
      }));
      badcap = await store.read('badcap');
    });

    test('损坏文件读出 undefined', () => {
      assert.equal(brokenRead, undefined);
    });

    test('损坏文件不影响列表', () => {
      assert.equal(listAfterBroken.length, 2, '坏文件应被跳过');
    });

    test('缺字段时补默认标题', () => {
      assert.equal(partial.title, '未命名对话', partial.title);
    });

    test('缺时间戳时补当前时间', () => {
      assert.equal(typeof partial.createdAt, 'string');
      assert.ok(partial.createdAt.length > 10);
    });

    test('过滤掉非法轮次', () => {
      assert.equal(partial.turns.length, 1, `got ${partial.turns.length}`);
    });

    test('保留合法轮次', () => {
      assert.equal(partial.turns[0].content, '有效');
    });

    test('非 .json 文件被忽略', () => {
      assert.ok(listAfterNotJson.every((x) => x.id !== 'notjson'));
    });

    test('旧会话读得出来', () => {
      assert.ok(legacy);
      assert.equal(legacy.title, '旧对话');
    });

    // 序号 → 路径要读盘，而 normalize 是纯的；这一步由 controller 补。
    test('旧会话回落到大纲', () => {
      assert.equal(legacy.target.kind, 'outline', JSON.stringify(legacy.target));
    });

    test('旧会话保留 targetNo 供 controller 还原', () => {
      assert.equal(legacy.targetNo, 7);
    });

    test('旧会话有合法的阶段与能力', () => {
      assert.equal(legacy.stage, 'outline');
      assert.equal(legacy.capability, 'discuss');
    });

    test('认不出的 target 回落到大纲', () => {
      assert.equal(weird.target.kind, 'outline');
    });

    test('认不出的阶段回落', () => {
      assert.equal(weird.stage, 'outline');
    });

    test('认不出的能力回落到默认', () => {
      assert.equal(weird.capability, 'discuss');
    });

    test('阶段不支持的能力回落', () => {
      assert.equal(badcap.capability, 'discuss', badcap.capability);
    });

    test('但目标本身保留', () => {
      assert.equal(badcap.target.plotRelPath, '.novelforge/plots/001-x.md');
    });
  });

  describe('重命名与删除', () => {
    let renamed;
    let persisted;
    let blankRename;
    let ghostRename;
    let deletedRead;
    let trashed;
    let ghostDelete;

    before(async () => {
      renamed = await store.rename(s.id, '  改个名字  ');
      persisted = await store.read(s.id);
      blankRename = await store.rename(s.id, '   ');
      ghostRename = await store.rename('nope', 'x');

      await store.delete(older.id);
      deletedRead = await store.read(older.id);
      trashed = fs.existsSync(path.join(WORK, '.novelforge', '.trash', `${older.id}.json`));
      ghostDelete = await store.delete('nope');
    });

    test('重命名生效', () => {
      assert.equal(renamed.title, '改个名字', renamed.title);
    });

    test('重命名已落盘', () => {
      assert.equal(persisted.title, '改个名字');
    });

    test('空标题不覆盖原名', () => {
      assert.equal(blankRename.title, '改个名字');
    });

    test('重命名不存在的会话返回 undefined', () => {
      assert.equal(ghostRename, undefined);
    });

    test('删除后读不到', () => {
      assert.equal(deletedRead, undefined);
    });

    test('删除移入 .novelforge/.trash', () => {
      assert.ok(trashed);
    });

    test('删除不存在的会话不报错', () => {
      assert.equal(ghostDelete, undefined);
    });
  });

  describe('标题推导', () => {
    test('取首句', () => {
      assert.equal(sessionMod.deriveTitle('林昭进城，被守卫拦下。然后呢'), '林昭进城');
    });

    test('剥列表符号', () => {
      assert.equal(sessionMod.deriveTitle('1. 沈氏出场'), '沈氏出场');
    });

    test('跳过空行', () => {
      assert.equal(sessionMod.deriveTitle('\n\n  \n真正的内容'), '真正的内容');
    });

    test('空文本兜底', () => {
      assert.equal(sessionMod.deriveTitle('   '), '新对话');
    });

    test('长句截断到 24 字', () => {
      assert.equal(
        sessionMod.deriveTitle('这是一个非常非常非常非常非常非常非常非常长的没有标点的句子').length,
        24
      );
    });
  });

  // 命令类的轮次（生成细纲、拆成场景）content 本来就是空的：该说的都在大纲和
  // 细纲里，作者一个字都不必打。空串会让历史列表出现一排「新对话」。
  describe('轮次预览', () => {
    const t = (content, command) => ({ id: 'p1', role: 'user', content, at: sessionMod.nowIso(), command });

    test('有话就用那句话', () => {
      assert.equal(sessionMod.turnPreview(t('林昭夜访沈氏。')), '林昭夜访沈氏。');
    });

    test('空输入的命令轮次用命令名', () => {
      assert.equal(sessionMod.turnPreview(t('', '生成细纲')), '/生成细纲');
    });

    test('两样都有时话优先', () => {
      assert.equal(sessionMod.turnPreview(t('慢一点', '生成细纲')), '慢一点');
    });

    test('两样都没有时给空串', () => {
      assert.equal(sessionMod.turnPreview(t('   ')), '');
    });

    // 于是标题推导也跟着能说出这一轮干了什么，不再落到「新对话」。
    test('命令轮次的标题不再是「新对话」', () => {
      assert.equal(sessionMod.deriveTitle(sessionMod.turnPreview(t('', '拆成场景'))), '/拆成场景');
    });
  });

  describe('id 唯一性', () => {
    test('200 次生成无碰撞', () => {
      const ids = new Set();
      for (let i = 0; i < 200; i++) ids.add(sessionMod.makeSessionId());
      assert.equal(ids.size, 200, `got ${ids.size}`);
    });

    test('turnId 200 次无碰撞', () => {
      const turnIds = new Set();
      for (let i = 0; i < 200; i++) turnIds.add(sessionMod.makeTurnId());
      assert.equal(turnIds.size, 200, `got ${turnIds.size}`);
    });
  });

  describe('旧目录迁移', () => {
    // 只有 .novel/ 时应判定需要迁移；rename 后内容原样搬过去。
    let legacyRoot;
    let legacyDir;
    let needsBefore;
    let initializedBefore;
    let legacyGone;
    let initializedAfter;
    let needsAfter;
    let needsWithBoth;

    before(async () => {
      ({ dir: legacyRoot } = makeTempDir('legacy'));

      legacyDir = path.join(legacyRoot, '.novel');
      fs.mkdirSync(path.join(legacyDir, 'summaries'), { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'project.json'), JSON.stringify({ version: 1, title: '旧工程', chapters: [] }));
      fs.writeFileSync(path.join(legacyDir, 'style.md'), '# 文风指南\n\n旧的内容。\n');
      fs.writeFileSync(path.join(legacyDir, 'summaries', '001.md'), '摘要内容');

      const legacy = projectMod.NovelProject.open(legacyRoot);
      needsBefore = await legacy.needsMigration();
      initializedBefore = await legacy.isInitialized();

      await legacy.migrateLegacyDir();
      // 「旧目录已消失」必须当场取值：这一节末尾会把 .novel/ 重新建出来。
      legacyGone = !fs.existsSync(legacyDir);
      initializedAfter = await legacy.isInitialized();
      needsAfter = await legacy.needsMigration();

      // 两个目录都在时不该动手——用户可能是有意保留的。
      fs.mkdirSync(path.join(legacyRoot, '.novel'), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, '.novel', 'project.json'), '{}');
      needsWithBoth = await legacy.needsMigration();
    });

    // 原脚本只在成功路径删它，抛异常就漏在 temp 里；这里挂到 after()。
    after(() => cleanup(legacyRoot));

    test('检测到需要迁移', () => {
      assert.equal(needsBefore, true);
    });

    test('迁移前 isInitialized 为 false', () => {
      assert.equal(initializedBefore, false);
    });

    test('新目录已存在', () => {
      assert.ok(fs.existsSync(path.join(legacyRoot, '.novelforge')));
    });

    test('旧目录已消失', () => {
      assert.ok(legacyGone);
    });

    test('manifest 搬过去了', () => {
      assert.ok(fs.existsSync(path.join(legacyRoot, '.novelforge', 'project.json')));
    });

    test('子目录一并搬过去', () => {
      assert.ok(fs.existsSync(path.join(legacyRoot, '.novelforge', 'summaries', '001.md')));
    });

    test('文件内容原样', () => {
      assert.ok(
        fs.readFileSync(path.join(legacyRoot, '.novelforge', 'style.md'), 'utf8').includes('旧的内容')
      );
    });

    test('迁移后 isInitialized 为 true', () => {
      assert.equal(initializedAfter, true);
    });

    test('迁移后不再提示迁移', () => {
      assert.equal(needsAfter, false);
    });

    test('新目录已存在时不判定为需迁移', () => {
      assert.equal(needsWithBoth, false);
    });
  });
});
