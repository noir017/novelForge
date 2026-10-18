/**
 * 外观与专注的取值校验（`media/src/editor/lookCore.ts`，纯函数）：字号 / 行距 / 版心的上下限与取整、
 * 字体认不出回落宋体、整份偏好读回来坏值逐项回落、专注三个开关只认明明白白的 true、写到 `<html>` 上的变量。
 * 面板、菜单、快捷键那一整条在 tests/dom/standalone/look.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  DEFAULT_LOOK,
  FONT_CHOICES,
  FONT_SIZE,
  LINE_HEIGHT,
  LOOK_VARS,
  MEASURE,
  clampFontSize,
  clampLineHeight,
  clampMeasure,
  fontStack,
  lookVars,
  measureLabel,
  normalizeFocus,
  normalizeFont,
  normalizeLook,
  sameLook,
  stepFontSize,
} = loadModule('media/src/editor/lookCore.ts');

describe('lookCore：缺省值', () => {
  test('缺省与改造前写死的一样：宋体、15px、1.95 倍、铺满', () => {
    assert.deepEqual({ ...DEFAULT_LOOK }, { fontFamily: 'song', fontSize: 15, lineHeight: 1.95, measure: 0 });
  });

  test('缺省值被冻结，改不动', () => {
    assert.equal(Object.isFrozen(DEFAULT_LOOK), true);
  });

  test('字体表：宋体、黑体、楷体、仿宋、跟随系统，宋体排第一', () => {
    assert.deepEqual(
      FONT_CHOICES.map((f) => f.id),
      ['song', 'hei', 'kai', 'fangsong', 'system']
    );
  });

  test('每个字体都落到一个通用族上（作者机器上没有那几个名字时不至于变成浏览器默认的 Times）', () => {
    for (const f of FONT_CHOICES) {
      assert.match(f.stack, /(serif|sans-serif|system-ui)$/, f.id);
    }
  });

  test('版心的几档里第一档是「铺满」（0）', () => {
    assert.equal(MEASURE.presets[0], 0);
  });
});

describe('lookCore：字号', () => {
  test('范围之内原样', () => {
    assert.equal(clampFontSize(18), 18);
  });

  test('越界夹进上下限', () => {
    assert.deepEqual([clampFontSize(4), clampFontSize(200)], [FONT_SIZE.min, FONT_SIZE.max]);
  });

  test('取整到 1px', () => {
    assert.equal(clampFontSize(16.4), 16);
  });

  test('不是数字（字符串、NaN、Infinity、null）回落缺省', () => {
    for (const bad of ['18', NaN, Infinity, null, undefined, {}]) {
      assert.equal(clampFontSize(bad), 15, String(bad));
    }
  });

  test('放大一档、缩小一档', () => {
    assert.deepEqual([stepFontSize(15, 1), stepFontSize(15, -1)], [16, 14]);
  });

  test('到头了原样返回', () => {
    assert.deepEqual([stepFontSize(FONT_SIZE.max, 1), stepFontSize(FONT_SIZE.min, -1)], [FONT_SIZE.max, FONT_SIZE.min]);
  });
});

describe('lookCore：行距', () => {
  test('范围之内取整到 0.05', () => {
    assert.equal(clampLineHeight(1.83), 1.85);
  });

  test('不留浮点尾巴', () => {
    assert.equal(clampLineHeight(0.1 + 0.2 + 1.5), 1.8);
  });

  test('越界夹进上下限', () => {
    assert.deepEqual([clampLineHeight(1), clampLineHeight(9)], [LINE_HEIGHT.min, LINE_HEIGHT.max]);
  });

  test('坏值回落缺省', () => {
    assert.equal(clampLineHeight('2'), 1.95);
  });
});

describe('lookCore：版心宽度', () => {
  test('0 是铺满', () => {
    assert.equal(clampMeasure(0), 0);
  });

  test('负数也当铺满', () => {
    assert.equal(clampMeasure(-5), 0);
  });

  test('太窄夹到最少 20 字、太宽夹到最多 80 字', () => {
    assert.deepEqual([clampMeasure(3), clampMeasure(500)], [MEASURE.min, MEASURE.max]);
  });

  test('取整', () => {
    assert.equal(clampMeasure(42.6), 43);
  });

  test('坏值回落铺满', () => {
    assert.equal(clampMeasure('40'), 0);
  });

  test('说法：铺满 / 一行最多 N 字', () => {
    assert.deepEqual([measureLabel(0), measureLabel(40)], ['铺满', '一行最多 40 字']);
  });
});

describe('lookCore：字体', () => {
  test('认得出的原样', () => {
    assert.equal(normalizeFont('kai'), 'kai');
  });

  test('认不出（拼错、中文名、数字）回落宋体', () => {
    for (const bad of ['Kai', '楷体', 3, null]) {
      assert.equal(normalizeFont(bad), 'song', String(bad));
    }
  });

  test('认不出的 id 取字体串时也落到宋体那一串', () => {
    assert.equal(fontStack('nope'), FONT_CHOICES[0].stack);
  });
});

describe('lookCore：整份偏好读回来', () => {
  test('什么都没记（null、不是对象）：全是缺省', () => {
    for (const raw of [null, undefined, 'x', 3, []]) {
      assert.deepEqual(normalizeLook(raw), { ...DEFAULT_LOOK }, String(raw));
    }
  });

  test('只读外观那四项，同一处记着的别的开关不管', () => {
    const raw = { autoPair: false, autoSave: true, fontFamily: 'hei', fontSize: 20, lineHeight: 2.2, measure: 40 };
    assert.deepEqual(normalizeLook(raw), { fontFamily: 'hei', fontSize: 20, lineHeight: 2.2, measure: 40 });
  });

  test('坏值逐项回落：一项坏了不连累别的', () => {
    const raw = { fontFamily: 'comic', fontSize: 20, lineHeight: 'tall', measure: 40 };
    assert.deepEqual(normalizeLook(raw), { fontFamily: 'song', fontSize: 20, lineHeight: 1.95, measure: 40 });
  });

  test('越界的夹进上下限', () => {
    assert.deepEqual(normalizeLook({ fontSize: 99, lineHeight: 0.5, measure: 5 }), {
      fontFamily: 'song',
      fontSize: FONT_SIZE.max,
      lineHeight: LINE_HEIGHT.min,
      measure: MEASURE.min,
    });
  });

  test('sameLook 逐项比', () => {
    assert.equal(sameLook({ ...DEFAULT_LOOK }, normalizeLook({})), true);
    assert.equal(sameLook({ ...DEFAULT_LOOK }, { ...DEFAULT_LOOK, measure: 40 }), false);
  });
});

describe('lookCore：写到 <html> 上的那组变量', () => {
  test('变量名：字体、字号、行距、版心', () => {
    assert.deepEqual(Object.values(LOOK_VARS), [
      '--nf-ed-font-family',
      '--nf-ed-font-size',
      '--nf-ed-line-height',
      '--nf-ed-measure',
    ]);
  });

  test('字号带 px、行距是倍数、版心按 em（全角字宽 = 字号）', () => {
    const vars = lookVars({ fontFamily: 'hei', fontSize: 18, lineHeight: 2.1, measure: 40 });
    assert.deepEqual(
      [vars['--nf-ed-font-size'], vars['--nf-ed-line-height'], vars['--nf-ed-measure']],
      ['18px', '2.1', '40em']
    );
  });

  test('字体写的是那一串字体族名', () => {
    assert.equal(lookVars({ ...DEFAULT_LOOK, fontFamily: 'kai' })['--nf-ed-font-family'], fontStack('kai'));
  });

  test('铺满写成整个编辑区宽（100cqi），居中那一算式落回最小内边距', () => {
    assert.equal(lookVars({ ...DEFAULT_LOOK })['--nf-ed-measure'], '100cqi');
  });
});

describe('lookCore：专注那三个开关', () => {
  test('缺省都关', () => {
    assert.deepEqual(normalizeFocus(null), { focusMode: false, typewriter: false, paragraphFocus: false });
  });

  test('只认明明白白的 true（"true"、1 都不算）', () => {
    assert.deepEqual(normalizeFocus({ focusMode: 'true', typewriter: 1, paragraphFocus: true }), {
      focusMode: false,
      typewriter: false,
      paragraphFocus: true,
    });
  });

  test('全屏不在偏好里（记了也恢复不了）', () => {
    assert.equal('fullscreen' in normalizeFocus({ fullscreen: true }), false);
  });
});
