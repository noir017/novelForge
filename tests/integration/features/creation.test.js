/**
 * 产物解析的三层降级 + 各条采纳落盘路径。
 *
 * 这一层最贵的失败方式不是崩溃，而是**静默写错地方或静默覆盖**——
 * 采纳剧情把手写的那份顶掉、拆卷把已有的卷纲抹掉。
 * 所以这里的重点不是「能不能写进去」，而是「不该写的时候有没有拦住」。
 *
 * 采纳的各条分支在 `generation/accept.ts`；落盘的守卫在 `workspace/`。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let A;
let plotFile;
let h;
let t;
let project;
/** `accept(target, artifact)`——绑好 project 的采纳入口。 */
let accept;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    artifact: './src/core/features/artifact.ts',
    accept: './src/core/generation/accept.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipe: './src/core/views/pipeline.ts',
  });
  A = bundle.artifact;
  plotFile = bundle.plotFile;
  // 假宿主**没有** reviewReplace，于是采纳走 confirm 那条分支。
  // helper 默认带 reviewReplace，不摘掉的话「保留原样」这条路根本走不到。
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'creation',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
  accept = (target, artifact) => bundle.accept.acceptArtifact(project, target, artifact);
});

after(() => {
  if (t) cleanup(t.dir);
});

// ================================================================ 产物解析

// 三种落点，采纳那半边要用。**解析不再看 target**：从前 `outline` 阶段兼管
// 全书大纲与卷纲，同一个 `split` 在两者上产出的东西完全不同（分卷清单 /
// 一个剧情段），只看 stage 分不开；卷纲独立成阶段之后 stage 就够了。
const VOLUME_T = { kind: 'volume', volumeRelPath: '.novelforge/volumes/01-觉醒之日.md' };
const PLOT_T = { kind: 'plot', plotRelPath: '.novelforge/plots/01-觉醒之日/012-夜入青云.md' };

describe('artifact.ts · 剧情三层降级', () => {
  const act = { stage: 'plot', capability: 'generate' };
  let json;
  let md;
  let plain;
  let irrelevant;

  before(() => {
    json = A.parseArtifact(act, JSON.stringify({
      目标: '林昭进入青云宗',
      剧情脉络: '他踩点、失手、翻墙；收在藏书阁门口。',
      冲突与转折: '主冲突是守卫换岗；在他被狗惊动那一步翻转',
      伏笔与回收: '埋下第三块令牌',
    }));
    // 模型忘了 JSON，改回 Markdown 小节——这是最常见的不听话方式。
    md = A.parseArtifact(act, '## 目标\n\n林昭进入青云宗\n\n## 剧情脉络\n\n踩点、失手、翻墙');
    // 什么结构都没有：全文塞进主字段，好过整次生成作废。
    plain = A.parseArtifact(act, '这一段讲林昭翻墙进宗门。');
    // 语法合法但完全不相干的 JSON 不能认下来——认了会得到一份空剧情**且不再降级**。
    irrelevant = A.parseArtifact(act, '{"text":"林昭翻墙进宗门"}');
  });

  test('第一层 JSON', () => {
    assert.equal(json.kind, 'plot');
    assert.equal(json.sections.目标, '林昭进入青云宗');
  });

  test('JSON 四节都收下', () => {
    assert.equal(json.sections.伏笔与回收, '埋下第三块令牌');
  });

  test('第二层 Markdown 小节', () => {
    assert.equal(md.sections.目标, '林昭进入青云宗');
  });

  test('Markdown 路径也收其余节', () => {
    assert.equal(md.sections.剧情脉络, '踩点、失手、翻墙');
  });

  // 兜底落「剧情脉络」而不是「目标」：目标不算 filled（isPlotFilled 只看
  // 剧情脉络），兜底进那一节的话，这一段采纳后会显示成「还没排剧情」的空壳。
  test('第三层全文兜底进剧情脉络', () => {
    assert.equal(plain.sections.剧情脉络, '这一段讲林昭翻墙进宗门。');
  });

  test('兜底进去的剧情算「排过」', () => {
    assert.ok(plotFile.isPlotFilled(plain.sections), JSON.stringify(plain.sections));
  });

  // 严格解析不做全文兜底。批量路径（工程页一次给几十段写剧情）用它：
  // 那里没有人逐份过目，兜底会把模型的一句「我不太确定」变成一份「已规划」
  // 的剧情，紧接着的批量拆场景还会照着它往下拆。
  test('严格解析不兜底', () => {
    assert.equal(A.parsePlotStrict('这一段讲林昭翻墙进宗门。'), undefined);
  });

  test('严格解析仍认 JSON', () => {
    assert.equal(A.parsePlotStrict('{"剧情脉络":"进宗门"}')?.剧情脉络, '进宗门');
  });

  test('严格解析仍认 Markdown 小节', () => {
    assert.equal(A.parsePlotStrict('## 剧情脉络\n\n进宗门')?.剧情脉络, '进宗门');
  });

  test('不相干的 JSON 退到全文兜底', () => {
    assert.ok(irrelevant.sections.剧情脉络.includes('林昭翻墙'), JSON.stringify(irrelevant.sections));
  });

  test('代码块包裹能剥掉', () => {
    assert.equal(
      A.parseArtifact(act, '```json\n{"剧情脉络":"进宗门"}\n```').sections.剧情脉络,
      '进宗门'
    );
  });

  test('JSON 前后的废话不影响解析', () => {
    assert.equal(
      A.parseArtifact(act, '好的，以下是剧情：\n{"剧情脉络":"进宗门"}\n希望有帮助').sections.剧情脉络,
      '进宗门'
    );
  });

  // 落定与写剧情产出的是同一种产物，走的是同一条解析路。
  test('落定与写剧情解析成同一种产物', () => {
    const settled = A.parseArtifact({ stage: 'plot', capability: 'settle' }, '{"剧情脉络":"进宗门"}');
    assert.equal(settled.kind, 'plot');
    assert.equal(settled.sections.剧情脉络, '进宗门');
  });
});

describe('artifact.ts · 拆分清单', () => {
  // 两个阶段各拆一层：大纲拆出**分卷清单**，卷纲拆出**一个剧情段**。
  // 从前两者同属 `outline` 阶段、靠 target 分辨，现在按 stage 分。
  const outlineSplit = { stage: 'outline', capability: 'split' };
  const volumeSplit = { stage: 'volume', capability: 'split' };
  let volumes;
  let bareVolumes;
  let mdVolumes;
  let proseVolumes;
  let segment;
  let segmentFromList;
  let longTitle;
  let legacyKey;

  before(() => {
    volumes = A.parseArtifact(outlineSplit, JSON.stringify({
      volumes: [
        { no: 1, title: '觉醒之日', goal: '林昭活着走出青云镇', arc: '从客栈发烧醒来开始……' },
        { title: '北行', goal: '找到第三块令牌' },
      ],
    }));
    // 模型漏掉外层键，直接给数组。
    bareVolumes = A.parseArtifact(outlineSplit, '[{"title":"觉醒之日","goal":"走出青云镇"}]');
    // 模型整个忘了 JSON，列了一串 Markdown。
    mdVolumes = A.parseArtifact(outlineSplit, '1. 觉醒之日\n2. 北行\n3. 赤星');
    // 一段说明文字不该被拆成几十卷。
    proseVolumes = A.parseArtifact(outlineSplit, '这本书大致分三卷。\n第一卷讲入局。\n第二卷讲反转。');

    // 一卷上的 split：一个剧情段。
    segment = A.parseArtifact(volumeSplit, JSON.stringify({
      plots: [{ title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕 · 入局' }],
    }));
    // 模型不听话，一次给了三段：**只取第一段**。契约是一次一段，
    // 收下三段会让「一次只拆一段」这条设计在数据这一侧悄悄失效。
    segmentFromList = A.parseArtifact(volumeSplit, JSON.stringify({
      plots: [
        { title: '夜入青云', goal: '进宗门' },
        { title: '藏书阁', goal: '找到令牌' },
        { title: '沈氏来访', goal: '被盯上' },
      ],
    }));
    // 标题会变成文件名，模型很爱把一整句梗概当标题。
    longTitle = A.parseArtifact(volumeSplit,
      '[{"title":"林昭在暴雨的深夜翻越青云宗的侧峰围墙并且成功进入了藏书阁"}]');
    // 模型跟着旧提示词给了 `chapters` 键——照收，别因为一个键名丢掉整次调用。
    legacyKey = A.parseArtifact(volumeSplit, '{"chapters":[{"title":"夜入青云","goal":"进宗门"}]}');
  });

  test('大纲拆卷走 volumes 键', () => {
    assert.equal(volumes.kind, 'volumeList');
    assert.equal(volumes.volumes.length, 2);
  });

  test('带卷号的保留卷号', () => {
    assert.equal(volumes.volumes[0].no, 1);
  });

  test('不带卷号的留空由调用方续号', () => {
    assert.equal(volumes.volumes[1].no, undefined);
  });

  test('卷的剧情走向进 arc', () => {
    assert.ok(volumes.volumes[0].arc.includes('客栈'), volumes.volumes[0].arc);
  });

  test('裸数组也认', () => {
    assert.equal(bareVolumes.volumes.length, 1);
    assert.equal(bareVolumes.volumes[0].title, '觉醒之日');
  });

  test('Markdown 列表兜底', () => {
    assert.equal(mdVolumes.volumes.length, 3, JSON.stringify(mdVolumes.volumes));
  });

  test('列表项的序号前缀被剥掉', () => {
    assert.equal(mdVolumes.volumes[0].title, '觉醒之日', mdVolumes.volumes[0].title);
  });

  test('散文不被误拆成清单', () => {
    assert.equal(proseVolumes.volumes.length, 0, JSON.stringify(proseVolumes.volumes));
  });

  test('一卷上的 split 产出一个剧情段', () => {
    assert.equal(segment.kind, 'plotSegment');
    assert.equal(segment.segment.title, '夜入青云');
    assert.equal(segment.segment.goal, '林昭进入宗门');
  });

  test('模型一次给三段时只取第一段', () => {
    assert.equal(segmentFromList.kind, 'plotSegment');
    assert.equal(segmentFromList.segment.title, '夜入青云');
  });

  test('旧的 chapters 键也认', () => {
    assert.equal(legacyKey.segment.title, '夜入青云', JSON.stringify(legacyKey));
  });

  test('过长的标题被收口', () => {
    assert.ok(longTitle.segment.title.length <= 18, longTitle.segment.title);
  });

  // 剧情层已经没有 `split`（场景那一层删掉了）。解析仍然只按 stage 走，
  // 于是老会话里那个动作落到「产出这一段的细纲」——不会解析出一个
  // 新模型里根本无处落盘的产物。
  test('剧情层的 split 解析成细纲而不是场景清单', () => {
    const legacy = A.parseArtifact({ stage: 'plot', capability: 'split' }, '{"剧情脉络":"进宗门"}');
    assert.equal(legacy.kind, 'plot', legacy.kind);
  });
});

describe('artifact.ts · 空产物与描述', () => {
  test('正文原样收下', () => {
    assert.equal(
      A.parseArtifact({ stage: 'manuscript', capability: 'generate' }, '雨下了三天。').text,
      '雨下了三天。'
    );
  });

  test('空正文算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'manuscript', text: '   ' }));
  });

  test('空的分卷清单算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'volumeList', volumes: [] }));
  });

  test('没有标题也没有目标的剧情段算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'plotSegment', segment: { title: ' ', goal: '', arc: '' } }));
  });

  test('有内容的不算空', () => {
    assert.ok(!A.isArtifactEmpty(A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"剧情脉络":"x"}')));
  });

  test('描述带得出卷数', () => {
    assert.equal(A.describeArtifact({ kind: 'volumeList', volumes: [1, 2, 3] }), '3 卷');
  });

  // 「一个剧情段」在描述里就要说是一个：作者点的是「拆出剧情段」，
  // 卡片上写「3 章的细纲」会让他以为工具又替他铺了一片骨架。
  test('剧情段的描述报一个', () => {
    assert.equal(
      A.describeArtifact({ kind: 'plotSegment', segment: { title: '楼道', goal: 'x', arc: '' } }),
      '1 个剧情段 · 楼道'
    );
  });

  test('剧情描述带填了几节', () => {
    const a = A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"目标":"x","剧情脉络":"y"}');
    assert.equal(A.describeArtifact(a), '剧情 · 2/4 节');
  });
});

// ================================================================ 采纳落盘

describe('采纳 · 大纲拆成卷', () => {
  let result;
  let again;
  let volumeCount;
  let plotCount;

  before(async () => {
    result = await accept(
      { kind: 'outline' },
      {
        kind: 'volumeList',
        volumes: [
          { title: '觉醒之日', goal: '走出青云镇', arc: '从客栈发烧醒来开始……' },
          { title: '北行', goal: '找到第三块令牌', arc: '' },
        ],
      }
    );
    volumeCount = (await project.listVolumes()).length;
    plotCount = (await project.listPlots()).length;
    // 已存在的卷号一律跳过，绝不覆盖。
    again = await accept(
      { kind: 'outline' },
      { kind: 'volumeList', volumes: [{ no: 1, title: '换个名', goal: '不该写进去', arc: '' }] }
    );
  });

  test('建出两卷', () => {
    assert.equal(volumeCount, 2, result.message);
  });

  // 卷号两位数：一本书几百章是常态，几百卷不是；而这个词干还要当 `plots/`
  // 下的目录名用，三位数只会让目录名比它收纳的东西还长。
  test('卷纲文件按卷号命名（两位数前缀）', () => {
    assert.ok(
      t.has('.novelforge/volumes/01-觉醒之日.md') && t.has('.novelforge/volumes/02-北行.md'),
      t.read('.novelforge/volumes/01-觉醒之日.md') ?? ''
    );
  });

  // 拆卷**不铺剧情段**：段由「从这一卷拆出剧情段」一次一个地拆出来。
  // 顺手铺几十个空段只会让作者以为工具替他排好了剧情。
  test('不顺手铺剧情段', () => {
    assert.equal(plotCount, 0, String(plotCount));
  });

  test('卷纲里带上了大纲给的目标与走向', () => {
    const text = t.read('.novelforge/volumes/01-觉醒之日.md');
    assert.ok(text.includes('走出青云镇'), text);
    assert.ok(text.includes('客栈'), text);
  });

  // 卷纲记下了大纲的指纹——改了大纲，这一卷才标得出脏。
  test('卷纲记下上游指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(t.read('.novelforge/volumes/01-觉醒之日.md')));
  });

  test('已存在的卷号被跳过', () => {
    assert.ok(again.message.includes('跳过'), again.message);
  });

  test('原卷纲没被改名', () => {
    assert.ok(
      t.has('.novelforge/volumes/01-觉醒之日.md') && !t.has('.novelforge/volumes/01-换个名.md')
    );
  });

  test('原卷纲没被覆盖', () => {
    assert.ok(!t.read('.novelforge/volumes/01-觉醒之日.md').includes('不该写进去'));
  });
});

describe('采纳 · 卷纲拆出剧情段（一次一个）', () => {
  const target = { kind: 'volume', volumeRelPath: '.novelforge/volumes/01-觉醒之日.md' };
  let first;
  let second;
  let paths;

  before(async () => {
    first = await accept(target, {
      kind: 'plotSegment',
      segment: { title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕' },
    });
    second = await accept(target, {
      kind: 'plotSegment',
      segment: { title: '藏书阁', goal: '找到令牌', arc: '第一幕' },
    });
    paths = (await project.listPlots()).map((p) => p.relPath);
  });

  // 归属靠**目录**，不落 frontmatter：目录已经说了，再记一份就会漂移。
  test('落进这一卷的段目录', () => {
    assert.ok(t.has('.novelforge/plots/01-觉醒之日/001-夜入青云.md'), paths.join('、'));
  });

  test('一次只建一个', () => {
    assert.equal(paths.length, 2, paths.join('、'));
  });

  test('段号往后连排', () => {
    assert.ok(t.has('.novelforge/plots/01-觉醒之日/002-藏书阁.md'), paths.join('、'));
  });

  test('消息说的是一个剧情段', () => {
    assert.ok(first.message.includes('剧情段'), first.message);
    assert.ok(second.relPath.endsWith('002-藏书阁.md'), second.relPath);
  });

  // 上游是**这一卷**而不是全书大纲：改一卷的走向只该让那一卷的段标脏，
  // 否则改一句立意换来一屏 ⟳。
  test('细纲记下的是卷纲的指纹', async () => {
    const plot = await project.readPlot('.novelforge/plots/01-觉醒之日/001-夜入青云.md');
    const volume = await project.readVolume(target.volumeRelPath);
    assert.equal(plot.upstreamHash, bundle.pipe.volumeContentHash(volume));
  });

  test('细纲里带上了拆分给的目标', () => {
    assert.ok(t.read('.novelforge/plots/01-觉醒之日/001-夜入青云.md').includes('林昭进入宗门'));
  });

  // 只填「目标」的骨架**不算排过剧情**：拿它当 filled 的话，刚拆出来的段
  // 会立刻显示「已规划」，紧接着的批量拆场景还会照着空壳往下拆。
  test('只有目标的骨架不算排过剧情', async () => {
    const plot = await project.readPlot('.novelforge/plots/01-觉醒之日/001-夜入青云.md');
    assert.ok(!plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('骨架的流水线停在待写剧情', async () => {
    const plot = await project.readPlot('.novelforge/plots/01-觉醒之日/001-夜入青云.md');
    const p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
    assert.equal(p.stage, 'plot', p.stage);
  });

  test('没有卷时拒绝落盘', async () => {
    await assert.rejects(
      () =>
        accept(
          { kind: 'outline' },
          { kind: 'plotSegment', segment: { title: 'x', goal: 'y', arc: '' } }
        ),
      /不属于任何一卷/
    );
  });
});

describe('采纳 · 剧情（覆盖要审阅）', () => {
  const target = { kind: 'plot', plotRelPath: '.novelforge/plots/01-觉醒之日/001-夜入青云.md' };
  const sections = {
    目标: '林昭进入青云宗',
    剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
    冲突与转折: '三拍推进',
    伏笔与回收: '第三块令牌',
  };
  let kept;
  let afterKept;
  let written;
  let same;

  before(async () => {
    // 已有一份（拆段时建的骨架），内容不同 → 必须问。答「保留原样」就不能写。
    h.answers.push('保留原样');
    kept = await accept(target, { kind: 'plot', sections });
    // 下一步就会把内容覆盖掉，所以先抓快照。
    afterKept = t.read('.novelforge/plots/01-觉醒之日/001-夜入青云.md');

    h.answers.push('覆盖');
    written = await accept(target, { kind: 'plot', sections });

    // 一字未变时不该弹框——弹了只会让人以为自己点错了。answers 空着，
    // 真弹框的话 confirm 返回 undefined，会被当成取消而 skipped。
    same = await accept(target, { kind: 'plot', sections });
  });

  test('拒绝覆盖时不写盘', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('拒绝后磁盘上还是旧的', () => {
    assert.ok(!afterKept.includes('三拍推进'));
  });

  test('确认后才写', () => {
    assert.equal(written.relPath, '.novelforge/plots/01-觉醒之日/001-夜入青云.md', written.message);
  });

  test('新内容已落盘', () => {
    assert.ok(t.read('.novelforge/plots/01-觉醒之日/001-夜入青云.md').includes('三拍推进'));
  });

  test('内容相同不弹框直接通过', () => {
    assert.notEqual(same.skipped, true, same.message);
    assert.ok(!!same.relPath, same.message);
  });

  test('写完之后这一段算排过剧情了', async () => {
    const plot = await project.readPlot(target.plotRelPath);
    assert.ok(plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  // 落定走的是同一条落盘路（`acceptPlot`），只是上游那次调用的提示词不同。
  test('落定产出的剧情走同一条落盘路', async () => {
    const settled = { ...sections, 冲突与转折: '讨论里定下的：两拍' };
    h.answers.push('覆盖');
    const r = await accept(target, { kind: 'plot', sections: settled });
    assert.equal(r.relPath, '.novelforge/plots/01-觉醒之日/001-夜入青云.md', r.message);
    assert.ok(t.read('.novelforge/plots/01-觉醒之日/001-夜入青云.md').includes('讨论里定下的'));
  });
});

describe('采纳 · 正文', () => {
  const plotRelPath = '.novelforge/plots/01-觉醒之日/001-夜入青云.md';
  let upstreamBefore;
  let result;
  let entry;
  let manuscript;
  let pipe;
  let chapterCount;

  before(async () => {
    const target = { kind: 'manuscript', plotRelPath };
    const plotBefore = await project.readPlot(plotRelPath);
    // 正文的上游是**这一段的细纲**（从前是那一段的场景集合）。
    upstreamBefore = bundle.pipe.plotContentHash(plotBefore);

    result = await accept(target, {
      kind: 'manuscript',
      text: '雨下了三天，青云宗的石阶泡得发白。',
    });

    // 写完要记一笔 upstreamHash，否则这一段会永远显示（或永远不显示）「与剧情对不上」。
    manuscript = await project.readManuscript(plotRelPath);
    chapterCount = (await project.listChapters()).length;
    const manifest = await project.readManifest();
    entry = manifest.chapters.find((c) => c.order === 1);

    const plot = await project.readPlot(plotRelPath);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  });

  test('剧情排过就算得出上游指纹', () => {
    assert.ok(upstreamBefore.length > 0);
  });

  // 正文先落在中转站 manuscripts/，**不是 chapters/**：在哪儿断章由作者定。
  test('正文追加到 manuscripts/', () => {
    assert.equal(result.relPath, '.novelforge/manuscripts/01-觉醒之日/001-夜入青云.md', result.message);
  });

  test('正文确实写进去了', () => {
    assert.ok(t.read('.novelforge/manuscripts/01-觉醒之日/001-夜入青云.md').includes('石阶泡得发白'));
  });

  // 采纳正文这一步不碰发布区：拆分是另一个动作（features/splitChapter.ts）。
  test('不往 chapters/ 里写任何东西', () => {
    assert.equal(chapterCount, 0, String(chapterCount));
  });

  // 指纹落在正文文件自己的 frontmatter 里，不在 manifest——
  // 真相跟着文件走，作者手工搬动文件时不会与中央索引失联。
  test('正文的 frontmatter 记下细纲指纹', () => {
    assert.equal(manuscript.upstreamHash, upstreamBefore, manuscript.upstreamHash);
  });

  // manifest 索引的是 `chapters/` 里的成品。中转站那份是半成品，拆分时就删了，
  // 进索引只会留下一堆指向已删文件的条目。
  test('中转站的正文不进 manifest', () => {
    assert.equal(entry, undefined, JSON.stringify(entry));
  });

  test('刚写完的正文不标脏', () => {
    assert.equal(pipe.manuscript.upstreamStale, false);
  });

  // 这一段的细纲没写 targetWords，所以「有字就算写完」——不拿一个猜出来的
  // 阈值骗人（见 model/pipeline.ts 的 `manuscriptRatio`）。
  test('没有目标字数时有正文就算满', () => {
    assert.equal(pipe.progress.manuscript, 1, String(pipe.progress.manuscript));
  });

  // 一段正文可以分几次写，顺序拼起来才是完整的一段——所以是追加不是覆盖。
  test('再写一次是追加，不覆盖前一次', async () => {
    await accept(
      { kind: 'manuscript', plotRelPath },
      { kind: 'manuscript', text: '他数到第三盏灯才动。' }
    );
    const text = t.read('.novelforge/manuscripts/01-觉醒之日/001-夜入青云.md');
    assert.ok(text.includes('石阶泡得发白') && text.includes('第三盏灯'), text);
  });

  // 两次追加之间那一行 `---` 是**默认的拆分候选点**（第 23 条）。
  test('两次追加之间插了分隔标记', () => {
    assert.ok(t.read('.novelforge/manuscripts/01-觉醒之日/001-夜入青云.md').includes('\n---\n'));
  });
});

describe('采纳 · 大纲整篇替换', () => {
  let result;
  let outline;

  before(async () => {
    h.answers.push('覆盖');
    result = await accept(
      { kind: 'outline' },
      { kind: 'outlineDoc', text: '## 第一幕 · 入局\n\n- 林昭进宗门' }
    );
    outline = await project.readOutline();
  });

  test('大纲写回 outline.md', () => {
    assert.ok(result.relPath.endsWith('outline.md'), result.message);
  });

  test('大纲内容已换', () => {
    assert.ok(outline.includes('林昭进宗门'));
  });
});

describe('采纳 · 目标不存在时报错而不是乱写', () => {
  let message = '';

  before(async () => {
    try {
      await accept(
        { kind: 'manuscript', plotRelPath: '.novelforge/plots/999-不存在.md' },
        { kind: 'manuscript', text: 'x' }
      );
    } catch (err) {
      message = String(err.message ?? err);
    }
  });

  test('找不到细纲时抛错', () => {
    assert.ok(message.includes('找不到细纲'), message);
  });

  test('没有凭空造出正文', () => {
    assert.ok(!t.has('.novelforge/manuscripts/999-不存在.md'));
  });
});
