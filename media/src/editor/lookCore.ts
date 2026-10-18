/**
 * 外观与专注的取值表、上下限与校验（纯函数、零 DOM、零 import）。
 *
 * 这几项都按浏览器记在 `novelforge.editor.prefs` 里（与成对符号、自动保存同一处，见 `paragraphState.ts`），
 * 作者会手改 localStorage、旧版本写下的值也可能不认识——**读回来的坏值一律回落缺省、越界的夹进上下限**，
 * 口径只在这里写一份（`tests/unit/editor/lookCore.test.js` 钉着）。`look.ts` 只管把结果写成 CSS 变量，
 * `focus.ts` 只管开关。
 *
 * ## 排版参数怎么落到页面上
 *
 * 字体、字号、行距、版心宽度是一组 CSS 变量（`LOOK_VARS`），写在 `<html>` 上；编辑区的 textarea、高亮镜像层、
 * 预览三处在 `css/standalone/look.css` 里**共用同一条规则**读它们——别给哪一处单写一份，镜像层与 textarea 排得
 * 不一样，查找高亮就对不齐了（`media/README.md`「镜像层与 textarea 排版必须完全一致」）。
 */

/** 正文字体。只列字体族名，不打包字体文件：作者机器上没有的那几个名字浏览器会跳过，落到最后的通用族上。 */
export type FontId = 'song' | 'hei' | 'kai' | 'fangsong' | 'system';

export interface FontChoice {
  id: FontId;
  label: string;
  /** `font-family` 的值。固定的一张表，不收作者输入（写进 CSS 变量的只会是这几串）。 */
  stack: string;
}

/** 顺序即面板上的顺序。宋体是缺省（与改造前编辑区的正文字体同一串）。 */
export const FONT_CHOICES: readonly FontChoice[] = [
  {
    id: 'song',
    label: '宋体（衬线）',
    stack: "'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif",
  },
  {
    id: 'hei',
    label: '黑体（无衬线）',
    stack:
      "'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'WenQuanYi Micro Hei', sans-serif",
  },
  {
    id: 'kai',
    label: '楷体',
    stack: "'LXGW WenKai', 'Kaiti SC', 'STKaiti', 'KaiTi', 'AR PL UKai CN', serif",
  },
  {
    id: 'fangsong',
    label: '仿宋',
    stack: "'FangSong', 'STFangsong', 'FangSong_GB2312', 'Fangsong SC', serif",
  },
  {
    id: 'system',
    label: '跟随系统',
    stack: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  },
];

/** 字号（px）。快捷键 Ctrl+= / Ctrl+- 一下一步。 */
export const FONT_SIZE = { min: 12, max: 32, step: 1, fallback: 15 } as const;
/** 行距（倍数）。空行分段时段与段之间那一行空行也跟着它变。 */
export const LINE_HEIGHT = { min: 1.3, max: 3, step: 0.05, fallback: 1.95 } as const;
/**
 * 版心宽度：一行最多几个字（按全角字宽算），宽屏时那一栏居中。`0` 是「铺满」——缺省，与改造前一样。
 * `presets` 是面板下拉框里的几档；手改成别的整数也认（夹进上下限）。
 */
export const MEASURE = { min: 20, max: 80, fallback: 0, presets: [0, 30, 35, 40, 45, 50, 60, 70] } as const;

export interface LookPrefs {
  fontFamily: FontId;
  /** px */
  fontSize: number;
  /** 倍数 */
  lineHeight: number;
  /** 一行最多几个字；0 = 铺满 */
  measure: number;
}

export const DEFAULT_LOOK: Readonly<LookPrefs> = Object.freeze({
  fontFamily: 'song',
  fontSize: FONT_SIZE.fallback,
  lineHeight: LINE_HEIGHT.fallback,
  measure: MEASURE.fallback,
});

/** 偏好里这几项的键名（与成对符号、自动保存平铺在同一个对象里）。 */
export const LOOK_KEYS: readonly (keyof LookPrefs)[] = ['fontFamily', 'fontSize', 'lineHeight', 'measure'];

/** 排版那组 CSS 变量的名字。textarea、镜像层、预览在 `look.css` 里读同一组。 */
export const LOOK_VARS = {
  fontFamily: '--nf-ed-font-family',
  fontSize: '--nf-ed-font-size',
  lineHeight: '--nf-ed-line-height',
  measure: '--nf-ed-measure',
} as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 按步长取整（避免 0.1 + 0.2 那种尾巴写进偏好），再夹进上下限。 */
function snap(v: number, min: number, max: number, step: number): number {
  const stepped = Math.round(v / step) * step;
  const fixed = Number(stepped.toFixed(4));
  return Math.min(max, Math.max(min, fixed));
}

/** 字号：不是有限数字回落缺省，越界夹进 12–32，取整到 1px。 */
export function clampFontSize(v: unknown): number {
  return isNumber(v) ? snap(v, FONT_SIZE.min, FONT_SIZE.max, FONT_SIZE.step) : FONT_SIZE.fallback;
}

/** 行距：不是有限数字回落缺省，越界夹进 1.3–3，取整到 0.05。 */
export function clampLineHeight(v: unknown): number {
  return isNumber(v) ? snap(v, LINE_HEIGHT.min, LINE_HEIGHT.max, LINE_HEIGHT.step) : LINE_HEIGHT.fallback;
}

/** 版心：不是有限数字回落缺省（铺满）；≤ 0 是铺满；其余取整、夹进 20–80 字。 */
export function clampMeasure(v: unknown): number {
  if (!isNumber(v)) {
    return MEASURE.fallback;
  }
  if (v <= 0) {
    return 0;
  }
  return Math.min(MEASURE.max, Math.max(MEASURE.min, Math.round(v)));
}

/** 字体：认不出的回落宋体。 */
export function normalizeFont(v: unknown): FontId {
  return FONT_CHOICES.some((f) => f.id === v) ? (v as FontId) : DEFAULT_LOOK.fontFamily;
}

/** 从整份偏好（一个随便什么都可能的对象）里读出外观那几项，坏值逐项回落。 */
export function normalizeLook(raw: unknown): LookPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    fontFamily: normalizeFont(r.fontFamily),
    fontSize: clampFontSize(r.fontSize),
    lineHeight: clampLineHeight(r.lineHeight),
    measure: clampMeasure(r.measure),
  };
}

/** 两份外观一样不一样。 */
export function sameLook(a: LookPrefs, b: LookPrefs): boolean {
  return LOOK_KEYS.every((k) => a[k] === b[k]);
}

/** 放大 / 缩小一档（到头了原样返回）。 */
export function stepFontSize(size: number, dir: 1 | -1): number {
  return clampFontSize(clampFontSize(size) + dir * FONT_SIZE.step);
}

export function fontStack(id: FontId): string {
  return (FONT_CHOICES.find((f) => f.id === id) ?? FONT_CHOICES[0]).stack;
}

/**
 * 写到 `<html>` 上的那组变量。版心按 `em` 写（全角字宽 = 字号），在用到它的元素上按那里的字号解析——
 * textarea、镜像层、预览字号相同，算出来就相同。铺满写 `100cqi`（整个编辑区宽），居中那一算式就落回最小内边距。
 */
export function lookVars(look: LookPrefs): Record<string, string> {
  return {
    [LOOK_VARS.fontFamily]: fontStack(look.fontFamily),
    [LOOK_VARS.fontSize]: `${look.fontSize}px`,
    [LOOK_VARS.lineHeight]: String(look.lineHeight),
    [LOOK_VARS.measure]: look.measure > 0 ? `${look.measure}em` : '100cqi',
  };
}

/** 版心那一档怎么说（面板下拉框、菜单提示）。 */
export function measureLabel(measure: number): string {
  return measure > 0 ? `一行最多 ${measure} 字` : '铺满';
}

// ---------------------------------------------------------------- 专注

/** 专注那三个开关（全屏不记：浏览器每次加载都从窗口模式开始，记了也恢复不了）。 */
export interface FocusPrefs {
  focusMode: boolean;
  typewriter: boolean;
  paragraphFocus: boolean;
}

export const FOCUS_KEYS: readonly (keyof FocusPrefs)[] = ['focusMode', 'typewriter', 'paragraphFocus'];

/** 三个开关缺省都关，只认明明白白的 `true`（与自动保存同一个口径）。 */
export function normalizeFocus(raw: unknown): FocusPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    focusMode: r.focusMode === true,
    typewriter: r.typewriter === true,
    paragraphFocus: r.paragraphFocus === true,
  };
}
