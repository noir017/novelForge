/**
 * 上下文详细度（model/contextDetail.ts）的级别表，以及 config.ts 怎么读写它。
 *
 * 几条硬约束在这里钉住：
 * - **第 3 级逐项等于从前写死的常量**（外加摘要封顶 60 章）——缺省是它，升级不该改别的；
 * - **级别越高，每一项都不少**（只有「角色卡只带要点」反过来）：表里填错一格，开关就不再单调；
 * - **认不出的值回落第 3 级**，不抛；
 * - **旧的两个键不再读**，下一次保存时从文件里清掉。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, loadBundle } = require('../../helpers/load');

let m;
before(() => {
  m = loadModule('src/core/model/contextDetail.ts');
});

describe('model/contextDetail · 级别表', () => {
  test('四级，缺省第 3 级「详细」', () => {
    assert.deepEqual(m.CONTEXT_DETAILS, [1, 2, 3, 4]);
    assert.equal(m.DEFAULT_CONTEXT_DETAIL, 3);
    assert.deepEqual(
      m.CONTEXT_DETAILS.map((d) => m.CONTEXT_DETAIL_LABEL[d]),
      ['精简', '标准', '详细', '完整']
    );
  });

  // 设定那四项是新加的：从前命中就整条塞、不封顶，几百条的书会把窗口填满（设定名录，2026-10-18）。
  // 拆细纲带叙事线那三项（`plotThread*` / `plotForeshadowCount`）是叙事线二期加的：从前拆细纲一条线都不带。
  // 「更早章细纲最多带几章」（`summaryChapters`）2026-10-21 删了：写正文、写大纲都不再带更早几十章的细纲。
  test('第 3 级逐项等于从前写死的常量，外加设定封顶', () => {
    assert.deepEqual(
      { ...m.CONTEXT_DETAIL_LIMITS[3] },
      {
        fullTextChapters: 2,
        prevTailChars: 1500,
        evidenceRecent: 5,
        evidenceChapters: 12,
        evidenceChars: 6000,
        factsChapters: 12,
        factsChars: 3000,
        threadCount: 6,
        threadChars: 1200,
        plotThreadCount: 8,
        plotForeshadowCount: 14,
        plotThreadChars: 1800,
        plotListMax: 100,
        prevPlots: 3,
        nextPlots: 1,
        historyCap: 0.3,
        essentialCards: false,
        castSummaries: 2,
        deriveSamples: 5,
        styleSamples: 2,
        characterChapters: 3,
        referenceSamples: 5,
        threadPlanOutlineChars: 8000,
        threadJudge: 12,
        foreshadowJudge: 16,
        loreFull: 6,
        loreLines: 40,
        loreChars: 5000,
        loreTail: 3,
      }
    );
  });

  test('级别越高每一项都不少（只有「只带要点」反过来）', () => {
    const rows = m.CONTEXT_DETAILS.map((d) => m.CONTEXT_DETAIL_LIMITS[d]);
    for (const key of Object.keys(rows[0])) {
      for (let i = 1; i < rows.length; i++) {
        const [lo, hi] = [rows[i - 1][key], rows[i][key]];
        if (key === 'essentialCards') {
          assert.ok(!(hi && !lo), `${key} 在第 ${i + 1} 级反而打开了`);
        } else {
          assert.ok(hi >= lo, `${key}：第 ${i} 级 ${lo} > 第 ${i + 1} 级 ${hi}`);
        }
      }
    }
  });

  test('只有「精简」不带定稿原文片段、只带要点；没有哪一级再带更早几十章的细纲', () => {
    assert.equal(m.CONTEXT_DETAIL_LIMITS[1].evidenceChapters, 0);
    assert.equal(m.CONTEXT_DETAIL_LIMITS[1].essentialCards, true);
    assert.ok([1, 2, 3, 4].every((d) => !('summaryChapters' in m.CONTEXT_DETAIL_LIMITS[d])));
  });

  test('表是冻结的：谁也不能顺手改掉一格', () => {
    assert.ok(Object.isFrozen(m.CONTEXT_DETAIL_LIMITS) && Object.isFrozen(m.CONTEXT_DETAIL_LIMITS[3]));
  });
});

describe('model/contextDetail · 容错与解析', () => {
  test('认不出的一律回落第 3 级', () => {
    for (const bad of [undefined, null, 0, 5, 2.5, NaN, '3', 'high', {}]) {
      assert.equal(m.normalizeContextDetail(bad), 3, String(bad));
    }
    assert.equal(m.normalizeContextDetail(1), 1);
  });

  test('contextLimitsOf：没写级别 = 第 3 级那一行；单项覆盖叠在上面', () => {
    assert.equal(m.contextLimitsOf({}), m.CONTEXT_DETAIL_LIMITS[3]);
    const l = m.contextLimitsOf({ contextDetail: 1, contextOverrides: { fullTextChapters: 4 } });
    assert.equal(l.fullTextChapters, 4);
    assert.equal(l.prevPlots, 1);
  });

  test('takeLast：0 是空（不是 slice(-0) 的整份），Infinity 是全部', () => {
    const list = [1, 2, 3];
    assert.deepEqual(m.takeLast(list, 0), []);
    assert.deepEqual(m.takeLast(list, -1), []);
    assert.deepEqual(m.takeLast(list, 2), [2, 3]);
    assert.deepEqual(m.takeLast(list, Infinity), [1, 2, 3]);
    assert.notEqual(m.takeLast(list, Infinity), list, '拿到的是副本');
  });

  test('说明文字：0 写「不带」，不出现 Infinity', () => {
    assert.match(m.describeContextDetail(1), /近章全文 不带/);
    assert.match(m.describeContextDetail(1), /定稿原文片段 不带/);
    assert.match(m.describeContextDetail(1), /角色卡只带要点/);
    assert.match(m.describeContextDetail(1), /前几章细纲 1 章/);
    assert.doesNotMatch(m.describeContextDetail(4), /Infinity/);
  });
});

describe('config · 上下文详细度的读写', () => {
  let config;
  let settings;
  before(() => {
    config = loadBundle({ config: './src/core/config.ts' }).config;
    config.initConfigFromHost({
      config: {
        read: () => settings,
        write: async (s) => {
          settings = s;
        },
      },
    });
  });

  test('缺席 = 第 3 级；认不出 = 第 3 级', () => {
    settings = {};
    assert.equal(config.readConfig().contextDetail, 3);
    settings = { contextDetail: 9 };
    assert.equal(config.readConfig().contextDetail, 3);
    settings = { contextDetail: 1 };
    assert.equal(config.readConfig().contextDetail, 1);
  });

  test('旧的两个键不再读：留着 recentChaptersFullText: 0 也不生效', () => {
    settings = { recentChaptersFullText: 0, prevChapterTailChars: 100 };
    const cfg = config.readConfig();
    assert.ok(!('recentChaptersFullText' in cfg) && !('prevChapterTailChars' in cfg));
    const limits = m.contextLimitsOf(cfg);
    assert.equal(limits.fullTextChapters, 2);
    assert.equal(limits.prevTailChars, 1500);
  });

  test('下一次保存时把旧的两个键从文件里清掉', async () => {
    settings = { recentChaptersFullText: 0, prevChapterTailChars: 100, temperature: 0.5 };
    await config.updateSettings({ contextDetail: 2 });
    assert.ok(!('recentChaptersFullText' in settings) && !('prevChapterTailChars' in settings), JSON.stringify(settings));
    assert.equal(settings.contextDetail, 2);
    assert.equal(settings.temperature, 0.5);
  });

  test('测试用的单项覆盖经 readConfig 带出来，清掉就没了；config.json 里同名的键不认', () => {
    settings = { contextOverrides: { fullTextChapters: 7 } };
    assert.equal(config.readConfig().contextOverrides, undefined);
    config.setContextLimitsOverride({ fullTextChapters: 0 });
    assert.deepEqual(config.readConfig().contextOverrides, { fullTextChapters: 0 });
    config.setContextLimitsOverride(undefined);
    assert.equal(config.readConfig().contextOverrides, undefined);
  });
});
