/**
 * 创作编排层的离线验证：产物解析的三层降级 + 六条采纳落盘路径。
 *
 * 这一层最贵的失败方式不是崩溃，而是**静默写错地方或静默覆盖**——
 * 拆场景把作者填了三天的「必须发生」抹掉、采纳细纲把手写的那份顶掉。
 * 所以这里的重点不是「能不能写进去」，而是「不该写的时候有没有拦住」。
 *
 * 用法：node scripts/smoke-creation.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-creation-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 几个模块打进同一个 bundle，共享 host / config 的模块级状态。 */
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
  artifact: './src/core/features/artifact.ts',
  creation: './src/core/features/creation.ts',
  pipe: './src/core/pipeline.ts',
});

const { artifact: A } = bundle;

// ================================================================ 产物解析

console.log('\n== artifact.ts · 细纲三层降级 ==');
{
  const act = { stage: 'plan', capability: 'generate' };

  const json = A.parseArtifact(act, JSON.stringify({
    本章目标: '林昭进入青云宗',
    开头: '雨里的山门',
    结尾: '他站在藏书阁前',
    冲突与节奏: '三拍：踩点、失手、翻墙',
    伏笔与回收: '埋下第三块令牌',
  }));
  check('第一层 JSON', json.kind === 'plan' && json.sections.本章目标 === '林昭进入青云宗');
  check('JSON 五节都收下', json.sections.伏笔与回收 === '埋下第三块令牌');

  // 模型忘了 JSON，改回 Markdown 小节——这是最常见的不听话方式。
  const md = A.parseArtifact(act, '## 本章目标\n\n林昭进入青云宗\n\n## 冲突与节奏\n\n三拍推进');
  check('第二层 Markdown 小节', md.sections.本章目标 === '林昭进入青云宗');
  check('Markdown 路径也收其余节', md.sections.冲突与节奏 === '三拍推进');

  // 什么结构都没有：全文塞进主字段，好过整次生成作废。
  const plain = A.parseArtifact(act, '这一章讲林昭翻墙进宗门。');
  check('第三层全文兜底', plain.sections.本章目标 === '这一章讲林昭翻墙进宗门。');

  // 语法合法但完全不相干的 JSON 不能认下来——认了会得到一份空细纲**且不再降级**。
  const irrelevant = A.parseArtifact(act, '{"text":"林昭翻墙进宗门"}');
  check('不相干的 JSON 退到全文兜底',
    irrelevant.sections.本章目标.includes('林昭翻墙'), JSON.stringify(irrelevant.sections));

  check('代码块包裹能剥掉',
    A.parseArtifact(act, '```json\n{"本章目标":"进宗门"}\n```').sections.本章目标 === '进宗门');
  check('JSON 前后的废话不影响解析',
    A.parseArtifact(act, '好的，以下是细纲：\n{"本章目标":"进宗门"}\n希望有帮助').sections.本章目标 === '进宗门');
}

console.log('\n== artifact.ts · 场景卡 ==');
{
  const act = { stage: 'scene', capability: 'generate' };
  const scene = A.parseArtifact(act, JSON.stringify({
    place: '青云宗侧峰',
    time: '子时，暴雨',
    characters: ['林昭', '守卫'],
    targetWords: 1200,
    目的: '进入宗门',
    必须发生: ['第一次翻墙失手', '守卫换岗', '林昭翻过去'],
    不能发生: '不能让人看见他的脸',
  }));
  check('场景 frontmatter 字段', scene.place === '青云宗侧峰' && scene.time === '子时，暴雨');
  check('在场人物成数组', Array.isArray(scene.characters) && scene.characters.length === 2);
  check('目标字数取整数', scene.targetWords === 1200);
  // 「必须发生」是骨架，必须归一成 Markdown 列表——落盘的格式是列表。
  check('必须发生渲染成列表',
    scene.sections.必须发生 === '- 第一次翻墙失手\n- 守卫换岗\n- 林昭翻过去', JSON.stringify(scene.sections.必须发生));
  check('单条也渲染成列表', scene.sections.不能发生 === '- 不能让人看见他的脸');

  // 模型把三条骨架写成一行顿号分隔——拆开，否则「3~6 条」变成一条又臭又长的。
  const inline = A.parseArtifact(act, JSON.stringify({ 目的: 'x', 必须发生: '翻墙、被发现、逃走' }));
  check('顿号分隔的一行拆成三条',
    inline.sections.必须发生 === '- 翻墙\n- 被发现\n- 逃走', JSON.stringify(inline.sections.必须发生));

  const md = A.parseArtifact(act, '## 目的\n\n进入宗门\n\n## 必须发生\n\n- 翻墙\n- 被发现');
  check('场景卡也能走 Markdown 路径', md.sections.目的 === '进入宗门');
  check('Markdown 路径没有 frontmatter 字段也不炸', md.place === '' && md.characters.length === 0);
}

console.log('\n== artifact.ts · 拆分清单 ==');
{
  const outlineSplit = { stage: 'outline', capability: 'split' };
  const list = A.parseArtifact(outlineSplit, JSON.stringify({
    chapters: [
      { order: 12, title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕 · 入局' },
      { title: '藏书阁', goal: '找到第三块令牌' },
    ],
  }));
  check('拆章走 chapters 键', list.kind === 'chapterList' && list.chapters.length === 2);
  check('带序号的保留序号', list.chapters[0].order === 12);
  check('不带序号的留空由调用方续号', list.chapters[1].order === undefined);

  // 模型漏掉外层键，直接给数组。
  const bare = A.parseArtifact(outlineSplit, '[{"title":"夜入青云","goal":"进宗门"}]');
  check('裸数组也认', bare.chapters.length === 1 && bare.chapters[0].title === '夜入青云');

  // 模型整个忘了 JSON，列了一串 Markdown。
  const mdList = A.parseArtifact(outlineSplit, '1. 夜入青云\n2. 藏书阁夜谈\n3. 沈氏来访');
  check('Markdown 列表兜底', mdList.chapters.length === 3, JSON.stringify(mdList.chapters));
  check('列表项的序号前缀被剥掉', mdList.chapters[0].title === '夜入青云', mdList.chapters[0].title);

  // 一段说明文字不该被拆成几十项「章节」。
  const prose = A.parseArtifact(outlineSplit, '这本书大致分三幕。\n第一幕讲入局。\n第二幕讲反转。');
  check('散文不被误拆成章节清单', prose.chapters.length === 0, JSON.stringify(prose.chapters));

  // 标题会变成文件名，模型很爱把一整句梗概当标题。
  const longTitle = A.parseArtifact(outlineSplit,
    '[{"title":"林昭在暴雨的深夜翻越青云宗的侧峰围墙并且成功进入了藏书阁"}]');
  check('过长的标题被收口', longTitle.chapters[0].title.length <= 18, longTitle.chapters[0].title);

  const sceneSplit = A.parseArtifact({ stage: 'plan', capability: 'split' }, JSON.stringify({
    scenes: [{ title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], targetWords: 1000 }],
  }));
  check('拆场景走 scenes 键', sceneSplit.kind === 'sceneList' && sceneSplit.scenes.length === 1);
  check('场景清单带上地点时间', sceneSplit.scenes[0].place === '侧峰' && sceneSplit.scenes[0].time === '子时');
}

console.log('\n== artifact.ts · 空产物与描述 ==');
{
  check('正文原样收下',
    A.parseArtifact({ stage: 'manuscript', capability: 'generate' }, '雨下了三天。').text === '雨下了三天。');
  check('空正文算空产物',
    A.isArtifactEmpty({ kind: 'manuscript', text: '   ' }));
  check('空清单算空产物', A.isArtifactEmpty({ kind: 'chapterList', chapters: [] }));
  check('有内容的不算空',
    !A.isArtifactEmpty(A.parseArtifact({ stage: 'plan', capability: 'generate' }, '{"本章目标":"x"}')));
  check('描述带得出条数',
    A.describeArtifact({ kind: 'chapterList', chapters: [1, 2, 3] }) === '3 章');
}

// ================================================================ 采纳落盘

const answers = [];
bundle.host.initHost({
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({}), write: async () => {} },
  input: async () => answers.shift(),
  confirm: async () => answers.shift(),
  pick: async () => answers.shift(),
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: () => {},
  selectionAttachment: async () => undefined,
});

const rel = (...p) => path.join(WORK, ...p);
const has = (relPath) => fs.existsSync(rel(relPath));
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');

async function main() {
  const project = bundle.project.NovelProject.open(WORK);
  await project.initialize({ title: '青云剑录', author: '测试' });
  const session = new bundle.creation.CreationSession(project);

  console.log('\n== 采纳 · 大纲拆章 ==');
  {
    const result = await session.acceptArtifact(
      { kind: 'outline' },
      {
        kind: 'chapterList',
        chapters: [
          { title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕' },
          { title: '藏书阁', goal: '找到令牌', arc: '第一幕' },
        ],
      }
    );
    check('建出两章', (await project.listChapters()).length === 2, result.message);
    check('章节文件按序号命名', has('chapters/001-夜入青云.md') && has('chapters/002-藏书阁.md'));
    // 建空章节而不是只建细纲：四套镜像路径全都挂在章节的 relPath 上。
    check('同时建出细纲', has('.novelforge/plans/001-夜入青云.md'));
    check('细纲里带上了大纲给的目标', read('.novelforge/plans/001-夜入青云.md').includes('林昭进入宗门'));
    // 细纲记下了大纲的指纹——改了大纲，这份细纲才标得出脏。
    check('细纲记下上游指纹', /upstreamHash: \w+/.test(read('.novelforge/plans/001-夜入青云.md')));

    // 已存在的序号一律跳过，绝不覆盖。
    const again = await session.acceptArtifact(
      { kind: 'outline' },
      { kind: 'chapterList', chapters: [{ order: 1, title: '换个名', goal: '不该写进去', arc: '' }] }
    );
    check('已存在的序号被跳过', again.message.includes('跳过'), again.message);
    check('原章节没被改名', has('chapters/001-夜入青云.md') && !has('chapters/001-换个名.md'));
    check('原细纲没被覆盖', !read('.novelforge/plans/001-夜入青云.md').includes('不该写进去'));
  }

  console.log('\n== 采纳 · 细纲（覆盖要审阅） ==');
  {
    const target = { kind: 'plan', chapterRelPath: 'chapters/001-夜入青云.md' };
    const sections = {
      本章目标: '林昭进入青云宗',
      开头: '雨里的山门',
      结尾: '藏书阁前',
      冲突与节奏: '三拍推进',
      伏笔与回收: '第三块令牌',
    };

    // 已有一份（拆章时建的），内容不同 → 必须问。答「保留原样」就不能写。
    answers.push('保留原样');
    const kept = await session.acceptArtifact(target, { kind: 'plan', sections });
    check('拒绝覆盖时不写盘', kept.skipped === true, kept.message);
    check('拒绝后磁盘上还是旧的', !read('.novelforge/plans/001-夜入青云.md').includes('三拍推进'));

    answers.push('覆盖');
    const written = await session.acceptArtifact(target, { kind: 'plan', sections });
    check('确认后才写', written.relPath === '.novelforge/plans/001-夜入青云.md', written.message);
    check('新内容已落盘', read('.novelforge/plans/001-夜入青云.md').includes('三拍推进'));

    // 一字未变时不该弹框——弹了只会让人以为自己点错了。answers 空着，
    // 真弹框的话 confirm 返回 undefined，会被当成取消而 skipped。
    const same = await session.acceptArtifact(target, { kind: 'plan', sections });
    check('内容相同不弹框直接通过', same.skipped !== true && !!same.relPath, same.message);
  }

  console.log('\n== 采纳 · 细纲拆场景 ==');
  {
    const target = { kind: 'plan', chapterRelPath: 'chapters/001-夜入青云.md' };
    const result = await session.acceptArtifact(target, {
      kind: 'sceneList',
      scenes: [
        { title: '踩点', place: '山门外', time: '戌时', characters: ['林昭'], goal: '摸清换岗' },
        { title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], goal: '进入宗门' },
      ],
    });
    check('拆出两场', result.message.includes('2 场'), result.message);
    check('场景文件两位数前缀', has('.novelforge/scenes/001-夜入青云/01-踩点.md'));
    check('第二场按序排下去', has('.novelforge/scenes/001-夜入青云/02-翻越侧峰.md'));
    const first = read('.novelforge/scenes/001-夜入青云/01-踩点.md');
    check('场景卡带上地点时间', first.includes('place: 山门外') && first.includes('time: 戌时'));
    // 刚拆出来的是壳，「必须发生」还没填——status 得如实说 draft。
    check('新拆的场景是 draft', first.includes('status: draft'));
    check('场景记下细纲指纹', /upstreamHash: \w+/.test(first));

    // 再拆一次：已有的两场绝不覆盖，新的接着往后排。
    const again = await session.acceptArtifact(target, {
      kind: 'sceneList',
      scenes: [{ title: '追兵', place: '后山', time: '丑时', characters: [], goal: '甩掉追兵' }],
    });
    check('二次拆分不动原有场景', again.message.includes('原有 2 场未动'), again.message);
    check('新场景排在后面', has('.novelforge/scenes/001-夜入青云/03-追兵.md'));
    check('原场景内容还在', read('.novelforge/scenes/001-夜入青云/01-踩点.md').includes('摸清换岗'));
  }

  console.log('\n== 采纳 · 单张场景卡 ==');
  {
    const target = { kind: 'scene', chapterRelPath: 'chapters/001-夜入青云.md', sceneNo: 1 };
    answers.push('覆盖');
    const result = await session.acceptArtifact(target, {
      kind: 'scene',
      place: '山门外',
      time: '戌时，小雨',
      characters: ['林昭', '守卫甲'],
      targetWords: 900,
      sections: {
        目的: '摸清换岗',
        前置: '林昭刚到镇上',
        必须发生: '- 看见换岗\n- 被狗叫惊动',
        不能发生: '- 不能被认出',
        情绪曲线: '警觉 → 紧张',
        人物状态: '他还不知道令牌在藏书阁',
        伏笔: '狗',
      },
    });
    check('场景卡写回原文件', result.relPath === '.novelforge/scenes/001-夜入青云/01-踩点.md', result.message);
    const text = read('.novelforge/scenes/001-夜入青云/01-踩点.md');
    // 「必须发生」填上了就是可以开写——状态由内容推，不靠调用方记得传。
    check('填了必须发生就转 ready', text.includes('status: ready'));
    check('在场人物写进 frontmatter', text.includes('林昭') && text.includes('守卫甲'));
    check('改写不改文件名', !has('.novelforge/scenes/001-夜入青云/01-摸清换岗.md'));
  }

  console.log('\n== 采纳 · 正文 ==');
  {
    const chapterRelPath = 'chapters/001-夜入青云.md';
    const target = { kind: 'manuscript', chapterRelPath, sceneNo: 1 };
    const before = await project.beatsHashFor(chapterRelPath);
    check('场景齐了就算得出 beatsHash', before.length > 0);

    const result = await session.acceptArtifact(target, {
      kind: 'manuscript',
      text: '雨下了三天，青云宗的石阶泡得发白。',
    });
    check('正文追加到章节', result.relPath === chapterRelPath, result.message);
    check('正文确实写进去了', read(chapterRelPath).includes('石阶泡得发白'));

    // 写完要记一笔 beatsHash，否则这一章会永远显示（或永远不显示）「与场景对不上」。
    const manifest = await project.readManifest();
    const entry = manifest.chapters.find((c) => c.file === chapterRelPath);
    check('manifest 记下 beatsHash', entry?.beatsHash === before, entry?.beatsHash);
    // 写的是某一场 → 那一场标 written，流水线进度才走得动。
    const scene = await project.readScene(chapterRelPath, 1);
    check('对应场景标记为 written', scene.status === 'written', scene.status);

    const pipe = await bundle.pipe.buildChapterPipeline(
      project,
      (await project.listChapters()).find((c) => c.relPath === chapterRelPath)
    );
    check('刚写完的正文不标脏', pipe.manuscript.beatsStale === false);
    check('流水线看得见 1/3 场写完', Math.abs(pipe.progress.manuscript - 1 / 3) < 1e-9, String(pipe.progress.manuscript));
  }

  console.log('\n== 采纳 · 新建章节 ==');
  {
    const order = await project.nextChapterOrder();
    const result = await session.acceptAsNewChapter('林昭推开门。', order, '');
    check('空标题时用首句兜底', result.relPath.includes('林昭推开门'), result.relPath);
    check('新章节已落盘', fs.existsSync(rel(result.relPath)));
  }

  console.log('\n== 采纳 · 大纲整篇替换 ==');
  {
    answers.push('覆盖');
    const result = await session.acceptArtifact(
      { kind: 'outline' },
      { kind: 'outlineDoc', text: '## 第一幕 · 入局\n\n- 林昭进宗门' }
    );
    check('大纲写回 outline.md', result.relPath.endsWith('outline.md'), result.message);
    check('大纲内容已换', (await project.readOutline()).includes('林昭进宗门'));
  }

  console.log('\n== 采纳 · 目标不存在时报错而不是乱写 ==');
  {
    let message = '';
    try {
      await session.acceptArtifact(
        { kind: 'manuscript', chapterRelPath: 'chapters/999-不存在.md' },
        { kind: 'manuscript', text: 'x' }
      );
    } catch (err) {
      message = String(err.message ?? err);
    }
    check('找不到章节时抛错', message.includes('找不到章节'), message);
    check('没有凭空造出章节', !has('chapters/999-不存在.md'));
  }
}

main()
  .then(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? '✓ smoke-creation 通过' : `${failures} 项失败`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
